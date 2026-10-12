# Lakomics local ASR (PC only)

Japanese speech recognition with Kotoba-whisper (faster-whisper, CUDA) for the YouTube subtitle translation in the
Lakomics extension, plus audio-based speaker diarization (who speaks when) so the extension can colour subtitles by
speaker. It runs on the PC's GPU and listens on `127.0.0.1` only. When it is not running, the extension quietly uses
YouTube's own captions as before.

## Start

```powershell
C:\laku\asr\venv\Scripts\python.exe V:\chatgpt\_tools\asr\server.py
```

Stop it with Ctrl+C in that window. Options: `--port` (39125), `--root` (`C:\laku\asr`), `--model-dir`, `--cache-dir`,
`--allow-extension-id <id>` (default: any extension), `--idle-minutes` (10), `--unit-chars` (6), `--max-hours` (6),
`--diarize-python` (default `<root>\venv-diar\Scripts\python.exe`), `--no-diarization`.
The same values can come from `LAKOMICS_ASR_PORT`, `LAKOMICS_ASR_ROOT`, `LAKOMICS_ASR_MODEL`, `LAKOMICS_ASR_CACHE`,
`LAKOMICS_ASR_EXTENSION_IDS` (comma separated), `LAKOMICS_ASR_DIAR_PYTHON`.

The venv, the model (`<root>\models\kotoba-whisper-v2.0-faster-aligned`, alignment heads fixed for word timestamps) and
the result cache (`<root>\cache\<videoId>.v2.json3`, `<videoId>.segments.json` and `<videoId>.turns.json`) stay outside
the repository. Cache format `v2` carries speakers; older `<videoId>.json3` files are ignored, so a video transcribed
before is transcribed (and diarized) again when requested. To redo one video by hand, delete its `<videoId>.v2.json3`.

## Speakers (diarization)

After the transcription (and before the downloaded audio is deleted) the job runs `diarize.py` as a subprocess of a
second Python, because pyannote and torch live in their own venv, `<root>\venv-diar` (Python 3.14, torch cu128,
`pyannote.audio` 4.x). The job state is `diarizing` for that step (about 15 s for 5 minutes of audio, ~3 GB of VRAM next
to the Kotoba model). The model is `pyannote/speaker-diarization-community-1`: its terms must be accepted on Hugging
Face once, with the account whose token `hf auth login` stored in that venv's user (default Hugging Face home); the
token is read from there and never printed. The model files stay in the default Hugging Face cache.

Each unit gets the speaker with the longest overlap (nearest turn when none), then speaker changes are smoothed: inside
one Kotoba segment a run of one speaker shorter than 1.2 s or of at most 3 characters, and under 35 % of the segment, is
given to its neighbour (not when that phrase continues across the segment boundary); a speaker with under 2 s in total
is merged into the speaker before. A segment that is a short reply of its own keeps its speaker. Speakers are numbered
0, 1, 2 ... by first appearance. If the venv or the model is missing, or diarization fails or times out, the job still
finishes, logs the reason and answers without speakers. `--no-diarization` switches the step off.

## API

Every request needs `Origin: chrome-extension://<id>` or, without an Origin, the header `X-Lakomics-Asr: 1`; the Host
must be `127.0.0.1:<port>` or `localhost:<port>`. Anything else gets 403.

| Request | Answer |
| --- | --- |
| `GET /health` | `{ok, model, busy}` |
| `POST /jobs` `{"videoId": "..."}` | starts (or returns) the job; `{state, progress}` |
| `GET /jobs/<videoId>` | `{state: queued\|downloading\|transcribing\|diarizing\|done\|error, progress: 0..1, error?}` |
| `GET /jobs/<videoId>/json3` | the finished caption document (YouTube json3 shape), 409 until done |

`videoId` must match `^[A-Za-z0-9_-]{6,20}$`; the server builds the YouTube URL itself. One GPU job runs at a time; the
model loads on the first job and unloads after 10 idle minutes. The downloaded audio is deleted after transcription.

## json3 shape

One event per caption unit (`tStartMs`, `dDurationMs`, one `segs` entry with `utf8`). A unit joins up to `--unit-chars`
Kotoba word tokens (they are one or two characters each) and breaks at punctuation, at pauses of 300 ms or more and at
segment ends; it keeps the real start of its first token and the real end of its last token. With diarization every
event also has `"lkSpk": <0, 1, 2 ...>` (speaker by first appearance) and the document has `"lkDiar": true`.
