// vessels.js — the two vessels in the marine workspace.
//
// These are not invented "boat classes".  Their overall dimensions and the
// named propulsion facts come from public NTNU material:
//
//   · milliAmpere1 — the 5 m electric autonomous-ferry prototype.
//   · R/V Gunnerus — the research vessel used by the TwinShip demonstrator.
//
// The visual models are deliberately low-detail engineering massing models.
// Each primitive is already positioned and sized here; the Godot renderer only
// draws the payload.  That keeps the vessel choice testable in Node and stops a
// second geometry model growing inside the renderer.
//
// Published particulars are facts.  Mission defaults marked provisional are
// inputs for a screening calculation and must be replaced by a measured power
// trace or a vessel resistance/shaft-power curve for engineering release.

export const VESSEL_MODEL_VERSION = '2026.08.3';

const MODEL_BOUNDARY = 'Low-detail engineering massing only, not CAD. Primitive boxes show named systems and the sourced outer vertical envelope; they are not hull lines, compartment geometry, class drawings or construction geometry.';

const waterlineDatum = (draughtM, zMaxM, topReference) => Object.freeze({
  id: 'design-waterline-z0',
  axes: 'x starboard, y forward, z up',
  waterlineZM: 0,
  baselineZM: -draughtM,
  zMinM: -draughtM,
  zMaxM,
  verticalExtentM: draughtM + zMaxM,
  topReference,
  basis: 'The engineering-massing waterline is z=0. Its lowest visual baseline is one published draught below that line; this is a display datum, not a surveyed keel or hull-offset definition.',
});

const milliAmpereDatum = waterlineDatum(0.20, 3.30, 'published air draught');
const gunnerusDatum = waterlineDatum(2.70, 19.70, 'published antenna height');

const box = (role, name, sizeM, atM, tint = '#5f8f96') => ({
  kind: 'box', role, name, sizeM, atM, tint,
});

const milliAmpereModel = [
  box('hull', 'Aft hull', { x: 2.50, y: 1.70, z: 0.36 }, { x: 0, y: -1.55, z: -0.02 }),
  box('hull', 'Mid hull', { x: 2.68, y: 1.90, z: 0.46 }, { x: 0, y: -0.05, z: 0.03 }),
  box('hull', 'Bow hull', { x: 1.95, y: 1.45, z: 0.34 }, { x: 0, y: 1.58, z: -0.03 }),
  box('deck', 'Passenger deck', { x: 2.72, y: 4.45, z: 0.10 }, { x: 0, y: 0, z: 0.32 }, '#72999b'),
  box('superstructure', 'Passenger cabin', { x: 1.82, y: 2.12, z: 1.08 }, { x: 0, y: -0.05, z: 0.90 }, '#7ca5a8'),
  box('roof', 'Sensor roof', { x: 1.94, y: 2.25, z: 0.09 }, { x: 0, y: -0.05, z: 1.49 }, '#8ab0b0'),
  box('mast', 'Sensor mast', { x: 0.10, y: 0.10, z: 1.25 }, { x: 0, y: -0.05, z: 2.16 }, '#a4bdba'),
  box('sensor', 'Radar and camera bar', { x: 1.15, y: 0.16, z: 0.10 }, { x: 0, y: -0.05, z: 2.80 }, '#d0b264'),
  box('antenna', 'Air-draught marker antenna', { x: 0.06, y: 0.06, z: 0.45 }, { x: 0, y: -0.05, z: 3.075 }, '#d0b264'),
  box('thruster', 'Fore azimuth thruster', { x: 0.34, y: 0.34, z: 0.30 }, { x: 0, y: 2.12, z: -0.05 }, '#d28a55'),
  box('thruster', 'Aft azimuth thruster', { x: 0.34, y: 0.34, z: 0.30 }, { x: 0, y: -2.12, z: -0.05 }, '#d28a55'),
];

