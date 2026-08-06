// garage-ui.js — the garage, on screen.
//
// The engine in garage.js already answers the question. This is the part that
// makes it feel like standing in front of the machine rather than reading a
// report about it: pick a part off the shelf, and the numbers move while you
// watch.
//
// Three rules, and they are what keep it from becoming a toy:
//
//   THE DELTA IS THE INTERFACE. Not the new value — the CHANGE. "+41 km" is
//   something a person feels; "410 km" is something they have to remember the
//   old number to interpret.
//
//   A BROKEN OPTION LOOKS BROKEN BEFORE YOU FIT IT. Every option on the shelf
//   is pre-evaluated, so the one that gains the most range and fails the
//   safety audit is marked as such in the list, not after you have chosen it
//   and started believing in it.
//
//   NOTHING IS HIDDEN BEHIND A GOOD NUMBER. Where a swap costs something, the
//   cost is shown beside the gain in the same size type. A configurator shows
//   you the gain and puts the cost in a footnote.
//
// It owns one pane and reads the design engine through one function, so it
// cannot drift from what the rest of the tool says.

import {
  partsBin, applySwap, partValue, compare, tryAll, METRICS,
} from './garage.js';
import { TWINSHIP_REFERENCE, twinReadiness } from './marine-workspace.js';
import { defaultVesselModel, vesselModelById } from './vessels.js';

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

const fmt = (v, unit) => {
  if (v == null) return '—';
  const abs = Math.abs(v);
  if (unit === 'USD') return `$${Math.round(v).toLocaleString()}`;
  if (abs >= 1000) return Math.round(v).toLocaleString();
  if (abs >= 10) return v.toFixed(0);
  return v.toFixed(abs < 1 ? 2 : 1);
};

const signed = (v, unit) => (v > 0 ? `+${fmt(v, unit)}` : fmt(v, unit));

// Public copy contract so the marine surface cannot accidentally inherit the
// automotive product name. CSS and internal function names remain stable for
// compatibility; every customer-visible marine string says Vessel Twin.
export function workspaceCopy(applicationId) {
  if (applicationId === 'marine') return {
    title: 'Vessel Twin',
    intro: 'Select an NTNU vessel, change the voyage or PMS operating goal, and watch the same governed battery design respond. Published vessel facts and provisional inputs stay separate, and a screening result is never presented as a validated live twin.',
    empty: 'Choose the marine application and a cell first — Vessel Twin compares against the current governed vessel design.',
  };
  return {
    title: 'The garage',
    intro: 'Fit a different part and watch what it does. Every option is priced before you choose it — what it buys, what it costs, and whether it breaks anything. A part that wins on one number and fails the audit is marked, not ranked.',
    empty: 'Choose an application and a cell first — the garage compares against the design you already have.',
  };
}

/**
 * Mount the garage into a pane.
 *
 * `getSpec` returns the design specification as it stands, and `build` turns
 * one into a design. Both are injected so this file never imports the engine
 * directly and cannot end up with a second opinion about anything.
 */
