// hosts.js — the machine the pack goes into.
//
// A pack on a bench tells you what it weighs. A pack shown INSIDE the thing
// it powers tells you the only question anyone actually has at the start: does
// it fit, and where does it go? Under the floor of a car, along the frame of a
// bicycle, in the hull of a boat, in the torso of a humanoid — those are four
// different design problems, and the tool has always modelled them separately
// without ever showing them.
//
// WHAT IS REAL HERE AND WHAT IS NOT, stated plainly, because a silhouette is
// exactly the kind of thing people take literally:
//
//   REAL — the pack. Every cell, every millimetre, from layoutPack, drawn at
//   true scale inside the machine. If it looks too big for the car, it is too
//   big for the car.
//
//   REAL WHERE AVAILABLE — the machine's cross-section. Five applications have
//   a vehicle model with a measured frontal area, and width and height are
//   derived from it rather than drawn to taste.
//
//   INDICATIVE — the machine's length, and everything about the machines with
//   no vehicle model. Class-typical figures, registered in REFERENCES §8, and
//   the scene says which kind it used. They are there to give the pack somewhere
//   to sit, not to describe anybody's vehicle.
//
// A silhouette is NOT a CAD model and this file will never grow into one. The
// moment it starts carrying wheelbases and overhangs, someone will measure it.
//
// Pure data, no DOM.

import { vehicleDefaultsFor } from './vehicle.js';
import { vesselModelById } from './vessels.js';

// Where the pack lives in the machine. This is the interesting half: it is a
// real integration decision with real consequences, and the same 60 kWh of
// cells is a different design in each one.
export const MOUNTINGS = {
  floor: { id: 'floor', name: 'Skateboard floor', what: 'A flat slab between the axles, below the cabin. The lowest centre of gravity available and the largest flat area — which is why almost every purpose-built EV looks like this.' },
  roof: { id: 'roof', name: 'Roof-mounted', what: 'On top, where an underfloor pack would foul the low-floor cabin. Standard on city buses, and it puts several hundred kilograms above the roll centre.' },
  frame: { id: 'frame', name: 'In the frame', what: 'Along the down tube or in the rack. Narrow, long, and constrained by a tube somebody else designed.' },
  deck: { id: 'deck', name: 'Under the deck', what: 'A shallow tray the rider stands on. Almost no height, and every millimetre of it is ground clearance.' },
  hull: { id: 'hull', name: 'In the hull', what: 'Low and central for trim. Wet, salty, and grounded to nothing — a boat is deliberately not bonded to earth.' },
  torso: { id: 'torso', name: 'In the torso', what: 'Carried as part of the mass it has to move, high enough to matter for balance. A legged machine pays for its battery on every step.' },
  belly: { id: 'belly', name: 'Belly-mounted', what: 'Slung under the airframe on the centre of lift. Mass here is paid for continuously, not just when accelerating.' },
  chassis: { id: 'chassis', name: 'In the chassis', what: 'Low in the frame of a wheeled machine, usually swappable because the machine is meant to keep working.' },
  rack: { id: 'rack', name: 'Racked', what: 'Stacked in a cabinet where mass is free and access, fire separation and cable routing are what matter.' },
  case: { id: 'case', name: 'In the case', what: 'The pack IS most of the product. The enclosure is the thing the customer holds.' },
  locker: { id: 'locker', name: 'In a locker', what: 'A house bank in a compartment, sized by the space that happens to exist rather than by a target.' },
  strap: { id: 'strap', name: 'Against the body', what: 'Millimetres, worn on skin. Temperature limits are human comfort limits, not cell limits.' },
  grip: { id: 'grip', name: 'In the grip', what: 'A hand tool\'s pack is a handle. Ergonomics and a moulded latch decide the shape before any cell does.' },
};

