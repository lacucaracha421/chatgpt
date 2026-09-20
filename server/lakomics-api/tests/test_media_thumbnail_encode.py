"""Bounded image/GIF/video thumbnail encoder: kinds, sidecar contract, tool bounds.

The encoder is exercised here as the worker runs it: a real child process, real exit
codes, real Pillow and the real FFmpeg toolchain when it is installed. What is *faked* is
the toolchain boundary. A missing tool is modelled by pointing the two configured paths at
files that do not exist, and a tool that hangs, floods its output or ignores the output
bound it is given is a generated stub run through the real reader. Those are the failures
this process must survive on a host where the real binaries do not behave.

Video cases build their sources with the local FFmpeg at test time. Rotation is produced
the way the product's own captures carry it, as a display matrix on a copy remux, and the
fixture is checked for that matrix before it is asserted on; the display-matrix logic is
also covered against real ffprobe JSON without needing a rotated file. Two cases are
reported rather than skipped when the property is unavailable:

* A host without FFmpeg runs none of the video cases and says so through the skip, which
  is never counted as a decode.
* A build that cannot write a display matrix fails the rotation case instead of passing it
  for the wrong reason.
"""
from __future__ import annotations

import io
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock
from pathlib import Path

SERVER_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVER_DIR))

import image_thumbnail_encode as encoder  # noqa: E402

try:
    from PIL import Image
except ImportError:  # pragma: no cover - the production venv installs Pillow
    Image = None

#: The production entry point the worker already runs with three arguments. It is
#: imported rather than hard-coded so that the kind this suite passes and the kind the
#: worker will pass cannot drift apart unnoticed.
import image_thumbnails as worker_module  # noqa: E402

ENCODER = str(SERVER_DIR / "image_thumbnail_encode.py")
WORKER_KINDS = {"image": "image", "gif": "gif", "video": "video"}

requires_pillow = unittest.skipIf(Image is None, "Pillow is unavailable in this environment")

FFMPEG = shutil.which(encoder.FFMPEG or "")
FFPROBE = shutil.which(encoder.FFPROBE or "")
requires_ffmpeg = unittest.skipUnless(
    bool(FFMPEG and FFPROBE), "FFmpeg and FFprobe are unavailable in this environment")

#: The encoder sets its own CPU and address-space limits; a generated stub starts far
#: under them, and this is the allowance the wall-clock cases measure against.
STUB_STARTUP_ALLOWANCE_SECONDS = 8
#: A bound that fires late is not a bound. Every stub in this suite is given a timeout far
#: above this, and must be stopped within it.
STUB_BOUND_GUARD_SECONDS = 2.0

#: Reported when this host cannot produce the rotated fixture at all, rather than
#: treating the missing property as a pass.
NO_DISPLAY_MATRIX_FIXTURE = (
    "this FFmpeg build did not write a display matrix for the remuxed fixture")

#: Averages a fixture's black intro must stay under, and a coloured later frame must stay
#: over, for a pixel assertion to prove which frame was chosen. The gap is wide enough that
#: lossy encoding and 4:2:0 chroma cannot blur the two into each other.
INTRO_BLACK_CHANNEL_CEILING = 40
INTRO_TINT_CHANNEL_FLOOR = 120


def run_encoder(arguments, *, env=None, script=ENCODER, timeout=120):
    """Run the encoder exactly as the worker does, for one explicit kind."""
    return subprocess.run([sys.executable, script, *arguments], check=False,
                          capture_output=True, timeout=timeout, env=env)


def no_tool_environment():
    """An environment where both external tools are absent.

    Pointing the encoder at paths that do not exist is how a host without FFmpeg looks
    to it. Nothing about PATH is changed, because the encoder never consults PATH for
    the tools in the first place.
    """
    return dict(os.environ, LAKOMICS_FFMPEG="/nonexistent/ffmpeg",
                LAKOMICS_FFPROBE="/nonexistent/ffprobe")


