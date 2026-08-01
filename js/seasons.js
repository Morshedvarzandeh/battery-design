// seasons.js — what temperature is the system actually at? Ambient is not
// one number: it swings across winter / spring / summer / autumn, and the
// pack sits ABOVE ambient by its own heat rise under load. This module
// carries class-typical seasonal ambient bands per climate and turns them
// into a per-season outlook (estimated system temperature + the charge and
// discharge flags that follow from the cell's rated windows).
//
// HONESTY: the bands are class-typical outdoor ambients for the climate
// family, not a weather service — the customer can always type their own
// window. Pure data + math, no DOM.

export const SEASONS = ['winter', 'spring', 'summer', 'autumn'];

// Applications that live indoors: picking one selects the conditioned
// climate automatically — a vacuum robot never sees a Nordic winter, and
// showing it one would be exactly the incoherence this tool avoids.
export const INDOOR_APPS = new Set(['robovac', 'robot', 'humanoid', 'ups', 'solar-ess']);

export const CLIMATES = [
  {
    id: 'temperate', name: 'Temperate (central EU / US midlatitude)',
    seasons: { winter: [-10, 5], spring: [5, 20], summer: [20, 35], autumn: [0, 20] },
  },
  {
    id: 'cold', name: 'Cold / continental (Nordic, Canada, alpine)',
    seasons: { winter: [-25, 0], spring: [-5, 15], summer: [10, 30], autumn: [-5, 15] },
  },
  {
    id: 'hot', name: 'Hot (arid / tropical)',
    seasons: { winter: [5, 25], spring: [15, 35], summer: [25, 45], autumn: [15, 35] },
  },
  {
    id: 'indoor', name: 'Indoor (conditioned space)',
    seasons: { winter: [15, 25], spring: [18, 28], summer: [20, 32], autumn: [18, 28] },
  },
];

export function climateById(id) {
  return CLIMATES.find((c) => c.id === id) || null;
}

// The all-year design window: coldest seasonal low to hottest seasonal high.
export function climateSpan(climate) {
  const los = SEASONS.map((s) => climate.seasons[s][0]);
  const his = SEASONS.map((s) => climate.seasons[s][1]);
  return [Math.min(...los), Math.max(...his)];
}

// Per-season outlook for a design: the estimated SYSTEM temperature is the
// seasonal ambient high plus the pack's own heat rise at continuous load
// (worst normal case: hottest hour, full duty). Flags come from the cell's
// rated charge/discharge windows.
// cell: needs tempChargeC [lo,hi] and tempDischargeC [lo,hi].
// tempRiseC: estimated pack rise above ambient at continuous load (may be null).
export function seasonalOutlook(climate, cell, tempRiseC) {
  const rise = tempRiseC ?? 0;
  return SEASONS.map((season) => {
    const [lo, hi] = climate.seasons[season];
    const systemHiC = hi + rise;
    const flags = [];
    let severity = 'pass';
    if (cell?.tempChargeC && lo < cell.tempChargeC[0]) {
      flags.push(`charging below ${cell.tempChargeC[0]} °C needs a heater or charge inhibit`);
      severity = 'warn';
    }
    if (cell?.tempDischargeC && lo < cell.tempDischargeC[0]) {
      flags.push(`ambient can drop below the ${cell.tempDischargeC[0]} °C discharge rating`);
      severity = 'warn';
    }
    if (cell?.tempDischargeC && systemHiC > cell.tempDischargeC[1]) {
      flags.push(`system can reach ~${Math.round(systemHiC)} °C — above the ${cell.tempDischargeC[1]} °C rating; cooling must remove the margin`);
      severity = 'fail';
    } else if (cell?.tempDischargeC && systemHiC > cell.tempDischargeC[1] - 10) {
      flags.push(`only ${Math.round(cell.tempDischargeC[1] - systemHiC)} °C headroom to the discharge rating at the hottest hour`);
      if (severity === 'pass') severity = 'warn';
    }
    return { season, ambientC: [lo, hi], systemHiC, riseC: rise, flags, severity };
  });
}
