"""Opt-in timings without changing inference inputs, model policy or cache keys."""
from collections import defaultdict
from contextlib import contextmanager
from time import perf_counter


class Timings:
    def __init__(self):
        self.seconds = defaultdict(float)
        self.calls = defaultdict(int)

    @contextmanager
    def measure(self, name):
        start = perf_counter()
        try:
            yield
        finally:
            self.seconds[name] += perf_counter() - start
            self.calls[name] += 1

    def wrap(self, name, fn):
        def measured(*args, **kwargs):
            with self.measure(name):
                return fn(*args, **kwargs)
        return measured

    def snapshot(self):
        return {name: {"ms": round(seconds * 1000, 3), "calls": self.calls[name]}
                for name, seconds in sorted(self.seconds.items())}


class TimedSession:
    def __init__(self, session, timings, stage):
        self.session, self.timings, self.stage = session, timings, stage

    def __getattr__(self, name):
        return getattr(self.session, name)

    def run(self, *args, **kwargs):
        with self.timings.measure(self.stage):
            return self.session.run(*args, **kwargs)


def instrument(engine, cache_module, runtime_module, timings):
    engine.detector = TimedSession(engine.detector, timings, "detector")
    engine.feature = TimedSession(engine.feature, timings, "feature")
    engine.metric = TimedSession(engine.metric, timings, "metric")
    cache_module.input_digest = timings.wrap("file_verification", cache_module.input_digest)
    runtime_module.sha256 = timings.wrap("file_verification", runtime_module.sha256)
    runtime_module.rgb = timings.wrap("image_decode", runtime_module.rgb)
