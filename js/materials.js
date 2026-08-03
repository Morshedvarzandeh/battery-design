// materials.js — what things are made of, in one place.
//
// Built as a foundation rather than a feature, because five things that are
// coming all need the same numbers and would otherwise each invent them:
//
//   wiring      resistivity and temperature coefficient, to size a conductor
//   grounding   the same, plus what makes an acceptable bonding path
//   corrosion   the galvanic series — which pairs of metals must not touch
//   runaway     density, specific heat and thermal conductivity
//   LCA         density and embodied CO₂ per kilogram
//
// Every one of those is a property of the MATERIAL, not of the feature using
// it. Putting them here means a busbar's resistivity is the same number in
// the fault study, the wiring check and the carbon footprint — and changing a
// value corrects all of them at once.
//
// The galvanic (anodic) index is the number that matters for corrosion: the
// further apart two metals sit, the harder the more-anodic one corrodes when
// they touch with any moisture present. The widely used engineering rule of
// thumb — 0.15 V for harsh environments, 0.25 V for normal, 0.50 V indoors and
// dry — is encoded in `galvanicRisk()` rather than left to memory.
//
// Pure data + queries, no DOM.

export const MATERIALS = [
  {
    id: 'copper', name: 'Copper (C110)', kind: 'conductor',
    resistivityOhmM: 1.72e-8, tempCoPerK: 0.00393,
    densityKgM3: 8960, specificHeatJkgK: 385, thermalWmK: 401,
    anodicIndexV: 0.35, meltingC: 1085,
    co2PerKg: 3.8,
    what: 'The default for busbars and cable. Best conductivity per cross-section of anything affordable, and the reference every other conductor is compared against.',
    watch: 'Heavy, and the price moves. Bare copper corrodes galvanically against aluminium — a joint between the two needs plating or a bimetal transition.',
  },
  {
    id: 'aluminium', name: 'Aluminium (1350/6101)', kind: 'conductor',
    resistivityOhmM: 2.82e-8, tempCoPerK: 0.00403,
    densityKgM3: 2700, specificHeatJkgK: 900, thermalWmK: 237,
    anodicIndexV: 0.90, meltingC: 660,
    co2PerKg: 11.5,
    what: 'A third of the mass of copper for the same current, at about 1.6× the cross-section. Standard for large pack busbars where volume is available and mass is not.',
    watch: 'Creeps under bolted pressure, so joints need Belleville washers. Grows an insulating oxide the moment it is exposed — joints must be prepared and sealed. Strongly anodic to copper.',
  },
  {
    id: 'nickel', name: 'Nickel strip (201)', kind: 'conductor',
    resistivityOhmM: 6.99e-8, tempCoPerK: 0.006,
    densityKgM3: 8900, specificHeatJkgK: 456, thermalWmK: 91,
    anodicIndexV: 0.30, meltingC: 1455,
    co2PerKg: 13.0,
    what: 'The strip that gets spot-welded to cylindrical cells. Chosen because it welds reliably to steel cans, not because it conducts well — it is four times the resistance of copper.',
    watch: 'That resistance is the point of failure in high-current cylindrical packs: undersized nickel is a heater. Copper-clad nickel exists for exactly this reason.',
  },
  {
    id: 'nickel-plated-copper', name: 'Nickel-plated copper', kind: 'conductor',
    resistivityOhmM: 1.78e-8, tempCoPerK: 0.00393,
    densityKgM3: 8940, specificHeatJkgK: 388, thermalWmK: 390,
    anodicIndexV: 0.30, meltingC: 1085,
    co2PerKg: 4.4,
    what: 'Copper with a nickel skin: copper conductivity, a weldable and corrosion-stable surface, and an anodic index close to nickel so it pairs better with steel cans.',
    watch: 'The plating is thin. Cut or abrade the edge and you expose bare copper exactly where the joint is.',
  },
  {
    id: 'steel-nickel-plated', name: 'Nickel-plated steel (cell can)', kind: 'structural',
    resistivityOhmM: 1.43e-7, tempCoPerK: 0.005,
    densityKgM3: 7850, specificHeatJkgK: 490, thermalWmK: 50,
    anodicIndexV: 0.30, meltingC: 1425,
    co2PerKg: 2.3,
    what: 'What a cylindrical cell can is made of. It appears here because every weld in the pack lands on it, and its resistance and galvanic index decide what may be welded to it.',
    watch: 'Poor conductor and poor heat spreader compared with the strip attached to it.',
  },
  {
    id: 'aluminium-housing', name: 'Aluminium housing (5000/6000 series)', kind: 'structural',
    resistivityOhmM: 3.99e-8, tempCoPerK: 0.0039,
    densityKgM3: 2700, specificHeatJkgK: 900, thermalWmK: 155,
    anodicIndexV: 0.90, meltingC: 610,
    co2PerKg: 8.6,
    what: 'The enclosure, and usually the chassis bonding path with it. Its thermal conductivity is why a housing doubles as a heat spreader.',
    watch: 'Anodising insulates: an anodised housing is not a bonding path, which surprises people who assumed the enclosure was earth.',
  },
  {
    id: 'stainless-304', name: 'Stainless steel (304)', kind: 'structural',
    resistivityOhmM: 7.2e-7, tempCoPerK: 0.001,
    densityKgM3: 8000, specificHeatJkgK: 500, thermalWmK: 16,
    anodicIndexV: 0.15, meltingC: 1400,
    co2PerKg: 6.1,
    what: 'Fasteners, straps and brackets where corrosion resistance matters more than conductivity.',
    watch: 'Forty times the resistance of copper — never a current path. Strongly cathodic to aluminium, so a stainless bolt through an aluminium bracket in a wet environment eats the bracket.',
  },
  {
    id: 'tin', name: 'Tin plating', kind: 'plating',
    resistivityOhmM: 1.09e-7, tempCoPerK: 0.0045,
    densityKgM3: 7310, specificHeatJkgK: 228, thermalWmK: 67,
    anodicIndexV: 0.65, meltingC: 232,
    co2PerKg: 17.1,
    what: 'The usual plating on bolted busbar joints and terminals: cheap, solderable, and it keeps copper from oxidising.',
    watch: 'Soft, so it cold-flows under bolt pressure and joints need re-torquing. Its index sits between copper and aluminium, which is exactly why it is used to join them.',
  },
];

