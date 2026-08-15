function findImage(value: unknown): { data: string; mime: string } | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  const data = typeof item.data === "string" ? item.data : null;
  const mime = typeof item.mime_type === "string" ? item.mime_type : typeof item.mimeType === "string" ? item.mimeType : "";
  if (data && mime.startsWith("image/")) return { data, mime };
  for (const child of Object.values(item)) {
    if (Array.isArray(child)) {
      for (const nested of child) { const found = findImage(nested); if (found) return found; }
    } else {
      const found = findImage(child); if (found) return found;
    }
  }
  return null;
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as { apiKey?: string; prompt?: string; quality?: string; aspectRatio?: string };
    if (!body.apiKey?.trim()) return Response.json({ error: "Нужен Google API key" }, { status: 400 });
    if (!body.prompt?.trim()) return Response.json({ error: "Промпт пуст" }, { status: 400 });
    const response = await fetch("https://generativelanguage.googleapis.com/v1beta/interactions", {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": body.apiKey.trim() },
      body: JSON.stringify({
        model: "gemini-3.1-flash-image",
        input: body.prompt,
        response_format: { type: "image", mime_type: "image/jpeg", aspect_ratio: body.aspectRatio === "9:16" ? "9:16" : "16:9", image_size: ["1K", "2K", "4K"].includes(body.quality || "") ? body.quality : "1K" },
      }),
    });
    const result = await response.json() as unknown;
    if (!response.ok) {
      const error = result as { error?: { message?: string } };
      return Response.json({ error: error.error?.message || `Google API: ${response.status}` }, { status: response.status });
    }
    const image = findImage(result);
    if (!image) return Response.json({ error: "Nano Banana не вернула изображение" }, { status: 502 });
    return Response.json({ image: `data:${image.mime};base64,${image.data}` });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Ошибка Nano Banana" }, { status: 500 });
  }
}
