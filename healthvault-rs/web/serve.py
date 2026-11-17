"""Static host for the GPUI web build with the COOP/COEP headers WebGPU/wasm threads need."""
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import os

class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        super().end_headers()

os.chdir(Path(__file__).parent)
ThreadingHTTPServer(("0.0.0.0", 3042), Handler).serve_forever()
