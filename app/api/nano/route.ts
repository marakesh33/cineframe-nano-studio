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
    const body = await request.json() as {
      apiKey?: string;
      prompt?: string;
      quality?: string;
      aspectRatio?: string;
      sceneId?: number;
      sceneCount?: number;
      referenceImages?: Array<{ data?: string; mime_type?: string }>;
    };
    if (!body.apiKey?.trim()) return Response.json({ error: "Нужен Google API key" }, { status: 400 });
    if (!body.prompt?.trim()) return Response.json({ error: "Промпт пуст" }, { status: 400 });
    const referenceImages = (body.referenceImages || [])
      .slice(0, 3)
      .filter((image) => typeof image.data === "string" && image.data.length > 0 && ["image/jpeg", "image/png", "image/webp"].includes(image.mime_type || ""))
      .map((image) => ({ type: "image", data: image.data!, mime_type: image.mime_type! }));
    const sceneId = Math.max(1, Math.round(body.sceneId || 1));
    const cameraDirection = sceneId <= 2
      ? "a calm wide or medium establishing composition"
      : sceneId <= 5
        ? "a natural medium three-quarter composition, occasionally moving closer when emotion requires it"
        : "a slightly wider cinematic composition that preserves continuity and gradually opens the environment";
    const allowRareMotif = sceneId % 8 === 4;
    const motifDirection = allowRareMotif
      ? "A single small symbolic motif from the references may appear naturally in the distant background: choose either one raven OR one classical bust, never both, and never make it the focal point."
      : "Do not include ravens, crows, birds, statues, marble busts or crystal balls in this frame.";
    const styleLockedPrompt = referenceImages.length
      ? `SCENE CONTENT — HIGHEST PRIORITY:\n${body.prompt}\n\nCAMERA GUIDANCE FOR FRAME ${sceneId}: use ${cameraDirection}. Keep neighboring frames visually connected. Change camera distance or angle only when it helps the story, while avoiding the exact same centered framing throughout the whole sequence.\n\nCONTENT RULES: Show the exact people, action, location, objects and symbolism requested in the scene. Do not replace it with an unrelated portrait or copy a reference composition. ${motifDirection} Other reference objects may appear only when naturally useful to the requested scene and must never repeat as the central object. Keep locations and character positions coherent across connected scenes.\n\nSTRICT USER REFERENCE STYLE LOCK: The FIRST attached image is the decisive target for painting technique, brush texture, color relationships, lighting, softness and emotional tone. Do not copy its man, bed, window or room unless the scene requests them; transfer its visual language to the requested content. The result must be unmistakably hand-painted: dense broad visible oil brushstrokes, soft impasto-like texture across people and environment, gently simplified anatomy and facial detail, softened contours, low microcontrast, smoky atmospheric depth and restrained analog grain. Use deep teal and petrol-blue shadows with clearly readable midtones, controlled crimson-red rain reflections or distant glow, and small warm amber practical-light accents. Keep the image dark, contemplative and psychologically intimate but never underexposed or crushed into black. Favor natural side views, back-three-quarter figures and thoughtful body language when appropriate. Avoid photographic sharpness, polished AI realism, glossy CGI, hyperreal skin, clean vector edges, smooth 3D surfaces, cyberpunk neon overload and fussy background detail. It should resemble a richly brushed cinematic painting, not a photograph passed through a filter. Never reproduce reference text, subtitles, logos, the words Psychology of Mind / Психология разума, or any watermark.`
      : body.prompt;
    const input = referenceImages.length
      ? [...referenceImages, { type: "text", text: styleLockedPrompt }]
      : body.prompt;
    const response = await fetch("https://generativelanguage.googleapis.com/v1beta/interactions", {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": body.apiKey.trim() },
      body: JSON.stringify({
        model: "gemini-3.1-flash-image",
        input,
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
