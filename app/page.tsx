"use client";

import { ChangeEvent, useEffect, useMemo, useRef, useState } from "react";
import { AudioBufferSource, BufferTarget, CanvasSource, Mp4OutputFormat, Output, Quality, StreamTarget, type StreamTargetChunk } from "mediabunny";
import { SimpleFilter, SoundTouch, WebAudioBufferSource } from "soundtouchjs";
import { addProjectToCapCut } from "./capcut-export";
import {
  clearGeneratedProjectMedia,
  deleteProjectBlob,
  loadProjectBlob,
  loadProjectCheckpoint,
  ProjectCheckpoint,
  saveProjectBlob,
  saveProjectCheckpoint,
  saveSceneImage,
} from "./project-storage";

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

const DEFAULT_STYLE = `cinematic oil-painting style matching the supplied channel reference, unmistakably hand-painted rather than photographic, dense broad visible brushstrokes and soft impasto texture across the entire frame, gently simplified faces and objects, softened contours, low microcontrast, smoky atmospheric depth and restrained analog grain, dark teal and petrol-blue interiors with readable shadow detail, vivid crimson-red rain reflections and warm amber practical light used as controlled accents, contemplative psychological mood, lonely thoughtful human figures shown naturally from the side or three-quarter view, dark but never underexposed, cinematic 16:9 widescreen composition, no sharp modern digital detail, no glossy CGI, no hyperreal skin, no clean vector edges, no neon cyberpunk look, no text, no subtitles, no logo, no watermark`;

const STYLE_REFERENCE_PATHS = [
  "/style-references/psychology-style-user-target.png",
];

const QWEN_LOCAL_CLONE_ID = "qwen-local-youtube-clone";
const QWEN_CLOUD_CLONE_ID = "qwen-cloud-youtube-clone";
const QWEN_LOCAL_PROFILE_ID = "6c7a7827-0001-461e-a50e-5703d42c0b54";
const QWEN_REFERENCE_FILE = "/wealth-simple-voice-reference-clean.wav";
const QWEN_EMBEDDING_STORAGE_KEY = "cineframe_fal_qwen_embedding_v1";
const QWEN_REQUEST_CHARS = 650;
const VOICE_REVISION = 7;
const QWEN_REFERENCE_TEXT = `Начнем с правды, которую мало кто хочет слышать — разбогатеть несложно.
Людям нравится думать иначе. Они рассуждают об этом так, будто существует тайная формула, спрятанная в древних трактатах, или доступная лишь избранным.
Но реальность гораздо проще.`;

const VOICES = [
  { id: "Algieba", label: "Основной голос · мягкий живой мужской Gemini" },
];

function isQwenCloneVoice(voiceId: string) {
  return voiceId === QWEN_LOCAL_CLONE_ID || voiceId === QWEN_CLOUD_CLONE_ID;
}

const DEFAULT_VOICE_DIRECTION = `# AUDIO PROFILE
Nikolai is a native Russian male essay narrator in his early thirties. His voice is warm, smooth and grounded, with the natural imperfections of a real person speaking from experience. He is intelligent without sounding academic, intimate without whispering, and emotionally present without acting.

# THE SCENE
Nikolai is recording late in a quiet, softly lit room for one attentive listener. He understands the thought first and then says it, as if this is a genuine conversation rather than a prepared voice-over. The microphone is close, but his voice remains fully voiced, clean and comfortable.

# DIRECTOR'S NOTES
Speak natural contemporary Russian. Let meaning control rhythm: move easily through linking words, give important ideas subtle weight, and allow tiny thinking moments only where the thought truly turns. Keep a calm flowing pace suitable for a psychological YouTube essay. Vary sentence melody and energy gently so consecutive sentences never land in the same mechanical pattern. Begin softly and naturally, as though continuing an interesting conversation; never hit the first word. Use restrained human curiosity, recognition, concern and warmth when the text calls for them. Keep diction clear but pleasantly relaxed, with natural consonants and no artificial over-articulation. Include subtle real breathing and tiny changes of energy between thoughts. The delivery may be slightly imperfect and spontaneous: let an occasional phrase flow faster and the next important phrase settle naturally. Do not polish away every human irregularity.

Never sound like an announcer, trailer narrator, meditation app, audiobook caricature or synthetic assistant. No fixed cadence, no metronomic pauses, no identical sentence endings, no grave authority, no theatrical drama, no whisper, no stretched vowels and no audible performance tags. Read the supplied Russian script verbatim without adding, removing or paraphrasing words.`;
const POPULAR_VOICE_WPM = 129;
const VOICE_TEMPO = 1;
const VOICE_PREVIEW_TEXT = "Иногда одна мысль меняет всё. Но самое важное мы замечаем только тогда, когда перестаём спешить.";
const SHORTS_OUTRO = "Здесь — суть за минуту. На основном канале — то, что действительно меняет мышление.";
const SCENE_SECONDS = 10;
const LONG_OPENING_HOOK_SECONDS = 20;
const CROSSFADE_SECONDS = 0.35;

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

async function slowVoiceFile(file: File, tempo = VOICE_TEMPO) {
  const audioContext = new AudioContext({ sampleRate: 24000 });
  try {
    const buffer = await audioContext.decodeAudioData(await file.arrayBuffer());
    const soundTouch = new SoundTouch(buffer.sampleRate);
    soundTouch.tempo = tempo;
    soundTouch.pitch = 1;
    soundTouch.rate = 1;
    const filter = new SimpleFilter(new WebAudioBufferSource(buffer), soundTouch);
    const blockFrames = 8192;
    const maximumFrames = Math.ceil(buffer.length / tempo + buffer.sampleRate * 3);
    const blocks: Float32Array[] = [];
    let totalFrames = 0;
    while (totalFrames < maximumFrames) {
      const block = new Float32Array(blockFrames * 2);
      const extracted = filter.extract(block, blockFrames);
      if (extracted <= 0) break;
      blocks.push(block.slice(0, extracted * 2));
      totalFrames += extracted;
    }
    if (!totalFrames) return file;
    const pcm = new Uint8Array(totalFrames * 2);
    const view = new DataView(pcm.buffer);
    let outputFrame = 0;
    for (const block of blocks) {
      for (let frame = 0; frame < block.length / 2; frame++) {
        const value = Math.max(-1, Math.min(1, ((block[frame * 2] || 0) + (block[frame * 2 + 1] || 0)) / 2));
        view.setInt16(outputFrame * 2, value < 0 ? value * 0x8000 : value * 0x7fff, true);
        outputFrame++;
      }
    }
    return new File([makeWav([pcm], buffer.sampleRate)], file.name.replace(/\.wav$/i, "-slower.wav"), { type: "audio/wav" });
  } finally {
    await audioContext.close();
  }
}

async function forceVoiceDuration(file: File, targetSeconds: number) {
  const audioContext = new AudioContext({ sampleRate: 24000 });
  try {
    const buffer = await audioContext.decodeAudioData(await file.arrayBuffer());
    const sampleRate = buffer.sampleRate || 24000;
    const exactSamples = Math.max(1, Math.round(targetSeconds * sampleRate));
    const copiedSamples = Math.min(buffer.length, exactSamples);
    const pcm = new Uint8Array(exactSamples * 2);
    const view = new DataView(pcm.buffer);
    for (let sample = 0; sample < copiedSamples; sample++) {
      let value = 0;
      for (let channel = 0; channel < buffer.numberOfChannels; channel++) value += buffer.getChannelData(channel)[sample] || 0;
      value = Math.max(-1, Math.min(1, value / Math.max(1, buffer.numberOfChannels)));
      view.setInt16(sample * 2, value < 0 ? value * 0x8000 : value * 0x7fff, true);
    }
    return new File([makeWav([pcm], sampleRate)], file.name.replace(/\.wav$/i, "-exact.wav"), { type: "audio/wav" });
  } finally {
    await audioContext.close();
  }
}

async function fitVoiceFileToDuration(file: File, targetSeconds: number) {
  const audioContext = new AudioContext({ sampleRate: 24000 });
  let currentSeconds = 0;
  try {
    const buffer = await audioContext.decodeAudioData(await file.arrayBuffer());
    currentSeconds = buffer.duration;
  } finally {
    await audioContext.close();
  }
  if (!currentSeconds || !targetSeconds) return file;
  const tempo = currentSeconds / targetSeconds;
  if (tempo < 0.72 || tempo > 1.28) {
    throw new Error(`Текст не помещается естественно: голос ${clock(currentSeconds)}, видео ${clock(targetSeconds)}. Сократи или дополни сценарий примерно на ${Math.round(Math.abs(1 - tempo) * 100)}%.`);
  }
  const stretched = Math.abs(tempo - 1) < 0.005 ? file : await slowVoiceFile(file, tempo);
  return forceVoiceDuration(stretched, targetSeconds);
}

