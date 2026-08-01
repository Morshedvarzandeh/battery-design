// report.js — customer-facing results: economical analysis, CO2 analysis
// with the emissions payback point, and a self-contained report document
// used for both the PDF (print) and Word (.doc) exports. Pure functions.
//
// HONESTY: all CO2 figures are first-order class estimates. Manufacturing
// footprints are literature-class values per kWh of capacity (they vary by
// factory, grid and year); avoided emissions assume the pack's delivered
// energy displaces the selected source one-for-one, with no round-trip
// losses. Good for comparing options — not an audited LCA.

// Manufacturing footprint, kg CO2e per kWh of cell capacity (class values).
export const CO2_MFG_PER_KWH = {
  NMC: 85, NCA: 85, LFP: 60, LTO: 90, LCO: 90, NAION: 45,
};

// What the delivered energy displaces, g CO2e per kWh.
export const GRID_FACTORS = [
  { id: 'world', label: 'World grid average', g: 440 },
  { id: 'us', label: 'US grid average', g: 370 },
  { id: 'eu', label: 'EU grid average', g: 250 },
  { id: 'coal', label: 'Coal generation', g: 950 },
  { id: 'diesel-gen', label: 'Diesel generator', g: 800 },
  { id: 'custom', label: 'Custom…', g: null },
];

// ---------------------------------------------------------------------------
export function co2Model({ cell, energyWh, cyclesPerYear, targetYears, gridGPerKWh, dod = 0.8 }) {
  const capacityKWh = energyWh / 1000;
  const mfgFactor = CO2_MFG_PER_KWH[cell.chemistry] ?? 80;
  const mfgKgPerPack = capacityKWh * mfgFactor;
  const cycleLife = cell.cycleLife ?? null;
  const perCycleKWh = (energyWh * dod) / 1000;
  const g = gridGPerKWh ?? 440;

  const deliveredKWhPerPack = cycleLife != null ? cycleLife * perCycleKWh : null;
  const avoidedKgPerPack = deliveredKWhPerPack != null ? (deliveredKWhPerPack * g) / 1000 : null;
  const netKgPerPack = avoidedKgPerPack != null ? avoidedKgPerPack - mfgKgPerPack : null;

  // The payback POINT: how many cycles until avoided emissions equal the
  // pack's manufacturing footprint.
  const paybackCycles = perCycleKWh > 0 && g > 0 ? mfgKgPerPack / ((perCycleKWh * g) / 1000) : null;
  const paybackYears = paybackCycles != null && cyclesPerYear > 0 ? paybackCycles / cyclesPerYear : null;
  const paybackReached = cycleLife != null && paybackCycles != null ? paybackCycles <= cycleLife : null;

  // Over the application's target period (with replacement packs).
  let packsOverTarget = null, deliveredOverTargetKWh = null, avoidedOverTargetKg = null, netKgOverTarget = null;
  if (cyclesPerYear > 0 && targetYears > 0) {
    const cyclesNeeded = cyclesPerYear * targetYears;
    packsOverTarget = cycleLife != null ? Math.max(1, Math.ceil(cyclesNeeded / cycleLife)) : 1;
    const usableCycles = cycleLife != null ? Math.min(cyclesNeeded, packsOverTarget * cycleLife) : cyclesNeeded;
    deliveredOverTargetKWh = usableCycles * perCycleKWh;
    avoidedOverTargetKg = (deliveredOverTargetKWh * g) / 1000;
    netKgOverTarget = avoidedOverTargetKg - mfgKgPerPack * packsOverTarget;
  }
  return {
    capacityKWh, mfgFactor, mfgKgPerPack, gridGPerKWh: g,
    deliveredKWhPerPack, avoidedKgPerPack, netKgPerPack,
    paybackCycles, paybackYears, paybackReached,
    packsOverTarget, deliveredOverTargetKWh, avoidedOverTargetKg, netKgOverTarget,
  };
}