class EncoderCase(unittest.TestCase):
    """A temporary directory with a source file and an output path."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = self.temp.name

    def path(self, name):
        return os.path.join(self.directory, name)

    def write_source(self, payload, name="source"):
        path = self.path(name)
        Path(path).write_bytes(payload)
        return path

    def encode(self, payload, kind, *, name="source", env=None, expect=0):
        """Encode ``payload`` and return ``(returncode, metadata_or_None, output_path)``."""
        source = self.write_source(payload, name)
        output = self.path("out.webp")
        completed = run_encoder([source, output, kind], env=env)
        self.assertEqual(completed.returncode, expect, completed.stderr[-400:])
        metadata = self.read_metadata(output) if completed.returncode == 0 else None
        return completed.returncode, metadata, output

    def read_metadata(self, output):
        with open(f"{output}.json", "rb") as handle:
            payload = handle.read()
        self.assertLessEqual(len(payload), encoder.MAX_METADATA_BYTES)
        return json.loads(payload.decode("ascii"))

    def assert_no_output(self, output):
        """Neither half of the pair may exist after an error exit."""
        self.assertFalse(os.path.exists(output), "an error exit left a thumbnail behind")
        self.assertFalse(os.path.exists(f"{output}.json"),
                         "an error exit left a metadata sidecar behind")
        self.assertFalse(os.path.exists(f"{output}.part"))
        self.assertFalse(os.path.exists(f"{output}.json.part"))

    def open_thumbnail(self, output):
        assert Image is not None
        with Image.open(output) as encoded:
            encoded.load()
            return encoded.size, encoded.format, encoded.mode


# ---------------------------------------------------------------------------
# Synthetic sources, built with Pillow and the local FFmpeg
# ---------------------------------------------------------------------------


def gif_bytes(size=(800, 400), frames=3, duration=120):
    """An animated GIF: the first frame is the preview, the rest must be ignored."""
    assert Image is not None
    colors = ((255, 0, 0), (0, 0, 255), (0, 255, 0), (255, 255, 0))
    images = [Image.new("RGB", size, colors[index % len(colors)]) for index in range(frames)]
    buffer = io.BytesIO()
    images[0].save(buffer, format="GIF", save_all=True, append_images=images[1:],
                   duration=duration, loop=0)
    return buffer.getvalue()


def still_gif_bytes(size=(64, 48)):
    assert Image is not None
    buffer = io.BytesIO()
    Image.new("RGB", size, (10, 20, 30)).save(buffer, format="GIF")
    return buffer.getvalue()


def png_bytes(size=(64, 48)):
    assert Image is not None
    buffer = io.BytesIO()
    Image.new("RGB", size, (200, 40, 40)).save(buffer, format="PNG")
    return buffer.getvalue()


def build_video(path, args):
    """Encode a generated clip with the local FFmpeg. Raises on failure, never skips."""
    assert FFMPEG is not None
    completed = subprocess.run(
        [FFMPEG, "-hide_banner", "-loglevel", "error", "-nostdin", *args, "-y", path],
        check=False, capture_output=True, timeout=120)
    if completed.returncode != 0:
        raise AssertionError(completed.stderr[-400:])
    return path


def h264_mp4(path, size="1280x720", seconds="2", extra=()):
    return build_video(path, ["-f", "lavfi", "-i", f"testsrc=size={size}:rate=25",
                              "-t", seconds, "-pix_fmt", "yuv420p", "-c:v", "libx264",
                              *extra])


def copied_with_rotation(source, path, degrees=90):
    """Remux ``source`` with a real display matrix of ``degrees`` on its video stream.

    The rotation is set as an *input* option on the copy remux, which is where this
    FFmpeg build accepts it and which is what makes the output carry a genuine display
    matrix (verified: ``side_data`` with ``rotation=90``). Setting the ``rotate`` metadata
    tag instead does not, on this build, produce a matrix at all.
    """
    completed = subprocess.run(
        [FFMPEG, "-hide_banner", "-loglevel", "error", "-nostdin",
         "-display_rotation", str(degrees), "-i", source, "-c", "copy", "-y", path],
        check=False, capture_output=True, timeout=120)
    if completed.returncode != 0:
        raise AssertionError(completed.stderr[-400:])
    return path


def reports_display_matrix(path):
    """True when a copy remux really gave this file a display matrix, or ``None``.

    ``None`` means this host cannot produce the fixture at all, which the caller reports
    rather than turning into a pass.
    """
    assert FFPROBE is not None
    completed = subprocess.run(
        [FFPROBE, "-hide_banner", "-loglevel", "error", "-select_streams", "v:0",
         "-show_streams", path], check=False, capture_output=True, timeout=120)
    if completed.returncode != 0:
        return None
    return "displaymatrix" in completed.stdout.decode("utf-8", "replace").lower()


# ---------------------------------------------------------------------------
# The argument contract
# ---------------------------------------------------------------------------


class KindArgumentTests(EncoderCase):
    def test_the_kind_defaults_to_image_so_the_three_argument_form_still_works(self):
        # The worker's existing call passes three arguments and must keep meaning
        # "static image". This is asserted directly rather than only through the worker,
        # because the default is the compatibility guarantee.
        source = self.write_source(b"\x89PNG\r\n\x1a\nnot-really-a-png")
        output = self.path("out.webp")
        completed = run_encoder([source, output])
        self.assertEqual(completed.returncode, encoder.EXIT_UNSUPPORTED_INPUT)
        self.assert_no_output(output)

    def test_an_unknown_kind_is_a_usage_exit_and_writes_nothing(self):
        source = self.write_source(png_bytes())
        output = self.path("out.webp")
        completed = run_encoder([source, output, "thumbnail"])
        self.assertEqual(completed.returncode, encoder.EXIT_USAGE)
        self.assertEqual(completed.stdout, b"")
        self.assert_no_output(output)

    def test_a_fourth_argument_beyond_the_kind_is_a_usage_exit(self):
        source = self.write_source(png_bytes())
        output = self.path("out.webp")
        completed = run_encoder([source, output, "image", "extra"])
        self.assertEqual(completed.returncode, encoder.EXIT_USAGE)

    def test_the_kinds_the_encoder_accepts_cover_the_kinds_the_worker_maps(self):
        # A drift guard between the two modules: the worker's Asset kinds and the
        # encoder's accepted kinds are separate literals, and this is where they are
        # compared without editing either module to import the other.
        self.assertEqual(tuple(sorted(WORKER_KINDS.values())), tuple(sorted(encoder.KINDS)))

    def test_the_video_asset_kind_the_worker_maps_is_the_kind_this_encoder_expects(self):
        self.assertEqual(encoder.KIND_VIDEO, "video")
        self.assertEqual(encoder.KIND_GIF, "gif")
        self.assertEqual(encoder.KIND_IMAGE, worker_module.IMAGE_KIND)


# ---------------------------------------------------------------------------
# The metadata sidecar: exact keys, display dimensions, bounded size
# ---------------------------------------------------------------------------


@requires_pillow
class MetadataTests(EncoderCase):
    def test_the_sidecar_carries_exactly_three_keys(self):
        _code, metadata, output = self.encode(png_bytes(size=(1600, 900)), "image")
        self.assertEqual(set(metadata), {"width", "height", "duration_ms"})
        self.assertEqual((metadata["width"], metadata["height"]), (1600, 900))
        self.assertIsNone(metadata["duration_ms"])
        self.assertEqual(
            Path(f"{output}.json").read_bytes(),
            b'{"duration_ms":null,"height":900,"width":1600}')

    def test_dimensions_are_the_source_display_size_not_the_thumbnail_size(self):
        # The whole point of the field: a 512 px tile must not turn a source's metadata
        # into 512x288. Both halves are asserted, because either alone could pass by
        # accident.
        _code, metadata, output = self.encode(png_bytes(size=(1600, 900)), "image")
        self.assertEqual((metadata["width"], metadata["height"]), (1600, 900))
        assert Image is not None
        with Image.open(output) as tile:
            self.assertEqual(tile.size, (512, 288))

    def test_exif_rotation_is_applied_to_the_reported_dimensions(self):
        # Orientation 6 means "rotate 90 for display", so the source is displayed 20x40.
        # Reporting the untransposed 40x20 would put a landscape box under a portrait
        # thumbnail.
        assert Image is not None
        buffer = io.BytesIO()
        image = Image.new("RGB", (40, 20), (5, 5, 5))
        exif = image.getexif()
        exif[274] = 6
        image.save(buffer, format="JPEG", exif=exif)
        _code, metadata, _output = self.encode(buffer.getvalue(), "image")
        self.assertEqual((metadata["width"], metadata["height"]), (20, 40))

    def test_a_small_image_reports_the_original_size_it_was_not_upscaled_to(self):
        _code, metadata, _output = self.encode(png_bytes(size=(120, 90)), "image")
        self.assertEqual((metadata["width"], metadata["height"]), (120, 90))

    def test_a_static_image_reports_no_duration_rather_than_zero(self):
        # ``null`` is "unknown"; ``0`` would be a positive claim that the source lasts
        # no time at all.
        _code, metadata, _output = self.encode(png_bytes(), "image")
        self.assertIsNone(metadata["duration_ms"])

    def test_the_sidecar_stays_within_its_byte_bound(self):
        _code, _metadata, output = self.encode(png_bytes(size=(2000, 2000)), "image")
        size = os.path.getsize(f"{output}.json")
        self.assertGreater(size, 0)
        self.assertLessEqual(size, encoder.MAX_METADATA_BYTES)

    def test_a_written_sidecar_is_ascii_and_reparses_to_the_same_values(self):
        _code, metadata, output = self.encode(png_bytes(size=(300, 400)), "image")
        raw = Path(f"{output}.json").read_bytes()
        raw.decode("ascii")
        self.assertEqual(json.loads(raw.decode("ascii")), metadata)

    def test_the_pair_is_published_together_and_only_after_both_are_complete(self):
        _code, _metadata, output = self.encode(png_bytes(size=(800, 600)), "image")
        self.assertTrue(os.path.exists(output))
        self.assertTrue(os.path.exists(f"{output}.json"))
        self.assertGreater(os.path.getsize(output), 0)


# ---------------------------------------------------------------------------
# GIF: a static first-frame preview, never an animation
# ---------------------------------------------------------------------------


@requires_pillow
class GifTests(EncoderCase):
    def test_an_animated_gif_becomes_a_static_first_frame_webp(self):
        _code, metadata, output = self.encode(gif_bytes(size=(800, 400)), "gif")
        assert Image is not None
        self.assertEqual((metadata["width"], metadata["height"]), (800, 400))
        with Image.open(output) as tile:
            self.assertEqual(tile.format, "WEBP")
            # One frame, single-frame WebP: an animated tile is explicitly not the
            # product, so the output must not carry a second frame.
            self.assertNotIn("duration", tile.info)
            self.assertEqual(getattr(tile, "n_frames", 1), 1)

    def test_the_first_frame_is_the_one_previewed(self):
        # Frame 0 is red, frame 1 is blue. Sampling any later frame would show blue.
        assert Image is not None
        images = [Image.new("RGB", (320, 160), (255, 0, 0)),
                  Image.new("RGB", (320, 160), (0, 0, 255))]
        buffer = io.BytesIO()
        images[0].save(buffer, format="GIF", save_all=True, append_images=images[1:], duration=100)
        _code, _metadata, output = self.encode(buffer.getvalue(), "gif")
        with Image.open(output) as tile:
            red, green, blue = tile.convert("RGB").resize((1, 1)).getpixel((0, 0))
        self.assertGreater(red, 200)
        self.assertLess(blue, 60)

    def test_a_long_animation_is_not_traversed_to_sum_its_durations(self):
        # Sixty frames at 40 ms each is 2.4 s of animation. No total is reported at all:
        # a first frame's delay is one frame of the animation, not the length of the
        # source, so reporting it (or a sum over every frame) would be a wrong answer.
        _code, metadata, _output = self.encode(gif_bytes(frames=60, duration=40), "gif")
        self.assertIsNone(metadata["duration_ms"])

    def test_an_animated_gif_reports_no_duration_rather_than_its_first_frame_delay(self):
        # The specific misreport this guards: frame 0 declares 250 ms and the tile must not
        # claim the source lasts 250 ms, or 750 ms for three frames.
        _code, metadata, _output = self.encode(gif_bytes(frames=3, duration=250), "gif")
        self.assertIsNone(metadata["duration_ms"])

    def test_a_gif_without_a_declared_delay_reports_null(self):
        assert Image is not None
        buffer = io.BytesIO()
        Image.new("RGB", (64, 48), (1, 2, 3)).save(buffer, format="GIF")
        _code, metadata, _output = self.encode(buffer.getvalue(), "gif")
        self.assertIsNone(metadata["duration_ms"])

    def test_a_still_gif_is_accepted_through_the_gif_kind(self):
        _code, metadata, _output = self.encode(still_gif_bytes(size=(200, 100)), "gif")
        self.assertEqual((metadata["width"], metadata["height"]), (200, 100))

    def test_a_gif_larger_than_the_edge_bound_is_scaled_without_upscaling(self):
        _code, metadata, output = self.encode(gif_bytes(size=(1600, 800), frames=2), "gif")
        self.assertEqual((metadata["width"], metadata["height"]), (1600, 800))
        assert Image is not None
        with Image.open(output) as tile:
            self.assertEqual(tile.size, (512, 256))

    def test_a_gif_source_is_refused_when_the_kind_says_image(self):
        # The kinds are not interchangeable: a GIF reaching the static-image path must be
        # refused rather than quietly accepted, so the caller's classification stays
        # meaningful.
        _code, _metadata, output = self.encode(gif_bytes(), "image",
                                               expect=encoder.EXIT_UNSUPPORTED_INPUT)
        self.assert_no_output(output)

    def test_the_gif_path_is_pillow_alone_and_needs_no_external_tool(self):
        # The GIF path must not consult FFmpeg or FFprobe at all. Both configured paths
        # are pointed at files that do not exist, and the encode still succeeds: a GIF is
        # decoded by Pillow, which is the only tool it needs.
        _code, metadata, output = self.encode(gif_bytes(size=(800, 400)), "gif",
                                              env=no_tool_environment())
        self.assertEqual((metadata["width"], metadata["height"]), (800, 400))
        assert Image is not None
        with Image.open(output) as tile:
            self.assertEqual(tile.format, "WEBP")
            self.assertEqual(getattr(tile, "n_frames", 1), 1)

    def test_a_gif_is_refused_when_pillow_is_the_missing_tool(self):
        # Pillow is the GIF path's only tool, so a process without it has nothing to
        # decode with and says so with the same code a video without FFmpeg gives.
        assert Image is not None
        script = os.path.join(self.directory, "no_pillow_gif.py")
        Path(script).write_text(
            "import sys\n"
            "class Blocker:\n"
            "    def find_spec(self, name, path=None, target=None):\n"
            "        if name == 'PIL' or name.startswith('PIL.'):\n"
            "            raise ImportError('blocked')\n"
            "        return None\n"
            "sys.meta_path.insert(0, Blocker())\n"
            f"sys.path.insert(0, {str(SERVER_DIR)!r})\n"
            "import image_thumbnail_encode as encoder\n"
            "sys.exit(encoder.main(['x', sys.argv[1], sys.argv[2], 'gif']))\n")
        source = self.write_source(gif_bytes(), "blocked.gif")
        output = self.path("blocked.webp")
        completed = run_encoder([source, output, "gif"], script=script)
        self.assertEqual(completed.returncode, encoder.EXIT_TOOL_UNAVAILABLE,
                         completed.stderr[-400:])
        self.assert_no_output(output)


# ---------------------------------------------------------------------------
# Video: the external toolchain
# ---------------------------------------------------------------------------


class ToolAvailabilityTests(EncoderCase):
    def test_a_video_source_without_ffmpeg_has_its_own_exit_code(self):
        source = self.write_source(b"not-a-video")
        output = self.path("out.webp")
        completed = run_encoder([source, output, "video"], env=no_tool_environment())
        self.assertEqual(completed.returncode, encoder.EXIT_TOOL_UNAVAILABLE)
        self.assertEqual(completed.stdout, b"")
        self.assert_no_output(output)

    def test_a_gif_source_needs_no_tool_at_all(self):
        # The GIF path used to depend on the FFmpeg toolchain. It must not any more, which
        # is asserted by encoding a real GIF in the environment where both tools are
        # missing: FFmpeg being absent is not a reason a GIF cannot be previewed.
        source = self.write_source(gif_bytes(), "plain.gif")
        output = self.path("plain.webp")
        completed = run_encoder([source, output, "gif"], env=no_tool_environment())
        if Image is None:
            self.assertEqual(completed.returncode, encoder.EXIT_TOOL_UNAVAILABLE)
            self.assert_no_output(output)
            return
        self.assertEqual(completed.returncode, encoder.EXIT_OK, completed.stderr[-400:])
        self.assertTrue(os.path.exists(output))

    def test_the_static_image_path_never_requires_the_external_tools(self):
        # Only the GIF and video kinds depend on the toolchain. An image must still
        # encode on a host where FFmpeg was never installed, so this asserts the
        # distinction rather than assuming it.
        source = self.write_source(png_bytes())
        output = self.path("out.webp")
        completed = run_encoder([source, output, "image"], env=no_tool_environment())
        if Image is None:
            self.skipTest("Pillow is unavailable in this environment")
        self.assertEqual(completed.returncode, encoder.EXIT_OK, completed.stderr[-400:])
        self.assertTrue(os.path.exists(output))

    def test_tool_unavailable_is_distinct_from_every_other_exit_code(self):
        self.assertEqual(encoder.EXIT_TOOL_UNAVAILABLE, 7)
        self.assertNotIn(encoder.EXIT_TOOL_UNAVAILABLE,
                         (encoder.EXIT_OK, encoder.EXIT_USAGE,
                          encoder.EXIT_UNSUPPORTED_PLATFORM, encoder.EXIT_UNSUPPORTED_INPUT,
                          encoder.EXIT_ENCODE_FAILED, encoder.EXIT_INTERNAL))

    def test_the_tool_paths_are_absolute_so_the_host_does_not_depend_on_path(self):
        for configured in (encoder.FFMPEG, encoder.FFPROBE):
            self.assertTrue(os.path.isabs(configured), configured)

    def test_the_legacy_path_suffix_is_ignored_on_a_posix_host(self):
        # The encoder refuses to run where it cannot bound itself, which is why the
        # absolute POSIX paths above are the only ones that can ever be used in
        # production. This pins that reasoning to the code rather than to a comment.
        if os.name != "posix":
            self.skipTest("the fail-closed platform guard is a POSIX behaviour")
        self.assertFalse(encoder._apply_own_resource_limits.__doc__ is None)


@requires_ffmpeg
class BoundedToolRunTests(EncoderCase):
    """Wall, output and process-group bounds, exercised against generated stub tools."""

    def stub(self, name, body):
        path = os.path.join(self.directory, name)
        Path(path).write_text(body)
        return path

    def bounded(self, command, timeout, limit_bytes):
        """Run one stub and return ``(code, output, elapsed_seconds)``.

        Every case here is also a timing case: a bound that stops a tool is worth nothing
        if it stops it only after the full budget, so the elapsed time is measured and
        checked against a guard well under the timeout each stub is given.
        """
        started = time.monotonic()
        code, output = encoder._run_bounded(command, timeout, limit_bytes)
        return code, output, time.monotonic() - started

    def assert_stopped_within(self, elapsed, seconds=STUB_BOUND_GUARD_SECONDS):
        self.assertLess(elapsed, seconds,
                        f"the bound took {elapsed:.2f}s to act")

    def test_a_tool_that_hangs_is_reaped_at_the_wall_clock(self):
        stub = self.stub("hang.py", "import time\ntime.sleep(120)\n")
        code, output, elapsed = self.bounded([sys.executable, stub], 1.0, 4096)
        self.assertIsNone(code)
        self.assertEqual(output, b"")
        self.assert_stopped_within(elapsed, STUB_STARTUP_ALLOWANCE_SECONDS)

    def test_a_tool_that_writes_one_byte_and_sleeps_still_hits_the_wall_clock(self):
        # The read must not wait for a pipe to fill. A stub that writes a single byte and
        # then sleeps well past the timeout leaves the descriptor readable once and never
        # again; a buffered read of a whole chunk would block on it until EOF, which this
        # stub never reaches on its own. The run therefore has to come back at the wall
        # clock with the byte it did write.
        stub = self.stub("one_byte.py",
                         "import os, time\nos.write(1, b'Z')\ntime.sleep(300)\n")
        code, output, elapsed = self.bounded([sys.executable, stub], 1.0, 4096)
        self.assertIsNone(code)
        self.assertEqual(output, b"")
        self.assert_stopped_within(elapsed)

    def test_a_one_byte_tool_that_finishes_is_read_whole(self):
        # The same short read on the success path: the payload is returned exactly, however
        # little of the pipe the tool filled.
        stub = self.stub("one_byte_done.py", "import os\nos.write(1, b'Z')\n")
        code, output, elapsed = self.bounded([sys.executable, stub], 5.0, 4096)
        self.assertEqual(code, 0)
        self.assertEqual(output, b"Z")
        self.assert_stopped_within(elapsed)

    def test_a_killed_tool_leaves_no_process_group_behind(self):
        # The stub starts a grandchild and then hangs. Reaping the direct child is this
        # process's job; the grandchild is inside the worker's group, so it is the
        # worker's group kill that reaches it, which is why this process must never put a
        # tool in a session or group of its own. The grandchild ignores SIGTERM so that it
        # is still there when this call returns, which is what makes the claim checkable
        # rather than a race: neither SIGKILL nor a group signal was sent to it.
        pid_file = os.path.join(self.directory, "pid")
        stub = self.stub(
            "spawn.py",
            "import os, signal, time, subprocess, sys\n"
            "signal.signal(signal.SIGTERM, signal.SIG_IGN)\n"
            "child = subprocess.Popen([sys.executable, '-c',\n"
            "    'import signal, time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(120)'])\n"
            f"open({pid_file!r}, 'w').write('%%d %%d' %% (os.getpid(), child.pid))\n"
            "time.sleep(120)\n".replace("%%", "%"))
        code, _output, elapsed = self.bounded([sys.executable, stub], 1.0, 4096)
        self.assertIsNone(code)
        self.assert_stopped_within(elapsed, STUB_STARTUP_ALLOWANCE_SECONDS)
        parent_pid, child_pid = (int(value) for value in
                                 Path(pid_file).read_text().split())
        try:
            # The direct child was signalled and reaped by the bounded run itself.
            self.assertFalse(_pid_alive(parent_pid), "the direct child was not reaped")
            # The grandchild was not: nothing here signals a group, so it is left for the
            # worker's group kill, which is the only thing meant to reach it.
            self.assertTrue(_pid_alive(child_pid), "the grandchild did not outlive the kill")
        finally:
            os.kill(child_pid, signal.SIGKILL)

    def test_a_tool_that_floods_stdout_is_stopped_and_reaped_at_its_bound(self):
        # Without the read bound a tool could make this process buffer without limit. The
        # stub ignores the bound it is given and writes 8 MiB, so the bound is what stops
        # the run, and the run stops it there rather than waiting out the timeout: it is
        # given a minute and must return the failure in a fraction of that.
        pid_file = os.path.join(self.directory, "flood-pid")
        stub = self.stub(
            "flood.py",
            "import os, sys\n"
            f"open({pid_file!r}, 'w').write(str(os.getpid()))\n"
            "sys.stdout.buffer.write(b'x' * (8 << 20))\n")
        code, output, elapsed = self.bounded([sys.executable, stub], 60.0, 64 * 1024)
        self.assertIsNone(code)
        self.assertEqual(output, b"")
        self.assert_stopped_within(elapsed)
        self.assertFalse(_pid_alive(int(Path(pid_file).read_text())))

    def test_a_tool_that_writes_exactly_up_to_its_bound_is_still_returned(self):
        # The bound is a ceiling, not a threshold: a payload of exactly ``limit_bytes`` is
        # fine (a 512 px WebP and a probe report are both well inside it) and only more
        # than that is a failure.
        stub = self.stub("exact.py", "import sys\nsys.stdout.buffer.write(b'y' * 4096)\n")
        code, output, _elapsed = self.bounded([sys.executable, stub], 30.0, 4096)
        self.assertEqual(code, 0)
        self.assertEqual(len(output), 4096)

    def test_a_tool_that_floods_stderr_is_stopped_at_its_bound(self):
        # stderr is never returned or shown to anyone, so a flood there is not a reason to
        # keep the tool alive: the cap stops and reaps it, rather than draining every byte
        # it cares to write. The stub writes 16 MiB with a 32 KiB cap, and must be ended
        # long before the minute it is given.
        pid_file = os.path.join(self.directory, "stderr-pid")
        stub = self.stub(
            "stderr_flood.py",
            "import os, sys\n"
            f"open({pid_file!r}, 'w').write(str(os.getpid()))\n"
            "for _ in range(64):\n"
            "    sys.stderr.buffer.write(b'e' * (256 << 10))\n"
            "sys.stderr.flush()\n")
        code, output, elapsed = self.bounded([sys.executable, stub], 60.0, 64 * 1024)
        self.assertIsNone(code)
        self.assertEqual(output, b"")
        self.assert_stopped_within(elapsed)
        self.assertFalse(_pid_alive(int(Path(pid_file).read_text())))

    def test_a_chatty_stderr_below_its_cap_does_not_hold_up_the_result(self):
        # The cap must not fire on a tool that is merely talkative: one that writes a few
        # hundred bytes of its own noise and then its real result still succeeds, and its
        # stderr is neither returned nor shown.
        stub = self.stub(
            "stderr_chatty.py",
            "import sys\n"
            "sys.stderr.write('note: ' * 100)\n"
            "sys.stderr.flush()\n"
            "sys.stdout.write('done')\n")
        code, output, elapsed = self.bounded([sys.executable, stub], 5.0, 4096)
        self.assertEqual(code, 0)
        self.assertEqual(output, b"done")
        self.assert_stopped_within(elapsed)

    def test_the_tool_is_never_run_through_a_shell(self):
        # A path containing shell syntax must arrive as one argument. The stub reports the
        # arguments it received, so a shell that re-split or expanded the marker would
        # change what it prints.
        marker = os.path.join(self.directory, "argv count; rm -rf nope")
        stub = self.stub("argv.py", "import sys\nprint(len(sys.argv), sys.argv[1])\n")
        code, output, _elapsed = self.bounded([sys.executable, stub, marker], 30.0, 4096)
        self.assertEqual(code, 0)
        count, received = output.decode().strip().split(" ", 1)
        self.assertEqual(count, "2")
        self.assertEqual(received, marker)

    def test_the_encoder_does_not_depend_on_a_shell_being_present(self):
        # ``subprocess.Popen`` with a list and no ``shell=True`` is the property that
        # makes the test above true, so it is asserted on the source as well.
        source = Path(ENCODER).read_text()
        spawn = source.split("def _run_bounded(", 1)[1].split("def _read_tool(", 1)[0]
        self.assertNotIn("shell=True", spawn)

    def test_unset_and_relative_tool_paths_are_never_searched_on_path(self):
        # The configured tool is an absolute path, so a bare name never reaches PATH. The
        # check is on the constants the process actually uses.
        self.assertNotEqual(os.path.basename(encoder.FFMPEG), encoder.FFMPEG)
        self.assertNotEqual(os.path.basename(encoder.FFPROBE), encoder.FFPROBE)


def _pid_alive(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


class NetworkBoundTests(EncoderCase):
    """No URL input, no external references, no arbitrary demuxer."""

    def test_the_probe_whitelist_admits_only_file_and_pipe_protocols(self):
        # A URL would be opened by FFmpeg's own network stack, outside every bound this
        # process applies. ``file`` and ``pipe`` are local by definition.
        protocols = {entry.strip() for entry in encoder.PROTOCOL_WHITELIST.split(",")}
        self.assertEqual(protocols, {"file", "pipe"})
        for refused in ("http", "https", "tcp", "udp", "rtmp", "ftp", "hls", "crypto"):
            self.assertNotIn(refused, protocols)

    def test_the_container_whitelist_admits_no_playlist_format(self):
        # HLS and DASH reference external segments and a manifest, which is how a
        # container can pull in remote bytes. Only the containers the product captures
        # may be demuxed.
        for refused in ("hls", "dash", "rtsp", "sdp", "concat", "crypto", "image2"):
            self.assertNotIn(refused, encoder.VIDEO_FORMATS)

    def test_the_format_whitelist_admits_only_captured_container_groups(self):
        # ``-format_whitelist`` takes a supported list of names, and this is that list. It
        # is not the set of demuxers that can ever run: the input's own header chooses the
        # demuxer within it, and ``VIDEO_FORMATS`` is what any reported container is
        # checked against, so the names here have to be known aliases.
        for group in encoder.INPUT_FORMAT.split(","):
            self.assertIn(group, encoder.VIDEO_FORMATS, group)

    def test_a_playlist_is_refused_before_it_is_parsed_at_all(self):
        # The format whitelist is on the command line, so this is decided before the input
        # is opened: an m3u8 naming a remote segment is never demuxed, rather than being
        # read and then rejected. The manifest points at a closed local port and the case
        # still fails, which is the property that matters.
        playlist = self.write_source(
            b"#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:1.0,\nhttp://127.0.0.1:9/segment.ts\n",
            name="remote.m3u8")
        output = self.path("out.webp")
        completed = run_encoder([playlist, output, "video"])
        if FFMPEG is None or FFPROBE is None:
            self.assertEqual(completed.returncode, encoder.EXIT_TOOL_UNAVAILABLE)
        else:
            self.assertEqual(completed.returncode, encoder.EXIT_UNSUPPORTED_INPUT)
        self.assert_no_output(output)

    def test_the_container_whitelist_accepts_the_captured_containers(self):
        for accepted in ("mp4", "mov", "matroska", "webm"):
            self.assertIn(accepted, encoder.VIDEO_FORMATS)

    def test_an_unlisted_container_is_refused_even_when_ffprobe_can_read_it(self):
        for report in ({"format": {"format_name": "hls"}},
                       {"format": {"format_name": "image2"}},
                       {"format": {"format_name": "dash"}},
                       {"format": {}},
                       {}):
            self.assertIsNone(encoder._video_format(report))
            self.assertIsNone(encoder._parse_report(json.dumps(report).encode()))

    def test_a_multi_alias_container_name_is_accepted_on_any_known_alias(self):
        # ``mov,mp4,m4a,3gp,3g2,mj2`` and ``matroska,webm`` are one demuxer under several
        # names, and which name comes first varies. Requiring a particular position would
        # refuse ordinary files.
        for name in ("mov,mp4,m4a,3gp,3g2,mj2", "matroska,webm", "webm,matroska",
                     "MP4", " mp4 , m4a "):
            self.assertIsNotNone(encoder._video_format({"format": {"format_name": name}}), name)

    def test_the_probe_command_hardens_the_input_before_it_is_opened(self):
        # Asserted on the argument vector the process builds, so an edit that drops the
        # whitelist fails here rather than on a host that suddenly parses a playlist or
        # fetches a URL. Both the probe and the decode have to carry it, and both are
        # checked, because either one opening an unlisted file is enough to matter.
        for name, build in (("probe", self._probe_command), ("decode", self._decode_command)):
            command = build()
            for option in ("-protocol_whitelist", "-format_whitelist"):
                self.assertIn(option, command, name)
                self.assertEqual(
                    command[command.index(option) + 1],
                    encoder.PROTOCOL_WHITELIST if option == "-protocol_whitelist"
                    else encoder.INPUT_FORMAT, name)
            self.assertTrue(os.path.isabs(command[0]), name)

    def test_the_input_hardening_is_placed_before_the_input_argument(self):
        # The whitelist only narrows an input that is opened after it. After ``-i`` it would
        # either apply to the wrong file or be rejected, so the position is part of the
        # bound rather than a style choice.
        for name, build in (("probe", self._probe_command), ("decode", self._decode_command)):
            command = build()
            self.assertLess(command.index("-format_whitelist"), command.index("-i"), name)

    def test_the_demuxer_option_is_only_passed_where_its_demuxer_applies(self):
        # The parent uses an extensionless source. Names must not control hardening.
        for name in ("source", "misleading.webm", "misleading.mp4"):
            path = self.write_source(b"\x00\x00\x00\x18ftypisom", name=name)
            options = encoder._input_hardening(path)
            self.assertEqual(options[options.index("-f") + 1], "mov")
            self.assertEqual(options[options.index("-enable_drefs") + 1], "0")
            Path(path).write_bytes(b"\x1a\x45\xdf\xa3")
            options = encoder._input_hardening(path)
            self.assertEqual(options[options.index("-f") + 1], "matroska")
            self.assertNotIn("-enable_drefs", options)

    def test_no_tool_is_given_a_session_or_process_group_of_its_own(self):
        # The worker kills this process's whole group when its own timeout expires, and
        # that is the only bound reaching a tool still running after this encoder is gone.
        # A session of the tool's own would hide it from that kill, and a fork-time
        # callback is out for the reason the parent passes none: a threaded process must
        # not run one. Checked in the argument vectors, where such a thing would appear.
        for name, build in (("probe", self._probe_command), ("decode", self._decode_command)):
            command = build()
            self.assertNotIn("start_new_session", command, name)
            self.assertNotIn("preexec_fn", command, name)

    def test_importing_the_encoder_runs_no_tool_at_all(self):
        # Importing this module happens inside the API process, before any bound exists and
        # before the image and GIF paths decide anything. It must therefore not start a
        # process for any reason, and no kind may reach a tool before the resource limits
        # are applied. Checked by importing it in a fresh interpreter with every spawn
        # trapped, which is the only way to see a call that a helper would make.
        program = (
            "import subprocess, sys\n"
            "spawned = []\n"
            "subprocess.Popen = lambda *a, **k: spawned.append(a and a[0])\n"
            "subprocess.run = lambda *a, **k: spawned.append(a and a[0])\n"
            "subprocess.check_output = lambda *a, **k: spawned.append(a and a[0])\n"
            f"sys.path.insert(0, {str(SERVER_DIR)!r})\n"
            "import image_thumbnail_encode\n"
            "print(len(spawned))\n")
        completed = subprocess.run([sys.executable, "-c", program], check=False,
                                   capture_output=True, timeout=60)
        self.assertEqual(completed.returncode, 0, completed.stderr[-400:])
        self.assertEqual(completed.stdout.strip(), b"0")

    def test_no_kind_reaches_a_tool_before_the_resource_limits_are_applied(self):
        # The limits come first in ``main`` for every kind. This replaces the limit step
        # with a refusal and checks that no kind gets past it, which is what makes the
        # ordering a property rather than a comment.
        if Image is None:
            self.skipTest("Pillow is unavailable in this environment")
        for kind in encoder.KINDS:
            output = self.path(f"ordered-{kind}.webp")
            program = (
                "import subprocess, sys\n"
                "spawned = []\n"
                "subprocess.Popen = lambda *a, **k: spawned.append(a and a[0])\n"
                "subprocess.run = lambda *a, **k: spawned.append(a and a[0])\n"
                f"sys.path.insert(0, {str(SERVER_DIR)!r})\n"
                "import image_thumbnail_encode as encoder\n"
                "encoder._apply_own_resource_limits = lambda: False\n"
                "encoder.main(['x', sys.argv[1], sys.argv[2]])\n"
                "print(len(spawned))\n")
            source = self.write_source(png_bytes(), f"ordered-{kind}.png")
            completed = subprocess.run(
                [sys.executable, "-c", program, source, output], check=False,
                capture_output=True, timeout=60)
            self.assertEqual(completed.stdout.strip(), b"0", kind)
            self.assertFalse(os.path.exists(output), kind)

    def _probe_command(self):
        """The exact ffprobe argument vector, captured instead of executed."""
        captured = {}

        def fake_run_bounded(command, timeout, limit_bytes=None):
            captured["command"] = list(command)
            return 1, b""

        original = encoder._run_bounded
        encoder._run_bounded = fake_run_bounded
        try:
            with self.assertRaises(encoder._UnsupportedInput):
                encoder._probe_display(self.write_source(b"ftyp", "source"))
        finally:
            encoder._run_bounded = original
        return captured["command"]

    def _decode_command(self):
        """The exact ffmpeg argument vector, captured instead of executed.

        ``_probe_display`` is stubbed so the decode is reached without a real video.
        """
        captured = {}

        def fake_run_bounded(command, timeout, limit_bytes=None):
            captured["command"] = list(command)
            return 1, b""

        original_run, original_probe = encoder._run_bounded, encoder._probe_display
        encoder._run_bounded = fake_run_bounded
        encoder._probe_display = lambda _path: (1280, 720, 2000)
        try:
            with self.assertRaises(encoder._EncodeFailed):
                encoder._video_thumbnail(self.write_source(b"ftyp", "source"))
        finally:
            encoder._run_bounded = original_run
            encoder._probe_display = original_probe
        return captured["command"]


# ---------------------------------------------------------------------------
# Video decoding against real generated clips
# ---------------------------------------------------------------------------


@requires_ffmpeg
class VideoTests(EncoderCase):
    def test_an_mp4_is_decoded_into_a_bounded_webp_with_source_dimensions(self):
        source = h264_mp4(self.path("clip.mp4"), size="1280x720", seconds="2")
        _code, metadata, output = self.encode(Path(source).read_bytes(), "video",
                                              name="clip.mp4")
        self.assertEqual((metadata["width"], metadata["height"]), (1280, 720))
        self.assertEqual(metadata["duration_ms"], 2000)
        assert Image is not None
        with Image.open(output) as tile:
            self.assertEqual(tile.format, "WEBP")
            self.assertEqual(tile.size, (512, 288))
            self.assertLessEqual(max(tile.size), encoder.MAX_EDGE)
            self.assertEqual(getattr(tile, "n_frames", 1), 1)
        self.assertLessEqual(os.path.getsize(output), encoder.MAX_OUTPUT_BYTES)

    def test_a_webm_is_decoded_through_the_matroska_demuxer(self):
        # A WebM is one of the containers the product captures, and it is demuxed by its
        # own alias list rather than by the MP4 one. Its source is smaller than the tile
        # bound, so the tile also proves the decode did not upscale it.
        source = build_video(self.path("clip.webm"),
                             ["-f", "lavfi", "-i", "testsrc=size=320x240:rate=10",
                              "-t", "2", "-c:v", "libvpx-vp9", "-b:v", "200k"])
        _code, metadata, output = self.encode(Path(source).read_bytes(), "video",
                                              name="clip.webm")
        self.assertEqual((metadata["width"], metadata["height"]), (320, 240))
        self.assertGreater(metadata["duration_ms"], 0)
        assert Image is not None
        with Image.open(output) as tile:
            self.assertEqual(tile.size, (320, 240))

    def test_a_portrait_source_keeps_the_tile_portrait(self):
        source = h264_mp4(self.path("portrait.mp4"), size="720x1280", seconds="2")
        _code, metadata, output = self.encode(Path(source).read_bytes(), "video",
                                              name="portrait.mp4")
        self.assertEqual((metadata["width"], metadata["height"]), (720, 1280))
        assert Image is not None
        with Image.open(output) as tile:
            self.assertEqual(tile.size, (288, 512))

    def test_a_quarter_turn_rotation_is_applied_to_the_reported_dimensions(self):
        # A phone clip stores 640x360 with a display matrix of 90 degrees and displays as
        # 360x640. Metadata must describe the display geometry, which is what the UI
        # reserves space for. The fixture is a base clip plus a copy remux carrying a real
        # matrix, and the fixture itself is verified before it is used: a build that did
        # not write one would make this test pass for the wrong reason.
        base = h264_mp4(self.path("flat.mp4"), size="640x360", seconds="1.5")
        rotated = copied_with_rotation(base, self.path("rotated.mov"), 90)
        matrix = reports_display_matrix(rotated)
        if matrix is not True:
            self.fail(NO_DISPLAY_MATRIX_FIXTURE if matrix is False else
                      "the fixture could not be inspected at all")
        _code, metadata, output = self.encode(Path(rotated).read_bytes(), "video",
                                              name="rotated.mov")
        self.assertEqual((metadata["width"], metadata["height"]), (360, 640))
        assert Image is not None
        with Image.open(output) as tile:
            self.assertEqual(tile.size, (288, 512))

    def test_a_source_smaller_than_the_tile_is_not_upscaled(self):
        # The tile bound is a ceiling on the long edge. Scaling a 200x100 clip up to 512 px
        # would invent detail and grow the artifact, so the decode keeps the source size.
        source = h264_mp4(self.path("small.mp4"), size="200x100", seconds="1")
        _code, metadata, output = self.encode(Path(source).read_bytes(), "video",
                                              name="small.mp4")
        self.assertEqual((metadata["width"], metadata["height"]), (200, 100))
        assert Image is not None
        with Image.open(output) as tile:
            self.assertEqual(tile.size, (200, 100))
            self.assertLessEqual(max(tile.size), encoder.MAX_EDGE)

    def test_a_source_shorter_than_the_seek_point_still_yields_a_frame(self):
        # The poster frame is taken slightly after the start. A clip that ends before that
        # point is short but perfectly valid, and must not come back empty.
        source = h264_mp4(self.path("short.mp4"), size="200x100", seconds="0.1")
        _code, metadata, output = self.encode(Path(source).read_bytes(), "video",
                                              name="short.mp4")
        self.assertEqual((metadata["width"], metadata["height"]), (200, 100))
        # The declared duration of a 0.1 s encode is the muxer's own rounding of one frame
        # time, not exactly 100 ms, so the bound is the point: a small positive value that
        # could not be a first-frame delay misreported as the whole source.
        self.assertIsInstance(metadata["duration_ms"], int)
        self.assertGreater(metadata["duration_ms"], 0)
        self.assertLessEqual(metadata["duration_ms"], 500)
        self.assertGreater(os.path.getsize(output), 0)

    def test_the_decoded_frame_is_a_real_picture_and_not_a_blank_tile(self):
        # ``testsrc`` is a colour-bar pattern, so a frame that decoded correctly is
        # neither uniform nor fully black. A silently empty or zeroed buffer would fail
        # both checks while still producing a valid WebP header.
        source = h264_mp4(self.path("pattern.mp4"), size="1280x720", seconds="2")
        _code, _metadata, output = self.encode(Path(source).read_bytes(), "video",
                                               name="pattern.mp4")
        assert Image is not None
        with Image.open(output) as tile:
            frame = tile.convert("RGB")
            colors = frame.getcolors(maxcolors=1 << 20)
            self.assertIsNotNone(colors)
            self.assertGreater(len(colors), 50)
            self.assertNotEqual(frame.resize((1, 1)).getpixel((0, 0)), (0, 0, 0))

    def test_the_poster_frame_skips_a_black_intro_for_a_coloured_later_frame(self):
        # The regression: a capture whose black intro outlasts the offset this worker used to
        # seek to. The clip opens with two seconds of black, and a tenth of its 30 seconds is
        # the three-second cap, so the poster lands past the intro. The old fixed 0.5 s seek
        # landed inside the black run, which is the black tile this change removes; the
        # coloured frame is only selected if the seek is duration-relative.
        source = self.coloured_after_black_intro(self.path("intro.mp4"),
                                                 intro_seconds="2", tinted_seconds="28")
        _code, metadata, output = self.encode(Path(source).read_bytes(), "video",
                                              name="intro.mp4")
        seek_ms = encoder._seek_seconds(metadata["duration_ms"])[1]
        self.assertGreater(seek_ms, 2_000,
                           "the fixture must keep the coloured frame past the seek point")
        self.assertGreater(seek_ms, encoder.VIDEO_SEEK_FLOOR_MS,
                           "the fixture must not be reachable by the old fixed offset")
        assert Image is not None
        with Image.open(output) as tile:
            red, green, blue = tile.convert("RGB").resize((1, 1)).getpixel((0, 0))
        self.assertGreater(red, INTRO_TINT_CHANNEL_FLOOR,
                           f"the poster is the black intro: {(red, green, blue)}")
        self.assertGreater(green, INTRO_TINT_CHANNEL_FLOOR,
                           f"the poster is the black intro: {(red, green, blue)}")
        self.assertLess(blue, INTRO_BLACK_CHANNEL_CEILING,
                        f"the poster is the black intro: {(red, green, blue)}")

    def test_a_short_capture_keeps_the_offset_it_had_before_the_fraction(self):
        # A tenth of this capture is not *after* the fixed offset this worker used before; it
        # is earlier, and seeking there would move the poster back toward the black intro
        # instead of past it. The capture is long enough to hold the old offset, so the seek
        # is the old choice exactly. This clip proves the seek is unchanged for a capture of
        # this length, not that it clears an intro longer than the offset.
        #
        # The fixture starts black for a second, so a poster taken at the offset would be
        # black by design: only the seek itself is asserted here.
        source = self.coloured_after_black_intro(self.path("short-intro.mp4"),
                                                 intro_seconds="1", tinted_seconds="2.5",
                                                 sample_at="1.5")
        _code, metadata, output = self.encode(Path(source).read_bytes(), "video",
                                              name="short-intro.mp4")
        self.assertGreater(metadata["duration_ms"], 2 * encoder.VIDEO_SEEK_FLOOR_MS)
        self.assertEqual(encoder._seek_seconds(metadata["duration_ms"])[1],
                         encoder.VIDEO_SEEK_FLOOR_MS)
        self.assertEqual(encoder._seek_seconds(metadata["duration_ms"])[0], "0.500")
        assert Image is not None
        with Image.open(output) as tile:
            self.assertEqual(tile.size, (320, 240))

    def test_a_capture_too_short_to_hold_the_offset_is_seeked_inside_itself(self):
        # End to end on a real clip of about a third of a second, all of it coloured. The
        # duration fraction seeks it to its middle, so a coloured poster only exists if a frame
        # at that point decoded: a seek that landed on or past the last frame writes no frame
        # at all, and the retry at the start of the file would then be the only thing
        # answering. The seek is asserted against the duration the same encode reported, which
        # is what keeps the clamp honest for a clip this short.
        source = self.coloured_after_black_intro(self.path("short-hold.mp4"),
                                                 intro_seconds="0.0", tinted_seconds="0.3",
                                                 sample_at="0.100",
                                                 intro_verifiable=False)
        _code, metadata, output = self.encode(Path(source).read_bytes(), "video",
                                              name="short-hold.mp4")
        duration_ms = metadata["duration_ms"]
        self.assertIsInstance(duration_ms, int)
        self.assertGreater(duration_ms, 0)
        self.assertLess(duration_ms, 2 * encoder.VIDEO_SEEK_FLOOR_MS)
        seek_ms = encoder._seek_seconds(duration_ms)[1]
        self.assertGreater(seek_ms, 0)
        self.assertLess(seek_ms, duration_ms)
        assert Image is not None
        with Image.open(output) as tile:
            self.assertEqual(tile.size, (320, 240))
            red, green, blue = tile.convert("RGB").resize((1, 1)).getpixel((0, 0))
        # A black or empty tile would fail this, which is what makes it a decode of the seek
        # rather than merely a published artifact.
        self.assertGreater(red, INTRO_TINT_CHANNEL_FLOOR,
                           f"no frame decoded at {seek_ms} ms: {(red, green, blue)}")
        self.assertLess(blue, INTRO_BLACK_CHANNEL_CEILING,
                        f"no frame decoded at {seek_ms} ms: {(red, green, blue)}")

    def test_the_poster_is_the_frame_at_the_old_offset_when_the_intro_is_shorter(self):
        # The complement of the duration-relative case: an intro that is over before the fixed
        # offset is reached still yields a coloured poster, so this change cannot trade one
        # black tile for another on ordinary short captures.
        source = self.coloured_after_black_intro(self.path("early-colour.mp4"),
                                                 intro_seconds="0.2", tinted_seconds="3",
                                                 sample_at="1.0")
        _code, metadata, output = self.encode(Path(source).read_bytes(), "video",
                                              name="early-colour.mp4")
        self.assertEqual(encoder._seek_seconds(metadata["duration_ms"])[1],
                         encoder.VIDEO_SEEK_FLOOR_MS)
        assert Image is not None
        with Image.open(output) as tile:
            red, green, blue = tile.convert("RGB").resize((1, 1)).getpixel((0, 0))
        self.assertGreater(red, INTRO_TINT_CHANNEL_FLOOR,
                           f"the poster is not the coloured frame: {(red, green, blue)}")

    def test_a_clean_empty_decode_is_reported_as_failure_for_a_broken_source(self):
        # A source the tool cannot open at all exits non-zero, which is a failure rather than a
        # clean empty decode, so the caller will not retry it.
        ok, payload = encoder._decode_frame(self.write_source(b"ftyp", "source"), "0.000",
                                           encoder.MAX_OUTPUT_BYTES, self.path("frame.webp"))
        self.assertFalse(ok)
        self.assertEqual(payload, b"")

    def test_a_clean_empty_write_into_the_stage_file_is_a_success(self):
        # The retryable outcome itself: a clean exit and no artifact written.
        original_run, original_hardening = encoder._run_bounded, encoder._input_hardening
        encoder._run_bounded = lambda *_a, **_k: (0, b"")
        encoder._input_hardening = lambda _path: []
        try:
            ok, payload = encoder._decode_frame(self.path("source"), "0.000", 1024,
                                                self.path("absent.webp"))
        finally:
            encoder._run_bounded = original_run
            encoder._input_hardening = original_hardening
        self.assertTrue(ok)
        self.assertEqual(payload, b"")

    def test_a_failed_decode_is_terminal_and_never_retried_at_the_start(self):
        # A tool that fails, is killed at its wall clock or floods its output is a failure of
        # the host, not a source with no frame at the chosen point. Retrying it would decode a
        # failing source twice and could return a frame that hides the fault.
        for code in (1, 127, -9):
            calls = []
            original_run, original_probe = encoder._run_bounded, encoder._probe_display

            def fake(command, timeout, limit_bytes=None):
                calls.append(list(command))
                return code, b""

            encoder._run_bounded = fake
            encoder._probe_display = lambda _path: (320, 240, 2_000)
            try:
                with self.assertRaises(encoder._EncodeFailed):
                    encoder._video_thumbnail(self.write_source(b"ftyp", "source"))
            finally:
                encoder._run_bounded = original_run
                encoder._probe_display = original_probe
            self.assertEqual(len(calls), 1, f"a failed decode was retried: exit {code}")

    def test_a_decode_that_writes_an_over_bound_file_is_terminal(self):
        # A clean exit whose artifact reaches the bound is a truncated frame, not a short one,
        # so it must not become eligible for the retry.
        calls = []
        original_run, original_probe = encoder._run_bounded, encoder._probe_display

        def fake(command, timeout, limit_bytes=None):
            calls.append(list(command))
            # The bound is passed to the tool as ``-fs``; the fake writes exactly that much.
            Path(command[-1]).write_bytes(b"x" * int(command[command.index("-fs") + 1]))
            return 0, b""

        encoder._run_bounded = fake
        encoder._probe_display = lambda _path: (320, 240, 2_000)
        try:
            with self.assertRaises(encoder._EncodeFailed):
                encoder._video_thumbnail(self.write_source(b"ftyp", "source"))
        finally:
            encoder._run_bounded = original_run
            encoder._probe_display = original_probe
        self.assertEqual(len(calls), 1, "an over-bound artifact was retried")

    def test_an_unreadable_artifact_is_terminal_rather_than_an_empty_decode(self):
        # Only a *missing* artifact is the clean empty outcome. One that exists and cannot be
        # read is a different matter: a frame was written, this process could not read it, and
        # a second decode would neither change that nor be honest about it. The tool exits 0
        # and the payload is there, so only the read itself can fail. The fake tool writes a
        # real artifact every time, so the read would succeed if it were reached intact.
        calls = []
        original_run, original_probe = encoder._run_bounded, encoder._probe_display
        original_open = io.open
        original_hardening = encoder._input_hardening

        def fake(command, timeout, limit_bytes=None):
            calls.append(list(command))
            Path(command[-1]).write_bytes(b"RIFF....WEBP")
            return 0, b""

        def unreadable(path, *args, **kwargs):
            # The stage artifact only. The sidecar and the source are opened through this
            # same patched builtin by other code, and breaking those would not be this test.
            if str(path).endswith("frame.webp"):
                raise PermissionError(13, "Permission denied")
            return original_open(path, *args, **kwargs)

        encoder._run_bounded = fake
        encoder._probe_display = lambda _path: (320, 240, 2_000)
        source = self.write_source(b"\x00\x00\x00\x18ftypisom", "source")
        with mock.patch("builtins.open", unreadable):
            try:
                ok, payload = encoder._decode_frame(source, "0.500", 1024,
                                                    self.path("frame.webp"))
                self.assertFalse(ok, "an unreadable artifact was treated as an empty decode")
                self.assertEqual(payload, b"")
                # And it is terminal, exactly like a failed decode: the caller never reaches
                # the first-frame retry. The count is reset first because the call above is
                # already one decode of its own.
                calls.clear()
                with self.assertRaises(encoder._EncodeFailed):
                    encoder._video_thumbnail(source)
                self.assertEqual(len(calls), 1, "an unreadable artifact was retried")
            finally:
                encoder._run_bounded = original_run
                encoder._probe_display = original_probe
                encoder._input_hardening = original_hardening

    def test_a_successful_empty_decode_is_retried_exactly_once_at_the_start(self):
        # The complement: a clean run that writes no frame is retried once, at the start of the
        # file, and then reported as a failure if that also yields nothing. The retry must use
        # the first-frame seek and keep every other option identical.
        calls = []
        original_run, original_probe = encoder._run_bounded, encoder._probe_display

        def fake(command, timeout, limit_bytes=None):
            calls.append(list(command))
            return 0, b""

        encoder._run_bounded = fake
        encoder._probe_display = lambda _path: (320, 240, 2_000)
        try:
            with self.assertRaises(encoder._EncodeFailed):
                encoder._video_thumbnail(self.write_source(b"ftyp", "source"))
        finally:
            encoder._run_bounded = original_run
            encoder._probe_display = original_probe
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[0][calls[0].index("-ss") + 1], "0.500")
        self.assertEqual(calls[1][calls[1].index("-ss") + 1],
                         encoder.VIDEO_FIRST_FRAME_SEEK_SECONDS)
        self.assertEqual(calls[0][calls[0].index("-i") + 1],
                         calls[1][calls[1].index("-i") + 1])
        self.assertNotIn("image2pipe", calls[1], "the retry must not go back to a pipe")

    def test_a_short_clip_decodes_its_frame_through_the_retry(self):
        # End to end on a real generated source: a single-frame capture has no timestamp
        # strictly inside it, so the duration-relative seek succeeds and writes nothing, and
        # the retry at the start of the file is what produces the poster.
        source = build_video(
            self.path("one-frame.mp4"),
            ["-f", "lavfi", "-i", "color=c=orange:size=320x240:rate=10:d=0.5",
             "-frames:v", "1", "-pix_fmt", "yuv420p", "-c:v", "libx264"])
        _code, metadata, output = self.encode(Path(source).read_bytes(), "video",
                                              name="one-frame.mp4")
        self.assertEqual(metadata["duration_ms"], 100)
        assert Image is not None
        with Image.open(output) as tile:
            self.assertEqual(tile.size, (320, 240))
            red, green, blue = tile.convert("RGB").resize((1, 1)).getpixel((0, 0))
        self.assertGreater(red, INTRO_TINT_CHANNEL_FLOOR,
                           f"the single frame did not decode: {(red, green, blue)}")

    def coloured_after_black_intro(self, path, *, intro_seconds, tinted_seconds="2",
                                  sample_at=None, intro_verifiable=True):
        """A clip that is black for ``intro_seconds``, then a flat colour.

        ``color`` is a flat frame, so the encoder's libx264 settings make the intro a run of
        keyframes and the coloured part a single GOP. The fixture is verified before it is
        asserted on, because a clip whose later frame is *not* distinguishable from the
        intro would let the pixel assertions below pass while proving nothing.

        ``sample_at`` overrides where the coloured part is sampled, in seconds. The default
        sits just inside it, which is where a black or fade-in intro would already be over.
        ``intro_verifiable=False`` skips only the intro's own colour check, for a caller that
        needs a clip with no intro and cannot ask this fixture for one.
        """
        source = build_video(
            path,
            ["-f", "lavfi", "-i", f"color=c=black:size=320x240:rate=10:d={intro_seconds}",
             "-f", "lavfi", "-i", f"color=c=orange:size=320x240:rate=10:d={tinted_seconds}",
             "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0[out]", "-map", "[out]",
             "-pix_fmt", "yuv420p", "-c:v", "libx264"])
        intro_ms = int(float(intro_seconds) * 1000)
        if intro_verifiable:
            intro_pixel = self.frame_colour(source, max(intro_ms - 100, 0))
            self.assertLess(max(intro_pixel), INTRO_BLACK_CHANNEL_CEILING,
                            f"the fixture intro is not black: {intro_pixel}")
        later_ms = int(float(sample_at) * 1000) if sample_at else intro_ms + 500
        later_pixel = self.frame_colour(source, later_ms)
        self.assertGreater(later_pixel[0], INTRO_TINT_CHANNEL_FLOOR,
                           f"the fixture later frame is not coloured: {later_pixel}")
        return source

    def frame_colour(self, source, at_ms):
        """The average colour of ``source`` at ``at_ms``, decoded with the local FFmpeg.

        This samples the *fixture*, not the encoder: it is what establishes that the frame
        the encoder must choose really does differ from the one it must not choose.
        """
        assert FFMPEG is not None
        completed = subprocess.run(
            [FFMPEG, "-hide_banner", "-loglevel", "error", "-nostdin", "-i", source,
             "-ss", f"{at_ms / 1000:.3f}", "-frames:v", "1", "-vf", "scale=1:1",
             "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
            check=False, capture_output=True, timeout=120)
        if completed.returncode != 0 or len(completed.stdout) < 3:
            raise AssertionError(f"the fixture could not be sampled at {at_ms} ms: "
                                 f"{completed.stderr[-200:]}")
        return tuple(completed.stdout[:3])

    def test_garbage_claimed_to_be_an_mp4_is_refused_without_writing_anything(self):
        output = self.path("out.webp")
        _code, _metadata, output = self.encode(b"not a video at all" * 512, "video",
                                               name="broken.mp4",
                                               expect=encoder.EXIT_UNSUPPORTED_INPUT)
        self.assert_no_output(output)

    def test_an_empty_video_source_is_refused(self):
        _code, _metadata, output = self.encode(b"", "video", name="empty.mp4",
                                               expect=encoder.EXIT_UNSUPPORTED_INPUT)
        self.assert_no_output(output)

    def test_a_static_image_is_refused_through_the_video_kind(self):
        # FFmpeg can read a PNG, so the container whitelist is what refuses it. Without
        # that check the worker's classification would not be enforced at all.
        _code, _metadata, output = self.encode(png_bytes(size=(320, 240)), "video",
                                               name="still.png",
                                               expect=encoder.EXIT_UNSUPPORTED_INPUT)
        self.assert_no_output(output)

    def test_an_oversize_video_frame_is_refused_on_its_declared_size(self):
        # 24 MP is the ceiling, and it is checked on the probe's declared geometry before
        # any frame is decoded, so a bomb cannot force the allocation first.
        source = h264_mp4(self.path("huge.mp4"), size="6000x4500", seconds="0.5")
        _code, _metadata, output = self.encode(Path(source).read_bytes(), "video",
                                               name="huge.mp4",
                                               expect=encoder.EXIT_UNSUPPORTED_INPUT)
        self.assert_no_output(output)

    def test_the_video_pair_is_published_together(self):
        source = h264_mp4(self.path("pair.mp4"), size="320x240", seconds="1")
        _code, metadata, output = self.encode(Path(source).read_bytes(), "video",
                                              name="pair.mp4")
        self.assertTrue(os.path.exists(output))
        self.assertTrue(os.path.exists(f"{output}.json"))
        self.assertEqual(set(metadata), {"width", "height", "duration_ms"})


# ---------------------------------------------------------------------------
# Fail-closed behaviour and the metadata helpers
# ---------------------------------------------------------------------------


class DecoderHelperTests(unittest.TestCase):
    def test_a_missing_duration_is_null_and_never_negative(self):
        for container in ({}, {"duration": "N/A"}, {"duration": None}, {"duration": "-1"},
                          {"duration": "nan"}, {"duration": "inf"}, None):
            self.assertIsNone(encoder._duration_ms(container), container)

    def test_a_declared_zero_duration_is_zero_and_not_null(self):
        # ``0`` is a real declaration and the contract allows it; only an unknown or
        # impossible duration is ``null``. A frame-count-derived zero would be a different
        # matter, which is why this is asserted on the container helper alone.
        self.assertEqual(encoder._duration_ms({"duration": "0"}), 0)
        self.assertEqual(encoder._duration_ms({"duration": 0}), 0)

    def test_overflowing_duration_is_unknown_instead_of_invalid_sidecar(self):
        for duration in ("1e308", "1e18", str(2**63 / 1000)):
            self.assertIsNone(encoder._duration_ms({"duration": duration}))

    def test_every_kind_requires_pillow_even_when_video_tools_exist(self):
        with mock.patch.object(encoder, '_apply_own_resource_limits', return_value=True), mock.patch.object(
                encoder, '_pillow_available', return_value=False), mock.patch.object(
                encoder, '_toolchain_available', return_value=True):
            for kind in encoder.KINDS:
                self.assertEqual(encoder.main(['encode', 'unused', 'unused', kind]), encoder.EXIT_TOOL_UNAVAILABLE)

    @requires_pillow
    def test_video_output_is_a_single_webp_within_the_tile_bound(self):
        # The frame is written to a file by the tool, so the fake tool writes the payload to the
        # same path. Each payload here is one this worker must refuse: not WEBP, not a single
        # frame, or larger than the tile.
        large_webp = io.BytesIO()
        Image.new('RGB', (1024, 1024), 'red').save(large_webp, 'WEBP')
        animated_webp = io.BytesIO()
        Image.new('RGB', (32, 32), 'red').save(animated_webp, 'WEBP', save_all=True,
                                            append_images=[Image.new('RGB', (32, 32), 'blue')])
        payloads = [png_bytes(), gif_bytes(), large_webp.getvalue(), animated_webp.getvalue()]
        for payload in payloads:
            written = {}

            def fake_run_bounded(command, timeout, limit_bytes=None):
                Path(command[-1]).write_bytes(payload)
                written['path'] = command[-1]
                return 0, b""

            with self.subTest(payload_size=len(payload)), mock.patch.object(
                    encoder, '_probe_display', return_value=(1600, 900, 1000)), mock.patch.object(
                    encoder, '_input_hardening', return_value=[]), mock.patch.object(
                    encoder, '_run_bounded', side_effect=fake_run_bounded):
                with self.assertRaises(encoder._UnsupportedInput):
                    encoder._video_thumbnail('unused')
                self.assertIn('path', written, "the tool was never asked to write a frame")

    def test_a_positive_duration_truncates_to_whole_milliseconds(self):
        self.assertEqual(encoder._duration_ms({"duration": "2.000000"}), 2000)
        self.assertEqual(encoder._duration_ms({"duration": 1.5}), 1500)
        self.assertEqual(encoder._duration_ms({"duration": "0.0009"}), 0)

    def test_a_pixel_budget_is_enforced_on_declared_dimensions(self):
        encoder._check_pixel_budget(6000, 4000)
        for width, height in ((6000, 4500), (0, 100), (-1, 100), (None, 100), (100, 0), (-1, -1), (True, 1), (1.5, 2)):
            with self.assertRaises(encoder._UnsupportedInput):
                encoder._check_pixel_budget(width, height)

    def test_the_sidecar_serialisation_is_stable_and_exactly_three_keys(self):
        payload = encoder._encode_metadata({"width": 1600, "height": 900,
                                            "duration_ms": None})
        self.assertEqual(payload, b'{"duration_ms":null,"height":900,"width":1600}')
        self.assertEqual(json.loads(payload.decode("ascii")),
                         {"width": 1600, "height": 900, "duration_ms": None})
        rounded = encoder._encode_metadata({"width": 10.7, "height": 4.2, "duration_ms": 5})
        self.assertEqual(json.loads(rounded.decode("ascii"))["width"], 10)

    def test_the_seek_point_is_duration_relative_and_capped(self):
        # A tenth of the duration, floored, so a long capture's black intro is skipped and a
        # short one keeps the position it had before the fraction existed.
        self.assertEqual(encoder._seek_seconds(20_000)[1], 2_000)
        self.assertEqual(encoder._seek_seconds(30_520)[1], 3_000)
        self.assertEqual(encoder._seek_seconds(1_800_000)[1], encoder.VIDEO_SEEK_CAP_MS)
        self.assertEqual(encoder._seek_seconds(65_432)[1], encoder.VIDEO_SEEK_CAP_MS)

    def test_a_short_source_keeps_the_fixed_offset_rather_than_moving_back(self):
        # A tenth of a capture of five seconds or more is not *after* the fixed offset this
        # worker used before; it is earlier. Seeking there would move the poster back toward
        # the black intro instead of past it, so the floor applies and the tile for such a
        # capture is the same choice as the previous recipe. Past five seconds the fraction
        # takes over and only grows.
        for duration_ms in (5_000, 5_100, 10_000, 20_000):
            self.assertGreaterEqual(encoder._seek_seconds(duration_ms)[1],
                                    encoder.VIDEO_SEEK_FLOOR_MS, duration_ms)
        for duration_ms in (5_100, 10_000, 20_000):
            self.assertGreater(encoder._seek_seconds(duration_ms)[1],
                               encoder.VIDEO_SEEK_FLOOR_MS, duration_ms)

    def test_the_seek_never_lands_on_frame_zero(self):
        # Frame 0 is the black frame the duration-relative seek exists to skip, so a
        # sub-millisecond fraction falls back to the fixed offset instead of rounding to 0.
        for duration_ms in (1, 5, 9):
            self.assertEqual(encoder._seek_seconds(duration_ms)[1], duration_ms // 2,
                             duration_ms)
        self.assertGreater(encoder._seek_seconds(1_000)[1], 0)

    def test_a_capture_too_short_to_hold_the_offset_is_seeked_inside_itself(self):
        # The same clamp seen from the caller's side. It only bites where the floor is *longer*
        # than the source can hold — below twice the floor — and there it lands on half the
        # declared duration, strictly inside the source rather than on or past its end.
        for duration_ms in (900, 999, 1_000):
            seek_ms = encoder._seek_seconds(duration_ms)[1]
            self.assertEqual(seek_ms, duration_ms // 2, duration_ms)
            self.assertGreater(seek_ms, 0, duration_ms)
            self.assertLess(seek_ms, duration_ms, duration_ms)
        # A capture just long enough to hold the floor keeps it, and the clamp is inert from
        # there on, so the two rules agree at the crossing point.
        self.assertEqual(encoder._seek_seconds(1_000)[1], 500)
        self.assertEqual(encoder._seek_seconds(1_000)[1], encoder.VIDEO_SEEK_FLOOR_MS)
        for duration_ms in (1_200, 1_400, 2_000):
            self.assertEqual(encoder._seek_seconds(duration_ms)[1],
                             encoder.VIDEO_SEEK_FLOOR_MS, duration_ms)
            self.assertLess(encoder.VIDEO_SEEK_FLOOR_MS, duration_ms, duration_ms)

    def test_an_unknown_duration_seeks_before_the_start_rather_than_past_it(self):
        # No declared duration, a zero and a negative one all take the fallback rather than
        # producing a negative or empty seek argument.
        for duration_ms in (None, 0, -1, -10_000, "2"):
            self.assertEqual(encoder._seek_seconds(duration_ms)[1],
                             encoder.VIDEO_SEEK_FALLBACK_MS, duration_ms)

    def test_a_duration_too_short_to_hold_the_seek_gets_half_of_itself(self):
        # A capture shorter than twice the floor cannot hold it: seeking there would land on or
        # past its last frame, where an accurate decode seek returns nothing at all. Half the
        # declared duration keeps the point strictly inside the source instead.
        self.assertEqual(encoder._seek_seconds(100)[1], 50)
        self.assertEqual(encoder._seek_seconds(600)[1], 300)
        self.assertEqual(encoder._seek_seconds(999)[1], 499)
        for duration_ms in (100, 600, 999, 1_400):
            self.assertGreater(encoder._seek_seconds(duration_ms)[1], 0)
            self.assertLess(encoder._seek_seconds(duration_ms)[1], duration_ms)

    def test_the_clamp_is_a_ceiling_so_the_seek_never_jumps_as_a_source_shrinks(self):
        # The reason the clamp applies to every duration rather than below some cutoff: a
        # ceiling cannot make the seek *later* as the duration grows. A threshold that swapped
        # whole rules at one duration would, and the seek would step backwards one millisecond
        # above it.
        previous = encoder._seek_seconds(1)[1]
        for duration_ms in range(1, 12_000):
            seek_ms = encoder._seek_seconds(duration_ms)[1]
            self.assertGreaterEqual(seek_ms, previous, duration_ms)
            self.assertLessEqual(seek_ms, duration_ms, duration_ms)
            previous = seek_ms

    def test_the_seek_is_formatted_as_whole_millisecond_seconds(self):
        # The same spelling the desktop poster passes, so the two clients spell a seek alike.
        self.assertEqual(encoder._seek_seconds(20_000)[0], "2.000")
        self.assertEqual(encoder._seek_seconds(6_320)[0], "0.632")
        self.assertEqual(encoder._seek_seconds(65_432)[0], "3.000")
        self.assertEqual(encoder._seek_seconds(1_952_517)[0], "3.000")
        # A capture that cannot hold the floor keeps the point inside itself rather than
        # producing a seek at its own declared duration.
        self.assertEqual(encoder._seek_seconds(1_000)[0], "0.500")
        self.assertEqual(encoder._seek_seconds(100)[0], "0.050")
        self.assertEqual(encoder._seek_seconds(6_200)[0], "0.620")
        self.assertEqual(encoder._seek_seconds(1_401)[0], "0.500")

    def test_the_sidecar_bound_is_under_the_read_bound_the_worker_uses(self):
        # The worker's artifact read bound covers the thumbnail; the sidecar has its own
        # much smaller one. Pinning both keeps a future reader from assuming the sidecar
        # shares the 2 MiB allowance.
        self.assertEqual(encoder.MAX_METADATA_BYTES, 4096)
        self.assertLess(encoder.MAX_METADATA_BYTES, encoder.MAX_OUTPUT_BYTES)
        self.assertEqual(encoder.MAX_OUTPUT_BYTES, worker_module.MAX_ARTIFACT_BYTES)

    def test_a_still_source_never_seeks_or_reads_a_frame_count(self):
        # The bounded still contract, checked as code rather than as prose. Comments are
        # stripped first, because the module documents what it does not do and those words
        # are not the behaviour. The GIF path reports no duration, so nothing there may
        # seek, read a frame count or read a per-frame delay; the frame count is read only
        # by the image path's own check for an animated source.
        source = Path(ENCODER).read_text()
        code = "\n".join(line for line in source.splitlines()
                         if not line.lstrip().startswith("#"))
        still = code.split("def _still_thumbnail(", 1)[1].split("\ndef _reject_animated", 1)[0]
        # ``duration_ms`` appears once, as a literal ``None``: the check is that nothing in
        # this path reads or computes one.
        self.assertNotIn("duration_ms=", still)
        self.assertNotIn("seek(", still)
        self.assertNotIn("n_frames", still)
        self.assertEqual(still.count("duration_ms"), 1)
        self.assertIn('"duration_ms": None', still)
        animated = code.split("def _reject_animated(", 1)[1].split("\ndef ", 1)[0]
        # The frame count is read by the animated-source check through ``_frame_count``,
        # which is the only place ``n_frames`` appears at all.
        self.assertTrue(code.count("n_frames"), 1)
        self.assertIn("_frame_count", animated)

    def test_a_still_sidecar_reports_null_for_its_duration(self):
        # Every still kind reports ``null``, which is the one answer a GIF's frame delay
        # must not replace with a number.
        source = Path(ENCODER).read_text()
        still = source.split("def _still_thumbnail(", 1)[1].split("\ndef ", 1)[0]
        self.assertIn('"duration_ms": None', still)


class FailClosedTests(EncoderCase):
    """The platform guard and unsupported-input paths still hold for the new kinds."""

    @requires_pillow
    def test_every_kind_refuses_to_run_when_it_cannot_bound_itself(self):
        # The guard is checked before the kind is dispatched, so a new kind cannot
        # accidentally gain a path that skips it.
        for kind in encoder.KINDS:
            output = self.path(f"guarded-{kind}.webp")
            program = (
                "import sys\n"
                f"sys.path.insert(0, {str(SERVER_DIR)!r})\n"
                "import image_thumbnail_encode as encoder\n"
                "encoder._apply_own_resource_limits = lambda: False\n"
                f"sys.exit(encoder.main(['x', sys.argv[1], sys.argv[2], {kind!r}]))\n")
            source = self.write_source(png_bytes(), f"guarded-{kind}.png")
            completed = run_encoder([source, output, kind], script=self.stub_script(program))
            self.assertEqual(completed.returncode, encoder.EXIT_UNSUPPORTED_PLATFORM)
            self.assertEqual(completed.stdout, b"")
            self.assert_no_output(output)

    @requires_pillow
    def test_no_kind_leaves_a_partial_file_behind_on_an_unsupported_source(self):
        for kind in encoder.KINDS:
            output = self.path(f"absent-{kind}.webp")
            completed = run_encoder([self.path("does-not-exist"), output, kind])
            self.assertEqual(completed.returncode, encoder.EXIT_UNSUPPORTED_INPUT)
            self.assert_no_output(output)

    def stub_script(self, program):
        path = os.path.join(self.directory, f"stub-{abs(hash(program)) & 0xffff}.py")
        Path(path).write_text(program)
        return path

    @requires_pillow
    def test_the_metadata_written_by_every_kind_is_the_same_shape(self):
        # The parent parses the sidecar without knowing the kind, so the keys and their
        # types have to match across all three.
        payloads = {"image": png_bytes(size=(400, 200)), "gif": gif_bytes(size=(400, 200))}
        for kind, payload in payloads.items():
            _code, metadata, _output = self.encode(payload, kind, name=f"{kind}-source")
            self.assertEqual(set(metadata), {"width", "height", "duration_ms"})
            self.assertIsInstance(metadata["width"], int)
            self.assertIsInstance(metadata["height"], int)
            self.assertTrue(metadata["duration_ms"] is None
                            or isinstance(metadata["duration_ms"], int))
            if metadata["duration_ms"] is not None:
                self.assertGreaterEqual(metadata["duration_ms"], 0)


# ---------------------------------------------------------------------------
# Rotation: the display matrix, at the level the probe reads it
# ---------------------------------------------------------------------------


class RotationTests(EncoderCase):
    """The probe's display-matrix handling, without depending on a rotated fixture.

    A fixture with a real matrix is produced by ``VideoTests`` and used there. This class
    covers the same logic on the exact JSON shapes ffprobe returns for a rotated stream,
    which is what keeps the behaviour pinned on a host that cannot write such a fixture.
    Both spellings are real output from this FFmpeg generation: the modern ``rotation``
    side-data entry, and the classic ``rotate`` stream tag that older files carry.
    """

    def test_a_side_data_rotation_of_90_or_270_is_a_quarter_turn(self):
        for degrees in (90, -90, 270, -270):
            stream = {"width": 640, "height": 360,
                      "side_data_list": [{"side_data_type": "Display Matrix",
                                           "rotation": degrees}]}
            self.assertTrue(encoder._quarter_rotation(stream), degrees)

    def test_a_side_data_rotation_of_zero_or_180_is_not_a_quarter_turn(self):
        # 180 degrees swaps nothing and 0 is the identity, so neither may transpose the
        # reported dimensions.
        for degrees in (0, 180, -180, 360):
            stream = {"width": 640, "height": 360,
                      "side_data_list": [{"rotation": degrees}]}
            self.assertFalse(encoder._quarter_rotation(stream), degrees)

    def test_the_classic_rotate_tag_is_a_quarter_turn(self):
        for tag in ("90", "-90", "270"):
            self.assertTrue(encoder._quarter_rotation({"tags": {"rotate": tag}}), tag)
        for tag in ("0", "180", "270x"):
            self.assertFalse(encoder._quarter_rotation({"tags": {"rotate": tag}}), tag)

    def test_a_stream_without_rotation_information_is_not_rotated(self):
        for stream in ({}, {"width": 640, "height": 360}, {"tags": {}},
                       {"side_data_list": []}, {"side_data_list": [{}]},
                       {"side_data_list": "not-a-list"}, {"tags": None}):
            self.assertFalse(encoder._quarter_rotation(stream), stream)

    def test_a_rotated_stream_transposes_the_reported_dimensions(self):
        # End to end through the probe: the command is faked, the report is real ffprobe
        # JSON, and the returned geometry is what the sidecar would carry.
        report = {
            "streams": [{"width": 640, "height": 360,
                         "side_data_list": [{"side_data_type": "Display Matrix",
                                              "rotation": 90}]}],
            "format": {"format_name": "mov,mp4,m4a,3gp,3g2,mj2", "duration": "1.500000"},
        }
        original = encoder._run_bounded
        encoder._run_bounded = lambda *_args, **_kwargs: (0, json.dumps(report).encode())
        try:
            self.assertEqual(encoder._probe_display(self.write_source(b"ftyp", "source")), (360, 640, 1500))
        finally:
            encoder._run_bounded = original

    def test_an_unrotated_stream_keeps_its_reported_dimensions(self):
        report = {
            "streams": [{"width": 640, "height": 360}],
            "format": {"format_name": "matroska,webm", "duration": "2.000000"},
        }
        original = encoder._run_bounded
        encoder._run_bounded = lambda *_args, **_kwargs: (0, json.dumps(report).encode())
        try:
            self.assertEqual(encoder._probe_display(self.write_source(b"\x1a\x45\xdf\xa3", "source")), (640, 360, 2000))
        finally:
            encoder._run_bounded = original

    def test_a_report_shaped_like_a_refused_container_is_never_accepted(self):
        # The demuxer is pinned by the command line, and this is the second check: a
        # report that names a container outside the whitelist cannot become a thumbnail.
        for name in ("hls", "image2", None, ""):
            report = {"streams": [{"width": 640, "height": 360}],
                      "format": {"format_name": name}}
            original = encoder._run_bounded
            encoder._run_bounded = lambda *_a, **_k: (0, json.dumps(report).encode())
            try:
                with self.assertRaises(encoder._UnsupportedInput):
                    encoder._probe_display(self.write_source(b"ftyp", "source"))
            finally:
                encoder._run_bounded = original


if __name__ == "__main__":
    unittest.main()
