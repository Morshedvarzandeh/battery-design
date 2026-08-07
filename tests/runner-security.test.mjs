// The desktop sidecar is a privileged local compute boundary. Exercise it as
// a process so the tests cover binding, HTTP parsing, authentication, limits
// and capability claims together rather than only checking source strings.
import { test } from 'node:test';
import { ok } from './helpers.mjs';
import { createServer } from 'node:net';
import { request as httpRequest } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNNER = path.join(ROOT, 'desktop', 'bd.mjs');
const TOKEN = '0123456789abcdef'.repeat(4);
const TOKEN_HEADER = 'X-Battery-Design-Token';

async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function startRunner(t) {
  const port = await freePort();
  const child = spawn(process.execPath, [RUNNER, 'serve', '--port', String(port), '--token', TOKEN], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  t.after(async () => {
    if (child.exitCode == null) child.kill('SIGTERM');
    if (child.exitCode == null) await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 2000))]);
  });

  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 80; attempt++) {
    if (child.exitCode != null) throw new Error(`runner exited ${child.exitCode}: ${stderr || stdout}`);
    try {
      const response = await fetch(`${base}/api/capabilities`, { headers: { [TOKEN_HEADER]: TOKEN } });
      if (response.ok) return { base, child, stdout: () => stdout };
    } catch { /* starting */ }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`runner did not start: ${stderr || stdout}`);
}

async function api(base, pathname, { token = TOKEN, origin = null, method = 'GET', body = null } = {}) {
  const headers = {};
  if (token != null) headers[TOKEN_HEADER] = token;
  if (origin != null) headers.origin = origin;
  if (body != null) headers['content-type'] = 'application/json';
  return fetch(`${base}${pathname}`, {
    method, headers, body: body == null ? undefined : JSON.stringify(body),
  });
}

async function rawStatus(base, requestPath) {
  const url = new URL(base);
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: url.hostname, port: url.port, method: 'GET', path: requestPath,
    }, (response) => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    });
    request.on('error', reject);
    request.end();
  });
}

