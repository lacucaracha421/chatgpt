"""Character cutouts for the card pop-out layer (CARD-GACHA-001 slice 4).

A small NDJSON worker owned by the Rust app (`card_cutouts`), separate from `scan_worker.py`.
It loads the ToonOut BiRefNet model (`birefnet-toonout-fp16.onnx`, MIT) once and cuts one
library image at a time. The app supplies the model path and verifies its hash; this script
never downloads anything, never touches SQLite and only writes the output it was asked for.

Pipeline (validated against other models on 2026-10-15):
  input  [1,3,1024,1024] float32, plain resize (no aspect keep), /255, ImageNet normalisation
  output 'mask' [1,1,1024,1024], already a sigmoid, resized with Lanczos to the output size
  edge   light decontamination only: the background colour is estimated from the image border
         and removed from partly transparent pixels within a few pixels of the edge; the alpha
         itself is never changed, so nothing inside the mask is removed
  fill   the RGB of fully transparent pixels is filled from nearby foreground so scaling and
         texture filtering never pull in a dark or white halo
  output at most 1100 px on the long edge, WebP with alpha (q 90), at most 2 MiB (PNG otherwise)

Requests (one JSON object per line on stdin):
  {"type":"cutout","id":"...","src":"<image path>","dstStem":"<output path without extension>"}
  {"type":"shutdown"}
Replies (one JSON object per line on stdout):
  {"type":"ready","provider":"DmlExecutionProvider","model":"toonout-1"}
  {"type":"result","id":"...","ok":true,"file":"...","contentType":"image/webp","sha256":"...",
   "sizeBytes":123,"width":800,"height":1100,"ms":1234}
  {"type":"result","id":"...","ok":false,"error":"..."}
"""
import argparse
import hashlib
import io
import json
import os
import sys
import time
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter, ImageOps

MODEL_ID = "toonout-1"
SIZE = 1024
MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)
MAX_EDGE = 1100
MAX_BYTES = 2 * 1024 * 1024
WEBP_QUALITIES = (90, 82, 72)
EDGE_BAND = 3          # pixels from the edge that get decontaminated
FILL_STEPS = 12        # pixels transparent RGB is grown from the foreground
MIN_ALPHA = 0.2        # lowest coverage divided by when removing the background colour


def load_rgb(path):
    """The image as RGB, upright; transparency is composited on white."""
    with Image.open(path) as source:
        image = ImageOps.exif_transpose(source)
        if image.mode in ("RGBA", "LA", "PA") or "transparency" in image.info:
            rgba = image.convert("RGBA")
            flat = Image.new("RGBA", rgba.size, (255, 255, 255, 255))
            flat.alpha_composite(rgba)
            return flat.convert("RGB")
        return image.convert("RGB")


def preprocess(image):
    """[1,3,1024,1024] float32 model input."""
    small = image.resize((SIZE, SIZE), Image.BILINEAR)
    array = np.asarray(small, dtype=np.float32) / 255.0
    array = (array - MEAN) / STD
    return np.ascontiguousarray(array.transpose(2, 0, 1)[None], dtype=np.float32)


def mask_to_alpha(mask, size):
    """The model's sigmoid mask as an 8-bit alpha plane of `size` (width, height)."""
    array = np.asarray(mask, dtype=np.float32)
    if array.shape != (1, 1, SIZE, SIZE) or not np.isfinite(array).all():
        raise ValueError("unexpected mask output")
    plane = Image.fromarray(np.clip(array[0, 0], 0.0, 1.0), mode="F")
    resized = np.asarray(plane.resize(size, Image.LANCZOS), dtype=np.float32)
    return (np.clip(resized, 0.0, 1.0) * 255.0 + 0.5).astype(np.uint8)


def fit_size(size, limit=MAX_EDGE):
    width, height = size
    scale = min(1.0, limit / max(width, height))
    return max(1, round(width * scale)), max(1, round(height * scale))


def border_colour(rgb, alpha):
    """Median colour of the image border, preferring pixels the mask calls background."""
    height, width = alpha.shape
    thickness = max(2, round(min(height, width) * 0.02))
    ring = np.zeros((height, width), dtype=bool)
    ring[:thickness] = ring[-thickness:] = True
    ring[:, :thickness] = ring[:, -thickness:] = True
    chosen = ring & (alpha < 26)
    if int(chosen.sum()) < 16:
        chosen = ring
    return np.median(rgb[chosen].reshape(-1, 3), axis=0).astype(np.float32)


