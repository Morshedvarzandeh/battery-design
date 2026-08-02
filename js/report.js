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

  ${R.architecture ? (() => {
    const A = R.architecture, P = A.partition, B = A.bms, PR = A.precharge, K = A.contactors, RES = A.resistance;
    return `
  <h2 style="${h2}">Electrical architecture</h2>
  ${R.archPng ? `<img src="${R.archPng}" style="width:100%;max-width:640px;border:1px solid #ddd" alt="architecture diagram">` : ''}
  ${R.bmsPng ? `<div style="font-size:11px;color:#666;margin:6px 0 2px">Inside the BMS — layer 2 (master internals + slave AFE ICs)</div>
  <img src="${R.bmsPng}" style="width:100%;max-width:640px;border:1px solid #ddd" alt="BMS internal diagram">` : ''}
  ${table([
    row('Structure', P.virtual
      ? 'cell-to-pack — one virtual group, no physical module tier'
      : `${P.nModules} modules of ${P.sMod}S${P.pMod}P — ${f1(P.moduleVoltageMaxV)} V max, ${f1(P.moduleEnergyWh / 1000)} kWh, ${f1(P.moduleMassCellsKg)} kg cells per module`),
    ...(A.system && (A.system.racks > 1 || A.system.overridden) ? [row('System scale', A.system.overridden
      ? `<b>${A.system.racks} stacks set by the customer</b> — ${f1(A.system.totalWh / 1000)} kWh total${A.system.targetWh ? ` (${f0(A.system.coveragePct)}% of the ${f1(A.system.targetWh / 1000)} kWh target)` : ''}; this report models ONE stack, each with its own contactors, fuse and BMS string`
      : `the ${f1(A.system.targetWh / 1000)} kWh target needs <b>${A.system.racks} packs (racks)</b> of this design in parallel strings — this report models ONE pack; each rack keeps its own contactors, fuse and BMS string`)] : []),
    row('Voltage class', `${esc(A.voltageClass.label)} — <span style="font-weight:normal">${esc(A.voltageClass.note)}</span>`),
    row('BMS', `${esc(B.topologyInfo?.name || B.topology)} · ${B.afeTotal}× AFE IC (${B.channelsPerIc} ch) · ${B.senseWiresTotal} sense wires · ${B.tempSensors} temperature sensors (1 per ${B.cellsPerTempSensor} cells)`),
    ...(R.archAssess?.topo ? [row('Topology assessment', `<b>${esc(R.archAssess.topo.verdict)}</b> — <span style="font-weight:normal">${esc(R.archAssess.topo.why)} Pros: ${R.archAssess.topo.pros.map(esc).join('; ')}. Cons: ${R.archAssess.topo.cons.map(esc).join('; ')}.</span>`)] : []),
    ...(A.comms ? [row('Communication', `${esc(A.comms.primary)}${A.comms.alternates?.length ? ` — <span style="font-weight:normal">alternates: ${esc(A.comms.alternates.join('; '))}</span>` : ''}<br><span style="font-weight:normal">${esc(A.comms.note)}</span>`)] : []),
    ...(A.welding ? [row('Cell joining / welding', `${esc(A.welding.primary)} — <span style="font-weight:normal">alternates: ${esc(A.welding.alternates.join('; '))}. ${esc(A.welding.cautions.join(' '))} (Joining review: Lee, Kim, Hu, Cai &amp; Abell, ASME MSEC2010-34168.)</span>`)] : []),
    ...(A.supervisor ? [row('Supervisory layer', `${esc(A.supervisor.name)} — <span style="font-weight:normal">${esc(A.supervisor.role)} The control hierarchy is cell → module (slave AFE) → BMS master → supervisor.${A.supervisor.detail ? `<br>Functions: ${A.supervisor.detail.functions.map(esc).join('; ')}.<br>Interfaces: ${A.supervisor.detail.interfaces.map(esc).join('; ')}.` : ''}</span>`)] : []),
    ...(A.emsArch ? [row('EMS architecture', `${esc(A.emsArch.chosen.name)} — <span style="font-weight:normal">${esc(A.emsArch.chosen.when)} Pros: ${(A.emsArch.chosen.pros || []).map(esc).join('; ')}. Cons: ${(A.emsArch.chosen.cons || []).map(esc).join('; ')}. ${esc(A.emsArch.note)}</span>`)] : []),
    ...(PR ? [
      row('Precharge', `${f1(PR.rOhm)} Ω resistor · DC link within ${PR.closeGapV} V in ${PR.timeToCloseS} s (τ = ${f2(PR.tauS)} s) · ${f0(PR.energyPerEventJ)} J and ${f1(PR.avgPowerDuringEventW)} W average per event · sized for ${PR.prechargesPerHour}/h`),
      row('Switching sequence', PR.sequence.map((x, i) => `${i + 1}. ${esc(x)}`).join('<br>')),
    ] : []),
    row('Contactors', `2 mains + 1 precharge · rated ≥${f0(K.ratingA)} A continuous · ~${f0(K.massEachG)} g each (mass fit is weak — budgeting only)`),
    row('Fuse', `≈${f0(K.fuse.ratingA)} A (2× continuous) · <span style="font-weight:normal">${esc(K.fuse.rules[1])} ${esc(K.fuse.rules[2])}</span>`),
    row('Isolation', A.isolation
      ? `≥${f0(A.isolation.floorKOhm)} kΩ floor at ${A.isolation.ohmsPerVolt} Ω/V per ${esc(A.isolation.standardLabel)} — <span style="font-weight:normal">${esc(A.isolation.oemPracticeNote)}</span>`
      : 'not required — the pack stays at or below the 60 V DC boundary'),
    row('DC-DC converter', `${f1(A.dcdc.inputRangeV[0])}–${f1(A.dcdc.inputRangeV[1])} V input → ${A.dcdc.lvBusV} V auxiliary bus — <span style="font-weight:normal">${esc(A.dcdc.sizingNote)}</span>`),
    ...(RES.totalMOhm != null ? [row('Pack resistance', `~${f1(RES.totalMOhm)} mΩ (cells ${f1(RES.cellsMOhm)} mΩ + interconnect ${f0(RES.interconnectMOhm)} mΩ) · ~${f1(RES.droopVAtCont)} V droop, ~${f0(RES.lossWAtCont)} W loss at max continuous`)] : []),
  ])}
  <div style="font-size:11px;color:#666;margin-top:4px">${[...(P.notes || []), ...(B.notes || []), A.dcdc.chargingNote, K.lvNote, A.isolation?.groundingNote].filter(Boolean).map(esc).join(' ')}</div>`;
  })() : ''}

  ${R.thermal ? `
  <h2 style="${h2}">Thermal management system</h2>
  ${R.thermPng ? `<img src="${R.thermPng}" style="width:100%;max-width:640px;border:1px solid #ddd" alt="thermal loop diagram">` : ''}
  ${table([
    row('Loop', `${esc(R.thermal.loop.name)} — <span style="font-weight:normal">${esc(R.thermal.loop.when)}</span>`),
    ...(R.thermal.assessment ? [row('Loop assessment', `<b>${esc(R.thermal.assessment.verdict)}</b> — <span style="font-weight:normal">${esc(R.thermal.assessment.why)} Pros: ${(R.thermal.loop.pros || []).map(esc).join('; ')}. Cons: ${(R.thermal.loop.cons || []).map(esc).join('; ')}.</span>`)] : []),
    row('Heat to move', `~${f1(R.thermal.heatContW)} W at continuous load · design ambient ${R.thermal.ambientC[0]}…${R.thermal.ambientC[1]} °C`),
    ...(R.thermal.flowLpm != null ? [row('Coolant flow (first-order)', `~${f1(R.thermal.flowLpm)} L/min at ΔT ${R.thermal.coolant.dTdesignK} K, 50/50 water-glycol (ṁ = Q/(c_p·ΔT))`)] : []),
    ...(R.thermal.chillerKW != null ? [row('Chiller / higher system', `~${f1(R.thermal.chillerKW)} kW battery-side duty → ~${f1(R.thermal.compressorKW)} kW compressor load on the vehicle AC / plant HVAC (COP ~${R.thermal.chillerCOP}) — the refrigerant side is OWNED by the higher system`)] : []),
    row('Heater', R.thermal.heaterNeeded
      ? `required — design ambient falls below the ${R.thermal.chargeFloorC} °C charge floor`
      : 'not required in the design climate window'),
    row('Control', R.thermal.control
      ? `${esc(R.thermal.control.name)} — drives ${esc(R.thermal.control.drives.join(', '))}. <span style="font-weight:normal">${esc(R.thermal.control.note)}</span>`
      : 'none — passive system'),
    ...(R.thermal.coolantSide?.length ? [row('Coolant loop', `<span style="font-weight:normal">${R.thermal.coolantSide.map(esc).join('<br>')}</span>`)] : []),
    ...(R.thermal.refrigerantSide?.length ? [row('Refrigerant side (higher system)', `<span style="font-weight:normal">${R.thermal.refrigerantSide.map(esc).join('<br>')}</span>`)] : []),
    ...(R.thermal.airSide?.length ? [row('Air side', `<span style="font-weight:normal">${R.thermal.airSide.map(esc).join('<br>')}</span>`)] : []),
  ])}
  <div style="font-size:11px;color:#666;margin-top:4px">${R.thermal.notes.map(esc).join(' ')}</div>` : ''}

  ${R.sensors?.groups?.length ? `
  <h2 style="${h2}">Sensor plan — by level</h2>
  ${R.sensors.groups.map((gr) => `
    <div style="font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#666;margin:10px 0 2px">${esc(gr.level)}</div>
    ${table(gr.sensors.map((sn) => row(`${sn.count != null ? `${sn.count}× ` : ''}${sn.name}`,
      `<span style="font-weight:normal">${esc(sn.note)}</span>`)))}`).join('')}
  <div style="font-size:11px;color:#666;margin-top:4px">${R.sensors.notes.map(esc).join(' ')}</div>` : ''}

  ${R.loadProfile ? `
  <h2 style="${h2}">Load profile — ${esc(R.loadProfile.name)}</h2>
  <img src="${R.loadProfile.chartPng}" style="width:100%;max-width:640px;border:1px solid #ddd" alt="load profile">
  ${table([
    row('One pass', `${R.loadProfile.stats.durationS >= 3600
      ? f1(R.loadProfile.stats.durationS / 3600) + ' h' : f0(R.loadProfile.stats.durationS) + ' s'} ·
      ${f0(R.loadProfile.stats.energyPerPassWh)} Wh discharged${R.loadProfile.stats.regenWh > 0.5
        ? ` · ${f0(R.loadProfile.stats.regenWh)} Wh regenerated` : ''}`),
    row('Peak / RMS / mean power', `${f0(R.loadProfile.stats.peakW)} / ${f0(R.loadProfile.stats.rmsW)} / ${f0(R.loadProfile.stats.meanW)} W` +
      (R.loadProfile.stats.crestFactor ? ` (crest ${f1(R.loadProfile.stats.crestFactor)}×)` : '')),
  ])}
  ${table(R.loadProfile.findings.map((f) =>
    row(f.severity.toUpperCase(), `${esc(f.title)} — <span style="font-weight:normal">${esc(f.detail)}</span>`)))}
  <div style="font-size:11px;color:#666;margin-top:4px">${esc(R.loadProfile.note)}</div>` : ''}

  <h2 style="${h2}">Economical analysis (cells, class-estimate prices)</h2>
  ${table([
    row('Upfront cost', C.upfrontUSD != null ? `$${f0(C.upfrontUSD)} · ${f0(C.usdPerKWhCap)} $/kWh capacity` : 'no price data'),
    row('Lifetime energy throughput', C.throughputKWh != null ? `${f0(C.throughputKWh)} kWh (${f0(R.cell.cycleLife)} cycles at ${f0((R.usage.dod ?? 0.8) * 100)}% DoD)` : 'no cycle-life rating'),
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

// ---------------------------------------------------------------------------
// The ARCHITECTURE report — a second, standalone document alongside the main
// report: a layered HTML file where the reader SELECTS a layer (system →
// pack → module → cell, plus control / thermal / sensors) and opens exactly
// the level they care about. Self-contained: inline styles, embedded PNGs,
// a few lines of vanilla JS — it works as a downloaded file with no server.
// ---------------------------------------------------------------------------
export function buildArchReportHTML(R) {
  const td = 'padding:5px 10px;border-bottom:1px solid #e2e2e2;font-size:12.5px';
  const th = td + ';text-align:left;color:#667;font-weight:normal;width:40%';
  const row = (k, v) => v == null ? '' : `<tr><td style="${th}">${esc(k)}</td><td style="${td}"><b style="font-weight:600">${v}</b></td></tr>`;
  const table = (rows) => `<table style="border-collapse:collapse;width:100%">${rows.join('')}</table>`;
  const img = (src, alt) => src ? `<img src="${src}" style="width:100%;max-width:660px;border:1px solid #ddd;border-radius:6px;margin:8px 0" alt="${esc(alt)}">` : '';
  const list = (items) => `<ul style="margin:4px 0 4px 18px;padding:0;line-height:1.7">${items.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`;
  const verdictBadge = (a) => a ? `<span style="display:inline-block;padding:1px 8px;border-radius:10px;font-size:11px;background:${a.verdict === 'not-workable' ? '#fbe4e4' : a.verdict === 'workable-with-costs' || a.verdict === 'unproven' ? '#fdf3d7' : '#e0f0ea'};color:${a.verdict === 'not-workable' ? '#b3261e' : a.verdict === 'workable-with-costs' || a.verdict === 'unproven' ? '#8a6d1a' : '#0b6e5f'}">${esc(a.verdict)}</span> ${esc(a.why || '')}` : null;

  const A = R.architecture, S = R.summary, T = R.thermal;
  const P = A?.partition, B = A?.bms;

  const layer = (id, icon, title, sub, body, open = false) => `
  <details class="layer" id="L-${id}"${open ? ' open' : ''}>
    <summary><span class="lic">${icon}</span><b>${esc(title)}</b><span class="lsub">${esc(sub)}</span></summary>
    <div class="lbody">${body}</div>
  </details>`;

  const layers = [];

  // --- Layer: system ---------------------------------------------------------
  if (A) {
    layers.push(layer('system', '🏭', 'System level', 'stacks, supervisor, EMS, communication', [
      table([
        row('Scale', A.system && (A.system.racks > 1 || A.system.overridden)
          ? `${A.system.racks} packs (stacks/racks) in parallel strings · ${f1(A.system.totalWh / 1000)} kWh total — each string keeps its own contactors, fuse and BMS`
          : 'single pack — no stack tier'),
        row('Supervisory unit', A.supervisor ? `${esc(A.supervisor.name)}<br><span style="font-weight:normal">${esc(A.supervisor.role)}</span>` : null),
        A.supervisor?.detail ? row('Supervisor functions', `<span style="font-weight:normal">${A.supervisor.detail.functions.map(esc).join('; ')}</span>`) : '',
        A.supervisor?.detail ? row('Supervisor interfaces', `<span style="font-weight:normal">${A.supervisor.detail.interfaces.map(esc).join('; ')}</span>`) : '',
        row('EMS architecture', A.emsArch ? `${esc(A.emsArch.chosen.name)}${A.emsArch.overridden ? ' (customer override)' : ''}<br><span style="font-weight:normal">${esc(A.emsArch.chosen.when || '')}</span>` : null),
        R.archAssess?.ems ? row('EMS assessment', `<span style="font-weight:normal">${verdictBadge(R.archAssess.ems)}</span>`) : '',
        row('Communication', A.comms ? `${esc(A.comms.primary)}<br><span style="font-weight:normal">${esc(A.comms.note || '')}</span>` : null),
      ]),
    ].join('\n'), true));
  }

  // --- Layer: pack (HV chain) ------------------------------------------------
  if (A && S) {
    const PR = A.precharge, K = A.contactors;
    layers.push(layer('pack', '🔋', 'Pack level', 'HV chain — fuse, contactors, precharge, isolation, DC-DC', [
      img(R.archPng, 'pack electrical architecture'),
      table([
        row('Configuration', `${S.s}S${S.p}P · ${S.cellCount} cells · ${f1(S.nominalV)} V nominal (${f1(S.vMin)}–${f1(S.vMax)} V)`),
        row('Voltage class', A.voltageClass ? `${esc(A.voltageClass.label)} — <span style="font-weight:normal">${esc(A.voltageClass.note)}</span>` : null),
        row('Main fuse', K?.fuse?.ratingA != null ? `${f0(K.fuse.ratingA)} A — <span style="font-weight:normal">${esc(K.fuse.rules[0])}</span>` : null),
        row('Contactors', K ? (PR ? `${K.mains} main + ${K.precharge} precharge · ${f0(K.ratingA)} A class` : `<span style="font-weight:normal">${esc(K.lvNote || 'solid-state disconnect (≤60 V)')}</span>`) : null),
        PR ? row('Precharge', `${f1(PR.rOhm)} Ω · τ = ${f1(PR.tauS)} s · close at ~${f1(PR.timeToCloseS)} s · peak ${f0(PR.peakCurrentA)} A / ${f0(PR.peakPowerW)} W`) : '',
        PR ? row('Precharge sequence', `<span style="font-weight:normal">${PR.sequence.map(esc).join(' → ')}</span>`) : '',
        row('Isolation', A.isolation ? `${f0(A.isolation.ohmsPerVolt)} Ω/V (${esc(A.isolation.standardLabel)}) — floor ${f1(A.isolation.floorKOhm)} kΩ` : null),
        row('DC-DC (LV supply)', A.dcdc ? `${A.dcdc.lvBusV} V bus — <span style="font-weight:normal">${esc(A.dcdc.sizingNote)}</span>` : null),
        row('Pack resistance', A.resistance?.totalMOhm != null ? `${f1(A.resistance.totalMOhm)} mΩ (cells ${f1(A.resistance.cellsMOhm)} + interconnect ${f1(A.resistance.interconnectMOhm)}) · ${f1(A.resistance.droopVAtCont)} V droop at max continuous` : null),
      ]),
    ].join('\n')));
  }

  // --- Layer: module ---------------------------------------------------------
  if (P) {
    layers.push(layer('module', '🧱', 'Module level', P.virtual ? 'cell-to-pack — no physical module tier' : `${P.nModules}× ${P.sMod}S${P.pMod}P`, [
      table([
        row('Partition', P.virtual
          ? 'cell-to-pack: one virtual group — the pack structure carries the cells directly'
          : `${P.nModules} modules of ${P.sMod}S${P.pMod}P · ${f1(P.moduleVoltageMaxV)} V max · ${f1(P.moduleEnergyWh / 1000)} kWh · ${f1(P.moduleMassCellsKg)} kg cells per module`),
        row('Sense wiring', B ? `${B.senseWiresPerModule ?? B.senseWiresTotal} sense wires per ${P.virtual ? 'pack' : 'module'} · ${B.tempSensors} temperature sensors (1 per ${B.cellsPerTempSensor} cells)` : null),
        row('Cell joining', A?.welding ? `${esc(A.welding.primary)}<br><span style="font-weight:normal">Alternates: ${A.welding.alternates.map(esc).join('; ')}</span>` : null),
      ]),
    ].join('\n')));
  }

  // --- Layer: cell -----------------------------------------------------------
  if (R.cell && S) {
    layers.push(layer('cell', '⚗️', 'Cell level', `${R.cell.name}`, [
      table([
        row('Cell', `${esc(R.cell.name)} — ${esc(R.cell.chemistry)}, ${esc(R.cell.form)} ${esc(R.cell.formFactor || '')}`),
        row('Ratings', `${f1(R.cell.nominalV)} V · ${f1(R.cell.capacityAh)} Ah · ${f0(R.cell.massG)} g`),
        row('Energy density (pack)', `${f0(S.whPerKg)} Wh/kg · ${f0(S.whPerL)} Wh/L`),
      ]),
    ].join('\n')));
  }

  // --- Layer: control hierarchy ----------------------------------------------
  if (B) {
    layers.push(layer('control', '🧠', 'Control hierarchy', 'BMS protects · BTMS moves heat · supervisor decides', [
      img(R.bmsPng, 'BMS internals'),
      table([
        row('BMS topology', `${esc(B.topologyInfo?.name || B.topology)} · ${B.afeTotal}× AFE IC (${B.channelsPerIc} ch)`),
        R.archAssess?.topo ? row('Topology assessment', `<span style="font-weight:normal">${verdictBadge(R.archAssess.topo)}</span>`) : '',
        row('BTMS', T?.control ? `${esc(T.control.name)}<br><span style="font-weight:normal">${esc(T.control.note || '')}</span>` : 'none — no active thermal loop to run'),
        row('Supervisor', A?.supervisor ? esc(A.supervisor.name) : null),
      ]),
    ].join('\n')));
  }

  // --- Layer: thermal system -------------------------------------------------
  if (T) {
    layers.push(layer('thermal', '🌡️', 'Thermal system', T.loop?.name || T.loopId, [
      img(R.thermPng, 'thermal loop'),
      table([
        row('Loop', `${esc(T.loop?.name || T.loopId)}${T.ramAir ? ' — ram air (free airflow in use, nothing to buy)' : ''}`),
        T.assessment ? row('Loop assessment', `<span style="font-weight:normal">${verdictBadge(T.assessment)}</span>`) : '',
        row('Continuous heat', `${f0(T.heatContW)} W at ${f0(T.ambientC?.[1])} °C design ambient`),
        T.flowLpm != null ? row('Coolant flow', `${f1(T.flowLpm)} L/min (ṁ = Q / (c_p·ρ·ΔT), ΔT ${T.coolant.dTdesignK} K)`) : '',
        T.compressorKW != null ? row('Chiller', `${f1(T.chillerKW)} kW duty → ~${f1(T.compressorKW)} kW compressor at COP ${T.chillerCOP} — owned by the higher system`) : '',
        row('Winter charging', T.heaterNeeded ? `heater branch required — design ambient falls below the ${f0(T.chargeFloorC)} °C charge floor` : 'no heater needed in the design climate'),
      ]),
      T.coolantSide ? `<div class="side"><b>Coolant side</b>${list(T.coolantSide)}</div>` : '',
      T.refrigerantSide ? `<div class="side"><b>Refrigerant side</b>${list(T.refrigerantSide)}</div>` : '',
      T.airSide ? `<div class="side"><b>Air side</b>${list(T.airSide)}</div>` : '',
    ].join('\n')));
  }

  // --- Layer: sensors --------------------------------------------------------
  if (R.sensors?.groups?.length) {
    layers.push(layer('sensors', '📡', 'Sensor plan', `${R.sensors.groups.length} levels`, R.sensors.groups.map((gr) =>
      `<div class="side"><b>${esc(gr.level)}</b>${list(gr.sensors.map((x) => `${x.name}${x.count != null ? ` — ${x.count}×` : ''}${x.note ? `. ${x.note}` : ''}`))}</div>`
    ).join('\n')));
  }

  const navBtn = (id, label) => `<button data-l="${id}">${esc(label)}</button>`;
  const nav = [
    A ? navBtn('system', '🏭 System') : '',
    A ? navBtn('pack', '🔋 Pack') : '',
    P ? navBtn('module', '🧱 Module') : '',
    navBtn('cell', '⚗️ Cell'),
    B ? navBtn('control', '🧠 Control') : '',
    T ? navBtn('thermal', '🌡️ Thermal') : '',
    R.sensors?.groups?.length ? navBtn('sensors', '📡 Sensors') : '',
  ].filter(Boolean).join('');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Architecture report — ${esc(R.application)} ${S ? `${S.s}S${S.p}P` : ''}</title>
<style>
  body{font-family:'Segoe UI',Helvetica,Arial,sans-serif;color:#1a1a1a;margin:0;background:#f4f6f5}
  .wrap{max-width:760px;margin:0 auto;padding:24px 16px 60px}
  h1{font-size:21px;margin:0 0 2px}
  .meta{color:#667;font-size:12px;margin-bottom:14px}
  nav{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 14px}
  nav button{border:1px solid #cfd6d3;background:#fff;border-radius:14px;padding:4px 12px;
    font-size:12px;cursor:pointer}
  nav button:hover{border-color:#0b6e5f;color:#0b6e5f}
  .layer{background:#fff;border:1px solid #dfe4e2;border-radius:8px;margin-bottom:10px;padding:0}
  .layer>summary{cursor:pointer;list-style:none;padding:12px 14px;font-size:14px}
  .layer>summary::-webkit-details-marker{display:none}
  .layer>summary::before{content:'▸';display:inline-block;margin-right:8px;color:#889;
    transition:transform .15s}
  .layer[open]>summary::before{transform:rotate(90deg)}
  .lic{margin-right:6px}
  .lsub{color:#667;font-size:12px;margin-left:10px;font-weight:normal}
  .lbody{padding:2px 14px 14px}
  .side{font-size:12.5px;margin-top:10px}
  .foot{color:#667;font-size:11px;margin-top:18px;line-height:1.6}
  @media print{nav{display:none}.layer{border:none;page-break-inside:avoid}}
</style></head><body><div class="wrap">
  <h1>Architecture report — layered</h1>
  <div class="meta">${esc(R.date)} · application: ${esc(R.application)} · battery-design
    (morshedvarzandeh.github.io/battery-design)</div>
  <nav>${nav}<button data-l="__all">⤢ open all</button></nav>
  ${layers.join('\n')}
  <div class="foot">Select a layer above, or open the sections directly — each level of the
  architecture (system → pack → module → cell, plus control, thermal and sensors) is a layer
  of this report. ${esc(R.disclaimer || '')}</div>
</div>
<script>
  document.querySelectorAll('nav button').forEach(function (b) {
    b.onclick = function () {
      if (b.dataset.l === '__all') {
        var all = document.querySelectorAll('.layer');
        var open = Array.prototype.some.call(all, function (d) { return !d.open; });
        all.forEach(function (d) { d.open = open; });
        return;
      }
      var d = document.getElementById('L-' + b.dataset.l);
      if (d) { d.open = true; d.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
    };
  });
</script>
</body></html>`;
}
