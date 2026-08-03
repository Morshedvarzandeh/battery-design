// terrain.js — what the wheels are actually on.
//
// The vehicle model has always taken a rolling-resistance coefficient, and it
// has always been given the tarmac value, because that is what a drive cycle
// assumes. Off the road it is the single largest error in the whole energy
// budget: sand is five to eight times tarmac, and at low speed rolling
// resistance IS the consumption — there is barely any aerodynamic term to
// hide behind.
//
// That makes terrain a property of the JOURNEY rather than of the vehicle,
// which is why it lives here and not in the vehicle defaults. The same pickup
// crosses tarmac, gravel and sand in one trip, and a route can carry a
// different surface per segment.
//
// It is not only Crr. Three things change together, and taking one without
// the others gives an answer that is wrong in a confident direction:
//
//   ROLLING RESISTANCE rises, sharply and non-linearly with how much the
//   surface deforms under the tyre.
//   SPEED falls, because nobody drives sand at 90 km/h — and since aero goes
//   with v², the slower speed claws back some of what the surface costs.
//   REGENERATION falls, because loose surfaces limit how hard you can brake
//   without losing grip, so less of the descent comes back.
//
// The published Crr figures are for pneumatic tyres at road pressures. Airing
// down for sand — which is what people actually do — moves them, and the
// direction is favourable, so treating the road-pressure figure as the
// off-road answer is conservative rather than optimistic.
//
// Pure data + math, no DOM.

export const TERRAINS = {
  tarmac: {
    id: 'tarmac', name: 'Tarmac / sealed road', crr: 0.010,
    speedScale: 1.0, regenScale: 1.0,
    what: 'What every drive cycle assumes, and the only surface a homologation figure was measured on.',
  },
  concrete: {
    id: 'concrete', name: 'Concrete / warehouse floor', crr: 0.008,
    speedScale: 1.0, regenScale: 1.0,
    what: 'Smoother than tarmac and the reason indoor machines look efficient beside road ones.',
  },
  gravel: {
    id: 'gravel', name: 'Gravel / hard track', crr: 0.020,
    speedScale: 0.75, regenScale: 0.7,
    what: 'A graded track. Twice the rolling resistance of tarmac, and the first surface where braking grip starts to limit how much energy comes back.',
  },
  grass: {
    id: 'grass', name: 'Grass / firm field', crr: 0.055,
    speedScale: 0.6, regenScale: 0.6,
    what: 'Firm ground with a soft top. Highly sensitive to how wet it is — the wet figure is closer to mud than to this.',
  },
  sand: {
    id: 'sand', name: 'Soft sand', crr: 0.150,
    speedScale: 0.45, regenScale: 0.4,
    what: 'The hard case. Fifteen times tarmac, because the tyre is climbing out of a hole it digs continuously. Momentum matters more than power, which is why stopping in sand is what strands you.',
  },
  mud: {
    id: 'mud', name: 'Mud / deep rut', crr: 0.130,
    speedScale: 0.4, regenScale: 0.35,
    what: 'Like sand but with suction as well as deformation, and far less predictable — the same track differs hour to hour.',
  },
  rock: {
    id: 'rock', name: 'Rock / boulder crawl', crr: 0.070,
    speedScale: 0.15, regenScale: 0.5,
    what: 'Slow enough that aerodynamics vanish entirely and the whole budget is rolling resistance, gradient and the auxiliary load. Hours at walking pace is a duty cycle nothing else in this tool resembles.',
  },
  snow: {
    id: 'snow', name: 'Snow / packed ice', crr: 0.045,
    speedScale: 0.5, regenScale: 0.25,
    what: 'Moderate rolling resistance and almost no regeneration, because braking hard enough to recover energy is braking hard enough to slide. Cold also cuts what the pack will accept back.',
  },
};

export const terrainById = (id) => TERRAINS[id] || TERRAINS.tarmac;
export const terrainIds = () => Object.keys(TERRAINS);

/** Is this journey off-road at all? Used to decide whether to say anything. */
export const isOffRoad = (id) => !['tarmac', 'concrete'].includes(id);

/**
 * Apply a terrain to a vehicle.
 *
 * Returns a copy rather than mutating, because a route with mixed surfaces
 * evaluates the same vehicle several times and a mutated Crr would leak from
 * one segment into the next.
 */
export function vehicleOnTerrain(vehicle, terrainId) {
  const t = terrainById(terrainId);
  if (!vehicle) return null;
  return {
    ...vehicle,
    crr: t.crr,
    regenFrac: (vehicle.regenFrac || 0) * t.regenScale,
    terrain: t.id,
  };
}

/**
 * What this surface costs, against the same journey on tarmac.
 *
 * Both figures come from the REAL model, run twice. An earlier version
 * approximated the ratio from the Crr ratio and an assumed rolling share, and
 * it disagreed with the simulation by fifty percent on sand — 9.1x against
 * 6.1x — because the rolling share is not a constant. It moves with speed and
 * with how much accelerating the duty contains: about 40% on a drive cycle,
 * nearly all of it at walking pace, a third on a motorway.
 *
 * An approximation that contradicts the model standing next to it is not a
 * shortcut, it is a second answer that is wrong. So this reports the
 * comparison and the reasoning, and does no arithmetic of its own.
 */
export function terrainPenalty({ terrainId, baseWhPerKm = null, terrainWhPerKm = null }) {
  const t = terrainById(terrainId);
  const crrRatio = t.crr / TERRAINS.tarmac.crr;
  const factor = baseWhPerKm > 0 && terrainWhPerKm > 0 ? terrainWhPerKm / baseWhPerKm : null;
  return {
    terrain: t, crrRatio, factor,
    whPerKm: terrainWhPerKm,
    rangeFactor: factor ? 1 / factor : null,
    why: t.id === 'tarmac'
      ? 'Tarmac is the reference every published consumption figure was measured on.'
      : `${t.name} has ${crrRatio.toFixed(1)}x the rolling resistance of tarmac. `
        + (factor
          ? `Travelling slower on it recovers some of that — aerodynamic drag falls with the square of speed — so the net cost on this duty is ${factor.toFixed(2)}x the energy per kilometre and ${(1 / factor).toFixed(2)}x the range. `
          : 'Run the drive on both surfaces to see what that costs on your duty: the net is always less than the Crr ratio, because the lower speed takes back some of it. ')
        + t.what,
    assumptions: [
      'Both consumption figures come from the same vehicle model run twice — once on tarmac, once on this surface — rather than from a rule of thumb. The ratio is therefore specific to this duty and does not transfer to another one.',
      'Crr figures are for pneumatic tyres at ROAD pressures. Airing down for sand — which is what people actually do — lowers them, so this is the conservative end rather than the optimistic one.',
      'Traction is not modelled. This says what the energy costs, not whether the machine can get through at all, and on sand or mud the second question is usually the one that ends the trip.',
    ],
  };
}
