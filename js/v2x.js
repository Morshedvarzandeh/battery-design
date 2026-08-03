// v2x.js — the AC side, round two: feeding power back. V2L, V2H, V2G and
// V2V, built on top of the charging architecture (js/charging.js).
//
// The reason this belongs in a PACK tool and not a brochure: the wear side
// of the ledger is computable from data we already hold. Every kWh sent out
// of the battery consumes cycle life, and the cycle-based cost model gives
// that a price — the WEAR FLOOR in $/kWh. Grid-service revenue below the
// floor loses money on battery wear before a single other cost is counted.
//
// Honesty on scope:
//  · The wear floor uses the cell's NAMEPLATE cycle life. Shallow V2G
//    micro-cycling ages differently (usually more gently per kWh) — the
//    floor is a first-order ceiling on wear cost, stated as such (§8).
//  · V2V has no settled public standard — it is assessed 'unproven', with
//    the practical fix named (V2L or a portable DC transfer unit), the same
//    vocabulary the tool uses for wireless BMS.
//  · Stationary storage is NOT "V2X": feeding the grid is its normal
//    operation through the PCS. The panel says so instead of listing modes.
//  · Discharge-to-grid segments in the mission simulation are a future
//    round; this one prices the decision.
//
// Pure data + math, no DOM.

export const V2X_MODES = [
  {
    id: 'v2l', name: 'V2L — power a load from the pack',
    what: 'An AC socket fed by an inverter runs tools, a camp or an appliance. Nothing interconnects with the grid — an islanded output, which is why it is the cheapest and least regulated way to feed power back.',
    needs: ['inverter output (a factory option on many EVs; already standard on RVs and boats)', 'residual-current protection on the socket', 'reserve enforcement so the machine still does its real job'],
    // Re-derived per application instead of assumed: anything that already
    // carries an inverter and can spare the energy can do V2L.
    appIds: ['ev', 'rv', 'marine'],
    gridFacing: false,
  },
  {
    id: 'v2h', name: 'V2H — back up the building',
    what: 'The pack supplies a house or site during an outage through a bidirectional charger, with the building islanded from the grid.',
    needs: ['bidirectional EVSE/charger (UL 9741 class)', 'transfer switch and islanding so linemen never meet a backfed grid', 'building-side integration and its certification'],
    appIds: ['ev'],
    gridFacing: true,
  },
  {
    id: 'v2g', name: 'V2G — sell services to the grid',
    what: 'The pack discharges into the grid for peak shaving or frequency services. Bidirectional power transfer per ISO 15118-20 (CCS) or CHAdeMO; the grid-facing inverter must meet DER interconnection rules (IEEE 1547, UL 1741, EN 50549).',
    needs: ['ISO 15118-20 BPT (or CHAdeMO) charge session', 'grid-code-compliant inverter path (IEEE 1547 / UL 1741 / EN 50549)', 'an aggregator or market route to actually get paid', 'the wear economics to close (see the floor)'],
    appIds: ['ev', 'ebus'],
    gridFacing: true,
  },
  {
    id: 'v2v', name: 'V2V — charge another vehicle',
    what: 'One vehicle rescues another. In practice this is V2L feeding the other vehicle\'s AC charger (slow), or a DC transfer with largely proprietary hardware.',
    needs: ['no settled public standard exists for direct DC vehicle-to-vehicle transfer'],
    appIds: ['ev'],
    gridFacing: false,
  },
];

