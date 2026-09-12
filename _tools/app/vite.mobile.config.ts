import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import {readFileSync} from 'node:fs';
export default defineConfig({
  root: 'mobile-client', base: './', plugins: [react(), {
    name: 'bundled-font-licenses', generateBundle() {
      for (const name of ['Barlow-OFL.txt', 'Rajdhani-OFL.txt', 'SUIT-OFL.txt']) {
        this.emitFile({type:'asset',fileName:`licenses/${name}`,source:readFileSync(new URL(`./src/styles/fonts/${name}`,import.meta.url),'utf8')});
      }
    },
  }],
  build: { outDir: '../../android/assets', emptyOutDir: true, sourcemap: false },
  server: { host: '127.0.0.1', port: 1448, strictPort: true },
});