const gunnerusModel = [
  box('hull', 'Aft hull', { x: 9.20, y: 12.00, z: 2.55 }, { x: 0, y: -10.2, z: -1.425 }),
  box('hull', 'Mid hull', { x: 9.65, y: 14.00, z: 2.70 }, { x: 0, y: 0.0, z: -1.35 }),
  box('hull', 'Bow hull', { x: 6.70, y: 11.50, z: 2.45 }, { x: 0, y: 11.8, z: -1.225 }),
  box('deck', 'Main and work deck', { x: 9.45, y: 30.20, z: 0.14 }, { x: 0, y: -0.8, z: 1.50 }, '#72999b'),
  box('superstructure', 'Laboratory superstructure', { x: 7.20, y: 8.80, z: 2.90 }, { x: 0, y: -5.0, z: 3.02 }, '#7ca5a8'),
  box('bridge', 'Bridge', { x: 8.05, y: 4.70, z: 1.45 }, { x: 0, y: 0.2, z: 5.195 }, '#8ab0b0'),
  box('workdeck', 'Aft scientific work deck', { x: 8.60, y: 8.60, z: 0.10 }, { x: 0, y: -12.1, z: 1.62 }, '#5c898b'),
  box('mast', 'Main mast to published mast height', { x: 0.28, y: 0.28, z: 8.93 }, { x: 0, y: -0.2, z: 10.385 }, '#a4bdba'),
  box('sensor', 'Navigation sensor bar', { x: 4.10, y: 0.28, z: 0.18 }, { x: 0, y: -0.2, z: 8.10 }, '#d0b264'),
  box('sensor', 'Radar platform', { x: 2.10, y: 0.85, z: 0.16 }, { x: 0, y: -0.2, z: 14.70 }, '#d0b264'),
  box('antenna', 'Antenna to published antenna height', { x: 0.10, y: 0.10, z: 4.85 }, { x: 0, y: -0.2, z: 17.275 }, '#d0b264'),
  box('azipod', 'Port azimuth propulsion unit', { x: 0.70, y: 1.50, z: 0.68 }, { x: -2.35, y: -15.35, z: -2.35 }, '#d28a55'),
  box('azipod', 'Starboard azimuth propulsion unit', { x: 0.70, y: 1.50, z: 0.68 }, { x: 2.35, y: -15.35, z: -2.35 }, '#d28a55'),
  box('thruster', 'Bow tunnel-thruster zone', { x: 5.20, y: 0.55, z: 0.55 }, { x: 0, y: 13.65, z: -1.70 }, '#d28a55'),
];