export const materialById = (id) => MATERIALS.find((m) => m.id === id) || null;
export const conductors = () => MATERIALS.filter((m) => m.kind === 'conductor');

/** Resistivity at temperature: ρ(T) = ρ₂₀·(1 + α·(T − 20)). */
export function resistivityAt(id, tempC = 20) {
  const m = materialById(id);
  if (!m) return null;
  return m.resistivityOhmM * (1 + m.tempCoPerK * (tempC - 20));
}

/** Resistance of a run: R = ρ·L/A, with L in metres and A in mm². */
export function conductorResistance({ materialId, lengthM, areaMm2, tempC = 20 }) {
  const rho = resistivityAt(materialId, tempC);
  if (rho == null || !(areaMm2 > 0) || !(lengthM >= 0)) return null;
  return (rho * lengthM) / (areaMm2 * 1e-6);
}

/** Mass of a run, for the bill of materials and the carbon footprint. */
export function conductorMassKg({ materialId, lengthM, areaMm2 }) {
  const m = materialById(materialId);
  if (!m || !(areaMm2 > 0) || !(lengthM >= 0)) return null;
  return m.densityKgM3 * lengthM * areaMm2 * 1e-6;
}

/**
 * The adiabatic constant k, for "will this conductor survive the fault".
 *
 * Over the milliseconds a fault lasts nothing has time to cool, so all the
 * I²t goes into heating the metal, and a conductor survives while
 * I²t ≤ (k·A)². Handbooks publish k for a few insulation classes of copper —
 * 115, 143, 226 — and those three numbers get used for everything, including
 * conductors that are not copper.
 *
 * But k is not a handbook lookup, it is a property of the material and the
 * two temperatures. The IEC 60949 form is
 *
 *     k = √( Qc/(α₂₀·ρ₂₀) · ln((β + θf)/(β + θi)) ),   β = 1/α₂₀ − 20
 *
 * and every term is already in the table above. Computing it means a stainless
 * bonding strap is judged as stainless (k ≈ 46) instead of borrowing copper's
 * 226 and being declared four times stronger than it is.
 *
 * It reproduces the published copper values exactly — 115 for PVC (70→160),
 * 143 for XLPE (90→250), 228 for bare (30→500) — which is how we know the
 * derivation is right rather than merely plausible, and it is pinned by test.
 */
