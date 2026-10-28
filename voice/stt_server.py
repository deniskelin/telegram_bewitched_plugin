"""
OpenAI-compatible speech-to-text server on top of faster-whisper.

POST /v1/audio/transcriptions (multipart: file, model, language, response_format)
GET  /health

Listens on 127.0.0.1 only. The model is loaded once at start.
Run: stt-venv/bin/python stt_server.py --port 8178 --model large-v3-turbo
"""
import argparse
import json
import os
import tempfile
from email.parser import BytesParser
from email.policy import HTTP
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from faster_whisper import WhisperModel

parser = argparse.ArgumentParser()
parser.add_argument("--port", type=int, default=8178)
parser.add_argument("--model", default=os.environ.get("STT_LOCAL_MODEL", "large-v3-turbo"))
parser.add_argument("--threads", type=int, default=max(1, (os.cpu_count() or 4) // 2))
args = parser.parse_args()

model = WhisperModel(args.model, device="cpu", compute_type="int8", cpu_threads=args.threads)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _json(self, code, body):
        data = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/health":
            return self._json(200, {"ok": True, "model": args.model})
        self._json(404, {"error": "not found"})

    def do_POST(self):
        if not self.path.startswith("/v1/audio/transcriptions"):
            return self._json(404, {"error": "not found"})
        # multipart/form-data without the cgi module (gone in Python 3.13)
        raw = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        msg = BytesParser(policy=HTTP).parsebytes(b"Content-Type: " + self.headers["Content-Type"].encode() + b"\r\n\r\n" + raw)
        fields = {p.get_param("name", header="content-disposition"): p for p in msg.iter_parts()}
        if "file" not in fields:
            return self._json(400, {"error": "file is required"})
        language = (fields["language"].get_content().strip() if "language" in fields else "") or None
        with tempfile.NamedTemporaryFile(suffix=".audio") as f:
            f.write(fields["file"].get_payload(decode=True))
            f.flush()
            segments, info = model.transcribe(f.name, language=language, vad_filter=True, beam_size=5)
            text = "".join(s.text for s in segments).strip()
        self._json(200, {"text": text, "language": info.language, "duration": info.duration})


ThreadingHTTPServer(("127.0.0.1", args.port), Handler).serve_forever()
