type JsonRecord = Record<string, any>;

export type CapCutScene = {
  id: number;
  start: number;
  end: number;
  text: string;
  image?: string;
};

type WritableHandle = {
  write(data: Blob | string): Promise<void>;
  close(): Promise<void>;
};

type FileHandle = {
  kind: "file";
  name: string;
  getFile(): Promise<File>;
  createWritable(): Promise<WritableHandle>;
};

type DirectoryEntry = FileHandle | DirectoryHandle;

type DirectoryHandle = {
  kind: "directory";
  name: string;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FileHandle>;
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<DirectoryHandle>;
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
  entries(): AsyncIterableIterator<[string, DirectoryEntry]>;
};

type ExportOptions = {
  scenes: CapCutScene[];
  readyVideo: Blob;
  aspect: string;
  duration: number;
  subtitles: boolean;
  onProgress?: (message: string) => void;
};

const jsonClone = <T,>(value: T): T => structuredClone(value);
const uuid = () => crypto.randomUUID().toUpperCase();
const localId = () => crypto.randomUUID().toLowerCase();
const microseconds = (seconds: number) => Math.max(1, Math.round(seconds * 1_000_000));

async function readText(directory: DirectoryHandle, name: string) {
  const handle = await directory.getFileHandle(name);
  return (await handle.getFile()).text();
}

async function readJson(directory: DirectoryHandle, name: string) {
  return JSON.parse(await readText(directory, name)) as JsonRecord;
}

async function writeFile(directory: DirectoryHandle, name: string, data: Blob | string) {
  const handle = await directory.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  await writable.write(data);
  await writable.close();
}

async function copyFile(source: DirectoryHandle, destination: DirectoryHandle, name: string) {
  const sourceFile = await (await source.getFileHandle(name)).getFile();
  await writeFile(destination, name, sourceFile);
}

async function directoryExists(directory: DirectoryHandle, name: string) {
  try {
    await directory.getDirectoryHandle(name);
    return true;
  } catch {
    return false;
  }
}

function basename(path: string) {
  return path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "";
}

async function findTemplate(root: DirectoryHandle, rootMeta: JsonRecord) {
  const names: string[] = [];
  for (const item of rootMeta.all_draft_store || []) {
    const name = basename(String(item.draft_fold_path || item.draft_name || ""));
    if (name && !names.includes(name)) names.push(name);
  }
  for await (const [name, entry] of root.entries()) {
    if (entry.kind === "directory" && !name.startsWith(".") && !names.includes(name)) names.push(name);
  }

  let best: { directory: DirectoryHandle; content: JsonRecord; meta: JsonRecord; score: number } | null = null;
  for (const name of names) {
    try {
      const directory = await root.getDirectoryHandle(name);
      const content = await readJson(directory, "draft_info.json");
      const meta = await readJson(directory, "draft_meta_info.json");
      const videoTrack = (content.tracks || []).find((track: JsonRecord) => track.type === "video" && track.segments?.length);
      const videoMaterial = content.materials?.videos?.[0];
      if (!videoTrack || !videoMaterial) continue;
      const hasText = Boolean((content.tracks || []).find((track: JsonRecord) => track.type === "text" && track.segments?.length) && content.materials?.texts?.length);
      const score = (hasText ? 10 : 0) + (meta.tm_draft_modified || 0) / 1e18;
      if (!best || score > best.score) best = { directory, content, meta, score };
    } catch {
      // A recycle-bin folder or an incomplete draft is not a usable template.
    }
  }
  if (!best) throw new Error("В этой папке не нашёлся ни один обычный проект CapCut.");
  return best;
}

function updateRichText(material: JsonRecord, text: string, durationUs: number) {
  try {
    const content = JSON.parse(material.content || "{}") as JsonRecord;
    content.text = text;
    for (const style of content.styles || []) style.range = [0, text.length];
    material.content = JSON.stringify(content);
  } catch {
    material.content = JSON.stringify({ styles: [], text });
  }
  material.global_alpha = 1;
  material.text_alpha = 1;
  material.line_max_width = 0.82;
  material.words = {
    start_time: [0],
    end_time: [Math.round(durationUs / 1000)],
    text: [text],
  };
}

