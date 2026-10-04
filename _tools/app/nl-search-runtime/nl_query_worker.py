"""Persistent CPU opus/SigLIP2 text worker; stdout is bounded JSON lines only."""
import argparse
from contextlib import redirect_stdout
import ctypes
import io
import json
import os
import sys
import time

from runtime_support import (MODELS, OPUS, QUERY_INSTRUCTION, QwenEncoder,
                             normalize, require_snapshot, torch_setup)

MAX_MESSAGE_BYTES = 256 * 1024


def rss_bytes():
    if os.name == 'nt':
        from ctypes import wintypes
        class Counters(ctypes.Structure):
            _fields_ = [('cb', wintypes.DWORD), ('PageFaultCount', wintypes.DWORD)] + [
                (name, ctypes.c_size_t) for name in ('PeakWorkingSetSize', 'WorkingSetSize',
                'QuotaPeakPagedPoolUsage', 'QuotaPagedPoolUsage', 'QuotaPeakNonPagedPoolUsage',
                'QuotaNonPagedPoolUsage', 'PagefileUsage', 'PeakPagefileUsage')]
        data = Counters()
        data.cb = ctypes.sizeof(data)
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        kernel.GetCurrentProcess.restype = wintypes.HANDLE
        psapi = ctypes.WinDLL('psapi', use_last_error=True)
        psapi.GetProcessMemoryInfo.argtypes = [wintypes.HANDLE, ctypes.c_void_p, wintypes.DWORD]
        if not psapi.GetProcessMemoryInfo(kernel.GetCurrentProcess(), ctypes.byref(data), data.cb):
            raise ctypes.WinError(ctypes.get_last_error())
        return int(data.WorkingSetSize)
    # Current RSS on Linux, not resource.ru_maxrss (which measures peak).
    with open('/proc/self/statm', encoding='ascii') as stream:
        return int(stream.read().split()[1]) * os.sysconf('SC_PAGE_SIZE')


class QueryEncoder:
    def __init__(self, with_qwen8b=False, threads=4):
        tick = time.perf_counter()
        self.torch = torch_setup(threads=threads)
        from transformers import AutoConfig, AutoModelForSeq2SeqLM, AutoTokenizer, SiglipTextModel
        snapshot = require_snapshot(OPUS)
        self.translator = AutoModelForSeq2SeqLM.from_pretrained(snapshot,
                    local_files_only=True, dtype=self.torch.float32).eval()
        self.opus_tokenizer = AutoTokenizer.from_pretrained(snapshot, local_files_only=True)
        snapshot = require_snapshot(MODELS['siglip'])
        # This SigLIP2 checkpoint declares the original SiglipTextConfig. Use its
        # dedicated text class: AutoModel does not register SiglipTextConfig.
        text_config = AutoConfig.from_pretrained(snapshot, local_files_only=True).text_config
        self.text_model = SiglipTextModel.from_pretrained(snapshot, config=text_config, local_files_only=True,
                    dtype=self.torch.float32, attn_implementation='sdpa').eval()
        self.tokenizer = AutoTokenizer.from_pretrained(snapshot, local_files_only=True)
        if any('vision' in name for name, _ in self.text_model.named_parameters()):
            raise RuntimeError('Unexpected vision parameters in text-only query model')
        self.qwen = QwenEncoder() if with_qwen8b else None
        self.telemetry = {'load_seconds':time.perf_counter()-tick, 'rss_bytes':rss_bytes(),
            'threads':threads, 'qwen8b':with_qwen8b,
            'text_model_class':type(self.text_model).__name__,
            'text_parameters':sum(p.numel() for p in self.text_model.parameters()),
            'text_parameter_bytes':sum(p.numel()*p.element_size() for p in self.text_model.parameters())}

    def embed(self, text):
        inputs = self.opus_tokenizer([text], return_tensors='pt', truncation=True, max_length=512)
        with self.torch.inference_mode():
            generated = self.translator.generate(**inputs, num_beams=4, max_new_tokens=40)
        en = self.opus_tokenizer.batch_decode(generated, skip_special_tokens=True)[0]
        inputs = self.tokenizer([en.lower()], padding='max_length', max_length=64,
                                truncation=True, return_tensors='pt')
        with self.torch.inference_mode():
            output = self.text_model(**inputs).pooler_output
        vector = normalize(output.float().cpu().numpy())[0]
        if len(vector) != 1152:
            raise RuntimeError(f'Unexpected SigLIP dimension: {len(vector)}')
        result = {'en':en, 'siglip':vector.tolist()}
        if self.qwen:
            result['qwen8b'] = self.qwen.encode([{'text':text, 'instruction':QUERY_INSTRUCTION}])[0].tolist()
        return result


def emit(output, value):
    line = json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(',', ':')) + '\n'
    if len(line.encode('utf-8')) >= MAX_MESSAGE_BYTES:
        raise ValueError('Response exceeds 256 KiB')
    output.write(line)
    output.flush()


def serve(encoder, source, output, telemetry):
    emit(output, {'type':'ready', **telemetry})
    count = 0
    while True:
        line = source.readline(MAX_MESSAGE_BYTES + 1)
        if not line:
            return
        request = {}
        try:
            if len(line.encode('utf-8')) >= MAX_MESSAGE_BYTES:
                # Drain the offending line so its tail cannot become a second request.
                while not line.endswith('\n'):
                    line = source.readline(MAX_MESSAGE_BYTES + 1)
                    if not line:
                        break
                raise ValueError('Request exceeds 256 KiB')
            request = json.loads(line)
            if not isinstance(request, dict):
                request = {}
                raise ValueError('Request must be a JSON object')
            if request.get('op') == 'shutdown':
                return  # Explicit shutdown, as specified; no pong.
            if request.get('op') != 'embed':
                raise ValueError('Unknown op; expected embed or shutdown')
            if not isinstance(request.get('id'), str):
                raise ValueError('embed requires a string id')
            text = request.get('text')
            if not isinstance(text, str) or not text.strip():
                raise ValueError('text must be a nonempty string')
            tick = time.perf_counter()
            # Helpers occasionally print diagnostics. Keep protocol stdout clean.
            with redirect_stdout(sys.stderr):
                result = encoder.embed(text)
            for key in ('siglip', 'qwen8b'):
                if key in result:
                    result[key] = [float(format(x, '.6g')) for x in result[key]]
            count += 1
            elapsed = time.perf_counter()-tick
            emit(output, {'id':request['id'], 'ok':True, **result,
                          'latency_seconds':elapsed, 'rss_bytes':rss_bytes(), 'warm':count > 1})
        except Exception as exc:
            # Bounded errors must remain writable even for a hostile id/error string.
            ident = request.get('id')
            if not isinstance(ident, str) or len(ident.encode('utf-8')) > 4096:
                ident = None
            emit(output, {'id':ident, 'ok':False, 'error':str(exc)[:4096]})


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--with-qwen8b', action='store_true')
    p.add_argument('--threads', type=int, choices=(2, 3, 4), default=4)
    args = p.parse_args()
    sys.stdin.reconfigure(encoding='utf-8')
    sys.stdout.reconfigure(encoding='utf-8')
    try:
        with redirect_stdout(sys.stderr):
            encoder = QueryEncoder(args.with_qwen8b, args.threads)
    except Exception as exc:
        emit(sys.stdout, {'type':'startup_error', 'error':str(exc)[:4096]})
        return 1
    serve(encoder, sys.stdin, sys.stdout, encoder.telemetry)
    return 0


if __name__ == '__main__':
    sys.exit(main())
