const ALLOWED_VOICES = new Set(["Gacrux", "Charon", "Schedar", "Fenrir"]);

type AudioPart = { data: string; mime: string };

function collectAudio(value: unknown, parts: AudioPart[] = []): AudioPart[] {
  if (!value || typeof value !== "object") return parts;
  const item = value as Record<string, unknown>;
  const data = typeof item.data === "string" ? item.data : null;
  const mime = typeof item.mime_type === "string"
    ? item.mime_type
    : typeof item.mimeType === "string"
      ? item.mimeType
      : "";
  if (data && (mime.startsWith("audio/") || item.type === "audio")) {
    parts.push({ data, mime: mime || "audio/L16;codec=pcm;rate=24000" });
    return parts;
  }
  for (const child of Object.values(item)) {
    if (Array.isArray(child)) child.forEach((nested) => collectAudio(nested, parts));
    else collectAudio(child, parts);
  }
  return parts;
}

function decodeBase64(value: string) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function joinBytes(chunks: Uint8Array[]) {
  const output = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function parseRate(mime: string) {
  const match = mime.match(/rate[=:-](\d+)/i);
  return match ? Number(match[1]) : 24000;
}

function pcm16ToWav(pcm: Uint8Array, sampleRate: number) {
  const wav = new Uint8Array(44 + pcm.byteLength);
  const view = new DataView(wav.buffer);
  const write = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index++) wav[offset + index] = value.charCodeAt(index);
  };
  write(0, "RIFF");
  view.setUint32(4, 36 + pcm.byteLength, true);
  write(8, "WAVE");
  write(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, "data");
  view.setUint32(40, pcm.byteLength, true);
  wav.set(pcm, 44);
  return wav;
}

function parseEventStream(text: string) {
  const events: unknown[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try { events.push(JSON.parse(payload)); } catch { /* Ignore incomplete keepalive events. */ }
  }
  return events;
}

function findErrorMessage(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  if (typeof item.message === "string" && item.message.trim()) return item.message;
  for (const child of Object.values(item)) {
    if (Array.isArray(child)) {
      for (const nested of child) { const message = findErrorMessage(nested); if (message) return message; }
    } else {
      const message = findErrorMessage(child);
      if (message) return message;
    }
  }
  return null;
}

