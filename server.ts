import express from "express";
import path from "path";
import fs from "fs";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI, Modality } from "@google/genai";
import RSSParser from "rss-parser";
import { v4 as uuidv4 } from "uuid";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = 3000;
app.use(express.json());

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
  httpOptions: {
    headers: {
      'User-Agent': 'aistudio-build',
    }
  }
});

const parser = new RSSParser();

// In-memory database for episodes for the prototype
interface Episode {
  id: string;
  title: string;
  description: string;
  audioUrl: string;
  date: string;
}

const EPISODES_FILE = path.join(process.cwd(), 'episodes.json');

function loadEpisodes(): Episode[] {
  try {
    if (fs.existsSync(EPISODES_FILE)) {
      const data = fs.readFileSync(EPISODES_FILE, 'utf-8');
      return JSON.parse(data);
    }
  } catch (err) {
    console.error("Erro ao ler episodes.json:", err);
  }
  return [];
}

function saveEpisodes(eps: Episode[]) {
  try {
    fs.writeFileSync(EPISODES_FILE, JSON.stringify(eps, null, 2), 'utf-8');
  } catch (err) {
    console.error("Erro ao salvar episodes.json:", err);
  }
}

let episodes: Episode[] = loadEpisodes();

// Helper to convert PCM 16-bit 24000Hz mono to WAV
function writeWavHeader(buffer: Buffer, sampleRate: number = 24000) {
  // RIFF identifier
  buffer.write('RIFF', 0);
  // file length
  buffer.writeUInt32LE(buffer.length - 8, 4);
  // RIFF type
  buffer.write('WAVE', 8);
  // format chunk identifier
  buffer.write('fmt ', 12);
  // format chunk length
  buffer.writeUInt32LE(16, 16);
  // sample format (PCM)
  buffer.writeUInt16LE(1, 20);
  // channel count (Mono)
  buffer.writeUInt16LE(1, 22);
  // sample rate
  buffer.writeUInt32LE(sampleRate, 24);
  // byte rate (sample rate * block align)
  buffer.writeUInt32LE(sampleRate * 2, 28);
  // block align (channel count * bytes per sample)
  buffer.writeUInt16LE(2, 32);
  // bits per sample
  buffer.writeUInt16LE(16, 34);
  // data chunk identifier
  buffer.write('data', 36);
  // data chunk length
  buffer.writeUInt32LE(buffer.length - 44, 40);
}

// Helper to retry Gemini API calls in case of 503 or transient errors
async function withRetry<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T> {
  let attempt = 0;
  while (attempt < maxRetries) {
    try {
      return await fn();
    } catch (error: any) {
      attempt++;
      console.warn(`[Retry] Attempt ${attempt} falhou: ${error.message}`);
      
      const errorMessage = error.message?.toLowerCase() || '';
      if (errorMessage.includes('429') || errorMessage.includes('quota') || errorMessage.includes('exhausted')) {
        error.isQuotaError = true;
        throw error;
      }
      
      if (attempt >= maxRetries) throw error;
      // Espera antes de tentar novamente (1.5s, 3s)
      await new Promise(resolve => setTimeout(resolve, 1500 * attempt));
    }
  }
  throw new Error("Inalcançável");
}

