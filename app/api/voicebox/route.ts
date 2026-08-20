const VOICEBOX_BASE = "http://127.0.0.1:17493";
const DEFAULT_PROFILE_ID = "6c7a7827-0001-461e-a50e-5703d42c0b54";

type VoiceboxGeneration = {
  id?: string;
  status?: string;
  error?: string | null;
};

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function voiceboxError(response: Response) {
  const raw = await response.text().catch(() => "");
  try {
    const value = JSON.parse(raw) as { detail?: string | Array<{ msg?: string }>; error?: string; message?: string };
    if (typeof value.detail === "string") return value.detail;
    if (Array.isArray(value.detail)) return value.detail.map((item) => item.msg).filter(Boolean).join("; ");
    return value.error || value.message || raw || `Voicebox: ${response.status}`;
  } catch {
    return raw || `Voicebox: ${response.status}`;
  }
}

export const runtime = "nodejs";
export const maxDuration = 900;

export async function POST(request: Request) {
  try {
    const body = await request.json() as { text?: string; profileId?: string };
    const text = body.text?.trim() || "";
    if (!text) return Response.json({ error: "Текст озвучки пуст" }, { status: 400 });
    if (text.length > 4800) return Response.json({ error: "Один фрагмент Voicebox не должен превышать 4800 символов" }, { status: 400 });

    let health: Response;
    try {
      health = await fetch(`${VOICEBOX_BASE}/health`, {
        cache: "no-store",
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      return Response.json({
        error: "Voicebox не запущен. Открой приложение Voicebox и дождись зелёного индикатора сервера.",
      }, { status: 503 });
    }
    if (!health.ok) return Response.json({ error: `Voicebox недоступен: ${await voiceboxError(health)}` }, { status: 503 });

    const createdResponse = await fetch(`${VOICEBOX_BASE}/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        profile_id: body.profileId || DEFAULT_PROFILE_ID,
        text,
        language: "ru",
        engine: "qwen",
        model_size: "1.7B",
        max_chunk_chars: 650,
        normalize: true,
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(30000),
    });
    if (!createdResponse.ok) {
      return Response.json({ error: `Voicebox: ${await voiceboxError(createdResponse)}` }, { status: createdResponse.status });
    }
    const created = await createdResponse.json() as VoiceboxGeneration;
    if (!created.id) return Response.json({ error: "Voicebox не вернул номер задачи" }, { status: 502 });

    for (let check = 0; check < 900; check++) {
      const statusResponse = await fetch(`${VOICEBOX_BASE}/history/${created.id}`, { cache: "no-store" });
      if (!statusResponse.ok) {
        if (statusResponse.status === 404 && check < 5) {
          await sleep(500);
          continue;
        }
        return Response.json({ error: `Voicebox: ${await voiceboxError(statusResponse)}` }, { status: 502 });
      }
      const generation = await statusResponse.json() as VoiceboxGeneration;
      const status = generation.status || "completed";
      if (status === "completed") {
        const audioResponse = await fetch(`${VOICEBOX_BASE}/audio/${created.id}`, { cache: "no-store" });
        if (!audioResponse.ok || !audioResponse.body) {
          return Response.json({ error: `Voicebox создал голос, но не отдал WAV: ${await voiceboxError(audioResponse)}` }, { status: 502 });
        }
        return new Response(audioResponse.body, {
          headers: {
            "content-type": audioResponse.headers.get("content-type") || "audio/wav",
            "cache-control": "no-store",
            "x-voicebox-generation": created.id,
          },
        });
      }
      if (status === "failed" || status === "cancelled") {
        return Response.json({ error: generation.error || `Voicebox: ${status}` }, { status: 502 });
      }
      await sleep(1000);
    }

    return Response.json({
      error: "Voicebox создаёт этот фрагмент слишком долго. Готовые части уже сохранены — нажми «Продолжить озвучку» после перезапуска Voicebox.",
    }, { status: 504 });
  } catch (error) {
    const message = error instanceof Error && error.name === "TimeoutError"
      ? "Voicebox не ответил вовремя. Перезапусти приложение и нажми «Продолжить озвучку»."
      : error instanceof Error ? error.message : "Ошибка локального Voicebox";
    return Response.json({ error: message }, { status: 500 });
  }
}
