// limits.js — the tool refuses work it cannot finish, and never dies trying.
//
// Found by fuzzing the engine with hostile inputs: a 100000S100000P design and
// a ten-million-pass mission both ran forever. Neither is a slow answer — both
// are a frozen application, which on a modest machine is indistinguishable
// from a crash. A typo in a number field should not cost someone their work.
//
// Two rules, and they are different from each other:
//
//   1. BOUND THE WORK. Some requests are nonsense — ten billion cells is not
//      a pack. The tool clamps them to something buildable and SAYS SO. It
//      does not spin, and it does not silently pretend the request was fine.
//
//   2. CONTAIN THE FAILURE. When one panel's maths goes wrong, that panel
//      says so and the rest of the application keeps working. One broken
//      number must never take the page down with it.
//
// The limits below are deliberately generous: every one sits far above the
// largest real design the tool has been pointed at, so no honest user meets
// them. They exist to catch typos and runaway loops, not to ration.

// A 12 m e-bus pack is about 30,000 cells; grid containers reach into the
// hundreds of thousands. A quarter of a million is past anything this tool
// models as ONE pack, and 10 billion is a slipped keystroke.
export const MAX_CELLS = 250_000;

// Total integration steps across a whole run. A 30-minute WLTP cycle at 1 s
// with 20 passes is 36,000 — this is fifty times that.
export const MAX_SIM_STEPS = 2_000_000;

// Nobody types 500 series cells by accident and means it; but 10,000 is a
// typo. These bound the individual fields before they multiply.
export const MAX_SERIES = 2_000;
export const MAX_PARALLEL = 5_000;

/**
 * Clamp a pack configuration to something that can actually be built and
 * computed. Returns the corrected counts plus a note for every correction —
 * the caller must show these, never swallow them.
 */
export function clampPack(s, p) {
  const notes = [];
  const num = (v, fallback) => (Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback);
  let ss = num(s, 1);
  let pp = num(p, 1);
  if (!Number.isFinite(s) || s <= 0) notes.push(`Series count "${s}" is not a positive number — using ${ss}.`);
  if (!Number.isFinite(p) || p <= 0) notes.push(`Parallel count "${p}" is not a positive number — using ${pp}.`);
  if (ss > MAX_SERIES) { notes.push(`${ss} cells in series is beyond anything this tool models — capped at ${MAX_SERIES}.`); ss = MAX_SERIES; }
  if (pp > MAX_PARALLEL) { notes.push(`${pp} cells in parallel is beyond anything this tool models — capped at ${MAX_PARALLEL}.`); pp = MAX_PARALLEL; }
  if (ss * pp > MAX_CELLS) {
    // Keep the series count — it sets the voltage, which is usually the
    // deliberate choice — and reduce the parallel count to fit.
    const fitted = Math.max(1, Math.floor(MAX_CELLS / ss));
    notes.push(`${(ss * pp).toLocaleString()} cells is past the ${MAX_CELLS.toLocaleString()}-cell limit this tool computes as one pack; parallel count reduced to ${fitted}. For a system this large, model one pack and use the stacks-and-racks view for the rest.`);
    pp = fitted;
  }
  return { s: ss, p: pp, notes };
}

/**
 * Bound a simulation before it starts. Returns the number of passes that
 * actually fit, and says what it dropped.
 */
export function clampSteps({ profileLength, passes = 1, subSteps = 1 }) {
  const notes = [];
  const len = Number.isFinite(profileLength) && profileLength > 0 ? profileLength : 0;
  let n = Number.isFinite(passes) && passes > 0 ? Math.floor(passes) : 1;
  const per = Math.max(1, len * Math.max(1, subSteps));
  const maxPasses = Math.max(1, Math.floor(MAX_SIM_STEPS / per));
  if (n > maxPasses) {
    notes.push(`${n.toLocaleString()} passes would be ${(n * per).toLocaleString()} integration steps — more than this tool will run in one go (${MAX_SIM_STEPS.toLocaleString()}). Reduced to ${maxPasses.toLocaleString()}. For a longer study, use the desktop runner, which can take the time.`);
    n = maxPasses;
  }
  return { passes: n, steps: n * per, notes };
}

/**
 * Run something that might fail, and never let it take the caller down.
 *
 * Returns { ok, value, error }. The point is not to hide the failure — the
 * error text is returned so it can be SHOWN — but to keep one broken
 * calculation from stopping every other panel on the screen.
 */
export function attempt(label, fn, fallback = null) {
  try {
    return { ok: true, value: fn(), error: null, label };
  } catch (e) {
    return { ok: false, value: fallback, error: e?.message || String(e), label };
  }
}

/**
 * The same idea for rendering: if a panel throws while drawing, that panel
 * shows why and the rest of the application carries on. A stack trace in the
 * console with a blank screen is the worst of both worlds.
 */
export function renderGuard(label, el, fn) {
  try {
    fn();
    return true;
  } catch (e) {
    // Writing the message can itself fail: the element that just broke the
    // render is usually the element we are about to write into. Found by
    // sabotaging a panel in a real browser — the guard caught the render,
    // then threw again from inside its own catch, uncaught. A safety net
    // that can fall over is not a safety net.
    try {
      if (el) {
        el.innerHTML = `<div class="finding warn"><div class="t">`
          + `<span class="chip warn">warn</span> ${escapeHtml(label)} could not be calculated</div>`
          + `<div class="d">${escapeHtml(e?.message || String(e))}</div>`
          + `<div class="r">The rest of the design is unaffected. Change an input to try again, `
          + `or report this if it keeps happening.</div></div>`;
      }
    } catch { /* nowhere safe to write — the console below is the last resort */ }
    // Still tell the console, so a developer sees the stack.
    if (typeof console !== 'undefined') console.error(`[${label}]`, e);
    return false;
  }
}

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