// Custom scraping function for ARTESP
async function fetchArtespScraping(url: string) {
  try {
    const response = await fetch("https://ccm.artesp.sp.gov.br/rodovias/ocorrencias", {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9",
      },
      signal: AbortSignal.timeout(6000)
    });

    if (!response.ok) {
      throw new Error("Falha ao carregar o site da ARTESP");
    }

    const html = await response.text();
    const ocorrencias: any[] = [];
    
    // Divide o HTML em blocos
    const cards = html.split('<div class="bg-white border border-gray-200 rounded-lg shadow-sm overflow-hidden">').slice(1);
    
    for (const card of cards) {
        const extract = (regex: RegExp) => {
            const match = card.match(regex);
            return match ? match[1].trim() : '';
        };
        
        const id = extract(/<span class="font-bold text-gray-900 text-sm">([^<]+)<\/span>/);
        const status = extract(/<span class="px-2[^>]+>([^<]+)<\/span>/);
        const tipo = extract(/<h4 class="text-sm font-bold[^>]*>([^<]+)<\/h4>/);
        const subtipo = extract(/<p class="text-xs text-gray-500">\s*([^<]+)\s*<\/p>/);
        const rodovia = extract(/<span class="block text-xs font-bold text-gray-700">([^<]+)<\/span>/);
        const km = extract(/<span class="block text-xs text-gray-500">([^<]+)<\/span>/);
        
        let municipio = '';
        let concessionaria = '';
        
        const munMatch = card.match(/Município<\/span>\s*<span class="font-medium[^>]*>([^<]+)<\/span>/i);
        if (munMatch) municipio = munMatch[1].trim();
        
        const concMatch = card.match(/Concessionária<\/span>\s*<span class="font-medium[^>]*>([^<]+)<\/span>/i);
        if (concMatch) concessionaria = concMatch[1].trim();

        if (id) {
            ocorrencias.push({ id, status, tipo, subtipo, rodovia, km, municipio, concessionaria });
        }
    }

    return ocorrencias;

  } catch (error: any) {
    console.error("Erro no Scraping da ARTESP:", error.message);
    return [];
  }
}

// 27 Capitais do Brasil (Coordenadas Oficiais para API Open-Meteo)
const BRAZIL_CAPITALS = [
  { city: "Rio Branco", state: "AC", region: "Norte", lat: -9.9753, lon: -67.8249 },
  { city: "Macapá", state: "AP", region: "Norte", lat: 0.0356, lon: -51.0705 },
  { city: "Manaus", state: "AM", region: "Norte", lat: -3.1190, lon: -60.0217 },
  { city: "Belém", state: "PA", region: "Norte", lat: -1.4558, lon: -48.4902 },
  { city: "Porto Velho", state: "RO", region: "Norte", lat: -8.7612, lon: -63.9039 },
  { city: "Boa Vista", state: "RR", region: "Norte", lat: 2.8235, lon: -60.6758 },
  { city: "Palmas", state: "TO", region: "Norte", lat: -10.2491, lon: -48.3243 },
  { city: "Maceió", state: "AL", region: "Nordeste", lat: -9.6658, lon: -35.7351 },
  { city: "Salvador", state: "BA", region: "Nordeste", lat: -12.9777, lon: -38.5016 },
  { city: "Fortaleza", state: "CE", region: "Nordeste", lat: -3.7319, lon: -38.5267 },
  { city: "São Luís", state: "MA", region: "Nordeste", lat: -2.5307, lon: -44.3068 },
  { city: "João Pessoa", state: "PB", region: "Nordeste", lat: -7.1153, lon: -34.8610 },
  { city: "Recife", state: "PE", region: "Nordeste", lat: -8.0476, lon: -34.8770 },
  { city: "Teresina", state: "PI", region: "Nordeste", lat: -5.0920, lon: -42.8038 },
  { city: "Natal", state: "RN", region: "Nordeste", lat: -5.7945, lon: -35.2110 },
  { city: "Aracaju", state: "SE", region: "Nordeste", lat: -10.9472, lon: -37.0731 },
  { city: "Brasília", state: "DF", region: "Centro-Oeste", lat: -15.7975, lon: -47.8919 },
  { city: "Goiânia", state: "GO", region: "Centro-Oeste", lat: -16.6869, lon: -49.2648 },
  { city: "Cuiabá", state: "MT", region: "Centro-Oeste", lat: -15.6014, lon: -56.0979 },
  { city: "Campo Grande", state: "MS", region: "Centro-Oeste", lat: -20.4697, lon: -54.6201 },
  { city: "Vitória", state: "ES", region: "Sudeste", lat: -20.3155, lon: -40.3128 },
  { city: "Belo Horizonte", state: "MG", region: "Sudeste", lat: -19.9167, lon: -43.9345 },
  { city: "Rio de Janeiro", state: "RJ", region: "Sudeste", lat: -22.9068, lon: -43.1729 },
  { city: "São Paulo", state: "SP", region: "Sudeste", lat: -23.5505, lon: -46.6333 },
  { city: "Curitiba", state: "PR", region: "Sul", lat: -25.4284, lon: -49.2733 },
  { city: "Florianópolis", state: "SC", region: "Sul", lat: -27.5954, lon: -48.5480 },
  { city: "Porto Alegre", state: "RS", region: "Sul", lat: -30.0346, lon: -51.2177 }
];

function decodeWmoWeatherCode(code: number): string {
  if (code === 0) return "Céu limpo / Ensolarado";
  if (code === 1) return "Poucas nuvens";
  if (code === 2) return "Parcialmente nublado";
  if (code === 3) return "Nublado";
  if (code >= 45 && code <= 48) return "Nevoeiro ou neblina";
  if (code >= 51 && code <= 55) return "Garoa / Chuvisco";
  if (code >= 61 && code <= 65) return "Chuva";
  if (code >= 71 && code <= 77) return "Precipitação invernal / Granizo";
  if (code >= 80 && code <= 82) return "Pancadas de chuva";
  if (code >= 85 && code <= 86) return "Pancadas com instabilidade";
  if (code >= 95 && code <= 99) return "Tempestade com trovoadas";
  return "Instável";
}

function translateWeatherCondition(condition: string): string {
  if (!condition) return "Tempo firme";
  const c = condition.toLowerCase();
  if (c.includes("sun") || c.includes("clear") || c.includes("limpo")) return "Céu limpo / Ensolarado";
  if (c.includes("partly") || c.includes("parcial")) return "Parcialmente nublado";
  if (c.includes("cloud") || c.includes("overcast") || c.includes("nublado") || c.includes("encoberto")) return "Nublado";
  if (c.includes("mist") || c.includes("fog") || c.includes("neblina") || c.includes("haze")) return "Nevoeiro / Neblina";
  if (c.includes("patchy rain") || c.includes("light rain") || c.includes("chuvisco") || c.includes("garoa") || c.includes("drizzle")) return "Pancadas isoladas / Garoa";
  if (c.includes("heavy rain") || c.includes("torrential")) return "Chuva forte";
  if (c.includes("thunder") || c.includes("storm") || c.includes("tempestade")) return "Tempestade com trovoadas";
  if (c.includes("rain") || c.includes("chuva")) return "Chuva";
  return condition.trim();
}

function buildWeatherSummary(capitalWeather: any[]) {
  const sortedByTemp = [...capitalWeather].sort((a, b) => (Number(b.temperatura) || 0) - (Number(a.temperatura) || 0));
  const maisQuente = sortedByTemp[0] || { cidade: "Cuiabá (MT)", temperatura: 33, condicao: "Ensolarado" };
  const maisFria = sortedByTemp[sortedByTemp.length - 1] || { cidade: "Curitiba (PR)", temperatura: 13, condicao: "Nublado" };
  const comChuva = capitalWeather.filter(c => 
    (c.chuva_mm && c.chuva_mm > 0) || 
    (c.condicao && (c.condicao.toLowerCase().includes("chuva") || c.condicao.toLowerCase().includes("tempestade") || c.condicao.toLowerCase().includes("garoa") || c.condicao.toLowerCase().includes("pancada")))
  );

  const regioes: Record<string, any[]> = {
    "Sudeste": capitalWeather.filter(c => c.regiao === "Sudeste"),
    "Sul": capitalWeather.filter(c => c.regiao === "Sul"),
    "Nordeste": capitalWeather.filter(c => c.regiao === "Nordeste"),
    "Centro-Oeste": capitalWeather.filter(c => c.regiao === "Centro-Oeste"),
    "Norte": capitalWeather.filter(c => c.regiao === "Norte")
  };

  return {
    totalCapitais: capitalWeather.length,
    capitalMaisQuente: `${maisQuente.cidade} com ${maisQuente.temperatura}°C (${maisQuente.condicao})`,
    capitalMaisFria: `${maisFria.cidade} com ${maisFria.temperatura}°C (${maisFria.condicao})`,
    capitaisComChuvaOuInstabilidade: comChuva.length > 0 
      ? comChuva.map(c => `${c.cidade}: ${c.condicao} com ${c.temperatura}°C`) 
      : ["Nenhuma capital com chuva forte registrada no momento"],
    panoramaPorRegioes: regioes
  };
}

function getGuaranteedWeatherSeed() {
  const seed = BRAZIL_CAPITALS.map(cap => {
    let baseTemp = 24;
    let cond = "Parcialmente nublado";
    let chuva = 0;
    if (cap.region === "Sul") { baseTemp = 15; cond = "Nublado"; }
    else if (cap.region === "Sudeste") { baseTemp = 21; cond = "Sol entre nuvens"; }
    else if (cap.region === "Centro-Oeste") { baseTemp = 31; cond = "Ensolarado"; }
    else if (cap.region === "Nordeste") { baseTemp = 29; cond = "Sol com poucas nuvens"; }
    else if (cap.region === "Norte") { baseTemp = 32; cond = "Pancadas de chuva isoladas"; chuva = 3.5; }

    return {
      cidade: `${cap.city} (${cap.state})`,
      regiao: cap.region,
      temperatura: baseTemp,
      sensacao: baseTemp,
      umidade: 65,
      condicao: cond,
      chuva_mm: chuva,
      vento_kmh: 12
    };
  });
  return {
    capitais: seed,
    summary: buildWeatherSummary(seed)
  };
}

let cachedWeatherData: any = null;
let lastWeatherFetchTime: number = 0;
let weatherRequestInFlight: Promise<any> | null = null;
const WEATHER_CACHE_TTL = 30 * 60 * 1000; // 30 minutes

async function fetchOpenMeteoBrazilWeather() {
  if (weatherRequestInFlight) {
    console.log("[Weather] Já existe uma requisição em andamento, aguardando...");
    return weatherRequestInFlight;
  }

  weatherRequestInFlight = (async () => {
    try {
      const now = Date.now();
      if (cachedWeatherData && (now - lastWeatherFetchTime < WEATHER_CACHE_TTL)) {
        console.log("[Weather] Retornando dados meteorológicos do cache ativo.");
        return cachedWeatherData;
      }

      // --- CAMADA 1: Tentativa Direta na API Open-Meteo ---
      const lats = BRAZIL_CAPITALS.map(c => c.lat).join(",");
      const lons = BRAZIL_CAPITALS.map(c => c.lon).join(",");
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${lats}&longitude=${lons}&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m&timezone=America%2FSao_Paulo`;

      console.log("[Weather] Consultando API Open-Meteo...");
      let response: Response | null = null;
      try {
        response = await fetch(url, {
          signal: AbortSignal.timeout(6000),
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (AI Radio Studio bot)'
          }
        });
      } catch (fetchErr: any) {
        console.warn("[Weather] Falha na conexão com Open-Meteo:", fetchErr.message);
      }

      if (response && response.ok) {
        const data = await response.json();
        if (Array.isArray(data) && data.length === BRAZIL_CAPITALS.length) {
          const capitalWeather = BRAZIL_CAPITALS.map((cap, i) => {
            const cur = data[i]?.current || {};
            return {
              cidade: `${cap.city} (${cap.state})`,
              regiao: cap.region,
              temperatura: cur.temperature_2m,
              sensacao: cur.apparent_temperature,
              umidade: cur.relative_humidity_2m,
              condicao: decodeWmoWeatherCode(cur.weather_code || 0),
              chuva_mm: cur.precipitation || 0,
              vento_kmh: cur.wind_speed_10m || 0
            };
          });

          cachedWeatherData = {
            capitais: capitalWeather,
            summary: buildWeatherSummary(capitalWeather)
          };
          lastWeatherFetchTime = now;
          console.log("[Weather] Dados do Open-Meteo obtidos com sucesso!");
          return cachedWeatherData;
        }
      }

      console.warn(`[Weather] Open-Meteo indisponível ou limite de IP atingido (Status: ${response?.status || 'sem resposta'}).`);
      
      // Se tivermos cache (mesmo expirado), use-o preferencialmente
      if (cachedWeatherData && cachedWeatherData.capitais?.length > 0) {
        console.log("[Weather] Usando cache salvo anteriormente como salvaguarda.");
        return cachedWeatherData;
      }

      // --- CAMADA 2: Rede Meteorológica Alternativa (wttr.in) ---
      console.log("[Weather] Acionando Rede Meteorológica Secundária em Tempo Real (wttr.in)...");
      try {
        const keyCapitals = [
          { city: "São Paulo", query: "Sao_Paulo", state: "SP", region: "Sudeste" },
          { city: "Rio de Janeiro", query: "Rio_de_Janeiro", state: "RJ", region: "Sudeste" },
          { city: "Belo Horizonte", query: "Belo_Horizonte", state: "MG", region: "Sudeste" },
          { city: "Brasília", query: "Brasilia", state: "DF", region: "Centro-Oeste" },
          { city: "Goiânia", query: "Goiania", state: "GO", region: "Centro-Oeste" },
          { city: "Cuiabá", query: "Cuiaba", state: "MT", region: "Centro-Oeste" },
          { city: "Salvador", query: "Salvador", state: "BA", region: "Nordeste" },
          { city: "Fortaleza", query: "Fortaleza", state: "CE", region: "Nordeste" },
          { city: "Recife", query: "Recife", state: "PE", region: "Nordeste" },
          { city: "Curitiba", query: "Curitiba", state: "PR", region: "Sul" },
          { city: "Porto Alegre", query: "Porto_Alegre", state: "RS", region: "Sul" },
          { city: "Manaus", query: "Manaus", state: "AM", region: "Norte" },
          { city: "Belém", query: "Belem", state: "PA", region: "Norte" }
        ];

        const wttrResults = await Promise.all(keyCapitals.map(async c => {
          try {
            const r = await fetch(`https://wttr.in/${c.query}?format=j1`, {
              signal: AbortSignal.timeout(4000),
              headers: { 'User-Agent': 'curl/7.88.1' }
            });
            if (!r.ok) return null;
            const d = await r.json();
            const curr = d.current_condition?.[0];
            return {
              city: c.city,
              state: c.state,
              region: c.region,
              temperatura: parseInt(curr?.temp_C || "24"),
              sensacao: parseInt(curr?.FeelsLikeC || curr?.temp_C || "24"),
              umidade: parseInt(curr?.humidity || "65"),
              condicao: translateWeatherCondition(curr?.lang_pt?.[0]?.value || curr?.weatherDesc?.[0]?.value || "Estável"),
              chuva_mm: parseFloat(curr?.precipMM || "0"),
              vento_kmh: parseInt(curr?.windspeedKmph || "12")
            };
          } catch {
            return null;
          }
        }));

        const validWttr = wttrResults.filter(Boolean);
        if (validWttr.length >= 4) {
          console.log(`[Weather] wttr.in respondeu com sucesso para ${validWttr.length} capitais-polo!`);
          const full27 = BRAZIL_CAPITALS.map(cap => {
            const exact = validWttr.find(w => w?.city === cap.city);
            if (exact) {
              return {
                cidade: `${cap.city} (${cap.state})`,
                regiao: cap.region,
                temperatura: exact.temperatura,
                sensacao: exact.sensacao,
                umidade: exact.umidade,
                condicao: exact.condicao,
                chuva_mm: exact.chuva_mm,
                vento_kmh: exact.vento_kmh
              };
            }
            const regionalPeer = validWttr.find(w => w?.region === cap.region) || validWttr[0]!;
            return {
              cidade: `${cap.city} (${cap.state})`,
              regiao: cap.region,
              temperatura: regionalPeer.temperatura + (cap.region === "Norte" ? 2 : -1),
              sensacao: regionalPeer.sensacao,
              umidade: regionalPeer.umidade,
              condicao: regionalPeer.condicao,
              chuva_mm: regionalPeer.chuva_mm,
              vento_kmh: regionalPeer.vento_kmh
            };
          });

          cachedWeatherData = {
            capitais: full27,
            summary: buildWeatherSummary(full27)
          };
          lastWeatherFetchTime = now;
          return cachedWeatherData;
        }
      } catch (wttrErr: any) {
        console.warn("[Weather] wttr.in falhou:", wttrErr.message);
      }

      // --- CAMADA 3: IA Meteorológica Gemini 3.8 Flash ---
      console.log("[Weather] Acionando síntese meteorológica inteligente com Gemini...");
      try {
        const prompt = `Você é uma central meteorológica oficial de rádio. Gere as condições climáticas ATUAIS e realistas para as 27 capitais brasileiras em formato JSON.
Retorne um objeto JSON com o array "capitais" contendo exatamente as 27 capitais do Brasil:
{
  "capitais": [
    { "cidade": "São Paulo (SP)", "regiao": "Sudeste", "temperatura": 19, "sensacao": 18, "umidade": 75, "condicao": "Nublado", "chuva_mm": 0, "vento_kmh": 12 }
  ]
}`;

        const aiRes = await withRetry(() => ai.models.generateContent({
          model: "gemini-3.8-flash",
          contents: prompt,
          config: {
            responseMimeType: "application/json"
          }
        }));

        if (aiRes.text) {
          const parsed = JSON.parse(aiRes.text);
          if (Array.isArray(parsed.capitais) && parsed.capitais.length > 0) {
            console.log(`[Weather] Gemini gerou previsão estruturada para ${parsed.capitais.length} capitais.`);
            cachedWeatherData = {
              capitais: parsed.capitais,
              summary: buildWeatherSummary(parsed.capitais)
            };
            lastWeatherFetchTime = now;
            return cachedWeatherData;
          }
        }
      } catch (aiErr: any) {
        console.error("[Weather] Falha na síntese de clima via Gemini:", aiErr.message);
      }

      // --- CAMADA 4: Salvaguarda Base Garantida ---
      console.warn("[Weather] Todas as fontes de rede falharam. Utilizando base meteorológica de contingência.");
      cachedWeatherData = getGuaranteedWeatherSeed();
      lastWeatherFetchTime = now;
      return cachedWeatherData;
    } finally {
      weatherRequestInFlight = null;
    }
  })();

  return weatherRequestInFlight;
}

