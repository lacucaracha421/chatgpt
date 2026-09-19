"""Isolated single-image thumbnail encoder.

Run as a child process by :mod:`image_thumbnails` and never imported by the API
process: Pillow is imported here *only*, so a decoder crash, a decompression bomb
or an unbounded allocation cannot take the API down with it.

This process bounds *itself*, at the very start of :func:`main` and before Pillow
is imported: CPU time, address space and scheduling priority. That ordering is
deliberate. The parent spawns this child from a threaded request-serving process,
where a ``preexec_fn`` callback runs between ``fork`` and ``exec`` in a process
whose other threads may hold locks — a documented deadlock risk — so the parent
passes no callback at all. It still supplies the wall-clock timeout, which is the
one bound that cannot be self-applied.

Usage::

    python image_thumbnail_encode.py <input-path> <output-path>

Exit codes are the whole contract, because stdout/stderr are never trusted and
never echoed to a client:

    0  success — ``<output-path>`` holds a complete WebP thumbnail
    2  usage error (wrong argument count)
    3  unsupported platform — this process could not bound its own resources
    4  unsupported input — not a decodable single-frame JPEG/PNG/WebP, too many
       pixels, or a frame that cannot be transposed/scaled
    5  encode failed (including an oversize result)
    6  unexpected internal failure

Deliberately absent: any diagnostic message that could contain a filename,
object key, signed URL or credential.
"""
import io
import os
import sys
import warnings

EXIT_OK = 0
EXIT_USAGE = 2
EXIT_UNSUPPORTED_PLATFORM = 3
EXIT_UNSUPPORTED_INPUT = 4
EXIT_ENCODE_FAILED = 5
EXIT_INTERNAL = 6

#: Longest output edge, in pixels. The product wants one dense-list thumbnail
#: size for now; MEDIA-R2-001 can add further immutable variants later.
MAX_EDGE = 512

#: Hard ceiling on decoded pixels, well below Pillow's default bomb threshold of
#: ~89 MP. A 24 MP source is already far beyond what a 512 px tile needs and keeps
#: the worst-case decoded buffer inside the address-space limit below.
MAX_PIXELS = 24_000_000

#: Hard ceiling on the encoded artifact. A 512 px WebP is normally tens of KB, so
#: this only fires on something pathological and keeps the R2 object predictable.
MAX_OUTPUT_BYTES = 2 * 1024 * 1024

#: WebP quality and effort. ``method=4`` is the "moderate" middle of Pillow's 0-6
#: range: materially better than the fastest setting without the slowest one's CPU
#: time, which matters on a single-core host.
WEBP_QUALITY = 80
WEBP_METHOD = 4

#: Address-space and CPU ceilings this process applies to itself. Sized for a 512 px
#: encode: a bounded 24 MP decode plus a Lanczos resize fits comfortably, while a
#: decompression bomb does not.
ADDRESS_SPACE_BYTES = 384 * 1024 * 1024
CPU_LIMIT_SECONDS = 10
#: Linux niceness. The host is a 1 vCPU VPS serving live requests, so encoding must
#: yield to the API under any contention. Ignored where the host has no such notion.
NICENESS = 10

#: Source formats this worker accepts. GIF (animated or not), video containers and
#: everything else are out of scope: the Asset kind gate already excludes them and
#: this list makes the encoder's own contract explicit rather than implicit.
SUPPORTED_FORMATS = ("JPEG", "PNG", "WEBP")

#: Modes kept as-is; everything else is converted to ``RGBA`` when it carries
#: transparency and ``RGB`` otherwise, so a transparent source is never flattened onto
#: opaque black.
PASSTHROUGH_MODES = ("RGB", "L")


class _UnsupportedInput(Exception):
    pass


class _EncodeFailed(Exception):
    pass


def main(argv):
    if len(argv) != 3:
        return EXIT_USAGE
    input_path, output_path = argv[1], argv[2]

    if not _apply_own_resource_limits():
        # Fail closed. Without an address-space cap an image that decodes to gigabytes
        # would be bounded only by luck, and the host has under a gigabyte to spare.
        return EXIT_UNSUPPORTED_PLATFORM

    try:
        payload = _encode(input_path)
    except _UnsupportedInput:
        return EXIT_UNSUPPORTED_INPUT
    except _EncodeFailed:
        return EXIT_ENCODE_FAILED
    except BaseException:
        return EXIT_INTERNAL

    # Write through a sibling temp path so a crash mid-write cannot leave a partial
    # file that the parent would upload as a valid thumbnail.
    temporary_path = f"{output_path}.part"
    try:
        with open(temporary_path, "wb") as handle:
            handle.write(payload)
        os.replace(temporary_path, output_path)
    except OSError:
        _discard(temporary_path)
        return EXIT_ENCODE_FAILED
    return EXIT_OK