export const VESSEL_MODELS = Object.freeze([
  Object.freeze({
    id: 'ntnu-milliampere1',
    name: 'NTNU milliAmpere1',
    shortName: 'milliAmpere1',
    kind: 'ntnu-electric-ferry',
    segment: 'small-electric-ferry',
    description: 'NTNU electric autonomous-ferry prototype: the smaller complete low-detail engineering massing model.',
    dimensionsM: Object.freeze({
      length: 5.0, beam: 2.8, draught: 0.2, airDraught: 3.3,
      zMin: milliAmpereDatum.zMinM, zMax: milliAmpereDatum.zMaxM,
      height: milliAmpereDatum.verticalExtentM,
    }),
    published: Object.freeze({
      lightWeightKg: 1800,
      maxPassengers: 6,
      propulsionUnits: 2,
      propulsionUnitW: 2000,
      operatingSpeedKn: 3,
      maxSpeedKn: 5,
      dcBusV: 24,
      installedEnergyWh: 24000,
      statedEnduranceH: 6,
    }),
    missionDefaults: Object.freeze({
      referenceMassKg: 1800,
      payloadKg: 450,
      designSpeedKn: 5,
      serviceSpeedKn: 3,
      headCurrentKn: 0,
      headwindKn: 5,
      propulsionAtDesignW: 4000,
      hotelW: 250,
      durationH: 6,
      seaState: 'calm',
    }),
    policyId: 'marine-full-electric',
    mounting: Object.freeze({
      id: 'below-deck', name: 'Below deck',
      what: 'The NTNU description places batteries, chargers and thruster drives below deck. Exact battery-compartment dimensions were not published, so the visual seat is indicative and fit remains unproven.',
    }),
    // Indicative waterline-relative position. Compartment fit remains unproven.
    packSeatM: Object.freeze({ x: 0, y: 0, z: 0.22 }),
    model: Object.freeze({
      version: VESSEL_MODEL_VERSION,
      kind: 'engineering-massing',
      boundary: MODEL_BOUNDARY,
      datum: milliAmpereDatum,
      primitives: Object.freeze(milliAmpereModel),
    }),
    evidence: Object.freeze({
      title: 'milliAmpere: An Autonomous Ferry Prototype',
      url: 'https://torarnj.folk.ntnu.no/icmass%20milliampere%202022.pdf',
      basis: 'Published length, beam, draught, air draught, light weight, passenger count, two 2 kW azimuth thrusters, speed, 24 V/24 kWh battery and stated endurance.',
    }),
    boundary: 'The original published battery is lead-acid VRLA. Any lithium pack shown here is a replacement study, not the vessel as built. Hotel load is a visible provisional input.',
  }),
  Object.freeze({
    id: 'ntnu-gunnerus',
    name: 'NTNU R/V Gunnerus',
    shortName: 'R/V Gunnerus',
    kind: 'ntnu-research-vessel',
    segment: 'research-vessel',
    description: 'The research vessel used by the TwinShip co-simulation demonstrator: the larger complete low-detail engineering massing model.',
    dimensionsM: Object.freeze({
      length: 36.25, beam: 9.90, draught: 2.70, mouldedDepth: 4.20,
      mastHeight: 14.85, antennaHeight: 19.70,
      zMin: gunnerusDatum.zMinM, zMax: gunnerusDatum.zMaxM,
      height: gunnerusDatum.verticalExtentM,
    }),
    published: Object.freeze({
      waterlineLengthM: 24.90,
      deadweightKg: 72000,
      propulsionUnits: 2,
      propulsionUnitW: 500000,
      generatorUnits: 3,
      generatorUnitW: 450000,
      bowThrusterW: 200000,
      cruisingSpeedKn: 10,
      maxSpeedKn: 12.6,
    }),
    missionDefaults: Object.freeze({
      // NTNU publishes deadweight, not displacement/lightship mass.  Null is
      // deliberate: marineDuty disables its payload mass correction rather
      // than substituting deadweight for vessel mass.
      referenceMassKg: null,
      payloadKg: 0,
      designSpeedKn: 12.6,
      serviceSpeedKn: 10,
      headCurrentKn: 0,
      headwindKn: 5,
      propulsionAtDesignW: 1000000,
      hotelW: 0,
      durationH: 1,
      seaState: 'calm',
    }),
    policyId: 'marine-load-levelling',
    mounting: Object.freeze({
      id: 'machinery-space-study', name: 'Machinery-space study position',
      what: 'A low central study position for comparing a battery concept with the diesel-electric power plant. No Gunnerus battery-compartment dimensions were published.',
    }),
    // Indicative waterline-relative position. Compartment fit remains unproven.
    packSeatM: Object.freeze({ x: 0, y: 1.0, z: -1.50 }),
    model: Object.freeze({
      version: VESSEL_MODEL_VERSION,
      kind: 'engineering-massing',
      boundary: MODEL_BOUNDARY,
      datum: gunnerusDatum,
      primitives: Object.freeze(gunnerusModel),
    }),
    evidence: Object.freeze({
      title: 'R/V Gunnerus technical specifications after the 2019 lengthening',
      url: 'https://www.ntnu.edu/documents/1262202806/0/Specifications%2BRV%2BGUNNERUS.pdf/6a6540e0-00ae-b7a2-a51d-bf365302bf61?t=1584611463564',
      basis: 'Published length, beam, moulded depth, draught, separate 14.85 m mast and 19.70 m antenna heights, deadweight, two 500 kW azimuth units, three 450 kW generators, 200 kW bow thruster and speeds.',
      sourceReconciliation: Object.freeze({
        status: 'conflicting-published-values',
        selectedBasis: 'The current NTNU technical sheet for the vessel after its 2019 lengthening is used for this versioned massing model.',
        alternateSource: Object.freeze({
          title: 'Co-simulation as a Fundamental Technology for Twin Ships — Table 2',
          url: 'https://www.mic-journal.no/PDF/2020/MIC-2020-4-2.pdf',
        }),
        differences: Object.freeze([
          Object.freeze({ field: 'waterlineLengthM', selectedValue: 24.90, alternateValue: 29.90, unit: 'm' }),
          Object.freeze({ field: 'deadweightKg', selectedValue: 72000, alternateValue: 165000, unit: 'kg' }),
        ]),
        releaseRequirement: 'Resolve these published-source differences with the vessel owner and controlled as-built particulars before using either value for release engineering.',
      }),
    }),
    boundary: 'TwinShip modelled the diesel-electric vessel and recorded operations. It did not publish a production battery retrofit; the battery shown here is a governed design scenario.',
  }),
]);

export function vesselModelById(id) {
  return VESSEL_MODELS.find((vessel) => vessel.id === id) || null;
}

export function defaultVesselModel() {
  return VESSEL_MODELS[0];
}

export function marineInputsForVessel(id, overrides = {}) {
  const vessel = vesselModelById(id) || defaultVesselModel();
  return { ...vessel.missionDefaults, ...overrides, vesselId: vessel.id };
}
