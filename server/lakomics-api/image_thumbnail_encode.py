"""Isolated single-source thumbnail encoder for images, GIFs and videos.

Run as a child process by :mod:`image_thumbnails` and never imported by the API
process: Pillow is imported here *only*, so a decoder crash, a decompression bomb
or an unbounded allocation cannot take the API down with it. Only video sources
reach the external FFmpeg toolchain; images and GIFs are decoded by Pillow alone.

This process bounds *itself*, at the very start of :func:`main` and before Pillow
is imported: CPU time, address space and scheduling priority. That ordering is
deliberate. The parent spawns this child from a threaded request-serving process
and passes no ``preexec_fn``: it still supplies the wall-clock timeout, which is
the one bound that cannot be self-applied.

Because that timeout can only kill the whole outer process, this process never
calls ``setsid`` or otherwise leaves the session or process group it was started
in. Its tool subprocesses stay inside the same group, so the parent's group kill
reaches them even when this process is killed first.

Usage::

    python image_thumbnail_encode.py <input-path> <output-path> [image|gif|video]

The third argument is the source kind and defaults to ``image``. On success the
thumbnail is written to ``<output-path>`` and its metadata to ``<output-path>.json``:

    {"width": <int>, "height": <int>, "duration_ms": <int|null>}

``width`` and ``height`` are the *source's* display dimensions after EXIF/rotation
normalisation, not the thumbnail's — a 512 px tile must
not turn a 1600x900 video into 512x288 metadata. ``duration_ms`` is an integer
millisecond count or ``null`` when the source does not declare one; it is never
negative.

Exit codes are the whole contract, because stdout/stderr are never trusted and
never echoed to a client:

    0  success — the output and its sidecar hold a complete thumbnail and metadata
    2  usage error (wrong argument count, or an unknown kind)
    3  unsupported platform — this process could not bound its own resources
    4  unsupported input — an undecodable, animated, oversize or otherwise rejected
       source, a kind mismatch, or a container outside the demux whitelist
    5  encode failed (including an oversize result, or a tool that failed, timed out,
       wrote an artifact this process refused to read, or wrote past its output bound)
    6  unexpected internal failure
    7  tool unavailable — the packages this kind needs are absent: FFmpeg and FFprobe
       for video, and Pillow for every kind

Both artifacts are written through sibling temp paths and renamed last, so an error
exit leaves no output at all: never a thumbnail without its sidecar, and never a
partial file the parent could upload as a usable result. The sidecar is bounded by
``MAX_METADATA_BYTES`` and the thumbnail by ``MAX_OUTPUT_BYTES``.

Deliberately absent: any diagnostic message that could contain a filename,
object key, signed URL or credential.
"""
import io
import json
import math
import os
import selectors
import shutil
import subprocess
import sys
import tempfile
import time
import warnings

EXIT_OK = 0
EXIT_USAGE = 2
EXIT_UNSUPPORTED_PLATFORM = 3
EXIT_UNSUPPORTED_INPUT = 4
EXIT_ENCODE_FAILED = 5
EXIT_INTERNAL = 6
#: A missing FFmpeg/FFprobe, or a missing Pillow. Distinct from every other failure
#: because no retry and no different input can change it: the host is not provisioned
#: to encode this kind of source.
EXIT_TOOL_UNAVAILABLE = 7

#: Absolute paths, not bare names. Nothing in this process reads PATH, which is what
#: makes "is FFmpeg installed" a decidable question with one answer: either the binary
#: the deployment provides is at that path or the encoder reports EXIT_TOOL_UNAVAILABLE.
#: A PATH lookup with no ``PATH`` in the environment still finds the system directories,
#: which would make this process behave differently depending on how it was spawned.
#: Overridable as a whole, for a host that installs its tools somewhere else.
FFMPEG = os.environ.get("LAKOMICS_FFMPEG") or "/usr/bin/ffmpeg"
FFPROBE = os.environ.get("LAKOMICS_FFPROBE") or "/usr/bin/ffprobe"

#: Longest output edge, in pixels. The product wants one dense-list thumbnail size
#: for now; MEDIA-R2-001 can add further immutable variants later. A source whose
#: longest edge is already under this is written at its own size, never upscaled.
MAX_EDGE = 512

#: Hard ceiling on decoded pixels, well below Pillow's default bomb threshold of
#: ~89 MP. A 24 MP source is already far beyond what a 512 px tile needs and keeps
#: the worst-case decoded buffer inside the address-space limit below.
MAX_PIXELS = 24_000_000

#: Hard ceiling on the encoded artifact. A 512 px WebP is normally tens of KB, so
#: this only fires on something pathological and keeps the R2 object predictable. The
#: tool is asked to write at most this many bytes plus one, so a tool that ignores the
#: ceiling is caught by the read bound rather than by the write that overshot it.
MAX_OUTPUT_BYTES = 2 * 1024 * 1024

