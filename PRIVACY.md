# Lakomics Companion Privacy Policy

Implementation/data-flow reconciliation: 2026-10-22, source `2e8db984` (Companion 3.5.64). This updates the August 30, 2026 description; it is not a legal review.

## Data processed and purpose

Depending on enabled features and user actions, Companion processes:

- Selected media, source/page URLs, author identifiers, publication dates and classification choices for capture and saved-media indicators, on X and other supported pages.
- X posts, selected text and nearby context, visible page blocks, and user dictionary terms for translation. Page translation can send navigation, captions and comments as well as body text; fields and excluded content are skipped.
- Image bytes (including a canvas fallback), resized image content, recognized original/Korean lines and region boxes for image translation. Permanent image saves can retain translated lines/boxes; paper colour is display-only.
- YouTube video/track identifiers, caption text, timing, glossary and speaker settings for subtitle cleanup/translation. Optional PC ASR sends audio to the configured local service for Japanese transcription/diarization, then text to the configured subtitle provider; it can fall back to YouTube captions.
- Connection/pairing credentials, provider keys, preferences, classification caches, local history and completed subtitles needed for these features.

## Storage and Lakomics server

Browser extension storage holds settings, credentials and caches. Page scripts do not receive provider keys. Paired profile/settings synchronization stores the supported portable settings in the user's Lakomics scope; device connection secrets remain governed by pairing and the settings whitelist. Completed subtitles can be shared through `/v1/extension/subtitles`; partial failures stay local. Local fallback remains available when shared storage is unavailable.

Permanent capture sends source/media URLs and relevant metadata to the paired Lakomics server, which retrieves and stores media. Library state and captured media remain until removed through that setup. The Arca picker reads selected library folders/characters/images through the PC connection or paired server and passes chosen images to Arca's upload handling; it does not submit posts.

## Optional providers

Text translation uses the configured OpenRouter, Anthropic or Neuralwatt/DeepSeek path. Image translation supports the configured Claude, Gemini or Neuralwatt DeepSeek vision option. YouTube processing uses Anthropic and the shared dictionary/key settings; it has no Gemini subtitle provider. Credentials are used by the extension worker for the selected provider. Content sent to a provider is subject to that provider's retention practices. See the [Companion guide](extension-list/README.md) for current model/settings choices and [local ASR setup](_tools/asr/README.md) for the separate PC service.

## Downloads and control

Temporary downloads are explicit actions, separate from permanent server capture and its retry workflow. Server failure is not an automatic legacy download fallback. Local file retention follows the user's filesystem/download controls.

Disable optional features or excluded sites in settings, clear local caches/storage, or uninstall the extension. Subtitle controls can clear this browser's completed/resume data or delete all shared subtitle entries in the paired scope; that does not clear the API key, dictionary or X translation cache. Remove server media/settings through the relevant Lakomics controls. Local settings/caches otherwise remain until changed or cleared; provider retention is controlled by the provider.

Companion does not sell user data, use advertising trackers or execute remotely hosted executable code. Network requests retrieve content, communicate with the user's Lakomics setup, upload selected images to Arca, or call configured translation services. Data is not used for advertising or unrelated profiling.
