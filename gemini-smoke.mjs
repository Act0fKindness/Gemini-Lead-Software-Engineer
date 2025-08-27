import { GoogleGenAI } from "@google/genai";
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const res = await ai.models.generateContent({
  model: "gemini-2.5-pro",
  contents: [{ role: "user", parts: [{ text: "Say pong." }] }]
});
console.log(res.text ?? "");