export function mountGarage({ pane, getSpec, build, onFit = null, onDesign = null }) {
  if (!pane) return null;
  let currentSpec = null;
  let baseline = null;
  let openPart = null;
  let shownApplication = null;

  const head = el('div', 'garage-head');
  // Where the machine itself is shown. It is a hole in this module rather
  // than something it draws: the renderer is a separate engine and this file
  // must not acquire an opinion about 3D, or about whether there is any.
  const floor = el('div', 'garage-floor');
  const shelf = el('div', 'garage-shelf');
  const stage = el('div', 'garage-stage');
  pane.append(head, floor, shelf, stage);

  function renderHead() {
    head.replaceChildren();
    const copy = workspaceCopy(currentSpec?.application);
    head.append(el('h3', null, copy.title));
    head.append(el('p', 'muted', copy.intro));
    if (currentSpec?.application === 'marine') {
      const vessel = vesselModelById(currentSpec.marine?.vesselId ?? currentSpec.vesselId)
        || defaultVesselModel();
      const particulars = el('p', 'muted', `${vessel.name} · ${vessel.dimensionsM.length} m long × ${vessel.dimensionsM.beam} m beam × ${vessel.dimensionsM.height} m overall visual height. ${vessel.boundary}`);
      head.append(particulars);
      const vesselSource = el('a', null, `Published particulars — ${vessel.evidence.title}`);
      vesselSource.href = vessel.evidence.url;
      vesselSource.target = '_blank';
      vesselSource.rel = 'noreferrer';
      head.append(vesselSource, document.createTextNode(' · '));
      const nestedEvidence = currentSpec.marine?.twinEvidence;
      const topLevelTwin = currentSpec.twinShip;
      const evidence = nestedEvidence && typeof nestedEvidence === 'object'
        ? nestedEvidence
        : (topLevelTwin?.readiness || topLevelTwin?.evidence || {});
      const readiness = twinReadiness({
        ...evidence,
        vesselId: currentSpec.marine?.vesselId ?? currentSpec.vesselId,
      });
      head.append(el('p', 'muted', `${readiness.label} — ${readiness.statement}`));
      const source = el('a', null, 'NTNU TwinShip architecture and evidence basis');
      source.href = TWINSHIP_REFERENCE.projectUrl;
      source.target = '_blank';
      source.rel = 'noreferrer';
      head.append(source);
    }
  }

  // The shelf: one row per fittable part, expanded to show its options with
  // the effect of each already computed.
  function renderShelf() {
    shelf.replaceChildren();
    const bin = partsBin(currentSpec?.application);
    for (const part of bin) {
      const row = el('div', 'garage-part');
      const btn = el('button', 'garage-part-head');
      btn.append(el('span', 'garage-part-name', part.label));
      btn.append(el('span', 'garage-part-count',
        part.kind === 'choice' ? `${part.options.length} to try` : 'adjust'));
      btn.onclick = () => { openPart = openPart === part.id ? null : part.id; renderShelf(); };
      row.append(btn);

      if (openPart === part.id) {
        const why = el('p', 'garage-why', part.what);
        row.append(why);
        if (part.kind === 'choice') row.append(renderOptions(part));
        else row.append(renderNumber(part));
      }
      shelf.append(row);
    }
  }

  // Every option evaluated before it is offered. This is the expensive call
  // and it is worth it: a complete design is milliseconds, and the whole
  // point is that the customer sees the consequence before committing.
  function renderOptions(part) {
    const list = el('div', 'garage-options');
    let wall;
    try {
      wall = tryAll({ spec: currentSpec, part: part.id, options: part.options, build, rankBy: rankFor(part) });
    } catch {
      list.append(el('p', 'muted', 'This part could not be evaluated on the current design.'));
      return list;
    }
    if (!wall) return list;

    for (const r of [...wall.safe, ...wall.broken]) {
      const broke = r.comparison?.verdict === 'broke-something';
      // A part the engine would not fit — wrong cell format, out of scale —
      // must never render as "no measurable change". That reads as "this part
      // makes no difference" when the truth is "this part was never fitted",
      // and it is the same inertness the shelf exists to expose.
      const refused = !broke && (r.comparison?.notFitted?.length > 0);
      const clears = !broke && !refused && (r.comparison?.findings?.fixedIt?.length > 0);
      const opt = el('button', `garage-option${broke ? ' is-broken' : ''}`
        + `${refused ? ' is-refused' : ''}${clears ? ' has-fix' : ''}`);
      const top = el('div', 'garage-option-top');
      top.append(el('span', 'garage-option-name', r.option.label));
      if (broke) top.append(el('span', 'garage-flag', 'breaks the design'));
      if (refused) top.append(el('span', 'garage-flag garage-flag-refused', 'does not fit this pack'));
      // Ranking is by the chosen metric, so the option that clears a safety
      // failure can sit at the BOTTOM of the shelf — it usually costs mass.
      // Flagging it is what stops the shelf from quietly recommending the
      // cheapest thing on a design that is failing its thermal audit.
      const fixes = !broke && !refused ? (r.comparison?.findings?.fixedIt?.length || 0) : 0;
      if (fixes) {
        top.append(el('span', 'garage-flag garage-flag-fixes',
          fixes === 1 ? 'clears a failure' : `clears ${fixes} failures`));
      }
      opt.append(top);

      if (r.option.hint) opt.append(el('span', 'garage-option-hint', r.option.hint));

      if (refused) {
        opt.append(el('p', 'garage-refused', r.comparison.notFitted[0]));
        opt.onclick = () => fit(part, r.option.value, r);
        list.append(opt);
        continue;
      }

      // The deltas, gains and costs side by side and in the same size type.
      const deltas = el('div', 'garage-deltas');
      const shown = (r.comparison?.changes || []).slice(0, 4);
      if (!shown.length) deltas.append(el('span', 'muted', 'no measurable change'));
      for (const c of shown) {
        const d = el('span', `garage-delta ${c.improved === true ? 'up' : c.improved === false ? 'down' : ''}`);
        d.textContent = `${c.label} ${signed(c.delta, c.unit)} ${c.unit}`;
        deltas.append(d);
      }
      opt.append(deltas);

      if (broke) {
        const b = el('p', 'garage-broke');
        b.textContent = r.comparison.findings.brokeIt.map((f) => f.title).join(' · ');
        opt.append(b);
      }
      opt.onclick = () => fit(part, r.option.value, r);
      list.append(opt);
    }
    return list;
  }

  function renderNumber(part) {
    const box = el('div', 'garage-number');
    const cur = Number(partValue(currentSpec, part) ?? part.min ?? 0);
    const input = el('input');
    input.type = 'range';
    input.min = part.min; input.max = part.max; input.step = part.step;
    input.value = Number.isFinite(cur) && cur >= part.min ? cur : part.min;
    const read = el('span', 'garage-number-read', `${input.value}${part.unit ? ` ${part.unit}` : ''}`);
    const preview = el('div', 'garage-deltas');

    const evaluate = () => {
      read.textContent = `${input.value}${part.unit ? ` ${part.unit}` : ''}`;
      preview.replaceChildren();
      try {
        const after = build(applySwap(currentSpec, { part: part.id, value: Number(input.value) }));
        const c = compare(baseline, after, { label: part.label });
        if (!c?.changes.length) { preview.append(el('span', 'muted', 'no measurable change')); return; }
        if (c.findings.brokeIt.length) {
          const f = el('span', 'garage-flag', `breaks: ${c.findings.brokeIt[0].title}`);
          preview.append(f);
        }
        for (const ch of c.changes.slice(0, 4)) {
          const d = el('span', `garage-delta ${ch.improved === true ? 'up' : ch.improved === false ? 'down' : ''}`);
          d.textContent = `${ch.label} ${signed(ch.delta, ch.unit)} ${ch.unit}`;
          preview.append(d);
        }
      } catch {
        preview.append(el('span', 'muted', 'not buildable at this value'));
      }
    };
    input.oninput = evaluate;
    const fitBtn = el('button', 'garage-fit', 'Fit this');
    fitBtn.onclick = () => fit(part, Number(input.value));
    box.append(read, input, preview, fitBtn);
    evaluate();
    return box;
  }

  // What to rank a shelf by: range where the machine travels, energy where it
  // does not. Ranking a wearable by range would sort every option to null.
  function rankFor() {
    if (currentSpec?.application === 'marine') return 'missionUnmetWh';
    return baseline?.vehicle?.drive?.whPerKm > 0 ? 'rangeKm' : 'energyWh';
  }

  function fit(part, value, evaluated = null) {
    const next = applySwap(currentSpec, { part: part.id, value });
    let after;
    try { after = build(next); } catch { return; }
    if (!after) return;
    const c = evaluated?.comparison || compare(baseline, after, { label: part.label });
    renderStage(c, part, evaluated?.option?.label || value);
    // The machine on the floor is the machine that was just changed. A
    // showroom still showing the pack from before the swap is the same lie as
    // a shelf whose options do nothing.
    if (onDesign) onDesign(after);
    if (onFit) onFit(next, after, c);
  }

  function renderStage(c, part, value) {
    stage.replaceChildren();
    if (!c) return;
    const box = el('div', `garage-result${c.verdict === 'broke-something' ? ' is-broken' : ''}`);
    box.append(el('h4', null, `${part.label}: ${value}`));
    box.append(el('p', 'garage-headline', c.headline));

    if (c.findings.brokeIt.length) {
      const ul = el('ul', 'garage-broke-list');
      for (const f of c.findings.brokeIt) {
        const li = el('li');
        li.append(el('strong', null, f.title));
        li.append(el('span', null, ` — ${f.detail}`));
        ul.append(li);
      }
      box.append(el('h5', null, 'What it broke'), ul);
    }
    if (c.findings.fixedIt.length) {
      box.append(el('h5', null, 'What it fixed'),
        el('p', 'muted', c.findings.fixedIt.map((f) => f.title).join(' · ')));
    }
    // Neither broken nor fixed: already failing, and the numbers moved. This
    // is the one a configurator hides, because the check reads "fail" on both
    // sides and nets out to nothing.
    if (c.findings.stillFailing?.length) {
      const ul = el('ul', 'garage-broke-list');
      for (const f of c.findings.stillFailing) {
        const li = el('li');
        li.append(el('strong', null, f.title));
        li.append(el('span', null, ` — was: ${f.was}`));
        li.append(el('span', null, ` Now: ${f.detail}`));
        ul.append(li);
      }
      box.append(el('h5', null, 'Already failing, and it moved'), ul);
    }

    const table = el('table', 'garage-table');
    const hdr = el('tr');
    for (const h of ['', 'before', 'after', 'change']) hdr.append(el('th', null, h));
    table.append(hdr);
    for (const ch of c.changes) {
      const tr = el('tr', ch.improved === true ? 'up' : ch.improved === false ? 'down' : '');
      tr.append(el('td', null, ch.label));
      tr.append(el('td', null, `${fmt(ch.before, ch.unit)}`));
      tr.append(el('td', null, `${fmt(ch.after, ch.unit)}`));
      tr.append(el('td', null, `${signed(ch.delta, ch.unit)} ${ch.unit}`));
      table.append(tr);
    }
    box.append(table);
    if (c.caveat) box.append(el('p', 'muted', c.caveat));
    stage.append(box);
  }

  function refresh() {
    currentSpec = getSpec();
    if (currentSpec?.application !== shownApplication) {
      shownApplication = currentSpec?.application ?? null;
      // Both requested vessel models are visible on first entry. The person
      // can collapse the shelf afterwards; subsequent design refreshes keep
      // that choice instead of forcing it open again.
      openPart = shownApplication === 'marine' ? 'marine:vesselId' : null;
    }
    try { baseline = build(currentSpec); } catch { baseline = null; }
    renderHead();
    if (!baseline) {
      shelf.replaceChildren(el('p', 'muted', workspaceCopy(currentSpec?.application).empty));
      return;
    }
    renderShelf();
    if (onDesign) onDesign(baseline);
  }

  refresh();
  return { refresh, floor };
}

export { METRICS };