async function tightenLongVoicePauses(file: File) {
  const audioContext = new AudioContext({ sampleRate: 24000 });
  try {
    const buffer = await audioContext.decodeAudioData(await file.arrayBuffer());
    const sampleRate = buffer.sampleRate || 24000;
    const threshold = 0.008;
    const minimumSilence = Math.round(sampleRate * 0.58);
    const keptSilence = Math.round(sampleRate * 0.42);
    const outputGain = 1;
    const cuts: Array<[number, number]> = [];
    let silentStart = -1;
    for (let sample = 0; sample <= buffer.length; sample++) {
      let silent = sample < buffer.length;
      for (let channel = 0; silent && channel < buffer.numberOfChannels; channel++) {
        if (Math.abs(buffer.getChannelData(channel)[sample] || 0) >= threshold) silent = false;
      }
      if (silent && silentStart < 0) silentStart = sample;
      if (!silent && silentStart >= 0) {
        const silentLength = sample - silentStart;
        if (silentLength > minimumSilence) {
          const excess = silentLength - keptSilence;
          const cutStart = silentStart + Math.floor(keptSilence / 2);
          cuts.push([cutStart, cutStart + excess]);
        }
        silentStart = -1;
      }
    }
    const removedSamples = cuts.reduce((total, [start, end]) => total + end - start, 0);
    const pcm = new Uint8Array((buffer.length - removedSamples) * 2);
    const view = new DataView(pcm.buffer);
    let outputSample = 0;
    let cutIndex = 0;
    for (let sample = 0; sample < buffer.length; sample++) {
      const cut = cuts[cutIndex];
      if (cut && sample >= cut[0] && sample < cut[1]) continue;
      if (cut && sample >= cut[1]) cutIndex++;
      let value = 0;
      for (let channel = 0; channel < buffer.numberOfChannels; channel++) value += buffer.getChannelData(channel)[sample] || 0;
      value = Math.max(-1, Math.min(1, value / Math.max(1, buffer.numberOfChannels) * outputGain));
      view.setInt16(outputSample * 2, value < 0 ? value * 0x8000 : value * 0x7fff, true);
      outputSample++;
    }
    return new File([makeWav([pcm], sampleRate)], file.name, { type: "audio/wav" });
  } finally {
    await audioContext.close();
  }
}

function clock(seconds: number) {
  const value = Math.max(0, Math.round(seconds));
  return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
}

function frameCountForDuration(seconds: number, openingSeconds = 0) {
  if (openingSeconds <= 0) return Math.max(1, Math.ceil(seconds / SCENE_SECONDS));
  return 1 + Math.max(0, Math.ceil((seconds - Math.min(seconds, openingSeconds)) / SCENE_SECONDS));
}

