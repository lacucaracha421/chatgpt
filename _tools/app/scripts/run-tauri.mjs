import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

if (process.platform === "win32") {
  const pathKey = Object.keys(process.env).find(
    (key) => key.toLowerCase() === "path",
  );
  if (pathKey) {
    process.env[pathKey] = process.env[pathKey].replaceAll('"', "");
  }
}

const cliPath = fileURLToPath(
  new URL("../node_modules/@tauri-apps/cli/tauri.js", import.meta.url),
);
const child = spawn(process.execPath, [cliPath, ...process.argv.slice(2)], {
  env: process.env,
  stdio: "inherit",
});

child.on("error", (error) => {
  console.error(`Failed to start the Tauri CLI: ${error.message}`);
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
