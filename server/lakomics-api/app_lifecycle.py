"""Ordered lifecycle hooks shared by the application and standalone route modules."""
from contextlib import asynccontextmanager
from inspect import isawaitable

from fastapi import FastAPI


class AppLifecycle:
    def __init__(self, previous_lifespan):
        self.startup_handlers = []
        self.shutdown_handlers = []
        self._previous_lifespan = previous_lifespan

    def on_startup(self, handler):
        self.startup_handlers.append(handler)
        return handler

    def on_shutdown(self, handler):
        self.shutdown_handlers.append(handler)
        return handler

    @asynccontextmanager
    async def lifespan(self, app):
        async with self._previous_lifespan(app) as state:
            for handler in self.startup_handlers:
                result = handler()
                if isawaitable(result):
                    await result
            # Match event handlers: a startup failure skips shutdown; otherwise
            # shutdown runs in registration order, including on lifespan errors.
            try:
                yield state
            finally:
                for handler in self.shutdown_handlers:
                    result = handler()
                    if isawaitable(result):
                        await result


def lifecycle(app: FastAPI) -> AppLifecycle:
    """Install once per app, including apps built directly by module tests."""
    hooks = getattr(app.state, "_lakomics_lifecycle", None)
    if hooks is None:
        hooks = AppLifecycle(app.router.lifespan_context)
        app.state._lakomics_lifecycle = hooks
        app.router.lifespan_context = hooks.lifespan
    return hooks
