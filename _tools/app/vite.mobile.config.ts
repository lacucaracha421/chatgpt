import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import {readFileSync} from 'node:fs';
// The tablet shows the APK's own version (Settings › 정보), read from the manifest at build time.
const appVersion = /android:versionName="([^"]+)"/.exec(readFileSync(new URL('../../android/AndroidManifest.xml', import.meta.url), 'utf8'))?.[1] ?? 'dev';
export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(appVersion) },
  root: 'mobile-client', base: './', plugins: [react(), {
    name: 'bundled-font-licenses', generateBundle() {
      for (const name of ['Pretendard-OFL.txt', 'Rajdhani-OFL.txt']) {
        this.emitFile({type:'asset',fileName:`licenses/${name}`,source:readFileSync(new URL(`./src/styles/fonts/${name}`,import.meta.url),'utf8')});
      }
    },
  }],
  build: { outDir: '../../../android/assets', emptyOutDir: true, sourcemap: false },
  server: { host: '127.0.0.1', port: 1448, strictPort: true },
});