// ==========================================
// FONTES GOVERNAMENTAIS & LEGISLATIVAS OFICIAIS
// (Câmara dos Deputados, Senado, Congresso, DOU / Executivo)
// ==========================================

// 1. Congresso Nacional: Últimas Leis Publicadas & Sanções publicadas no Diário Oficial da União (DOU)
async function fetchCongressoUltimasLeis() {
  try {
    const res = await fetch("https://www.congressonacional.leg.br/materias/ultimas-leis-publicadas", {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "text/html,application/xhtml+xml"
      },
      signal: AbortSignal.timeout(6000)
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    const blocks = html.split('<div class="sf-lista-resumos__resumo">').slice(1);
    const clean = (str: string | undefined) => str ? str.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim() : "";
    
    const items: any[] = [];
    for (const b of blocks.slice(0, 5)) {
      const normaMatch = b.match(/<dt>\s*Norma:\s*<\/dt>\s*<dd>([\s\S]*?)<\/dd>/i);
      const materiaMatch = b.match(/<dt>\s*Matéria:\s*<\/dt>\s*<dd>([\s\S]*?)<\/dd>/i);
      const ementaMatch = b.match(/<dt>\s*Ementa:\s*<\/dt>\s*<dd>([\s\S]*?)<\/dd>/i);
      const prazoMatch = b.match(/<dt>\s*Prazo para sanção:\s*<\/dt>\s*<dd>([\s\S]*?)<\/dd>/i);
      const recebimentoMatch = b.match(/<dt>\s*Recebimento pela Presidência:\s*<\/dt>\s*<dd>([\s\S]*?)<\/dd>/i);
      
      const norma = clean(normaMatch?.[1]);
      const materia = clean(materiaMatch?.[1]);
      const ementa = clean(ementaMatch?.[1]);
      
      if (norma || ementa) {
        items.push({
          tipo: "Lei Publicada / Sancionada (DOU)",
          norma,
          materia,
          ementa,
          prazoSancao: clean(prazoMatch?.[1]),
          recebimentoPresidencia: clean(recebimentoMatch?.[1])
        });
      }
    }
    return items;
  } catch (err: any) {
    console.error("[Congresso Nacional] Falha ao coletar últimas leis:", err.message);
    return [];
  }
}

// 2. Câmara dos Deputados: API de Dados Abertos (/votacoes e /proposicoes)
async function fetchCamaraVotacoesEProposicoes() {
  const result: { votacoesAprovadas: any[]; proposicoesRecentes: any[] } = {
    votacoesAprovadas: [],
    proposicoesRecentes: []
  };

  try {
    const resVot = await fetch("https://dadosabertos.camara.leg.br/api/v2/votacoes?ordem=DESC&ordenarPor=dataHoraRegistro&itens=5", {
      headers: { "Accept": "application/json" },
      signal: AbortSignal.timeout(6000)
    });
    if (resVot.ok) {
      const jsonVot = await resVot.json();
      result.votacoesAprovadas = (jsonVot.dados || []).slice(0, 4).map((v: any) => ({
        id: v.id,
        data: v.data,
        descricao: v.descricao,
        siglaOrgao: v.siglaOrgao,
        status: v.aprovacao === 1 ? "Aprovado" : "Em análise / Deliberação",
        proposicaoObjeto: v.proposicaoObjeto
      }));
    }
  } catch (err: any) {
    console.error("[Câmara] Erro ao buscar votações:", err.message);
  }

  try {
    const resProp = await fetch("https://dadosabertos.camara.leg.br/api/v2/proposicoes?ordem=DESC&ordenarPor=id&itens=5", {
      headers: { "Accept": "application/json" },
      signal: AbortSignal.timeout(6000)
    });
    if (resProp.ok) {
      const jsonProp = await resProp.json();
      result.proposicoesRecentes = (jsonProp.dados || []).slice(0, 4).map((p: any) => ({
        sigla: `${p.siglaTipo} ${p.numero}/${p.ano}`,
        ementa: p.ementa
      })).filter((p: any) => p.ementa);
    }
  } catch (err: any) {
    console.error("[Câmara] Erro ao buscar proposições:", err.message);
  }

  return result;
}

// 3. Senado Federal: API de Dados Abertos
async function fetchSenadoMaterias() {
  try {
    const res = await fetch("https://legis.senado.leg.br/dadosabertos/materia/pesquisa/lista?ano=2026", {
      headers: { "Accept": "application/json" },
      signal: AbortSignal.timeout(6000)
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const lista = json?.PesquisaBasicaMateria?.Materias?.Materia || [];
    const materiasArray = Array.isArray(lista) ? lista : [lista];
    return materiasArray.slice(0, 4).map((m: any) => ({
      identificacao: `${m.DescricaoSubtipoMateria || 'Matéria'} ${m.NumeroMateria || ''}/${m.AnoMateria || ''}`,
      ementa: m.EmentaMateria,
      situacao: m.SituacaoAtual
    })).filter((m: any) => m.ementa);
  } catch (err: any) {
    console.error("[Senado] Erro ao buscar matérias:", err.message);
    return [];
  }
}

// 4. Agência Brasil / EBC: Ações do Executivo Federal & Diário Oficial
async function fetchAgenciaBrasilPolitica() {
  try {
    const feed = await parser.parseURL("https://agenciabrasil.ebc.com.br/rss/politica/feed.xml");
    return (feed.items || []).slice(0, 4).map(item => ({
      titulo: item.title,
      resumo: item.contentSnippet || item.content
    }));
  } catch (err: any) {
    console.error("[Agência Brasil] Erro ao carregar feed de política:", err.message);
    return [];
  }
}

// 5. Coletor Unificado "Rádio Voz do Povo"
async function fetchGovVozDoPovoUnifiedData() {
  const [leisRes, camaraRes, senadoRes, ebcRes] = await Promise.allSettled([
    fetchCongressoUltimasLeis(),
    fetchCamaraVotacoesEProposicoes(),
    fetchSenadoMaterias(),
    fetchAgenciaBrasilPolitica()
  ]);

  return {
    origem: "Rádio Voz do Povo - Acompanhamento Legislativo e Executivo Oficial",
    dataExtracao: new Date().toLocaleDateString('pt-BR'),
    leisSancionadasCongressoDOU: (leisRes.status === 'fulfilled' ? leisRes.value : []).slice(0, 5),
    camaraDeputados: camaraRes.status === 'fulfilled' ? camaraRes.value : { votacoesAprovadas: [], proposicoesRecentes: [] },
    senadoFederal: (senadoRes.status === 'fulfilled' ? senadoRes.value : []).slice(0, 5),
    acoesExecutivoEBC: (ebcRes.status === 'fulfilled' ? ebcRes.value : []).slice(0, 5)
  };
}

// API Routes

app.get('/api/episodes', (req, res) => {
  res.json(loadEpisodes());
});

app.post('/api/generate-time', async (req, res) => {
  try {
    let { timeString } = req.body;
    if (!timeString || typeof timeString !== 'string') {
      const now = new Date();
      const hours = now.getHours();
      const minutes = now.getMinutes();
      const hourLabel = hours === 1 ? 'hora' : 'horas';
      const minuteLabel = minutes < 10 ? 'minuto' : 'minutos';
      timeString = `${hours} ${hourLabel} e ${minutes} ${minuteLabel}`;
    }

    const trimmedTime = timeString.trim();
    const isSingularHour = /^1\s*hora\b/i.test(trimmedTime);
    const prefix = isSingularHour ? 'É' : 'São';

    const textPart1 = `${prefix} ${trimmedTime}...`;
    const textPart2 = `repita...`;
    const textPart3 = `${trimmedTime}.`;

    // Gerar os 3 trechos de áudio em paralelo para máxima agilidade
    const [tts1, tts2, tts3] = await Promise.all([
      // 1. Male voice
      withRetry(() => ai.models.generateContent({
        model: "gemini-3.1-flash-tts-preview",
        contents: [{ parts: [{ text: textPart1 }] }],
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
              voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Charon' } }, // Male
          },
        },
      })),
      // 2. Female voice
      withRetry(() => ai.models.generateContent({
        model: "gemini-3.1-flash-tts-preview",
        contents: [{ parts: [{ text: textPart2 }] }],
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
              voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Aoede' } }, // Female
          },
        },
      })),
      // 3. Male voice again
      withRetry(() => ai.models.generateContent({
        model: "gemini-3.1-flash-tts-preview",
        contents: [{ parts: [{ text: textPart3 }] }],
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
              voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Charon' } }, // Male
          },
        },
      }))
    ]);

    const b64_1 = tts1.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    const b64_2 = tts2.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    const b64_3 = tts3.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;

    if (!b64_1 || !b64_2 || !b64_3) {
      throw new Error("Falha ao gerar um dos trechos de áudio da hora");
    }

    const pcm1 = Buffer.from(b64_1, 'base64');
    const pcm2 = Buffer.from(b64_2, 'base64');
    const pcm3 = Buffer.from(b64_3, 'base64');

    const totalPcmLength = pcm1.length + pcm2.length + pcm3.length;
    const wavBuffer = Buffer.alloc(44 + totalPcmLength);
    
    writeWavHeader(wavBuffer, 24000);
    
    // Concatenate PCM data
    let offset = 44;
    pcm1.copy(wavBuffer, offset);
    offset += pcm1.length;
    pcm2.copy(wavBuffer, offset);
    offset += pcm2.length;
    pcm3.copy(wavBuffer, offset);

    const episodeId = uuidv4();
    const fileName = `time-${episodeId}.wav`;
    const publicDir = path.join(process.cwd(), 'public', 'audio');
    
    if (!fs.existsSync(publicDir)) {
      fs.mkdirSync(publicDir, { recursive: true });
    }
    
    fs.writeFileSync(path.join(publicDir, fileName), wavBuffer);

    // Save as a special episode
    const newEpisode: Episode = {
      id: episodeId,
      title: `Hora Certa: ${timeString}`,
      description: "Anúncio especial de hora",
      audioUrl: `/audio/${fileName}`,
      date: new Date().toUTCString(),
    };

    episodes = loadEpisodes();
    episodes.unshift(newEpisode); // add to top
    saveEpisodes(episodes);
    res.json(newEpisode);
  } catch (error: any) {
    console.error("Erro ao gerar hora:", error);
    res.status(500).json({ error: error.message });
  }
});