// ---------------------------------------------------------------------------
// The parts the decision drags in. This is why V2X is a POLICY here and not a
// brochure: choosing it changes the bill of materials, the control software
// and the certification path. The customer should see that list before saying
// yes, not after.
// ---------------------------------------------------------------------------
export const V2X_PARTS = {
  v2l: [
    { part: 'Inverter (islanded AC output)', why: 'Turns pack DC into usable AC. Sized by the socket rating, not by the pack.', standard: 'IEC 62109 / UL 1741 equipment safety' },
    { part: 'Residual-current protection on the socket', why: 'The socket is now a source, and people will plug consumer equipment into it.', standard: 'IEC 60364-4-41 class' },
    { part: 'Reserve enforcement in the BMS/supervisor', why: 'Export stops at the reserve floor so the machine can still do its real job.', standard: 'design rule, not a standard' },
  ],
  v2h: [
    { part: 'Bidirectional charger', why: 'Power has to flow both ways through a path that was built one-way.', standard: 'UL 9741' },
    { part: 'Transfer switch + islanding control', why: 'The building must be disconnected from the grid before the pack feeds it. This is the safety-of-life item.', standard: 'IEEE 1547 anti-islanding, local wiring code' },
    { part: 'Grid-loss (anti-islanding) detection', why: 'Backfeeding a line someone believes is dead is how line workers are killed.', standard: 'IEEE 1547 / EN 50549' },
    { part: 'Building-level energy management', why: 'Something has to decide when the vehicle is allowed to be the power station.', standard: 'design rule' },
  ],
  v2g: [
    { part: 'Bidirectional charger on a grid-code inverter path', why: 'The export path is a distributed energy resource and gets certified as one.', standard: 'UL 1741 / EN 50549 / IEEE 1547' },
    { part: 'ISO 15118-20 (or CHAdeMO) session controller', why: 'Export has to be negotiated, authorised and metered per session.', standard: 'ISO 15118-20' },
    { part: 'Revenue-grade metering', why: 'You are selling energy — nobody pays against an estimate.', standard: 'local metering regulation (MID in the EU)' },
    { part: 'Aggregator / market interface', why: 'One vehicle is not a market participant; an aggregator makes it one.', standard: 'commercial, not technical' },
    { part: 'Cycle-life accounting in the BMS', why: 'Grid service is extra throughput, and warranty and state-of-health have to know about it.', standard: 'design rule' },
  ],
  v2v: [
    { part: 'Portable DC transfer unit, or a V2L-to-AC-charger adapter', why: 'No standard direct-DC path exists, so the hardware is proprietary or the transfer is slow.', standard: 'none settled' },
  ],
};

export function v2xParts(modeId) {
  return (V2X_PARTS[modeId] || []).map((p) => ({ ...p }));
}

// ---------------------------------------------------------------------------
// The export budget. Feeding power back is only real if the machine can still
// do its job afterwards, so every mode reserves state of charge — and what is
// left is checkable: kWh out, hours of backup, and what it costs in wear.
// ---------------------------------------------------------------------------
export const RESERVE_SOC = { v2l: 0.20, v2h: 0.20, v2g: 0.30, v2v: 0.30 };

export function exportBudget({ modeId, energyWh, socNow = 1.0, powerKW = null, wearFloor = null }) {
  const reserve = RESERVE_SOC[modeId];
  if (reserve == null || !(energyWh > 0)) return null;
  const exportableWh = energyWh * Math.max(0, socNow - reserve);
  return {
    reserve, exportableWh, powerKW,
    hours: powerKW > 0 ? exportableWh / 1000 / powerKW : null,
    wearCostUSD: wearFloor != null ? (exportableWh / 1000) * wearFloor : null,
    note: exportableWh > 0
      ? `Reserving ${Math.round(reserve * 100)}% keeps the machine usable; ${Math.round(exportableWh / 100) / 10} kWh is available to export from a ${Math.round(socNow * 100)}% charge.`
      : `Nothing to export: at ${Math.round(socNow * 100)}% charge the pack is already at or below the ${Math.round(reserve * 100)}% reserve.`,
  };
}

// The wear floor: what a delivered kWh costs in cycle life, from numbers the
// tool already trusts (cell price, nameplate cycle life, usable DoD). This
// is exactly the cost model's $/kWh-delivered — reproduced here so the
// module stays pure and the formula stays visible.
export function wearFloorUsdPerKWh({ cell, cellCount, energyWh, dod = 0.8 }) {
  if (cell?.priceUSD == null || cell?.cycleLife == null || !(cellCount > 0) || !(energyWh > 0)) return null;
  const upfrontUSD = cell.priceUSD * cellCount;
  const lifetimeKWh = (cell.cycleLife * energyWh * dod) / 1000;
  return lifetimeKWh > 0 ? upfrontUSD / lifetimeKWh : null;
}

