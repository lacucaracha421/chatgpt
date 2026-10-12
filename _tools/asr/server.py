#!/usr/bin/env python
"""Lakomics local Japanese speech recognition server (Kotoba-whisper through faster-whisper).

PC only. Listens on 127.0.0.1, takes a YouTube video id, downloads the audio itself, transcribes it on the GPU and
answers with a YouTube json3-shaped caption document that the Lakomics extension reads like any caption track.

Start (see README.md):
  C:\\laku\\asr\\venv\\Scripts\\python.exe V:\\chatgpt\\_tools\\asr\\server.py
"""
import argparse
import bisect
import gc
import json
import os
import queue
import re
import shutil
import subprocess
import sys
import threading
import time
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

DEFAULT_ROOT = r"C:\laku\asr"
VIDEO_ID = re.compile(r"^[A-Za-z0-9_-]{6,20}$")
EXTENSION_ORIGIN = re.compile(r"^chrome-extension://([a-p]{32})$")
MODEL_NAME = "kotoba-whisper-v2.0-faster"
MAX_BODY = 1024
# Cache format: v2 json3 events carry lkSpk (speaker). Older "<id>.json3" files (no speakers) are never read again.
CACHE_FORMAT = "v2"


def log(*parts):
    print(time.strftime("%H:%M:%S"), *parts, flush=True)


def add_cuda_dlls():
    """Make pip-provided CUDA libs (cuBLAS, cuDNN, NVRTC) loadable by CTranslate2."""
    site = Path(sys.prefix) / "Lib" / "site-packages" / "nvidia"
    if not site.is_dir():
        return
    for sub in site.iterdir():
        b = sub / "bin"
        if b.is_dir():
            os.add_dll_directory(str(b))
            os.environ["PATH"] = str(b) + os.pathsep + os.environ.get("PATH", "")


# ---------------------------------------------------------------- json3 building (pure, no GPU needed)

PUNCT_END = tuple("、。，．,.!?！？…")


def clean_segments(segments):
    """Drops leading/trailing (and any other) segments without text. Punctuation-less text is kept as is."""
    kept = [s for s in segments if str(s.get("text", "")).strip() and s.get("words")]
    return kept


def group_words(segment_words, unit_chars):
    """Groups Kotoba word tokens (one or two characters each) into short units.

    A unit closes at punctuation, after a pause of 300 ms or more, once it holds unit_chars characters, and at the
    end of the segment. A unit keeps the real start of its first word and the real end of its last word.
    unit_chars <= 1 keeps every token as its own unit.
    """
    units = []
    for seg_index, words in enumerate(segment_words):
        current = []
        for i, w in enumerate(words):
            current.append(w)
            text = "".join(x["word"] for x in current).strip()
            nxt = words[i + 1] if i + 1 < len(words) else None
            pause = nxt is not None and nxt["start"] - w["end"] >= 0.3
            close = (nxt is None or pause or unit_chars <= 1 or len(text) >= unit_chars or
                     w["word"].strip().endswith(PUNCT_END))
            if close:
                if text:
                    units.append({"text": text, "start": current[0]["start"], "end": max(w["end"], current[0]["start"]),
                                  "seg": seg_index})
                current = []
    return units


# ---------------------------------------------------------------- speakers (pure, no GPU needed)

# Smoothing of the per-unit speakers taken from the diarization turns (see smooth_speakers).
MINOR_RUN_SECONDS = 1.2     # a run of one speaker inside a Kotoba segment shorter than this ...
MINOR_RUN_CHARS = 3         # ... or holding at most this many characters ...
MINOR_RUN_SHARE = 0.35      # ... and under this share of the segment's characters is not a real change of speaker.
TINY_SPEAKER_SECONDS = 2.0  # a "speaker" who speaks less than this in total and under TINY_SPEAKER_SHARE of all
TINY_SPEAKER_SHARE = 0.02   # speech is a diarization artefact; its units go to the speaker before them.


def unit_chars_of(unit):
    return max(1, len(unit["text"].replace(" ", "").replace("　", "")))


def unit_seconds(unit):
    """Speech length of a unit. Whisper stretches the last word of a phrase over the pause after it, so the length is
    capped by what its characters take to say."""
    return max(0.0, min(unit["end"] - unit["start"], 0.2 + 0.15 * unit_chars_of(unit)))