def _apply_own_resource_limits():
    """Bound this process before any decoding is possible. Returns success.

    Called first thing in :func:`main`, ahead of the Pillow import, so the limits are
    in force for the entire decode. ``resource`` is POSIX-only and the memory limit is
    not meaningful on Windows, so both are treated as "cannot bound myself" and the
    caller refuses to encode rather than proceeding unbounded.
    """
    try:
        import resource
    except ImportError:
        return False
    try:
        os.nice(NICENESS)
    except (AttributeError, OSError):
        # Priority is a courtesy, not a safety bound: a host without ``nice`` still
        # gets the CPU and memory caps below. A failure here is deliberately fatal on
        # Linux anyway, because it means this is not the POSIX platform assumed.
        if os.name != "posix":
            return False
    try:
        _soft, hard = resource.getrlimit(resource.RLIMIT_AS)
        limit = ADDRESS_SPACE_BYTES
        if hard != resource.RLIM_INFINITY:
            limit = min(limit, hard)
        resource.setrlimit(resource.RLIMIT_AS, (limit, limit))
        resource.setrlimit(resource.RLIMIT_CPU, (CPU_LIMIT_SECONDS, CPU_LIMIT_SECONDS + 5))
    except (AttributeError, ValueError, OSError):
        return False
    # Read the effective limit back: a platform that accepts setrlimit but does not
    # enforce it would otherwise let this process decode unbounded while believing
    # it is capped.
    try:
        effective, _hard = resource.getrlimit(resource.RLIMIT_AS)
    except (AttributeError, ValueError, OSError):
        return False
    return effective != resource.RLIM_INFINITY


def _discard(path):
    try:
        os.unlink(path)
    except OSError:
        pass


def _encode(input_path):
    from PIL import Image

    # Pillow only *warns* between MAX_IMAGE_PIXELS and twice it, and warns rather than
    # raises at all while the warning filter is permissive. Turning the class into an
    # error is what makes the ceiling hard; ``_check_pixel_budget`` below is the second
    # line of defence for a plugin that reports dimensions without triggering Pillow's
    # own check.
    Image.MAX_IMAGE_PIXELS = MAX_PIXELS
    warnings.simplefilter("error", Image.DecompressionBombWarning)

    try:
        with Image.open(input_path) as image:
            if image.format not in SUPPORTED_FORMATS:
                raise _UnsupportedInput
            # Before any decode: refuse a bomb on its declared size, so the guard does
            # not depend on surviving the allocation it is meant to prevent.
            _check_pixel_budget(image.width, image.height)
            if _frame_count(image) > 1:
                # Animated WebP/PNG is rejected rather than silently taken as frame 0.
                # A tile that animates is a different product decision, and pretending
                # a still frame is representative is the kind of quiet wrong answer
                # this worker exists to avoid.
                raise _UnsupportedInput
            image.seek(0)
            # A truncated file must fail here, not at save time with a half-decoded
            # buffer whose pixels are silently zeroed.
            image.load()
            frame = _transposed(image)
            _check_pixel_budget(frame.width, frame.height)
            thumbnail = _scaled(frame)
            sink = io.BytesIO()
            thumbnail.save(sink, format="WEBP", quality=WEBP_QUALITY, method=WEBP_METHOD)
            payload = sink.getvalue()
    except _UnsupportedInput:
        raise
    except (Image.DecompressionBombError, Image.DecompressionBombWarning):
        raise _UnsupportedInput
    except (OSError, ValueError, SyntaxError, MemoryError, EOFError):
        raise _UnsupportedInput

    if not payload or len(payload) > MAX_OUTPUT_BYTES:
        raise _EncodeFailed
    return payload


def _check_pixel_budget(width, height):
    """Reject a frame whose declared pixel count exceeds the ceiling."""
    try:
        pixels = int(width) * int(height)
    except (TypeError, ValueError):
        raise _UnsupportedInput
    if pixels <= 0 or pixels > MAX_PIXELS:
        raise _UnsupportedInput


def _frame_count(image):
    """Frames in an opened image, or 1 when the plugin does not report them."""
    try:
        return int(image.n_frames)
    except (AttributeError, TypeError, ValueError):
        return 1


def _transposed(image):
    """Apply the EXIF orientation tag, then drop it, preserving transparency.

    ``ImageOps.exif_transpose`` rewrites the tag to 1, but the upload carries no EXIF
    at all, so unread orientation metadata cannot re-rotate the thumbnail downstream.
    """
    from PIL import ImageOps

    try:
        upright = ImageOps.exif_transpose(image)
    except (OSError, ValueError, SyntaxError):
        raise _UnsupportedInput
    if upright is not image:
        upright.load()
    if upright.mode in PASSTHROUGH_MODES:
        return upright
    if _carries_transparency(upright):
        return upright if upright.mode == "RGBA" else upright.convert("RGBA")
    return upright.convert("RGB")


def _carries_transparency(image):
    """True when this frame has an alpha channel or a palette transparency entry.

    Checking the mode name alone is not enough: a ``P``-mode PNG carries its alpha in
    the palette's ``transparency`` entry, so it must convert to ``RGBA`` to keep it.
    Converting such a frame to ``RGB`` silently renders every transparent pixel black.
    """
    if image.mode in ("RGBA", "LA", "PA", "La"):
        return True
    try:
        if "transparency" in image.info:
            return True
        if image.mode == "P":
            return "A" in image.getbands()
    except (AttributeError, ValueError, OSError):
        return False
    return False


def _scaled(image):
    """Longest edge ``MAX_EDGE``, aspect preserved, never upscaled."""
    from PIL import Image

    longest = max(image.width, image.height)
    if longest <= MAX_EDGE:
        return image
    scale = MAX_EDGE / longest
    target = (max(1, round(image.width * scale)), max(1, round(image.height * scale)))
    return image.resize(target, Image.Resampling.LANCZOS)


if __name__ == "__main__":
    sys.exit(main(sys.argv))
