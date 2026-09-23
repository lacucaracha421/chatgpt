"""Synthetic-only JPEG draft benchmark; no storage, API or library access.

Run from server/lakomics-api:
    python3 tests/jpeg_thumbnail_benchmark.py --repeats 3

Each measurement is a fresh subprocess running the same still-image pipeline.
The full-decode baseline disables only JPEG draft(), retaining all other stages.
Fixture generation is a separate process so its allocations cannot inflate sample
RSS. Times cover open/decode/transpose/resize/WebP encode, not process startup or
fixture/output writes. RSS is the sample process high-water mark (Linux KiB).
Pixel error compares decoded WebP outputs, not perceptual quality acceptance.
"""
import argparse
from contextlib import nullcontext
import json
import math
from pathlib import Path
import random
import statistics
import subprocess
import sys
import tempfile
import time
from unittest import mock

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageStat, JpegImagePlugin, features

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import image_thumbnail_encode as encoder


FIXTURES = ("photo", "sharp-lines", "exif-portrait")


def generate(directory):
    rng = random.Random(20260923)
    texture = Image.frombytes("RGB", (384, 256), rng.randbytes(384 * 256 * 3))
    photo = texture.filter(ImageFilter.GaussianBlur(2)).resize(
        (4097, 3001), Image.Resampling.BICUBIC)
    draw = ImageDraw.Draw(photo)
    draw.ellipse((311, 401, 2689, 2703), fill=(78, 133, 92))
    draw.ellipse((501, 601, 2401, 2503), fill=(93, 148, 106))
    photo = photo.filter(ImageFilter.GaussianBlur(18))
    # Fine seeded texture over a smooth field, rather than a photographic claim.
    detail = Image.frombytes("L", (1024, 768), rng.randbytes(1024 * 768)).resize(photo.size)
    photo = Image.blend(photo, detail.convert("RGB"), 0.12)
    photo.save(directory / "photo.jpg", quality=93)

    lines = Image.new("RGB", (4097, 3001), "white")
    draw = ImageDraw.Draw(lines)
    for x in range(0, lines.width, 19):
        draw.line((x, 0, x, lines.height), fill=(0, 0, 0), width=3)
    for y in range(0, lines.height, 29):
        draw.line((0, y, lines.width, y + 331), fill=(190, 25, 60), width=5)
    draw.rectangle((333, 401, 3001, 2303), outline=(0, 60, 255), width=17)
    lines.save(directory / "sharp-lines.jpg", quality=93)

    portrait = photo.resize((5003, 3001), Image.Resampling.BICUBIC)
    ImageDraw.Draw(portrait).rectangle((51, 101, 900, 1500), fill=(210, 63, 42))
    exif = Image.Exif()
    exif[274] = 6
    portrait.save(directory / "exif-portrait.jpg", quality=93, exif=exif)


def sample(mode, source, output):
    import resource

    context = (mock.patch.object(JpegImagePlugin.JpegImageFile, "draft", return_value=None)
               if mode == "full" else nullcontext())
    with context:
        started = time.perf_counter()
        payload, metadata = encoder._still_thumbnail(source, encoder.KIND_IMAGE)
        elapsed = time.perf_counter() - started
    peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    Path(output).write_bytes(payload)
    print(json.dumps({"seconds": elapsed, "peak_rss_kib": peak,
                      "bytes": len(payload), "metadata": metadata}))


def run_child(*args):
    result = subprocess.run([sys.executable, str(Path(__file__).resolve()), *map(str, args)],
                            check=True, capture_output=True, text=True, timeout=60)
    return result.stdout


def benchmark(repeats):
    if not sys.platform.startswith("linux"):
        raise SystemExit("RSS units in this focused benchmark require Linux")
    print(json.dumps({"python": sys.version.split()[0], "pillow": Image.__version__,
                      "libjpeg_turbo": features.version("libjpeg_turbo"),
                      "repeats": repeats, "seed": 20260923}))
    with tempfile.TemporaryDirectory(prefix="jpeg-fixture-benchmark-") as temporary:
        directory = Path(temporary)
        run_child("--generate", directory)
        for fixture in FIXTURES:
            samples = {"full": [], "draft": []}
            source = directory / f"{fixture}.jpg"
            with Image.open(source) as image:
                original = image.size
                image.draft(image.mode, tuple(edge * min(1, 1024 / max(original))
                                              for edge in original))
                reduced = image.size
            for repetition in range(repeats):
                for mode in (("full", "draft") if repetition % 2 == 0 else ("draft", "full")):
                    samples[mode].append(json.loads(run_child(
                        "--sample", mode, source, directory / f"{mode}.webp")))
            with Image.open(directory / "full.webp") as full, Image.open(directory / "draft.webp") as draft:
                assert full.size == draft.size
                difference = ImageStat.Stat(ImageChops.difference(full.convert("RGB"), draft.convert("RGB")))
                mae = statistics.mean(difference.mean)
                mse = statistics.mean(value ** 2 for value in difference.rms)
                metrics = {"mae_8bit": round(mae, 4),
                           "psnr_db": round(10 * math.log10(255 ** 2 / mse), 3) if mse else None,
                           "output_size": full.size}
            assert samples["full"][0]["metadata"] == samples["draft"][0]["metadata"]
            summary = {}
            for mode, results in samples.items():
                summary[mode] = {
                    "ms_samples": [round(item["seconds"] * 1000, 3) for item in results],
                    "median_ms": round(statistics.median(item["seconds"] for item in results) * 1000, 3),
                    "peak_rss_kib_samples": [item["peak_rss_kib"] for item in results],
                    "median_peak_rss_kib": statistics.median(item["peak_rss_kib"] for item in results),
                    "output_bytes": results[0]["bytes"],
                }
            print(json.dumps({"fixture": fixture, "original_size": original,
                              "draft_size": reduced, "metadata": samples["draft"][0]["metadata"],
                              **summary, **metrics}), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repeats", type=int, choices=range(1, 8), default=3)
    parser.add_argument("--generate", type=Path)
    parser.add_argument("--sample", nargs=3, metavar=("MODE", "SOURCE", "OUTPUT"))
    args = parser.parse_args()
    if args.generate:
        generate(args.generate)
    elif args.sample:
        sample(*args.sample)
    else:
        benchmark(args.repeats)
