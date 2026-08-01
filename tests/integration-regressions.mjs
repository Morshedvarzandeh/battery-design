// Integration regressions — "when the person speaks about one application,
// the things which are not related are omitted." These tests walk EVERY
// application and assert cross-module coherence: profiles, standards list,
// checklist class, comms, climate, chemistry preferences and the LV/HV
// architecture behavior must all tell the same story. A new preset or
// standard that is not classified FAILS here — integration is enforced,
// not hoped for.
import { PRESETS } from '../js/presets.js';
import { CELLS, CHEMISTRIES, cellById } from '../js/cells.js';
import { profileForApp, profilesForApp } from '../js/loadprofiles.js';
import { MARKETS, releaseChecklist, appClassOf, CLASS_OF_APP } from '../js/markets.js';
import {
  COMMS_BY_APP, commsForApp, buildArchitecture, modulePartition, bmsArchitecture,
} from '../js/architecture.js';
import { STANDARDS_INFO, STANDARD_CLASSES, standardsForClass } from '../js/standards.js';
import { INDOOR_APPS } from '../js/seasons.js';
import { euChecks } from '../js/eurules.js';

let fails = 0;
const ok = (c, m) => { if (!c) { console.error('FAIL:', m); fails++; } };

const VALID_CLASSES = new Set(['vehicle', 'lmt', 'stationary', 'marine', 'industrial', 'portable', 'auxiliary']);

// --- every application is fully integrated ----------------------------------
for (const pr of PRESETS) {
  const cls = appClassOf(pr.id);
  ok(VALID_CLASSES.has(cls), `${pr.id}: classified (${cls})`);
  // Its own profile, and the recommendation list starts with it.
  const def = profileForApp(pr.id);
  ok(def && def.appIds.includes(pr.id), `${pr.id}: default profile belongs to it`);
  ok(profilesForApp(pr.id)[0]?.id === def.id, `${pr.id}: recommendation list starts with its default`);
  // Its own communication entry — not the generic fallback.
  ok(COMMS_BY_APP[pr.id] != null, `${pr.id}: has an explicit comms mapping`);
  // A release checklist in every market, transport gate always present.
  for (const m of MARKETS) {
    const cl = releaseChecklist({ market: m.id, application: pr.id, chemistry: pr.preferredChemistries[0] });
    ok(cl.applicationClass === cls, `${pr.id}×${m.id}: checklist uses the same class`);
    ok(cl.items.some((i) => i.code === 'UN 38.3'), `${pr.id}×${m.id}: UN 38.3 present`);
  }
  // Chemistry preferences are real chemistries.
  for (const c of pr.preferredChemistries) ok(CHEMISTRIES[c] != null, `${pr.id}: chemistry ${c} exists`);
  // EU checks never crash and always answer.
  ok(euChecks({
    energyWh: pr.typicalEnergyWh, application: pr.id,
    chemistry: pr.preferredChemistries[0], commsPrimary: commsForApp(pr.id).primary,
  }).length > 0, `${pr.id}: EU applicability answers`);
}

// --- the standards reference list follows the application -------------------
{
  // Every listed standard must be classified — a new entry fails until it is.
  for (const s of STANDARDS_INFO) {
    const c = STANDARD_CLASSES[s.id];
    ok(Array.isArray(c) && c.length > 0, `standard ${s.id} is classified`);
    ok(c.every((x) => x === 'all' || VALID_CLASSES.has(x)), `standard ${s.id} classes valid`);
  }
  const codes = (cls) => standardsForClass(cls).map((s) => s.id);
  // A vacuum robot (portable) never advertises vehicle or grid rules.
  const portable = codes('portable');
  ok(!portable.includes('ece-r100') && !portable.includes('ul2580') && !portable.includes('ul9540'),
    'portable list omits vehicle/grid standards');
  ok(portable.includes('un383') && portable.includes('iec62133-2'),
    'portable keeps transport + portable safety');
  // A vehicle never advertises grid-storage listing rules; a boat gets its own.
  const vehicle = codes('vehicle');
  ok(vehicle.includes('ece-r100') && !vehicle.includes('ul9540') && !vehicle.includes('abyc-e13'),
    'vehicle list is vehicle-shaped');
  ok(codes('marine').includes('abyc-e13'), 'marine gets ABYC E-13');
  ok(codes('stationary').includes('ul9540a'), 'stationary gets UL 9540A');
  for (const cls of VALID_CLASSES) ok(codes(cls).length >= 4, `${cls} list is non-trivial`);
  // The 'all' basics appear everywhere.
  for (const cls of VALID_CLASSES) ok(codes(cls).includes('un383'), `${cls} keeps UN 38.3`);
}

