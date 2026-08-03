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
    id: 'v2l', name: 'V2L — power a load from the vehicle',
    what: 'An AC socket on the vehicle (or an adapter on the charge port) runs tools, camps, or a house appliance. No grid interconnection — it is an inverter output.',
    needs: ['inverter output on the vehicle (factory option on many EVs)', 'load management so the pack reserve is respected'],
    appIds: ['ev'],
  },
  {
    id: 'v2h', name: 'V2H — back up the home',
    what: 'The vehicle supplies the house during an outage through a bidirectional charger, with the home islanded from the grid.',
    needs: ['bidirectional EVSE/charger (UL 9741 class)', 'transfer switch / islanding so linemen never meet a backfed grid', 'home-side integration and certification'],
    appIds: ['ev'],
  },
  {
    id: 'v2g', name: 'V2G — sell services to the grid',
    what: 'The pack discharges into the grid for peak shaving or frequency services. Bidirectional power transfer per ISO 15118-20 (CCS) or CHAdeMO; the grid-facing inverter must meet DER interconnection rules (IEEE 1547, UL 1741).',
    needs: ['ISO 15118-20 BPT (or CHAdeMO) charge session', 'grid-code-compliant inverter path (IEEE 1547 / UL 1741, or the local grid code)', 'an aggregator/market route to actually get paid', 'the wear economics to close (see the floor)'],
    appIds: ['ev', 'ebus'],
  },
  {
    id: 'v2v', name: 'V2V — charge another vehicle',
    what: 'One vehicle rescues another. In practice this is V2L feeding the other car\'s AC charger (slow), or a DC transfer with largely proprietary hardware.',
    needs: ['no settled public standard exists for direct DC vehicle-to-vehicle transfer'],
    appIds: ['ev'],
  },
];

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

// The per-application plan the UI and report consume.
export function v2xPlan({ appId, cell, cellCount, energyWh, dod = 0.8 }) {
  // Stationary storage IS grid storage — bidirectionality is its normal
  // operation through the PCS, not a V2X feature. Say so.
  if (appId === 'solar-ess' || appId === 'ups') {
    return {
      applicable: false,
      why: 'Not applicable as "V2X": this system already feeds the grid through its PCS — bidirectional operation is its normal duty, covered by the EMS dispatch and the grid-interconnection rules in its own checklist.',
      modes: [], wearFloor: null,
    };
  }
  const modes = V2X_MODES.filter((m) => m.appIds.includes(appId));
  if (!modes.length) {
    return {
      applicable: false,
      why: 'Not applicable: no vehicle-style bidirectional interface exists for this application class.',
      modes: [], wearFloor: null,
    };
  }
  const wearFloor = wearFloorUsdPerKWh({ cell, cellCount, energyWh, dod });
  return {
    applicable: true,
    why: null,
    modes: modes.map((m) => ({ ...m, assessment: assessV2xMode(m, { wearFloor }) })),
    wearFloor,
    wearNote: wearFloor != null
      ? `Wear floor ${`$${wearFloor.toFixed(2)}`}/kWh: at nameplate cycle life (${cell.cycleLife} cycles, ${Math.round(dod * 100)}% DoD), that is what one delivered kWh consumes of this pack's ${`$${Math.round(cell.priceUSD * cellCount)}`} cell cost. V2G revenue must clear it.`
      : 'No wear floor computable — the cell publishes no price or cycle life, so the wear side of the V2G ledger cannot be priced.',
  };
}
