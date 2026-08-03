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

import { partsBin, compare, tryAll, METRICS } from './garage.js';

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

/**
 * Mount the garage into a pane.
 *
 * `getSpec` returns the design specification as it stands, and `build` turns
 * one into a design. Both are injected so this file never imports the engine
 * directly and cannot end up with a second opinion about anything.
 */
export function mountGarage({ pane, getSpec, build, onFit = null }) {
  if (!pane) return null;
  let currentSpec = null;
  let baseline = null;
  let openPart = null;

  const head = el('div', 'garage-head');
  const shelf = el('div', 'garage-shelf');
  const stage = el('div', 'garage-stage');
  pane.append(head, shelf, stage);

  function renderHead() {
    head.replaceChildren();
    head.append(el('h3', null, 'The garage'));
    const p = el('p', 'muted');
    p.textContent = 'Fit a different part and watch what it does. Every option is priced before you choose it — '
      + 'what it buys, what it costs, and whether it breaks anything. A part that wins on one number and fails the audit is marked, not ranked.';
    head.append(p);
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
      const opt = el('button', `garage-option${broke ? ' is-broken' : ''}`);
      const top = el('div', 'garage-option-top');
      top.append(el('span', 'garage-option-name', r.option.label));
      if (broke) top.append(el('span', 'garage-flag', 'breaks the design'));
      opt.append(top);

      if (r.option.hint) opt.append(el('span', 'garage-option-hint', r.option.hint));

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
    const cur = Number(currentSpec?.[part.id] ?? part.min ?? 0);
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
        const after = build({ ...currentSpec, [part.id]: Number(input.value) });
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
    return baseline?.vehicle?.drive?.whPerKm > 0 ? 'rangeKm' : 'energyWh';
  }

  function fit(part, value, evaluated = null) {
    const next = { ...currentSpec, [part.id]: value };
    let after;
    try { after = build(next); } catch { return; }
    if (!after) return;
    const c = evaluated?.comparison || compare(baseline, after, { label: part.label });
    renderStage(c, part, value);
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
    try { baseline = build(currentSpec); } catch { baseline = null; }
    renderHead();
    if (!baseline) {
      shelf.replaceChildren(el('p', 'muted', 'Choose an application and a cell first — the garage compares against the design you already have.'));
      return;
    }
    renderShelf();
  }

  refresh();
  return { refresh };
}

export { METRICS };