#: Hard ceiling on the metadata sidecar. Three short keys cannot legitimately approach
#: this; the bound exists so a sidecar can never become a way to smuggle arbitrary data
#: into whatever reads it.
MAX_METADATA_BYTES = 4096

#: WebP quality and effort. ``method=4`` is the "moderate" middle of Pillow's 0-6
#: range: materially better than the fastest setting without the slowest one's CPU
#: time, which matters on a single-core host.
WEBP_QUALITY = 80
WEBP_METHOD = 4

#: Address-space and CPU ceilings this process applies to itself, and CPU for its tool
#: children. Sized for a 512 px encode: a bounded 24 MP decode plus a Lanczos resize fits
#: within the cap for ordinary inputs; larger allocations fail closed. Tool children
#: inherit resource limits across fork/exec, independently of session membership.
ADDRESS_SPACE_BYTES = 384 * 1024 * 1024
CPU_LIMIT_SECONDS = 10
#: Linux niceness. The host is a 1 vCPU VPS serving live requests, so encoding must
#: yield to the API under any contention. Ignored where the host has no such notion.
NICENESS = 10

#: Source formats this worker accepts as static images. Animated WebP/PNG stay out of
#: scope: an animated tile is a product decision, and taking frame 0 silently would be a
#: quietly wrong answer. GIF is accepted separately, as a first-frame still.
SUPPORTED_FORMATS = ("JPEG", "PNG", "WEBP")

#: Kinds this worker can be asked for, as the optional last argv entry.
KIND_IMAGE = "image"
KIND_GIF = "gif"
KIND_VIDEO = "video"
KINDS = (KIND_IMAGE, KIND_GIF, KIND_VIDEO)

#: Formats a kind="gif" request accepts. Pillow reports a still GIF and an animated GIF
#: identically, which is the point: either way the first frame is the preview.
GIF_FORMATS = ("GIF",)

#: FFprobe's own I/O timeout, in microseconds. It bounds a *read* that stalls; it says
#: nothing about a header the demuxer chews on without ever reading, which is why the
#: outer wall clock below exists as well.
PROBE_TIMEOUT_MICROSECONDS = 5_000_000
#: Outer wall clock on FFprobe, above its own I/O timeout. A probe that never reaches I/O
#: would otherwise run until the worker's outer timeout killed the whole group, turning a
#: single rejected object into a timed-out job. Kept under the worker's 20-second child
#: budget so this process always gets to report its own exit code.
PROBE_WALL_SECONDS = 6.0
DECODE_TIMEOUT_SECONDS = 8.0
#: Grace between SIGTERM and SIGKILL when a timed-out tool is reaped.
GRACE_SECONDS = 1.0
#: Bound on how many times a timed-out tool may be signalled before the encoder gives up.
#: Only a child that ignores SIGKILL could reach this, and it must not hang the worker.
MAX_REAP_ATTEMPTS = 2
#: Per-stream read cap inside :func:`_read_capped`. Small enough that a tool flooding a
#: pipe is dropped quickly, large enough that no single read needs a large allocation.
TOOL_READ_CHUNK_BYTES = 64 * 1024

#: Container whitelist, not a blacklist: only the containers the product actually
#: captures may be demuxed. The demuxer is chosen by these names, so a playlist (HLS,
#: DASH) or any other external-reference format is never given a demuxer at all. FFmpeg
#: also accepts these as the comma-separated aliases it prints for one demuxer
#: (``mov,mp4,m4a,3gp,3g2,mj2`` and ``matroska,webm``), which is why either spelling can
#: be passed on the command line or read back from a probe.
VIDEO_FORMATS = frozenset({"mov", "mp4", "m4a", "3gp", "3g2", "mj2", "matroska", "webm"})
#: Disable network protocols. This is not a filesystem sandbox; MOV external
#: references are separately disabled with enable_drefs=0.
PROTOCOL_WHITELIST = "file,pipe"
#: Only the two supported demuxer families may open an input.
INPUT_FORMAT = "mov,matroska"

#: Bound on the probe's result, applied while its pipe is read: a probe that writes more
#: than this is a failure, not a larger report. ffprobe's JSON for one stream is a few
#: hundred bytes, so the cap only fires on something pathological.
MAX_PROBE_BYTES = 1 << 20
#: Stderr byte ceiling. Content is never retained or exposed; exceeding this count
#: terminates the tool rather than draining an unlimited diagnostic stream.
MAX_TOOL_STDERR_BYTES = 64 * 1024

