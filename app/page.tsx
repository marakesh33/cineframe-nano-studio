"use client";

import { ChangeEvent, useEffect, useMemo, useRef, useState } from "react";
import { AudioBufferSource, BufferTarget, CanvasSource, Mp4OutputFormat, Output, Quality } from "mediabunny";
import { addProjectToCapCut } from "./capcut-export";

type Scene = {
  id: number;
  start: number;
  end: number;
  text: string;
  prompt: string;
  image?: string;
  status: "ready" | "working" | "done" | "error";
  error?: string;
};

type PipelineStage = "idle" | "voice" | "frames" | "render" | "done" | "error";

const DEFAULT_STYLE = `cinematic oil-painting style, dramatic chiaroscuro lighting, rich red and teal color grading, deep contrast between warm crimson highlights and cool cyan shadows, painterly visible brushstrokes, atmospheric haze and film grain, moody and emotionally charged atmosphere, hyper-detailed realism blended with expressive painting texture, cinematic 16:9 widescreen composition, dramatic single-light-source lighting, no text, no watermark`;

const STYLE_REFERENCE_PATHS = [
  "/style-references/psychology-style-01-clean.jpg",
  "/style-references/psychology-style-02-clean.jpg",
];

const VOICES = [
  { id: "Gacrux", label: "Gacrux · глубокий взрослый" },
  { id: "Charon", label: "Charon · спокойный рассказчик" },
  { id: "Schedar", label: "Schedar · ровный документальный" },
  { id: "Fenrir", label: "Fenrir · уверенный и живой" },
];

const DEFAULT_VOICE_DIRECTION = `Native Russian male narrator, 40–55 years old. Deep, warm, mature baritone; calm authority, intelligent and emotionally restrained. Natural conversational Russian, clear diction, medium pace, meaningful pauses after important ideas. Avoid a high pitch, advertising enthusiasm, theatrical acting, whispering, singing and robotic rhythm. Read the supplied script verbatim without adding or removing words.`;
const VOICE_PREVIEW_TEXT = "Иногда одна мысль меняет всё. Но самое важное мы замечаем только тогда, когда перестаём спешить.";

type StyleReference = { data: string; mime_type: string };
let styleReferencePromise: Promise<StyleReference[]> | null = null;

function bytesToBase64(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(binary);
}

function loadStyleReferences() {
  if (!styleReferencePromise) {
    styleReferencePromise = Promise.all(STYLE_REFERENCE_PATHS.map(async (path) => {
      const response = await fetch(path);
      if (!response.ok) throw new Error(`Не загрузился референс стиля: ${path}`);
      return {
        data: bytesToBase64(await response.arrayBuffer()),
        mime_type: response.headers.get("content-type") || "image/jpeg",
      };
    }));
  }
  return styleReferencePromise;
}

type AudioPart = { data: string; mime: string };

function collectAudioParts(value: unknown, parts: AudioPart[] = []): AudioPart[] {
  if (!value || typeof value !== "object") return parts;
  const item = value as Record<string, unknown>;
  const data = typeof item.data === "string" ? item.data : null;
  const mime = typeof item.mime_type === "string" ? item.mime_type : typeof item.mimeType === "string" ? item.mimeType : "";
  if (data && (mime.startsWith("audio/") || item.type === "audio")) {
    parts.push({ data, mime: mime || "audio/L16;codec=pcm;rate=24000" });
    return parts;
  }
  for (const child of Object.values(item)) {
    if (Array.isArray(child)) child.forEach((nested) => collectAudioParts(nested, parts));
    else collectAudioParts(child, parts);
  }
  return parts;
}

function base64Bytes(value: string) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function makeWav(chunks: Uint8Array[], sampleRate: number) {
  const pcmLength = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const wav = new Uint8Array(44 + pcmLength);
  const view = new DataView(wav.buffer);
  const write = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index++) wav[offset + index] = value.charCodeAt(index);
  };
  write(0, "RIFF"); view.setUint32(4, 36 + pcmLength, true); write(8, "WAVE"); write(12, "fmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); write(36, "data"); view.setUint32(40, pcmLength, true);
  let offset = 44;
  for (const chunk of chunks) { wav.set(chunk, offset); offset += chunk.byteLength; }
  return wav;
}

async function readVoiceResponse(response: Response) {
  const contentType = response.headers.get("content-type") || "";
  if (contentType.startsWith("audio/")) return response.blob();
  const raw = await response.text();
  const payloads: unknown[] = [];
  if (contentType.includes("event-stream") || raw.includes("data:")) {
    for (const line of raw.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      try { payloads.push(JSON.parse(data)); } catch { /* Ignore stream keepalives. */ }
    }
  } else {
    try { payloads.push(JSON.parse(raw)); } catch { throw new Error("Gemini вернула повреждённый аудиопоток"); }
  }
  const parts = payloads.flatMap((payload) => collectAudioParts(payload));
  if (!parts.length) throw new Error("Gemini не вернула аудиодорожку");
  const rateMatch = parts[0].mime.match(/rate[=:-](\d+)/i);
  const sampleRate = rateMatch ? Number(rateMatch[1]) : 24000;
  const mime = parts[0].mime.toLowerCase();
  if (!mime.includes("pcm") && !mime.includes("l16")) {
    return new Blob(parts.map((part) => base64Bytes(part.data)), { type: parts[0].mime || "audio/wav" });
  }
  return new Blob([makeWav(parts.map((part) => base64Bytes(part.data)), sampleRate)], { type: "audio/wav" });
}

function clock(seconds: number) {
  const value = Math.max(0, Math.round(seconds));
  return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
}

function frameCountForDuration(seconds: number) {
  return Math.max(1, Math.ceil(seconds / 7));
}

function extractOpeningQuote(text: string) {
  const paragraphs = text.trim().split(/\n+/).map((part) => part.trim()).filter(Boolean);
  if (!paragraphs[0]?.startsWith("«") || !paragraphs[0].includes("»") || !/Макиавелли/i.test(paragraphs[1] || "")) return null;
  return { quote: paragraphs[0], author: paragraphs[1], rest: paragraphs.slice(2).join("\n\n") };
}

function voiceTextForScript(text: string) {
  const opening = extractOpeningQuote(text);
  return opening ? `${opening.quote}\n\n${opening.rest}` : text;
}

