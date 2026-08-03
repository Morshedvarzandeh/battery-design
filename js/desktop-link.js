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

let cached = null;   // null = not asked yet, false = no runner, object = runner

/**
 * Is a local runner answering? Asked once; the answer is remembered.
 * Returns the capability list, or false.
 */
export async function detectRunner() {
  if (cached !== null) return cached;
  cached = false;
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), PROBE_TIMEOUT_MS);
    const res = await fetch('/api/capabilities', { signal: ctl.signal });
    clearTimeout(timer);
    if (res.ok) {
      const info = await res.json();
      // Only trust an answer that looks like ours.
      if (info?.runner && Array.isArray(info.capabilities)) cached = info;
    }
  } catch {
    // No runner, a timeout, or a plain static host. All the same thing: the
    // page carries on as the browser version.
  }
  return cached;
}

// For tests and for code that must not re-probe.
export function knownRunner() { return cached; }
export function resetRunner() { cached = null; }

async function post(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
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

/** Build the FMI co-simulation FMU. Returns the files as strings. */
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
        + 'The heavier studies (the calibratable model, design-space search, co-simulation export) '
        + 'need the desktop runner, which is the same interface with the ceiling removed.',
    };
  }
  return {
    here: 'desktop',
    text: `Running on your machine across ${info.cores} core${info.cores === 1 ? '' : 's'} — `
      + `${info.capabilities.length} extra capabilit${info.capabilities.length === 1 ? 'y is' : 'ies are'} available here: `
      + `${info.capabilities.map((c) => c.name).join(', ')}. Nothing leaves this computer.`,
  };
}