def decontaminate(rgb, alpha, background=None):
    """Removes the background colour from partly transparent pixels near the edge.

    F = (I - (1 - a) * B) / a, clamped. Opaque and fully transparent pixels are untouched and
    the alpha plane is not an output, so no pixel inside the mask can disappear.
    """
    if background is None:
        background = border_colour(rgb, alpha)
    nearest_background = np.asarray(
        Image.fromarray(alpha).filter(ImageFilter.MinFilter(2 * EDGE_BAND + 1)))
    band = (alpha > 0) & (alpha < 255) & (nearest_background < 128)
    if not band.any():
        return rgb
    coverage = np.maximum(alpha[band].astype(np.float32) / 255.0, MIN_ALPHA)[:, None]
    observed = rgb[band].astype(np.float32)
    foreground = (observed - (1.0 - coverage) * np.asarray(background, dtype=np.float32)) / coverage
    out = rgb.copy()
    out[band] = np.clip(foreground + 0.5, 0, 255).astype(np.uint8)
    return out


def fill_transparent(rgb, alpha, steps=FILL_STEPS):
    """Grows foreground colour into fully transparent pixels (the alpha stays 0 there)."""
    known = alpha > 0
    if not known.any() or known.all():
        return rgb
    colour = rgb.astype(np.float32)
    weight = known.astype(np.float32)
    colour *= weight[..., None]
    mean = colour[known].mean(axis=0)
    for _ in range(steps):
        pending = weight == 0
        if not pending.any():
            break
        padded_w = np.pad(weight, 1)
        padded_c = np.pad(colour, ((1, 1), (1, 1), (0, 0)))
        total_w = np.zeros_like(weight)
        total_c = np.zeros_like(colour)
        for dy in (0, 1, 2):
            for dx in (0, 1, 2):
                if dy == 1 and dx == 1:
                    continue
                total_w += padded_w[dy:dy + weight.shape[0], dx:dx + weight.shape[1]]
                total_c += padded_c[dy:dy + weight.shape[0], dx:dx + weight.shape[1]]
        grow = pending & (total_w > 0)
        if not grow.any():
            break
        colour[grow] = total_c[grow] / total_w[grow][:, None]
        weight[grow] = 1.0
    colour[weight == 0] = mean
    out = rgb.copy()
    transparent = alpha == 0
    out[transparent] = np.clip(colour[transparent] + 0.5, 0, 255).astype(np.uint8)
    return out


def encode(rgba):
    """(bytes, content type, extension) of the smallest acceptable file at most MAX_BYTES."""
    image = rgba
    for _ in range(4):
        for quality in WEBP_QUALITIES:
            buffer = io.BytesIO()
            image.save(buffer, "WEBP", quality=quality, method=4, exact=True)
            if buffer.tell() <= MAX_BYTES:
                return buffer.getvalue(), "image/webp", "webp"
        buffer = io.BytesIO()
        image.save(buffer, "PNG", optimize=True)
        if buffer.tell() <= MAX_BYTES:
            return buffer.getvalue(), "image/png", "png"
        image = image.resize(fit_size(image.size, round(max(image.size) * 0.85)), Image.LANCZOS)
    raise ValueError("cutout does not fit in 2 MiB")


def compose(image, mask, limit=MAX_EDGE):
    """Final RGBA cutout of `image` (RGB) from the model's `mask`."""
    size = fit_size(image.size, limit)
    resized = image if size == image.size else image.resize(size, Image.LANCZOS)
    alpha = mask_to_alpha(mask, size)
    rgb = np.asarray(resized, dtype=np.uint8)
    rgb = fill_transparent(decontaminate(rgb, alpha), alpha)
    out = np.dstack([rgb, alpha])
    return Image.fromarray(out, mode="RGBA")


