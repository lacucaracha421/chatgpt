import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

const baseUrl = "http://127.0.0.1:1430";
const views = [
  "home", "assets", "assets-folder", "artists", "albums", "collections",
  "collection-detail", "calendar", "manga", "manga-catalog", "notes", "settings",
];
const outputDir = fileURLToPath(new URL("../../../.tmp/preview-shots/", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const packageRoot = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
await mkdir(outputDir, { recursive: true });

let server = null;
let serverOutput = "";
let serverClosed = Promise.resolve();
let chromeProfile = null;
const files = [];
try {
  if (!await available()) {
    server = spawn("npm", ["run", "dev:preview"], { cwd: packageRoot, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    serverClosed = new Promise(resolve => server.once("close", resolve));
    server.once("error", error => { serverOutput = `${serverOutput}\n${error.stack ?? error.message}`.slice(-8000); });
    server.stdout.on("data", chunk => { serverOutput = (serverOutput + chunk).slice(-8000); });
    server.stderr.on("data", chunk => { serverOutput = (serverOutput + chunk).slice(-8000); });
    await waitForServer();
  }

  chromeProfile = await mkdtemp(path.join(tmpdir(), "lakomics-preview-chrome-"));
  for (const view of views) {
    const file = path.join(outputDir, `${view}.png`);
    const params = new URLSearchParams({ view });
    if (view === "assets") params.set("panel", "info");
    await run("/usr/bin/google-chrome", [
      "--headless=new",
      "--hide-scrollbars",
      "--window-size=1440,900",
      "--virtual-time-budget=4000",
      "--disable-gpu",
      "--no-sandbox",
      `--user-data-dir=${chromeProfile}`,
      `--screenshot=${file}`,
      `${baseUrl}/?${params.toString()}`,
    ]);
    files.push(file);
  }
} finally {
  if (chromeProfile) await rm(chromeProfile, { recursive: true, force: true });
  if (server?.exitCode === null) {
    server.kill("SIGTERM");
    await Promise.race([serverClosed, new Promise(resolve => setTimeout(resolve, 3000))]);
    if (server.exitCode === null) server.kill("SIGKILL");
  }
}

for (const file of files) console.log(path.relative(repoRoot, file));

async function available() {
  try {
    const response = await fetch(`${baseUrl}/preview-media/thumbnail/asset-001`, { signal: AbortSignal.timeout(800) });
    return response.ok && response.headers.get("content-type")?.startsWith("image/svg+xml") === true;
  }
  catch { return false; }
}

async function waitForServer() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (await available()) return;
    if (server?.exitCode !== null) {
      await serverClosed;
      throw new Error(`Preview server exited before it was ready.\n${serverOutput}`);
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`Preview server did not become ready.\n${serverOutput}`);
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.on("data", chunk => { output += chunk; });
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}.\n${output}`)));
  });
}
