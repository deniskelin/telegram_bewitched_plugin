"""
OpenAI-compatible text-to-speech server on top of Silero TTS (Russian).

POST /v1/audio/speech  {"input": "...", "voice": "xenia", "response_format": "wav"}
GET  /health

Listens on 127.0.0.1 only. Returns 16-bit PCM WAV. Long text is split into
sentences (the model limits input length) and joined.
Run: silero-venv/bin/python silero_server.py --port 8179 --sample-rate 48000
"""
import argparse
import io
import json
import re
import wave

import torch

parser = argparse.ArgumentParser()
parser.add_argument("--port", type=int, default=8179)
parser.add_argument("--sample-rate", type=int, default=48000)
parser.add_argument("--speaker", default="v4_ru")
parser.add_argument("--threads", type=int, default=4)
args = parser.parse_args()

torch.set_num_threads(args.threads)
model, _ = torch.hub.load(repo_or_dir="snakers4/silero-models", model="silero_tts", language="ru", speaker=args.speaker, trust_repo=True)
VOICES = set(getattr(model, "speakers", [])) or {"aidar", "baya", "kseniya", "xenia", "eugene"}

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer  # noqa: E402


def sentences(text, limit=800):
    parts, cur = [], ""
    for s in re.split(r"(?<=[.!?…])\s+", text.strip()):
        while len(s) > limit:
            parts.append(s[:limit])
            s = s[limit:]
        if len(cur) + len(s) + 1 > limit and cur:
            parts.append(cur)
            cur = s
        else:
            cur = f"{cur} {s}".strip()
    if cur:
        parts.append(cur)
    return parts


def synth(text, voice):
    audio = []
    for chunk in sentences(text):
        a = model.apply_tts(text=chunk, speaker=voice, sample_rate=args.sample_rate, put_accent=True, put_yo=True)
        audio.append(a)
        audio.append(torch.zeros(int(args.sample_rate * 0.25)))
    pcm = (torch.cat(audio).clamp(-1, 1) * 32767).to(torch.int16).numpy().tobytes()
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(args.sample_rate)
        w.writeframes(pcm)
    return buf.getvalue()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, code, body, ctype):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            return self._send(200, json.dumps({"ok": True, "voices": sorted(VOICES)}).encode(), "application/json")
        self._send(404, b"{}", "application/json")

    def do_POST(self):
        if not self.path.startswith("/v1/audio/speech"):
            return self._send(404, b"{}", "application/json")
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
        text = (body.get("input") or "").strip()
        voice = body.get("voice") or "xenia"
        if not text:
            return self._send(400, b'{"error":"input is required"}', "application/json")
        if voice not in VOICES:
            voice = "xenia"
        self._send(200, synth(text, voice), "audio/wav")


ThreadingHTTPServer(("127.0.0.1", args.port), Handler).serve_forever()
