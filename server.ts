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
      }
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

let cachedWeatherData: any = null;
let lastWeatherFetchTime: number = 0;
const WEATHER_CACHE_TTL = 15 * 60 * 1000; // 15 minutes

async function fetchOpenMeteoBrazilWeather() {
  const now = Date.now();
  if (cachedWeatherData && (now - lastWeatherFetchTime < WEATHER_CACHE_TTL)) {
    console.log("[Open-Meteo] Retornando dados do cache (cache fresh).");
    return cachedWeatherData;
  }

  const lats = BRAZIL_CAPITALS.map(c => c.lat).join(",");
  const lons = BRAZIL_CAPITALS.map(c => c.lon).join(",");
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lats}&longitude=${lons}&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m&timezone=America%2FSao_Paulo`;

  console.log("[Open-Meteo] Buscando novos dados da API...");
  const response = await fetch(url);
  if (!response.ok) {
    if (response.status === 429 && cachedWeatherData) {
       console.warn("[Open-Meteo] Recebido 429, mas temos cache (mesmo expirado). Usando cache de emergência.");
       return cachedWeatherData;
    }
    throw new Error(`Erro ao consultar API Open-Meteo: Status ${response.status}`);
  }
  const data = await response.json();
  if (!Array.isArray(data) || data.length !== BRAZIL_CAPITALS.length) {
    throw new Error("Formato de resposta inesperado retornado pela API Open-Meteo");
  }

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

  const sortedByTemp = [...capitalWeather].sort((a, b) => b.temperatura - a.temperatura);
  const maisQuente = sortedByTemp[0];
  const maisFria = sortedByTemp[sortedByTemp.length - 1];
  const comChuva = capitalWeather.filter(c => c.chuva_mm > 0 || c.condicao.toLowerCase().includes("chuva") || c.condicao.toLowerCase().includes("tempestade"));

  const regioes: Record<string, any[]> = {
    "Sudeste": capitalWeather.filter(c => c.regiao === "Sudeste"),
    "Sul": capitalWeather.filter(c => c.regiao === "Sul"),
    "Nordeste": capitalWeather.filter(c => c.regiao === "Nordeste"),
    "Centro-Oeste": capitalWeather.filter(c => c.regiao === "Centro-Oeste"),
    "Norte": capitalWeather.filter(c => c.regiao === "Norte")
  };

  cachedWeatherData = {
    capitais: capitalWeather,
    summary: {
      totalCapitais: 27,
      capitalMaisQuente: `${maisQuente.cidade} com ${maisQuente.temperatura}°C (${maisQuente.condicao})`,
      capitalMaisFria: `${maisFria.cidade} com ${maisFria.temperatura}°C (${maisFria.condicao})`,
      capitaisComChuvaOuInstabilidade: comChuva.length > 0 ? comChuva.map(c => `${c.cidade}: ${c.condicao} com ${c.temperatura}°C`) : ["Nenhuma capital com chuva registrada no momento"],
      panoramaPorRegioes: regioes
    }
  };
  
  lastWeatherFetchTime = now;
  return cachedWeatherData;
}

// API Routes

app.get('/api/episodes', (req, res) => {
  res.json(loadEpisodes());
});

app.post('/api/generate-time', async (req, res) => {
  try {
    const { timeString } = req.body;
    if (!timeString) {
      return res.status(400).json({ error: "timeString is required" });
    }

    const textPart1 = `São ${timeString}...`;
    const textPart2 = `repita...`;
    const textPart3 = `${timeString}.`;

    // 1. Male voice
    const tts1 = await withRetry(() => ai.models.generateContent({
      model: "gemini-3.1-flash-tts-preview",
      contents: [{ parts: [{ text: textPart1 }] }],
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Charon' } }, // Male
        },
      },
    }));

    // 2. Female voice
    const tts2 = await withRetry(() => ai.models.generateContent({
      model: "gemini-3.1-flash-tts-preview",
      contents: [{ parts: [{ text: textPart2 }] }],
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Aoede' } }, // Female
        },
      },
    }));

    // 3. Male voice again
    const tts3 = await withRetry(() => ai.models.generateContent({
      model: "gemini-3.1-flash-tts-preview",
      contents: [{ parts: [{ text: textPart3 }] }],
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Charon' } }, // Male
        },
      },
    }));

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
    let scriptPrompt = "";

    console.log(`[generate-episode] Início da geração para rssUrl: "${rssUrl}" (normalizada: "${normalizedUrl}", isWeather=${isWeather})`);

    if (isWeather) {
      console.log(`[generate-episode] Consultando Open-Meteo para as 27 capitais...`);
      const weatherData = await fetchOpenMeteoBrazilWeather();
      topItems = weatherData.capitais;
      console.log(`[generate-episode] Dados Open-Meteo obtidos com sucesso para ${topItems.length} capitais.`);

      scriptPrompt = `
        Você é o locutor e meteorologista de rádio de uma prestigiada emissora nacional.
        Escreva o roteiro de um boletim de previsão do tempo dinâmico, natural e envolvente (cerca de 1 minuto de fala, por volta de 150 a 220 palavras), cobrindo o clima em tempo real no Brasil com base nas coordenadas de todas as 27 capitais obtidas via API Open-Meteo.

        Roteiro da locução:
        1. Abertura com uma saudação calorosa aos ouvintes e anúncio do Giro Meteorológico Nacional das Capitais.
        2. Destaque dos extremos meteorológicos:
           - A capital que registra a maior temperatura: ${weatherData.summary.capitalMaisQuente}
           - A capital com a menor temperatura: ${weatherData.summary.capitalMaisFria}
           - Capitais com registro de chuva ou instabilidade: ${JSON.stringify(weatherData.summary.capitaisComChuvaOuInstabilidade)}
        3. Um panorama ágil pelas regiões brasileiras destacando temperaturas e tempo predominante no Sudeste, Sul, Nordeste, Centro-Oeste e Norte.
        4. Recomendações práticas aos ouvintes e encerramento com a assinatura da emissora.

        REGRAS OBRIGATÓRIAS:
        - Não coloque marcações como [Locutor], [Música] ou notas de produção.
        - Escreva APENAS o texto falado de forma contínua e fluida.
        - Não use asteriscos nem formatações markdown.

        Dados oficiais em tempo real das 27 capitais:
        ${JSON.stringify(weatherData.summary, null, 2)}
      `;
    } else if (normalizedUrl.includes("artesp.sp.gov.br") || normalizedUrl.includes("artesp")) {
      const ocorrencias = await fetchArtespScraping(normalizedUrl);
      topItems = ocorrencias; // Get all occurrences without slicing
    } else if (normalizedUrl.includes("news.google")) {
      let targetUrl = normalizedUrl;
      // If it's a raw google news URL without RSS, default to top news.
      // But if it ALREADY has 'rss' (like the search url), use it as is!
      if (!targetUrl.includes("rss")) {
        targetUrl = "https://news.google.com/rss?hl=pt-BR&gl=BR&ceid=BR:pt-419";
      }
      
      // Google News is extremely aggressive in blocking bot requests (503/403) from cloud IPs.
      // We directly use feed2json to safely parse it without hitting their WAF or API limits.
      try {
           const feed2jsonUrl = `https://feed2json.org/convert?url=${encodeURIComponent(targetUrl)}`;
           const response = await fetch(feed2jsonUrl);
           const data = await response.json();
           
           if (!data || !data.items) {
              throw new Error("Feed2JSON failed to parse the RSS items.");
           }
           
           topItems = data.items.map((item: any) => {
              const titleParts = item.title?.split(' - ') || [];
              const source = titleParts.length > 1 ? titleParts.pop() : 'Google News';
              return {
                  title: titleParts.join(' - ') || item.title,
                  source: source,
                  date: item.date_published
              };
           });
      } catch (err: any) {
           console.error("Feed2JSON proxy failed:", err);
           throw new Error(`Serviço de leitura de notícias indisponível no momento (${err.message}). Tente novamente mais tarde.`);
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

    if (!topItems || topItems.length === 0) {
      return res.status(400).json({
        error: "Nenhuma notícia ou ocorrência encontrada nesta fonte para compor o episódio."
      });
    }

    // Limiting to 5 for general RSS feeds to avoid massive payloads
    if (!isWeather) {
      topItems = topItems.slice(0, 5);
    }

    // 2. Curate & Script with Gemini (if not weather, use generic news prompt)
    if (!scriptPrompt) {
      scriptPrompt = `
        Você é um produtor e locutor de rádio de notícias (com um tom jornalístico, natural e dinâmico).
        Baseado nos seguintes itens de notícias ou ocorrências obtidas da fonte, escreva um roteiro de rádio conciso (cerca de 1 a 2 minutos de fala).
        Sintetize as principais informações de forma coesa e interessante.
        Não inclua marcações de palco como [Música] ou [Locutor]. 
        Escreva APENAS o que o locutor deve falar, de forma fluida.
        Apresente-se como o host da nossa rádio automatizada, comece saudando os ouvintes, traga os destaques das notícias e encerre a transmissão.
        
        Dados da Fonte:
        ${JSON.stringify(topItems, null, 2)}
      `;
    }

    const scriptResponse = await withRetry(() => ai.models.generateContent({
      model: "gemini-3.8-flash",
      contents: scriptPrompt,
    }));
    
    const scriptText = scriptResponse.text?.trim() || "";

    // Começamos a enviar cabeçalhos e espaços em branco para manter a conexão ativa (evitar timeout do Nginx/Browser)
    res.setHeader('Content-Type', 'application/json');
    keepAliveInterval = setInterval(() => {
      res.write(' ');
    }, 15000);

    // 3. Generate TTS with Gemini
    // Divide o texto em blocos menores para não estourar o limite da API de TTS e processar aos poucos
    const sentences = scriptText.match(/[^.!?]+[.!?]+/g) || [scriptText];
    let chunks: string[] = [];
    let currentChunk = "";
    for (const sentence of sentences) {
       if (currentChunk.length + sentence.length > 600) {
           if (currentChunk) chunks.push(currentChunk.trim());
           currentChunk = sentence;
       } else {
           currentChunk += (currentChunk ? " " : "") + sentence;
       }
    }
    if (currentChunk.trim().length > 0) chunks.push(currentChunk.trim());

    console.log(`[generate-episode] Roteiro pronto (${scriptText.length} caracteres). Chunks para TTS: ${chunks.length}`);

    let allPcmData: Buffer[] = [];
    
    for (let cIdx = 0; cIdx < chunks.length; cIdx++) {
       const chunk = chunks[cIdx];
       if (!chunk) continue;
       console.log(`[generate-episode] Sintetizando TTS chunk ${cIdx + 1}/${chunks.length} (${chunk.length} chars)...`);
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
           if (base64Audio) {
               allPcmData.push(Buffer.from(base64Audio, 'base64'));
               console.log(`[generate-episode] Chunk ${cIdx + 1} TTS sintetizado com sucesso.`);
           }
       } catch (ttsErr: any) {
           console.error("Aviso: Falha ao gerar um bloco de TTS:", ttsErr.message);
           if (ttsErr.isQuotaError) {
             throw ttsErr;
           }
       }
    }

    clearInterval(keepAliveInterval);

    if (allPcmData.length === 0) {
      res.write(JSON.stringify({ error: "Falha geral ao gerar o áudio" }));
      res.end();
      return;
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
    if (normalizedUrl.includes('mudanças+climáticas') || normalizedUrl.includes('mudancas+climaticas')) {
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
    
    res.write(JSON.stringify(newEpisode));
    res.end();

  } catch (error: any) {
    if (keepAliveInterval) {
      clearInterval(keepAliveInterval);
    }
    console.error("Error generating episode:", error);
    
    const isQuota = error.isQuotaError;
    const errPayload = isQuota 
        ? { error: "QUOTA_EXCEEDED", message: "Limite de saldo excedido na API do Gemini." }
        : { error: error.message || "Unknown error" };

    if (!res.headersSent) {
      res.status(isQuota ? 429 : 500).json(errPayload);
    } else {
      res.write(JSON.stringify(errPayload));
      res.end();
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