test('runner is authenticated, loopback-only in its advertised URL, and reports real surfaces', async (t) => {
  const runner = await startRunner(t);

  const missing = await api(runner.base, '/api/capabilities', { token: null });
  ok(missing.status === 401, 'API rejects a missing token');
  const wrong = await api(runner.base, '/api/capabilities', { token: 'x'.repeat(64) });
  ok(wrong.status === 401, 'API rejects a wrong token');
  const crossOrigin = await api(runner.base, '/api/capabilities', { origin: 'https://attacker.example' });
  ok(crossOrigin.status === 403, 'API rejects a foreign browser origin even with the token');

  const response = await api(runner.base, '/api/capabilities');
  const info = await response.json();
  ok(response.status === 200 && info.runnerId === 'battery-design-desktop-v1', 'authenticated identity is explicit');
  ok(response.headers.get('x-battery-design-runner') === 'battery-design-desktop-v1', 'identity is also in the response header for Tauri readiness');
  const csp = response.headers.get('content-security-policy') || '';
  ok(/default-src 'self'/.test(csp) && /script-src 'self' 'wasm-unsafe-eval'/.test(csp), 'runner CSP permits local scripts and WebAssembly without opening ordinary eval');
  ok(/frame-ancestors 'self'/.test(csp), 'runner pages can be framed only by the same-origin designer');
  ok(!/script-src[^;]*unsafe-inline/.test(csp), 'runner CSP does not reopen inline script execution');
  const shell = await fetch(`${runner.base}/index.html`);
  const shellCsp = shell.headers.get('content-security-policy') || '';
  ok(/script-src[^;]*'sha256-/.test(shellCsp), 'each HTML response hashes its own inline scripts');
  ok(!/script-src[^;]*unsafe-inline/.test(shellCsp), 'HTML responses retain a strict script policy');
  const gui = info.capabilities.map((capability) => capability.id);
  ok(gui.includes('sim2') && gui.includes('cosim') && gui.includes('showroom-machine'), 'actual GUI extras are advertised');
  ok(!gui.includes('search') && !gui.includes('wiring'), 'CLI-only features are not advertised as GUI buttons');
  ok(info.cliCapabilities.some((capability) => capability.id === 'search'), 'CLI features remain discoverable separately');
  ok(runner.stdout().includes(`http://127.0.0.1:`) && runner.stdout().includes(`?token=${TOKEN}`), 'manual serve prints the tokenised loopback URL');
});

test('runner rejects malformed paths and unbounded work without terminating', async (t) => {
  const runner = await startRunner(t);
  const malformed = await fetch(`${runner.base}/%`);
  ok(malformed.status === 400, 'malformed percent escapes return 400 rather than crashing Node');
  ok((await fetch(`${runner.base}/.git/config`)).status === 404, 'hidden repository metadata is never served');
  ok((await fetch(`${runner.base}/%5c.git%5cconfig`)).status === 404, 'encoded Windows separators cannot bypass the hidden-segment rule');
  ok([403, 404].includes(await rawStatus(runner.base, '/..%2f..%2fetc/passwd')), 'encoded traversal cannot escape the real application root');

  const wrongMethod = await api(runner.base, '/api/capabilities', { method: 'PUT' });
  ok(wrongMethod.status === 405, 'unknown API methods are rejected');
  const wrongType = await fetch(`${runner.base}/api/design`, {
    method: 'POST', headers: { [TOKEN_HEADER]: TOKEN }, body: '{}',
  });
  ok(wrongType.status === 415, 'JSON endpoints require an explicit JSON content type');

  const zeroStep = await api(runner.base, '/api/search', {
    method: 'POST', body: { from: 20_000, to: 30_000, step: 0 },
  });
  ok(zeroStep.status === 400 && /step must not be zero/.test((await zeroStep.json()).error), 'zero search step is rejected');
  const wrongDirection = await api(runner.base, '/api/search', {
    method: 'POST', body: { from: 20_000, to: 30_000, step: -1000 },
  });
  ok(wrongDirection.status === 400 && /points away/.test((await wrongDirection.json()).error), 'wrong-direction search step is rejected');
  const tooMany = await api(runner.base, '/api/search', {
    method: 'POST', body: { from: 1, to: 100_000, step: 1 },
  });
  ok(tooMany.status === 400 && /limit/.test((await tooMany.json()).error), 'candidate range is bounded before jobs are allocated');

  const costlyProfile = await api(runner.base, '/api/sim2', {
    method: 'POST',
    body: {
      spec: { application: 'ev' }, params: { maxDtS: 0.001 },
      profile: { dtS: 1, w: Array.from({ length: 6000 }, () => 1000) },
    },
  });
  ok(costlyProfile.status === 400 && /integration-module steps/.test((await costlyProfile.json()).error), 'simulation integration work is bounded independently of input bytes');

  const profile = Array.from({ length: 100_001 }, () => 1000);
  const oversizedProfile = await api(runner.base, '/api/sim2', {
    method: 'POST', body: { spec: { application: 'ev' }, profile: { dtS: 1, w: profile } },
  });
  ok(oversizedProfile.status === 400 && /samples/.test((await oversizedProfile.json()).error), 'simulation profile length is bounded');

  const complexJson = await api(runner.base, '/api/design', {
    method: 'POST', body: { values: Array.from({ length: 250_001 }, () => 0) },
  });
  ok(complexJson.status === 413 && /too many values/.test((await complexJson.json()).error), 'JSON structural complexity is bounded below the byte ceiling');

  const oversizedBody = await fetch(`${runner.base}/api/design`, {
    method: 'POST',
    headers: { [TOKEN_HEADER]: TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify({ padding: 'x'.repeat(4 * 1024 * 1024) }),
  });
  ok(oversizedBody.status === 413 && /MiB limit/.test((await oversizedBody.json()).error), 'request bytes are capped before parsing');

  const alive = await api(runner.base, '/api/capabilities');
  ok(alive.status === 200, 'runner remains healthy after rejected inputs');
});

test('desktop bootstrap scrubs the URL token and attaches it to every API call', () => {
  const moduleUrl = `${pathToFileURL(path.join(ROOT, 'js', 'desktop-link.js')).href}?runner-security=${Date.now()}`;
  const script = `
    const stored = new Map();
    const calls = [];
    globalThis.location = { href: 'http://127.0.0.1:8420/index.html?mode=test&token=${TOKEN}#pack' };
    globalThis.sessionStorage = { setItem: (k,v) => stored.set(k,v), getItem: (k) => stored.get(k) || null };
    globalThis.history = { state: { keep: true }, replaceState: (_s,_t,url) => calls.push({ clean: url }) };
    globalThis.fetch = async (url, options = {}) => {
      calls.push({ url, options });
      return { ok: true, status: 200, json: async () => ({ runner: 'battery-design desktop', runnerId: 'battery-design-desktop-v1', cores: 4, capabilities: [] }) };
    };
    const link = await import(${JSON.stringify(moduleUrl)});
    await link.detectRunner();
    await link.runAdvancedModel({ spec: {} });
    process.stdout.write(JSON.stringify({ calls, stored: [...stored.entries()] }));
  `;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: ROOT, encoding: 'utf8' });
  ok(run.status === 0, `bootstrap subprocess succeeds: ${run.stderr}`);
  const result = JSON.parse(run.stdout);
  ok(result.calls[0].clean === '/index.html?mode=test#pack', 'token is removed while path, other query and hash are preserved');
  ok(result.stored.some(([key, value]) => /runner-token/.test(key) && value === TOKEN), 'token is kept only in session storage');
  const requests = result.calls.filter((entry) => entry.options);
  ok(requests.length === 2 && requests.every((entry) => entry.options.headers[TOKEN_HEADER] === TOKEN), 'probe and POST both use the token header');
});