export function buildCapCutDraft(
  template: JsonRecord,
  templateMeta: JsonRecord,
  rootMeta: JsonRecord,
  projectName: string,
  options: ExportOptions,
  media: { images: Array<{ name: string; size: number; mime: string }>; videoName: string; videoSize: number },
) {
  const content = jsonClone(template);
  const sourceMaterials = jsonClone(template.materials || {});
  const sourceVideoTrack = (template.tracks || []).find((track: JsonRecord) => track.type === "video" && track.segments?.length);
  const sourceVideoSegment = sourceVideoTrack?.segments?.[0];
  const sourceVideoMaterial = (template.materials?.videos || []).find((item: JsonRecord) => item.id === sourceVideoSegment?.material_id) || template.materials?.videos?.[0];
  if (!sourceVideoTrack || !sourceVideoSegment || !sourceVideoMaterial) throw new Error("В шаблоне CapCut нет видеодорожки.");

  const sourceTextTrack = (template.tracks || []).find((track: JsonRecord) => track.type === "text" && track.segments?.length);
  const sourceTextSegment = sourceTextTrack?.segments?.[0];
  const sourceTextMaterial = (template.materials?.texts || []).find((item: JsonRecord) => item.id === sourceTextSegment?.material_id) || template.materials?.texts?.[0];
  const width = options.aspect === "9:16" ? 1080 : 1920;
  const height = options.aspect === "9:16" ? 1920 : 1080;
  const durationUs = microseconds(options.duration);
  const nowUs = Date.now() * 1000;
  const draftId = uuid();
  const timelineId = uuid();
  const rootPath = String(rootMeta.root_path || templateMeta.draft_root_path || "").replace(/[\\/]+$/, "");
  if (!rootPath) throw new Error("В root_meta_info.json не нашёлся путь CapCut.");
  const projectPath = `${rootPath}/${projectName}`;
  const mediaPath = `${projectPath}/Resources/Media`;

  content.id = timelineId;
  content.name = projectName;
  content.duration = durationUs;
  content.create_time = nowUs;
  content.update_time = nowUs;
  content.canvas_config = { ...(content.canvas_config || {}), width, height, ratio: options.aspect };
  content.relationships = [];
  content.group_container = null;
  content.cover = null;
  content.static_cover_image_path = "";
  if (content.keyframes && typeof content.keyframes === "object") {
    for (const key of Object.keys(content.keyframes)) content.keyframes[key] = [];
  }
  for (const key of Object.keys(content.materials || {})) {
    if (Array.isArray(content.materials[key])) content.materials[key] = [];
  }
  content.materials.videos ||= [];
  content.materials.texts ||= [];

  const sourceById = new Map<string, { collection: string; value: JsonRecord }>();
  for (const [collection, values] of Object.entries(sourceMaterials)) {
    if (!Array.isArray(values)) continue;
    for (const value of values as JsonRecord[]) if (value?.id) sourceById.set(value.id, { collection, value });
  }
  const cloneRefs = (ids: string[] = []) => ids.flatMap((oldId) => {
    const found = sourceById.get(oldId);
    if (!found) return [];
    const copy = jsonClone(found.value);
    copy.id = uuid();
    content.materials[found.collection] ||= [];
    content.materials[found.collection].push(copy);
    return [copy.id];
  });

  const metaMaterials: JsonRecord[] = [];
  const virtualMaterialIds: string[] = [];
  const visualTrack = jsonClone(sourceVideoTrack);
  visualTrack.id = uuid();
  visualTrack.name = "01 · КАДРЫ ОТДЕЛЬНО";
  visualTrack.is_default_name = false;
  visualTrack.segments = [];

  options.scenes.forEach((scene, index) => {
    const image = media.images[index];
    const clipDuration = microseconds(Math.max(0.001, scene.end - scene.start));
    const clipStart = microseconds(scene.start);
    const materialId = uuid();
    const importedId = localId();
    const material = jsonClone(sourceVideoMaterial);
    Object.assign(material, {
      id: materialId,
      local_material_id: importedId,
      material_name: image.name,
      path: `${mediaPath}/${image.name}`,
      duration: clipDuration,
      width,
      height,
      has_audio: false,
      type: "photo",
    });
    if (material.video_algorithm) material.video_algorithm = { ...material.video_algorithm, path: "", algorithms: [] };
    content.materials.videos.push(material);

    const segment = jsonClone(sourceVideoSegment);
    segment.id = uuid();
    segment.material_id = materialId;
    segment.raw_segment_id = visualTrack.id;
    segment.source_timerange = { start: 0, duration: clipDuration };
    segment.target_timerange = { start: clipStart, duration: clipDuration };
    segment.extra_material_refs = cloneRefs(sourceVideoSegment.extra_material_refs || []);
    segment.common_keyframes = [];
    segment.keyframe_refs = [];
    segment.render_index = 0;
    segment.track_render_index = 0;
    segment.volume = 0;
    segment.last_nonzero_volume = 1;
    segment.visible = true;
    segment.clip = { ...(segment.clip || {}), alpha: 1 };
    visualTrack.segments.push(segment);

    metaMaterials.push({
      create_time: Math.floor(Date.now() / 1000),
      duration: clipDuration,
      extra_info: image.name,
      file_Path: `./Resources/Media/${image.name}`,
      height,
      id: importedId,
      import_time: Math.floor(Date.now() / 1000),
      import_time_ms: nowUs,
      item_source: 1,
      md5: "",
      metetype: "photo",
      roughcut_time_range: { start: 0, duration: clipDuration },
      sub_time_range: { start: -1, duration: -1 },
      type: 0,
      width,
    });
    virtualMaterialIds.push(importedId);
  });

  const audioTrack = jsonClone(sourceVideoTrack);
  audioTrack.id = uuid();
  audioTrack.name = "02 · ОЗВУЧКА";
  audioTrack.is_default_name = false;
  const audioMaterialId = uuid();
  const audioLocalId = localId();
  const audioMaterial = jsonClone(sourceVideoMaterial);
  Object.assign(audioMaterial, {
    id: audioMaterialId,
    local_material_id: audioLocalId,
    material_name: media.videoName,
    path: `${mediaPath}/${media.videoName}`,
    duration: durationUs,
    width: options.aspect === "9:16" ? 720 : 1280,
    height: options.aspect === "9:16" ? 1280 : 720,
    has_audio: true,
    type: "video",
  });
  content.materials.videos.push(audioMaterial);
  const audioSegment = jsonClone(sourceVideoSegment);
  audioSegment.id = uuid();
  audioSegment.material_id = audioMaterialId;
  audioSegment.raw_segment_id = audioTrack.id;
  audioSegment.source_timerange = { start: 0, duration: durationUs };
  audioSegment.target_timerange = { start: 0, duration: durationUs };
  audioSegment.extra_material_refs = cloneRefs(sourceVideoSegment.extra_material_refs || []);
  audioSegment.common_keyframes = [];
  audioSegment.keyframe_refs = [];
  audioSegment.render_index = 1;
  audioSegment.track_render_index = 1;
  audioSegment.volume = 1;
  audioSegment.last_nonzero_volume = 1;
  audioSegment.visible = true;
  audioSegment.clip = { ...(audioSegment.clip || {}), alpha: 0 };
  audioTrack.segments = [audioSegment];
  metaMaterials.push({
    create_time: Math.floor(Date.now() / 1000),
    duration: durationUs,
    extra_info: media.videoName,
    file_Path: `./Resources/Media/${media.videoName}`,
    height: audioMaterial.height,
    id: audioLocalId,
    import_time: Math.floor(Date.now() / 1000),
    import_time_ms: nowUs,
    item_source: 1,
    md5: "",
    metetype: "video",
    roughcut_time_range: { start: 0, duration: durationUs },
    sub_time_range: { start: -1, duration: -1 },
    type: 0,
    width: audioMaterial.width,
  });
  virtualMaterialIds.push(audioLocalId);

  const tracks: JsonRecord[] = [visualTrack, audioTrack];
  if (options.subtitles && sourceTextTrack && sourceTextSegment && sourceTextMaterial) {
    const textTrack = jsonClone(sourceTextTrack);
    textTrack.id = uuid();
    textTrack.name = "03 · СУБТИТРЫ";
    textTrack.is_default_name = false;
    textTrack.segments = options.scenes.map((scene, index) => {
      const clipDuration = microseconds(Math.max(0.001, scene.end - scene.start));
      const textMaterial = jsonClone(sourceTextMaterial);
      textMaterial.id = uuid();
      textMaterial.group_id = uuid();
      updateRichText(textMaterial, scene.text, clipDuration);
      content.materials.texts.push(textMaterial);
      const segment = jsonClone(sourceTextSegment);
      segment.id = uuid();
      segment.material_id = textMaterial.id;
      segment.target_timerange = { start: microseconds(scene.start), duration: clipDuration };
      segment.source_timerange = null;
      segment.extra_material_refs = cloneRefs(sourceTextSegment.extra_material_refs || []);
      segment.common_keyframes = [];
      segment.keyframe_refs = [];
      segment.render_index = 14000 + index;
      segment.track_render_index = 2;
      segment.clip = {
        ...(segment.clip || {}),
        alpha: 1,
        scale: { x: options.aspect === "9:16" ? 0.78 : 0.9, y: options.aspect === "9:16" ? 0.78 : 0.9 },
        transform: { x: 0, y: options.aspect === "9:16" ? -0.62 : -0.72 },
      };
      return segment;
    });
    tracks.push(textTrack);
  }
  content.tracks = tracks;

  const draftMeta = jsonClone(templateMeta);
  Object.assign(draftMeta, {
    draft_id: draftId,
    draft_name: projectName,
    draft_fold_path: projectPath,
    draft_root_path: rootPath,
    draft_cover: "draft_cover.jpg",
    tm_duration: durationUs,
    tm_draft_create: nowUs,
    tm_draft_modified: nowUs,
    tm_draft_removed: 0,
    draft_materials: [
      { type: 0, value: metaMaterials },
      { type: 1, value: [] },
      { type: 2, value: [] },
      { type: 3, value: [] },
      { type: 6, value: [] },
      { type: 7, value: [] },
      { type: 8, value: [] },
    ],
  });

  const totalSize = media.images.reduce((sum, image) => sum + image.size, media.videoSize);
  const root = jsonClone(rootMeta);
  const rootEntry = jsonClone(root.all_draft_store?.[0] || {});
  Object.assign(rootEntry, {
    draft_cover: `${projectPath}/draft_cover.jpg`,
    draft_fold_path: projectPath,
    draft_id: draftId,
    draft_json_file: `${projectPath}/draft_info.json`,
    draft_name: projectName,
    draft_root_path: rootPath,
    draft_timeline_materials_size: totalSize,
    tm_draft_create: nowUs,
    tm_draft_modified: nowUs,
    tm_draft_removed: 0,
    tm_duration: durationUs,
  });
  root.all_draft_store = [rootEntry, ...(root.all_draft_store || [])];
  root.draft_ids = root.all_draft_store.length;

  const virtualStore = {
    draft_materials: [],
    draft_virtual_store: [
      { type: 0, value: [{ creation_time: 0, display_name: "", filter_type: 0, id: "", import_time: 0, import_time_us: 0, sort_sub_type: 0, sort_type: 0 }] },
      { type: 1, value: virtualMaterialIds.map((id) => ({ child_id: id, parent_id: "" })) },
      { type: 2, value: [] },
    ],
  };

  return { content, draftMeta, root, virtualStore };
}