# Choose one later timestamp rather than analyzing/scanning frames for brightness.
# This reduces opening-black posters but cannot guarantee a non-black frame.
VIDEO_SEEK_FRACTION = 0.1
# Keep the previous 500 ms target for ordinary short captures; the half-duration
# ceiling below keeps sub-second clips inside their declared timeline.
VIDEO_SEEK_FLOOR_MS = 500
#: Ceiling on the seek, in milliseconds. Without it a multi-hour capture would take its
#: poster minutes in, which is later than a preview should go.
VIDEO_SEEK_CAP_MS = 3_000
#: Seek used when the container declares no usable duration.
VIDEO_SEEK_FALLBACK_MS = 500
#: Ceiling on the whole seek, as a declared-duration fraction. A shorter capture cannot hold
#: the floor above without landing on or past its own declared end, so it is seeked to its
#: middle instead, which keeps the point strictly inside the source.
#:
#: The bound is not a threshold: it applies to every declared duration, so it cannot make the
#: seek jump backwards as the duration grows. On any capture long enough to exceed twice the
#: floor it is inert, and the floor and cap above are what choose the point.
VIDEO_SEEK_SHORT_CEILING_FRACTION = 0.5
#: Seek precision passed to FFmpeg, in seconds. Three decimals match the whole-millisecond
#: seek this worker computes and the desktop poster's ``%d.%03d`` spelling.
VIDEO_SEEK_PRECISION_SECONDS = 3
#: Seek used for the retry that takes a source's *first* frame, as a seconds string. It is
#: only reached when the duration-relative seek decoded cleanly and produced no frame at all.
VIDEO_FIRST_FRAME_SEEK_SECONDS = "0.000"

#: Modes kept as-is; everything else is converted to ``RGBA`` when it carries
#: transparency and ``RGB`` otherwise, so a transparent source is never flattened onto
#: opaque black.
PASSTHROUGH_MODES = ("RGB", "L")


class _UnsupportedInput(Exception):
    pass


class _EncodeFailed(Exception):
    pass


def main(argv):
    if len(argv) < 3 or len(argv) > 4:
        return EXIT_USAGE
    input_path, output_path = argv[1], argv[2]
    kind = argv[3] if len(argv) > 3 else KIND_IMAGE
    if kind not in KINDS:
        return EXIT_USAGE

    if not _apply_own_resource_limits():
        # Fail closed. Without an address-space cap an image that decodes to gigabytes
        # would be bounded only by luck, and the host has under a gigabyte to spare.
        return EXIT_UNSUPPORTED_PLATFORM

    try:
        if not _pillow_available():
            return EXIT_TOOL_UNAVAILABLE
        if kind == KIND_VIDEO:
            if not _toolchain_available():
                return EXIT_TOOL_UNAVAILABLE
            payload, metadata = _video_thumbnail(input_path)
        else:
            # The image and GIF paths are Pillow's alone: neither consults the external
            # toolchain, so a host without FFmpeg still previews every image it accepts.
            payload, metadata = _still_thumbnail(input_path, kind)
    except _UnsupportedInput:
        return EXIT_UNSUPPORTED_INPUT
    except _EncodeFailed:
        return EXIT_ENCODE_FAILED
    except BaseException:
        return EXIT_INTERNAL

    if not _publish(output_path, payload, metadata):
        return EXIT_ENCODE_FAILED
    return EXIT_OK


def _publish(output_path, payload, metadata):
    """Write the thumbnail and its sidecar, or neither. Returns success.

    Both files are written to sibling temp paths and renamed only once both exist, so
    the pair becomes visible together. A failure at any point removes the temporaries
    and whatever this call already renamed into place, leaving the output paths as
    they were found — an error exit must not leave a thumbnail that the parent would
    hand to a client without the metadata that was supposed to accompany it.
    """
    try:
        sidecar = _encode_metadata(metadata)
    except (KeyError, TypeError, ValueError):
        return False
    if not payload or len(payload) > MAX_OUTPUT_BYTES:
        return False
    if len(sidecar) > MAX_METADATA_BYTES:
        return False

    metadata_path = f"{output_path}.json"
    staged = ((f"{output_path}.part", payload), (f"{metadata_path}.part", sidecar))
    published = []
    try:
        # Payload first, sidecar last: the sidecar is what the parent keys on, so it is
        # renamed into place only after everything else has already succeeded.
        for path, content in staged:
            with open(path, "wb") as handle:
                handle.write(content)
        for path, _content in staged:
            os.replace(path, path[: -len(".part")])
            published.append(path[: -len(".part")])
    except OSError:
        for path, _content in staged:
            _discard(path)
        for path in published:
            _discard(path)
        return False
    return True


def _encode_metadata(metadata):
    """The exact sidecar bytes: three keys, no extras, no locale- or version drift."""
    return json.dumps(
        {"width": int(metadata["width"]), "height": int(metadata["height"]),
         "duration_ms": metadata["duration_ms"]},
        separators=(",", ":"), sort_keys=True).encode("ascii")


def _toolchain_available():
    """True when both external tools exist at their configured absolute paths.

    No PATH search: this process should give one answer regardless of how it was
    spawned, and the answer is what lets the parent tell "this host has no FFmpeg"
    apart from "this particular file is bad".
    """
    return bool(shutil.which(FFMPEG) and shutil.which(FFPROBE))