test('CLI range guards fail readably instead of hanging', () => {
  const run = spawnSync(process.execPath, [RUNNER, 'range', '--app', 'ev', '--from', '1000', '--to', '2000', '--step', '0'], {
    cwd: ROOT, encoding: 'utf8', timeout: 5000,
  });
  ok(run.status === 2 && /step must not be zero/.test(run.stderr), 'zero step exits with a bounded input error');
  ok(!/\n\s+at /.test(run.stderr), 'user input error does not print a stack');
});

test('runner refuses privileged/default HTTP ports whose browser origin is ambiguous', () => {
  const run = spawnSync(process.execPath, [RUNNER, 'serve', '--port', '80', '--token', TOKEN], {
    cwd: ROOT, encoding: 'utf8', timeout: 5000,
  });
  ok(run.status === 2 && /port must be 0/.test(run.stderr), 'port 80 is rejected with a readable input error');
});

test('CLI reports modeled thermal peak separately from the cell rating', () => {
  const run = spawnSync(process.execPath, [RUNNER, 'mission', '--app', 'ev', '--energy', '60000'], {
    cwd: ROOT, encoding: 'utf8', timeout: 10_000,
  });
  ok(run.status === 0, `mission completes: ${run.stderr}`);
  const match = run.stdout.match(/modeled peak ([\d.]+) °C \(cell limit ([\d.]+) °C\)/);
  ok(match, 'CLI names both quantities without calling the rating a result');
  ok(Number(match[1]) > Number(match[2]), 'the regression case exposes the real over-temperature instead of hiding it');
});

test('Tauri generates a cryptographic token, authenticates readiness and has a CSP fallback', () => {
  const rust = readFileSync(path.join(ROOT, 'desktop-app', 'src-tauri', 'src', 'main.rs'), 'utf8');
  const cargo = readFileSync(path.join(ROOT, 'desktop-app', 'src-tauri', 'Cargo.toml'), 'utf8');
  const lock = readFileSync(path.join(ROOT, 'desktop-app', 'src-tauri', 'Cargo.lock'), 'utf8');
  const config = JSON.parse(readFileSync(path.join(ROOT, 'desktop-app', 'src-tauri', 'tauri.conf.json'), 'utf8'));
  ok(/getrandom::fill/.test(rust) && /getrandom = "0\.3"/.test(cargo), 'Tauri uses the OS CSPRNG');
  ok(/"getrandom 0\.3\.4"/.test(lock), 'locked desktop build includes the direct RNG dependency');
  ok(/X-Battery-Design-Token/.test(rust) && /runnerId/.test(rust) && /authenticated_probe/.test(rust), 'readiness verifies the authenticated runner identity');
  ok(!/TcpListener::bind\(\("127\.0\.0\.1", port\)\)\.is_err/.test(rust), 'occupied-port detection is no longer treated as readiness');
  ok(/default-src 'self'/.test(config.app.security.csp) && /object-src 'none'/.test(config.app.security.csp), 'direct-page fallback has an explicit CSP');
  ok(config.build.beforeBuildCommand === 'node prepare.mjs', 'Tauri stages from the desktop-app project working directory');
  ok(/script-src 'self' 'wasm-unsafe-eval' 'sha256-/.test(config.app.security.csp)
    && /frame-ancestors 'self'/.test(config.app.security.csp)
    && !/script-src[^;]*unsafe-inline/.test(config.app.security.csp), 'Tauri fallback permits Wasm and same-origin showroom framing without unsafe inline scripts');
});

test('Godot uses the hashed shell bridge instead of JavaScript eval', () => {
  const gdscript = readFileSync(path.join(ROOT, 'garage3d', 'garage.gd'), 'utf8');
  const bridge = readFileSync(path.join(ROOT, 'garage3d', 'head_include.html'), 'utf8');
  const preset = readFileSync(path.join(ROOT, 'garage3d', 'export_presets.cfg'), 'utf8');
  const encoded = preset.match(/^html\/head_include=(".*")$/m)?.[1];
  ok(encoded && JSON.parse(encoded) === bridge, 'the exported shell contains the reviewed bridge source exactly');
  ok(/window\.bdPostMessage/.test(bridge) && /window\.bdPostMessage/.test(gdscript), 'Godot calls a normal pre-hashed bridge function');
  ok(!/JavaScriptBridge\.eval/.test(gdscript), 'renderer messaging does not require unsafe JavaScript eval');
});
