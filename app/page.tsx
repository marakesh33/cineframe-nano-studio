"use client";

import { ChangeEvent, useEffect, useMemo, useRef, useState } from "react";
import { AudioBufferSource, BufferTarget, CanvasSource, Mp4OutputFormat, Output, Quality, StreamTarget } from "mediabunny";

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

const DEFAULT_STYLE = "Dark hand-painted historical realism, Renaissance-era characters, dramatic chiaroscuro, cold blue-gray shadows, warm amber candlelight, cinematic composition, detailed oil-paint texture, serious psychological atmosphere, no text, no watermark.";

function clock(seconds: number) {
  const value = Math.max(0, Math.round(seconds));
  return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
}

function splitIntoScenes(text: string, count: number, duration: number, style: string, direction: string, aspect: string) {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const actualCount = Math.max(1, Math.min(count, Math.ceil(words.length / 5)));
  return Array.from({ length: actualCount }, (_, index): Scene => {
    const from = Math.floor((index * words.length) / actualCount);
    const to = Math.floor(((index + 1) * words.length) / actualCount);
    const fragment = words.slice(from, to).join(" ");
    const start = (index * duration) / actualCount;
    const end = ((index + 1) * duration) / actualCount;
    return {
      id: index + 1,
      start,
      end,
      text: fragment,
      prompt: `${style}\n\nOutput composition: ${aspect}.\nOverall story direction: ${direction || "Create a coherent visual narrative."}\nNarration for this exact shot: "${fragment}"\nShow one clear visual moment that expresses the meaning of this narration. Keep recurring characters, wardrobe, facial features, palette and lighting consistent with every other shot. Strong foreground subject, readable composition, natural anatomy. Do not include captions, letters, logos or watermarks.`,
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
  const [shotLength, setShotLength] = useState(12);
  const [quality, setQuality] = useState("1K");
  const [aspect, setAspect] = useState("16:9");
  const [subtitles, setSubtitles] = useState(true);
  const [scenes, setScenes] = useState<Scene[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [keys, setKeys] = useState("");
  const [showKeys, setShowKeys] = useState(false);
  const [message, setMessage] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [isRendering, setIsRendering] = useState(false);
  const [renderProgress, setRenderProgress] = useState(0);
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playhead, setPlayhead] = useState(0);

  useEffect(() => {
    setKeys(localStorage.getItem("cineframe_google_keys") || "");
  }, []);

  const wordCount = useMemo(() => script.trim().split(/\s+/).filter(Boolean).length, [script]);
  const estimatedDuration = Math.max(1, audioDuration || (wordCount / 130) * 60);
  const expectedScenes = Math.max(1, Math.ceil(estimatedDuration / shotLength));
  const selected = scenes.find((scene) => scene.id === selectedId) || null;
  const currentScene = scenes.find((scene) => playhead >= scene.start && playhead < scene.end) || selected || scenes[0];
  const done = scenes.filter((scene) => scene.status === "done").length;

  function handleAudio(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    const url = URL.createObjectURL(file);
    const probe = new Audio(url);
    probe.onloadedmetadata = () => setAudioDuration(probe.duration || 0);
    setAudioName(file.name);
    setAudioFile(file);
    setAudioUrl(url);
    setScenes([]);
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
    localStorage.setItem("cineframe_google_keys", keys.trim());
    setShowKeys(false);
    setMessage("Ключи сохранены только в этом браузере.");
  }

  async function generateScene(scene: Scene, key: string) {
    setScenes((items) => items.map((item) => item.id === scene.id ? { ...item, status: "working", error: undefined } : item));
    try {
      const response = await fetch("/api/nano", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ apiKey: key, prompt: scene.prompt, quality, aspectRatio: aspect }),
      });
      const result = await response.json() as { image?: string; error?: string };
      if (!response.ok || !result.image) throw new Error(result.error || `Google API: ${response.status}`);
      setScenes((items) => items.map((item) => item.id === scene.id ? { ...item, image: result.image, status: "done" } : item));
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Ошибка генерации";
      setScenes((items) => items.map((item) => item.id === scene.id ? { ...item, status: "error", error: reason } : item));
    }
  }

  async function generateAll() {
    const list = keys.split(/[\n,;]+/).map((item) => item.trim()).filter(Boolean);
    if (!list.length) { setShowKeys(true); return; }
    if (!scenes.length) { setMessage("Снача создай план кадров."); return; }
    setIsGenerating(true);
    setMessage("Генерация идёт напрямую через Nano Banana 2…");
    const queue = scenes.filter((scene) => scene.status !== "done");
    let cursor = 0;
    const worker = async (workerIndex: number) => {
      while (cursor < queue.length) {
        const index = cursor++;
        await generateScene(queue[index], list[(index + workerIndex) % list.length]);
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, queue.length) }, (_, index) => worker(index)));
    setIsGenerating(false);
    setMessage("Очередь завершена. Кадры с ошибкой можно повторить отдельно.");
  }

  function download(name: string, body: string, type: string) {
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([body], { type }));
    link.download = name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }

  function exportProject() {
    const clean = scenes.map(({ image, ...scene }) => ({ ...scene, imageFile: image ? `scene-${String(scene.id).padStart(3, "0")}.jpg` : null }));
    download("cineframe-project.json", JSON.stringify({ direction, style, duration: estimatedDuration, aspect, subtitles, scenes: clean }, null, 2), "application/json");
  }

  function exportSrt() {
    const stamp = (value: number) => {
      const ms = Math.round(value * 1000);
      const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60, x = ms % 1000;
      return `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")},${String(x).padStart(3,"0")}`;
    };
    download("subtitles.srt", scenes.map((scene, index) => `${index + 1}\n${stamp(scene.start)} --> ${stamp(scene.end)}\n${scene.text}\n`).join("\n"), "text/plain;charset=utf-8");
  }

  async function renderVideo() {
    if (!scenes.length || scenes.some((scene) => !scene.image)) {
      setMessage("Снача создай все кадры. После этого сайт соберёт их в один MP4.");
      return;
    }
    if (!("VideoEncoder" in window)) {
      setMessage("Этот браузер не поддерживает быструю сборку MP4. Открой сайт в Chrome.");
      return;
    }
    setIsRendering(true);
    setRenderProgress(0);
    setMessage("Собираю единый MP4: движение камеры, переходы, озвучка и субтитры…");
    try {
      const width = aspect === "9:16" ? 720 : 1280;
      const height = aspect === "9:16" ? 1280 : 720;
      const fps = 24;
      const frameDuration = 1 / fps;
      const duration = scenes.at(-1)?.end || estimatedDuration;
      const totalFrames = Math.ceil(duration * fps);
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) throw new Error("Не удалось создать видеохолст");

      const images = await Promise.all(scenes.map((scene) => new Promise<HTMLImageElement>((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error(`Не загрузился кадр ${scene.id}`));
        image.src = scene.image!;
      })));

      const bufferTarget = new BufferTarget();
      let target: BufferTarget | StreamTarget = bufferTarget;
      const savePicker = (window as unknown as { showSaveFilePicker?: (options: Record<string, unknown>) => Promise<{ createWritable(): Promise<unknown> }> }).showSaveFilePicker;
      if (savePicker) {
        const handle = await savePicker({
          suggestedName: `cineframe-${aspect === "9:16" ? "shorts" : "video"}.mp4`,
          types: [{ description: "MP4 video", accept: { "video/mp4": [".mp4"] } }],
        });
        const writable = await handle.createWritable();
        target = new StreamTarget(writable as WritableStream<never>, { chunked: true });
      }

      const output = new Output({ format: new Mp4OutputFormat({ fastStart: "in-memory" }), target });
      const videoSource = new CanvasSource(canvas, { codec: "avc", quality: new Quality("high") });
      output.addVideoTrack(videoSource, { frameRate: fps });

      let audioSource: AudioBufferSource | null = null;
      let decodedAudio: AudioBuffer | null = null;
      if (audioFile) {
        const audioContext = new AudioContext();
        decodedAudio = await audioContext.decodeAudioData(await audioFile.arrayBuffer());
        await audioContext.close();
        audioSource = new AudioBufferSource({ codec: "aac", quality: new Quality("high") });
        output.addAudioTrack(audioSource);
      }

      await output.start();
      if (audioSource && decodedAudio) await audioSource.add(decodedAudio);

      const drawCover = (image: HTMLImageElement, progress: number, index: number, opacity = 1) => {
        const base = Math.max(width / image.naturalWidth, height / image.naturalHeight);
        const scale = base * (1.035 + progress * 0.055);
        const drawnWidth = image.naturalWidth * scale;
        const drawnHeight = image.naturalHeight * scale;
        const drift = (progress - 0.5) * width * 0.025 * (index % 2 ? 1 : -1);
        const x = (width - drawnWidth) / 2 + drift;
        const y = (height - drawnHeight) / 2 - (progress - 0.5) * height * 0.012;
        context.globalAlpha = opacity;
        context.drawImage(image, x, y, drawnWidth, drawnHeight);
        context.globalAlpha = 1;
      };

      const drawSubtitle = (text: string) => {
        const fontSize = aspect === "9:16" ? 38 : 36;
        context.font = `700 ${fontSize}px Arial`;
        context.textAlign = "center";
        context.textBaseline = "middle";
        const maxWidth = width * 0.82;
        const words = text.split(/\s+/);
        const lines: string[] = [];
        let line = "";
        for (const word of words) {
          const candidate = line ? `${line} ${word}` : word;
          if (context.measureText(candidate).width > maxWidth && line) { lines.push(line); line = word; }
          else line = candidate;
        }
        if (line) lines.push(line);
        const visible = lines.slice(0, 3);
        const startY = height - (aspect === "9:16" ? 150 : 72) - (visible.length - 1) * fontSize * 0.62;
        visible.forEach((item, index) => {
          const y = startY + index * fontSize * 1.18;
          context.lineJoin = "round";
          context.lineWidth = 9;
          context.strokeStyle = "rgba(0,0,0,.82)";
          context.strokeText(item, width / 2, y);
          context.fillStyle = "#fffdf5";
          context.fillText(item, width / 2, y);
        });
      };

      let sceneIndex = 0;
      for (let frame = 0; frame < totalFrames; frame++) {
        const timestamp = frame / fps;
        while (sceneIndex < scenes.length - 1 && timestamp >= scenes[sceneIndex].end) sceneIndex++;
        const scene = scenes[sceneIndex];
        const local = Math.max(0, Math.min(1, (timestamp - scene.start) / Math.max(0.001, scene.end - scene.start)));
        context.fillStyle = "#08090a";
        context.fillRect(0, 0, width, height);
        drawCover(images[sceneIndex], local, sceneIndex);
        if (local > 0.94 && sceneIndex < scenes.length - 1) {
          const fade = (local - 0.94) / 0.06;
          drawCover(images[sceneIndex + 1], 0, sceneIndex + 1, fade);
        }
        if (subtitles) drawSubtitle(scene.text);
        await videoSource.add(timestamp, frameDuration, { keyFrame: frame % (fps * 2) === 0 });
        if (frame % fps === 0 || frame === totalFrames - 1) setRenderProgress((frame + 1) / totalFrames);
      }

      await output.finalize();
      if (target === bufferTarget && bufferTarget.buffer) {
        const link = document.createElement("a");
        link.href = URL.createObjectURL(new Blob([bufferTarget.buffer], { type: "video/mp4" }));
        link.download = `cineframe-${aspect === "9:16" ? "shorts" : "video"}.mp4`;
        link.click();
        setTimeout(() => URL.revokeObjectURL(link.href), 5000);
      }
      setRenderProgress(1);
      setMessage(`Гото: один MP4 ${aspect} собран${audioFile ? " с твоей озвучкой" : " без озвучки"}.`);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") setMessage("Сохранение MP4 отменено.");
      else setMessage(error instanceof Error ? `Сборка не удалась: ${error.message}` : "Сборка MP4 не удалась");
    } finally {
      setIsRendering(false);
    }
  }

  return (
    <main>
      <header className="header">
        <div className="logo"><span>C</span><div><strong>CineFrame</strong><small>Nano Banana Studio</small></div></div>
        <div className="headerActions"><button className="plain" onClick={() => setShowKeys(true)}>Ключи Google</button><i /> <span>gemini-3.1-flash-image</span></div>
      </header>

      <section className="hero">
        <p>ДЛИННЫЙ ФОРМАТ · ДО 30 МИНУТ</p>
        <h1>Твой сценарий → готовый видеоряд</h1>
        <span>Сайт привязывает каждый кадр к тексту и точной длине твоей озвучки.</span>
      </section>

      <section className="editor">
        <div className="source card">
          <div className="cardTitle"><b>1</b><div><h2>Добавь материал</h2><p>Никаких готовых сцен — только твой текст.</p></div></div>
          <label>О чём должен быть ролик
            <input value={direction} onChange={(e) => setDirection(e.target.value)} placeholder="Например: психологическая история о денежных ошибках" />
          </label>
          <label>Сценарий
            <textarea value={script} onChange={(e) => { setScript(e.target.value); setScenes([]); }} placeholder="Вставь сюда свой полный сценарий…" />
            <small>{wordCount} слов · расчётная длина {clock(estimatedDuration)}</small>
          </label>
          <label className={`drop ${audioName ? "filled" : ""}`}>
            <input type="file" accept="audio/*" onChange={handleAudio} />
            <span>♪</span><div><strong>{audioName || "Загрузить озвучку"}</strong><small>{audioName ? `Точная длина: ${clock(audioDuration)}` : "MP3, WAV или M4A — голос не изменяется"}</small></div><em>{audioName ? "Заменить" : "Выбрать"}</em>
          </label>
        </div>

        <aside className="setup card">
          <div className="cardTitle compact"><b>2</b><div><h2>Настройки</h2><p>Один стиль для всего ролика.</p></div></div>
          <label>Визуальный стиль<textarea className="style" value={style} onChange={(e) => setStyle(e.target.value)} /></label>
          <div className="row"><label>Длина кадра<select value={shotLength} onChange={(e) => setShotLength(Number(e.target.value))}><option value={8}>8 сек</option><option value={12}>12 сек</option><option value={15}>15 сек</option><option value={20}>20 сек</option></select></label><label>Формат<select value={aspect} onChange={(e) => { setAspect(e.target.value); setScenes([]); }}><option value="16:9">16:9 · YouTube</option><option value="9:16">9:16 · Shorts</option></select></label><label>Качество<select value={quality} onChange={(e) => setQuality(e.target.value)}><option>1K</option><option>2K</option><option>4K</option></select></label></div>
          <button className="toggleLine" onClick={() => setSubtitles(!subtitles)}><span><strong>Субтитры</strong><small>Можно скачать SRT или отключить</small></span><i className={subtitles ? "on" : ""}><b /></i></button>
          <div className="numbers"><span><small>Длина</small><b>{clock(estimatedDuration)}</b></span><span><small>Кадров</small><b>{script ? expectedScenes : 0}</b></span><span><small>Формат</small><b>{aspect}</b></span></div>
          <button className="primary" onClick={buildPlan}>Создать план кадров <span>→</span></button>
        </aside>
      </section>

      <section className="storyboard card">
        <div className="storyHead"><div className="cardTitle compact"><b>3</b><div><h2>Видео</h2><p>{scenes.length ? `${done} из ${scenes.length} кадров готово · результат — один MP4` : "Появится после твоего сценария"}</p></div></div>{scenes.length > 0 && <div className="storyActions"><button className="plain" onClick={exportProject}>JSON</button>{subtitles && <button className="plain" onClick={exportSrt}>SRT</button>}<button className="generate" onClick={generateAll} disabled={isGenerating || isRendering}>{isGenerating ? `Nano Banana… ${done}/${scenes.length}` : "1. Создать кадры"}</button><button className="assemble" onClick={renderVideo} disabled={isRendering || isGenerating}>{isRendering ? `Сборка MP4… ${Math.round(renderProgress * 100)}%` : `2. Скачать MP4 ${aspect}`}</button></div>}</div>
        {message && <div className="notice">{message}</div>}
        {!scenes.length ? <div className="empty"><span>+</span><strong>Здесь пока пусто</strong><p>Вставь свой текс выше и нажми «Создать план». Сайт не добавляет чужие сцены.</p></div> : (
          <div className="workarea">
            <div className="sceneGrid">{scenes.map((scene) => <button key={scene.id} onClick={() => setSelectedId(scene.id)} className={`shot ${scene.id === selectedId ? "selected" : ""}`}><div className={`shotImage ${aspect === "9:16" ? "vertical" : ""}`}>{scene.image ? <img src={scene.image} alt={`Кадр ${scene.id}`} /> : <span>{scene.status === "working" ? "…" : String(scene.id).padStart(2,"0")}</span>}<i className={scene.status} /></div><small>{clock(scene.start)}–{clock(scene.end)}</small><p>{scene.text}</p>{scene.error && <em>{scene.error}</em>}</button>)}</div>
            {selected && <aside className="inspector"><div className={`preview ${aspect === "9:16" ? "vertical" : ""}`}>{selected.image ? <img src={selected.image} alt="Предпросмотр" /> : <div>Кадр {selected.id}</div>}{subtitles && <strong>{selected.text}</strong>}</div><label>Текст кадра<textarea value={selected.text} onChange={(e) => setScenes((items) => items.map((item) => item.id === selected.id ? { ...item, text: e.target.value } : item))} /></label><label>Промпт Nano Banana<textarea className="prompt" value={selected.prompt} onChange={(e) => setScenes((items) => items.map((item) => item.id === selected.id ? { ...item, prompt: e.target.value, status: "ready" } : item))} /></label><button className="generate one" onClick={() => { const list = keys.split(/[\n,;]+/).filter(Boolean); if (!list.length) setShowKeys(true); else generateScene(selected, list[selected.id % list.length]); }}>Создать этот кадр</button></aside>}
          </div>
        )}
      </section>

      {audioUrl && <div className="player"><audio ref={audioRef} src={audioUrl} controls onTimeUpdate={(e) => setPlayhead(e.currentTarget.currentTime)} /><span>{currentScene ? `Кадр ${currentScene.id}` : "Озвучка"}</span></div>}

      {showKeys && <div className="modal" onMouseDown={(e) => { if (e.target === e.currentTarget) setShowKeys(false); }}><div className="modalBox"><button className="close" onClick={() => setShowKeys(false)}>×</button><h2>Ключи Google AI</h2><p>Вставь один или несколько ключей. При длинном ролике они меняются по кругу. Ключи хранятся только в твоём браузере.</p><textarea value={keys} onChange={(e) => setKeys(e.target.value)} placeholder={"AIza...\nAIza..."} /><button className="primary" onClick={saveKeys}>Сохранить</button></div></div>}
    </main>
  );
}