def _pillow_available():
    """True when Pillow can be imported, which is what the still paths need.

    A missing Pillow means no image or GIF can be decoded at all, which is the same
    kind of answer as a missing FFmpeg for video: nothing about the source matters.
    """
    try:
        import PIL.Image  # noqa: F401
    except ImportError:
        return False
    return True


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
    """Backwards-compatible single-image entry point. Returns the WebP bytes."""
    payload, _metadata = _still_thumbnail(input_path, KIND_IMAGE)
    return payload


def _still_thumbnail(input_path, kind):
    """Decode a still source with Pillow. Returns ``(webp_bytes, metadata)``.

    Both kinds run the same bounded path and differ only in the formats they accept, so
    a GIF is one more accepted format rather than a second decoder. The first frame is
    the whole preview: nothing here seeks, walks the frame list or reads a frame count
    on the GIF path, and no duration is claimed for it at all.
    """
    from PIL import Image

    # Pillow only *warns* between MAX_IMAGE_PIXELS and twice it, and warns rather than
    # raises at all while the warning filter is permissive. Turning the class into an
    # error is what makes the ceiling hard; ``_check_pixel_budget`` below is the second
    # line of defence for a plugin that reports dimensions without triggering Pillow's
    # own check.
    Image.MAX_IMAGE_PIXELS = MAX_PIXELS
    warnings.simplefilter("error", Image.DecompressionBombWarning)

    accepted_formats = GIF_FORMATS if kind == KIND_GIF else SUPPORTED_FORMATS

    try:
        with Image.open(input_path) as image:
            if image.format not in accepted_formats:
                raise _UnsupportedInput
            # Before any decode: refuse a bomb on its declared size, so the guard does
            # not depend on surviving the allocation it is meant to prevent.
            _check_pixel_budget(image.width, image.height)
            if accepted_formats is SUPPORTED_FORMATS:
                # Animated WebP/PNG is rejected rather than silently taken as frame 0.
                # A tile that animates is a different product decision, and pretending
                # a still frame is representative is the kind of quiet wrong answer
                # this worker exists to avoid. A GIF is the format whose whole point is
                # that it may animate, and its first frame is the agreed preview.
                _reject_animated(image)
            # A freshly opened image is already on frame 0, and seeking to it is what
            # would force Pillow to decode every frame in between. The frame count is
            # likewise never read here: on a GIF that would traverse the whole file.
            # A truncated source must fail at ``load``, not at save time with a
            # half-decoded buffer whose pixels are silently zeroed.
            image.load()
            frame = _transposed(image)
            _check_pixel_budget(frame.width, frame.height)
            # Measured on the transposed frame, because that is the orientation the
            # source is *displayed* in: a 40x20 file tagged "rotate 90" is a 20x40 image.
            width, height = frame.width, frame.height
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
    # ``null`` for every still source, whichever kind asked for it. A GIF's per-frame
    # delay is one frame of an animation, not the length of the source, so reporting it
    # as ``duration_ms`` would be a wrong answer rather than a missing one.
    return payload, {"width": width, "height": height, "duration_ms": None}


def _reject_animated(image):
    """Refuse a source that declares more than one frame, without opening any of them."""
    if _frame_count(image) > 1:
        raise _UnsupportedInput


# ---------------------------------------------------------------------------
# External toolchain (video sources only)
# ---------------------------------------------------------------------------


def _run_bounded(command, timeout, limit_bytes):
    """Run one external tool with hard wall and output bounds.

    Returns ``(returncode, stdout)``, where ``stdout`` is never longer than
    ``limit_bytes``. ``returncode`` is ``None`` when the tool passed the wall clock or
    either output bound, which is not an exit any tool chose.

    Both pipes are read while the tool runs, each into a fixed ceiling, and the reads are
    non-blocking: a descriptor that is reported ready is read with ``os.read``, which
    returns whatever is there instead of waiting for a buffer to fill or for EOF. That is
    what makes a tool writing one byte and then going quiet cost nothing.

    The timeout and both ceilings are checked on every pass, and either one stops the run
    there and then: the tool is signalled and reaped rather than kept alive to the end of
    the budget, so a flood is paid for once instead of until the clock runs out.

    The command is passed as a list and never through a shell, so a path containing spaces,
    quotes or a leading dash is an argument rather than syntax.
    """
    try:
        process = subprocess.Popen(
            list(command), stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE)
    except OSError:
        return None, b""

    deadline = time.monotonic() + timeout
    stdout = b""
    try:
        stdout, over_budget, timed_out = _read_tool(process, deadline, limit_bytes)
        _reap(process, over_budget or timed_out)
    except BaseException:
        # Includes the outer wall clock reaching this process: what this call started is
        # inside the worker's group, so the worker's kill reaches it too, but it must not
        # be left running by an exception here either.
        _reap(process, force=True)
        raise
    finally:
        for stream in (process.stdout, process.stderr):
            if stream is not None:
                try:
                    stream.close()
                except OSError:
                    pass

    if over_budget or timed_out or time.monotonic() >= deadline:
        # Over its output bound, out of wall clock, or finished exactly as the clock ran
        # out. None of the three produced a result this process can use.
        return None, b""
    # Reaped by ``_reap`` above, never ``None`` here, and negative for a tool that died
    # from a signal, so a failure is never mistaken for success.
    return process.returncode, stdout


