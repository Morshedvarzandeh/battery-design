// engineering.js — four-perspective engineering analysis engine for the pack
// designer: mechanical / thermal / electrical / safety.
//
// Pure functions, no state and no DOM. Consumes the precomputed
// design context (cell, s, p, pack, layout, usage, component selection) and
// never recomputes pack electricals. Component objects follow the shapes
// published by components.js but are duck-typed here — any of them may be
// null, which produces an info 'not selected' finding rather than a crash.
//
// Finding shape (shared with standards.js so the UI can reuse rendering):
//   { id, severity: 'fail'|'warn'|'pass'|'info', title, detail, ref }

import { resolveIsolationRule } from './isolation-rule.js';

export const ANALYSIS_DISCLAIMER =
  'These are first-order, steady-state engineering estimates computed from ' +
  'nameplate cell data and class-typical component properties (busbar ' +
  'resistivity, heat-transfer coefficients, TIM conductivity and the like). ' +
  'They are intended to orient a design — flagging where heat, current, ' +
  'clearance or mass budgets look tight — and are not a substitute for ' +
  'detailed CFD/FEA analysis, supplier data or physical testing of real ' +
  'hardware.';

/* ------------------------------------------------------------------ *
 *  Small helpers
 * ------------------------------------------------------------------ */

const SEVERITY_ORDER = { fail: 0, warn: 1, pass: 2, info: 3 };

function isNum(v) {
  return typeof v === 'number' && isFinite(v);
}

// Format a number to a sensible precision without false precision.
function fmt(n, digits) {
  if (!isNum(n)) return '?';
  if (digits === undefined) {
    const a = Math.abs(n);
    digits = a >= 100 ? 0 : a >= 10 ? 1 : a >= 1 ? 2 : 3;
  }
  const s = n.toFixed(digits);
  return s.indexOf('.') >= 0 ? s.replace(/\.?0+$/, '') : s;
}

function pct(ratio) {
  if (!isNum(ratio)) return '?';
  return fmt(ratio * 100, ratio * 100 >= 100 ? 0 : 1) + '%';
}

// Round for the totals block (keep raw math internal, emit tidy numbers).
function round(n, dp) {
  if (!isNum(n)) return null;
  const f = Math.pow(10, dp);
  return Math.round(n * f) / f;
}

function finding(id, severity, title, detail, ref) {
  return { id, severity, title, detail, ref: ref || null };
}

function sortFindings(list) {
  return list.sort(
    (a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9)
  );
}

function mid(range) {
  if (Array.isArray(range) && isNum(range[0]) && isNum(range[1])) {
    return (range[0] + range[1]) / 2;
  }
  return isNum(range) ? range : null;
}