// --- indoor machines never see a Nordic winter ------------------------------
{
  for (const id of ['robovac', 'robot', 'humanoid', 'ups']) ok(INDOOR_APPS.has(id), `${id} is indoor`);
  for (const id of ['ev', 'ebus', 'marine', 'rv', 'ebike']) ok(!INDOOR_APPS.has(id), `${id} is outdoor`);
}

// --- LV/HV architecture coherence -------------------------------------------
{
  const cyl = cellById('samsung-inr21700-50e');
  const lvSummary = {
    cellCount: 16, nominalV: 4 * cyl.nominalV, vMax: 4 * cyl.vMax, vMin: 4 * cyl.vMin,
    energyWh: 16 * cyl.nominalV * cyl.capacityAh, maxContCurrentA: 4 * cyl.maxContDischargeA,
  };
  const lv = buildArchitecture({ cell: cyl, s: 4, p: 4, summary: lvSummary, options: {} });
  ok(lv.precharge === null, 'LV pack omits the precharge chain entirely');
  ok(lv.isolation === null, 'LV pack omits the isolation floor');
  ok(lv.contactors.lvNote != null, 'LV pack carries the solid-state disconnect note');
  const hvSummary = {
    cellCount: 192, nominalV: 96 * cyl.nominalV, vMax: 96 * cyl.vMax, vMin: 96 * cyl.vMin,
    energyWh: 192 * cyl.nominalV * cyl.capacityAh, maxContCurrentA: 2 * cyl.maxContDischargeA,
  };
  const hv = buildArchitecture({ cell: cyl, s: 96, p: 2, summary: hvSummary, options: { isolationStandard: 'ece-r100' } });
  ok(hv.precharge != null && hv.isolation != null, 'HV pack keeps precharge + isolation');
}

// --- the 30-channel case: a fixed module gets its TWO slaves ----------------
{
  const cyl = cellById('samsung-inr21700-50e');
  // Mechanics fix a 30S module in a 60S pack; AFEs are 16-channel.
  const part = modulePartition(60, 2, cyl, { channelsPerIc: 16, sModOverride: 30 });
  ok(part.sMod === 30 && part.nModules === 2, `explicit 30S module honored (got ${part.nModules}x${part.sMod}S)`);
  ok(part.notes.some((n) => /2 AFE ICs/.test(n)), 'multi-slave module explained');
  const bms = bmsArchitecture({ s: 60, cellCount: 120, partition: part, topology: 'master-slave', channelsPerIc: 16 });
  ok(bms.afePerModule === 2, `each 30S module carries 2 slave AFEs (got ${bms.afePerModule})`);
  ok(bms.afeTotal === 4, `60S over 30S modules -> 4 AFEs total (got ${bms.afeTotal})`);
  // Invalid override falls back honestly.
  const bad = modulePartition(60, 2, cyl, { channelsPerIc: 16, sModOverride: 7 });
  ok(60 % bad.sMod === 0 && bad.notes.some((n) => /does not divide/.test(n)),
    'non-divisor override rejected with a note, auto partition used');
  // Centralized 30S with 16-channel AFEs also rounds up.
  const ctp = modulePartition(30, 1, cyl, { channelsPerIc: 16 });
  const cbms = bmsArchitecture({ s: 30, cellCount: 30, partition: ctp, topology: 'centralized', channelsPerIc: 16 });
  ok(cbms.afeTotal === 2, `centralized 30S @16ch -> 2 AFEs (got ${cbms.afeTotal})`);
}

// --- off-preference detection data is consistent ----------------------------
{
  // Every cell chemistry that max-fill can surface exists in CHEMISTRIES, so
  // the off-preference chip can always resolve.
  for (const c of CELLS) ok(CHEMISTRIES[c.chemistry] != null, `${c.id} chemistry known`);
  // CLASS_OF_APP and PRESETS agree exactly — no orphan on either side.
  const presetIds = new Set(PRESETS.map((p) => p.id));
  for (const id of Object.keys(CLASS_OF_APP)) ok(presetIds.has(id), `classified app ${id} exists as a preset`);
  for (const id of presetIds) ok(CLASS_OF_APP[id] != null, `preset ${id} is classified`);
}

console.log(fails === 0 ? 'INTEGRATION REGRESSIONS PASSED' : `${fails} FAILURES`);
process.exit(fails ? 1 : 0);