def _read_tool(process, deadline, limit_bytes):
    """Read both pipes within every bound. Returns ``(stdout, over_budget, timed_out)``.

    One loop, one selector, and a hard stop at the first bound of any kind:

    * the result stream past ``limit_bytes`` sets ``over_budget`` and ends the loop,
    * the tool's stderr past :data:`MAX_TOOL_STDERR_BYTES` sets ``over_budget`` and ends
      the loop as well, because a flood there is not a reason to keep the tool alive,
    * the deadline ends the loop with ``timed_out``.

    ``os.read`` on a non-blocking descriptor is used rather than a buffered ``read``: a
    buffered read on a ready pipe waits for its own chunk size or EOF, which a tool that
    writes one byte and then sleeps would never satisfy.

    stdout is kept, within its bound. stderr is never kept, never returned, never logged
    and never shown to anyone: it is only counted, because the pipe has to be drained for
    the tool to run at all. Past its cap a flood there is a failure like any other, and the
    run stops instead of draining whatever the tool cares to write.
    """
    selector = selectors.DefaultSelector()
    stdout = b""
    stderr_bytes = 0
    over_budget = False
    timed_out = False
    try:
        for stream in (process.stdout, process.stderr):
            if stream is None:
                continue
            # Non-blocking reads are what keep a ready-but-short pipe from stalling the
            # whole loop; without this a single byte would not be read until more arrived.
            os.set_blocking(stream.fileno(), False)
            selector.register(stream.fileno(), selectors.EVENT_READ)
        while selector.get_map():
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                timed_out = True
                break
            for key, _events in selector.select(timeout=remaining):
                try:
                    chunk = os.read(key.fd, TOOL_READ_CHUNK_BYTES)
                except BlockingIOError:
                    # Spurious readiness on a non-blocking descriptor: nothing to read yet.
                    continue
                except OSError:
                    selector.unregister(key.fd)
                    continue
                if not chunk:
                    selector.unregister(key.fd)
                    continue
                if key.fd == process.stdout.fileno():
                    if len(stdout) + len(chunk) > limit_bytes:
                        over_budget = True
                        break
                    stdout += chunk
                else:
                    stderr_bytes += len(chunk)
                    if stderr_bytes > MAX_TOOL_STDERR_BYTES:
                        over_budget = True
                        break
            if over_budget:
                break
    except OSError:
        # A pipe that cannot be made non-blocking or registered at all cannot be read
        # within any bound, so nothing about this tool's output can be trusted.
        return b"", True, False
    finally:
        selector.close()
    if over_budget or timed_out:
        return b"", over_budget, timed_out
    return stdout, False, False


def _reap(process, force):
    """Wait for the tool, signalling it first when it passed a bound. Returns success.

    On a clean finish this is a plain ``wait`` on a process whose pipes have just hit EOF.
    Otherwise the tool may still be running, and waiting for it without asking it to stop
    would defeat the bound, so it is signalled and waited for within a bounded grace; a
    tool that survives that is killed. Either way this returns only once the direct child
    is reaped, so ``returncode`` is meaningful.

    The tool is left in the process group it was started in. What it spawned itself is the
    worker's group kill to end, not this function's: signalling the group here would reach
    processes that this call did not start.
    """
    if force:
        try:
            process.terminate()
        except OSError:
            pass
    for _attempt in range(MAX_REAP_ATTEMPTS):
        try:
            process.wait(timeout=GRACE_SECONDS)
            return True
        except subprocess.TimeoutExpired:
            continue
    try:
        process.kill()
    except OSError:
        pass
    for _attempt in range(MAX_REAP_ATTEMPTS):
        try:
            process.wait(timeout=GRACE_SECONDS)
            return True
        except subprocess.TimeoutExpired:
            continue
    return False


