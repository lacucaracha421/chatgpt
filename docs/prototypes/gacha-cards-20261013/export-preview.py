"""Export one offline HTML with local fonts and scratch sample images embedded."""
import base64
import mimetypes
import re
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
SCRATCH = ROOT / '.tmp' / 'card-background-study'
STYLES = ROOT / '_tools' / 'app' / 'src' / 'styles'


def data_url(path):
    mime = mimetypes.guess_type(path.name)[0] or 'application/octet-stream'
    return 'data:' + mime + ';base64,' + base64.b64encode(path.read_bytes()).decode('ascii')


def embed_css(path):
    css = path.read_text(encoding='utf-8')
    return re.sub(r'url\([\"\']?([^\)\"\']+)[\"\']?\)',
                  lambda match: 'url("' + data_url(path.parent / match[1]) + '")', css)


def main():
    html = (HERE / 'index.html').read_text(encoding='utf-8')
    for name in ['fonts.css', 'tokens.css', 'controls.css']:
        html = html.replace(f'<link rel="stylesheet" href="../../../_tools/app/src/styles/{name}">',
                            '<style>' + embed_css(STYLES / name) + '</style>')
    html = html.replace('fonts/Anton-Regular.ttf', data_url(HERE / 'fonts' / 'Anton-Regular.ttf'))
    html = html.replace('<script src="backgrounds.js"></script>',
                        '<script>' + (HERE / 'backgrounds.js').read_text(encoding='utf-8') + '</script>')
    for name in ['art1.webp', 'art2.webp', 'art3.jpg', 'art4.jpg', 'cut1.webp', 'cut2.webp']:
        html = html.replace('samples/' + name, data_url(SCRATCH / 'samples' / name))
    html = html.replace('</body>', '<script>if (!location.hash) location.hash = "s2";</script></body>')
    target = SCRATCH / 'card-background-preview.html'
    target.write_text(html, encoding='utf-8')
    print(f'{target} ({target.stat().st_size:,} bytes)')


if __name__ == '__main__':
    main()
