const ALLOWED_VOICES = new Set(["Gacrux", "Charon", "Achird", "Schedar", "Fenrir"]);

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

function addExpressiveTags(script: string) {
  return `[calm, relaxed, clear normal conversational volume, fully voiced and never whispering, gently ease into the first words, no hard attack, speaking from personal experience, connect related sentences naturally without resetting the voice, never leave a long empty gap] ${script}`;
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

    const voice = ALLOWED_VOICES.has(body.voice || "") ? body.voice : "Achird";
    if (!apiKey) return Response.json({ error: "Нужен Google API key" }, { status: 400 });
    const direction = body.direction?.trim() || "Use Achird as a natural native Russian man speaking personally to one listener in a calm room. Keep a medium male register around 120–130 Hz, warm rounded timbre, relaxed consonants and normal clear conversational loudness. The voice must be fully voiced and present—never hushed, breathy or whispered. Ease naturally into the first sentence: begin relaxed and unhurried, but clear, with no hard attack or exaggerated stress on the opening words. The speaker understands and cares about each thought, while emotion stays genuine rather than performative. Let meaning create small natural changes in pitch and pace, soften imperfect endings, and give only truly important words a mild emphasis. Connect related sentences as one thought. Keep an average pace near 106–108 words per minute. Sound like a real person thinking aloud—not a narrator, presenter or motivational speaker. Avoid urgency, sternness, dramatic hooks, commanding delivery, perfect studio diction, repeated sentence melody, audiobook cadence, advertising, whispering and stretched vowels. Preserve clear Russian pronunciation.";
    const desiredSeconds = Number.isFinite(body.desiredSeconds) ? Math.max(0, Math.min(600, Math.round(body.desiredSeconds || 0))) : 0;
    const previousSeconds = Number.isFinite(body.previousSeconds) ? Math.max(0, Math.round(body.previousSeconds || 0)) : 0;
    const timing = desiredSeconds
      ? `The complete recording should last approximately ${desiredSeconds} seconds, averaging about ${Math.max(70, Math.round(script.split(/\s+/).length / desiredSeconds * 60))} words per minute. Do not pause mechanically at every full stop. Carry related sentences forward as one continuous thought, using only brief breathing space where a real speaker would need it. Pause more clearly only when the meaning genuinely changes. Never elongate vowels or insert dramatic silence. ${previousSeconds ? `The previous attempt lasted ${previousSeconds} seconds, so ${previousSeconds < desiredSeconds ? "relax the cadence slightly without adding empty gaps" : "tighten the cadence and remove unnecessary gaps"}.` : "Let punctuation guide the rhythm without obeying it mechanically."}`
      : "Use a natural medium pace.";
    const performanceScript = body.engine === "gemini-2.5" ? script : addExpressiveTags(script);
    const prompt = `${direction}\n\n${timing}\nBegin the first line calmly at normal conversational volume, without punching the first word or turning it into a dramatic hook. Keep the sound clear and fully voiced; do not whisper. Do not sound grave or commanding. Text in square brackets contains silent performance directions and must not be spoken. Do not add an opening quotation or a long intro unless it is already present in the supplied script. Read the Russian words below verbatim. Do not announce these instructions, do not add an introduction, and do not add or remove any spoken words.\n\nSCRIPT:\n${performanceScript}`;
    if (body.engine === "gemini-2.5") {
      const legacyResponse = await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:streamGenerateContent?alt=sse", {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 1,
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
          temperature: 1,
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