def _probe_display(input_path):
    """Ask FFprobe for the *display* geometry of the first video stream.

    Returns ``(width, height, duration_ms)``. The geometry is the geometry of the source
    itself, rotated when the stream carries a 90/270 display rotation, so a portrait phone
    video reports portrait dimensions rather than the pre-rotation stream size. Nothing
    else is read: no format tags, no other stream, no frame list.

    The input family is selected from the local header and restricted before opening.
    An unsupported container never reaches a playlist or network demuxer.

    ``format_name`` is asked for explicitly, and it is load-bearing. Naming any single
    ``format=`` entry suppresses the rest of the container fields, so a request for
    ``format=duration`` alone silently omits ``format_name``, and the check below could
    then never find a match, refusing every real video.
    """
    base = [FFPROBE, "-hide_banner", "-loglevel", "error", "-select_streams", "v:0"]
    base += _input_hardening(input_path)
    base += [
        "-show_entries",
        ("stream=width,height:stream_side_data=rotation:stream_tags=rotate:"
         "format=format_name,duration"),
        "-of", "json", "-timeout", str(PROBE_TIMEOUT_MICROSECONDS),
        "-i", input_path]
    code, stdout = _run_bounded(base, PROBE_WALL_SECONDS, MAX_PROBE_BYTES + 1)
    if code != 0 or not stdout or len(stdout) > MAX_PROBE_BYTES:
        raise _UnsupportedInput
    report = _parse_report(stdout)
    if report is None:
        raise _UnsupportedInput
    try:
        stream = report["streams"][0]
    except (KeyError, IndexError, TypeError):
        raise _UnsupportedInput
    if not isinstance(stream, dict):
        raise _UnsupportedInput
    try:
        width = int(stream["width"])
        height = int(stream["height"])
    except (KeyError, TypeError, ValueError):
        raise _UnsupportedInput
    _check_pixel_budget(width, height)
    if _quarter_rotation(stream):
        width, height = height, width
    return width, height, _duration_ms(report.get("format"))


def _parse_report(stdout):
    """A probe report for an accepted container, or ``None``.

    The container check here is a second line of defence. Which demuxer could run was
    already decided by the command line; this confirms the file matched it, and refuses
    anything the whitelist would not have accepted.
    """
    try:
        report = json.loads(stdout.decode("utf-8", "replace"))
    except (ValueError, UnicodeDecodeError):
        return None
    if not isinstance(report, dict):
        return None
    if _video_format(report) not in VIDEO_FORMATS:
        return None
    return report


def _input_hardening(input_path):
    """Arguments that narrow what a tool may open, applied before the input is named.

    WebM/Matroska starts with the EBML header; every other input must parse as MOV.
    Pinning the demuxer lets MOV always receive enable_drefs=0 (a MOV-only option)
    even for the worker's extensionless source. Neither filenames nor untrusted MIME
    select an option that could accidentally reopen external references.
    """
    try:
        with open(input_path, "rb") as source:
            ebml = source.read(4) == b"\x1a\x45\xdf\xa3"
    except OSError:
        raise _UnsupportedInput from None
    command = ["-protocol_whitelist", PROTOCOL_WHITELIST,
               "-format_whitelist", INPUT_FORMAT, "-f", "matroska" if ebml else "mov"]
    if not ebml:
        command += ["-enable_drefs", "0"]
    return command


def _video_format(report):
    """The reported container name for a format this worker accepts, or ``None``.

    ``matroska,webm`` and the MP4 alias list are comma-separated spellings of one
    demuxer, and which alias comes first varies by container and FFmpeg build, so any
    known alias is accepted rather than a name in a particular position.
    """
    container = report.get("format")
    if not isinstance(container, dict):
        return None
    name = container.get("format_name")
    if not isinstance(name, str):
        return None
    aliases = {alias.strip().lower() for alias in name.split(",")}
    return next((alias for alias in aliases if alias in VIDEO_FORMATS), None)


def _quarter_rotation(stream):
    """True when the stream is tagged with a 90/270 degree display rotation.

    Both spellings are checked, because FFmpeg itself checks both: the classic ``rotate``
    tag inside ``stream_tags``, and the modern ``rotation`` entry inside ``side_data_list``.
    A 180 degree rotation is deliberately not treated as a quarter turn, since it swaps
    nothing, and is left to the frame decode to apply.
    """
    try:
        tag = stream.get("tags", {}).get("rotate")
        if tag is not None and abs(int(tag)) % 180 == 90:
            return True
    except (AttributeError, TypeError, ValueError):
        pass
    side_data = stream.get("side_data_list")
    if isinstance(side_data, list):
        for entry in side_data:
            if not isinstance(entry, dict):
                continue
            try:
                if abs(int(entry.get("rotation"))) % 180 == 90:  # type: ignore[arg-type]
                    return True
            except (TypeError, ValueError):
                continue
    return False


def _duration_ms(container):
    """The declared container duration in whole milliseconds, or ``None``.

    Unknown or absent is reported as ``None``. A negative or non-finite value is also
    reported as ``None`` rather than clamped: neither is a plausible duration, and the
    contract forbids a negative. Truncation is deliberate: a duration is never rounded up
    to a millisecond the source does not have, and an exact zero stays ``0``.
    """
    if not isinstance(container, dict):
        return None
    try:
        seconds = float(container["duration"])
    except (KeyError, TypeError, ValueError):
        return None
    if not math.isfinite(seconds) or seconds < 0:
        return None
    milliseconds = seconds * 1000
    if not math.isfinite(milliseconds) or milliseconds >= 2**63:
        return None
    return int(milliseconds)