// Verdicts in the tool's standard vocabulary, judged against the design.
export function assessV2xMode(mode, { wearFloor = null } = {}) {
  const floorTxt = wearFloor != null ? `$${wearFloor.toFixed(2)}/kWh` : 'unknown (no price/cycle-life data)';
  switch (mode.id) {
    case 'v2l':
      return {
        verdict: 'workable',
        why: 'An inverter output with no grid interconnection — the simplest V2X there is. Budget the pack reserve it may consume.',
      };
    case 'v2h':
      return {
        verdict: 'workable-with-costs',
        why: 'Established but not free: a bidirectional charger, a transfer switch/islanding installation and its certification. The battery side is the easy part.',
      };
    case 'v2g':
      return {
        verdict: 'workable-with-costs',
        why: `The standards exist (ISO 15118-20, IEEE 1547/UL 1741) — the decision is economic: every kWh sent to the grid costs up to ${floorTxt} in battery wear at nameplate cycle life. Service revenue below that floor loses money before hardware, aggregation or comms cost a cent. Shallow-cycle aging is usually gentler than nameplate, so treat the floor as the conservative ceiling.`,
      };
    case 'v2v':
      return {
        verdict: 'unproven',
        why: 'No settled public standard for direct vehicle-to-vehicle DC transfer — implementations are proprietary. The workable route today is V2L feeding the other vehicle\'s AC charger, slowly, or a portable DC transfer unit.',
      };
    default:
      return { verdict: 'unproven', why: 'Unknown mode.' };
  }
}

// Applications whose whole purpose is already to feed power out. Calling that
// "V2X" would sell a customer a feature they have by definition — so the tool
// names the duty instead, and points at the panel that really governs it.
const NATIVE_EXPORT = {
  'solar-ess': 'this system already feeds the grid through its PCS — bidirectional operation is its normal duty, governed by the EMS dispatch and the grid-interconnection rules in its own checklist.',
  ups: 'a UPS exists to supply loads when the grid does not — that is its normal duty through its own inverter, not a V2X feature bolted on.',
  powerstation: 'a portable power station IS an inverter with a battery attached: powering loads from the pack is the product, not an extra mode.',
};

// The per-application plan the UI and report consume. `policy` is what the
// customer has actually chosen to build ('off' or a mode id) — that choice is
// what pulls in parts, an export budget and extra certification.
export function v2xPlan({
  appId, cell, cellCount, energyWh, dod = 0.8,
  policy = 'off', socNow = 1.0, powerKW = null,
}) {
  if (NATIVE_EXPORT[appId]) {
    return {
      applicable: false, native: true,
      why: `Not applicable as "V2X": ${NATIVE_EXPORT[appId]}`,
      modes: [], wearFloor: null, policy: 'off', parts: [], budget: null,
    };
  }
  const modes = V2X_MODES.filter((m) => m.appIds.includes(appId));
  if (!modes.length) {
    return {
      applicable: false, native: false,
      why: 'Not applicable: this machine has no bidirectional interface to build on — there is no inverter output and no charge port that could run backwards.',
      modes: [], wearFloor: null, policy: 'off', parts: [], budget: null,
    };
  }
  const wearFloor = wearFloorUsdPerKWh({ cell, cellCount, energyWh, dod });
  // A policy is only honoured if this application can actually do it.
  const chosen = modes.find((m) => m.id === policy) || null;
  const budget = chosen
    ? exportBudget({ modeId: chosen.id, energyWh, socNow, powerKW, wearFloor })
    : null;
  return {
    applicable: true, native: false, why: null,
    modes: modes.map((m) => ({ ...m, assessment: assessV2xMode(m, { wearFloor }) })),
    wearFloor,
    policy: chosen ? chosen.id : 'off',
    chosen,
    parts: chosen ? v2xParts(chosen.id) : [],
    gridFacing: chosen ? !!chosen.gridFacing : false,
    budget,
    policyNote: chosen
      ? `Building ${chosen.name.split(' — ')[0]} is a design decision, not a setting: it adds ${v2xParts(chosen.id).length} item${v2xParts(chosen.id).length === 1 ? '' : 's'} to the bill of materials${chosen.gridFacing ? ' and a grid-interconnection approval to the release checklist' : ' — and, being islanded, no grid-interconnection approval'}.`
      : 'No feed-back capability selected: the pack takes energy in and gives it to its own machine, and nothing extra is designed, bought or certified.',
    wearNote: wearFloor != null
      ? `Wear floor ${`$${wearFloor.toFixed(2)}`}/kWh: at nameplate cycle life (${cell.cycleLife} cycles, ${Math.round(dod * 100)}% DoD), that is what one delivered kWh consumes of this pack's ${`$${Math.round(cell.priceUSD * cellCount)}`} cell cost. V2G revenue must clear it.`
      : 'No wear floor computable — the cell publishes no price or cycle life, so the wear side of the V2G ledger cannot be priced.',
  };
}
