const FAL_QUEUE = "https://queue.fal.run";
const CLONE_ENDPOINT = "fal-ai/qwen-3-tts/clone-voice/1.7b";
const SPEAK_ENDPOINT = "fal-ai/qwen-3-tts/text-to-speech/1.7b";

type QueueTicket = {
  request_id?: string;
  status_url?: string;
  response_url?: string;
};

function falHeaders(apiKey: string, json = false) {
  const headers = new Headers({ authorization: `Key ${apiKey}` });
  if (json) headers.set("content-type", "application/json");
  return headers;
}

async function falError(response: Response) {
  const raw = await response.text().catch(() => "");
  try {
    const value = JSON.parse(raw) as { detail?: string; message?: string; error?: string };
    return value.detail || value.message || value.error || `Fal.ai: ${response.status}`;
  } catch {
    return raw || `Fal.ai: ${response.status}`;
  }
}

async function subscribe(endpoint: string, apiKey: string, input: Record<string, unknown>) {
  const submitted = await fetch(`${FAL_QUEUE}/${endpoint}`, {
    method: "POST",
    headers: falHeaders(apiKey, true),
    body: JSON.stringify(input),
  });
  if (!submitted.ok) throw new Error(await falError(submitted));
  const ticket = await submitted.json() as QueueTicket;
  if (!ticket.status_url || !ticket.response_url) throw new Error("Fal.ai не вернул адрес очереди");

  for (let check = 0; check < 240; check++) {
    const statusResponse = await fetch(ticket.status_url, { headers: falHeaders(apiKey) });
    if (!statusResponse.ok) throw new Error(await falError(statusResponse));
    const status = await statusResponse.json() as { status?: string; error?: string };
    if (status.status === "COMPLETED") {
      const resultResponse = await fetch(ticket.response_url, { headers: falHeaders(apiKey) });
      if (!resultResponse.ok) throw new Error(await falError(resultResponse));
      return resultResponse.json() as Promise<Record<string, unknown>>;
    }
    if (status.status === "FAILED" || status.status === "CANCELLED") throw new Error(status.error || `Fal.ai: ${status.status}`);
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  throw new Error("Fal.ai слишком долго создаёт голос. Готовые части сохранены — нажми «Продолжить озвучку».");
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as {
      action?: "clone" | "speak";
      apiKey?: string;
      audioDataUrl?: string;
      referenceText?: string;
      embeddingUrl?: string;
      text?: string;
    };
    const apiKey = body.apiKey?.trim() || "";
    if (!apiKey) return Response.json({ error: "Нужен Fal.ai API key" }, { status: 400 });

    if (body.action === "clone") {
      if (!body.audioDataUrl?.startsWith("data:audio/")) return Response.json({ error: "Не найден WAV-образец голоса" }, { status: 400 });
      const result = await subscribe(CLONE_ENDPOINT, apiKey, {
        audio_url: body.audioDataUrl,
        reference_text: body.referenceText || "",
      });
      const embedding = result.speaker_embedding as { url?: string } | undefined;
      if (!embedding?.url) throw new Error("Fal.ai не вернул отпечаток голоса");
      return Response.json({ embeddingUrl: embedding.url });
    }

    if (body.action === "speak") {
      if (!body.embeddingUrl || !body.text?.trim()) return Response.json({ error: "Не хватает отпечатка голоса или текста" }, { status: 400 });
      const result = await subscribe(SPEAK_ENDPOINT, apiKey, {
        text: body.text.trim(),
        language: "Russian",
        speaker_voice_embedding_file_url: body.embeddingUrl,
        reference_text: body.referenceText || "",
        temperature: 0.75,
        top_k: 40,
        top_p: 0.9,
        repetition_penalty: 1.08,
        subtalker_temperature: 0.75,
        subtalker_top_k: 40,
        subtalker_top_p: 0.9,
        max_new_tokens: 2048,
      });
      const audio = result.audio as { url?: string; content_type?: string } | undefined;
      if (!audio?.url) throw new Error("Fal.ai не вернул аудиофайл");
      const audioResponse = await fetch(audio.url);
      if (!audioResponse.ok || !audioResponse.body) throw new Error("Fal.ai создал, но не отдал аудиофайл");
      return new Response(audioResponse.body, {
        headers: {
          "content-type": audio.content_type || audioResponse.headers.get("content-type") || "audio/mpeg",
          "cache-control": "no-store",
        },
      });
    }

    return Response.json({ error: "Неизвестная операция Fal.ai" }, { status: 400 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Ошибка облачного Qwen" }, { status: 502 });
  }
}