def _seek_seconds(
        duration_ms, fraction=VIDEO_SEEK_FRACTION, floor_ms=VIDEO_SEEK_FLOOR_MS,
        cap_ms=VIDEO_SEEK_CAP_MS, fallback_ms=VIDEO_SEEK_FALLBACK_MS,
        short_ceiling_fraction=VIDEO_SEEK_SHORT_CEILING_FRACTION):
    """The FFmpeg seek point for a declared duration, as ``(seconds, milliseconds)``.

    The point is a fraction of the declared duration, floored at a fixed minimum and capped at
    a fixed maximum: far enough in to skip an opening black or fade-in stretch on a capture
    long enough to have moved past it, and never minutes into a long one.

    The floor is also clamped by half the declared duration, because a capture too short to
    hold it has frames only in the part of the timeline a seek can still land on, and a seek
    at or past its last frame decodes no frame at all. The clamp is a ceiling over the whole
    seek rather than a threshold: it applies to every duration, so shrinking a source can
    never move its seek *later*. Clamping is not a guarantee that an opening black stretch is
    skipped — on a capture shorter than twice the floor the point is only half way in, which a
    black stretch that long will still cover.

    The arithmetic is in integer milliseconds, matching the truncation the caller already
    applied, and a negative or unparseable duration takes the fixed offset rather than
    becoming an option FFmpeg could read as something else.
    """
    if not isinstance(duration_ms, int) or duration_ms <= 0:
        return _seek_spelling(fallback_ms), fallback_ms
    seek_ms = min(max(int(duration_ms * fraction), floor_ms), cap_ms)
    seek_ms = min(seek_ms, int(duration_ms * short_ceiling_fraction))
    return _seek_spelling(seek_ms), seek_ms


def _seek_spelling(seek_ms):
    """A whole-millisecond seek as the seconds string FFmpeg is given, never negative."""
    return f"{max(seek_ms, 0) / 1000:.{VIDEO_SEEK_PRECISION_SECONDS}f}"


def _decode_frame(input_path, seek_seconds, limit, output_path):
    """Decode one frame at ``seek_seconds`` into ``output_path``. Returns ``(ok, payload)``.

    ``ok`` distinguishes the two ways this can produce no payload:

    * ``(True, b"")`` — the tool ran and *succeeded*, but the seek point yielded no frame, or
      the artifact it wrote could not be read. Only the first of those is a clean empty
      outcome, and it is the only one that may be answered with a different seek point. An
      absent artifact is the clean case: the muxer does not create the path when it writes no
      frame. An artifact that exists but cannot be read is not — a frame did get written, and
      this process simply could not read it, which no second decode can change.
    * ``(False, b"")`` — the tool failed, was killed at its wall clock, or wrote past its
      output bound, or its artifact could not be read. That is terminal: retrying would decode
      the source a second time on a host that is already failing, and a frame from a second
      attempt would hide the fault.

    The frame is written to a file rather than to a pipe, and that is load-bearing. With
    ``image2pipe`` an exhausted seek exits non-zero (this FFmpeg generation reports libwebp's
    end-of-stream as an allocation failure), which would make "no frame at this point" and
    "the decoder broke" the same answer and force a blind retry of every failure. The plain
    ``image2`` muxer exits ``0`` having written nothing, so the distinction above actually
    exists and a failure is never retried.

    The result is read back bounded by ``limit + 1`` bytes, the same ceiling the tool was
    asked to stay under. That bound is this process's own, and it is what makes the read
    safe: ``-fs`` tells the muxer to stop at that many bytes, but it is the tool's own
    option rather than a limit on the filesystem, so a tool that ignored it is caught by the
    read returning more than the bound rather than by the write that overshot it. The outer
    process resource limits are the other half: both this process and the tool it spawns
    inherit the address-space and CPU ceilings applied in :func:`main`.

    ``-ss`` sits after ``-i`` so the seek is a decode seek: FFmpeg decodes from the preceding
    seek point and discards frames until the requested timestamp, rather than approximating
    the timestamp with the preceding keyframe. That approximation is what can put a black
    opening GOP on the tile. The same option before ``-map`` is what makes it select the
    first frame at or after the timestamp.
    """
    command = [FFMPEG, "-hide_banner", "-loglevel", "error", "-nostdin", "-threads", "1"]
    command += _input_hardening(input_path)
    command += [
        "-i", input_path, "-ss", seek_seconds,
        "-map", "0:v:0", "-frames:v", "1", "-an", "-sn", "-dn",
        # Pass timestamps through untouched instead of duplicating frames onto a
        # constant-rate timeline, which is what the shortest clips need to produce any
        # frame at all. ``-fps_mode`` is the modern spelling of the same option.
        "-vsync", "0",
        "-threads", "1", "-filter_threads", "1", "-filter_complex_threads", "1",
        # ``decrease`` alone only ever shrinks; the explicit ``min`` is what guarantees a
        # source smaller than the tile is written at its own size rather than upscaled.
        "-vf", (f"scale=w='min({MAX_EDGE},iw)':h='min({MAX_EDGE},ih)'"
                f":force_original_aspect_ratio=decrease"),
        "-c:v", "libwebp", "-quality", str(WEBP_QUALITY), "-threads", "1",
        # ``-fs`` asks the muxer to stop once the output file reaches this many bytes, which
        # truncates a frame that would exceed it. It is the tool's own option, not a limit on
        # the filesystem, so it is a bound on what a cooperative tool writes rather than a
        # guarantee: the cap is passed one byte over ``limit``, and the read below is what
        # catches an artifact that reached it anyway.
        "-f", "image2", "-fs", str(limit), "-y", output_path,
    ]
    # stdout is only a diagnostic channel here and is bounded by the same limit.
    code, _stdout = _run_bounded(command, DECODE_TIMEOUT_SECONDS, limit)
    if code != 0:
        return False, b""
    try:
        with open(output_path, "rb") as handle:
            payload = handle.read(limit + 1)
    except FileNotFoundError:
        # A clean exit with no artifact is how this tool reports that it wrote no frame; the
        # muxer never creates the path in that case. It is the empty outcome, not a failure,
        # and only a non-zero exit above is treated as one.
        return True, b""
    except OSError:
        # The artifact exists but could not be read: a permission or I/O fault, not an empty
        # decode. Treating it as empty would send the caller to a second seek and then report
        # a frame that was never readable, so it is terminal like any other tool fault.
        return False, b""
    if not payload:
        return True, b""
    if len(payload) >= limit:
        return False, b""
    return True, payload