def raw_speakers(units, turns):
    """Each unit gets the speaker whose turns overlap it longest (overlaps of one speaker add up); a unit outside every
    turn gets the nearest turn's speaker. turns: [(start, end, speaker)]."""
    turns = sorted(turns)
    starts = [t[0] for t in turns]
    longest = max((t[1] - t[0] for t in turns), default=0.0)
    out = []
    for u in units:
        s, e = u["start"], max(u["end"], u["start"])
        overlap = {}
        for i in range(bisect.bisect_left(starts, s - longest), len(turns)):
            ts, te, sp = turns[i]
            if ts >= e and ts > s:
                break
            o = min(e, te) - max(s, ts)
            if o > 0:
                overlap[sp] = overlap.get(sp, 0.0) + o
        if overlap:
            out.append(max(overlap, key=overlap.get))
            continue
        mid = (s + e) / 2
        out.append(min(turns, key=lambda t: 0.0 if t[0] <= mid <= t[1] else min(abs(mid - t[0]), abs(mid - t[1])))[2])
    return out


def smooth_speakers(units, speakers):
    """Moves speaker changes to where they are real.

    Turn boundaries from the audio fall in the middle of Kotoba's word tokens, so one to three characters at the edge
    of a phrase land in the neighbouring speaker. Kotoba's own segments (one phrase each) are the guide: inside one
    segment a run of one speaker is dropped into its neighbour when it is minor (shorter than MINOR_RUN_SECONDS or at
    most MINOR_RUN_CHARS characters, and under MINOR_RUN_SHARE of the segment's characters). A substantial minority
    stays, and a segment that is only a short reply of the other speaker is untouched (it has a single run).
    Finally a speaker who hardly speaks at all is merged into the speaker before. Returns a new list.
    """
    raw = list(speakers)
    speakers = list(speakers)
    weight = lambda run: sum(unit_chars_of(units[k]) for k in run[1])  # noqa: E731
    i = 0
    while i < len(units):
        j = i
        while j < len(units) and units[j]["seg"] == units[i]["seg"]:
            j += 1
        runs = []  # [speaker, [unit indexes]]
        for k in range(i, j):
            if runs and runs[-1][0] == speakers[k]:
                runs[-1][1].append(k)
            else:
                runs.append([speakers[k], [k]])
        total_chars = sum(unit_chars_of(units[k]) for k in range(i, j))
        while len(runs) > 1:
            minor = None  # (run index, characters): the smallest minor run goes first
            for r, run in enumerate(runs):
                # A run at the edge of the segment that goes on in the neighbouring segment is a phrase that
                # straddles Kotoba's segment boundary, not a stray piece.
                if (r == 0 and i > 0 and raw[i - 1] == run[0]) or (r == len(runs) - 1 and j < len(units) and raw[j] == run[0]):
                    continue
                chars = weight(run)
                seconds = sum(unit_seconds(units[k]) for k in run[1])
                if (seconds < MINOR_RUN_SECONDS or chars <= MINOR_RUN_CHARS) and chars / total_chars < MINOR_RUN_SHARE:
                    if minor is None or chars < minor[1]:
                        minor = (r, chars)
            if minor is None:
                break
            r = minor[0]
            left = runs[r - 1] if r > 0 else None
            right = runs[r + 1] if r + 1 < len(runs) else None
            if left and right and left[0] != right[0]:
                target = left if weight(left) >= weight(right) else right
            else:
                target = left or right
            runs[r][0] = target[0]
            merged = []
            for run in runs:
                if merged and merged[-1][0] == run[0]:
                    merged[-1][1].extend(run[1])
                else:
                    merged.append(run)
            runs = merged
        for sp, members in runs:
            for k in members:
                speakers[k] = sp
        i = j
    talk = {}
    for u, sp in zip(units, speakers):
        talk[sp] = talk.get(sp, 0.0) + unit_seconds(u)
    grand = sum(talk.values()) or 1.0
    tiny = {sp for sp, t in talk.items() if t < TINY_SPEAKER_SECONDS and t / grand < TINY_SPEAKER_SHARE}
    if tiny and len(tiny) < len(talk):
        for k, sp in enumerate(speakers):
            if sp in tiny:
                before = next((speakers[b] for b in range(k - 1, -1, -1) if speakers[b] not in tiny), None)
                after = next((speakers[a] for a in range(k + 1, len(units)) if speakers[a] not in tiny), None)
                speakers[k] = before if before is not None else after
    return speakers


