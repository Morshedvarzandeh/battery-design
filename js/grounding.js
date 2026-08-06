// grounding.js — where the fault current goes, and whether it can get there.
//
// Isolation is the question everyone asks: how many megohms between the live
// parts and the case. Bonding is the question that decides whether anyone
// survives when isolation fails, and it is asked far less often.
//
// The two are not alternatives, they are the two halves of one argument:
//
//   ISOLATION keeps fault current from reaching the case at all. The tool
//   already resolves that floor from the declared road-vehicle bus topology:
//   100 Ω/V for the UN R100 DC case and 500 Ω/V for the AC case. Those values
//   are not competing standards and are never inferred from charger coupling.
//
//   BONDING assumes isolation has already failed. Every metal part a person
//   can touch must be tied together and to the reference well enough that
//   (a) they never sit at different potentials, and (b) the fault current is
//   big enough to blow something before it is big enough to hurt someone.
//
// A bonding path that is merely present is not a bonding path. It has to be
// low enough in resistance to hold the touch voltage down, and thick enough
// to survive the fault current until protection clears — and those two pull
// in the same direction, which is why one strap usually answers both.
//
// The classic ways this goes wrong, all of which this checks:
//
//   · The enclosure is anodised. Anodising is an insulator. A bolt through an
//     anodised housing is a mechanical joint, not an electrical one, and the
//     "ground" everybody assumed exists does not.
//   · The bond is a stainless fastener. Stainless is forty times the
//     resistance of copper and was chosen for corrosion, not conduction.
//   · The path is long and thin because it was routed last, after everything
//     that mattered had already been placed.
//   · The machine is a boat. Marine DC is conventionally UNGROUNDED, and
//     applying automotive bonding rules to it is not conservative — it is
//     wrong, and the tool says so rather than quietly grading it as a failure.
//
// Read from the same connection graph the wiring study uses. No new input.
//
// Pure math, no DOM.

import { materialById, conductorResistance, adiabaticK } from './materials.js';
import { appClassOf } from './markets.js';

// The continuity limit for exposed conductive parts a person can touch at the
// same time. This one IS sourced — ISO 6469-3 and UN ECE R100 both put it at
// 0.1 Ω, measured with at least 0.2 A flowing, which is the point: a
// microhmmeter reading taken at no current can be fooled by a film that
// breaks down under load, and the test current is there to defeat exactly
// that. The tool records the current with the limit so the number is never
// quoted without the condition that makes it meaningful.
export const BONDING_LIMIT = {
  maxOhm: 0.1,
  testCurrentA: 0.2,
  source: 'ISO 6469-3 / UN ECE R100 — resistance between exposed conductive parts',
  why: 'Two metal parts a person can touch together must be at the same potential. 0.1 Ω is what keeps them there while a fault is flowing.',
};

// Above this, a DC potential is a shock hazard rather than an inconvenience.
// It is the same 60 V boundary the architecture module already uses to decide
// whether HVIL and isolation monitoring apply, kept consistent on purpose.
export const TOUCH_VOLTAGE_LIMIT_V = 60;

// How the enclosure is finished, and whether that finish conducts. This is
// the single most common way a bonding path turns out not to exist.
export const SURFACE_FINISHES = {
  bare: { conducts: true, name: 'Bare or machined', what: 'Clean metal against clean metal. Conducts, and corrodes unless sealed.' },
  'conversion-coated': {
    conducts: true, name: 'Conversion coated (chromate / Alodine)',
    what: 'A thin conductive film that resists corrosion. The finish specified when a surface must both survive and conduct.',
  },
  anodised: {
    conducts: false, name: 'Anodised',
    what: 'A hard oxide layer, and an EXCELLENT insulator. An anodised housing is not a bonding path, however many bolts go through it.',
  },
  painted: {
    conducts: false, name: 'Painted or powder-coated',
    what: 'Insulating. The paint must be masked at every bonding point, or cut through by a serrated washer, for the joint to conduct at all.',
  },
};

