import { defineConfig } from 'vitest/config';
import {readFileSync} from 'node:fs';
// Same build-time version as vite.mobile.config.ts, so Settings › 버전 is tested against the manifest.
const appVersion = /android:versionName="([^"]+)"/.exec(readFileSync(new URL('../../android/AndroidManifest.xml', import.meta.url), 'utf8'))?.[1] ?? 'dev';
export default defineConfig({ define: { __APP_VERSION__: JSON.stringify(appVersion) }, test: { environment: 'jsdom', include: ['mobile-client/**/*.test.{ts,tsx}'] } });