// ---------------------------------------------------------------------------
// Report document — one HTML string, inline-styled so it survives both the
// print pipeline and Word's HTML importer.
// ---------------------------------------------------------------------------
const f0 = (v) => v == null ? '—' : Math.round(v).toLocaleString('en-US');
const f1 = (v) => v == null ? '—' : (Math.round(v * 10) / 10).toLocaleString('en-US');
const f2 = (v) => v == null ? '—' : (Math.round(v * 100) / 100).toFixed(2);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (ch) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));

export function buildReportHTML(R) {
  const td = 'padding:5px 10px;border-bottom:1px solid #ddd;font-size:12px';
  const th = td + ';text-align:left;color:#666;font-weight:normal;width:46%';
  const h2 = 'font-size:15px;margin:22px 0 6px;color:#0b4a40';
  const row = (k, v) => `<tr><td style="${th}">${esc(k)}</td><td style="${td}"><b>${v}</b></td></tr>`;
  const table = (rows) => `<table style="border-collapse:collapse;width:100%">${rows.join('')}</table>`;
  const S = R.summary, C = R.cost, E = R.co2;

  const findingCounts = ['fail', 'warn', 'pass', 'info']
    .map((sev) => `${R.findings.filter((f) => f.severity === sev).length} ${sev}`).join(' · ');

  return `
<div style="font-family:Segoe UI,Helvetica,Arial,sans-serif;color:#1a1a1a;max-width:720px">
  <h1 style="font-size:21px;margin:0 0 2px">Battery pack design report</h1>
  <div style="color:#666;font-size:12px;margin-bottom:18px">
    ${esc(R.date)} · battery-design (morshedvarzandeh.github.io/battery-design) ·
    application: ${esc(R.application)}</div>

  <h2 style="${h2}">How this design was produced</h2>
  <ol style="font-size:12px;margin:4px 0 0 18px;padding:0;line-height:1.7">
    <li><b>Application &amp; duty</b> — the customer's use case sets the voltage window, power,
      duty (cycles/year) and service-life target.</li>
    <li><b>Space &amp; boundaries</b> — the available bay (box, round, L-shape, stepped or drawn
      outline) is fixed; walls, spacer gaps, busbar headroom, cooling-system space and an
      integration allowance (validated against production EV packs) are reserved.</li>
    <li><b>Scenario generation</b> — every library cell is packed to its maximum in that space
      and the best series×parallel split inside the voltage window is selected.</li>
    <li><b>Multi-objective selection</b> — scenarios are scored on energy-in-space, cost
      (lifetime TCO or upfront) and weight with customer-set priorities; Pareto-optimal
      trade-offs are flagged and the choice is stress-tested for sensitivity and robustness.</li>
    <li><b>Engineering verification</b> — the chosen design is audited from the mechanical,
      thermal, electrical and safety perspectives against public standards.</li>
    <li><b>Documentation</b> — this report: economics, CO2, sensitivity, patent landscape,
      components and audit findings.</li>
  </ol>

  <h2 style="${h2}">Pack</h2>
  ${table([
    row('Cell', esc(R.cell.name) + ` (${esc(R.cell.chemistry)}, ${esc(R.cell.form)})`),
    row('Configuration', `${S.s}S${S.p}P · ${S.cellCount} cells`),
    row('Nominal voltage / range', `${f1(S.nominalV)} V (${f1(S.vMin)}–${f1(S.vMax)} V)`),
    row('Capacity / energy', `${f1(S.capacityAh)} Ah · ${S.energyWh >= 5000 ? f1(S.energyWh / 1000) + ' kWh' : f0(S.energyWh) + ' Wh'}`),
    row('Max continuous discharge / power', `${f0(S.maxContCurrentA)} A · ${f0(S.maxContPowerW)} W`),
    row('Outer dimensions', S.dims ? `${f0(S.dims.x)} × ${f0(S.dims.y)} × ${f0(S.dims.z)} mm (${R.bayLabel})` : '—'),
    row('Mass (with components)', `${f1(R.massWithComponentsKg ?? S.massKg)} kg`),
    row('Energy density', `${f0(S.whPerKg)} Wh/kg · ${f0(S.whPerL)} Wh/L`),
  ])}

  <h2 style="${h2}">Economical analysis (cells, class-estimate prices)</h2>
  ${table([
    row('Upfront cost', C.upfrontUSD != null ? `$${f0(C.upfrontUSD)} · ${f0(C.usdPerKWhCap)} $/kWh capacity` : 'no price data'),
    row('Lifetime energy throughput', C.throughputKWh != null ? `${f0(C.throughputKWh)} kWh (${f0(R.cell.cycleLife)} cycles at 80% DoD)` : 'no cycle-life rating'),
    row('Cost per kWh delivered', C.usdPerKWhDelivered != null ? `$${f2(C.usdPerKWhDelivered)}` : '—'),
    row('Service life at duty', C.serviceYears != null ? `~${f1(C.serviceYears)} years (${f0(R.usage.cyclesPerYear)} cycles/year)` : '—'),
    row(`Total cost of ownership (${f0(R.usage.targetYears)} y)`,
      C.tcoUSD != null ? `$${f0(C.tcoUSD)}${C.replacements > 1 ? ` — ${C.replacements} packs` : ''}` : '—'),
    row('Cost per year', C.tcoUSD != null && R.usage.targetYears > 0 ? `$${f0(C.tcoUSD / R.usage.targetYears)}` : '—'),
  ])}

  <h2 style="${h2}">CO2 analysis (first-order class estimates)</h2>
  ${table([
    row('Manufacturing footprint', `${f0(E.mfgKgPerPack)} kg CO2e (${f0(E.mfgFactor)} kg/kWh, ${esc(R.cell.chemistry)}-class)`),
    row('Displaced source', `${esc(R.gridLabel)} — ${f0(E.gridGPerKWh)} g CO2e/kWh`),
    row('CO2 payback point', E.paybackCycles != null
      ? `${f0(E.paybackCycles)} cycles${E.paybackYears != null ? ` ≈ ${f1(E.paybackYears)} years` : ''}${E.paybackReached === false ? ' — NOT reached within rated cycle life' : ''}`
      : '—'),
    row('Avoided per pack life', E.avoidedKgPerPack != null ? `${f0(E.avoidedKgPerPack)} kg CO2e (${f0(E.deliveredKWhPerPack)} kWh delivered)` : '—'),
    row(`Net CO2 over ${f0(R.usage.targetYears)} years`, E.netKgOverTarget != null
      ? `${E.netKgOverTarget >= 0 ? '−' : '+'}${f0(Math.abs(E.netKgOverTarget))} kg CO2e ${E.netKgOverTarget >= 0 ? 'avoided (net reduction)' : 'EMITTED (footprint exceeds avoided)'}${E.packsOverTarget > 1 ? ` · ${E.packsOverTarget} packs` : ''}`
      : '—'),
  ])}

  ${R.sensitivity?.rows?.length ? `
  <h2 style="${h2}">Cost sensitivity — if a battery parameter changes ±${f0(R.sensitivity.deltaPct)}%</h2>
  <table style="border-collapse:collapse;width:100%">
    <tr>
      <td style="${th}">Parameter</td>
      <td style="${td};color:#666">−${f0(R.sensitivity.deltaPct)}%</td>
      <td style="${td};color:#666">base</td>
      <td style="${td};color:#666">+${f0(R.sensitivity.deltaPct)}%</td>
      <td style="${td};color:#666">max swing</td>
    </tr>
    ${R.sensitivity.rows.map((r) => {
      const fm = (v) => R.sensitivity.basis === 'perKWh' ? `$${f2(v / 1000)}/kWh` : `$${f0(v)}`;
      const repl = (n) => n != null && n !== R.sensitivity.baseReplacements ? ` <span style="color:#b4441f">(${n} packs)</span>` : '';
      return `<tr><td style="${th}">${esc(r.label)}</td>
        <td style="${td}">${fm(r.lo)}${repl(r.loReplacements)}</td>
        <td style="${td}"><b>${fm(r.base)}</b></td>
        <td style="${td}">${fm(r.hi)}${repl(r.hiReplacements)}</td>
        <td style="${td}"><b>${fm(r.swing)}</b></td></tr>`;
    }).join('')}
  </table>
  <div style="font-size:11px;color:#666;margin-top:4px">Basis: ${R.sensitivity.basis === 'tco'
    ? 'total cost of ownership over the target years (replacement-pack jumps highlighted)'
    : R.sensitivity.basis === 'perKWh' ? 'cost per kWh delivered' : 'upfront cost'} — one parameter varied at a time.</div>
  ${R.robustness ? `<div style="font-size:12px;margin-top:8px"><b>Decision robustness:</b> ${
    R.robustness.alreadyCheaper
      ? `the runner-up (${esc(R.robustness.runnerUp)}) is already equal or cheaper on this basis — the ranking is driven by the other objectives.`
      : `the chosen battery stays the cheaper option until its cost rises by more than <b>${f1(R.robustness.pct)}%</b>; beyond that, ${esc(R.robustness.runnerUp)} wins.`
  }</div>` : ''}` : ''}

  ${R.patents?.length ? `
  <h2 style="${h2}">Patent &amp; technology landscape for this design</h2>
  ${table(R.patents.map((p) => row(
    `${esc(p.holder)} · ${esc(p.era)}`,
    `${esc(p.title)} <span style="font-weight:normal">(${esc(p.example)}) — ${esc(p.designNote)}</span>
     <span style="font-weight:normal">${p.links.map((u, i) =>
      `<a href="${esc(u)}">${i === 0 ? 'Google Patents' : 'new this year'}</a>`).join(' · ')}</span>`)))}
  <div style="font-size:11px;color:#666;margin-top:4px">${esc(R.patentsDisclaimer || '')}</div>` : ''}

  <h2 style="${h2}">Selected components</h2>
  ${table(Object.entries(R.selection).filter(([, v]) => v).map(([k, v]) =>
    row(k[0].toUpperCase() + k.slice(1), `${esc(v.name)}${v.suppliers?.length ? ` <span style="color:#666">(e.g. ${esc(v.suppliers.join(', '))})</span>` : ''}`)))}

  <h2 style="${h2}">Engineering & standards audit</h2>
  <div style="font-size:12px;margin-bottom:6px">${findingCounts}</div>
  ${table(R.findings.filter((f) => f.severity === 'fail' || f.severity === 'warn').slice(0, 12).map((f) =>
    row(f.severity.toUpperCase(), `${esc(f.title)} — <span style="font-weight:normal">${esc(f.detail)}</span>`)))}

  <p style="font-size:10.5px;color:#666;margin-top:22px;border-top:1px solid #ddd;padding-top:8px">
    ${esc(R.disclaimer)} CO2 figures are literature-class estimates (manufacturing per kWh of
    capacity; displacement at the selected source factor with no round-trip losses) — for
    comparing design options, not an audited life-cycle assessment.</p>
</div>`;
}

// Wraps the report HTML so Microsoft Word opens it as a document.
export function buildWordDocument(reportHTML, title) {
  return `<html xmlns:o="urn:schemas-microsoft-com:office:office"
      xmlns:w="urn:schemas-microsoft-com:office:word"
      xmlns="http://www.w3.org/TR/REC-html40">
    <head><meta charset="utf-8"><title>${esc(title)}</title>
    <!--[if gte mso 9]><xml><w:WordDocument><w:View>Print</w:View></w:WordDocument></xml><![endif]-->
    </head><body>${reportHTML}</body></html>`;
}
