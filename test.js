import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";
dotenv.config();
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
async function test() {
  const prompt = "Gere um script com 10.000 caracteres...";
  console.log("Generating text...");
  const res = await ai.models.generateContent({
    model: "gemini-3.8-flash",
    contents: "Write a 5000 word essay about the history of the world."
  });
  const text = res.text;
  console.log("Text generated, length:", text.length);
  console.log("Generating TTS...");
  const ttsRes = await ai.models.generateContent({
    model: "gemini-3.1-flash-tts-preview",
    contents: [{ parts: [{ text: text.substring(0, 5000) }] }],
    config: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Zephyr' } } } }
  });
  console.log("TTS generated!");
}
test().catch(console.error);