// What actually makes the connection at a bonding point.
export const BOND_METHODS = {
  'bolt-plain': { cutsFinish: false, name: 'Plain bolt and washer', what: 'Clamps, but does not break through a coating. Only a bond if the surface under it already conducts.' },
  'bolt-serrated': { cutsFinish: true, name: 'Bolt with serrated / star washer', what: 'The teeth bite through paint or oxide into the metal beneath. The standard answer for bonding to a coated housing.' },
  welded: { cutsFinish: true, name: 'Welded or brazed', what: 'The most reliable bond there is: no interface to corrode, loosen or oxidise.' },
  'strap-bolted': { cutsFinish: false, name: 'Bolted braid strap', what: 'A flexible bond across a joint that moves. Only as good as the two surfaces it lands on.' },
};

/**
 * One bonding path, checked against both things it has to do.
 *
 * `faultA` is the prospective fault current the path would carry, and
 * `clearingS` how long protection takes to cut it. Without both, the
 * fault-survival half cannot be answered, and the result says so rather than
 * assuming a comfortable number.
 */
export function assessBond({
  id, from = 'enclosure', to = 'chassis',
  materialId = 'copper', lengthMm, areaMm2,
  finish = 'bare', method = 'bolt-serrated',
  faultA = null, clearingS = null, kAdiabatic = null,
}) {
  const mat = materialById(materialId);
  const surf = SURFACE_FINISHES[finish] || SURFACE_FINISHES.bare;
  const meth = BOND_METHODS[method] || BOND_METHODS['bolt-serrated'];
  if (!mat || !(areaMm2 > 0) || !(lengthMm > 0)) return null;
  // Derived from the strap's OWN material. Borrowing copper's 226 for a
  // stainless bond declares it four times stronger than it is.
  const k = kAdiabatic ?? adiabaticK(materialId);

  const resistanceOhm = conductorResistance({ materialId, lengthM: lengthMm / 1000, areaMm2 });
  // A finish that does not conduct is only survivable if the method breaks
  // through it. This is a yes/no that overrides every other number: an
  // immaculate 2 mΩ strap bolted flat to an anodised face conducts nothing.
  const finishBlocks = !surf.conducts && !meth.cutsFinish;

  // Touch voltage, if we know what current would flow. This is the number the
  // 0.1 Ω limit exists to hold down, so it is worth showing directly.
  const touchV = faultA != null ? faultA * resistanceOhm : null;
  // Fault survival by the same adiabatic rule the short-circuit study uses:
  // over a clearing time nothing has time to cool, so I²t ≤ (k·A)².
  const i2t = faultA != null && clearingS != null ? faultA * faultA * clearingS : null;
  const i2tLimit = Math.pow(k * areaMm2, 2);
  const survivesFault = i2t != null ? i2t <= i2tLimit : null;
  // The section that would survive it, for when it does not.
  const needAreaMm2 = i2t != null && !survivesFault ? Math.sqrt(i2t) / k : null;

  const overLimit = resistanceOhm > BONDING_LIMIT.maxOhm;
  const overTouch = touchV != null && touchV > TOUCH_VOLTAGE_LIMIT_V;

  let verdict = 'workable', why;
  if (finishBlocks) {
    verdict = 'not-workable';
    why = `${surf.name.toLowerCase()} against ${meth.name.toLowerCase()}: this is not a bonding path at all. `
      + `${surf.what} The strap itself measures ${(resistanceOhm * 1000).toFixed(2)} mΩ, which is irrelevant while the surface under it insulates. `
      + `Use a serrated washer to cut through, mask the finish at the bonding point, or weld the bond.`;
  } else if (overLimit) {
    verdict = resistanceOhm > BONDING_LIMIT.maxOhm * 3 ? 'not-workable' : 'workable-with-costs';
    const need = (conductorResistance({ materialId, lengthM: lengthMm / 1000, areaMm2 }) / BONDING_LIMIT.maxOhm) * areaMm2;
    why = `${(resistanceOhm * 1000).toFixed(1)} mΩ against the ${(BONDING_LIMIT.maxOhm * 1000).toFixed(0)} mΩ limit, over ${lengthMm.toFixed(0)} mm of ${areaMm2.toFixed(1)} mm² ${mat.name.toLowerCase()}. `
      + `It needs about ${need.toFixed(1)} mm², a shorter route, or a better conductor than ${mat.name.toLowerCase()}.`;
  } else if (overTouch) {
    verdict = 'not-workable';
    why = `${(resistanceOhm * 1000).toFixed(1)} mΩ is inside the continuity limit, but at ${faultA.toFixed(0)} A of fault current it puts ${touchV.toFixed(0)} V `
      + `on the case — past the ${TOUCH_VOLTAGE_LIMIT_V} V DC shock boundary. Continuity is not the only requirement; the path has to hold the potential down while the fault flows.`;
  } else if (survivesFault === false) {
    verdict = 'not-workable';
    why = `${(resistanceOhm * 1000).toFixed(1)} mΩ is a good bond, and it burns open before protection clears: ${faultA.toFixed(0)} A for ${(clearingS * 1000).toFixed(0)} ms `
      + `is ${i2t.toExponential(2)} A²s against a ${i2tLimit.toExponential(2)} A²s adiabatic limit for ${areaMm2.toFixed(1)} mm². `
      + `A bond that opens during the fault it exists for is worse than none, because everything downstream was designed believing it was there. It needs about ${needAreaMm2.toFixed(1)} mm².`;
  } else {
    why = `${(resistanceOhm * 1000).toFixed(1)} mΩ, inside the ${(BONDING_LIMIT.maxOhm * 1000).toFixed(0)} mΩ limit`
      + (survivesFault ? `, and ${areaMm2.toFixed(1)} mm² survives ${faultA.toFixed(0)} A for the ${(clearingS * 1000).toFixed(0)} ms protection needs.` : '.')
      + (survivesFault == null ? ' Fault survival is unproven — give a prospective fault current and a clearing time to close that half.' : '');
  }

  // A bond made of a structural metal passes the limit and is still the wrong
  // choice — the limit is generous enough to hide it. Worth saying whatever
  // the verdict, because nobody picks stainless for its conductivity.
  const structural = mat.kind !== 'conductor'
    ? `${mat.name} is a structural material, not a conductor: ${(mat.resistivityOhmM / 1.72e-8).toFixed(0)}× the resistance of copper, `
      + `and an adiabatic k of ${k.toFixed(0)} against copper's 226 — so it carries fault current ${(226 / k).toFixed(1)}× worse for the same section. `
      + `Nobody picks it for conduction; it usually ends up as the bond because it was the bracket that happened to be there.`
    : null;

  return {
    id, from, to, materialId, lengthMm, areaMm2, finish, method,
    resistanceOhm, limitOhm: BONDING_LIMIT.maxOhm, finishBlocks,
    touchV, touchLimitV: TOUCH_VOLTAGE_LIMIT_V,
    i2t, i2tLimit, adiabaticK: k, survivesFault, needAreaMm2, structural,
    verdict, why: structural ? `${why} ${structural}` : why,
  };
}