def assign_speakers(units, turns):
    """Speaker number (0, 1, 2 ... in order of first appearance) for every unit, or None without usable turns."""
    if not units or not turns:
        return None
    number = {}
    return [number.setdefault(sp, len(number)) for sp in smooth_speakers(units, raw_speakers(units, turns))]


# ---------------------------------------------------------------- json3 building (pure, no GPU needed)

def build_json3(segments, unit_chars=6, turns=None):
    """Kotoba segments (with word timings, seconds) -> YouTube json3 document.

    One event per unit: tStartMs is the unit's start, dDurationMs its real length, so the extension's parseJson3 gives
    every unit a start and an end. With diarization turns [(start, end, speaker)] every event also carries lkSpk
    (0, 1, 2 ... by first appearance) and the document has lkDiar true.
    """
    segments = clean_segments(segments)
    units = group_words([s["words"] for s in segments], unit_chars)
    speakers = assign_speakers(units, turns) if turns else None
    events = []
    previous = 0
    for i, u in enumerate(units):
        start = max(previous, int(round(u["start"] * 1000)))
        end = max(start, int(round(u["end"] * 1000)))
        previous = start
        event = {"tStartMs": start, "dDurationMs": end - start, "segs": [{"utf8": u["text"]}]}
        if speakers is not None:
            event["lkSpk"] = speakers[i]
        events.append(event)
    doc = {"wireMagic": "pb3", "events": events}
    if speakers is not None:
        doc["lkDiar"] = True
    return doc


# ---------------------------------------------------------------- jobs, model, worker

class Job:
    def __init__(self, video_id):
        self.video_id = video_id
        self.state = "queued"  # queued | downloading | transcribing | diarizing | done | error
        self.progress = 0.0
        self.error = None

    def public(self):
        out = {"state": self.state, "progress": round(self.progress, 3)}
        if self.error:
            out["error"] = self.error
        return out


