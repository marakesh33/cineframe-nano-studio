const DATABASE_NAME = "cineframe-projects";
const DATABASE_VERSION = 1;
const PROJECT_KEY = "active-project";

export type SavedScene = {
  id: number;
  start: number;
  end: number;
  text: string;
  prompt: string;
  status: "ready" | "working" | "done" | "error";
  error?: string;
};

export type ProjectCheckpoint = {
  version: 1;
  checkpointId: string;
  savedAt: number;
  script: string;
  direction: string;
  style: string;
  targetDuration: number;
  durationMinutesInput: string;
  quality: string;
  aspect: string;
  voice: string;
  voiceDirection: string;
  audioName: string;
  audioDuration: number;
  openingQuoteDuration?: number;
  audioSource?: "generated" | "uploaded";
  audioIncludesShortsOutro?: boolean;
  voiceRevision?: number;
  fitVoiceToVideo?: boolean;
  referenceVideoName?: string;
  videoFormat?: "mp4" | "mov";
  scenes: SavedScene[];
  pipelineStage: "idle" | "voice" | "frames" | "render" | "done" | "error";
  pipelineProgress: number;
  pipelineLabel: string;
};

type StoredImage = { key: string; checkpointId: string; sceneId: number; image: string };
type StoredBlob = { key: string; blob: Blob };

function openDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains("state")) database.createObjectStore("state");
      if (!database.objectStoreNames.contains("images")) database.createObjectStore("images", { keyPath: "key" });
      if (!database.objectStoreNames.contains("blobs")) database.createObjectStore("blobs", { keyPath: "key" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Не удалось открыть хранилище проекта"));
  });
}

function requestResult<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Ошибка хранилища проекта"));
  });
}

function transactionDone(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error("Ошибка сохранения проекта"));
    transaction.onabort = () => reject(transaction.error || new Error("Сохранение проекта прервано"));
  });
}

export async function saveProjectCheckpoint(checkpoint: ProjectCheckpoint) {
  const database = await openDatabase();
  try {
    const transaction = database.transaction("state", "readwrite");
    transaction.objectStore("state").put(checkpoint, PROJECT_KEY);
    await transactionDone(transaction);
  } finally {
    database.close();
  }
}

export async function loadProjectCheckpoint() {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(["state", "images", "blobs"], "readonly");
    const checkpointRequest = transaction.objectStore("state").get(PROJECT_KEY) as IDBRequest<ProjectCheckpoint | undefined>;
    const imagesRequest = transaction.objectStore("images").getAll() as IDBRequest<StoredImage[]>;
    const audioRequest = transaction.objectStore("blobs").get("audio") as IDBRequest<StoredBlob | undefined>;
    const videoRequest = transaction.objectStore("blobs").get("video") as IDBRequest<StoredBlob | undefined>;
    const completed = transactionDone(transaction);
    const [checkpoint, images, audio, video] = await Promise.all([
      requestResult(checkpointRequest), requestResult(imagesRequest), requestResult(audioRequest), requestResult(videoRequest),
    ]);
    await completed;
    if (!checkpoint) return null;
    const imageByScene = new Map(images.filter((item) => item.checkpointId === checkpoint.checkpointId).map((item) => [item.sceneId, item.image]));
    return {
      checkpoint,
      scenes: checkpoint.scenes.map((scene) => {
        const image = imageByScene.get(scene.id);
        return image ? { ...scene, image, status: "done" as const, error: undefined } : { ...scene, status: scene.status === "working" ? "ready" as const : scene.status };
      }),
      audioBlob: audio?.blob || null,
      videoBlob: video?.blob || null,
    };
  } finally {
    database.close();
  }
}

export async function saveSceneImage(checkpointId: string, sceneId: number, image: string) {
  const database = await openDatabase();
  try {
    const transaction = database.transaction("images", "readwrite");
    transaction.objectStore("images").put({ key: `${checkpointId}:${sceneId}`, checkpointId, sceneId, image } satisfies StoredImage);
    await transactionDone(transaction);
  } finally {
    database.close();
  }
}

export async function saveProjectBlob(key: string, blob: Blob) {
  const database = await openDatabase();
  try {
    const transaction = database.transaction("blobs", "readwrite");
    transaction.objectStore("blobs").put({ key, blob } satisfies StoredBlob);
    await transactionDone(transaction);
  } finally {
    database.close();
  }
}

export async function loadProjectBlob(key: string) {
  const database = await openDatabase();
  try {
    const result = await requestResult(database.transaction("blobs", "readonly").objectStore("blobs").get(key) as IDBRequest<StoredBlob | undefined>);
    return result?.blob || null;
  } finally {
    database.close();
  }
}

export async function deleteProjectBlob(key: string) {
  const database = await openDatabase();
  try {
    const transaction = database.transaction("blobs", "readwrite");
    transaction.objectStore("blobs").delete(key);
    await transactionDone(transaction);
  } finally {
    database.close();
  }
}

export async function clearGeneratedProjectMedia() {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(["images", "blobs"], "readwrite");
    transaction.objectStore("images").clear();
    transaction.objectStore("blobs").clear();
    await transactionDone(transaction);
  } finally {
    database.close();
  }
}
