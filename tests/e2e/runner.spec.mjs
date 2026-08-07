import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const RUNNER = path.join(ROOT, 'desktop', 'bd.mjs');
const GODOT_BUILD = path.join(ROOT, 'garage3d', 'build', 'index.html');
const TOKEN = 'playwright-desktop-token-'.padEnd(64, '7');
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

async function startRunner() {
  const port = await freePort();
  const child = spawn(process.execPath, [RUNNER, 'serve', '--port', String(port), '--token', TOKEN], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });

  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode != null) throw new Error(`runner exited ${child.exitCode}: ${stderr || stdout}`);
    try {
      const response = await fetch(`${base}/api/capabilities`, {
        headers: { [TOKEN_HEADER]: TOKEN },
      });
      if (response.ok) return { base, child, logs: () => stderr || stdout };
    } catch { /* still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  child.kill('SIGTERM');
  throw new Error(`runner did not start: ${stderr || stdout}`);
}

async function stopRunner(runner) {
  if (runner.child.exitCode != null) return;
  runner.child.kill('SIGTERM');
  await Promise.race([
    once(runner.child, 'exit'),
    new Promise((resolve) => setTimeout(resolve, 2000)),
  ]);
  if (runner.child.exitCode == null) runner.child.kill('SIGKILL');
}

function prepareDesktopPage(page) {
  return page.addInitScript(() => {
    localStorage.setItem('bd-wizard-done', '1');
    localStorage.setItem('bd-audience', 'engineering');
  });
}

test('the authenticated runner launches the real UI and its Rust/Wasm core under CSP', async ({ page }) => {
  const runner = await startRunner();
  try {
    await prepareDesktopPage(page);
    await page.goto(`${runner.base}/index.html?token=${TOKEN}`);

    await expect.poll(() => {
      const url = new URL(page.url());
      return `${url.origin}${url.pathname}${url.search}`;
    }).toBe(`${runner.base}/index.html`);
    const url = new URL(page.url());
    expect(url.search).toBe('');
    expect(page.url()).not.toContain(TOKEN);
    const sharedDesign = JSON.parse(decodeURIComponent(url.hash.slice(1)));
    expect(sharedDesign).toEqual(expect.objectContaining({
      c: expect.any(String),
      s: expect.any(Number),
      p: expect.any(Number),
      sel: expect.any(Object),
    }));
    await expect(page.locator('#runnerBox')).toContainText('your machine');
    await expect.poll(() => page.evaluate(async () => {
      const core = await import('/js/wasm-core.js');
      return core.wasmCoreReady();
    }), { timeout: 20_000, message: 'Rust/Wasm core should compile under the runner CSP' }).toBe(true);

    const csp = await page.evaluate(async () => (await fetch('/index.html')).headers.get('content-security-policy'));
    expect(csp).toContain("frame-ancestors 'self'");
    expect(csp).toContain("'wasm-unsafe-eval'");
    expect(csp).toContain("'sha256-");
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
  } finally {
    await stopRunner(runner);
  }
});

test('the authenticated GUI exports and inspects the canonical FMI mapping accessibly', async ({ page }) => {
  const runner = await startRunner();
  const runtimeErrors = [];
  page.on('pageerror', (error) => runtimeErrors.push(error.message));
  try {
    await prepareDesktopPage(page);
    await page.goto(`${runner.base}/index.html?token=${TOKEN}`);
    await page.getByRole('tab', { name: 'Results' }).click();
    await expect(page.locator('#runnerBox')).toContainText('your machine');
    await expect(page.getByRole('button', { name: 'Export FMI 2.0 source kit' })).toBeVisible();

    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export FMI 2.0 source kit' }).click();
    const download = await downloadPromise;
    await expect(page.locator('#runnerOut details')).toBeVisible();
    await expect(page.locator('#runnerOut summary')).toContainText('3 inputs · 6 outputs · 14 design parameters');
    await page.locator('#runnerOut summary').click();
    await expect(page.locator('#runnerOut')).toContainText('battery.pack.terminalCurrent');
    await expect(page.locator('#runnerOut')).toContainText('battery.pack.terminalPower');
    await expect(page.locator('#runnerOut')).toContainText('Static design');

    expect(download.suggestedFilename()).toMatch(/BatteryPack-source-fmu-kit\.json$/);
    const downloadPath = await download.path();
    expect(downloadPath).toBeTruthy();
    const manifest = JSON.parse(readFileSync(downloadPath, 'utf8'));
    expect(manifest.format).toBe('battery-design/source-fmu-kit@1');
    expect(manifest.files).toEqual(expect.objectContaining({
      'modelDescription.xml': expect.any(String),
      'resources/battery-design-io-map.json': expect.any(String),
      'resources/battery-design-design.json': expect.any(String),
    }));

    const axe = await new AxeBuilder({ page })
      .include('#runnerOut')
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22a', 'wcag22aa'])
      .analyze();
    const blocking = axe.violations.filter(({ impact }) => impact === 'serious' || impact === 'critical');
    expect(blocking, blocking.map(({ id, help }) => `${id}: ${help}`).join('\n')).toEqual([]);
    expect(runtimeErrors, `runner mapping runtime errors:\n${runtimeErrors.join('\n')}\n${runner.logs()}`).toEqual([]);
  } finally {
    await stopRunner(runner);
  }
});

test('the verified Godot export reaches its ready signal inside the runner origin', async ({ page }) => {
  test.skip(!existsSync(GODOT_BUILD), 'Godot export is built by the CI gate before this integration test.');
  const runner = await startRunner();
  const violations = [];
  page.on('pageerror', (error) => violations.push(error.message));
  page.on('console', (message) => {
    if (/content security policy|refused to/i.test(message.text())) violations.push(message.text());
  });

  try {
    await prepareDesktopPage(page);
    await page.goto(`${runner.base}/index.html?token=${TOKEN}`);
    await expect(page.locator('#runnerBox')).toContainText('your machine');
    await page.getByRole('tab', { name: 'Garage' }).click();

    const responsePromise = page.waitForResponse((response) =>
      response.url() === `${runner.base}/garage3d/build/index.html`);
    await page.getByRole('button', { name: 'Walk around it' }).click();
    await expect(page.locator('.garage3d-frame')).toBeVisible();
    await expect(page.locator('#showroomStatus')).toContainText('Starting the renderer');

    const response = await responsePromise;
    const csp = response.headers()['content-security-policy'] || '';
    expect(csp).toContain("frame-ancestors 'self'");
    expect(csp).toContain("'wasm-unsafe-eval'");
    expect((csp.match(/'sha256-/g) || []).length).toBeGreaterThan(0);
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);

    await expect(page.locator('#showroomStatus')).toHaveText('', { timeout: 60_000 });
    expect(violations, `runner-origin browser violations:\n${violations.join('\n')}\n${runner.logs()}`).toEqual([]);
  } finally {
    await stopRunner(runner);
  }
});