def create_session(model, provider="auto"):
    """(session, provider name). DirectML first when asked and available, otherwise CPU."""
    import onnxruntime as ort

    ort.set_default_logger_severity(3)

    def options(threads):
        value = ort.SessionOptions()
        value.log_severity_level = 3
        value.enable_mem_pattern = False
        value.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        if threads:
            value.intra_op_num_threads = threads
        return value

    if provider in ("auto", "dml") and "DmlExecutionProvider" in ort.get_available_providers():
        try:
            session = ort.InferenceSession(str(model), sess_options=options(0),
                                           providers=["DmlExecutionProvider", "CPUExecutionProvider"])
            # ORT can silently retry with CPU after a provider initialization failure.
            if "DmlExecutionProvider" in session.get_providers():
                return session, "DmlExecutionProvider"
        except Exception as error:  # noqa: BLE001 - any provider failure falls back to CPU
            print(f"DirectML unavailable; using CPU: {error}", file=sys.stderr, flush=True)
    threads = max(2, min(6, (os.cpu_count() or 4) // 2))
    session = ort.InferenceSession(str(model), sess_options=options(threads),
                                   providers=["CPUExecutionProvider"])
    return session, "CPUExecutionProvider"


class Cutter:
    def __init__(self, model, provider="auto", session=None, provider_name=None):
        self.model = model
        self.preference = provider
        if session is None:
            session, provider_name = create_session(model, provider)
        self.session, self.provider = session, provider_name or "CPUExecutionProvider"
        self.input_name = self.session.get_inputs()[0].name
        self.output_name = self.session.get_outputs()[0].name

    def predict(self, image):
        blob = preprocess(image)
        try:
            return self.session.run([self.output_name], {self.input_name: blob})[0]
        except Exception:
            if self.provider == "CPUExecutionProvider" or self.model is None:
                raise
            # A GPU-only failure on one image must not stop the queue: retry once on the CPU.
            self.session, self.provider = create_session(self.model, "cpu")
            return self.session.run([self.output_name], {self.input_name: blob})[0]

    def cut(self, src, dst_stem):
        started = time.perf_counter()
        image = load_rgb(src)
        rgba = compose(image, self.predict(image))
        data, content_type, extension = encode(rgba)
        final = Path(f"{dst_stem}.{extension}")
        final.parent.mkdir(parents=True, exist_ok=True)
        temporary = final.with_name(final.name + ".part")
        temporary.write_bytes(data)
        os.replace(temporary, final)
        return {"file": str(final), "contentType": content_type,
                "sha256": hashlib.sha256(data).hexdigest(), "sizeBytes": len(data),
                "width": rgba.width, "height": rgba.height,
                "ms": round((time.perf_counter() - started) * 1000)}


def handle(cutter, request):
    """One request to one reply; a failed image never raises."""
    if request.get("type") != "cutout":
        return {"type": "result", "id": request.get("id"), "ok": False, "error": "unknown request"}
    try:
        result = cutter.cut(request["src"], request["dstStem"])
        return {"type": "result", "id": request.get("id"), "ok": True, **result}
    except Exception as error:  # noqa: BLE001 - reported to the owner, which decides to retry
        return {"type": "result", "id": request.get("id"), "ok": False,
                "error": f"{type(error).__name__}: {error}"[:300]}


def emit(value):
    sys.stdout.write(json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def serve(cutter, lines=None):
    emit({"type": "ready", "provider": cutter.provider, "model": MODEL_ID})
    for line in lines if lines is not None else sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except ValueError:
            emit({"type": "result", "id": None, "ok": False, "error": "invalid request"})
            continue
        if request.get("type") == "shutdown":
            return
        emit(handle(cutter, request))


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--model", required=True, type=Path)
    parser.add_argument("--provider", choices=("auto", "dml", "cpu"), default="auto")
    parser.add_argument("--once", nargs=2, metavar=("SRC", "DST_STEM"),
                        help="cut one image and print the result instead of serving stdin")
    args = parser.parse_args(argv)
    cutter = Cutter(args.model, args.provider)
    if args.once:
        emit({"type": "ready", "provider": cutter.provider, "model": MODEL_ID})
        emit(handle(cutter, {"type": "cutout", "id": "once", "src": args.once[0], "dstStem": args.once[1]}))
        return 0
    serve(cutter)
    return 0


if __name__ == "__main__":
    sys.exit(main())