class Engine:
    def __init__(self, args):
        self.root = Path(args.root)
        self.model_dir = Path(args.model_dir) if args.model_dir else self.root / "models" / "kotoba-whisper-v2.0-faster-aligned"
        self.cache_dir = Path(args.cache_dir) if args.cache_dir else self.root / "cache"
        self.tmp_dir = self.root / "tmp"
        self.unit_chars = args.unit_chars
        self.diarize_python = Path(args.diarize_python) if args.diarize_python else self.root / "venv-diar" / "Scripts" / "python.exe"
        self.diarize_script = Path(__file__).with_name("diarize.py")
        self.diarize_enabled = not args.no_diarization
        self.idle_seconds = args.idle_minutes * 60
        self.max_hours = args.max_hours
        self.jobs = {}
        self.lock = threading.Lock()
        self.queue = queue.Queue()
        self.model = None
        self.model_lock = threading.Lock()
        self.last_used = time.time()
        self.running = None  # video id of the job on the GPU
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        shutil.rmtree(self.tmp_dir, ignore_errors=True)  # leftovers of an earlier run of this server
        threading.Thread(target=self.worker, daemon=True).start()
        threading.Thread(target=self.janitor, daemon=True).start()

    # -- cache
    def cache_json3(self, vid):
        return self.cache_dir / f"{vid}.{CACHE_FORMAT}.json3"

    def cache_segments(self, vid):
        return self.cache_dir / f"{vid}.segments.json"

    def cache_turns(self, vid):
        return self.cache_dir / f"{vid}.turns.json"

    def cached(self, vid):
        return self.cache_json3(vid).is_file()

    # -- API surface
    def start(self, vid):
        with self.lock:
            job = self.jobs.get(vid)
            if job and job.state != "error":
                return job
            if self.cached(vid):
                job = Job(vid)
                job.state, job.progress = "done", 1.0
                self.jobs[vid] = job
                return job
            job = Job(vid)
            self.jobs[vid] = job
            self.queue.put(vid)
            log("queued", vid)
            return job

    def get(self, vid):
        with self.lock:
            job = self.jobs.get(vid)
            if job:
                return job
            if self.cached(vid):
                job = Job(vid)
                job.state, job.progress = "done", 1.0
                self.jobs[vid] = job
                return job
        return None

    def health(self):
        with self.lock:
            busy = self.running is not None or not self.queue.empty()
        return {"ok": True, "model": MODEL_NAME, "busy": busy}

    # -- model
    def load_model(self):
        with self.model_lock:
            if self.model is None:
                from faster_whisper import WhisperModel
                started = time.time()
                self.model = WhisperModel(str(self.model_dir), device="cuda", compute_type="float16")
                log(f"model loaded in {time.time() - started:.1f}s")
            self.last_used = time.time()
            return self.model

    def janitor(self):
        while True:
            time.sleep(30)
            with self.lock:
                idle = self.running is None and self.queue.empty()
            if not idle:
                continue
            with self.model_lock:
                if self.model is not None and time.time() - self.last_used > self.idle_seconds:
                    self.model = None
                    gc.collect()
                    log("model unloaded after idle time")

    # -- worker
    def worker(self):
        while True:
            vid = self.queue.get()
            job = self.jobs[vid]
            with self.lock:
                self.running = vid
            started = time.time()
            try:
                self.run(job)
                log(f"done {vid} in {time.time() - started:.1f}s")
            except Exception as err:  # noqa: BLE001 - reported to the caller as a short message
                job.state = "error"
                job.error = (str(err).splitlines() or [type(err).__name__])[0].removeprefix("ERROR: ")[:200]
                log(f"error {vid}: {job.error}")
            finally:
                with self.lock:
                    self.running = None
                self.last_used = time.time()

    def run(self, job):
        vid = job.video_id
        work = self.tmp_dir / vid
        try:
            work.mkdir(parents=True, exist_ok=True)
            job.state, job.progress = "downloading", 0.0
            log("downloading", vid)
            try:
                wav = self.download(vid, work)
            except RuntimeError:
                raise
            except Exception as err:  # noqa: BLE001 - YouTube answers 403 now and then; one more try usually works
                log(f"download failed ({str(err).splitlines()[0][:80]}), retrying once")
                time.sleep(2)
                shutil.rmtree(work, ignore_errors=True)
                work.mkdir(parents=True, exist_ok=True)
                wav = self.download(vid, work)
            import numpy as np
            with wave.open(str(wav), "rb") as wf:
                if not (wf.getframerate() == 16000 and wf.getnchannels() == 1 and wf.getsampwidth() == 2):
                    raise RuntimeError("unexpected audio format")
                audio = np.frombuffer(wf.readframes(wf.getnframes()), dtype=np.int16).astype(np.float32) / 32768.0
            duration = len(audio) / 16000
            job.state, job.progress = "transcribing", 0.0
            diarizing = self.can_diarize()
            share = 0.9 if diarizing else 0.99  # the rest of the progress bar belongs to the speaker step
            log(f"transcribing {vid} ({duration:.0f}s)")
            model = self.load_model()
            with self.model_lock:
                self.last_used = time.time()
            segments, _info = model.transcribe(
                audio, language="ja", task="transcribe", beam_size=5,
                chunk_length=15, condition_on_previous_text=False,
                vad_filter=True, word_timestamps=True,
            )
            result = []
            for seg in segments:
                result.append({
                    "start": round(seg.start, 3), "end": round(seg.end, 3), "text": seg.text.strip(),
                    "words": [{"start": round(w.start, 3), "end": round(w.end, 3), "word": w.word} for w in (seg.words or [])],
                })
                job.progress = min(share, share * seg.end / duration) if duration > 0 else 0.0
            del audio
            result = clean_segments(result)
            if not result:
                raise RuntimeError("no speech found")
            turns = self.diarize(job, wav, duration, work) if diarizing else None
            doc = build_json3(result, self.unit_chars, turns)
            if not doc["events"]:
                raise RuntimeError("no speech found")
            if turns:
                speakers = {e["lkSpk"] for e in doc["events"]}
                changes = sum(1 for a, b in zip(doc["events"], doc["events"][1:]) if a["lkSpk"] != b["lkSpk"])
                log(f"speakers {vid}: {len(speakers)} speakers, {changes} changes in {len(doc['events'])} units")
                self.cache_turns(vid).write_text(json.dumps(turns), encoding="utf-8")
            # json3 last: its presence marks a finished cache entry.
            self.cache_segments(vid).write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
            tmp = self.cache_json3(vid).with_suffix(".json3.part")
            tmp.write_text(json.dumps(doc, ensure_ascii=False), encoding="utf-8")
            tmp.replace(self.cache_json3(vid))
            job.state, job.progress = "done", 1.0
        finally:
            shutil.rmtree(work, ignore_errors=True)  # the downloaded audio never stays

    def can_diarize(self):
        if not self.diarize_enabled:
            return False
        if not (self.diarize_python.is_file() and self.diarize_script.is_file()):
            log(f"no speakers: {self.diarize_python} is missing (see README)")
            return False
        return True

    def diarize(self, job, wav, duration, work):
        """Who speaks when: diarize.py in its own venv, on the GPU. Returns [(start, end, speaker)] or None when it fails;
        a failure is logged and the result simply comes without speakers."""
        job.state, job.progress = "diarizing", 0.9
        started = time.time()
        log(f"diarizing {wav.stem}")
        out, err = work / "turns.json", work / "diarize.err"
        timeout = 600 + duration * 0.2
        proc = None
        try:
            with open(err, "wb") as errfile:
                proc = subprocess.Popen(
                    [str(self.diarize_python), "-I", str(self.diarize_script), str(wav), str(out)],
                    stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=errfile,
                    creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
                expected = max(15.0, duration / 40)  # seconds the step takes, roughly: only paces the progress bar
                while proc.poll() is None:
                    elapsed = time.time() - started
                    if elapsed > timeout:
                        proc.kill()
                        proc.wait()
                        raise RuntimeError("timed out")
                    job.progress = 0.9 + 0.09 * (1 - 2.718281828 ** (-elapsed / expected))
                    time.sleep(0.5)
            if proc.returncode != 0:
                lines = [ln for ln in err.read_text(encoding="utf-8", errors="replace").splitlines() if ln.strip()]
                raise RuntimeError(lines[-1][:200] if lines else f"exit code {proc.returncode}")
            data = json.loads(out.read_text(encoding="utf-8"))
            turns = [(float(t["start"]), float(t["end"]), str(t["speaker"])) for t in data["turns"]]
            log(f"diarized in {time.time() - started:.1f}s: {len(turns)} turns")
            return turns or None
        except Exception as e:  # noqa: BLE001 - speakers are optional; the transcript is the job
            log(f"diarization failed, continuing without speakers: {(str(e).splitlines() or [type(e).__name__])[0][:200]}")
            if proc is not None and proc.poll() is None:
                proc.kill()
            return None

    def download(self, vid, work):
        import imageio_ffmpeg
        import yt_dlp
        opts = {
            "format": "bestaudio/best",
            "outtmpl": str(work / "%(id)s.%(ext)s"),
            "ffmpeg_location": imageio_ffmpeg.get_ffmpeg_exe(),
            "noplaylist": True, "quiet": True, "no_warnings": True, "noprogress": True,
            "postprocessors": [{"key": "FFmpegExtractAudio", "preferredcodec": "wav"}],
            "postprocessor_args": {"extractaudio": ["-ar", "16000", "-ac", "1"]},
        }
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(f"https://www.youtube.com/watch?v={vid}", download=False)
            if info.get("is_live") or info.get("live_status") in ("is_upcoming", "is_live"):
                raise RuntimeError("live streams cannot be transcribed")
            if (info.get("duration") or 0) > self.max_hours * 3600:
                raise RuntimeError("video is too long")
            ydl.process_ie_result(info, download=True)
        wav = work / f"{info['id']}.wav"
        if not wav.is_file():
            raise RuntimeError("audio download failed")
        return wav


# ---------------------------------------------------------------- HTTP

def make_handler(engine, port, allowed_ids):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        server_version = "LakomicsAsr"

        def log_message(self, fmt, *args):  # quiet: the server logs job events itself
            pass

        # -- helpers
        def reply(self, status, body=None, raw=None):
            data = raw if raw is not None else json.dumps(body if body is not None else {}, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            origin = self.headers.get("Origin")
            if origin and EXTENSION_ORIGIN.match(origin):
                self.send_header("Access-Control-Allow-Origin", origin)
                self.send_header("Vary", "Origin")
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(data)

        def authorized(self):
            """Only the extension (chrome-extension origin) or a local tool sending X-Lakomics-Asr: 1 may call."""
            if self.headers.get("Host", "") not in (f"127.0.0.1:{port}", f"localhost:{port}"):
                return False  # blocks DNS-rebinding pages
            origin = self.headers.get("Origin")
            if origin is None:
                return self.headers.get("X-Lakomics-Asr") == "1"
            m = EXTENSION_ORIGIN.match(origin)
            return bool(m) and (not allowed_ids or m.group(1) in allowed_ids)

        def guard(self):
            if self.authorized():
                return True
            self.reply(403, {"error": "forbidden"})
            return False

        # -- verbs
        def do_OPTIONS(self):
            if not self.authorized():
                return self.reply(403, {"error": "forbidden"})
            self.send_response(204)
            origin = self.headers.get("Origin")
            if origin:
                self.send_header("Access-Control-Allow-Origin", origin)
                self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Lakomics-Asr")
            self.send_header("Access-Control-Max-Age", "600")
            self.send_header("Content-Length", "0")
            self.end_headers()

        def do_GET(self):
            if not self.guard():
                return
            path = self.path.split("?", 1)[0].rstrip("/")
            if path == "/health":
                return self.reply(200, engine.health())
            m = re.fullmatch(r"/jobs/([^/]+)(/json3)?", path)
            if not m or not VIDEO_ID.match(m.group(1)):
                return self.reply(404 if not m else 400, {"error": "not found" if not m else "bad video id"})
            vid, want_json3 = m.group(1), bool(m.group(2))
            job = engine.get(vid)
            if job is None:
                return self.reply(404, {"error": "unknown job"})
            if not want_json3:
                return self.reply(200, job.public())
            if job.state != "done":
                return self.reply(409, {"error": "not ready", **job.public()})
            try:
                raw = engine.cache_json3(vid).read_bytes()
            except OSError:
                return self.reply(404, {"error": "result missing"})
            return self.reply(200, raw=raw)

        def do_POST(self):
            if not self.guard():
                return
            if self.path.split("?", 1)[0].rstrip("/") != "/jobs":
                return self.reply(404, {"error": "not found"})
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= MAX_BODY:
                    raise ValueError
                body = json.loads(self.rfile.read(length).decode("utf-8"))
                vid = body["videoId"]
                if not isinstance(vid, str) or not VIDEO_ID.match(vid):
                    raise ValueError
            except (ValueError, KeyError, TypeError):
                return self.reply(400, {"error": "bad request"})
            return self.reply(200, engine.start(vid).public())

    return Handler


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    env = os.environ.get
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--port", type=int, default=int(env("LAKOMICS_ASR_PORT", "39125")))
    ap.add_argument("--root", default=env("LAKOMICS_ASR_ROOT", DEFAULT_ROOT), help="folder holding models/, cache/ and tmp/")
    ap.add_argument("--model-dir", default=env("LAKOMICS_ASR_MODEL"), help="CTranslate2 model folder (default: <root>/models/kotoba-whisper-v2.0-faster-aligned)")
    ap.add_argument("--cache-dir", default=env("LAKOMICS_ASR_CACHE"), help="result cache (default: <root>/cache)")
    ap.add_argument("--allow-extension-id", action="append", default=[], help="accept only this extension id (repeatable; default: any extension)")
    ap.add_argument("--idle-minutes", type=float, default=10, help="unload the model after this idle time")
    ap.add_argument("--unit-chars", type=int, default=6, help="characters per caption unit (1 = every Kotoba token on its own)")
    ap.add_argument("--diarize-python", default=env("LAKOMICS_ASR_DIAR_PYTHON"), help="python of the speaker venv (default: <root>/venv-diar/Scripts/python.exe)")
    ap.add_argument("--no-diarization", action="store_true", help="no speaker labels")
    ap.add_argument("--max-hours", type=float, default=6, help="refuse longer videos")
    args = ap.parse_args()
    allowed = set(args.allow_extension_id) | {x for x in env("LAKOMICS_ASR_EXTENSION_IDS", "").split(",") if x}

    add_cuda_dlls()
    engine = Engine(args)
    server = ThreadingHTTPServer(("127.0.0.1", args.port), make_handler(engine, args.port, allowed))
    server.daemon_threads = True
    log(f"Lakomics ASR listening on http://127.0.0.1:{args.port} (model {engine.model_dir}, cache {engine.cache_dir})")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log("stopping")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