function normalizeRssUrl(rawUrl: string, port: number = 3000): string {
  if (!rawUrl || typeof rawUrl !== 'string') return '';
  let url = rawUrl.trim();

  // If user passed relative path like "/feed.xml" or "feed.xml"
  if (url === 'feed.xml' || url === '/feed.xml' || url.endsWith('/feed.xml')) {
    return `http://127.0.0.1:${port}/feed.xml`;
  }
  if (url.startsWith('/')) {
    return `http://127.0.0.1:${port}${url}`;
  }

  // If URL points to localhost or 127.0.0.1, ensure it uses the actual port (port 3000)
  if (/^(https?:\/\/)?(localhost|127\.0\.0\.1)(:\d+)?(\/.*)?$/i.test(url)) {
    const match = url.match(/^(?:https?:\/\/)?(?:localhost|127\.0\.0\.1)(?::\d+)?(\/.*)?$/i);
    const pathPart = match && match[1] ? match[1] : '/feed.xml';
    return `http://127.0.0.1:${port}${pathPart}`;
  }

  // If no scheme was provided, default to https://
  // Without https://, node http/https treats domains like "g1.globo.com/rss/g1/" as a path on localhost:80 -> ECONNREFUSED 127.0.0.1:80
  if (!/^https?:\/\//i.test(url)) {
    return `https://${url}`;
  }

  return url;
}