function splitVoiceText(text: string, maxChars = 350) {
  const paragraphs = text.trim().split(/\n+/).map((part) => part.trim()).filter(Boolean);
  const chunks: string[] = [];
  let current = "";
  for (const paragraph of paragraphs) {
    if ((current + "\n\n" + paragraph).length <= maxChars) {
      current = current ? `${current}\n\n${paragraph}` : paragraph;
      continue;
    }
    if (current) chunks.push(current);
    if (paragraph.length <= maxChars) {
      current = paragraph;
      continue;
    }
    const sentences = paragraph.match(/[^.!?…]+[.!?…]+|[^.!?…]+$/g) || [paragraph];
    current = "";
    for (const sentence of sentences) {
      if ((current + sentence).length > maxChars && current) { chunks.push(current.trim()); current = ""; }
      current += sentence;
    }
  }
  if (current) chunks.push(current.trim());
  return chunks.length ? chunks : [text.trim()];
}

function shotDescription(direction: string, index: number, fragment: string) {
  const numbered = direction.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  let containsNumberedScenes = false;
  for (const line of numbered) {
    const match = line.match(/^(?:(?:shot|frame|кадр|сцена)\s*)?(\d+)\s*[.):—-]\s*(.+)$/i);
    if (match) containsNumberedScenes = true;
    if (match && Number(match[1]) === index + 1) return match[2].replace(/[. ]+$/, "");
  }
  if (direction.trim() && !containsNumberedScenes) return `A concrete cinematic scene illustrating the idea "${fragment}", following this story direction: ${direction.trim()}`;
  const naturalShot = index % 6 === 0 ? "a calm wide establishing composition" : index % 6 === 3 ? "a closer emotional composition" : "a natural medium cinematic composition";
  return `Create one concrete narrative illustration that directly visualizes this exact voiceover fragment: "${fragment}". First identify the central human subject, then show a clear physical action, a believable location and only the objects needed to communicate the meaning. Use ${naturalShot} while maintaining continuity with neighboring scenes. Prefer literal cause-and-effect storytelling over vague symbols. Do not invent an unrelated office portrait, random philosopher, decorative statue, raven or abstract object unless the quoted narration genuinely requires it`;
}

function cleanSceneDescription(value: string) {
  const marker = value.toLowerCase().indexOf("cinematic oil-painting style");
  const subject = marker >= 0 ? value.slice(0, marker) : value;
  return subject.trim().replace(/[,. ]+$/, "");
}

function splitIntoScenes(text: string, count: number, duration: number, style: string, direction: string, aspect: string) {
  const opening = extractOpeningQuote(text);
  const words = (opening?.rest || text).trim().split(/\s+/).filter(Boolean);
  const actualCount = Math.max(1, count);
  return Array.from({ length: actualCount }, (_, index): Scene => {
    const narrativeIndex = opening ? index - 1 : index;
    const narrativeCount = opening ? Math.max(1, actualCount - 1) : actualCount;
    const from = Math.floor((Math.max(0, narrativeIndex) * words.length) / narrativeCount);
    const to = Math.floor(((Math.max(0, narrativeIndex) + 1) * words.length) / narrativeCount);
    const fragment = opening && index === 0
      ? `${opening.quote}\n${opening.author}`
      : words.slice(from, to).join(" ") || words[Math.max(0, narrativeIndex) % Math.max(1, words.length)] || direction || "Визуальная сцена";
    const start = index * 7;
    const end = Math.min(duration, start + 7);
    return {
      id: index + 1,
      start,
      end,
      text: fragment,
      prompt: `${cleanSceneDescription(shotDescription(direction, index, fragment))}, ${style.replace("cinematic 16:9 widescreen composition", aspect === "9:16" ? "cinematic 9:16 vertical composition" : "cinematic 16:9 widescreen composition")}`,
      status: "ready",
    };
  });
}