// Machines whose electrical system is conventionally UNGROUNDED. Applying a
// chassis-bonding rule to one of these is not being careful, it is being
// wrong: on a boat there is deliberately no bond to the hull, and an isolated
// (IT) system is monitored for the FIRST fault rather than protected against
// its consequences.
export const UNGROUNDED_CLASSES = {
  marine: {
    what: 'Marine DC systems are conventionally ungrounded, and deliberately so: a hull bond in salt water drives galvanic corrosion of everything below the waterline.',
    instead: 'The requirement is not a bonding path — it is insulation monitoring that alarms on the FIRST earth fault, while the system is still safe, so it can be fixed before a second fault makes a circuit. Bonding rules written for a chassis-referenced vehicle do not transfer.',
  },
};

/**
 * The fault the bonding path actually has to carry, taken from the
 * short-circuit study rather than asked for a second time.
 *
 * The subtlety worth stating: an HV traction pack is a FLOATING (IT) system,
 * deliberately referenced to nothing. A single isolation fault to the case
 * therefore draws almost no current — that is the entire reason isolation
 * monitoring exists, to catch that first fault while it is still harmless.
 *
 * The bonding path earns its keep on the SECOND fault, when a second point in
 * the string finds the case and the pack drives current through whatever the
 * two faults and the bond make into a circuit. So the current to size against
 * is not the first-fault current (near zero, and a trap) but the prospective
 * current of a dead short — the most the pack can source through anything.
 */
