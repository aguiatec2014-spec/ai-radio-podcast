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

let episodes: Episode[] = [];

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

// API Routes

app.get('/api/episodes', (req, res) => {
  res.json(episodes);
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

    episodes.unshift(newEpisode); // add to top
    res.json(newEpisode);
  } catch (error: any) {
    console.error("Erro ao gerar hora:", error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/generate-episode', async (req, res) => {
  const { rssUrl } = req.body;
  if (!rssUrl) {
    return res.status(400).json({ error: "rssUrl is required" });
  }

  try {
    let topItems: any[] = [];

    // 1. Fetch RSS Feed or perform Custom Scraping
    if (rssUrl.includes("artesp.sp.gov.br")) {
      const ocorrencias = await fetchArtespScraping(rssUrl);
      topItems = ocorrencias; // Get all occurrences without slicing
    } else if (rssUrl.includes("news.google")) {
      let targetUrl = rssUrl;
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
      const feed = await parser.parseURL(rssUrl);
      topItems = feed.items.map(item => ({
        title: item.title,
        contentSnippet: item.contentSnippet || item.content,
      }));
    }

    // Limiting to 5 to avoid exceedingly massive payloads and long generation times.
    topItems = topItems.slice(0, 5);

    // 2. Curate & Script with Gemini
    const scriptPrompt = `
      Você é um produtor e locutor de rádio de notícias (com um tom jornalístico, natural e dinâmico).
      Baseado nos seguintes itens de notícias ou ocorrências obtidas da fonte, escreva um roteiro de rádio conciso (cerca de 1 a 2 minutos de fala).
      Sintetize as principais informações de forma coesa e interessante.
      Não inclua marcações de palco como [Música] ou [Locutor]. 
      Escreva APENAS o que o locutor deve falar, de forma fluida.
      Apresente-se como o host da nossa rádio automatizada, comece saudando os ouvintes, traga os destaques das notícias e encerre a transmissão.
      
      Dados da Fonte:
      ${JSON.stringify(topItems, null, 2)}
    `;

    const scriptResponse = await withRetry(() => ai.models.generateContent({
      model: "gemini-3.8-flash",
      contents: scriptPrompt,
    }));
    
    const scriptText = scriptResponse.text?.trim() || "";

    // Começamos a enviar cabeçalhos e espaços em branco para manter a conexão ativa (evitar timeout do Nginx/Browser)
    res.setHeader('Content-Type', 'application/json');
    const keepAliveInterval = setInterval(() => {
      res.write(' ');
    }, 15000);

    // 3. Generate TTS with Gemini
    // Divide o texto em blocos menores para não estourar o limite da API de TTS e processar aos poucos
    const sentences = scriptText.match(/[^.!?]+[.!?]+/g) || [scriptText];
    let chunks: string[] = [];
    let currentChunk = "";
    for (const sentence of sentences) {
       if (currentChunk.length + sentence.length > 2000) {
           if (currentChunk) chunks.push(currentChunk.trim());
           currentChunk = sentence;
       } else {
           currentChunk += (currentChunk ? " " : "") + sentence;
       }
    }
    if (currentChunk.trim().length > 0) chunks.push(currentChunk.trim());

    let allPcmData: Buffer[] = [];
    
    for (const chunk of chunks) {
       if (!chunk) continue;
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
    let formattedTitle = rssUrl
        .replace(/^https?:\/\//i, '') // Remove http:// or https://
        .replace(/^www\./i, '');      // Remove www.
        
    // Optionally crop long paths to keep it clean (like news.google.com)
    if (formattedTitle.includes('/')) {
        formattedTitle = formattedTitle.split('/')[0];
    }
    // If it was the Google News search string specifically, we can make it prettier:
    if (rssUrl.includes('mudanças+climáticas')) {
       formattedTitle = 'Google Notícias: Mudanças Climáticas';
    } else if (rssUrl.includes('artesp')) {
       formattedTitle = 'Artesp - Rodovias SP';
    }

    const newEpisode: Episode = {
      id: episodeId,
      title: formattedTitle,
      description: scriptText,
      audioUrl: audioUrl,
      date: new Date().toUTCString()
    };

    episodes.unshift(newEpisode); // add to top
    
    res.write(JSON.stringify(newEpisode));
    res.end();

  } catch (error: any) {
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
  const appUrl = process.env.APP_URL || `http://localhost:${PORT}`;
  
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

  episodes.forEach(ep => {
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
