// desktop-link.js — the same interface, with the ceiling removed.
//
// The page does not know or care whether it was opened from the public site
// or served by the local runner. It asks once, at startup, whether a runner is
// answering — and if one is, the capabilities that a browser tab cannot
// reasonably compute stop being absent and start being buttons.
//
// That is the whole design: ONE interface, not a cut-down web version and a
// separate desktop program. The 3D and 2D viewers, the wizard, the training,
// the private cell library, the PDF/Word/Excel export, the bay editor — all of
// it is the same code either way. The desktop adds what it can compute, not a
// different way of working.
//
// Everything here fails soft. If no runner answers — the usual case on the
// public site — nothing appears, nothing errors, and the page behaves exactly
// as it always has.

const PROBE_TIMEOUT_MS = 1500;
const TOKEN_STORAGE_KEY = 'battery-design.runner-token';
const TOKEN_HEADER = 'X-Battery-Design-Token';
const RUNNER_ID = 'battery-design-desktop-v1';

// Tauri and `bd.mjs serve` open one tokenised bootstrap URL. Keep the secret
// only for this tab session, then remove it from the address bar immediately
// so reload still works without leaking it through history or referrers.
function bootstrapToken() {
  let token = null;
  let url = null;
  try {
    const href = globalThis.location?.href;
    if (href) {
      url = new URL(href);
      token = url.searchParams.get('token');
      if (token) {
        try { globalThis.sessionStorage?.setItem(TOKEN_STORAGE_KEY, token); } catch { /* session-only memory still works */ }
      }
    }
  } catch {
    // A malformed host URL cannot happen in the packaged app; fail soft if an
    // embedder supplies one.
  }
  if (token && url) {
    try {
      url.searchParams.delete('token');
      globalThis.history?.replaceState(globalThis.history.state, '', `${url.pathname}${url.search}${url.hash}`);
    } catch { /* the token remains memory-only even if history is unavailable */ }
  }
  try { token ||= globalThis.sessionStorage?.getItem(TOKEN_STORAGE_KEY) || null; } catch { /* storage can be disabled */ }
  return token;
}

let cached = null;   // null = not asked yet, false = no runner, object = runner
let runnerToken = bootstrapToken();

/**
 * Is a local runner answering? Asked once; the answer is remembered.
 * Returns the capability list, or false.
 */
export async function detectRunner() {
  if (cached !== null) return cached;
  cached = false;
  if (!runnerToken) return cached;
  let timer;
  try {
    const ctl = new AbortController();
    timer = setTimeout(() => ctl.abort(), PROBE_TIMEOUT_MS);
    const res = await fetch('/api/capabilities', {
      signal: ctl.signal,
      headers: { [TOKEN_HEADER]: runnerToken },
      credentials: 'same-origin',
    });
    if (res.ok) {
      const info = await res.json();
      // Only trust an answer that looks like ours.
      if (info?.runnerId === RUNNER_ID && info?.runner === 'battery-design desktop'
        && Array.isArray(info.capabilities)) cached = info;
    }
  } catch {
    // No runner, a timeout, or a plain static host. All the same thing: the
    // page carries on as the browser version.
  } finally {
    clearTimeout(timer);
  }
  return cached;
}

// For tests and for code that must not re-probe.
export function knownRunner() { return cached; }
export function resetRunner() { cached = null; }

async function post(path, body) {
  if (!runnerToken) throw new Error('The authenticated desktop runner is not available in this session.');
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', [TOKEN_HEADER]: runnerToken },
    credentials: 'same-origin',
    body: JSON.stringify(body ?? {}),
  });
  const data = await res.json().catch(() => ({ error: `The runner returned ${res.status}.` }));
  if (!res.ok || data.error) throw new Error(data.error || `The runner returned ${res.status}.`);
  return data;
}

/** The advanced electro-thermal model, computed by the runner. */
export const runAdvancedModel = (body) => post('/api/sim2', body);

/** Fit the model to measured data. */
export const runCalibration = (body) => post('/api/calibrate', body);

/** Search the design space across every core. */
export const runSearch = (body) => post('/api/search', body);

/** Build an FMI source-FMU kit. Returns its path-preserving files as strings. */
export const buildFmuOnRunner = (body) => post('/api/fmu', body);

/**
 * What to tell the customer, in one sentence, about where they are running.
 * Honest in both directions: the browser version is not broken, it is bounded.
 */
export function runnerStatusLine(info) {
  if (!info) {
    return {
      here: 'browser',
      text: 'Running in your browser — instant, private, nothing installed. '
        + 'The desktop GUI adds the advanced model and source-FMU export. '
        + 'Design-space search, calibration and automation are available separately through its CLI/API/MCP interfaces.',
    };
  }
  return {
    here: 'desktop',
    text: `Running on your machine across ${info.cores} core${info.cores === 1 ? '' : 's'} — `
      + `${info.capabilities.length} desktop-GUI extra${info.capabilities.length === 1 ? ' is' : 's are'} visible here: `
      + `${info.capabilities.map((c) => c.name).join(', ')}. Nothing leaves this computer.`,
  };
}
