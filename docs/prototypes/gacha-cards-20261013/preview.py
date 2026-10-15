"""Serve only the card prototype, shared styles and private scratch samples.

Run from the repository root: python docs/prototypes/gacha-cards-20261013/preview.py
"""
import argparse
import mimetypes
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parents[3]
PROTOTYPE = Path(__file__).resolve().parent
PREFIX = '/docs/prototypes/gacha-cards-20261013/'
SAMPLES = ROOT / '.tmp' / 'card-background-study' / 'samples'
STYLES = ROOT / '_tools' / 'app' / 'src' / 'styles'
ALLOWED = {'.html', '.js', '.css', '.ttf', '.woff2', '.txt', '.webp', '.jpg', '.png'}


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        request_path = unquote(urlsplit(self.path).path)
        if request_path == '/':
            self.send_response(302)
            self.send_header('Location', PREFIX + 'index.html?variant=digital#s2')
            self.end_headers()
            return
        if request_path.startswith(PREFIX + 'samples/'):
            base = SAMPLES
            relative = request_path[len(PREFIX + 'samples/'):]
        elif request_path.startswith(PREFIX):
            base = PROTOTYPE
            relative = request_path[len(PREFIX):] or 'index.html'
        elif request_path.startswith('/_tools/app/src/styles/'):
            base = STYLES
            relative = request_path[len('/_tools/app/src/styles/'):]
        else:
            self.send_error(404)
            return
        resolved = (base / relative).resolve()
        if not resolved.is_relative_to(base.resolve()) or resolved.suffix.lower() not in ALLOWED or not resolved.is_file():
            self.send_error(404)
            return
        data = resolved.read_bytes()
        self.send_response(200)
        self.send_header('Content-Type', mimetypes.guess_type(resolved.name)[0] or 'application/octet-stream')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.end_headers()
        self.wfile.write(data)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=8767)
    args = parser.parse_args()
    server = ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
    print(f'http://127.0.0.1:{args.port}{PREFIX}index.html?variant=digital#s2', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.server_close()