// API/browser orchestration resolves the isolation topology once in
// architecture.js and passes that exact immutable result to every consumer.
// Standalone callers may still provide the older context object; only that
// fallback invokes the low-level resolver.
function isolationForConsumer(ctx, workingVoltageV) {
  if (Object.hasOwn(ctx || {}, 'isolationResolution')) {
    const resolved = ctx.isolationResolution || null;
    if (resolved?.workingVoltageV != null
      && Math.abs(resolved.workingVoltageV - workingVoltageV) > 1e-9) return null;
    return resolved;
  }
  const rawContext = ctx?.isolationContext || null;
  const applicationContext = rawContext && typeof rawContext === 'object'
    ? rawContext.applicationContext
    : (ctx?.usage?.application === 'marine' ? 'marine-it' : null);
  try {
    return resolveIsolationRule({
      ...(typeof rawContext === 'string' ? { contextId: rawContext } : (rawContext || {})),
      workingVoltageV,
      applicationContext,
    });
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 *  Geometry / area helpers (mm in, m^2 out)
 * ------------------------------------------------------------------ */

// Total exposed surface of one cell.
function cellSurfaceM2(cell) {
  if (!cell || !cell.dims) return null;
  if (cell.form === 'cylindrical') {
    const { d, h } = cell.dims;
    if (!isNum(d) || !isNum(h)) return null;
    return (Math.PI * d * h + (Math.PI * d * d) / 2) * 1e-6; // lateral + 2 caps
  }
  const { w, t, h } = cell.dims;
  if (!isNum(w) || !isNum(t) || !isNum(h)) return null;
  return 2 * (w * h + t * h + w * t) * 1e-6;
}

// Wetted / contact area between the cooling system and the pack, by placement.
function coolingContactAreaM2(ctx, cooling) {
  if (!cooling || !ctx.cell || !ctx.pack) return null;
  const n = ctx.pack.cellCount;
  const inner = ctx.layout && ctx.layout.inner;
  const cell = ctx.cell;
  switch (cooling.placement) {
    case 'air':
    case 'immersion': {
      const a = cellSurfaceM2(cell);
      return a != null && isNum(n) ? a * n : null;
    }
    case 'bottom':
      return inner && isNum(inner.x) && isNum(inner.y) ? inner.x * inner.y * 1e-6 : null;
    case 'side':
      return inner && isNum(inner.y) && isNum(inner.z) ? 2 * inner.y * inner.z * 1e-6 : null;
    case 'between': {
      if (cell.form === 'cylindrical') {
        const { d, h } = cell.dims || {};
        if (!isNum(d) || !isNum(h) || !isNum(n)) return null;
        // Serpentine ribbon wraps ~a quarter of each cell's lateral surface.
        return 0.25 * Math.PI * d * h * 1e-6 * n;
      }
      const { w, h } = cell.dims || {};
      // Fin plates between prismatic/pouch cells: ~one large face per cell.
      return isNum(w) && isNum(h) && isNum(n) ? w * h * 1e-6 * n : null;
    }
    default:
      return null;
  }
}

function isPlateCooling(cooling) {
  return !!cooling && (cooling.placement === 'bottom' || cooling.placement === 'side' || cooling.placement === 'between');
}

function isPassiveCooling(cooling) {
  // No cooling selected, an explicit 'none', or still air counts as passive.
  if (!cooling) return true;
  if (cooling.kind === 'none') return true;
  return cooling.placement === 'air' && !cooling.needsPump;
}

function hasNoTim(tim) {
  return !tim || tim.kind === 'none' || !isNum(tim.thermalCondWmK);
}

/* ------------------------------------------------------------------ *
 *  Core derived quantities (computed once, shared by all perspectives)
 * ------------------------------------------------------------------ */

function deriveQuantities(ctx) {
  const { cell, pack, usage, selection } = ctx;
  const sel = selection || {};

  // --- Load (amps) — from usage power when given, else pack maximum.
  let loadContA = null;
  let loadContFromUsage = false;
  if (usage && isNum(usage.contPowerW) && usage.contPowerW > 0 && isNum(pack.nominalV) && pack.nominalV > 0) {
    loadContA = usage.contPowerW / pack.nominalV;
    loadContFromUsage = true;
  } else if (isNum(pack.maxContCurrentA)) {
    loadContA = pack.maxContCurrentA;
  }
  let loadPeakA = null;
  let loadPeakFromUsage = false;
  if (usage && isNum(usage.peakPowerW) && usage.peakPowerW > 0 && isNum(pack.nominalV) && pack.nominalV > 0) {
    loadPeakA = usage.peakPowerW / pack.nominalV;
    loadPeakFromUsage = true;
  } else if (isNum(pack.maxContCurrentA)) {
    loadPeakA = pack.maxContCurrentA;
  }

  // --- Busbar interconnect resistance (very rough joint model: ~2 joints of
  // 20 mm effective length per cell position, s groups in series, p in parallel).
  const busbar = sel.busbar || null;
  let interconnectROhm = null;
  if (busbar && isNum(busbar.resistivityNOhmM) && isNum(busbar.crossSectionMm2) && busbar.crossSectionMm2 > 0 &&
      isNum(ctx.s) && isNum(ctx.p) && ctx.p > 0) {
    const rJoint = (busbar.resistivityNOhmM * 1e-9 * 0.02) / (busbar.crossSectionMm2 * 1e-6);
    interconnectROhm = (rJoint * 2 * ctx.s) / ctx.p;
  }
  const busbarLossW = interconnectROhm != null && loadContA != null
    ? loadContA * loadContA * interconnectROhm : null;
  const busbarLossPeakW = interconnectROhm != null && loadPeakA != null
    ? loadPeakA * loadPeakA * interconnectROhm : null;

  // --- Cell I^2R heat.
  const hasDcir = cell && isNum(cell.dcirMOhm);
  let heatContW = null;
  let heatPeakW = null;
  if (hasDcir && loadContA != null && isNum(ctx.p) && ctx.p > 0 && isNum(pack.cellCount)) {
    const iCell = loadContA / ctx.p;
    heatContW = iCell * iCell * (cell.dcirMOhm / 1000) * pack.cellCount + (busbarLossW || 0);
  }
  if (hasDcir && loadPeakA != null && isNum(ctx.p) && ctx.p > 0 && isNum(pack.cellCount)) {
    const iCell = loadPeakA / ctx.p;
    heatPeakW = iCell * iCell * (cell.dcirMOhm / 1000) * pack.cellCount + (busbarLossPeakW || 0);
  }

  // --- Cooling.
  const cooling = sel.cooling || null;
  const coolAreaM2 = cooling ? coolingContactAreaM2(ctx, cooling) : null;
  const htcMid = cooling ? mid(cooling.htcWm2K) : null;
  let tempRiseContC = null;
  if (heatContW != null && coolAreaM2 != null && coolAreaM2 > 0 && isNum(htcMid) && htcMid > 0) {
    tempRiseContC = heatContW / (htcMid * coolAreaM2);
  }

  // --- TIM across the plate interface.
  const tim = sel.tim || null;
  const timTMidMm = tim ? mid(tim.thicknessMm) : null;
  let timDeltaTC = null;
  if (!hasNoTim(tim) && isPlateCooling(cooling) && heatContW != null &&
      coolAreaM2 != null && coolAreaM2 > 0 && isNum(timTMidMm) && timTMidMm > 0) {
    const conductance = (tim.thermalCondWmK / (timTMidMm / 1000)) * coolAreaM2; // W/K
    timDeltaTC = heatContW / conductance;
  }

  // --- Creepage / clearance requirement at pack vMax.
  // Rule-of-thumb for IEC 60664-1 pollution degree 2, material group IIIa:
  // ~5 mm creepage per kV of working voltage with a 1 mm floor. Clearance by
  // voltage class. Both are 'order-of' figures; the binding values come from
  // the IEC 60664-1 tables for the actual insulation coordination case.
  const vMax = pack && isNum(pack.vMax) ? pack.vMax : null;
  const creepageReqMm = vMax != null ? Math.max(1, (vMax / 1000) * 5) : null;
  let clearanceReqMm = null;
  if (vMax != null) {
    clearanceReqMm = vMax < 300 ? 1.5 : vMax <= 500 ? 3 : 5.5;
  }

  // --- Component masses (kg).
  const n = pack && isNum(pack.cellCount) ? pack.cellCount : 0;
  const massBusbar = busbar && isNum(busbar.massGPerCell) ? (busbar.massGPerCell * n) / 1000 : 0;
  const spacer = sel.spacer || null;
  const massSpacer = spacer && isNum(spacer.massGPerCell) ? (spacer.massGPerCell * n) / 1000 : 0;
  const massCooling = cooling && isNum(cooling.massKgPerM2) && coolAreaM2 != null
    ? cooling.massKgPerM2 * coolAreaM2 : 0;
  const massTim = tim && isNum(tim.densityKgM3) && isPlateCooling(cooling) &&
      coolAreaM2 != null && isNum(timTMidMm)
    ? tim.densityKgM3 * coolAreaM2 * (timTMidMm / 1000) : 0;
  const housing = sel.housing || null;
  let massHousing = 0;
  const outer = ctx.layout && ctx.layout.outer;
  if (housing && isNum(housing.densityKgM3) && outer &&
      isNum(outer.x) && isNum(outer.y) && isNum(outer.z) &&
      ctx.layout && isNum(ctx.layout.wallMm)) {
    const areaMm2 = 2 * (outer.x * outer.y + outer.y * outer.z + outer.x * outer.z);
    massHousing = (areaMm2 * ctx.layout.wallMm * housing.densityKgM3) / 1e9;
  }
  const componentMassKg = {
    busbar: round(massBusbar, 3),
    spacer: round(massSpacer, 3),
    cooling: round(massCooling, 3),
    tim: round(massTim, 3),
    housing: round(massHousing, 3),
    total: round(massBusbar + massSpacer + massCooling + massTim + massHousing, 3),
  };
  const packMassWithComponentsKg = pack && isNum(pack.massCellsKg)
    ? pack.massCellsKg * 1.02 + massBusbar + massSpacer + massCooling + massTim + massHousing
    : null;

  return {
    loadContA, loadPeakA, loadContFromUsage, loadPeakFromUsage,
    interconnectROhm, busbarLossW, busbarLossPeakW,
    hasDcir, heatContW, heatPeakW,
    cooling, coolAreaM2, htcMid, tempRiseContC,
    tim, timTMidMm, timDeltaTC,
    vMax, creepageReqMm, clearanceReqMm,
    massBusbar, massSpacer, massCooling, massTim, massHousing,
    componentMassKg, packMassWithComponentsKg,
  };
}

/* ------------------------------------------------------------------ *
 *  ELECTRICAL perspective
 * ------------------------------------------------------------------ */

function electricalFindings(ctx, q) {
  const out = [];
  const { pack, layout, selection } = ctx;
  const busbar = (selection && selection.busbar) || null;

  // 1. Load derivation.
  if (q.loadContA != null) {
    const src = q.loadContFromUsage
      ? 'derived from the usage profile (' + fmt(ctx.usage.contPowerW, 0) + ' W at ' +
        fmt(pack.nominalV) + ' V nominal)'
      : 'taken as the pack’s maximum continuous rating (no usage load given)';
    const peakTxt = q.loadPeakA != null
      ? ' Peak load is ' + fmt(q.loadPeakA) + ' A' +
        (q.loadPeakFromUsage ? ' from the ' + fmt(ctx.usage.peakPowerW, 0) + ' W peak power.' : ' (fallback: pack maximum).')
      : '';
    out.push(finding(
      'load-basis', 'info', 'Analysis load point',
      'All analyses below use a continuous load of ' + fmt(q.loadContA) + ' A, ' + src + '.' + peakTxt,
      null
    ));
  }

  // 2-3. Busbar joint utilization and interconnect loss.
  if (!busbar) {
    out.push(finding(
      'busbar-not-selected', 'info', 'Interconnect not selected',
      'No busbar/interconnect component is selected, so joint ampacity and interconnect ' +
      'losses were not audited. Pick an interconnect to check per-joint current and I²R heat.',
      null
    ));
  } else {
    if (q.loadContA != null && isNum(ctx.p) && ctx.p > 0 && isNum(busbar.ampacityAPerJoint) && busbar.ampacityAPerJoint > 0) {
      const iCell = q.loadContA / ctx.p;
      const util = iCell / busbar.ampacityAPerJoint;
      const sev = util > 1 ? 'fail' : util >= 0.7 ? 'warn' : 'pass';
      const tail = sev === 'fail'
        ? ' Joints will overheat at this load; use a heavier interconnect, more joints per cell, or reduce per-cell current.'
        : sev === 'warn'
          ? ' Less than 30% margin per joint leaves little headroom for joint aging and hot spots; consider the next size up.'
          : ' This leaves comfortable margin per joint.';
      out.push(finding(
        'busbar-joint-utilization', sev, 'Busbar joint utilization',
        'Each cell carries about ' + fmt(iCell) + ' A continuous (' + fmt(q.loadContA) + ' A / ' +
        ctx.p + 'P), which is ' + pct(util) + ' of the ' + busbar.name + ' rating of ' +
        fmt(busbar.ampacityAPerJoint) + ' A per joint.' + tail,
        'industry practice'
      ));
    }
    if (q.interconnectROhm != null && q.busbarLossW != null) {
      out.push(finding(
        'busbar-loss', 'info', 'Interconnect resistive loss',
        'Modelling roughly two 20 mm joints per cell in ' + busbar.material + ' gives a pack ' +
        'interconnect resistance of about ' + fmt(q.interconnectROhm * 1000) + ' mΩ, dissipating ' +
        'about ' + fmt(q.busbarLossW) + ' W at ' + fmt(q.loadContA) + ' A continuous. This is a rough ' +
        'geometric estimate; real joint resistance depends heavily on weld/bond quality.',
        'industry practice'
      ));
    }
  }

  // 4. Creepage / clearance requirement.
  if (q.vMax != null && q.creepageReqMm != null) {
    out.push(finding(
      'creepage-clearance-req', 'info', 'Creepage and clearance requirement',
      'At the pack maximum of ' + fmt(q.vMax) + ' V, insulation coordination per IEC 60664-1 ' +
      '(pollution degree 2, material group IIIa, overvoltage category II) calls for creepage on ' +
      'the order of ' + fmt(q.creepageReqMm, 1) + ' mm (≈ 5 mm/kV with a 1 mm floor) and clearance ' +
      'on the order of ' + fmt(q.clearanceReqMm, 1) + ' mm. These are rule-of-thumb figures; the ' +
      'binding values come from the IEC 60664-1 dimensioning tables for the actual insulation case.',
      'IEC 60664-1'
    ));
    if (q.vMax > 60 && layout && isNum(layout.spacingMm) && layout.spacingMm < q.creepageReqMm) {
      out.push(finding(
        'creepage-cell-spacing', 'warn', 'Cell spacing below creepage requirement',
        'Cell-to-cell spacing is ' + fmt(layout.spacingMm, 1) + ' mm, but adjacent groups can sit at ' +
        'up to group-to-group potential and the order-of creepage requirement at ' + fmt(q.vMax) +
        ' V is ' + fmt(q.creepageReqMm, 1) + ' mm. Bare conductive paths between neighbouring groups ' +
        'need insulating barriers (spacer walls, kapton, potting) or wider spacing.',
        'IEC 60664-1'
      ));
    }
  }

  // 5. Isolation / leakage for HV packs. A numeric floor is emitted only
  // when the caller supplies the vehicle-bus topology context used by the
  // shared UN R100 resolver. Otherwise this perspective explicitly refuses
  // the old blanket 100 Ω/V claim and directs the user to Architecture.
  if (q.vMax != null && q.vMax > 60) {
    const isolation = isolationForConsumer(ctx, q.vMax);
    if (isolation && isolation.applies) {
      out.push(finding(
        'hv-isolation', 'info', 'Isolation resistance and leakage',
        'For the declared ' + isolation.busType.toUpperCase() + ' ' +
        isolation.topology.replace('galvanically-', 'galvanically ') + ' vehicle-bus case, UN R100 ' +
        '§' + isolation.clause + ' sets ' + isolation.ohmsPerVolt + ' Ω/V: ' +
        fmt(isolation.floorKOhm, 0) + ' kΩ at ' + fmt(q.vMax) + ' V working voltage. ' +
        'A project or manufacturer target above this floor must be recorded separately.',
        isolation.standard
      ));
    } else if (isolation && isolation.status === 'review-required') {
      out.push(finding(
        'hv-isolation-context', 'warn', 'Marine isolation basis requires review',
        isolation.basis + ' ' + isolation.groundingNote,
        'marine class rules / flag-state requirements'
      ));
    } else {
      out.push(finding(
        'hv-isolation-context', 'warn', 'Isolation topology not declared',
        'No numeric isolation floor is asserted here. UN R100 uses different cases for a separate DC bus ' +
        '(100 Ω/V), a separate AC bus (500 Ω/V), and galvanically connected AC/DC buses ' +
        '(500 Ω/V baseline). Declare the bus type and galvanic topology in Architecture; never average them.',
        'UN R100 Rev. 3 §§5.1.3.1–5.1.3.2'
      ));
    }
  }

  // 6. TIM dielectric withstand across a metal cooling plate.
  const tim = (selection && selection.tim) || null;
  if (isPlateCooling(q.cooling) && tim && isNum(tim.dielectricKVPerMm) &&
      Array.isArray(tim.thicknessMm) && isNum(tim.thicknessMm[0]) && q.vMax != null) {
    const withstandKV = tim.dielectricKVPerMm * tim.thicknessMm[0];
    const marginX = withstandKV * 1000 / q.vMax;
    out.push(finding(
      'tim-dielectric', 'info', 'TIM dielectric withstand',
      'The ' + tim.name + ' layer provides about ' + fmt(withstandKV, 1) + ' kV withstand across its ' +
      'minimum ' + fmt(tim.thicknessMm[0], 2) + ' mm thickness (' + fmt(tim.dielectricKVPerMm) +
      ' kV/mm), roughly ' + fmt(marginX, 0) + '× the ' + fmt(q.vMax) + ' V pack maximum. The TIM ' +
      'is thus also serving as insulation between cells and the grounded metal cooling plate — ' +
      'keep it free of voids and metal particles.',
      'IEC 60664-1'
    ));
  }

  return sortFindings(out);
}

/* ------------------------------------------------------------------ *
 *  THERMAL perspective
 * ------------------------------------------------------------------ */

function thermalFindings(ctx, q) {
  const out = [];
  const { cell, pack, usage, selection } = ctx;
  const cooling = q.cooling;
  const tim = (selection && selection.tim) || null;

  // 1. Heat generation.
  if (!q.hasDcir) {
    out.push(finding(
      'no-dcir', 'info', 'No DCIR — thermal model unavailable',
      'The selected cell has no published DC internal resistance, so I²R heat generation and ' +
      'temperature rise could not be estimated. Interconnect losses are reported separately where a ' +
      'busbar is selected.',
      null
    ));
  } else if (q.heatContW != null) {
    const perCell = isNum(pack.cellCount) && pack.cellCount > 0
      ? (q.heatContW - (q.busbarLossW || 0)) / pack.cellCount : null;
    out.push(finding(
      'heat-generation', 'info', 'Steady-state heat generation',
      'At ' + fmt(q.loadContA) + ' A continuous the pack dissipates about ' + fmt(q.heatContW) +
      ' W (' + fmt(perCell) + ' W per cell from ' + fmt(cell.dcirMOhm) + ' mΩ DCIR' +
      (q.busbarLossW != null ? ', plus ' + fmt(q.busbarLossW) + ' W in the interconnects' : '') +
      ').' + (q.heatPeakW != null ? ' At peak load this rises to about ' + fmt(q.heatPeakW) + ' W.' : ''),
      null
    ));
  }

  // 2. Cooling adequacy.
  if (!cooling) {
    out.push(finding(
      'cooling-not-selected', 'info', 'Cooling not selected',
      'No cooling concept is selected, so heat rejection was not audited. Even passive packs should ' +
      'have a deliberate thermal path; pick a cooling option to estimate temperature rise.',
      null
    ));
  } else if (q.heatContW != null && q.coolAreaM2 != null && q.tempRiseContC != null) {
    const sev = q.tempRiseContC > 30 ? 'fail' : q.tempRiseContC >= 15 ? 'warn' : 'pass';
    let tail = sev === 'fail'
      ? ' Cells would run far above coolant temperature; this cooling concept cannot carry the load.'
      : sev === 'warn'
        ? ' This eats most of the usual cell temperature budget; consider more contact area or a higher-performance cooling class.'
        : ' This is a comfortable margin for the cell temperature budget.';
    if (isPassiveCooling(cooling) && sev !== 'pass') {
      tail += ' With passive air at ' + fmt(q.heatContW / q.coolAreaM2, 0) +
        ' W/m² of cell surface, forced air or liquid cooling is needed.';
    }
    out.push(finding(
      'cooling-adequacy', sev, 'Cooling adequacy (' + cooling.name + ')',
      'Rejecting ' + fmt(q.heatContW) + ' W through ' + fmt(q.coolAreaM2, 3) + ' m² of ' +
      cooling.placement + ' contact area at h ≈ ' + fmt(q.htcMid, 0) + ' W/m²K gives an ' +
      'estimated cell-to-coolant rise of about ' + fmt(q.tempRiseContC, 1) + ' °C at continuous load.' + tail,
      'industry practice'
    ));
  } else if (q.heatContW != null) {
    out.push(finding(
      'cooling-area-unknown', 'info', 'Cooling contact area not resolvable',
      'A cooling option is selected but its contact area could not be computed from the layout, so ' +
      'temperature rise was not estimated.',
      null
    ));
  }

  // 3. TIM interface.
  if (isPlateCooling(cooling)) {
    if (hasNoTim(tim)) {
      out.push(finding(
        'tim-dry-contact', 'warn', 'Cold plate without TIM',
        'A ' + cooling.placement + ' cooling plate is selected but no thermal interface material is. ' +
        'Dry metal-to-cell contact touches only a few percent of the apparent area and ruins plate ' +
        'performance; add a gap filler, pad or thermal adhesive at the interface.',
        'industry practice'
      ));
    } else if (q.timDeltaTC != null) {
      const sev = q.timDeltaTC > 5 ? 'warn' : 'pass';
      out.push(finding(
        'tim-delta-t', sev, 'TIM interface temperature drop',
        'The ' + tim.name + ' layer (' + fmt(tim.thermalCondWmK) + ' W/mK, ~' + fmt(q.timTMidMm, 2) +
        ' mm) drops about ' + fmt(q.timDeltaTC, 1) + ' °C across the plate interface at ' +
        fmt(q.heatContW) + ' W.' +
        (sev === 'warn'
          ? ' More than 5 °C lost in the TIM wastes cooling performance; use a thinner bond line or a higher-conductivity filler.'
          : ' This is an acceptable interface loss.'),
        'industry practice'
      ));
    }
  } else if (!tim && cooling) {
    out.push(finding(
      'tim-not-selected', 'info', 'TIM not selected',
      'No thermal interface material is selected. With ' + (cooling.name || 'the chosen cooling') +
      ' there is no plate interface to bridge, so none is strictly required.',
      null
    ));
  }

  // 4. Charge-rate heat with passive cooling.
  if (usage && isNum(usage.chargeRateC) && usage.chargeRateC >= 1 && isPassiveCooling(cooling)) {
    const chgA = isNum(pack.capacityAh) ? usage.chargeRateC * pack.capacityAh : null;
    out.push(finding(
      'charge-rate-passive', 'warn', 'Fast charge with passive cooling',
      'The usage profile charges at ' + fmt(usage.chargeRateC, 1) + 'C' +
      (chgA != null ? ' (about ' + fmt(chgA) + ' A)' : '') + ' but cooling is passive. Charging heats ' +
      'cells almost as much as discharging and happens with the pack stationary and unventilated; ' +
      '≥1C charging generally needs forced air or liquid cooling to stay inside the charge ' +
      'temperature window.',
      'industry practice'
    ));
  }

  // 5. Thermal-barrier spacer vs sideways cooling path.
  const spacer = (selection && selection.spacer) || null;
  if (spacer && spacer.thermalBarrier && cooling &&
      (cooling.placement === 'between' || cooling.placement === 'bottom')) {
    out.push(finding(
      'barrier-vs-cooling', 'info', 'Thermal barrier spacer and the cooling path',
      'The ' + spacer.name + ' acts as a cell-to-cell thermal barrier, which fights propagation but ' +
      'also blocks sideways heat spreading between cells.' +
      (cooling.placement === 'bottom'
        ? ' With bottom-plate cooling this is fine — heat leaves axially through the cell base, not sideways.'
        : ' With between-cell cooling make sure the barrier does not sit between cells and the cooling surface itself.'),
      'industry practice'
    ));
  }

  return sortFindings(out);
}

/* ------------------------------------------------------------------ *
 *  MECHANICAL perspective
 * ------------------------------------------------------------------ */

function mechanicalFindings(ctx, q) {
  const out = [];
  const { cell, pack, layout, usage, selection } = ctx;
  const sel = selection || {};
  const spacer = sel.spacer || null;
  const housing = sel.housing || null;

  // 1. Component mass budget.
  if (q.packMassWithComponentsKg != null) {
    const c = q.componentMassKg;
    out.push(finding(
      'component-mass', 'info', 'Component mass budget',
      'Selected components add about ' + fmt(c.total, 2) + ' kg: busbar ' + fmt(c.busbar, 2) +
      ', spacers ' + fmt(c.spacer, 2) + ', cooling ' + fmt(c.cooling, 2) + ', TIM ' + fmt(c.tim, 2) +
      ', housing ' + fmt(c.housing, 2) + ' kg. Estimated pack mass with components is ' +
      fmt(q.packMassWithComponentsKg, 2) + ' kg (cells ' + fmt(pack.massCellsKg, 2) +
      ' kg + 2% wiring/BMS allowance + components); this replaces the generic 8% + wall estimate ' +
      'used before components were chosen.',
      null
    ));
  }
  if (!housing) {
    out.push(finding(
      'housing-not-selected', 'info', 'Housing not selected',
      'No housing is selected, so enclosure mass, ingress protection and flammability were not ' +
      'audited and the mass budget above carries no enclosure share.',
      null
    ));
  }

  // 2. Pouch compression.
  if (cell.form === 'pouch') {
    const compressive = !!spacer && (
      spacer.kind === 'compression-foam' || spacer.kind === 'foam' || spacer.kind === 'plate'
    );
    if (!compressive) {
      out.push(finding(
        'pouch-compression', 'warn', 'Pouch stack lacks compression',
        'Pouch cells need a controlled stack preload of roughly 0.5–1 bar (≈ 10 psi) to age ' +
        'well and avoid delamination and gas-pocket growth, but the selected spacer ' +
        (spacer ? '(' + spacer.name + ') does not provide it' : 'is missing') +
        '. Add compression foam between cells and rigid end plates with tie rods or straps.',
        'industry practice'
      ));
    }
  }

  // 3. Prismatic long stacks.
  if (cell.form === 'prismatic' && layout && isNum(layout.ny) && layout.ny >= 6) {
    out.push(finding(
      'prismatic-stack-preload', 'info', 'Long prismatic stack — end plates advised',
      'This layout stacks ' + layout.ny + ' prismatic cells along the module axis. Stacks of 6+ cells ' +
      'are normally clamped between machined end plates with tie rods or bands to control stack ' +
      'preload and take up cell swelling over life (prismatic cells can grow ~1–2% in thickness).',
      'industry practice'
    ));
  }

  // 4. Cylindrical cells without a holder.
  if (cell.form === 'cylindrical' && (!spacer || spacer.kind === 'none')) {
    out.push(finding(
      'cyl-no-holder', 'warn', 'Cylindrical cells without holders',
      'No cell holder/spacer is selected, so ' + fmt(pack.cellCount, 0) + ' cylindrical cells rely ' +
      'on busbar joints and glue alone for retention. Vibration testing (UN 38.3 T3, ISO 12405 ' +
      'profiles) routinely finds wrapper abrasion, joint fatigue and inter-cell shorts in unheld ' +
      'packs; use moulded holders or potting.',
      'UN 38.3 T3'
    ));
  }

  // 5. Application vs ingress protection.
  const app = usage && usage.application;
  const wetApps = { marine: 1, ebike: 1, escooter: 1, rv: 1 };
  if (app && wetApps[app] && housing && (housing.ipClass == null || housing.ipClass === 'IP54')) {
    out.push(finding(
      'housing-ip-application', 'info', 'Ingress protection vs application',
      'A ' + app + ' application sees rain, spray and wash-down, but the selected ' + housing.name +
      ' is rated ' + (housing.ipClass || 'unrated') + '. IP67 sealing is the usual target for ' +
      'outdoor/vehicle packs; small high-vibration packs are often additionally potted.',
      'industry practice'
    ));
  }

  return sortFindings(out);
}

/* ------------------------------------------------------------------ *
 *  SAFETY perspective
 * ------------------------------------------------------------------ */

function safetyFindings(ctx, q) {
  const out = [];
  const { cell, pack, layout, selection } = ctx;
  const sel = selection || {};
  const vent = sel.vent || null;
  const spacer = sel.spacer || null;
  const busbar = sel.busbar || null;
  const housing = sel.housing || null;
  const tim = sel.tim || null;

  // 1. Vent audit.
  const hasPackVent = !!vent && vent.level === 'pack';
  if (cell.form === 'cylindrical' || cell.form === 'prismatic') {
    out.push(finding(
      'cell-vent-integral', 'info', 'Cells carry integral vents',
      (cell.form === 'cylindrical' ? 'Cylindrical' : 'Prismatic') + ' cells include an integral ' +
      'burst vent (and typically a CID on cylindrical formats) that releases gas in a defined ' +
      'direction on abuse. Orient cells so vent gas is not aimed at neighbouring cells or the BMS' +
      (hasPackVent ? '; the selected pack-level ' + vent.name + ' then gives that gas a path out of the enclosure.' : '.'),
      null
    ));
  } else if (cell.form === 'pouch' && !hasPackVent) {
    out.push(finding(
      'pouch-no-pack-vent', 'warn', 'Pouch cells with no pack-level vent',
      'Pouch cells have no vent of their own — on abuse the laminate simply ruptures and gas ' +
      'accumulates inside the enclosure. With no pack-level vent selected, pressure can build until ' +
      'the housing fails uncontrolled; add a burst membrane or pressure-relief vent to the enclosure.',
      'industry practice'
    ));
  }
  const sealed = !!housing && (housing.ipClass === 'IP65' || housing.ipClass === 'IP66' || housing.ipClass === 'IP67' || housing.ipClass === 'IP68');
  const hasBreather = !!vent && /breather|membrane|gore|equaliz/i.test((vent.mechanism || '') + ' ' + (vent.name || ''));
  if (sealed && !hasBreather) {
    out.push(finding(
      'sealed-no-breather', 'warn', 'Sealed enclosure without a breather',
      'The ' + housing.name + ' is sealed to ' + housing.ipClass + ' but no pressure-equalizing ' +
      'breather is selected. Daily temperature and altitude cycling pumps the seals of a sealed ' +
      'enclosure, drawing in moisture and eventually defeating the IP rating; fit a breather ' +
      'membrane (separate from any burst vent).',
      'industry practice'
    ));
  }
  if (isNum(pack.energyWh) && pack.energyWh > 5000 && !hasPackVent) {
    out.push(finding(
      'ess-no-prv', 'warn', 'ESS-scale energy without pressure relief',
      'At ' + fmt(pack.energyWh / 1000, 1) + ' kWh this pack is in stationary-storage territory, ' +
      'where NFPA 855 siting and UL 9540A test data assume deflagration venting is addressed. No ' +
      'pack-level pressure-relief or rupture vent is selected; a thermal-runaway event in a closed ' +
      'enclosure of this size is an explosion hazard.',
      'NFPA 855 / UL 9540A'
    ));
  }

  // 2. Propagation barrier for energetic chemistries.
  const energetic = cell.chemistry === 'NMC' || cell.chemistry === 'NCA' || cell.chemistry === 'LCO';
  if (energetic && isNum(pack.cellCount) && pack.cellCount >= 12) {
    if (spacer && spacer.thermalBarrier) {
      out.push(finding(
        'propagation-barrier', 'pass', 'Cell-to-cell propagation barrier present',
        'With ' + fmt(pack.cellCount, 0) + ' ' + cell.chemistry + ' cells, single-cell thermal ' +
        'runaway is the design case, and the selected ' + spacer.name + ' places a thermal barrier ' +
        'between cells. This is the primary measure for slowing or stopping cell-to-cell propagation.',
        'UL 9540A'
      ));
    } else if (layout && isNum(layout.spacingMm) && layout.spacingMm < 2) {
      out.push(finding(
        'propagation-gap', 'warn', 'Energetic chemistry with tight spacing and no barrier',
        cell.chemistry + ' cells sit ' + fmt(layout.spacingMm, 1) + ' mm apart with no thermal-barrier ' +
        'spacer selected. A single cell in runaway (surface >600 °C) will heat its neighbours ' +
        'across such a gap within seconds; add aerogel, mica or ceramic-fibre barriers between cells ' +
        'or at least between parallel groups.',
        'UL 9540A'
      ));
    } else if (layout && isNum(layout.spacingMm)) {
      out.push(finding(
        'propagation-spacing', 'info', 'Propagation relies on air gap alone',
        cell.chemistry + ' cells are spaced ' + fmt(layout.spacingMm, 1) + ' mm apart with no ' +
        'dedicated thermal barrier. The gap gives some margin, but air is a poor barrier to ' +
        'radiative and vent-gas heating; barrier material between groups is still recommended for ' +
        'packs of this size.',
        'industry practice'
      ));
    }
  }

  // 3. Per-cell fusing on parallel groups.
  if (busbar) {
    const wireBonded = /wire|bond/i.test((busbar.joinMethod || '') + ' ' + (busbar.name || ''));
    if (wireBonded) {
      out.push(finding(
        'wirebond-fusing', 'pass', 'Wire bonds act as per-cell fuses',
        'The ' + busbar.name + ' interconnect wire-bonds each cell, and each bond acts as a per-cell ' +
        'fusible link. In a ' + ctx.p + 'P group, an internally shorted cell is disconnected before ' +
        'its neighbours can dump current into it — the classic mitigation for large parallel groups.',
        'industry practice'
      ));
    } else if (isNum(ctx.p) && ctx.p >= 10) {
      out.push(finding(
        'parallel-no-fusing', 'warn', 'Large parallel group without per-cell fusing',
        'With ' + ctx.p + ' cells in parallel joined by plain ' + (busbar.material || 'metal') +
        ' strip, an internal short in one cell lets the other ' + (ctx.p - 1) + ' discharge into it ' +
        'unimpeded. Use fusible-link busbar cutouts, wire bonds or per-cell fuse wire so a failed ' +
        'cell disconnects itself.',
        'industry practice'
      ));
    }
  }

  // 4. Housing flammability.
  if (housing) {
    const metallic = /alumin|steel|metal|stainless/i.test(housing.material || '');
    const v0 = /V-0|5VA/i.test(housing.flameRating || '');
    if (metallic || v0) {
      out.push(finding(
        'housing-flammability', 'pass', 'Housing flammability acceptable',
        'The ' + housing.name + ' is ' + (metallic ? 'metallic (' + housing.material + ')' :
        'rated ' + housing.flameRating) + ', so the enclosure itself will not sustain a flame and ' +
        'provides a first containment layer in a cell failure.',
        'industry practice'
      ));
    } else {
      out.push(finding(
        'housing-flammability', 'warn', 'Plastic housing without V-0 rating',
        'The ' + housing.name + ' (' + (housing.material || 'plastic') + ') carries ' +
        (housing.flameRating ? 'only a ' + housing.flameRating : 'no') + ' flame rating. Battery ' +
        'enclosures are expected to be UL 94 V-0 (or metal) so the housing does not become fuel in ' +
        'a cell failure; specify a V-0 grade of the same polymer.',
        'industry practice'
      ));
    }
  }

  // 5. Potting / encapsulant as fire and retention barrier.
  if (tim && /pot|encap/i.test((tim.kind || '') + ' ' + (tim.name || ''))) {
    out.push(finding(
      'potting-barrier', 'info', 'Potting doubles as a barrier',
      'The selected ' + tim.name + ' encapsulates cells, which besides its thermal role also ' +
      'retains cells mechanically, blocks vent-gas jets between neighbours and adds a fire barrier. ' +
      'Note that potting is irreversible and adds mass; it is best suited to small high-vibration packs.',
      'industry practice'
    ));
  }

  return sortFindings(out);
}

/* ------------------------------------------------------------------ *
 *  Entry point
 * ------------------------------------------------------------------ */

/**
 * Run the four-perspective engineering analysis.
 * @param {object} ctx design context (see module docs / input contract)
 * @returns {{perspectives: object, totals: object}}
 */
export function analyze(ctx) {
  const empty = {
    perspectives: { mechanical: [], thermal: [], electrical: [], safety: [] },
    totals: {
      loadContA: null, loadPeakA: null,
      heatContW: null, heatPeakW: null, busbarLossW: null,
      tempRiseContC: null, timDeltaTC: null,
      creepageReqMm: null, clearanceReqMm: null,
      componentMassKg: { busbar: 0, spacer: 0, cooling: 0, tim: 0, housing: 0, total: 0 },
      packMassWithComponentsKg: null,
    },
  };
  if (!ctx || !ctx.cell || !ctx.pack) return empty;

  let q;
  try {
    q = deriveQuantities(ctx);
  } catch (e) {
    return empty;
  }

  const perspectives = {};
  const builders = {
    mechanical: mechanicalFindings,
    thermal: thermalFindings,
    electrical: electricalFindings,
    safety: safetyFindings,
  };
  for (const key of Object.keys(builders)) {
    try {
      perspectives[key] = builders[key](ctx, q);
    } catch (e) {
      // A malformed field must not take down the whole analysis.
      perspectives[key] = [];
    }
  }

  return {
    perspectives,
    totals: {
      loadContA: round(q.loadContA, 1),
      loadPeakA: round(q.loadPeakA, 1),
      heatContW: round(q.heatContW, 1),
      heatPeakW: round(q.heatPeakW, 1),
      busbarLossW: round(q.busbarLossW, 2),
      tempRiseContC: round(q.tempRiseContC, 1),
      timDeltaTC: round(q.timDeltaTC, 2),
      creepageReqMm: round(q.creepageReqMm, 2),
      clearanceReqMm: round(q.clearanceReqMm, 2),
      componentMassKg: q.componentMassKg,
      // Two decimals is right for a 300 kg EV pack and destroys a wearable: a
      // 30 g pack rounds to 0.03 kg, so fitting an 8 g part changes nothing in
      // the DATA and the garage honestly reports "no measurable change". Tiny
      // packs are real packs, so the precision follows the scale.
      packMassWithComponentsKg: round(q.packMassWithComponentsKg,
        q.packMassWithComponentsKg != null && Math.abs(q.packMassWithComponentsKg) < 1 ? 5 : 2),
    },
  };
}
