# Active extension development

Root `AGENTS.md` applies. `extension-list/` is the user's current and active Lakomics browser extension.

## Scope boundary

- For ordinary requests about “the extension”, “the list extension”, collection UI, classification picker, X/forum capture, pairing, or extension UX, modify `extension-list/` only.
- Do not mirror changes into the legacy `extension/` tree unless the user explicitly asks for legacy-extension work.
- The active extension consumes the live classification tree supplied by Lakomics/server; do not hardcode app classifications unless an offline contract specifically requires it.
- Keep `icons/` self-contained inside this directory and keep manifest icon paths relative to `extension-list/`.

## Verification

- Use the existing `node --test tests/*.test.mjs` suite for relevant behavior.
- `manifest.json` is the active extension version and entrypoint source of truth.
- Do not commit connection secrets, tokens, or machine-specific credentials.
