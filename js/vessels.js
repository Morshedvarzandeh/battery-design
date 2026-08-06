// vessels.js — the two vessels in the marine workspace.
//
// These are not invented "boat classes".  Their overall dimensions and the
// named propulsion facts come from public NTNU material:
//
//   · milliAmpere1 — the 5 m electric autonomous-ferry prototype.
//   · R/V Gunnerus — the research vessel used by the TwinShip demonstrator.
//
// Visual geometry lives in the reusable assets3d library. This module binds an
// evidence-governed vessel study to a versioned original asset; the renderer
// only consumes the resulting portable payload.
//
// Published particulars are facts.  Mission defaults marked provisional are
// inputs for a screening calculation and must be replaced by a measured power
// trace or a vessel resistance/shaft-power curve for engineering release.

import { fixedAsset3dById, VESSEL_ASSET_IDS } from '../assets3d/catalog.js';

export const VESSEL_MODEL_VERSION = '2026.08.5';

const MODEL_BOUNDARY = 'Original low-poly game visualization, not CAD. The asset communicates vessel class, named visible systems and the sourced outer vertical envelope; it is not hull-offset data, compartment geometry, a class drawing or construction geometry.';

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

const milliAmpereAsset = fixedAsset3dById(VESSEL_ASSET_IDS.milliAmpere1);
const gunnerusAsset = fixedAsset3dById(VESSEL_ASSET_IDS.gunnerus);

const bindVisualAsset = (visualAsset, datum) => Object.freeze({
  ...visualAsset,
  // The study identity and evidence boundary remain in this module; the
  // reusable asset contributes visual geometry and explicit licence data.
  version: `${VESSEL_MODEL_VERSION}+asset-${visualAsset.version}`,
  kind: 'engineering-massing',
  boundary: MODEL_BOUNDARY,
  datum,
});

const milliAmpereModel = bindVisualAsset(milliAmpereAsset, milliAmpereDatum);
const gunnerusModel = bindVisualAsset(gunnerusAsset, gunnerusDatum);

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
      ...milliAmpereModel,
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
      ...gunnerusModel,
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
