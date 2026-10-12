#!/usr/bin/env python
"""Speaker diarization for the Lakomics local ASR server (pyannote.audio, GPU).

Runs by itself in its own venv (default C:\\laku\\asr\\venv-diar) because pyannote and torch do not belong in the
server's venv. server.py starts it as a subprocess:

  C:\\laku\\asr\\venv-diar\\Scripts\\python.exe V:\\chatgpt\\_tools\\asr\\diarize.py <audio.wav> <turns.json>

Input: a 16 kHz mono 16-bit wav (read with the wave module; no torchaudio or av decoder is involved).
Output: JSON {"speakers": n, "turns": [{"start": s, "end": s, "speaker": "SPEAKER_00"}, ...]}, seconds, sorted by start.
Turns of different speakers may overlap (overlapped speech). Any failure exits non-zero with a short message on stderr.

The pipeline is pyannote/speaker-diarization-community-1. Its terms must be accepted once on Hugging Face with the
account whose token `hf auth login` stored; the token is read from there and never printed.
"""
import json
import sys
import wave

PIPELINE = "pyannote/speaker-diarization-community-1"


def load_wav(path):
    import numpy as np
    import torch
    with wave.open(path, "rb") as wf:
        if not (wf.getframerate() == 16000 and wf.getnchannels() == 1 and wf.getsampwidth() == 2):
            raise RuntimeError("unexpected audio format")
        audio = np.frombuffer(wf.readframes(wf.getnframes()), dtype=np.int16).astype(np.float32) / 32768.0
    return torch.from_numpy(audio).unsqueeze(0)


def diarize(wav_path):
    import huggingface_hub
    import torch
    from pyannote.audio import Pipeline
    token = huggingface_hub.get_token()
    pipeline = Pipeline.from_pretrained(PIPELINE, token=token)
    if pipeline is None:
        raise RuntimeError("diarization model unavailable (accept its terms on Hugging Face and log in)")
    pipeline.to(torch.device("cuda"))
    result = pipeline({"waveform": load_wav(wav_path), "sample_rate": 16000})
    annotation = getattr(result, "speaker_diarization", result)
    turns = [{"start": round(seg.start, 3), "end": round(seg.end, 3), "speaker": str(label)}
             for seg, _track, label in annotation.itertracks(yield_label=True)]
    turns.sort(key=lambda t: (t["start"], t["end"]))
    return {"speakers": len({t["speaker"] for t in turns}), "turns": turns}


def main():
    if len(sys.argv) != 3:
        print("usage: diarize.py <audio.wav> <turns.json>", file=sys.stderr)
        return 2
    try:
        out = diarize(sys.argv[1])
        with open(sys.argv[2], "w", encoding="utf-8") as f:
            json.dump(out, f, ensure_ascii=False)
    except Exception as err:  # noqa: BLE001 - the server logs this one line and goes on without speakers
        print(f"{type(err).__name__}: {(str(err).splitlines() or [''])[0][:200]}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