async function imageBlob(source: string) {
  const response = await fetch(source);
  if (!response.ok) throw new Error("Не удалось прочитать один из кадров.");
  return response.blob();
}

function extensionFor(blob: Blob) {
  if (blob.type.includes("png")) return "png";
  if (blob.type.includes("webp")) return "webp";
  return "jpg";
}

async function makeJpegCover(blob: Blob, aspect: string) {
  const url = URL.createObjectURL(blob);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const item = new Image();
      item.onload = () => resolve(item);
      item.onerror = () => reject(new Error("Не удалось создать обложку CapCut."));
      item.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = aspect === "9:16" ? 405 : 720;
    canvas.height = aspect === "9:16" ? 720 : 405;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Не удалось создать обложку CapCut.");
    const scale = Math.max(canvas.width / image.naturalWidth, canvas.height / image.naturalHeight);
    const width = image.naturalWidth * scale;
    const height = image.naturalHeight * scale;
    context.drawImage(image, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height);
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob((result) => result ? resolve(result) : reject(new Error("Не удалось создать обложку CapCut.")), "image/jpeg", 0.88));
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function addProjectToCapCut(options: ExportOptions) {
  if (!options.scenes.length || options.scenes.some((scene) => !scene.image)) throw new Error("Снача дождись всех кадров.");
  const picker = (window as Window & {
    showDirectoryPicker?: (options: { id: string; mode: "readwrite" }) => Promise<DirectoryHandle>;
  }).showDirectoryPicker;
  if (!picker) throw new Error("Прямое добавление в CapCut работает в Google Chrome или Microsoft Edge.");

  options.onProgress?.("Выбери папку com.lveditor.draft…");
  const root = await picker({ id: "cineframe-capcut-projects", mode: "readwrite" });
  let rootMeta: JsonRecord;
  try {
    rootMeta = await readJson(root, "root_meta_info.json");
  } catch {
    throw new Error("Это не папка проектов CapCut. Выбери com.lveditor.draft.");
  }
  const template = await findTemplate(root, rootMeta);

  const now = new Date();
  const date = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, "0"), String(now.getDate()).padStart(2, "0")].join("-");
  const time = [String(now.getHours()).padStart(2, "0"), String(now.getMinutes()).padStart(2, "0")].join("-");
  const baseName = `CineFrame ${date} ${time}`;
  let projectName = baseName;
  let suffix = 2;
  while (await directoryExists(root, projectName)) projectName = `${baseName} ${suffix++}`;

  const imageBlobs: Blob[] = [];
  const imageInfo: Array<{ name: string; size: number; mime: string }> = [];
  for (let index = 0; index < options.scenes.length; index++) {
    options.onProgress?.(`Подготавливаю кадры: ${index + 1} из ${options.scenes.length}…`);
    const blob = await imageBlob(options.scenes[index].image!);
    const name = `scene-${String(index + 1).padStart(3, "0")}.${extensionFor(blob)}`;
    imageBlobs.push(blob);
    imageInfo.push({ name, size: blob.size, mime: blob.type });
  }

  const built = buildCapCutDraft(template.content, template.meta, rootMeta, projectName, options, {
    images: imageInfo,
    videoName: "ready-video-audio.mp4",
    videoSize: options.readyVideo.size,
  });

  let projectCreated = false;
  try {
    options.onProgress?.("Создаю новый проект CapCut…");
    const project = await root.getDirectoryHandle(projectName, { create: true });
    projectCreated = true;
    const media = await (await project.getDirectoryHandle("Resources", { create: true })).getDirectoryHandle("Media", { create: true });
    await (await project.getDirectoryHandle("Resources", { create: true })).getDirectoryHandle("audioAlg", { create: true });
    await (await project.getDirectoryHandle("Resources", { create: true })).getDirectoryHandle("videoAlg", { create: true });
    await project.getDirectoryHandle("common_attachment", { create: true });
    await project.getDirectoryHandle("matting", { create: true });
    await project.getDirectoryHandle("smart_crop", { create: true });

    const replaced = new Set(["draft_info.json", "draft_info.json.bak", "draft_meta_info.json", "draft_cover.jpg", "template-2.tmp", "key_value.json", "draft_virtual_store.json", "attachment_pc_common.json"]);
    for await (const [name, entry] of template.directory.entries()) {
      if (entry.kind === "file" && !replaced.has(name) && !name.startsWith(".")) await copyFile(template.directory, project, name);
    }

    for (let index = 0; index < imageBlobs.length; index++) {
      options.onProgress?.(`Записываю кадры в CapCut: ${index + 1} из ${imageBlobs.length}…`);
      await writeFile(media, imageInfo[index].name, imageBlobs[index]);
    }
    await writeFile(media, "ready-video-audio.mp4", options.readyVideo);
    await writeFile(project, "draft_cover.jpg", await makeJpegCover(imageBlobs[0], options.aspect));

    const contentText = `${JSON.stringify(built.content)}\n`;
    await writeFile(project, "draft_info.json", contentText);
    await writeFile(project, "draft_info.json.bak", contentText);
    await writeFile(project, "template-2.tmp", contentText);
    await writeFile(project, "draft_meta_info.json", `${JSON.stringify(built.draftMeta)}\n`);
    await writeFile(project, "draft_virtual_store.json", `${JSON.stringify(built.virtualStore)}\n`);
    await writeFile(project, "key_value.json", "{}\n");

    let attachment: JsonRecord = {};
    try { attachment = await readJson(template.directory, "attachment_pc_common.json"); } catch { /* Optional CapCut file. */ }
    attachment.recognize_tasks = [];
    if (attachment.ai_packaging_report_info) attachment.ai_packaging_report_info.caption_id_list = [];
    await writeFile(project, "attachment_pc_common.json", `${JSON.stringify(attachment)}\n`);

    options.onProgress?.("Регистрирую проект в CapCut…");
    await writeFile(root, "root_meta_info.json", `${JSON.stringify(built.root)}\n`);
    return projectName;
  } catch (error) {
    if (projectCreated) {
      try { await root.removeEntry(projectName, { recursive: true }); } catch { /* Leave the incomplete folder for manual recovery. */ }
    }
    throw error;
  }
}