// The machines. `lengthM`, `widthM` and `heightM` are OVERALL indicative
// dimensions of the host; the renderer draws a massing block, never a model.
// Where a vehicle model exists, width and height are re-derived from its
// measured frontal area and these become the fallback.
export const HOSTS = {
  car: { kind: 'car', name: 'Passenger car', lengthM: 4.4, widthM: 1.8, heightM: 1.45, mount: 'floor' },
  bus: { kind: 'bus', name: 'City bus', lengthM: 12.0, widthM: 2.55, heightM: 3.2, mount: 'roof' },
  van: { kind: 'van', name: 'Motorhome / van', lengthM: 6.5, widthM: 2.2, heightM: 2.8, mount: 'locker' },
  bike: { kind: 'bike', name: 'Electric bicycle', lengthM: 1.75, widthM: 0.6, heightM: 1.1, mount: 'frame' },
  scooter: { kind: 'scooter', name: 'Kick scooter', lengthM: 1.15, widthM: 0.5, heightM: 1.2, mount: 'deck' },
  boat: { kind: 'boat', name: 'Small craft', lengthM: 7.0, widthM: 2.4, heightM: 1.6, mount: 'hull' },
  drone: { kind: 'drone', name: 'Multirotor', lengthM: 0.65, widthM: 0.65, heightM: 0.22, mount: 'belly' },
  agv: { kind: 'agv', name: 'Industrial mobile robot', lengthM: 1.4, widthM: 0.9, heightM: 0.6, mount: 'chassis' },
  humanoid: { kind: 'humanoid', name: 'Humanoid robot', lengthM: 0.35, widthM: 0.55, heightM: 1.7, mount: 'torso' },
  quadruped: { kind: 'quadruped', name: 'Quadruped robot', lengthM: 0.9, widthM: 0.4, heightM: 0.6, mount: 'torso' },
  puck: { kind: 'puck', name: 'Robot vacuum', lengthM: 0.34, widthM: 0.34, heightM: 0.09, mount: 'chassis' },
  cabinet: { kind: 'cabinet', name: 'Storage cabinet', lengthM: 0.9, widthM: 0.6, heightM: 2.0, mount: 'rack' },
  box: { kind: 'box', name: 'Portable power station', lengthM: 0.36, widthM: 0.25, heightM: 0.28, mount: 'case' },
  handtool: { kind: 'handtool', name: 'Cordless tool', lengthM: 0.30, widthM: 0.09, heightM: 0.24, mount: 'grip' },
  wrist: { kind: 'wrist', name: 'Worn on the wrist', lengthM: 0.07, widthM: 0.06, heightM: 0.05, mount: 'strap' },
};

// Which machine each application is. One line each, because the mapping is the
// whole point and burying it in a function would hide it.
export const HOST_BY_APP = {
  ev: 'car', ebus: 'bus', rv: 'van',
  ebike: 'bike', escooter: 'scooter',
  marine: 'boat', drone: 'drone',
  robot: 'agv', humanoid: 'humanoid', cyberdog: 'quadruped', robovac: 'puck',
  'solar-ess': 'cabinet', ups: 'cabinet',
  powerstation: 'box', powertool: 'handtool', wearable: 'wrist',
};

// A frontal area is width x height x a fill factor: no vehicle is a rectangle,
// and taking the area as w*h would make every silhouette too small. 0.85 is the
// usual first-order figure for a car-like body and is an assumption (§8).
const FRONTAL_FILL = 0.85;

/**
 * The machine an application is, sized as well as the tool can honestly size it.
 *
 * Returns null for an application with no host — which is a real answer, not a
 * gap: a custom design is not any particular machine.
 */
export function hostFor(appId, vesselId = null) {
  // A selected NTNU vessel is not the generic class-typical boat below. Its
  // published overall dimensions and complete massing payload come from
  // vessels.js. The battery seat is still only a study position, because
  // neither source publishes a battery-compartment envelope.
  if (appId === 'marine' && vesselId) {
    const vessel = vesselModelById(vesselId);
    if (vessel) {
      const datum = vessel.model.datum;
      const sizeM = {
        x: vessel.dimensionsM.beam,
        y: vessel.dimensionsM.length,
        z: datum.verticalExtentM,
        // Kept with the envelope so the renderer receives the source datum
        // through the existing host payload without inventing an origin.
        zMin: datum.zMinM,
        zMax: datum.zMaxM,
        waterlineZ: datum.waterlineZM,
        baselineZ: datum.baselineZM,
      };
      const envelopeCentreZ = (datum.zMinM + datum.zMaxM) / 2;
      return {
        id: vessel.id,
        vesselId: vessel.id,
        kind: vessel.kind,
        name: vessel.name,
        sizeM,
        mount: { ...vessel.mounting },
        dimsFrom: 'published-particulars',
        dimsLabel: 'published principal particulars; waterline-datum engineering massing envelope; not CAD',
        note: `Waterline is z=0 m, the display baseline is z=${datum.baselineZM.toFixed(2)} m, and the sourced ${datum.topReference} is z=+${datum.zMaxM.toFixed(2)} m. ${datum.basis} ${vessel.mounting.what}`,
        model: vessel.model,
        asset3dId: vessel.model.assetId,
        evidence: vessel.evidence,
        boundary: `${vessel.model.boundary} Battery-study boundary: ${vessel.boundary}`,
        datum: { ...datum },
        // Source positions use the published-waterline datum. packSeat() and
        // the established renderer contract use the envelope centre, so make
        // that one coordinate conversion here in the data layer.
        packSeatM: {
          x: vessel.packSeatM.x,
          y: vessel.packSeatM.y,
          z: vessel.packSeatM.z - envelopeCentreZ,
        },
        seatBasis: 'indicative-study-position',
        fitBasis: 'unpublished-battery-compartment',
      };
    }
  }

  const key = HOST_BY_APP[appId];
  const base = key ? HOSTS[key] : null;
  if (!base) return null;

  let widthM = base.widthM;
  let heightM = base.heightM;
  let dimsFrom = 'class-typical';

  // Where a measured frontal area exists, it decides the cross-section — the
  // silhouette then carries at least one number that is not a guess.
  const veh = vehicleDefaultsFor(appId);
  if (veh?.frontalAreaM2 > 0) {
    const aspect = base.widthM / base.heightM;                 // keep the shape, fit the area
    const h = Math.sqrt((veh.frontalAreaM2 / FRONTAL_FILL) / aspect);
    widthM = h * aspect;
    heightM = h;
    dimsFrom = 'frontal-area';
  }

  return {
    kind: base.kind, name: base.name,
    asset3dId: `host/${base.kind}`,
    sizeM: { x: widthM, y: base.lengthM, z: heightM },
    mount: MOUNTINGS[base.mount],
    dimsFrom,
    // Said out loud in the scene, because a silhouette is exactly the kind of
    // thing someone screenshots and measures.
    note: dimsFrom === 'frontal-area'
      ? `Cross-section from the vehicle model's measured frontal area of ${veh.frontalAreaM2} m². Length is class-typical (§8).`
      : 'Indicative class-typical dimensions (§8) — a place for the pack to sit, not a description of any particular machine.',
  };
}

