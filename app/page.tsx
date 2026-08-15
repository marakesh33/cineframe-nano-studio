"use client";

import { ChangeEvent, useEffect, useMemo, useRef, useState } from "react";

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

const DEFAULT_STYLE = "Dark hand-painted historical realism, Renaissance-era characters, dramatic chiaroscuro, cold blue-gray shadows, warm amber candlelight, cinematic 16:9 composition, detailed oil-paint texture, serious psychological atmosphere, no text, no watermark.";

function clock(seconds: number) {
  const value = Math.max(0, Math.round(seconds));
  return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
}

function splitIntoScenes(text: string, count: number, duration: number, style: string, direction: string) {
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
      prompt: `${style}\n\nOverall story direction: ${direction || "Create a coherent visual narrative."}\nNarration for this exact shot: "${fragment}"\nShow one clear visual moment that expresses the meaning of this narration. Keep recurring characters, wardrobe, facial features, palette and lighting consistent with every other shot. Strong foreground subject, readable composition, natural anatomy. Do not include captions, letters, logos or watermarks.`,
      status: "ready",
    };
  });
}

export default function Home() {
  const [script, setScript] = useState("");
  const [direction, setDirection] = useState("");
  const [style, setStyle] = useState(DEFAULT_STYLE);
  const [audioName, setAudioName] = useState("");
  const [audioUrl, setAudioUrl] = useState("");
  const [audioDuration, setAudioDuration] = useState(0);
  const [shotLength, setShotLength] = useState(12);
  const [quality, setQuality] = useState("1K");
  const [subtitles, setSubtitles] = useState(true);
  const [scenes, setScenes] = useState<Scene[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [keys, setKeys] = useState("");
  const [showKeys, setShowKeys] = useState(false);
  const [message, setMessage] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
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
    setAudioUrl(url);
    setScenes([]);
  }

  function buildPlan() {
    if (!script.trim()) {
      setMessage("Снача вставь свой сценарий.");
      return;
    }
    const next = splitIntoScenes(script, expectedScenes, estimatedDuration, style, direction);
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
        body: JSON.stringify({ apiKey: key, prompt: scene.prompt, quality }),
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
    download("cineframe-project.json", JSON.stringify({ direction, style, duration: estimatedDuration, subtitles, scenes: clean }, null, 2), "application/json");
  }

  function exportSrt() {
    const stamp = (value: number) => {
      const ms = Math.round(value * 1000);
      const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60, x = ms % 1000;
      return `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")},${String(x).padStart(3,"0")}`;
    };
    download("subtitles.srt", scenes.map((scene, index) => `${index + 1}\n${stamp(scene.start)} --> ${stamp(scene.end)}\n${scene.text}\n`).join("\n"), "text/plain;charset=utf-8");
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
          <div className="cardTitle"><b>1</b><div><h2>Добавь материал</h2><p>Никаких готовых сцен — только твой текс.</p></div></div>
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
          <div className="row"><label>Длина кадра<select value={shotLength} onChange={(e) => setShotLength(Number(e.target.value))}><option value={8}>8 сек</option><option value={12}>12 сек</option><option value={15}>15 сек</option><option value={20}>20 сек</option></select></label><label>Качество<select value={quality} onChange={(e) => setQuality(e.target.value)}><option>1K</option><option>2K</option><option>4K</option></select></label></div>
          <button className="toggleLine" onClick={() => setSubtitles(!subtitles)}><span><strong>Субтитры</strong><small>Можно скачать SRT или отключить</small></span><i className={subtitles ? "on" : ""}><b /></i></button>
          <div className="numbers"><span><small>Длина</small><b>{clock(estimatedDuration)}</b></span><span><small>Кадров</small><b>{script ? expectedScenes : 0}</b></span><span><small>Формат</small><b>16:9</b></span></div>
          <button className="primary" onClick={buildPlan}>Создать план кадров <span>→</span></button>
        </aside>
      </section>

      <section className="storyboard card">
        <div className="storyHead"><div className="cardTitle compact"><b>3</b><div><h2>Кадры</h2><p>{scenes.length ? `${done} из ${scenes.length} сгенерировано` : "Появятся после твоего сценария"}</p></div></div>{scenes.length > 0 && <div className="storyActions"><button className="plain" onClick={exportProject}>Скачать JSON</button>{subtitles && <button className="plain" onClick={exportSrt}>SRT</button>}<button className="generate" onClick={generateAll} disabled={isGenerating}>{isGenerating ? `Генерирую… ${done}/${scenes.length}` : "Создать все кадры"}</button></div>}</div>
        {message && <div className="notice">{message}</div>}
        {!scenes.length ? <div className="empty"><span>+</span><strong>Здесь пока пусто</strong><p>Вставь свой текс выше и нажми «Создать план». Сайт не добавляет чужие сцены.</p></div> : (
          <div className="workarea">
            <div className="sceneGrid">{scenes.map((scene) => <button key={scene.id} onClick={() => setSelectedId(scene.id)} className={`shot ${scene.id === selectedId ? "selected" : ""}`}><div className="shotImage">{scene.image ? <img src={scene.image} alt={`Кадр ${scene.id}`} /> : <span>{scene.status === "working" ? "…" : String(scene.id).padStart(2,"0")}</span>}<i className={scene.status} /></div><small>{clock(scene.start)}–{clock(scene.end)}</small><p>{scene.text}</p>{scene.error && <em>{scene.error}</em>}</button>)}</div>
            {selected && <aside className="inspector"><div className="preview">{selected.image ? <img src={selected.image} alt="Предпросмотр" /> : <div>Кадр {selected.id}</div>}{subtitles && <strong>{selected.text}</strong>}</div><label>Текст кадра<textarea value={selected.text} onChange={(e) => setScenes((items) => items.map((item) => item.id === selected.id ? { ...item, text: e.target.value } : item))} /></label><label>Промпт Nano Banana<textarea className="prompt" value={selected.prompt} onChange={(e) => setScenes((items) => items.map((item) => item.id === selected.id ? { ...item, prompt: e.target.value, status: "ready" } : item))} /></label><button className="generate one" onClick={() => { const list = keys.split(/[\n,;]+/).filter(Boolean); if (!list.length) setShowKeys(true); else generateScene(selected, list[selected.id % list.length]); }}>Создать этот кадр</button></aside>}
          </div>
        )}
      </section>

      {audioUrl && <div className="player"><audio ref={audioRef} src={audioUrl} controls onTimeUpdate={(e) => setPlayhead(e.currentTarget.currentTime)} /><span>{currentScene ? `Кадр ${currentScene.id}` : "Озвучка"}</span></div>}

      {showKeys && <div className="modal" onMouseDown={(e) => { if (e.target === e.currentTarget) setShowKeys(false); }}><div className="modalBox"><button className="close" onClick={() => setShowKeys(false)}>×</button><h2>Ключи Google AI</h2><p>Вставь один или несколько ключей. При длинном ролике они меняются по кругу. Ключи хранятся только в твоём браузере.</p><textarea value={keys} onChange={(e) => setKeys(e.target.value)} placeholder={"AIza...\nAIza..."} /><button className="primary" onClick={saveKeys}>Сохранить</button></div></div>}
    </main>
  );
}
