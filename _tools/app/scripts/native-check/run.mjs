// Opens the real Lakomics window on the test library and drives it over WebDriver.
//
//   node run.mjs <steps.json> <out-dir>
//
// Safety (see README.md): the app runs with its own config/data/cache folders, so it
// does not know the real library path; a private, empty D-Bus session so it cannot read
// the server tokens in the user's keyring; proxies pointing at a closed port; and the
// test library, whose server settings were removed by make_test_library.py.
//
// Steps: {"eval": js} | {"waitFor": css} | {"click": css} | {"dblclick": css} | {"key": "ArrowRight"} |
//        {"resize": [w, h]} | {"wait": ms} | {"shot": "name"}
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const [stepsFile, outDir] = process.argv.slice(2);
if (!stepsFile || !outDir) { console.error('usage: node run.mjs <steps.json> <out-dir>'); process.exit(2); }
const base = join(homedir(), '.cache/lakomics-native-check');
const app = join(base, 'target/debug/lakomics');
const library = join(base, 'library');
const home = join(base, 'home');
if (!existsSync(app)) throw new Error(`build the app first: ${app}`);
if (!existsSync(join(library, '.lakomics-dev-library'))) throw new Error('run make_test_library.py first');
const settings = execFileSync('sqlite3', ['-readonly', join(library, 'library.sqlite'), 'SELECT cloud_sync_enabled, cloud_capture_enabled, ifnull(cloud_api_base_url, "") FROM library_settings']).toString().trim();
if (settings !== '0|0|') throw new Error(`the test library still has server settings: ${settings}`);
for (const dir of ['config', 'data', 'cache', 'runtime']) mkdirSync(join(home, dir), { recursive: true, mode: 0o700 });
mkdirSync(outDir, { recursive: true });

const children = [];
const stop = () => { for (const child of children.reverse()) { try { child.kill('SIGTERM'); } catch {} } };
process.on('exit', stop);
process.on('SIGINT', () => process.exit(130));

// A private, empty session bus: the app's Secret Service lookups fail instead of reading the user's keyring.
// No service directories: nothing (e.g. a keyring daemon) can be started on this bus.
const busConfig = join(home, 'bus.conf');
writeFileSync(busConfig, `<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN" "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig><type>session</type><listen>unix:dir=${join(home, 'runtime')}</listen><auth>EXTERNAL</auth>
<policy context="default"><allow send_destination="*" eavesdrop="true"/><allow eavesdrop="true"/><allow own="*"/></policy></busconfig>\n`);
const bus = spawn('dbus-daemon', ['--config-file', busConfig, '--nofork', '--print-address=1', '--nopidfile'], { stdio: ['ignore', 'pipe', 'inherit'] });
children.push(bus);
const busAddress = await new Promise((done, fail) => { bus.stdout.once('data', (chunk) => done(chunk.toString().trim())); bus.once('exit', () => fail(new Error('dbus-daemon exited'))); });

const env = {
  ...process.env,
  XDG_CONFIG_HOME: join(home, 'config'), XDG_DATA_HOME: join(home, 'data'), XDG_CACHE_HOME: join(home, 'cache'),
  DBUS_SESSION_BUS_ADDRESS: busAddress,
  HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9', ALL_PROXY: 'http://127.0.0.1:9',
  http_proxy: 'http://127.0.0.1:9', https_proxy: 'http://127.0.0.1:9', all_proxy: 'http://127.0.0.1:9',
  NO_PROXY: 'localhost,127.0.0.1', no_proxy: 'localhost,127.0.0.1',
};
delete env.GNOME_KEYRING_CONTROL; delete env.SSH_AUTH_SOCK;

