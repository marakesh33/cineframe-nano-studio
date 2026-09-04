#!/usr/bin/env python3
"""Local HTTP bridge that applies the trained Psychology RVC voice to WAV audio."""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tempfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
APPLIO = ROOT / "Applio"
MODEL_DIR = APPLIO / "logs" / "psychology-mind-rvc"
INDEX_PATH = MODEL_DIR / "psychology-mind-rvc.index"
PREFERRED_MODEL = MODEL_DIR / "psychology-mind-rvc_4e_408s.pth"
HOST = "127.0.0.1"
PORT = 7871

os.chdir(APPLIO)
sys.path.insert(0, str(APPLIO))

from rvc.infer.infer import VoiceConverter  # noqa: E402


def latest_model() -> Path:
    configured = os.environ.get("CINEFRAME_RVC_MODEL", "").strip()
    if configured:
        selected = Path(configured).expanduser().resolve()
        if not selected.exists():
            raise FileNotFoundError(f"Указанная модель не найдена: {selected}")
        return selected
    if PREFERRED_MODEL.exists():
        return PREFERRED_MODEL
    candidates: list[tuple[int, int, Path]] = []
    pattern = re.compile(r"_(\d+)e_(\d+)s\.pth$")
    for path in MODEL_DIR.glob("psychology-mind-rvc_*e_*s.pth"):
        match = pattern.search(path.name)
        if match:
            candidates.append((int(match.group(1)), int(match.group(2)), path))
    if not candidates:
        raise FileNotFoundError("Обученная модель голоса ещё не найдена")
    return max(candidates)[2]


converter = VoiceConverter()


class Handler(BaseHTTPRequestHandler):
    server_version = "CineframeVoice/1.0"

    def cors(self, content_type: str) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Type", content_type)

    def json_response(self, status: int, payload: dict[str, object]) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.cors("application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(204)
        self.cors("text/plain")
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        if self.path != "/health":
            self.json_response(404, {"error": "Not found"})
            return
        try:
            model = latest_model()
            self.json_response(200, {"ok": True, "model": model.name})
        except Exception as error:
            self.json_response(503, {"ok": False, "error": str(error)})

    def do_POST(self) -> None:  # noqa: N802
        if self.path != "/convert":
            self.json_response(404, {"error": "Not found"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > 80 * 1024 * 1024:
                raise ValueError("Пустая или слишком большая аудиочасть")
            audio = self.rfile.read(length)
            model = latest_model()
            with tempfile.TemporaryDirectory(prefix="cineframe-rvc-") as temp_dir:
                input_path = Path(temp_dir) / "input.wav"
                output_path = Path(temp_dir) / "output.wav"
                input_path.write_bytes(audio)
                converter.convert_audio(
                    audio_input_path=str(input_path),
                    audio_output_path=str(output_path),
                    model_path=str(model),
                    index_path=str(INDEX_PATH),
                    pitch=1,
                    f0_method="crepe-tiny",
                    index_rate=0.0,
                    volume_envelope=1.0,
                    protect=0.5,
                    embedder_model="contentvec",
                    export_format="WAV",
                    sid=0,
                )
                cleaned_path = Path(temp_dir) / "cleaned-slower.wav"
                subprocess.run(
                    [
                        "ffmpeg", "-v", "error", "-y",
                        "-i", str(input_path), "-i", str(output_path),
                        "-filter_complex",
                        "[0:a]aresample=40000[clean];[1:a]aresample=40000[clone];"
                        "[clean][clone]amix=inputs=2:weights='0.68 0.32':normalize=0,"
                        "adeclick=threshold=4,deesser=i=0.04:m=0.16:f=0.5,"
                        "atempo=0.92,alimiter=limit=0.95[out]",
                        "-map", "[out]", "-ar", "40000", "-ac", "1", str(cleaned_path),
                    ],
                    check=True,
                )
                result = cleaned_path.read_bytes()
            self.send_response(200)
            self.cors("audio/wav")
            self.send_header("X-RVC-Model", model.name)
            self.send_header("Content-Length", str(len(result)))
            self.end_headers()
            self.wfile.write(result)
        except Exception as error:
            self.json_response(500, {"error": str(error)})

    def log_message(self, fmt: str, *args: object) -> None:
        print(f"[voice] {self.address_string()} {fmt % args}", flush=True)


if __name__ == "__main__":
    model = latest_model()
    print(f"Cineframe voice server: http://{HOST}:{PORT} · {model.name}", flush=True)
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