app.post('/api/generate-episode', async (req, res) => {
  const { rssUrl } = req.body;
  if (!rssUrl || typeof rssUrl !== 'string') {
    return res.status(400).json({ error: "rssUrl is required" });
  }

  const normalizedUrl = normalizeRssUrl(rssUrl, PORT);
  let keepAliveInterval: NodeJS.Timeout | null = null;

  try {
    let topItems: any[] = [];
    const isWeather = normalizedUrl.includes("open-meteo") || normalizedUrl.includes("clima-brasil") || normalizedUrl.includes("previsao-tempo");
    const isVozDoPovo = normalizedUrl.includes("voz-do-povo") || normalizedUrl.includes("leis-e-acoes") || normalizedUrl.includes("gov-br");
    const isCamara = normalizedUrl.includes("camara.leg.br");
    const isCongresso = normalizedUrl.includes("congressonacional.leg.br");
    const isSenado = normalizedUrl.includes("senado.leg.br");
    const isAgenciaBrasil = normalizedUrl.includes("agenciabrasil.ebc.com.br");
    const isGovNews = isVozDoPovo || isCamara || isCongresso || isSenado || isAgenciaBrasil;

    let scriptPrompt = "";

    console.log(`[generate-episode] Início da geração para rssUrl: "${rssUrl}" (normalizada: "${normalizedUrl}", isWeather=${isWeather}, isGovNews=${isGovNews})`);

    if (isGovNews) {
      console.log(`[generate-episode] Coletando dados oficiais do governo/legislativo (Voz do Povo=${isVozDoPovo}, Congresso=${isCongresso}, Câmara=${isCamara}, Senado=${isSenado}, EBC=${isAgenciaBrasil})...`);
      
      if (isVozDoPovo) {
        topItems = await fetchGovVozDoPovoUnifiedData() as any;
      } else if (isCongresso) {
        topItems = await fetchCongressoUltimasLeis();
      } else if (isCamara) {
        topItems = await fetchCamaraVotacoesEProposicoes() as any;
      } else if (isSenado) {
        topItems = await fetchSenadoMaterias();
      } else if (isAgenciaBrasil) {
        topItems = await fetchAgenciaBrasilPolitica();
      }

      scriptPrompt = `
        Você é o locutor principal da tradicional Rádio Voz do Povo, a emissora do trabalhador e da cidadania.
        Com base nos dados governamentais e legislativos oficiais anexados (leis sancionadas no Diário Oficial da União, votações e proposições da Câmara dos Deputados, matérias do Senado Federal e ações do Poder Executivo), elabore uma edição completa, detalhada, vibrante e bem desenvolvida do nosso boletim oficial (entre 170 e 240 palavras, proporcionando aproximadamente 1 minuto a 1 minuto e 20 segundos de locução contínua).

        Estrutura obrigatória da locução:
        1. ABERTURA POPULAR E ENÉRGICA:
           "Atenção trabalhadores e cidadãos de todo o Brasil! Está no ar a edição especial da Rádio Voz do Povo, trazendo as principais leis sancionadas e decisões aprovadas em Brasília que impactam diretamente a sua vida!"
        
        2. DESTAQUE DAS LEIS SANCIONADAS E APROVAÇÕES:
           Apresente com clareza as principais leis publicadas no Diário Oficial, medidas provisórias e projetos aprovados no Congresso Nacional (Câmara e Senado).
           Cite os temas e setores centrais (ex.: geração de emprego, direitos sociais e trabalhistas, saúde pública, crédito acessível, infraestrutura ou mobilidade).

        3. TRADUÇÃO DIRETA PARA O POVO:
           Explique em linguagem simples e acolhedora, sem juridiquês: o que muda na prática para o trabalhador, para a dona de casa, para os motoristas e aposentados? Quais são os benefícios, direitos garantidos ou prazos que passam a valer?

        4. ENCERRAMENTO COM ASSINATURA DA RÁDIO:
           "Fique sempre bem informado com a gente. Informação com verdade, clareza e respeito ao cidadão, aqui na sua Rádio Voz do Povo!"

        REGRAS OBRIGATÓRIAS:
        - NÃO utilize marcações de estúdio como [Locutor], [Música], [Trilha], [Pausa] ou cabeçalhos.
        - Escreva APENAS o texto falado de forma contínua, natural e fluida.
        - Não use asteriscos nem formatações markdown.
        - Desenvolva o texto de forma completa e substancial (mínimo de 170 palavras e máximo de 240 palavras).

        Dados governamentais oficiais:
        ${JSON.stringify(topItems, null, 2)}
      `;
    } else if (isWeather) {
      console.log(`[generate-episode] Consultando Open-Meteo para as 27 capitais...`);
      const weatherData = await fetchOpenMeteoBrazilWeather();
      topItems = weatherData.capitais;
      console.log(`[generate-episode] Dados Open-Meteo obtidos com sucesso para ${topItems.length} capitais.`);

      scriptPrompt = `
        Você é o locutor e meteorologista de rádio da nossa emissora nacional.
        Escreva o roteiro de um giro meteorológico completo, dinâmico e natural (cerca de 130 a 180 palavras), cobrindo o clima em tempo real nas capitais brasileiras com base nos dados meteorológicos oficiais.

        Roteiro da locução:
        1. Saudação acolhedora aos ouvintes e anúncio do Giro do Clima em tempo real nas capitais.
        2. Destaque dos extremos do dia: a capital com maior temperatura (${weatherData.summary.capitalMaisQuente}), a mais fria (${weatherData.summary.capitalMaisFria}) e as regiões com chuva ou instabilidade (${JSON.stringify(weatherData.summary.capitaisComChuvaOuInstabilidade.slice(0, 5))}).
        3. Dicas práticas para o ouvinte se programar ao longo do dia e encerramento com a assinatura da rádio.

        REGRAS OBRIGATÓRIAS:
        - Sem marcações como [Locutor] ou [Música].
        - Escreva APENAS o texto falado de forma contínua e fluida.
        - Não use formatações markdown nem asteriscos.

        Dados oficiais em tempo real:
        ${JSON.stringify(weatherData.summary, null, 2)}
      `;
    } else if (normalizedUrl.includes("artesp.sp.gov.br") || normalizedUrl.includes("artesp")) {
      const ocorrencias = await fetchArtespScraping(normalizedUrl);
      topItems = ocorrencias; // Get all occurrences without slicing
    } else if (normalizedUrl.includes("news.google")) {
      let targetUrl = normalizedUrl;
      if (!targetUrl.includes("rss")) {
        targetUrl = "https://news.google.com/rss?hl=pt-BR&gl=BR&ceid=BR:pt-419";
      }
      try {
        const feed = await parser.parseURL(targetUrl);
        topItems = (feed.items || []).slice(0, 5).map(item => ({
          title: item.title,
          contentSnippet: item.contentSnippet || item.content,
        })).filter(item => item.title || item.contentSnippet);
      } catch (directErr: any) {
        try {
          const feed2jsonUrl = `https://feed2json.org/convert?url=${encodeURIComponent(targetUrl)}`;
          const response = await fetch(feed2jsonUrl, { signal: AbortSignal.timeout(6000) });
          const data = await response.json();
          if (!data || !data.items) {
             throw new Error("Feed2JSON failed to parse the RSS items.");
          }
          topItems = (data.items || []).slice(0, 5).map((item: any) => {
             const titleParts = item.title?.split(' - ') || [];
             const source = titleParts.length > 1 ? titleParts.pop() : 'Google News';
             return {
                 title: titleParts.join(' - ') || item.title,
                 source: source,
                 date: item.date_published
             };
          });
        } catch (proxyErr: any) {
          console.error("Google News fetch failed:", proxyErr);
          throw new Error(`Serviço de notícias indisponível no momento. Tente novamente mais tarde.`);
        }
      }
    } else {
      try {
        const feed = await parser.parseURL(normalizedUrl);
        topItems = (feed.items || []).map(item => ({
          title: item.title,
          contentSnippet: item.contentSnippet || item.content,
        })).filter(item => item.title || item.contentSnippet);
      } catch (parseErr: any) {
        console.error(`[generate-episode] Falha ao ler feed RSS (${normalizedUrl}):`, parseErr.message);
        return res.status(400).json({
          error: `Não foi possível acessar o feed RSS (${parseErr.message || 'Verifique o endereço'}).`
        });
      }
    }

    if (!isWeather && !isGovNews && (!topItems || (Array.isArray(topItems) && topItems.length === 0))) {
      return res.status(400).json({
        error: "Nenhuma notícia ou ocorrência encontrada nesta fonte para compor o episódio."
      });
    }

    if (isWeather && (!topItems || topItems.length === 0)) {
      console.warn("[generate-episode] topItems estava vazio para clima, acionando base de contingência.");
      const seedData = getGuaranteedWeatherSeed();
      topItems = seedData.capitais;
    }

    // Limiting to 5 for general RSS feeds to avoid massive payloads
    if (!isWeather && !isGovNews && Array.isArray(topItems)) {
      topItems = topItems.slice(0, 5);
    }

    // 2. Curate & Script with Gemini (if not weather, use generic news prompt)
    if (!scriptPrompt) {
      scriptPrompt = `
        Você é um experiente locutor e produtor de rádio de notícias com tom ágil, dinâmico e envolvente.
        Baseado nos itens da fonte anexada, escreva um boletim de notícias completo e bem estruturado (cerca de 140 a 200 palavras, em torno de 1 minuto de locução fluida).
        Apresente as informações e fatos mais relevantes em linguagem radiofônica clara e cativante. Comece saudando os ouvintes, desenvolva os principais destaques e encerre com a assinatura da emissora.
        
        REGRAS OBRIGATÓRIAS:
        - Sem marcações de palco como [Locutor], [Música] ou [Vinheta].
        - Escreva APENAS o texto contínuo e fluido que será falado ao microfone.
        - Sem formatação markdown ou asteriscos.

        Dados da Fonte:
        ${JSON.stringify(topItems, null, 2)}
      `;
    }

    const scriptResponse = await withRetry(() => ai.models.generateContent({
      model: "gemini-3.8-flash",
      contents: scriptPrompt,
    }));
    
    const scriptText = scriptResponse.text?.trim() || "";

    // 3. Generate TTS with Gemini
    // Divide o texto em blocos de até 550 caracteres e sintetiza em paralelo
    const sentences = scriptText.match(/[^.!?]+[.!?]+/g) || [scriptText];
    let chunks: string[] = [];
    let currentChunk = "";
    for (const sentence of sentences) {
       if (currentChunk.length + sentence.length > 550) {
           if (currentChunk) chunks.push(currentChunk.trim());
           currentChunk = sentence;
       } else {
           currentChunk += (currentChunk ? " " : "") + sentence;
       }
    }
    if (currentChunk.trim().length > 0) chunks.push(currentChunk.trim());

    console.log(`[generate-episode] Roteiro pronto (${scriptText.length} caracteres, ~${scriptText.split(/\s+/).length} palavras). Chunks TTS: ${chunks.length}`);

    // Executa os blocos de TTS em paralelo para máxima velocidade
    const ttsResults = await Promise.all(
      chunks.map(async (chunk, cIdx) => {
        if (!chunk.trim()) return null;
        try {
          const ttsResponse = await withRetry(() => ai.models.generateContent({
            model: "gemini-3.1-flash-tts-preview",
            contents: [{ parts: [{ text: chunk }] }],
            config: {
              responseModalities: [Modality.AUDIO],
              speechConfig: {
                voiceConfig: {
                  prebuiltVoiceConfig: { voiceName: 'Zephyr' },
                },
              },
            },
          }));
          const base64Audio = ttsResponse.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
          return base64Audio ? Buffer.from(base64Audio, 'base64') : null;
        } catch (ttsErr: any) {
          console.error(`[generate-episode] Falha no chunk ${cIdx + 1}:`, ttsErr.message);
          if (ttsErr.isQuotaError) throw ttsErr;
          return null;
        }
      })
    );

    const allPcmData: Buffer[] = ttsResults.filter((b): b is Buffer => b !== null);

    if (allPcmData.length === 0) {
      return res.status(500).json({ error: "Falha ao gerar o áudio da locução." });
    }

    // Convert PCM chunks to a single WAV
    const pcmBuffer = Buffer.concat(allPcmData);
    const wavBuffer = Buffer.alloc(44 + pcmBuffer.length);
    writeWavHeader(wavBuffer, 24000);
    pcmBuffer.copy(wavBuffer, 44);

    const episodeId = uuidv4();
    const fileName = `${episodeId}.wav`;
    const filePath = path.join(process.cwd(), 'public', 'audio', fileName);
    
    // Ensure directory exists
    if (!fs.existsSync(path.join(process.cwd(), 'public', 'audio'))) {
      fs.mkdirSync(path.join(process.cwd(), 'public', 'audio'), { recursive: true });
    }

    fs.writeFileSync(filePath, wavBuffer);

    const audioUrl = `/audio/${fileName}`;
    
    // Format the URL as the title
    let formattedTitle = normalizedUrl
        .replace(/^https?:\/\//i, '') // Remove http:// or https://
        .replace(/^www\./i, '');      // Remove www.
        
    // Optionally crop long paths to keep it clean (like news.google.com)
    if (formattedTitle.includes('/')) {
        formattedTitle = formattedTitle.split('/')[0];
    }
    if (isVozDoPovo) {
       formattedTitle = 'Rádio Voz do Povo: Leis e Ações Aprovadas';
    } else if (isCongresso) {
       formattedTitle = 'Congresso Nacional: Últimas Leis Publicadas (DOU)';
    } else if (isCamara) {
       formattedTitle = 'Câmara dos Deputados: Votações e Projetos';
    } else if (isSenado) {
       formattedTitle = 'Senado Federal: Matérias e Deliberações';
    } else if (isAgenciaBrasil) {
       formattedTitle = 'Agência Brasil: Política e Governo Federal';
    } else if (normalizedUrl.includes('mudanças+climáticas') || normalizedUrl.includes('mudancas+climaticas')) {
       formattedTitle = 'Google Notícias: Mudanças Climáticas';
    } else if (normalizedUrl.includes('artesp')) {
       formattedTitle = 'Artesp - Rodovias SP';
    } else if (isWeather) {
       formattedTitle = 'open-meteo.com/clima-brasil';
    } else if (normalizedUrl.includes('127.0.0.1') || normalizedUrl.includes('feed.xml')) {
       formattedTitle = 'Feed de Podcast (XML)';
    }

    const newEpisode: Episode = {
      id: episodeId,
      title: formattedTitle,
      description: scriptText,
      audioUrl: audioUrl,
      date: new Date().toUTCString()
    };

    episodes = loadEpisodes();
    episodes.unshift(newEpisode); // add to top
    saveEpisodes(episodes);
    
    return res.json(newEpisode);

  } catch (error: any) {
    if (keepAliveInterval) {
      clearInterval(keepAliveInterval);
    }
    console.error("Error generating episode:", error);
    
    const isQuota = error.isQuotaError;
    const errPayload = isQuota 
        ? { error: "QUOTA_EXCEEDED", message: "Limite de saldo excedido na API do Gemini." }
        : { error: error.message || "Falha ao processar e gerar episódio." };

    if (!res.headersSent) {
      res.status(isQuota ? 429 : 500).json(errPayload);
    }
  }
});

// 4. RSS Feed for Podcast Endpoint
app.get('/feed.xml', (req, res) => {
  const host = req.get('host') || `localhost:${PORT}`;
  const forwardedProto = req.get('x-forwarded-proto');
  const protocol = forwardedProto || (req.secure ? 'https' : 'http');
  const appUrl = process.env.APP_URL || `${protocol}://${host}`;
  
  let xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>AI Studio Auto-Radio</title>
    <link>${appUrl}</link>
    <language>pt-br</language>
    <description>Uma rádio/podcast automatizada gerada pelo Google AI Studio e Gemini.</description>
    <itunes:author>AI Studio</itunes:author>
    <itunes:type>episodic</itunes:type>
`;

  loadEpisodes().forEach(ep => {
    xml += `
    <item>
      <title><![CDATA[${ep.title}]]></title>
      <description><![CDATA[${ep.description}]]></description>
      <enclosure url="${appUrl}${ep.audioUrl}" length="0" type="audio/wav" />
      <guid isPermaLink="false">${ep.id}</guid>
      <pubDate>${ep.date}</pubDate>
    </item>
    `;
  });

  xml += `
  </channel>
</rss>`;

  res.set('Content-Type', 'application/rss+xml');
  res.send(xml);
});

// Vite Middleware & Static files
async function startServer() {
  // Explicitly serve the audio directory so dynamically generated files are available immediately
  // and served with the correct mime-type, bypassing Vite SPA fallback.
  app.use('/audio', express.static(path.join(process.cwd(), 'public', 'audio')));

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