def _video_thumbnail(input_path):
    """Decode one poster frame with FFmpeg. Returns ``(webp_bytes, metadata)``.

    Exactly one frame is requested, from a duration-relative point after the start, so an
    opening black or fade-in stretch is skipped on a capture long enough to have moved past it
    without taking the poster minutes into a long one. The seek is accurate, one thread is used
    throughout, and no frame is scanned on the way.

    A *successful* decode that yields no frame at the computed point is retried once at the
    start of the file. Only that outcome is retried: a source can have no frame at or after a
    timestamp the seek can still land on — declared durations shorter than the time between
    two of its frames are the clearest case — and such a source's first frame is the answer.
    A failed, killed or over-bound tool raises immediately instead, so this never decodes a
    failing source twice and never masks a fault behind a second attempt.
    """
    from PIL import Image

    width, height, duration_ms = _probe_display(input_path)
    seek_seconds, _seek_ms = _seek_seconds(duration_ms)
    limit = min(MAX_OUTPUT_BYTES, MAX_EDGE * MAX_EDGE * 4) + 1
    with tempfile.TemporaryDirectory(prefix="lakomics-frame-") as directory:
        stage = os.path.join(directory, "frame.webp")
        ok, payload = _decode_frame(input_path, seek_seconds, limit, stage)
        if not payload:
            if not ok:
                raise _EncodeFailed
            _ok, payload = _decode_frame(input_path, VIDEO_FIRST_FRAME_SEEK_SECONDS,
                                         limit, stage)
    if not payload:
        raise _EncodeFailed
    # The frame is re-read rather than trusted: FFmpeg's output is decoded by our own
    # bounded Pillow path, whose ceiling then also covers the decoded frame itself.
    try:
        with Image.open(io.BytesIO(payload)) as frame:
            _check_pixel_budget(frame.width, frame.height)
            if frame.format != "WEBP" or max(frame.size) > MAX_EDGE or _frame_count(frame) != 1:
                raise _UnsupportedInput
            frame.load()
    except (Image.DecompressionBombError, Image.DecompressionBombWarning):
        raise _UnsupportedInput
    except (OSError, ValueError, SyntaxError, MemoryError, EOFError):
        raise _UnsupportedInput
    return payload, {"width": width, "height": height, "duration_ms": duration_ms}


def _check_pixel_budget(width, height):
    """Reject a frame whose declared pixel count exceeds the ceiling."""
    if type(width) is not int or type(height) is not int or width < 1 or height < 1:
        raise _UnsupportedInput
    if width * height > MAX_PIXELS:
        raise _UnsupportedInput


def _frame_count(image):
    """Frames in an opened image, or 1 when the plugin does not report them.

    Read from the header, without decoding or seeking: a frame count is metadata, and
    opening frame 1 is the work this check exists to avoid.
    """
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

    Checking the mode name alone is not enough: a ``P``-mode PNG carries its alpha in the
    palette transparency entry, so it must convert to ``RGBA`` to keep that alpha.
    Converting such a frame to ``RGB`` renders every transparent pixel black instead.
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
    from PIL import Image

    longest = max(image.width, image.height)
    if longest <= MAX_EDGE:
        return image
    scale = MAX_EDGE / longest
    target = (max(1, round(image.width * scale)), max(1, round(image.height * scale)))
    return image.resize(target, Image.Resampling.LANCZOS)


if __name__ == "__main__":
    sys.exit(main(sys.argv))
