/// <reference types="vitest/config" />
import process from "node:process";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { configDefaults } from "vitest/config";

export default defineConfig(async ({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const preview = (env.LAKOMICS_PREVIEW ?? process.env.LAKOMICS_PREVIEW) === "1";
  return {
    plugins: [react(), ...(preview ? [(await import("./src/preview/mediaPlugin.ts")).previewMediaPlugin()] : [])],
    define: { __LAKOMICS_PREVIEW__: preview ? "true" : "false" },
    resolve: preview ? {
      alias: {
        "@tauri-apps/api/core": "/src/preview/shims/core.ts",
        "@tauri-apps/api/event": "/src/preview/shims/event.ts",
        "@tauri-apps/api/window": "/src/preview/shims/window.ts",
        "@tauri-apps/api/webview": "/src/preview/shims/webview.ts",
        "@tauri-apps/api/app": "/src/preview/shims/app.ts",
        "@tauri-apps/plugin-dialog": "/src/preview/shims/dialog.ts",
        "@tauri-apps/plugin-opener": "/src/preview/shims/opener.ts",
      },
    } : undefined,
    clearScreen: false,
    server: {
      port: 1420,
      strictPort: true,
      watch: {
        ignored: ["**/src-tauri/**"],
      },
    },
    test: {
      // mobile-client tests run under vitest.mobile.config.ts (npm run mobile:test).
      exclude: [...configDefaults.exclude, "**/.tmp/**", "mobile-client/**", "scripts/**/*.test.mjs"], // node --test suites for the perf kit
      environment: "jsdom",
      setupFiles: ["./src/test/setup.ts"],
      css: { include: [/src\/styles\/(?:tokens|global)\.css$/] },
    },
  };
});