const port = 4444 + Math.floor(Math.random() * 400);
const driver = spawn(join(homedir(), '.cargo/bin/tauri-driver'), ['--port', String(port), '--native-driver', join(homedir(), '.cargo/bin/WebKitWebDriver')], { env, stdio: ['ignore', 'inherit', 'inherit'] });
children.push(driver);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// WebDriver code points for named keys.
const KEYS = { Enter: '', Escape: '', Home: '', ArrowLeft: '', ArrowUp: '', ArrowRight: '', ArrowDown: '', Tab: '' };
const url = `http://127.0.0.1:${port}`;
async function call(method, path, body) {
  const response = await fetch(url + path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${method} ${path}: ${JSON.stringify(json).slice(0, 400)}`);
  return json.value;
}
for (let k = 0; k < 50; k++) { try { await fetch(url + '/status'); break; } catch { await sleep(200); } }
const session = await call('POST', '/session', { capabilities: { alwaysMatch: { 'tauri:options': { application: app } } } });
const sid = session.sessionId;
const s = (path) => `/session/${sid}${path}`;
const run = (script, args = []) => call('POST', s('/execute/sync'), { script, args });
try {
  await sleep(2500);
  // Point the app at the test library through its own remembered-path key, then reload.
  await run('localStorage.setItem("lakomics.libraryPath", arguments[0]); location.reload(); return true;', [library]);
  await sleep(6000);
  const opened = await run('return localStorage.getItem("lakomics.libraryPath");');
  if (opened !== library) throw new Error(`unexpected library path: ${opened}`);
  for (const step of JSON.parse(readFileSync(stepsFile, 'utf8'))) {
    if (step.wait) await sleep(step.wait);
    if (step.waitFor) { let found = false; for (let k = 0; k < 120 && !found; k++) { found = await run('return Boolean(document.querySelector(arguments[0]));', [step.waitFor]); if (!found) await sleep(500); } if (!found) throw new Error(`timed out waiting for ${step.waitFor}`); }
    if (step.resize) await call('POST', s('/window/rect'), { width: step.resize[0], height: step.resize[1] });
    if (step.eval) console.log('eval:', JSON.stringify(await run(step.eval)));
    if (step.click || step.dblclick) {
      const element = await call('POST', s('/element'), { using: 'css selector', value: step.click ?? step.dblclick });
      const id = Object.values(element)[0];
      if (step.click) await call('POST', s(`/element/${id}/click`), {});
      else await call('POST', s('/actions'), { actions: [{ type: 'pointer', id: 'mouse', parameters: { pointerType: 'mouse' }, actions: [{ type: 'pointerMove', origin: { 'element-6066-11e4-a52e-4f735466cecf': id }, x: 0, y: 0 }, { type: 'pointerDown', button: 0 }, { type: 'pointerUp', button: 0 }, { type: 'pointerDown', button: 0 }, { type: 'pointerUp', button: 0 }] }] });
    }
    if (step.key) { const value = KEYS[step.key] ?? step.key; await call('POST', s('/actions'), { actions: [{ type: 'key', id: 'kb', actions: [{ type: 'keyDown', value }, { type: 'keyUp', value }] }] }); }
    if (step.shot) { const png = await call('GET', s('/screenshot')); writeFileSync(join(resolve(outDir), `${step.shot}.png`), Buffer.from(png, 'base64')); console.log('shot:', step.shot); }
  }
  // Evidence: every TCP connection held by the app's processes at the end of the run (only local ones are expected).
  const pids = execFileSync('pgrep', ['-f', app]).toString().trim().split('\n').filter(Boolean);
  const sockets = execFileSync('ss', ['-tnpH']).toString().split('\n').filter((line) => pids.some((pid) => line.includes(`pid=${pid},`)));
  const remote = sockets.filter((line) => !/^(127\.0\.0\.1|\[::1\]|\[::ffff:127\.0\.0\.1\]):/.test(line.trim().split(/\s+/)[4] ?? ''));
  writeFileSync(join(resolve(outDir), 'connections.txt'), `app pids: ${pids.join(' ')}\n${sockets.join('\n')}\nnon-local: ${remote.length}\n`);
  console.log(`connections: ${sockets.length} (non-local ${remote.length})`);
} finally {
  await call('DELETE', s('')).catch(() => {});
  stop();
}
process.exit(0);