export default function Home() {
  const [script, setScript] = useState("");
  const [direction, setDirection] = useState("");
  const [style, setStyle] = useState(DEFAULT_STYLE);
  const [audioName, setAudioName] = useState("");
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [audioUrl, setAudioUrl] = useState("");
  const [audioDuration, setAudioDuration] = useState(0);
  const [targetDuration, setTargetDuration] = useState(60);
  const frameCount = frameCountForDuration(targetDuration);
  const [quality, setQuality] = useState("1K");
  const [aspect, setAspect] = useState("16:9");
  const [scenes, setScenes] = useState<Scene[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [keys, setKeys] = useState("");
  const [showKeys, setShowKeys] = useState(false);
  const [message, setMessage] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [isGeneratingVoice, setIsGeneratingVoice] = useState(false);
  const [isGeneratingVoicePreview, setIsGeneratingVoicePreview] = useState(false);
  const [voice, setVoice] = useState("Gacrux");
  const [voiceDirection, setVoiceDirection] = useState(DEFAULT_VOICE_DIRECTION);
  const [voicePreviewUrl, setVoicePreviewUrl] = useState("");
  const [voiceError, setVoiceError] = useState("");
  const [pipelineStage, setPipelineStage] = useState<PipelineStage>("idle");
  const [pipelineProgress, setPipelineProgress] = useState(0);
  const [pipelineLabel, setPipelineLabel] = useState("Готов к запуску");
  const [videoUrl, setVideoUrl] = useState("");
  const [videoBlob, setVideoBlob] = useState<Blob | null>(null);
  const [isRendering, setIsRendering] = useState(false);
  const [renderProgress, setRenderProgress] = useState(0);
  const [isExportingCapCut, setIsExportingCapCut] = useState(false);
  const [capCutMessage, setCapCutMessage] = useState("");
  const audioRef = useRef<HTMLAudioElement>(null);
  const voicePreviewRef = useRef<HTMLAudioElement>(null);
  const keyCursorRef = useRef(0);
  const voiceChunkCacheRef = useRef(new Map<string, File>());
  const [playhead, setPlayhead] = useState(0);

  useEffect(() => {
    setKeys(localStorage.getItem("cineframe_google_keys") || "");
    const savedCursor = Number(localStorage.getItem("cineframe_google_key_cursor") || "0");
    keyCursorRef.current = Number.isFinite(savedCursor) && savedCursor >= 0 ? savedCursor : 0;
  }, []);

  const wordCount = useMemo(() => script.trim().split(/\s+/).filter(Boolean).length, [script]);
  const estimatedDuration = Math.max(1, targetDuration);
  const expectedScenes = frameCount;
  const selected = scenes.find((scene) => scene.id === selectedId) || null;
  const currentScene = scenes.find((scene) => playhead >= scene.start && playhead < scene.end) || selected || scenes[0];
  const done = scenes.filter((scene) => scene.status === "done").length;

  function attachAudio(file: File) {
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    const url = URL.createObjectURL(file);
    const probe = new Audio(url);
    probe.onloadedmetadata = () => {
      setAudioDuration(probe.duration || 0);
      setMessage(`Озвучка готова: ${clock(probe.duration || 0)}. Большая кнопка соберёт её с ${frameCount} кадрами в один MP4.`);
    };
    probe.onerror = () => setMessage("Голос создан, но браузер не смог прочитать аудиофайл.");
    setAudioName(file.name);
    setAudioFile(file);
    setAudioUrl(url);
    setScenes([]);
  }

  function handleAudio(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (file) attachAudio(file);
  }

  function measureAudio(file: File) {
    return new Promise<number>((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const audio = new Audio(url);
      audio.onloadedmetadata = () => { const duration = audio.duration || 0; URL.revokeObjectURL(url); resolve(duration); };
      audio.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Браузер не смог прочитать созданную озвучку")); };
    });
  }

  function keyList() {
    return [...new Set(keys.split(/[\n,;]+/).map((item) => item.trim()).filter(Boolean))];
  }

  function takeNextKey(list: string[]) {
    const index = keyCursorRef.current % list.length;
    const key = list[index];
    keyCursorRef.current = (index + 1) % list.length;
    localStorage.setItem("cineframe_google_key_cursor", String(keyCursorRef.current));
    return key;
  }

  function buildPlan() {
    if (!script.trim()) {
      setMessage("Снача вставь свой сценарий.");
      return;
    }
    const next = splitIntoScenes(script, expectedScenes, estimatedDuration, style, direction, aspect);
    setScenes(next);
    setSelectedId(next[0]?.id || null);
    setMessage(`Готово: ${next.length} кадров на ${clock(estimatedDuration)}. Можно проверить промпты и запускать Nano Banana.`);
  }

  function saveKeys() {
    const clean = keyList();
    const value = clean.join("\n");
    setKeys(value);
    localStorage.setItem("cineframe_google_keys", value);
    keyCursorRef.current = 0;
    localStorage.setItem("cineframe_google_key_cursor", "0");
    setShowKeys(false);
    setMessage(`Сохранено ключей: ${clean.length}. Кадры и озвучка будут брать их по кругу.`);
  }

  function importKeys(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const text = typeof reader.result === "string" ? reader.result : "";
      const found = [...new Set(text.match(/AIza[0-9A-Za-z_-]{20,}/g) || [])];
      if (!found.length) {
        setMessage("В CSV не нашлось ключей Google AI.");
        return;
      }
      const value = found.join("\n");
      setKeys(value);
      localStorage.setItem("cineframe_google_keys", value);
      keyCursorRef.current = 0;
      localStorage.setItem("cineframe_google_key_cursor", "0");
      setShowKeys(false);
      setMessage(`Импортировано ${found.length} уникальных ключей. Ротация начинается с первого.`);
    };
    reader.readAsText(file);
    event.target.value = "";
  }

  function importTextFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const content = typeof reader.result === "string" ? reader.result.trim() : "";
      if (!content) {
        setMessage("Выбранный файл пуст.");
        return;
      }

      const voiceMarker = "=== ТЕКСТ ДЛЯ ОЗВУЧКИ ===";
      const scenesMarker = "=== ПРОМПТЫ СЦЕН И ВИДЕО ===";
      const scenesMarkerIndex = content.indexOf(scenesMarker);
      if (scenesMarkerIndex >= 0) {
        const voicePart = content.slice(0, scenesMarkerIndex).replace(voiceMarker, "").trim();
        const scenesPart = content.slice(scenesMarkerIndex + scenesMarker.length).trim();
        setScript(voicePart);
        setDirection(scenesPart);
        const promptCount = scenesPart.split(/\r?\n/).filter((line) => /^\s*\d+\s*[.):—-]/.test(line)).length;
        if (promptCount >= 250) setTargetDuration(1800);
        setScenes([]);
        setMessage(`Загружен полный проект «${file.name}»: текст озвучки и ${promptCount} промптов сцен.`);
        return;
      }

      const promptCount = content.split(/\r?\n/).filter((line) => /^\s*\d+\s*[.):—-]/.test(line)).length;
      if (promptCount >= 3) {
        setDirection(content);
        if (promptCount >= 250) setTargetDuration(1800);
        setScenes([]);
        setMessage(`Загружен файл «${file.name}»: найдено ${promptCount} промптов сцен.`);
      } else {
        setScript(content);
        setScenes([]);
        setMessage(`Загружен текст озвучки «${file.name}».`);
      }
    };
    reader.onerror = () => setMessage("Не удалось прочитать выбранный файл.");
    reader.readAsText(file);
    event.target.value = "";
  }

  async function requestVoiceTrack(list: string[], text: string, desiredSeconds = 0, previousSeconds = 0) {
    let lastError = "Озвучка не создалась";
    const attempts = Math.min(5, list.length);
    for (let attempt = 0; attempt < attempts; attempt++) {
      let response: Response;
      try {
        response = await fetch("/api/tts", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ apiKey: takeNextKey(list), text, voice, direction: voiceDirection, desiredSeconds, previousSeconds }),
        });
      } catch {
        lastError = "Сетевое соединение прервалось. Автоматически пробую следующий ключ…";
        continue;
      }
      if (response.ok) {
        try {
          const blob = await readVoiceResponse(response);
          if (!blob.size) throw new Error("Gemini вернула пустую аудиодорожку");
          return new File([blob], `gemini-${voice.toLowerCase()}.wav`, { type: blob.type || "audio/wav" });
        } catch (error) {
          lastError = error instanceof Error ? error.message : "Gemini не вернула аудиодорожку";
          continue;
        }
      }
      const result = await response.json().catch(() => ({})) as { error?: string };
      lastError = result.error || `Google API: ${response.status}`;
      if (/current location|not available in your region/i.test(lastError)) break;
    }
    throw new Error(lastError);
  }

  async function combineVoiceFiles(files: File[]) {
    if (files.length === 1) return files[0];
    const audioContext = new AudioContext({ sampleRate: 24000 });
    try {
      const buffers = await Promise.all(files.map((file) => file.arrayBuffer().then((data) => audioContext.decodeAudioData(data))));
      const sampleRate = buffers[0]?.sampleRate || 24000;
      const totalSamples = buffers.reduce((total, buffer) => total + buffer.length, 0);
      const pcm = new Uint8Array(totalSamples * 2);
      const view = new DataView(pcm.buffer);
      let offset = 0;
      for (const buffer of buffers) {
        for (let sample = 0; sample < buffer.length; sample++) {
          let value = 0;
          for (let channel = 0; channel < buffer.numberOfChannels; channel++) value += buffer.getChannelData(channel)[sample] || 0;
          value = Math.max(-1, Math.min(1, value / Math.max(1, buffer.numberOfChannels)));
          view.setInt16(offset, value < 0 ? value * 0x8000 : value * 0x7fff, true);
          offset += 2;
        }
      }
      return new File([makeWav([pcm], sampleRate)], `gemini-${voice.toLowerCase()}-full.wav`, { type: "audio/wav" });
    } finally {
      await audioContext.close();
    }
  }

  async function padVoicePart(file: File, minimumSeconds: number) {
    const audioContext = new AudioContext({ sampleRate: 24000 });
    try {
      const buffer = await audioContext.decodeAudioData(await file.arrayBuffer());
      if (buffer.duration >= minimumSeconds) return file;
      const sampleRate = buffer.sampleRate || 24000;
      const exactSamples = Math.max(buffer.length, Math.round(minimumSeconds * sampleRate));
      const pcm = new Uint8Array(exactSamples * 2);
      const view = new DataView(pcm.buffer);
      for (let sample = 0; sample < buffer.length; sample++) {
        let value = 0;
        for (let channel = 0; channel < buffer.numberOfChannels; channel++) value += buffer.getChannelData(channel)[sample] || 0;
        value = Math.max(-1, Math.min(1, value / Math.max(1, buffer.numberOfChannels)));
        view.setInt16(sample * 2, value < 0 ? value * 0x8000 : value * 0x7fff, true);
      }
      return new File([makeWav([pcm], sampleRate)], file.name, { type: "audio/wav" });
    } finally {
      await audioContext.close();
    }
  }

  async function requestLongVoiceTrack(list: string[], text: string, desiredSeconds: number, onProgress?: (completed: number, total: number) => void) {
    const chunks = splitVoiceText(text);
    const totalWords = chunks.reduce((total, chunk) => total + chunk.split(/\s+/).filter(Boolean).length, 0);
    const files: File[] = [];
    for (let index = 0; index < chunks.length; index++) {
      const chunkWords = chunks[index].split(/\s+/).filter(Boolean).length;
      const chunkSeconds = Math.max(8, desiredSeconds * (chunkWords / Math.max(1, totalWords)));
      const cacheKey = `${voice}:${Math.round(desiredSeconds)}:${index}:${chunks[index]}`;
      const cached = voiceChunkCacheRef.current.get(cacheKey);
      if (cached) {
        files.push(cached);
        onProgress?.(index + 1, chunks.length);
        continue;
      }
      const requestedSeconds = chunkSeconds * 0.95;
      let part = await requestVoiceTrack(list, chunks[index], requestedSeconds);
      let partDuration = await measureAudio(part);
      if (partDuration < chunkSeconds * 0.55) {
        part = await requestVoiceTrack(list, chunks[index], requestedSeconds, partDuration);
        partDuration = await measureAudio(part);
      }
      if (partDuration < chunkSeconds * 0.45) throw new Error(`Gemini не дочитала часть ${index + 1}. Нажми «Продолжить озвучку» — готовые части сохранятся.`);
      part = await padVoicePart(part, chunkSeconds);
      voiceChunkCacheRef.current.set(cacheKey, part);
      files.push(part);
      onProgress?.(index + 1, chunks.length);
    }
    const combined = await combineVoiceFiles(files);
    const combinedDuration = await measureAudio(combined);
    if (combinedDuration < desiredSeconds * 0.96) throw new Error(`Озвучка получилась только ${clock(combinedDuration)} вместо ${clock(desiredSeconds)}. MP4 не будет собран с тишиной — повтори озвучку.`);
    return combined;
  }

  async function generateVoice() {
    const list = keyList();
    if (!list.length) { setShowKeys(true); return; }
    if (!script.trim()) { setMessage("Снача вставь сценарий — именно его сайт озвучит."); return; }
    setIsGeneratingVoice(true);
    setVoiceError("");
    const voicePartCount = splitVoiceText(voiceTextForScript(script)).length;
    setMessage(`Gemini создаёт озвучку частями: 0 из ${voicePartCount}. Не закрывай страницу.`);
    try {
      attachAudio(await requestLongVoiceTrack(list, voiceTextForScript(script), targetDuration, (completed, total) => setMessage(`Создаю озвучку: часть ${completed} из ${total}…`)));
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Озвучка не создалась";
      setVoiceError(reason);
      setMessage(`Озвучка не создалась: ${reason}`);
    } finally {
      setIsGeneratingVoice(false);
    }
  }

  async function previewVoice() {
    const list = keyList();
    if (!list.length) { setShowKeys(true); return; }
    setIsGeneratingVoicePreview(true);
    setVoiceError("");
    setMessage("Создаю короткий пример выбранного голоса…");
    try {
      const file = await requestVoiceTrack(list, VOICE_PREVIEW_TEXT, 8);
      const blob = file.slice();
      if (voicePreviewUrl) URL.revokeObjectURL(voicePreviewUrl);
      const url = URL.createObjectURL(blob);
      setVoicePreviewUrl(url);
      setMessage("Пример готов. Если воспроизведение не началось само, нажми ▶ в плеере.");
      setTimeout(() => voicePreviewRef.current?.play().catch(() => undefined), 0);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Пример голоса не создался";
      setVoiceError(reason);
      setMessage(`Пример не создался: ${reason}`);
    } finally {
      setIsGeneratingVoicePreview(false);
    }
  }

  async function generateScene(scene: Scene, list: string[]): Promise<Scene> {
    setScenes((items) => items.map((item) => item.id === scene.id ? { ...item, status: "working", error: undefined } : item));
    try {
      const referenceImages = await loadStyleReferences();
      const response = await fetch("/api/nano", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ apiKey: takeNextKey(list), prompt: scene.prompt, quality, aspectRatio: aspect, referenceImages, sceneId: scene.id, sceneCount: frameCount }),
      });
      const result = await response.json() as { image?: string; error?: string };
      if (!response.ok || !result.image) throw new Error(result.error || `Google API: ${response.status}`);
      const completed: Scene = { ...scene, image: result.image, status: "done", error: undefined };
      setScenes((items) => items.map((item) => item.id === scene.id ? completed : item));
      return completed;
    } catch (error) {
      const rawReason = error instanceof Error ? error.message : "Ошибка генерации";
      const reason = rawReason === "Failed to fetch" ? "Связь с локальным сервером потеряна" : rawReason;
      const failed: Scene = { ...scene, status: "error", error: reason };
      setScenes((items) => items.map((item) => item.id === scene.id ? failed : item));
      return failed;
    }
  }

  async function generateAll(sourceScenes?: Scene[], sourceKeys?: string[], onProgress?: (completed: number, total: number) => void) {
    const list = sourceKeys || keyList();
    if (!list.length) { setShowKeys(true); return; }
    if (!script.trim()) { setMessage("Вставь текст для озвучки в большое поле сверху."); return; }
    let activeScenes = sourceScenes || scenes;
    if (!activeScenes.length) {
      activeScenes = splitIntoScenes(script, frameCount, estimatedDuration, style, direction, aspect);
      setScenes(activeScenes);
      setSelectedId(activeScenes[0]?.id || null);
    }
    setIsGenerating(true);
    setMessage(`Создаю ${activeScenes.length} кадров. У каждого кадра будет свой ключ по кругу…`);
    const queue = activeScenes.filter((scene) => scene.status !== "done");
    const results = new Map<number, Scene>();
    activeScenes.filter((scene) => scene.status === "done").forEach((scene) => results.set(scene.id, scene));
    let cursor = 0;
    let completed = results.size;
    const worker = async () => {
      while (cursor < queue.length) {
        const index = cursor++;
        const result = await generateScene(queue[index], list);
        results.set(result.id, result);
        completed++;
        onProgress?.(completed, activeScenes.length);
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, queue.length) }, () => worker()));
    const merged = activeScenes.map((scene) => results.get(scene.id) || scene);
    setScenes(merged);
    setIsGenerating(false);
    setMessage("Очередь завершена. Кадры с ошибкой можно повторить отдельно.");
    return merged;
  }

  async function renderVideo(videoScenes: Scene[] = scenes, soundtrack: File | null = audioFile, durationOverride = estimatedDuration) {
    if (!videoScenes.length || videoScenes.some((scene) => !scene.image)) {
      setMessage("Снача создай все кадры. После этого сайт соберёт их в один MP4.");
      return false;
    }
    if (!("VideoEncoder" in window)) {
      setMessage("Этот браузер не поддерживает быструю сборку MP4. Открой сайт в Chrome.");
      return false;
    }
    setIsRendering(true);
    setRenderProgress(0);
    setMessage(aspect === "16:9"
      ? "Собираю лонг MP4: плавное покачивание кадров от +7,5° до −7,5° и озвучка…"
      : "Собираю Shorts MP4 без наклона кадров, с озвучкой…");
    try {
      const width = aspect === "9:16" ? 720 : 1280;
      const height = aspect === "9:16" ? 1280 : 720;
      const duration = videoScenes.at(-1)?.end || durationOverride;
      const fps = duration >= 600 ? 15 : 24;
      const frameDuration = 1 / fps;
      const totalFrames = Math.ceil(duration * fps);
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) throw new Error("Не удалось создать видеохолст");

      const images = await Promise.all(videoScenes.map((scene) => new Promise<HTMLImageElement>((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error(`Не загрузился кадр ${scene.id}`));
        image.src = scene.image!;
      })));

      const bufferTarget = new BufferTarget();
      const output = new Output({ format: new Mp4OutputFormat({ fastStart: "in-memory" }), target: bufferTarget });
      const videoSource = new CanvasSource(canvas, { codec: "avc", quality: new Quality("high") });
      output.addVideoTrack(videoSource, { frameRate: fps });

      let audioSource: AudioBufferSource | null = null;
      let decodedAudio: AudioBuffer | null = null;
      if (soundtrack) {
        const audioContext = new AudioContext();
        decodedAudio = await audioContext.decodeAudioData(await soundtrack.arrayBuffer());
        await audioContext.close();
        if (decodedAudio.duration < duration * 0.96) {
          throw new Error(`Озвучка длится только ${clock(decodedAudio.duration)}, а видео ${clock(duration)}. Сборка остановлена, чтобы не создавать ролик с тишиной.`);
        }
        const exactLength = Math.max(1, Math.round(duration * decodedAudio.sampleRate));
        const exactAudio = new AudioBuffer({ length: exactLength, numberOfChannels: decodedAudio.numberOfChannels, sampleRate: decodedAudio.sampleRate });
        for (let channel = 0; channel < decodedAudio.numberOfChannels; channel++) {
          exactAudio.getChannelData(channel).set(decodedAudio.getChannelData(channel).subarray(0, exactLength));
        }
        decodedAudio = exactAudio;
        audioSource = new AudioBufferSource({ codec: "aac", quality: new Quality("high") });
        output.addAudioTrack(audioSource);
      }

      await output.start();
      if (audioSource && decodedAudio) await audioSource.add(decodedAudio);

      const drawCover = (image: HTMLImageElement, progress: number) => {
        const base = Math.max(width / image.naturalWidth, height / image.naturalHeight);
        const isLongForm = aspect === "16:9";
        const scale = base * (isLongForm ? 1.23 : 1);
        const drawnWidth = image.naturalWidth * scale;
        const drawnHeight = image.naturalHeight * scale;
        const eased = 0.5 - Math.cos(Math.PI * progress) / 2;
        const rotation = isLongForm ? (7.5 - eased * 15) * Math.PI / 180 : 0;
        context.save();
        context.translate(width / 2, height / 2);
        context.rotate(rotation);
        context.drawImage(image, -drawnWidth / 2, -drawnHeight / 2, drawnWidth, drawnHeight);
        context.restore();
      };

      let sceneIndex = 0;
      for (let frame = 0; frame < totalFrames; frame++) {
        const timestamp = frame / fps;
        while (sceneIndex < videoScenes.length - 1 && timestamp >= videoScenes[sceneIndex].end) sceneIndex++;
        const scene = videoScenes[sceneIndex];
        const local = Math.max(0, Math.min(1, (timestamp - scene.start) / Math.max(0.001, scene.end - scene.start)));
        context.fillStyle = "#08090a";
        context.fillRect(0, 0, width, height);
        drawCover(images[sceneIndex], local);
        await videoSource.add(timestamp, frameDuration, { keyFrame: frame % (fps * 2) === 0 });
        if (frame % fps === 0 || frame === totalFrames - 1) {
          const progress = (frame + 1) / totalFrames;
          setRenderProgress(progress);
          setPipelineProgress(80 + progress * 19);
        }
      }

      await output.finalize();
      if (!bufferTarget.buffer) throw new Error("Не удалось получить готовый MP4");
      if (videoUrl) URL.revokeObjectURL(videoUrl);
      const renderedVideo = new Blob([bufferTarget.buffer], { type: "video/mp4" });
      setVideoBlob(renderedVideo);
      setVideoUrl(URL.createObjectURL(renderedVideo));
      setRenderProgress(1);
      setMessage(`Готово: один MP4 ${aspect} собран${soundtrack ? " с озвучкой" : " без озвучки"}.`);
      return true;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") setMessage("Сохранение MP4 отменено.");
      else setMessage(error instanceof Error ? `Сборка не удалась: ${error.message}` : "Сборка MP4 не удалась");
      return false;
    } finally {
      setIsRendering(false);
    }
  }

  async function exportToCapCut() {
    if (!videoBlob || scenes.some((scene) => !scene.image)) {
      setMessage("Снача дождись готового MP4 и всех кадров.");
      return;
    }
    const shouldContinue = window.confirm("Перед добавлением закрой CapCut, чтобы он не перезаписал список проектов.\n\nЗатем выбери папку com.lveditor.draft.");
    if (!shouldContinue) return;
    setIsExportingCapCut(true);
    setCapCutMessage("Подготавливаю проект…");
    try {
      const projectName = await addProjectToCapCut({
        scenes,
        readyVideo: videoBlob,
        aspect,
        duration: estimatedDuration,
        onProgress: setCapCutMessage,
      });
      setCapCutMessage(`✓ Проект «${projectName}» добавлен. Открой CapCut.`);
      setMessage(`Готово: в CapCut добавлен проект «${projectName}». Каждый кадр лежит отдельным клипом.`);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") setCapCutMessage("Добавление отменено.");
      else setCapCutMessage(error instanceof Error ? `Не добавилось: ${error.message}` : "Не удалось добавить проект в CapCut.");
    } finally {
      setIsExportingCapCut(false);
    }
  }

  async function createWholeVideo() {
    const list = keyList();
    if (!script.trim()) { setMessage("Вставь текст для озвучки."); return; }
    if (!list.length) { setShowKeys(true); return; }
    setVideoUrl("");
    setPipelineProgress(2);
    setPipelineStage("voice");
    setPipelineLabel(`Создаю озвучку: 0 из ${splitVoiceText(voiceTextForScript(script)).length} частей…`);
    setVoiceError("");
    try {
      let soundtrack = audioFile;
      let duration = audioDuration;
      if (!soundtrack) {
        soundtrack = await requestLongVoiceTrack(list, voiceTextForScript(script), targetDuration, (completed, total) => {
          setPipelineProgress(2 + (completed / total) * 16);
          setPipelineLabel(`Создаю озвучку: часть ${completed} из ${total}`);
        });
        duration = await measureAudio(soundtrack);
        if (splitVoiceText(script).length === 1 && (duration < targetDuration * 0.85 || duration > targetDuration * 1.15)) {
          setPipelineLabel(`Корректирую темп озвучки: было ${clock(duration)}, нужно ${clock(targetDuration)}…`);
          soundtrack = await requestVoiceTrack(list, script, targetDuration, duration);
          duration = await measureAudio(soundtrack);
        }
        attachAudio(soundtrack);
      }
      duration = targetDuration;
      setPipelineProgress(20);
      setPipelineStage("frames");
      setPipelineLabel(`Создаю ${frameCount} кадров в закреплённом стиле канала…`);
      const plan = splitIntoScenes(script, frameCount, duration, style, direction, aspect);
      setScenes(plan);
      setSelectedId(plan[0]?.id || null);
      let generated = await generateAll(plan, list, (completed, total) => {
        setPipelineProgress(20 + (completed / total) * 58);
        setPipelineLabel(`Создаю кадры: ${completed} из ${total}`);
      });
      for (let retry = 1; generated && generated.some((scene) => !scene.image) && retry <= 3; retry++) {
        const missing = generated.filter((scene) => !scene.image).length;
        setPipelineLabel(`Повторяю ${missing} недостающих кадров · попытка ${retry} из 3…`);
        generated = await generateAll(generated, list, (completed, total) => {
          setPipelineProgress(20 + (completed / total) * 58);
          setPipelineLabel(`Повторяю недостающие кадры: ${completed} из ${total}`);
        });
      }
      if (!generated || generated.some((scene) => !scene.image)) throw new Error("Не все кадры создались. Открой «Исправить отдельные кадры» и повтори красные кадры.");
      setPipelineProgress(80);
      setPipelineStage("render");
      setPipelineLabel("Собираю кадры и озвучку в один MP4…");
      const rendered = await renderVideo(generated, soundtrack, duration);
      if (!rendered) throw new Error("Не удалось собрать MP4");
      setPipelineProgress(100);
      setPipelineStage("done");
      setPipelineLabel("Готовое видео создано");
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Создание видео остановилось";
      setPipelineStage("error");
      setPipelineLabel(reason);
      setVoiceError(reason);
      setMessage(`Видео не создано: ${reason}`);
      setIsGenerating(false);
      setIsRendering(false);
    }
  }

  async function continueMissingFrames() {
    const list = keyList();
    if (!list.length) { setShowKeys(true); return; }
    if (!audioFile) { setMessage("Готовая озвучка не найдена в этой вкладке. Сначала создай или загрузи аудиодорожку."); return; }
    if (!scenes.length) { setMessage("Список кадров пуст. Сначала создай план видео."); return; }
    setPipelineStage("frames");
    setPipelineProgress(20 + (done / scenes.length) * 58);
    setVoiceError("");
    try {
      let recovered = scenes;
      for (let retry = 1; recovered.some((scene) => !scene.image) && retry <= 4; retry++) {
        const missing = recovered.filter((scene) => !scene.image).length;
        setPipelineLabel(`Продолжаю только ${missing} недостающих кадров · попытка ${retry} из 4…`);
        const next = await generateAll(recovered, list, (completed, total) => {
          setPipelineProgress(20 + (completed / total) * 58);
          setPipelineLabel(`Готово кадров: ${completed} из ${total}`);
        });
        if (!next) throw new Error("Не удалось продолжить очередь кадров");
        recovered = next;
      }
      const missing = recovered.filter((scene) => !scene.image).length;
      if (missing) throw new Error(`Осталось кадров с ошибкой: ${missing}. Нажми «Продолжить» ещё раз.`);
      setScenes(recovered);
      setPipelineStage("render");
      setPipelineProgress(80);
      setPipelineLabel("Все кадры готовы. Собираю MP4 с сохранённой озвучкой…");
      const rendered = await renderVideo(recovered, audioFile, targetDuration);
      if (!rendered) throw new Error("Не удалось собрать MP4");
      setPipelineProgress(100);
      setPipelineStage("done");
      setPipelineLabel("Готовое видео создано");
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Продолжение кадров остановилось";
      setPipelineStage("error");
      setPipelineLabel(reason);
      setMessage(reason);
    }
  }

  const pipelineRunning = pipelineStage === "voice" || pipelineStage === "frames" || pipelineStage === "render";
  const pipelineIndex = pipelineStage === "voice" ? 0 : pipelineStage === "frames" ? 1 : pipelineStage === "render" ? 2 : pipelineStage === "done" ? 3 : -1;

  return (
    <main>
      <header className="header">
        <div className="logo"><span>C</span><div><strong>CineFrame</strong><small>Nano Banana Studio</small></div></div>
        <div className="headerActions"><button className="plain" onClick={() => setShowKeys(true)}>Ключи Google</button><i /> <span>gemini-3.1-flash-image</span></div>
      </header>

      <section className="quickHero">
        <p>СОЗДАНИЕ ВИДЕО В ОДНОМ ОКНЕ</p>
        <h1>Вставь текст — получи готовый ролик</h1>
        <span>Голос, кадры и MP4 идут по порядку. Никакого водяного знака.</span>
      </section>

      <section className="quickStudio card">
        <div className="quickStep scriptStep">
          <div className="quickTitle"><b>1</b><div><h2>Текст для озвучки</h2><p>Вставляй сюда именно тот текст, который должен произнести голос.</p></div></div>
          <label className="textFileImport"><input type="file" accept=".txt,.md,text/plain,text/markdown" onChange={importTextFile} /><b>Загрузить файл с компьютера</b><span>TXT с озвучкой, промптами или готовым проектом</span></label>
          <textarea className="mainScript" value={script} onChange={(e) => { setScript(e.target.value); setScenes([]); }} placeholder="Вставь сюда полный текст ролика…" autoFocus />
          <div className="scriptMeta"><span>{wordCount} слов</span><span>План: {clock(estimatedDuration)}</span></div>
          <label className="scenePromptBlock"><span>Промпт сцен и видео</span><textarea value={direction} onChange={(e) => { setDirection(e.target.value); setScenes([]); }} placeholder={"Напиши сцены отдельными строками:\n1. A thoughtful man standing in a vast library...\n2. The same man studying several documents...\n3. ..."} /><small>Каждая пронумерованная строка — отдельный кадр. Для выбранной длины нужно {frameCount} строк: новая сцена строго каждые 7 секунд. Стиль добавляется автоматически; этот текст не озвучивается.</small></label>
        </div>

        <div className="quickDivider" />

        <div className="quickStep">
          <div className="quickTitle"><b>2</b><div><h2>Озвучка</h2><p>Выбери голос и нажми большую кнопку. Он прочитает текст сверху.</p></div></div>
          <div className="simpleVoiceRow">
            <label>Голос<select value={voice} onChange={(e) => setVoice(e.target.value)}>{VOICES.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
            <button className="previewButton" onClick={previewVoice} disabled={isGeneratingVoicePreview || isGeneratingVoice}>{isGeneratingVoicePreview ? "Создаю пример…" : "▶ Пример голоса"}</button>
            <button className="createVoiceButton" onClick={generateVoice} disabled={isGeneratingVoicePreview || isGeneratingVoice}>{isGeneratingVoice ? "Озвучиваю текст…" : "Создать озвучку текста"}</button>
          </div>
          <div className={`voiceResult ${isGeneratingVoicePreview || isGeneratingVoice ? "working" : voiceError ? "error" : voicePreviewUrl ? "ready" : ""}`}>
            {isGeneratingVoicePreview ? <><b><i /> Создаю короткий пример…</b><small>Плеер появится здесь.</small></> : isGeneratingVoice ? <><b><i /> Озвучиваю весь текст сверху…</b><small>Не закрывай страницу.</small></> : voiceError ? <><b>Озвучка остановилась</b><small>{voiceError}</small>{voiceError.includes("current location") && <em>Включи VPN с поддерживаемой страной.</em>}{voiceError.includes("403") && <em>Переключи VPN на другой сервер и попробуй снова.</em>}<button className="retryVoiceInline" onClick={generateVoice}>Продолжить озвучку</button></> : voicePreviewUrl ? <><b>✓ Пример {voice}</b><audio className="voicePreview" ref={voicePreviewRef} src={voicePreviewUrl} controls /></> : <><b>Пример появится здесь</b><small>Кнопка «Пример голоса» читает короткую тестовую фразу.</small></>}
          </div>
          {audioUrl && <div className="mainAudio"><div><b>✓ Озвучка ролика готова</b><small>{clock(audioDuration)} · {audioName}</small><a href={audioUrl} download="cineframe-full-voice.wav">Скачать полную WAV</a></div><audio ref={audioRef} src={audioUrl} controls onTimeUpdate={(e) => setPlayhead(e.currentTarget.currentTime)} /></div>}
          <label className={`compactUpload ${audioName ? "filled" : ""}`}><input type="file" accept="audio/*" onChange={handleAudio} /><span>Или загрузить свою MP3 / WAV</span></label>
        </div>

        <div className="quickDivider" />

        <div className="quickStep">
          <div className="quickTitle"><b>3</b><div><h2>Параметры видео</h2><p>Только три главные настройки.</p></div></div>
          <div className="bigControls">
            <label>Длительность<select value={targetDuration} onChange={(e) => { setTargetDuration(Number(e.target.value)); setAudioDuration(0); setAudioFile(null); setAudioUrl(""); setAudioName(""); setScenes([]); }}><option value={30}>30 секунд</option><option value={60}>1 минута</option><option value={180}>3 минуты</option><option value={300}>5 минут</option><option value={600}>10 минут</option><option value={900}>15 минут</option><option value={1200}>20 минут</option><option value={1800}>30 минут</option></select><small>{audioDuration ? `Озвучка ${clock(audioDuration)} · видео ${clock(targetDuration)}` : "Это точная длина готового MP4"}</small></label>
            <label>Смена кадра<div className="staticControl">Каждые 7 секунд</div><small>{frameCount} сцен на {clock(targetDuration)}</small></label>
            <label>Формат<select value={aspect} onChange={(e) => { setAspect(e.target.value); setScenes([]); }}><option value="16:9">16:9 · YouTube</option><option value="9:16">9:16 · Shorts</option></select><small>{aspect === "9:16" ? "Вертикальное видео" : "Горизонтальное видео"}</small></label>
          </div>
          <div className="quickOptions"><strong>{aspect === "16:9" ? "Лонги: анимация +7,5° → −7,5°" : "Shorts: кадры без наклона"}</strong><span>Без субтитров</span></div>
          <details className="advanced"><summary>Дополнительные настройки</summary><label>Качество<select value={quality} onChange={(e) => setQuality(e.target.value)}><option>1K</option><option>2K</option><option>4K</option></select></label><label>Манера речи<textarea value={voiceDirection} onChange={(e) => setVoiceDirection(e.target.value)} /></label><div className="lockedStyle"><b>Стиль канала закреплён</b><small>Oil painting · chiaroscuro · red & teal · visible brushstrokes · film grain</small></div></details>
          <button className="createFramesButton wholeVideoButton" onClick={createWholeVideo} disabled={pipelineRunning || !script.trim()}>{pipelineRunning ? pipelineLabel : "СОЗДАТЬ ГОТОВОЕ ВИДЕО"}</button>
          <div className={`pipelinePanel ${pipelineStage}`} aria-live="polite">
            <div className="pipelineSteps">
              {["Озвучка", "Кадры", "Сборка MP4", "Готово"].map((label, index) => <div key={label} className={`pipelineStep ${pipelineStage === "error" ? "" : index < pipelineIndex || pipelineStage === "done" ? "done" : index === pipelineIndex ? "active" : ""}`}><i>{index < pipelineIndex || pipelineStage === "done" ? "✓" : index + 1}</i><span>{label}</span></div>)}
            </div>
            <div className="progressTrack"><div className="progressFill" style={{ width: `${pipelineProgress}%` }} /></div>
            <div className="pipelineStatus"><b>{pipelineStage === "error" ? "Ошибка" : `${Math.round(pipelineProgress)}%`}</b><span>{pipelineLabel}</span></div>
            {pipelineStage === "error" && (voiceError.includes("current location") || voiceError.includes("403")) && <p className="pipelineHint">Google блокирует озвучку для текущего IP. Переключи VPN на США или Европу и нажми кнопку ещё раз.</p>}
          </div>
          {scenes.length > 0 && done < scenes.length && audioFile && <button className="resumeFramesButton" onClick={continueMissingFrames} disabled={pipelineRunning || isGenerating || isRendering}>ПРОДОЛЖИТЬ {scenes.length - done} НЕДОСТАЮЩИХ КАДРОВ</button>}
        </div>
      </section>

      <section className="motionDemo card">
        <div><p>ТЕСТ ДВИЖЕНИЯ ДЛЯ ЛОНГОВ</p><h2>Вот так кадры 16:9 будут качаться в CapCut</h2><span>Каждая фотография мягко идёт от +7,5° к −7,5°. В Shorts 9:16 наклон отключён.</span></div>
        <video src="/capcut-sway-demo.mp4" controls loop muted playsInline preload="metadata" />
      </section>

      <section className="storyboard card quickStoryboard">
        <div className="storyHead"><div><h2>Готовое видео</h2><p>{videoUrl ? `${clock(estimatedDuration)} · ${aspect} · озвучка и анимированные кадры` : pipelineRunning ? pipelineLabel : "Здесь появится один собранный ролик"}</p></div>{videoUrl && <div className="storyActions"><a className="downloadVideo downloadReady" href={videoUrl} download="cineframe-video.mp4">Скачать MP4</a></div>}</div>
        {message && <div className="notice">{message}</div>}
        {videoUrl ? <div className={`finalVideoCard ${aspect === "9:16" ? "vertical" : ""}`}><video src={videoUrl} controls playsInline /><div><b>✓ Ролик собран целиком</b><span>Кадры, тайминг и озвучка уже внутри MP4.</span><button className="capcutButton" onClick={exportToCapCut} disabled={isExportingCapCut}>{isExportingCapCut ? "ДОБАВЛЯЮ В CAPCUT…" : "ДОБАВИТЬ ПРОЕКТ В CAPCUT"}</button><small className="capcutHint">Каждая фотография будет отдельным клипом на таймлайне.</small>{capCutMessage && <em className={`capcutStatus ${capCutMessage.startsWith("Не ") ? "error" : ""}`}>{capCutMessage}</em>}</div></div> : <div className="compactEmpty"><span>{pipelineRunning ? `${Math.round(pipelineProgress)}%` : "Видео пока нет"}</span><p>{pipelineRunning ? pipelineLabel : "Вставь текст и промпты сцен, затем нажми «Создать готовое видео»."}</p></div>}
        {scenes.length > 0 && <details className="framesEditor"><summary>Исправить отдельные кадры ({done}/{scenes.length})</summary><div className="framesEditorBody"><div className="framesEditorActions"><span>Открывай это только если нужно заменить конкретную картинку.</span><button className="plain" onClick={() => generateAll() } disabled={isGenerating || pipelineRunning}>Повторить незавершённые</button><button className="plain" onClick={() => renderVideo()} disabled={isRendering || isGenerating || done !== scenes.length}>Пересобрать MP4</button></div><div className="workarea"><div className="sceneGrid">{scenes.map((scene) => <button key={scene.id} onClick={() => setSelectedId(scene.id)} className={`shot ${scene.id === selectedId ? "selected" : ""}`}><div className={`shotImage ${aspect === "9:16" ? "vertical" : ""}`}>{scene.image ? <img src={scene.image} alt={`Кадр ${scene.id}`} /> : <span>{scene.status === "working" ? "…" : String(scene.id).padStart(2,"0")}</span>}<i className={scene.status} /></div><small>{clock(scene.start)}–{clock(scene.end)}</small><p>{scene.text}</p>{scene.error && <em>{scene.error}</em>}</button>)}</div>{selected && <aside className="inspector"><div className={`preview ${aspect === "9:16" ? "vertical" : ""}`}>{selected.image ? <img src={selected.image} alt="Предпросмотр" /> : <div>Кадр {selected.id}</div>}</div><label>Текст кадра<textarea value={selected.text} onChange={(e) => setScenes((items) => items.map((item) => item.id === selected.id ? { ...item, text: e.target.value } : item))} /></label><label>Промпт изображения<textarea className="prompt" value={selected.prompt} onChange={(e) => setScenes((items) => items.map((item) => item.id === selected.id ? { ...item, prompt: e.target.value, status: "ready" } : item))} /></label><button className="generate one" onClick={() => { const list = keyList(); if (!list.length) setShowKeys(true); else void generateScene(selected, list); }}>Повторить этот кадр</button></aside>}</div></div></details>}
      </section>

      {showKeys && <div className="modal" onMouseDown={(e) => { if (e.target === e.currentTarget) setShowKeys(false); }}><div className="modalBox"><button className="close" onClick={() => setShowKeys(false)}>×</button><h2>Ключи Google AI</h2><p>Они используются и для кадров, и для озвучки. Каждый следующий запрос берёт следующий ключ по кругу. Ключи хранятся только в этом браузере.</p><label className="csvImport"><input type="file" accept=".csv,text/csv" onChange={importKeys} /><span>Импортировать CSV с ключами</span><small>{keyList().length ? `Сейчас сохранено: ${keyList().length}` : "Подойдёт gemini_api_keys_50_2026-07-31.csv"}</small></label><textarea value={keys} onChange={(e) => setKeys(e.target.value)} placeholder={"AIza...\nAIza..."} /><button className="primary" onClick={saveKeys}>Сохранить</button></div></div>}
    </main>
  );
}