function shortHash(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function extractOpeningQuote(text: string) {
  const paragraphs = text.trim().split(/\n+/).map((part) => part.trim()).filter(Boolean);
  if (!paragraphs[0]?.startsWith("«") || !paragraphs[0].includes("»") || !paragraphs[1]) return null;
  return { quote: paragraphs[0], author: paragraphs[1], rest: paragraphs.slice(2).join("\n\n") };
}

function estimateOpeningQuoteDuration(text: string) {
  const opening = extractOpeningQuote(text);
  if (!opening) return 0;
  const words = opening.quote.split(/\s+/).filter(Boolean).length;
  return Math.min(20, Math.max(3, words / 2.2 + 0.8));
}

function voiceTextForScript(text: string, includeShortsOutro = false) {
  const voiceText = text;
  if (!includeShortsOutro || voiceText.includes(SHORTS_OUTRO)) return voiceText;
  return `${voiceText.trim()}\n\n${SHORTS_OUTRO}`;
}

const RUSSIAN_VOICE_STRESSES: Array<[string, string]> = [
  ["договоров", "догово́ров"], ["договором", "догово́ром"], ["договоры", "догово́ры"], ["договор", "догово́р"],
  ["обеспечения", "обеспече́ния"], ["обеспечение", "обеспече́ние"], ["обеспечением", "обеспече́нием"],
  ["намерения", "намере́ния"], ["намерение", "намере́ние"], ["намерением", "намере́нием"],
  ["процентов", "проце́нтов"], ["проценты", "проце́нты"], ["процентами", "проце́нтами"],
  ["разбогатеть", "разбогате́ть"], ["богатство", "бога́тство"], ["богатства", "бога́тства"],
  ["бедность", "бе́дность"], ["бедности", "бе́дности"], ["деньгами", "де́ньгами"],
  ["доходов", "дохо́дов"], ["доходы", "дохо́ды"], ["инвестиции", "инвести́ции"], ["инвестировать", "инвести́ровать"],
  ["психология", "психоло́гия"], ["психологии", "психоло́гии"], ["мышление", "мышле́ние"], ["мышления", "мышле́ния"],
  ["самооценка", "самооце́нка"], ["самооценки", "самооце́нки"], ["манипуляция", "манипуля́ция"], ["манипуляции", "манипуля́ции"],
  ["отношения", "отноше́ния"], ["одиночество", "одино́чество"], ["зависимость", "зави́симость"], ["осознание", "осозна́ние"],
  ["феномен", "фено́мен"], ["маркетинг", "ма́ркетинг"], ["каталог", "катало́г"], ["квартал", "кварта́л"],
  ["звонит", "звони́т"], ["позвонит", "позвони́т"], ["начала", "начала́"], ["начался", "начался́"],
  ["поняла", "поняла́"], ["приняла", "приняла́"], ["создала", "создала́"], ["заняла", "заняла́"],
];

function applyRussianVoiceStresses(text: string) {
  let prepared = text.normalize("NFC");
  for (const [plain, stressed] of RUSSIAN_VOICE_STRESSES) {
    const pattern = new RegExp(`(^|[^А-Яа-яЁё])(${plain})(?=$|[^А-Яа-яЁё])`, "giu");
    prepared = prepared.replace(pattern, (_full, prefix: string, matched: string) => {
      const replacement = matched[0] === matched[0]?.toUpperCase()
        ? stressed[0].toUpperCase() + stressed.slice(1)
        : stressed;
      return `${prefix}${replacement}`;
    });
  }
  return prepared;
}

function splitVoiceText(text: string, maxChars = 220) {
  const paragraphs = text.trim().split(/\n+/).map((part) => part.trim()).filter(Boolean);
  const chunks: string[] = [];
  let current = "";
  let startIndex = 0;
  if (paragraphs[0]?.startsWith("«") && paragraphs[0].includes("»")) {
    chunks.push(paragraphs[0]);
    startIndex = 1;
  }
  for (const paragraph of paragraphs.slice(startIndex)) {
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

function splitIntoScenes(text: string, count: number, duration: number, style: string, direction: string, aspect: string, openingSeconds = 0) {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const actualCount = Math.max(1, count);
  const openingDuration = Math.min(duration, Math.max(0, openingSeconds));
  return Array.from({ length: actualCount }, (_, index): Scene => {
    const start = openingDuration > 0
      ? (index === 0 ? 0 : openingDuration + (index - 1) * SCENE_SECONDS)
      : index * SCENE_SECONDS;
    const end = Math.min(duration, index === 0 && openingDuration > 0 ? openingDuration : start + SCENE_SECONDS);
    const from = Math.floor((start / Math.max(1, duration)) * words.length);
    const to = Math.floor((end / Math.max(1, duration)) * words.length);
    const fragment = words.slice(from, to).join(" ") || words[index % Math.max(1, words.length)] || direction || "Визуальная сцена";
    const describedScene = cleanSceneDescription(shotDescription(direction, index, fragment));
    const scenePrompt = index === 0
      ? `OPENING HOOK FRAME — make this image noticeably more thoughtful and psychologically intriguing than the remaining sequence. Show one main person caught in a quiet moment of realization just before an important decision: pensive indirect gaze, restrained tension in the face and hands, expressive silhouette, meaningful negative space and one unanswered visual question. Avoid a generic action collage, a smiling presenter or a busy crowd. Directly connect the emotion and setting to the opening hook. ${describedScene}`
      : describedScene;
    return {
      id: index + 1,
      start,
      end,
      text: fragment,
      prompt: `${scenePrompt}, ${style.replace("cinematic 16:9 widescreen composition", aspect === "9:16" ? "cinematic 9:16 vertical composition" : "cinematic 16:9 widescreen composition")}`,
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
  const [audioSource, setAudioSource] = useState<"generated" | "uploaded">("uploaded");
  const [audioIncludesShortsOutro, setAudioIncludesShortsOutro] = useState(false);
  const [fitVoiceToVideo, setFitVoiceToVideo] = useState(false);
  const [referenceVideoName, setReferenceVideoName] = useState("");
  const [openingQuoteDuration, setOpeningQuoteDuration] = useState(0);
  const [targetDuration, setTargetDuration] = useState(60);
  const [durationMinutesInput, setDurationMinutesInput] = useState("1");
  const [quality, setQuality] = useState("2K");
  const [aspect, setAspect] = useState("16:9");
  const openingSeconds = aspect === "16:9" ? LONG_OPENING_HOOK_SECONDS : 0;
  const frameCount = frameCountForDuration(targetDuration, openingSeconds);
  const [scenes, setScenes] = useState<Scene[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [keys, setKeys] = useState("");
  const [falKey, setFalKey] = useState("");
  const [showKeys, setShowKeys] = useState(false);
  const [message, setMessage] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [isGeneratingVoice, setIsGeneratingVoice] = useState(false);
  const [isGeneratingVoicePreview, setIsGeneratingVoicePreview] = useState(false);
  const [voice, setVoice] = useState("Algieba");
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
  const checkpointIdRef = useRef(crypto.randomUUID());
  const checkpointReadyRef = useRef(false);
  const [checkpointStatus, setCheckpointStatus] = useState("Включаю автосохранение…");
  const [playhead, setPlayhead] = useState(0);

  useEffect(() => {
    setKeys(localStorage.getItem("cineframe_google_keys") || "");
    setFalKey(localStorage.getItem("cineframe_fal_key") || "");
    const savedCursor = Number(localStorage.getItem("cineframe_google_key_cursor") || "0");
    keyCursorRef.current = Number.isFinite(savedCursor) && savedCursor >= 0 ? savedCursor : 0;
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const restored = await loadProjectCheckpoint();
        if (cancelled || !restored) {
          checkpointReadyRef.current = true;
          if (!cancelled) setCheckpointStatus("Автосохранение включено");
          return;
        }
        const { checkpoint, scenes: savedScenes, audioBlob: savedAudio, videoBlob: savedVideo } = restored;
        checkpointIdRef.current = checkpoint.checkpointId;
        setScript(checkpoint.script);
        setDirection(checkpoint.direction);
        setStyle(!checkpoint.style || checkpoint.style.includes("hyper-detailed realism") ? DEFAULT_STYLE : checkpoint.style);
        setTargetDuration(checkpoint.targetDuration);
        setDurationMinutesInput(checkpoint.durationMinutesInput);
        setQuality(checkpoint.quality === "1K" ? "2K" : checkpoint.quality || "2K");
        setAspect(checkpoint.aspect);
        const restoredAudioSource = checkpoint.audioSource || (checkpoint.audioName.startsWith("gemini-") ? "generated" : "uploaded");
        const restoredVoice = "Algieba";
        const legacyVoiceNeedsRefresh = restoredAudioSource === "generated" && (
          checkpoint.voice !== "Algieba"
          || (checkpoint.voiceRevision || 0) < VOICE_REVISION
        );
        setVoice(restoredVoice);
        setVoiceDirection(DEFAULT_VOICE_DIRECTION);
        setScenes(savedScenes as Scene[]);
        setSelectedId(savedScenes[0]?.id || null);
        setAudioDuration(legacyVoiceNeedsRefresh ? 0 : checkpoint.audioDuration);
        setOpeningQuoteDuration(0);
        setAudioSource(restoredAudioSource);
        setAudioIncludesShortsOutro(checkpoint.audioIncludesShortsOutro ?? false);
        setFitVoiceToVideo(checkpoint.fitVoiceToVideo ?? false);
        setReferenceVideoName(checkpoint.referenceVideoName || "");
        if (savedAudio && !legacyVoiceNeedsRefresh) {
          const restoredAudio = new File([savedAudio], checkpoint.audioName || "cineframe-restored-voice.wav", { type: savedAudio.type || "audio/wav" });
          setAudioFile(restoredAudio);
          setAudioName(restoredAudio.name);
          setAudioUrl(URL.createObjectURL(restoredAudio));
        }
        if (savedVideo && !legacyVoiceNeedsRefresh && checkpoint.quality !== "1K") {
          setVideoBlob(savedVideo);
          setVideoUrl(URL.createObjectURL(savedVideo));
        }
        const restoredDone = savedScenes.filter((scene) => scene.status === "done").length;
        if (savedVideo && !legacyVoiceNeedsRefresh && checkpoint.quality !== "1K" && checkpoint.pipelineStage === "done") {
          setPipelineStage("done");
          setPipelineProgress(100);
          setPipelineLabel("Готовое видео восстановлено из автосохранения");
        } else if (savedScenes.length) {
          setPipelineStage(restoredDone === savedScenes.length && savedAudio && !legacyVoiceNeedsRefresh ? "error" : "idle");
          setPipelineProgress(20 + (restoredDone / savedScenes.length) * 58);
          setPipelineLabel(`Восстановлено кадров: ${restoredDone} из ${savedScenes.length}. Можно продолжить.`);
        } else {
          setPipelineStage("idle");
          setPipelineProgress(Math.min(checkpoint.pipelineProgress, savedAudio && !legacyVoiceNeedsRefresh ? 20 : 18));
          setPipelineLabel(legacyVoiceNeedsRefresh ? "Кадры восстановлены. Озвучку пересоздам голосом из самого популярного ролика." : savedAudio ? "Озвучка восстановлена. Можно продолжить создание видео." : "Проект восстановлен. Можно продолжить.");
        }
        setCheckpointStatus(`Восстановлено: ${restoredDone} из ${savedScenes.length || frameCountForDuration(checkpoint.targetDuration, checkpoint.openingQuoteDuration || 0)} кадров`);
      } catch (error) {
        if (!cancelled) setCheckpointStatus(error instanceof Error ? `Автосохранение недоступно: ${error.message}` : "Автосохранение недоступно");
      } finally {
        checkpointReadyRef.current = true;
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!checkpointReadyRef.current) return;
    const timeout = window.setTimeout(() => {
      const checkpoint: ProjectCheckpoint = {
        version: 1,
        checkpointId: checkpointIdRef.current,
        savedAt: Date.now(),
        script,
        direction,
        style,
        targetDuration,
        durationMinutesInput,
        quality,
        aspect,
        voice,
        voiceDirection,
        audioName,
        audioDuration,
        openingQuoteDuration,
        audioSource,
        audioIncludesShortsOutro,
        fitVoiceToVideo,
        referenceVideoName,
        voiceRevision: VOICE_REVISION,
        scenes: scenes.map(({ image: _image, ...scene }) => scene),
        pipelineStage,
        pipelineProgress,
        pipelineLabel,
      };
      void saveProjectCheckpoint(checkpoint)
        .then(() => setCheckpointStatus(`Сохранено автоматически · ${new Date().toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}`))
        .catch((error: unknown) => setCheckpointStatus(error instanceof Error ? `Не сохранилось: ${error.message}` : "Не удалось сохранить проект"));
    }, 300);
    return () => window.clearTimeout(timeout);
  }, [script, direction, style, targetDuration, durationMinutesInput, quality, aspect, voice, voiceDirection, audioName, audioDuration, openingQuoteDuration, audioSource, audioIncludesShortsOutro, fitVoiceToVideo, referenceVideoName, scenes, pipelineStage, pipelineProgress, pipelineLabel]);

  const wordCount = useMemo(() => script.trim().split(/\s+/).filter(Boolean).length, [script]);
  const estimatedDuration = Math.max(1, targetDuration);
  const expectedScenes = frameCount;
  const selected = scenes.find((scene) => scene.id === selectedId) || null;
  const currentScene = scenes.find((scene) => playhead >= scene.start && playhead < scene.end) || selected || scenes[0];
  const done = scenes.filter((scene) => scene.status === "done").length;

  async function invalidateGeneratedProject() {
    if (!scenes.length && !audioFile && !videoBlob) return;
    checkpointIdRef.current = crypto.randomUUID();
    await clearGeneratedProjectMedia().catch((error: unknown) => {
      setCheckpointStatus(error instanceof Error ? `Не удалось очистить старый проект: ${error.message}` : "Не удалось очистить старый проект");
    });
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    if (videoUrl) URL.revokeObjectURL(videoUrl);
    setAudioDuration(0);
    setAudioFile(null);
    setAudioUrl("");
    setAudioName("");
    setAudioSource("uploaded");
    setAudioIncludesShortsOutro(false);
    setOpeningQuoteDuration(0);
    setScenes([]);
    setSelectedId(null);
    setVideoBlob(null);
    setVideoUrl("");
    setPipelineStage("idle");
    setPipelineProgress(0);
    setPipelineLabel("Проект изменён. Можно запускать создание.");
  }

  async function selectNarrator(nextVoice: string) {
    if (nextVoice === voice) return;
    // A narrator change must never destroy expensive generated images. Only the
    // old narration and the MP4 containing it become outdated.
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    if (videoUrl) URL.revokeObjectURL(videoUrl);
    if (voicePreviewUrl) URL.revokeObjectURL(voicePreviewUrl);
    setVoice(nextVoice);
    setVoiceDirection(DEFAULT_VOICE_DIRECTION.replace(/\bAlgieba\b/g, nextVoice));
    setAudioDuration(0);
    setAudioFile(null);
    setAudioUrl("");
    setAudioName("");
    setAudioSource("uploaded");
    setAudioIncludesShortsOutro(false);
    setOpeningQuoteDuration(0);
    setVideoBlob(null);
    setVideoUrl("");
    setVoicePreviewUrl("");
    setVoiceError("");
    setPipelineStage("idle");
    setPipelineProgress(0);
    setPipelineLabel("Голос изменён. Кадры сохранены — создай новую озвучку.");
    setMessage("Голос изменён. Все готовые кадры сохранены; старая озвучка удалена из проекта.");
    await Promise.all([deleteProjectBlob("audio"), deleteProjectBlob("video")]).catch((error: unknown) => {
      setCheckpointStatus(error instanceof Error ? `Не удалось удалить старый звук: ${error.message}` : "Не удалось удалить старый звук");
    });
  }

  async function attachAudio(file: File, options: { preserveScenes?: boolean; source?: "generated" | "uploaded"; includesShortsOutro?: boolean } = {}) {
    if (!options.preserveScenes) await invalidateGeneratedProject();
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    const url = URL.createObjectURL(file);
    const probe = new Audio(url);
    probe.onloadedmetadata = () => {
      const exactDuration = probe.duration || 0;
      setAudioDuration(exactDuration);
      if (options.source === "generated" && exactDuration && !fitVoiceToVideo) {
        setTargetDuration(Math.max(30, Math.round(exactDuration)));
        setDurationMinutesInput(String(Number((exactDuration / 60).toFixed(2))));
      }
      setMessage(fitVoiceToVideo
        ? `Озвучка готова и точно подогнана под видео: ${clock(exactDuration)}.`
        : `Озвучка готова: ${clock(exactDuration)}. Длительность MP4 будет точно по голосу, без растягивания и тишины.`);
    };
    probe.onerror = () => setMessage("Голос создан, но браузер не смог прочитать аудиофайл.");
    setAudioName(file.name);
    setAudioFile(file);
    setAudioUrl(url);
    setAudioSource(options.source || "uploaded");
    setAudioIncludesShortsOutro(Boolean(options.includesShortsOutro));
    await saveProjectBlob("audio", file).then(() => setCheckpointStatus("Озвучка сохранена автоматически")).catch((error: unknown) => {
      setCheckpointStatus(error instanceof Error ? `Озвучка не сохранилась: ${error.message}` : "Озвучка не сохранилась");
    });
  }

  function applyTargetDuration(seconds: number, inputValue?: string) {
    void invalidateGeneratedProject();
    const safeSeconds = Math.max(30, Math.round(seconds));
    setTargetDuration(safeSeconds);
    setDurationMinutesInput(inputValue ?? String(Number((safeSeconds / 60).toFixed(2))));
  }

  function changeDurationMinutes(value: string) {
    setDurationMinutesInput(value);
    const minutes = Number(value.replace(",", "."));
    if (Number.isFinite(minutes) && minutes >= 0.5) applyTargetDuration(minutes * 60, value);
  }

  function handleAudio(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (file) void attachAudio(file);
  }

  function handleReferenceVideo(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    const probe = document.createElement("video");
    probe.preload = "metadata";
    probe.onloadedmetadata = () => {
      const exactDuration = Number((probe.duration || 0).toFixed(3));
      URL.revokeObjectURL(url);
      if (!exactDuration) {
        setMessage("Не удалось определить длительность выбранного видео.");
        return;
      }
      setFitVoiceToVideo(true);
      setReferenceVideoName(file.name);
      setTargetDuration(exactDuration);
      setDurationMinutesInput(String(Number((exactDuration / 60).toFixed(3))));
      setMessage(`Видео «${file.name}» длится ${clock(exactDuration)}. Новая WAV будет подогнана ровно под него.`);
    };
    probe.onerror = () => {
      URL.revokeObjectURL(url);
      setMessage("Браузер не смог прочитать длительность этого MP4.");
    };
    probe.src = url;
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
    const next = splitIntoScenes(script, expectedScenes, estimatedDuration, style, direction, aspect, openingSeconds);
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
      void invalidateGeneratedProject();

      const voiceMarker = "=== ТЕКСТ ДЛЯ ОЗВУЧКИ ===";
      const supportedScenesMarkers = [
        "=== ПРОМПТЫ СЦЕН И ВИДЕО ===",
        "=== СЦЕНЫ / НАПРАВЛЕНИЕ ===",
      ];
      const matchedScenesMarker = supportedScenesMarkers
        .map((marker) => ({ marker, index: content.indexOf(marker) }))
        .filter(({ index }) => index >= 0)
        .sort((a, b) => a.index - b.index)[0];
      const scenesMarkerIndex = matchedScenesMarker?.index ?? -1;
      if (scenesMarkerIndex >= 0) {
        const voicePart = content.slice(0, scenesMarkerIndex).replace(voiceMarker, "").trim();
        const scenesPart = content.slice(scenesMarkerIndex + matchedScenesMarker!.marker.length).trim();
        const voiceWords = voicePart.split(/\s+/).filter(Boolean).length;
        const voiceSeconds = Math.max(30, Math.round((voiceWords / POPULAR_VOICE_WPM) * 60));
        setScript(voicePart);
        setDirection(scenesPart);
        const promptCount = scenesPart.split(/\r?\n/).filter((line) => /^\s*\d+\s*[.):—-]/.test(line)).length;
        applyTargetDuration(voiceSeconds);
        setScenes([]);
        setMessage(`Загружен полный проект «${file.name}»: ${voiceWords} слов (${clock(voiceSeconds)}), промпт сцен добавлен${promptCount ? ` · ${promptCount} готовых кадров` : ""}.`);
        return;
      }

      const promptCount = content.split(/\r?\n/).filter((line) => /^\s*\d+\s*[.):—-]/.test(line)).length;
      if (promptCount >= 3) {
        setDirection(content);
        applyTargetDuration(promptCount * SCENE_SECONDS);
        setScenes([]);
        setMessage(`Загружен файл «${file.name}»: найдено ${promptCount} промптов сцен.`);
      } else {
        setScript(content);
        const voiceWords = content.split(/\s+/).filter(Boolean).length;
        applyTargetDuration((voiceWords / POPULAR_VOICE_WPM) * 60);
        setScenes([]);
        setMessage(`Загружен текст озвучки «${file.name}»: ${voiceWords} слов, примерно ${clock((voiceWords / POPULAR_VOICE_WPM) * 60)}.`);
      }
    };
    reader.onerror = () => setMessage("Не удалось прочитать выбранный файл.");
    reader.readAsText(file);
    event.target.value = "";
  }

  async function requestVoiceTrack(list: string[], text: string, desiredSeconds = 0, previousSeconds = 0) {
    if (voice === QWEN_LOCAL_CLONE_ID) {
      const response = await fetch("/api/voicebox", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          profileId: QWEN_LOCAL_PROFILE_ID,
          text: applyRussianVoiceStresses(text),
        }),
      });
      if (!response.ok) {
        const result = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(result.error || `Voicebox: ${response.status}`);
      }
      const audio = await response.blob();
      if (!audio.size) throw new Error("Voicebox вернул пустой WAV");
      const rawFile = new File([audio], "qwen-local-youtube-clone.wav", { type: audio.type || "audio/wav" });
      return VOICE_TEMPO === 1 ? rawFile : slowVoiceFile(rawFile);
    }
    if (voice === QWEN_CLOUD_CLONE_ID) {
      const cleanFalKey = falKey.trim();
      if (!cleanFalKey) throw new Error("Вставь Fal.ai API key под выбором голоса.");
      let embeddingUrl = localStorage.getItem(QWEN_EMBEDDING_STORAGE_KEY) || "";
      if (!embeddingUrl) {
        setMessage("Один раз создаю облачный отпечаток эталонного голоса…");
        const referenceResponse = await fetch(QWEN_REFERENCE_FILE);
        if (!referenceResponse.ok) throw new Error("Не нашёл очищенный WAV-образец голоса");
        const referenceType = referenceResponse.headers.get("content-type") || "audio/wav";
        const audioDataUrl = `data:${referenceType};base64,${bytesToBase64(await referenceResponse.arrayBuffer())}`;
        const cloneResponse = await fetch("/api/fal-voice", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "clone", apiKey: cleanFalKey, audioDataUrl, referenceText: QWEN_REFERENCE_TEXT }),
        });
        const cloneResult = await cloneResponse.json() as { embeddingUrl?: string; error?: string };
        if (!cloneResponse.ok || !cloneResult.embeddingUrl) throw new Error(cloneResult.error || "Облачный Qwen не создал отпечаток голоса");
        embeddingUrl = cloneResult.embeddingUrl;
        localStorage.setItem(QWEN_EMBEDDING_STORAGE_KEY, embeddingUrl);
      }

      const response = await fetch("/api/fal-voice", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "speak",
          apiKey: cleanFalKey,
          embeddingUrl,
          referenceText: QWEN_REFERENCE_TEXT,
          text: applyRussianVoiceStresses(text),
        }),
      });
      if (!response.ok) {
        const result = await response.json().catch(() => ({})) as { error?: string };
        if (/embedding|expired|not found/i.test(result.error || "")) localStorage.removeItem(QWEN_EMBEDDING_STORAGE_KEY);
        throw new Error(result.error || `Облачный Qwen: ${response.status}`);
      }
      const audio = await response.blob();
      if (!audio.size) throw new Error("Облачный Qwen вернул пустой звук");
      const rawFile = new File([audio], "qwen-cloud-youtube-clone.mp3", { type: audio.type || "audio/mpeg" });
      return VOICE_TEMPO === 1 ? rawFile : slowVoiceFile(rawFile);
    }
    let lastError = "Озвучка не создалась";
    const attempts = Math.min(5, list.length);
    for (let attempt = 0; attempt < attempts; attempt++) {
      let response: Response;
      try {
        response = await fetch("/api/tts", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ apiKey: takeNextKey(list), text, voice, direction: voiceDirection.replace(/\b(?:Achird|Charon|Gacrux|Schedar|Fenrir|Algieba)\b/g, voice), desiredSeconds, previousSeconds, engine: "gemini-2.5-pro" }),
        });
      } catch {
        lastError = "Сетевое соединение прервалось. Автоматически пробую следующий ключ…";
        continue;
      }
      if (response.ok) {
        try {
          const blob = await readVoiceResponse(response);
          if (!blob.size) throw new Error("Сервис вернул пустую аудиодорожку");
          const rawFile = new File([blob], `gemini-${voice.toLowerCase()}.wav`, { type: blob.type || "audio/wav" });
          return VOICE_TEMPO === 1 ? tightenLongVoicePauses(rawFile) : slowVoiceFile(rawFile);
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

  async function combineVoiceFiles(files: File[], sourceChunks: string[] = []) {
    if (files.length === 1) return files[0];
    const audioContext = new AudioContext({ sampleRate: 24000 });
    try {
      const buffers = await Promise.all(files.map((file) => file.arrayBuffer().then((data) => audioContext.decodeAudioData(data))));
      const sampleRate = buffers[0]?.sampleRate || 24000;
      const threshold = 0.0035;
      const ranges = buffers.map((buffer) => {
        let first = 0;
        let last = buffer.length - 1;
        const audibleAt = (sample: number) => {
          for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
            if (Math.abs(buffer.getChannelData(channel)[sample] || 0) >= threshold) return true;
          }
          return false;
        };
        while (first < last && !audibleAt(first)) first++;
        while (last > first && !audibleAt(last)) last--;
        return {
          start: Math.max(0, first - Math.round(sampleRate * 0.035)),
          end: Math.min(buffer.length, last + Math.round(sampleRate * 0.09)),
        };
      });
      const pauseLengths = buffers.slice(0, -1).map((_, index) => {
        const ending = sourceChunks[index]?.trim() || "";
        const semanticPause = /[?!…]$/.test(ending) ? 0.25 : /[.:;]$/.test(ending) ? 0.19 : 0.13;
        const naturalVariation = [0.00, 0.025, -0.015, 0.04, -0.025][index % 5];
        return Math.round(sampleRate * Math.max(0.1, semanticPause + naturalVariation));
      });
      const totalSamples = ranges.reduce((total, range) => total + Math.max(0, range.end - range.start), 0)
        + pauseLengths.reduce((total, length) => total + length, 0);
      const pcm = new Uint8Array(totalSamples * 2);
      const view = new DataView(pcm.buffer);
      let offset = 0;
      for (let bufferIndex = 0; bufferIndex < buffers.length; bufferIndex++) {
        const buffer = buffers[bufferIndex];
        const range = ranges[bufferIndex];
        for (let sample = range.start; sample < range.end; sample++) {
          let value = 0;
          for (let channel = 0; channel < buffer.numberOfChannels; channel++) value += buffer.getChannelData(channel)[sample] || 0;
          value = Math.max(-1, Math.min(1, value / Math.max(1, buffer.numberOfChannels)));
          view.setInt16(offset, value < 0 ? value * 0x8000 : value * 0x7fff, true);
          offset += 2;
        }
        if (bufferIndex < buffers.length - 1) offset += pauseLengths[bufferIndex] * 2;
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

  async function trimVoicePartToSpeech(file: File) {
    const audioContext = new AudioContext({ sampleRate: 24000 });
    try {
      const buffer = await audioContext.decodeAudioData(await file.arrayBuffer());
      const threshold = 0.004;
      let lastAudibleSample = buffer.length - 1;
      outer: for (; lastAudibleSample > 0; lastAudibleSample--) {
        for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
          if (Math.abs(buffer.getChannelData(channel)[lastAudibleSample] || 0) >= threshold) break outer;
        }
      }
      const sampleRate = buffer.sampleRate || 24000;
      const exactSamples = Math.min(buffer.length, lastAudibleSample + Math.round(sampleRate * 0.12));
      const pcm = new Uint8Array(exactSamples * 2);
      const view = new DataView(pcm.buffer);
      for (let sample = 0; sample < exactSamples; sample++) {
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

  async function requestLongVoiceTrack(
    list: string[],
    text: string,
    desiredSeconds: number,
    onProgress?: (completed: number, total: number) => void,
    onOpeningDuration?: (seconds: number) => void,
  ) {
    // Qwen receives coherent sentence groups. The local cache keeps every
    // finished group, so a long narration can resume after an interruption.
    const chunks = splitVoiceText(text, isQwenCloneVoice(voice) ? QWEN_REQUEST_CHARS : 220);
    const hasOpeningChunk = chunks[0]?.startsWith("«") && chunks[0].includes("»");
    let exactOpeningSeconds = 0;
    const files: File[] = [];
    for (let index = 0; index < chunks.length; index++) {
      const chunkWords = chunks[index].split(/\s+/).filter(Boolean).length;
      const isOpeningChunk = hasOpeningChunk && index === 0;
      // Short bridge sentences are naturally only a few seconds long. Requiring every
      // chunk to last at least eight seconds made valid clips (for example six words)
      // look truncated and stopped long narrations at the same chunk every time.
      const chunkSeconds = Math.max(isOpeningChunk ? 3 : 1.5, chunkWords / POPULAR_VOICE_WPM * 60);
      const cacheKey = `narrator-v32:${voice}:${VOICE_TEMPO}:${index}:${voiceDirection}:${chunks[index]}`;
      const storedKey = `voice-chunk:${shortHash(cacheKey)}`;
      let cached = voiceChunkCacheRef.current.get(cacheKey);
      if (!cached) {
        const savedChunk = await loadProjectBlob(storedKey).catch(() => null);
        if (savedChunk) {
          cached = new File([savedChunk], `gemini-${voice.toLowerCase()}-${index + 1}.wav`, { type: savedChunk.type || "audio/wav" });
          voiceChunkCacheRef.current.set(cacheKey, cached);
        }
      }
      if (cached) {
        if (isOpeningChunk) {
          exactOpeningSeconds = await measureAudio(cached);
          onOpeningDuration?.(exactOpeningSeconds);
        }
        files.push(cached);
        onProgress?.(index + 1, chunks.length);
        continue;
      }
      const requestedSeconds = chunkSeconds;
      let part = await requestVoiceTrack(list, chunks[index], requestedSeconds);
      let partDuration = await measureAudio(part);
      if (voice !== "Gacrux" && !isQwenCloneVoice(voice) && (partDuration < chunkSeconds * 0.9 || partDuration > chunkSeconds * 1.12)) {
        const retry = await requestVoiceTrack(list, chunks[index], requestedSeconds, partDuration);
        const retryDuration = await measureAudio(retry);
        if (Math.abs(retryDuration - chunkSeconds) < Math.abs(partDuration - chunkSeconds)) {
          part = retry;
          partDuration = retryDuration;
        }
      }
      if (partDuration < chunkSeconds * 0.45) throw new Error(`Gemini не дочитала часть ${index + 1}. Нажми «Продолжить озвучку» — готовые части сохранятся.`);
      if (isOpeningChunk) {
        part = await trimVoicePartToSpeech(part);
        exactOpeningSeconds = await measureAudio(part);
        onOpeningDuration?.(exactOpeningSeconds);
      }
      voiceChunkCacheRef.current.set(cacheKey, part);
      await saveProjectBlob(storedKey, part)
        .then(() => setCheckpointStatus(`Автосохранение озвучки: часть ${index + 1} из ${chunks.length}`))
        .catch((error: unknown) => setCheckpointStatus(error instanceof Error ? `Часть озвучки не сохранилась: ${error.message}` : "Часть озвучки не сохранилась"));
      files.push(part);
      onProgress?.(index + 1, chunks.length);
    }
    const combined = await combineVoiceFiles(files, chunks);
    if (fitVoiceToVideo && desiredSeconds > 0) {
      setMessage(`Подгоняю готовую озвучку точно под ${clock(desiredSeconds)} без изменения тембра…`);
      return fitVoiceFileToDuration(combined, desiredSeconds);
    }
    return combined;
  }

  async function generateVoice() {
    const list = keyList();
    if (!list.length && !isQwenCloneVoice(voice)) { setShowKeys(true); return; }
    if (!script.trim()) { setMessage("Снача вставь сценарий — именно его сайт озвучит."); return; }
    setIsGeneratingVoice(true);
    setVoiceError("");
    const voiceScript = voiceTextForScript(script, aspect === "9:16");
    const voicePartCount = splitVoiceText(voiceScript, isQwenCloneVoice(voice) ? QWEN_REQUEST_CHARS : 220).length;
    setMessage(voice === QWEN_LOCAL_CLONE_ID
      ? `Локальный Qwen создаёт голос бесплатно: 0 из ${voicePartCount}. Готовые части сохраняются автоматически.`
      : voice === QWEN_CLOUD_CLONE_ID
      ? `Облачный Qwen создаёт тот же голос: 0 из ${voicePartCount}. Готовые части сохраняются автоматически.`
      : `Gemini 2.5 Pro создаёт озвучку повышенного качества: 0 из ${voicePartCount}. Не закрывай страницу.`);
    try {
      await attachAudio(await requestLongVoiceTrack(
        list,
        voiceScript,
        targetDuration,
        (completed, total) => setMessage(`Создаю озвучку: часть ${completed} из ${total}…`),
        undefined,
      ), { preserveScenes: true, source: "generated", includesShortsOutro: aspect === "9:16" });
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
    if (!list.length && !isQwenCloneVoice(voice)) { setShowKeys(true); return; }
    setIsGeneratingVoicePreview(true);
    setVoiceError("");
    setMessage(voice === QWEN_LOCAL_CLONE_ID ? "Локальный Qwen бесплатно создаёт пример точного клона…" : voice === QWEN_CLOUD_CLONE_ID ? "Облачный Qwen создаёт пример точного клона…" : "Gemini создаёт чистый пример без обработки скорости…");
    try {
      const blob = (await requestVoiceTrack(list, VOICE_PREVIEW_TEXT, 8)).slice();
      if (voicePreviewUrl) URL.revokeObjectURL(voicePreviewUrl);
      const url = URL.createObjectURL(blob);
      setVoicePreviewUrl(url);
      setMessage(voice === QWEN_LOCAL_CLONE_ID ? "Пример локального клона Qwen готов." : voice === QWEN_CLOUD_CLONE_ID ? "Пример облачного клона Qwen готов." : `Новый пример Gemini ${voice} готов. Если он не запустился сам, нажми ▶.`);
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
    const checkpointId = checkpointIdRef.current;
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
      await saveSceneImage(checkpointId, scene.id, result.image).then(() => {
        setCheckpointStatus(`Кадр ${scene.id} сохранён автоматически`);
      }).catch((error: unknown) => {
        setCheckpointStatus(error instanceof Error ? `Кадр ${scene.id} не сохранился: ${error.message}` : `Кадр ${scene.id} не сохранился`);
      });
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
      activeScenes = splitIntoScenes(script, frameCount, estimatedDuration, style, direction, aspect, openingSeconds);
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
      ? `Собираю лонг MP4: 1080p · ${durationOverride <= 5 * 60 ? 60 : 30} FPS · плавное покачивание ±2,5° · мягкие переходы…`
      : "Собираю Shorts MP4 без наклона кадров, с озвучкой…");
    try {
      const landscapeSize = quality === "1K" ? [1280, 720] : quality === "4K" ? [2560, 1440] : [1920, 1080];
      const width = aspect === "9:16" ? landscapeSize[1] : landscapeSize[0];
      const height = aspect === "9:16" ? landscapeSize[0] : landscapeSize[1];
      const duration = videoScenes.at(-1)?.end || durationOverride;
      // Static illustrations remain smooth at 30 FPS, while halving the work for long videos.
      // Keep 60 FPS for short long-form tests only.
      const fps = aspect === "16:9" && duration <= 5 * 60 ? 60 : 30;
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
      const openingQuote = aspect === "16:9"
        ? extractOpeningQuote(script) || extractOpeningQuote(videoScenes[0]?.text || "")
        : null;

      // A 30-minute 1080p render can be several gigabytes. Keeping the whole MP4 in
      // BufferTarget crashes the browser, so long renders stream into origin-private
      // disk storage and are exposed as a Blob only after finalization.
      const canStreamToDisk = duration > 5 * 60 && typeof navigator.storage?.getDirectory === "function";
      let bufferTarget: BufferTarget | null = null;
      let diskFileHandle: FileSystemFileHandle | null = null;
      let outputTarget: BufferTarget | StreamTarget;
      if (canStreamToDisk) {
        const storageRoot = await navigator.storage.getDirectory();
        diskFileHandle = await storageRoot.getFileHandle("cineframe-render-working.mp4", { create: true });
        const writable = await diskFileHandle.createWritable({ keepExistingData: false });
        outputTarget = new StreamTarget(writable as unknown as WritableStream<StreamTargetChunk>, { chunked: true, chunkSize: 8 * 1024 * 1024 });
      } else {
        bufferTarget = new BufferTarget();
        outputTarget = bufferTarget;
      }
      const output = new Output({
        format: new Mp4OutputFormat({ fastStart: canStreamToDisk ? "fragmented" : "in-memory" }),
        target: outputTarget,
      });
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
        let peak = 0;
        let squares = 0;
        let samples = 0;
        for (let channel = 0; channel < decodedAudio.numberOfChannels; channel++) {
          const data = decodedAudio.getChannelData(channel);
          for (let index = 0; index < data.length; index += 16) {
            const value = data[index] || 0;
            peak = Math.max(peak, Math.abs(value));
            squares += value * value;
            samples++;
          }
        }
        const rms = Math.sqrt(squares / Math.max(1, samples));
        const masterGain = Math.max(0.5, Math.min(2.5, 0.12 / Math.max(0.0001, rms), 0.94 / Math.max(0.0001, peak)));
        // Gemini narration is mono, usually 24 kHz. Rendering it as 48 kHz stereo
        // multiplied memory use by roughly four without improving spoken audio.
        const masterRate = decodedAudio.sampleRate || 24000;
        const masterLength = Math.max(1, Math.round(duration * masterRate));
        const offline = new OfflineAudioContext(1, masterLength, masterRate);
        const source = offline.createBufferSource();
        const gain = offline.createGain();
        source.buffer = decodedAudio;
        gain.gain.value = masterGain;
        source.connect(gain).connect(offline.destination);
        source.start(0);
        decodedAudio = await offline.startRendering();
        audioSource = new AudioBufferSource({ codec: "aac", quality: new Quality("high") });
        output.addAudioTrack(audioSource);
      }

      await output.start();
      if (audioSource && decodedAudio) await audioSource.add(decodedAudio);

      const drawCover = (image: HTMLImageElement, progress: number, alpha = 1) => {
        const base = Math.max(width / image.naturalWidth, height / image.naturalHeight);
        const isLongForm = aspect === "16:9";
        const scale = base * (isLongForm ? 1.08 : 1);
        const drawnWidth = image.naturalWidth * scale;
        const drawnHeight = image.naturalHeight * scale;
        const eased = 0.5 - Math.cos(Math.PI * progress) / 2;
        const rotation = isLongForm ? (2.5 - eased * 5) * Math.PI / 180 : 0;
        context.save();
        context.globalAlpha = alpha;
        context.translate(width / 2, height / 2);
        context.rotate(rotation);
        context.drawImage(image, -drawnWidth / 2, -drawnHeight / 2, drawnWidth, drawnHeight);
        context.restore();
      };

      const drawOpeningQuote = (timestamp: number) => {
        if (!openingQuote) return;
        const quoteDuration = Math.min(videoScenes[0]?.end || openingQuoteDuration || estimateOpeningQuoteDuration(script), duration);
        if (timestamp >= quoteDuration) return;
        const smooth = (value: number) => {
          const clamped = Math.max(0, Math.min(1, value));
          return clamped * clamped * (3 - 2 * clamped);
        };
        const fadeOut = smooth((quoteDuration - timestamp) / 0.45);
        const entrance = smooth(timestamp / 0.75);
        const maxTextWidth = width * 0.72;
        const quoteText = openingQuote.quote.replace(/^«|»$/g, "").trim();
        const fontSize = quoteText.length > 180 ? 29 : quoteText.length > 115 ? 34 : 40;

        context.save();
        context.globalAlpha = fadeOut * (0.45 + entrance * 0.55);
        const shade = context.createRadialGradient(width / 2, height / 2, width * 0.08, width / 2, height / 2, width * 0.62);
        shade.addColorStop(0, "rgba(4, 7, 9, 0.52)");
        shade.addColorStop(1, "rgba(3, 5, 7, 0.84)");
        context.fillStyle = shade;
        context.fillRect(0, 0, width, height);

        context.translate(width / 2, height / 2 + (1 - entrance) * 18);
        const quoteScale = 0.975 + entrance * 0.025;
        context.scale(quoteScale, quoteScale);
        context.strokeStyle = "rgba(218, 172, 92, 0.92)";
        context.lineWidth = 2;
        context.beginPath();
        context.moveTo(-110 * entrance, -150);
        context.lineTo(110 * entrance, -150);
        context.stroke();

        context.font = `italic ${fontSize}px Georgia, serif`;
        context.textAlign = "center";
        context.textBaseline = "middle";
        const words = quoteText.split(/\s+/);
        const lines: string[] = [];
        let current = "";
        for (const word of words) {
          const candidate = current ? `${current} ${word}` : word;
          if (current && context.measureText(candidate).width > maxTextWidth) {
            lines.push(current);
            current = word;
          } else current = candidate;
        }
        if (current) lines.push(current);
        const lineHeight = fontSize * 1.28;
        const textTop = -(lines.length - 1) * lineHeight / 2 - 12;
        context.shadowColor = "rgba(0, 0, 0, 0.8)";
        context.shadowBlur = 14;
        context.fillStyle = "#f4efe5";
        lines.forEach((line, index) => {
          const decorated = lines.length === 1 ? `«${line}»` : index === 0 ? `«${line}` : index === lines.length - 1 ? `${line}»` : line;
          const lineProgress = smooth((timestamp - 0.12 - index * 0.16) / 0.52);
          context.save();
          context.globalAlpha *= lineProgress;
          context.translate(0, (1 - lineProgress) * 16);
          context.filter = `blur(${(1 - lineProgress) * 5}px)`;
          context.fillText(decorated, 0, textTop + index * lineHeight);
          context.restore();
        });
        context.shadowBlur = 0;
        context.font = "italic 22px Georgia, serif";
        context.fillStyle = "#d7ad68";
        const authorProgress = smooth((timestamp - 0.38 - lines.length * 0.16) / 0.55);
        context.globalAlpha *= authorProgress;
        context.translate(0, (1 - authorProgress) * 10);
        context.fillText(openingQuote.author, 0, textTop + lines.length * lineHeight + 34);
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
        const remaining = scene.end - timestamp;
        if (sceneIndex < videoScenes.length - 1 && remaining <= CROSSFADE_SECONDS) {
          const rawTransition = (CROSSFADE_SECONDS - Math.max(0, remaining)) / CROSSFADE_SECONDS;
          const transition = rawTransition * rawTransition * (3 - 2 * rawTransition);
          drawCover(images[sceneIndex + 1], transition * 0.06, transition);
        }
        await videoSource.add(timestamp, frameDuration, { keyFrame: frame % (fps * 2) === 0 });
        if (frame % fps === 0 || frame === totalFrames - 1) {
          const progress = (frame + 1) / totalFrames;
          setRenderProgress(progress);
          setPipelineProgress(80 + progress * 19);
        }
      }

      await output.finalize();
      let renderedVideo: Blob;
      if (diskFileHandle) {
        const diskFile = await diskFileHandle.getFile();
        if (!diskFile.size) throw new Error("Временный MP4 на диске оказался пустым");
        renderedVideo = diskFile.slice(0, diskFile.size, "video/mp4");
      } else {
        if (!bufferTarget?.buffer) throw new Error("Не удалось получить готовый MP4");
        renderedVideo = new Blob([bufferTarget.buffer], { type: "video/mp4" });
      }
      if (videoUrl) URL.revokeObjectURL(videoUrl);
      await saveProjectBlob("video", renderedVideo)
        .then(() => setCheckpointStatus("Готовый MP4 сохранён автоматически"))
        .catch((error: unknown) => setCheckpointStatus(error instanceof Error ? `MP4 не сохранился: ${error.message}` : "MP4 не сохранился"));
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
        openingQuote: null,
        openingQuoteDuration: 0,
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
    if (videoUrl) URL.revokeObjectURL(videoUrl);
    setVideoUrl("");
    setVideoBlob(null);
    void deleteProjectBlob("video");
    setPipelineProgress(2);
    setPipelineStage("voice");
    const voiceScript = voiceTextForScript(script, aspect === "9:16");
    setPipelineLabel(`Создаю озвучку: 0 из ${splitVoiceText(voiceScript, isQwenCloneVoice(voice) ? QWEN_REQUEST_CHARS : 220).length} частей…`);
    setVoiceError("");
    try {
      const hasOpeningQuote = false;
      const savedVoiceIsOutdated = Boolean(audioFile && audioSource === "generated" && (
        (aspect === "9:16" && !audioIncludesShortsOutro)
        || (hasOpeningQuote && !openingQuoteDuration)
      ));
      let soundtrack = savedVoiceIsOutdated ? null : audioFile;
      let duration = audioDuration;
      let exactOpeningDuration = openingQuoteDuration;
      if (savedVoiceIsOutdated) {
        setPipelineLabel(hasOpeningQuote ? "Обновляю озвучку для точной синхронизации цитаты…" : "Обновляю старую озвучку и добавляю переход на основной канал…");
        setMessage(hasOpeningQuote ? "Пересоздаю старую озвучку, чтобы первый кадр совпал с голосом цитаты." : "Старая озвучка была создана без фирменной фразы. Пересоздаю её автоматически.");
      }
      if (!soundtrack) {
        soundtrack = await requestLongVoiceTrack(list, voiceScript, targetDuration, (completed, total) => {
          setPipelineProgress(2 + (completed / total) * 16);
          setPipelineLabel(`Создаю озвучку: часть ${completed} из ${total}`);
        }, hasOpeningQuote ? (seconds) => {
          exactOpeningDuration = seconds;
          setOpeningQuoteDuration(seconds);
        } : undefined);
        duration = await measureAudio(soundtrack);
        if (!isQwenCloneVoice(voice) && splitVoiceText(voiceScript, 220).length === 1 && (duration < targetDuration * 0.85 || duration > targetDuration * 1.15)) {
          setPipelineLabel(`Корректирую темп озвучки: было ${clock(duration)}, нужно ${clock(targetDuration)}…`);
          soundtrack = await requestVoiceTrack(list, voiceScript, targetDuration, duration);
          duration = await measureAudio(soundtrack);
        }
        await attachAudio(soundtrack, { preserveScenes: true, source: "generated", includesShortsOutro: aspect === "9:16" });
      }
      duration = Math.max(30, duration || targetDuration);
      if (Math.abs(duration - targetDuration) > 1) {
        setTargetDuration(Math.round(duration));
        setDurationMinutesInput(String(Number((duration / 60).toFixed(2))));
      }
      const planOpeningSeconds = aspect === "16:9" ? LONG_OPENING_HOOK_SECONDS : 0;
      const planFrameCount = frameCountForDuration(duration, planOpeningSeconds);
      setPipelineProgress(20);
      setPipelineStage("frames");
      setPipelineLabel(`Создаю ${planFrameCount} кадров в закреплённом стиле канала…`);
      const reusablePlan = scenes.length === planFrameCount
        && Math.abs((scenes.at(-1)?.end || 0) - duration) < 1
        && (planOpeningSeconds <= 0 || Math.abs((scenes[0]?.end || 0) - planOpeningSeconds) < 0.05)
        && scenes.slice(planOpeningSeconds > 0 ? 1 : 0, -1).every((scene) => Math.abs(scene.end - scene.start - SCENE_SECONDS) < 0.05)
        && scenes.every((scene, index) => scene.id === index + 1);
      const plan = reusablePlan ? scenes : splitIntoScenes(script, planFrameCount, duration, style, direction, aspect, planOpeningSeconds);
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

  async function renderWithoutNarration() {
    if (!scenes.length || scenes.some((scene) => !scene.image)) {
      setMessage("Без озвучки можно собрать ролик, когда готовы все кадры.");
      return;
    }
    setPipelineStage("render");
    setPipelineProgress(80);
    setPipelineLabel("Собираю MP4 без голоса…");
    setVoiceError("");
    const rendered = await renderVideo(scenes, null, targetDuration);
    if (rendered) {
      setPipelineProgress(100);
      setPipelineStage("done");
      setPipelineLabel("MP4 без голоса готов");
    } else {
      setPipelineStage("error");
      setPipelineLabel("Не удалось собрать MP4 без голоса");
    }
  }

  const pipelineRunning = pipelineStage === "voice" || pipelineStage === "frames" || pipelineStage === "render";
  const projectLocked = pipelineRunning || isGenerating || isGeneratingVoice || isRendering;
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
          <label className="textFileImport"><input type="file" accept=".txt,.md,text/plain,text/markdown" onChange={importTextFile} disabled={projectLocked} /><b>Загрузить файл с компьютера</b><span>TXT с озвучкой, промптами или готовым проектом</span></label>
          <textarea className="mainScript" value={script} onChange={(e) => { void invalidateGeneratedProject(); setScript(e.target.value); }} placeholder="Вставь сюда полный текст ролика…" autoFocus disabled={projectLocked} />
          <div className="scriptMeta"><span>{wordCount} слов</span><span>План: {clock(estimatedDuration)}</span></div>
          <div className="quoteHint">Начинай сразу с сильного хука: конфликт, неприятная правда или обещание результата. Отдельной цитаты и долгой заставки не будет.</div>
          <label className="scenePromptBlock"><span>Промпт сцен и видео</span><textarea value={direction} onChange={(e) => { void invalidateGeneratedProject(); setDirection(e.target.value); }} placeholder={"Напиши сцены отдельными строками:\n1. A thoughtful man standing in a vast library...\n2. The same man studying several documents...\n3. ..."} disabled={projectLocked} /><small>{aspect === "16:9" ? "Первый кадр — отдельный сильный хук на 20 секунд;" : "Каждый кадр — 10 секунд;"} затем кадры по 10 секунд. Без отдельной цитаты. Нужно примерно {frameCount} строк. Стиль добавляется автоматически; этот текст не озвучивается.</small></label>
        </div>

        <div className="quickDivider" />

        <div className="quickStep">
          <div className="quickTitle"><b>2</b><div><h2>Озвучка</h2><p>Выбери голос и нажми большую кнопку. Он прочитает текст сверху.</p></div></div>
          <div className="simpleVoiceRow">
            <label>Голос<select value={voice} onChange={(e) => { void selectNarrator(e.target.value); }} disabled={projectLocked}>{VOICES.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select><small>Gemini 2.5 Pro · спокойная человеческая подача без глубокого дикторского тона</small></label>
            {voice === QWEN_CLOUD_CLONE_ID && <label>Fal.ai API key<input type="password" value={falKey} onChange={(e) => { const value = e.target.value.trim(); setFalKey(value); localStorage.setItem("cineframe_fal_key", value); }} placeholder="Вставь ключ Fal.ai" autoComplete="off" disabled={projectLocked} /><small>Хранится только в этом браузере и отправляется через защищённый маршрут сайта.</small></label>}
            <button className="previewButton" onClick={previewVoice} disabled={isGeneratingVoicePreview || isGeneratingVoice}>{isGeneratingVoicePreview ? "Создаю пример…" : "▶ Пример голоса"}</button>
            <button className="createVoiceButton" onClick={generateVoice} disabled={isGeneratingVoicePreview || isGeneratingVoice}>{isGeneratingVoice ? "Озвучиваю текст…" : "Создать озвучку текста"}</button>
          </div>
          <div className={`voiceResult ${isGeneratingVoicePreview || isGeneratingVoice ? "working" : voiceError ? "error" : voicePreviewUrl ? "ready" : ""}`}>
            {isGeneratingVoicePreview ? <><b><i /> Создаю короткий пример…</b><small>Плеер появится здесь.</small></> : isGeneratingVoice ? <><b><i /> Озвучиваю весь текст сверху…</b><small>Не закрывай страницу.</small></> : voiceError ? <><b>Озвучка остановилась</b><small>{voiceError}</small>{voiceError.includes("current location") && <em>Включи VPN с поддерживаемой страной.</em>}{voiceError.includes("403") && <em>Переключи VPN на другой сервер и попробуй снова.</em>}<button className="retryVoiceInline" onClick={generateVoice}>Продолжить озвучку</button></> : voicePreviewUrl ? <><b>✓ Пример {voice}</b><audio className="voicePreview" ref={voicePreviewRef} src={voicePreviewUrl} controls /></> : <><b>Пример появится здесь</b><small>Кнопка «Пример голоса» читает короткую тестовую фразу.</small></>}
          </div>
          {audioUrl && <div className="mainAudio"><div><b>✓ Озвучка ролика готова</b><small>{clock(audioDuration)} · {audioName}{audioIncludesShortsOutro ? " · переход на основной канал добавлен" : ""}</small><a href={audioUrl} download="cineframe-full-voice.wav">Скачать полную WAV</a></div><audio ref={audioRef} src={audioUrl} controls onTimeUpdate={(e) => setPlayhead(e.currentTarget.currentTime)} /></div>}
          <label className={`compactUpload ${audioName ? "filled" : ""}`}><input type="file" accept="audio/*" onChange={handleAudio} disabled={projectLocked} /><span>Или загрузить свою MP3 / WAV</span></label>
          <label className={`compactUpload ${fitVoiceToVideo ? "filled" : ""}`}><input type="file" accept="video/mp4,video/*" onChange={handleReferenceVideo} disabled={projectLocked} /><span>{fitVoiceToVideo ? `✓ Подгонка под ${referenceVideoName} · ${clock(targetDuration)}` : "Подогнать новую озвучку под готовый MP4"}</span></label>
        </div>

        <div className="quickDivider" />

        <div className="quickStep">
          <div className="quickTitle"><b>3</b><div><h2>Параметры видео</h2><p>Только три главные настройки.</p></div></div>
          <div className="bigControls">
            <label>Длительность, минут<input type="text" inputMode="decimal" value={durationMinutesInput} onChange={(e) => changeDurationMinutes(e.target.value)} onBlur={() => { const minutes = Number(durationMinutesInput.replace(",", ".")); if (!Number.isFinite(minutes) || minutes < 0.5) applyTargetDuration(targetDuration); }} placeholder="Например, 45" disabled={projectLocked} /><small>{audioDuration ? `Озвучка ${clock(audioDuration)} · видео ${clock(targetDuration)}` : "Можно написать 45, 60, 90… без лимита"}</small></label>
            <label>Смена кадра<div className="staticControl">{aspect === "16:9" ? "Хук 20 сек, затем по 10" : "Каждые 10 секунд"}</div><small>Мягкий переход 0,35 сек · {frameCount} сцен на {clock(targetDuration)}</small></label>
            <label>Формат<select value={aspect} onChange={(e) => { void invalidateGeneratedProject(); setAspect(e.target.value); }} disabled={projectLocked}><option value="16:9">16:9 · YouTube</option><option value="9:16">9:16 · Shorts</option></select><small>{aspect === "9:16" ? "Вертикальное видео" : "Горизонтальное видео"}</small></label>
          </div>
          <div className="quickOptions"><strong>{aspect === "16:9" ? "Лонги: плавная анимация +2,5° → −2,5°" : "Shorts: кадры без наклона"}</strong><span>{aspect === "16:9" ? `1080p · ${targetDuration <= 5 * 60 ? 60 : 30} FPS · задумчивый хук с первой секунды · без субтитров` : "Фирменная фраза в конце · без субтитров"}</span></div>
          <details className="advanced"><summary>Дополнительные настройки</summary><label>Качество<select value={quality} onChange={(e) => { void invalidateGeneratedProject(); setQuality(e.target.value); }} disabled={projectLocked}><option>1K</option><option>2K</option><option>4K</option></select></label><label>Манера речи<textarea value={voiceDirection} onChange={(e) => { void invalidateGeneratedProject(); setVoiceDirection(e.target.value); }} disabled={projectLocked} /></label><div className="lockedStyle"><b>Новый живописный стиль канала закреплён</b><small>Thick oil brushwork · teal shadows · crimson rain glow · soft human detail</small></div></details>
          <button className="createFramesButton wholeVideoButton" onClick={createWholeVideo} disabled={pipelineRunning || !script.trim()}>{pipelineRunning ? pipelineLabel : scenes.length || audioFile ? "ПРОДОЛЖИТЬ СОХРАНЁННЫЙ ПРОЕКТ" : "СОЗДАТЬ ГОТОВОЕ ВИДЕО"}</button>
          <div className="autosaveStatus"><i /> <span>{checkpointStatus}</span><small>Кадры, озвучка, прогресс и MP4 сохраняются в этом браузере.</small></div>
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
        <div><p>ТЕСТ ДВИЖЕНИЯ ДЛЯ ЛОНГОВ</p><h2>Вот так кадры 16:9 будут качаться в CapCut</h2><span>Каждая фотография очень плавно идёт от +2,5° к −2,5°. В Shorts 9:16 наклон отключён.</span></div>
        <video src="/capcut-sway-demo.mp4" controls loop muted playsInline preload="metadata" />
      </section>

      <section className="storyboard card quickStoryboard">
        <div className="storyHead"><div><h2>Готовое видео</h2><p>{videoUrl ? `${clock(estimatedDuration)} · ${aspect} · озвучка и анимированные кадры` : pipelineRunning ? pipelineLabel : "Здесь появится один собранный ролик"}</p></div>{videoUrl && <div className="storyActions"><a className="downloadVideo downloadReady" href={videoUrl} download="cineframe-video.mp4">Скачать MP4</a></div>}</div>
        {message && <div className="notice">{message}</div>}
        {videoUrl ? <div className={`finalVideoCard ${aspect === "9:16" ? "vertical" : ""}`}><video src={videoUrl} controls playsInline /><div><b>✓ Ролик собран целиком</b><span>Кадры и тайминг готовы. При необходимости можно убрать голос, не удаляя кадры.</span><button className="capcutButton" onClick={exportToCapCut} disabled={isExportingCapCut}>{isExportingCapCut ? "ДОБАВЛЯЮ В CAPCUT…" : "ДОБАВИТЬ ПРОЕКТ В CAPCUT"}</button><button className="plain" onClick={renderWithoutNarration} disabled={pipelineRunning || done !== scenes.length}>СОБРАТЬ MP4 БЕЗ ГОЛОСА</button><small className="capcutHint">Каждая фотография будет отдельным клипом на таймлайне.</small>{capCutMessage && <em className={`capcutStatus ${capCutMessage.startsWith("Не ") ? "error" : ""}`}>{capCutMessage}</em>}</div></div> : <div className="compactEmpty"><span>{pipelineRunning ? `${Math.round(pipelineProgress)}%` : "Видео пока нет"}</span><p>{pipelineRunning ? pipelineLabel : "Вставь текст и промпты сцен, затем нажми «Создать готовое видео»."}</p></div>}
        {scenes.length > 0 && <details className="framesEditor"><summary>Исправить отдельные кадры ({done}/{scenes.length})</summary><div className="framesEditorBody"><div className="framesEditorActions"><span>Открывай это только если нужно заменить конкретную картинку.</span><button className="plain" onClick={() => generateAll() } disabled={isGenerating || pipelineRunning}>Повторить незавершённые</button><button className="plain" onClick={() => renderVideo()} disabled={isRendering || isGenerating || done !== scenes.length}>Пересобрать с голосом</button><button className="plain" onClick={renderWithoutNarration} disabled={pipelineRunning || done !== scenes.length}>Собрать без голоса</button></div><div className="workarea"><div className="sceneGrid">{scenes.map((scene) => <button key={scene.id} onClick={() => setSelectedId(scene.id)} className={`shot ${scene.id === selectedId ? "selected" : ""}`}><div className={`shotImage ${aspect === "9:16" ? "vertical" : ""}`}>{scene.image ? <img src={scene.image} alt={`Кадр ${scene.id}`} /> : <span>{scene.status === "working" ? "…" : String(scene.id).padStart(2,"0")}</span>}<i className={scene.status} /></div><small>{clock(scene.start)}–{clock(scene.end)}</small><p>{scene.text}</p>{scene.error && <em>{scene.error}</em>}</button>)}</div>{selected && <aside className="inspector"><div className={`preview ${aspect === "9:16" ? "vertical" : ""}`}>{selected.image ? <img src={selected.image} alt="Предпросмотр" /> : <div>Кадр {selected.id}</div>}</div><label>Текст кадра<textarea value={selected.text} onChange={(e) => setScenes((items) => items.map((item) => item.id === selected.id ? { ...item, text: e.target.value } : item))} /></label><label>Промпт изображения<textarea className="prompt" value={selected.prompt} onChange={(e) => setScenes((items) => items.map((item) => item.id === selected.id ? { ...item, prompt: e.target.value, status: "ready" } : item))} /></label><button className="generate one" onClick={() => { const list = keyList(); if (!list.length) setShowKeys(true); else void generateScene(selected, list); }}>Повторить этот кадр</button></aside>}</div></div></details>}
      </section>

      {showKeys && <div className="modal" onMouseDown={(e) => { if (e.target === e.currentTarget) setShowKeys(false); }}><div className="modalBox"><button className="close" onClick={() => setShowKeys(false)}>×</button><h2>Ключи Google AI</h2><p>Они используются и для кадров, и для озвучки. Каждый следующий запрос берёт следующий ключ по кругу. Ключи хранятся только в этом браузере.</p><label className="csvImport"><input type="file" accept=".csv,text/csv" onChange={importKeys} /><span>Импортировать CSV с ключами</span><small>{keyList().length ? `Сейчас сохранено: ${keyList().length}` : "Подойдёт gemini_api_keys_50_2026-07-31.csv"}</small></label><textarea value={keys} onChange={(e) => setKeys(e.target.value)} placeholder={"AIza...\nAIza..."} /><button className="primary" onClick={saveKeys}>Сохранить</button></div></div>}
    </main>
  );
}
