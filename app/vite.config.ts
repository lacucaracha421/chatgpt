/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { configDefaults } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  test: {
    exclude: [...configDefaults.exclude, "**/.tmp/**"],
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    css: { include: [/src\/styles\/(?:tokens|global)\.css$/] },
  },
});