async function responseError(response: Response) {
  const raw = await response.text();
  let result: unknown;
  try { result = JSON.parse(raw); }
  catch { result = parseEventStream(raw); }
  return findErrorMessage(result) || `Google TTS: ${response.status}`;
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as {
      apiKey?: string;
      text?: string;
      voice?: string;
      direction?: string;
      desiredSeconds?: number;
      previousSeconds?: number;
      engine?: string;
    };
    const apiKey = body.apiKey?.trim();
    const script = body.text?.trim();
    if (!script) return Response.json({ error: "Сценарий пуст" }, { status: 400 });
    if (script.length > 12000) return Response.json({ error: "Для теста вставь текст до 12 000 символов" }, { status: 400 });

    const voice = ALLOWED_VOICES.has(body.voice || "") ? body.voice : "Gacrux";
    if (!apiKey) return Response.json({ error: "Нужен Google API key" }, { status: 400 });
    const direction = body.direction?.trim() || "Use Gacrux as a native Russian male narrator, approximately 35–50 years old, with the same overall character as the supplied Qwen reference but cleaner and more natural: a deep warm chest baritone, slightly textured and faintly husky, close-microphone presence, calm intelligence, restrained confidence and a serious psychological-documentary mood. Pronounce every Russian word and stress correctly, keep consonants clear without sounding over-articulated, and preserve subtle human breaths and tiny variations in emphasis. Never produce metallic resonance, digital warble, doubled syllables, broken words, missing endings, unnatural stress, sudden pitch jumps or robotic rhythm. Maintain 108–114 words per minute before final tempo treatment, with short natural pauses and no dramatic silence or stretched vowels. Give the first sentence firm intimate hook emphasis. Avoid advertising enthusiasm, theatrical acting, whispering, singing and exaggerated emotion.";
    const desiredSeconds = Number.isFinite(body.desiredSeconds) ? Math.max(0, Math.min(600, Math.round(body.desiredSeconds || 0))) : 0;
    const previousSeconds = Number.isFinite(body.previousSeconds) ? Math.max(0, Math.round(body.previousSeconds || 0)) : 0;
    const timing = desiredSeconds
      ? `The complete recording must last approximately ${desiredSeconds} seconds. Maintain about ${Math.max(70, Math.round(script.split(/\s+/).length / desiredSeconds * 60))} words per minute within a tolerance of ±3 WPM. Use short sentence pauses of 0.25–0.45 seconds and paragraph pauses no longer than 0.7 seconds. Never elongate vowels or insert dramatic silence. ${previousSeconds ? `The previous attempt lasted ${previousSeconds} seconds, so deliberately ${previousSeconds < desiredSeconds ? "reduce cadence slightly while keeping pauses short" : "increase cadence and remove every long pause"}.` : "Keep the narration continuous and confident."}`
      : "Use a natural medium pace.";
    const prompt = `${direction}\n\n${timing}\nStart immediately with the first line as a powerful hook. Do not add an opening quotation or a long intro unless it is already present in the supplied script. Read the Russian script below verbatim. Do not announce these instructions, do not add an introduction, and do not add or remove any words.\n\nSCRIPT:\n${script}`;
    if (body.engine === "gemini-2.5") {
      const legacyResponse = await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:streamGenerateContent?alt=sse", {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: {
              languageCode: "ru-RU",
              voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } },
            },
          },
        }),
      });
      if (!legacyResponse.ok) return Response.json({ error: await responseError(legacyResponse) }, { status: legacyResponse.status });
      if (!legacyResponse.body) return Response.json({ error: "Gemini 2.5 не вернула поток аудио" }, { status: 502 });
      return new Response(legacyResponse.body, {
        headers: {
          "content-type": legacyResponse.headers.get("content-type") || "text/event-stream",
          "x-gemini-audio-stream": "1",
          "x-gemini-tts-model": "gemini-2.5-flash-preview-tts",
          "cache-control": "no-store",
        },
      });
    }
    const googleResponse = await fetch("https://generativelanguage.googleapis.com/v1beta/interactions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": apiKey,
        "Api-Revision": "2026-05-20",
      },
      body: JSON.stringify({
        model: "gemini-3.1-flash-tts-preview",
        input: prompt,
        response_format: { type: "audio" },
        generation_config: { speech_config: [{ voice }] },
      }),
    });

    if (!googleResponse.ok) {
      const interactionError = await responseError(googleResponse);
      const fallbackResponse = await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:streamGenerateContent?alt=sse", {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: {
              languageCode: "ru-RU",
              voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } },
            },
          },
        }),
      });
      if (!fallbackResponse.ok) {
        const fallbackError = await responseError(fallbackResponse);
        return Response.json({ error: fallbackError || interactionError }, { status: fallbackResponse.status });
      }
      if (!fallbackResponse.body) return Response.json({ error: "Gemini не вернула поток аудио" }, { status: 502 });
      return new Response(fallbackResponse.body, {
        headers: {
          "content-type": fallbackResponse.headers.get("content-type") || "text/event-stream",
          "x-gemini-audio-stream": "1",
          "x-gemini-tts-model": "gemini-2.5-flash-preview-tts",
          "cache-control": "no-store",
        },
      });
    }

    if (!googleResponse.body) return Response.json({ error: "Gemini не вернула поток аудио" }, { status: 502 });
    return new Response(googleResponse.body, {
      headers: {
        "content-type": googleResponse.headers.get("content-type") || "application/json",
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Ошибка Gemini TTS" }, { status: 500 });
  }
}