export function faultFromShortCircuit(shortCircuit) {
  const terminal = shortCircuit?.faults?.find((f) => f.kind?.id === 'terminal') || shortCircuit?.faults?.[0];
  const r = terminal?.result;
  if (!r?.prospectiveA) return null;
  return {
    faultA: r.prospectiveA,
    clearingS: r.fuseClearedAtS ?? r.durationS ?? null,
    basis: `Prospective current of a dead short (${(r.prospectiveA / 1000).toFixed(1)} kA), cleared in `
      + `${r.fuseClearedAtS != null ? `${(r.fuseClearedAtS * 1000).toFixed(1)} ms` : 'no stated time'}. `
      + `This is the SECOND-fault case: the pack floats, so one isolation fault to the case draws almost nothing and only trips the monitor. `
      + `The bond is sized for the second fault, when the pack drives its full prospective current through it.`,
  };
}

/**
 * The grounding study for a design.
 *
 * Reads the enclosure joint the topology already builds, adds the bonding
 * paths the customer describes, and answers the whole question — including
 * the case where the honest answer is that the question does not apply.
 */
export function groundingStudy({
  topology, application = null, packVMax = null, isolation = null,
  isolationMonitoring = null,
  bonds = null, faultA = null, clearingS = null, faultBasis = null,
  finish = 'bare', method = 'bolt-serrated', strapMaterial = 'copper',
}) {
  if (!topology) return null;
  const appClass = application ? appClassOf(application) : null;
  const ungrounded = appClass ? UNGROUNDED_CLASSES[appClass] : null;

  // Below 60 V DC there is no shock hazard to bond against, which is the same
  // boundary the architecture module uses to decide whether HVIL applies.
  const lowVoltage = packVMax != null && packVMax <= TOUCH_VOLTAGE_LIMIT_V;

  // Without a described bonding scheme, take the enclosure joint the topology
  // already knows about and size a representative strap from the pack
  // envelope — flagged as an estimate, exactly as the run lengths are.
  const estimated = !bonds;
  const paths = bonds || [{
    id: 'bond-enclosure', from: 'Pack enclosure', to: 'Chassis / vehicle earth',
    materialId: strapMaterial, lengthMm: 250, areaMm2: 16, finish, method,
  }];

  const assessed = paths
    .map((b) => assessBond({ faultA, clearingS, ...b }))
    .filter(Boolean);

  const failing = assessed.filter((b) => b.verdict === 'not-workable');
  const costly = assessed.filter((b) => b.verdict === 'workable-with-costs');
  const unproven = assessed.filter((b) => b.survivesFault == null);

  let verdict = failing.length ? 'not-workable' : costly.length ? 'workable-with-costs' : 'workable';
  if (ungrounded) verdict = 'unproven';
  else if (!failing.length && !costly.length && unproven.length) verdict = 'unproven';

  const findings = [];
  if (ungrounded) {
    findings.push({
      severity: 'warn', category: 'safety',
      title: 'This machine is conventionally ungrounded — bonding rules do not apply as written',
      detail: `${ungrounded.what} ${ungrounded.instead}`,
    });
    if (isolationMonitoring?.required === false) {
      findings.push({
        severity: 'warn', category: 'safety',
        title: 'Marine first-fault monitoring is not active in the architecture',
        detail: `The declared ungrounded boundary requires insulation-fault monitoring, but the architecture reports “${isolationMonitoring.status || 'unknown'}”. Resolve that architecture state before release; this bonding study cannot substitute for it.`,
      });
    }
  }
  if (lowVoltage) {
    findings.push({
      severity: 'info', category: 'safety',
      title: `At ${packVMax.toFixed(0)} V there is no shock hazard to bond against`,
      detail: `Below the ${TOUCH_VOLTAGE_LIMIT_V} V DC boundary, protective bonding is not a shock requirement. It may still be wanted for EMC, for static, or because a charger upstream is mains-referenced — but it is a design choice here, not a safety floor.`,
    });
  }
  // On an ungrounded machine these paths are being measured against a rule
  // the finding above has just said does not apply. Reporting them as hard
  // failures would contradict it, so they are demoted and captioned — the
  // numbers are still worth showing, as numbers rather than as verdicts.
  const caveat = ungrounded
    ? ' Shown for completeness: on an ungrounded system this is not a requirement, and sizing a bond to satisfy it may be the wrong move entirely.'
    : '';
  for (const b of failing) {
    findings.push({
      severity: ungrounded ? 'info' : 'fail', category: 'safety',
      title: b.finishBlocks ? `${b.id}: the surface it bolts to does not conduct` : `${b.id} is not an adequate bonding path`,
      detail: b.why + caveat,
    });
  }
  for (const b of costly) {
    findings.push({
      severity: ungrounded ? 'info' : 'warn', category: 'safety',
      title: `${b.id} is marginal`, detail: b.why + caveat,
    });
  }
  for (const b of assessed) {
    if (b.structural && b.verdict === 'workable') {
      findings.push({
        severity: 'warn', category: 'safety',
        title: `${b.id} is bonded with a structural metal`,
        detail: `${b.structural} It passes here because the 0.1 Ω limit is generous enough to hide the difference, not because it is the right metal for the job.`,
      });
    }
  }
  if (unproven.length && !ungrounded) {
    findings.push({
      severity: 'info', category: 'safety',
      title: 'Fault survival is unproven for every bonding path',
      detail: 'Continuity has been checked; whether the bond survives the current it would carry has not, because no prospective fault current and clearing time were given. The short-circuit study produces both — run it and feed them in, or the bond is only half checked.',
    });
  }
  if (estimated) {
    findings.push({
      severity: 'info', category: 'safety',
      title: 'The bonding scheme is assumed, not described',
      detail: 'One representative 250 mm strap of 16 mm² was assumed, because no bonding paths were given. Real machines have several, and the one that fails is usually the one nobody drew. Describe them and this becomes an answer rather than an illustration.',
    });
  }

  const worst = assessed.slice().sort((a, b) => b.resistanceOhm - a.resistanceOhm)[0] || null;

  return {
    verdict, paths: assessed, findings, ungrounded: !!ungrounded, lowVoltage, estimated,
    isolation: isolation || null,
    isolationMonitoring: isolationMonitoring || null,
    ontologyRuleId: isolation?.ontologyRule?.id || isolationMonitoring?.ontologyRuleId || null,
    totals: {
      pathsChecked: assessed.length,
      failing: failing.length, costly: costly.length, unproven: unproven.length,
      worstOhm: worst?.resistanceOhm ?? null,
      maxTouchV: assessed.reduce((m, b) => (b.touchV != null && b.touchV > m ? b.touchV : m), 0) || null,
    },
    headline: ungrounded
      ? 'This machine is conventionally ungrounded, so the bonding question is replaced by an insulation-monitoring one — the numbers below are shown for completeness, not as a verdict.'
      : worst
        ? `The weakest bonding path measures ${(worst.resistanceOhm * 1000).toFixed(1)} mΩ against a ${(BONDING_LIMIT.maxOhm * 1000).toFixed(0)} mΩ limit`
          + (worst.touchV != null ? `, putting ${worst.touchV.toFixed(0)} V on the case at ${faultA.toFixed(0)} A of fault current.` : '.')
        : 'No bonding paths to check.',
    assumptions: [
      ...(faultBasis ? [faultBasis] : []),
      `Continuity limit ${BONDING_LIMIT.maxOhm} Ω between exposed conductive parts, measured at ${BONDING_LIMIT.testCurrentA} A or more (${BONDING_LIMIT.source}). The test current matters: a film that reads open-circuit at no current can conduct under load, and one that reads fine can break down.`,
      `Touch-voltage boundary ${TOUCH_VOLTAGE_LIMIT_V} V DC — the same threshold the architecture model uses for HVIL and isolation monitoring.`,
      'Fault survival by the adiabatic rule I²t ≤ (k·A)², the same rule the short-circuit study applies to busbars: over a clearing time nothing cools.',
      'Bond resistance is the CONDUCTOR only. A real bonded joint adds contact resistance at both ends, which is the part that ages, loosens and corrodes — so treat this as the floor, and measure the built article.',
      'Isolation and bonding are separate requirements. Passing here says nothing about the isolation floor, which is sized in the architecture model against whichever standard governs.',
    ],
  };
}
