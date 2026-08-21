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

const VISUAL_ROLES = [
  "OPENING HOOK: one person standing, walking or paused mid-action in a visually tense location; never a seated portrait",
  "ACTION DETAIL: close view of hands changing, opening, choosing, holding or building something important; no full seated person",
  "ENVIRONMENT: wide architecture, street, transport, landscape or interior where the location carries the idea; no dominant person",
  "INTERACTION: two or more distinct people talking, negotiating, helping, confronting or moving together; nobody posing for camera",
  "FULL-BODY ACTION: one person standing or moving while performing a clear physical action; no chair, sofa, bed or passive desk pose",
  "PHYSICAL METAPHOR: a concrete still life such as a chain, scale, calendar, ticket, doorway, tool or other narration-relevant object; no people",
  "WORK IN PROGRESS: active use of plans, documents, tools, technology or machinery; the action must be visible and purposeful",
  "EXTERIOR SCALE: city, nature, industrial structure or transport with a tiny person only if scale improves the meaning",
  "OVER-THE-SHOULDER ACTION: a person actively changing or deciding something in the world, not merely staring or thinking",
  "SOCIAL CONTRAST: several people at different depths whose roles and body language communicate the current idea",
  "OBJECT CLOSE-UP: one powerful narration-relevant object or trace of action, composed like a cinematic insert; no people",
  "ATMOSPHERIC LOCATION: an empty but meaningful place with weather, light and physical evidence of what happened; no people",
];

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
    const visualRole = VISUAL_ROLES[(sceneId - 1) % VISUAL_ROLES.length];
    const styleMarker = body.prompt.toLocaleLowerCase("ru").indexOf("cinematic oil-painting style");
    const sceneContent = styleMarker >= 0 ? body.prompt.slice(0, styleMarker) : body.prompt;
    const explicitlySeated = /(?:^|[^а-яёa-z])(сидит|сидящ|сидя|кресл|диван|стул|кроват|постел|sitting|seated|chair|armchair|sofa|bed)(?:[а-яёa-z]*)/iu.test(sceneContent);
    const seatedRule = explicitlySeated
      ? "The narration explicitly requests a seated setting, so it is allowed only for this frame; still avoid copying the reference pose or room."
      : "STRICT: no seated person, chair, armchair, sofa, bed, passive desk portrait or man staring through a window in this frame.";
    const allowRareMotif = sceneId % 8 === 4;
    const motifDirection = allowRareMotif
      ? "A single small symbolic motif from the references may appear naturally in the distant background: choose either one raven OR one classical bust, never both, and never make it the focal point."
      : "Do not include ravens, crows, birds, statues, marble busts or crystal balls in this frame.";
    const styleLockedPrompt = referenceImages.length
      ? `SCENE CONTENT — HIGHEST PRIORITY:\n${body.prompt}\n\nASSIGNED VISUAL ROLE FOR FRAME ${sceneId} OF ${Math.max(sceneId, Math.round(body.sceneCount || sceneId))}: ${visualRole}. Follow this role unless it directly contradicts a literal event in the narration. ${seatedRule}\n\nSEQUENCE DIVERSITY — STRICT: This video must feel like a changing visual story, not a slideshow of one contemplative man. Alternate people in action, useful objects, hands, groups, architecture, exteriors, landscapes, physical metaphors and person-free locations. Palette and painting technique provide continuity; do not preserve the same character, room, posture or camera setup by default. Never repeat the same main subject or location in neighboring frames. Do not turn an abstract sentence into another passive male portrait.\n\nCONTENT RULES: Show the exact action, location, objects and symbolism requested in the scene. Do not replace them with an unrelated portrait or copy a reference composition. ${motifDirection} Other reference objects may appear only when naturally useful to the requested scene and must never repeat as the central object.\n\nSTRICT USER REFERENCE STYLE LOCK: The FIRST attached image is the decisive target for painting technique, brush texture, color relationships, lighting, softness and emotional tone. Reference images are STYLE ONLY: never copy their people, pose, furniture, house, window or composition. Transfer only the visual language to the requested content. The result must be unmistakably hand-painted: dense broad visible oil brushstrokes, soft impasto-like texture across people and environment, gently simplified anatomy and facial detail, softened contours, low microcontrast, smoky atmospheric depth and restrained analog grain. Use deep teal and petrol-blue shadows with clearly readable midtones, controlled crimson-red atmospheric light, and small warm amber accents. Keep the image dark and psychologically charged but never underexposed or crushed into black. Avoid photographic sharpness, polished AI realism, glossy CGI, hyperreal skin, clean vector edges, smooth 3D surfaces, cyberpunk neon overload and fussy background detail. It should resemble a richly brushed cinematic painting, not a photograph passed through a filter. Never reproduce reference text, subtitles, logos, the words Psychology of Mind / Психология разума, or any watermark.`
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