/**
 * Where the pack sits inside the machine, in metres from the machine's centre.
 *
 * Only the mounting decides this, so a design that changes its pack size moves
 * the pack rather than the machine — which is what makes an oversized pack
 * visibly burst out of the silhouette instead of quietly rescaling it.
 */
export function packSeat(host, packSizeM) {
  if (!host) return null;
  if (host.packSeatM) return { ...host.packSeatM };
  const s = host.sizeM;
  const p = packSizeM || { x: 0, y: 0, z: 0 };
  switch (host.mount.id) {
    case 'floor':   return { x: 0, y: 0, z: -s.z / 2 + p.z / 2 + 0.12 };
    case 'roof':    return { x: 0, y: 0, z: s.z / 2 + p.z / 2 };
    case 'deck':    return { x: 0, y: 0, z: -s.z / 2 + p.z / 2 + 0.05 };
    case 'hull':    return { x: 0, y: -s.y * 0.1, z: -s.z / 2 + p.z / 2 + 0.15 };
    case 'belly':   return { x: 0, y: 0, z: -s.z / 2 - p.z / 2 };
    case 'frame':   return { x: 0, y: -s.y * 0.05, z: -s.z * 0.1 };
    case 'torso':   return { x: 0, y: 0, z: s.z * 0.12 };
    case 'chassis': return { x: 0, y: 0, z: -s.z / 2 + p.z / 2 + 0.04 };
    case 'rack':    return { x: 0, y: 0, z: -s.z / 2 + p.z / 2 + 0.15 };
    case 'grip':    return { x: 0, y: 0, z: -s.z / 2 + p.z / 2 };
    default:        return { x: 0, y: 0, z: 0 };               // case, locker, strap: it IS the machine
  }
}

/** Does the pack actually fit in the machine it is meant to go in? */
export function fitInHost(host, packSizeM) {
  if (!host || !packSizeM) return null;
  if (host.fitBasis === 'unpublished-battery-compartment') {
    return {
      fits: null,
      over: [],
      status: 'unproven',
      basis: host.fitBasis,
      label: 'Unproven — battery-compartment dimensions unpublished',
      note: 'The pack is shown at an indicative study position. Published vessel overall dimensions cannot establish whether it fits the actual battery compartment; import or enter that compartment before making a fit claim.',
    };
  }
  const s = host.sizeM;
  // The roof and the belly are outside the body, so only two axes constrain.
  const outside = ['roof', 'belly'].includes(host.mount.id);
  const over = {
    x: packSizeM.x > s.x, y: packSizeM.y > s.y,
    z: !outside && packSizeM.z > s.z,
  };
  const axes = Object.entries(over).filter(([, v]) => v).map(([k]) => k);
  return {
    fits: axes.length === 0, over: axes,
    // Deliberately not a pass/fail finding: the silhouette is indicative, so
    // this is a prompt to check rather than a verdict to act on.
    note: axes.length
      ? `The pack is larger than the indicative ${host.name.toLowerCase()} on ${axes.join(' and ')}. `
        + 'The silhouette is not a measurement, so treat this as a reason to check the real bay, not as a failure.'
      : null,
  };
}