export function adiabaticK(id, { initialC = 30, finalC = 500 } = {}) {
  const m = materialById(id);
  if (!m || !(finalC > initialC)) return null;
  const volumetricHeat = m.densityKgM3 * m.specificHeatJkgK;   // J/(m³·K)
  const beta = 1 / m.tempCoPerK - 20;                          // K, reciprocal temp coefficient at 0 °C
  const k = Math.sqrt(
    (volumetricHeat / (m.tempCoPerK * m.resistivityOhmM)) * Math.log((beta + finalC) / (beta + initialC)),
  );
  return k / 1e6;                                              // A·√s per mm²
}

// Environment classes for the galvanic rule. The permitted difference in
// anodic index is what decides whether two metals may touch.
export const GALVANIC_LIMITS = {
  harsh: { maxDeltaV: 0.15, what: 'Salt spray, condensation, road spray — marine, underbody, anything washed.' },
  normal: { maxDeltaV: 0.25, what: 'Sheltered but not sealed: humidity and occasional condensation.' },
  dry: { maxDeltaV: 0.50, what: 'Indoors, controlled, sealed enclosure with no condensation.' },
};

/**
 * May these two metals touch in this environment?
 *
 * Corrosion needs an electrolyte, so a genuinely sealed dry joint tolerates a
 * pairing that would fail on a boat. The verdict names the metal that
 * corrodes, because "incompatible" without saying which one dissolves is not
 * an actionable answer.
 */
export function galvanicRisk(idA, idB, environment = 'normal') {
  const a = materialById(idA), b = materialById(idB);
  const limit = GALVANIC_LIMITS[environment] || GALVANIC_LIMITS.normal;
  if (!a || !b) return null;
  const delta = Math.abs(a.anodicIndexV - b.anodicIndexV);
  // The more anodic (higher index) metal is the one that corrodes.
  const sacrificial = a.anodicIndexV > b.anodicIndexV ? a : b;
  const noble = sacrificial === a ? b : a;
  const ok = delta <= limit.maxDeltaV;
  return {
    deltaV: delta, limitV: limit.maxDeltaV, environment,
    ok, sacrificial: sacrificial.id, noble: noble.id,
    verdict: ok ? 'workable' : delta <= limit.maxDeltaV * 2 ? 'workable-with-costs' : 'not-workable',
    why: delta === 0
      ? `${a.name} against itself — no galvanic couple at all.`
      : ok
        ? `${a.name} and ${b.name} differ by ${delta.toFixed(2)} V, inside the ${limit.maxDeltaV} V allowed for a ${environment} environment.`
        : `${a.name} and ${b.name} differ by ${delta.toFixed(2)} V, past the ${limit.maxDeltaV} V allowed here. With any moisture present the ${sacrificial.name.toLowerCase()} is the side that corrodes, at the joint, where the current has to pass. Plate the interface (tin sits between copper and aluminium for exactly this), use a bimetallic transition washer, or seal the joint so no electrolyte can reach it.`,
  };
}

/** Sanity for the tests: every material complete, every property positive. */
export function validateMaterials() {
  const errors = [];
  const seen = new Set();
  for (const m of MATERIALS) {
    if (seen.has(m.id)) errors.push(`duplicate material ${m.id}`);
    seen.add(m.id);
    for (const k of ['resistivityOhmM', 'densityKgM3', 'specificHeatJkgK', 'thermalWmK', 'anodicIndexV', 'meltingC', 'co2PerKg']) {
      if (!(m[k] > 0)) errors.push(`${m.id}: ${k} must be a positive number`);
    }
    if (!m.what || !m.watch) errors.push(`${m.id}: must say what it is for and what to watch`);
    if (!['conductor', 'structural', 'plating'].includes(m.kind)) errors.push(`${m.id}: unknown kind ${m.kind}`);
  }
  return errors;
}
