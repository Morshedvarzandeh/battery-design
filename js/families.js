// families.js — sixteen machines, eight kinds of machine.
//
// A flat grid of every application asks the customer to scan sixteen tiles
// and work out which one is theirs. That is fine at six and unusable at
// forty, and the list only grows. So the picker is two steps: choose the KIND
// of machine, then the model within it.
//
// The grouping is not cosmetic. Machines in a family share a physical story —
// four legs and twelve actuators, or a hull and a house bank — and usually
// share an application class, which means they share a release checklist. When
// a family's members disagree about their class, that is worth knowing, and a
// test says so rather than letting it pass unnoticed.
//
// Pure data + queries, no DOM.

import { PRESETS } from './presets.js';
import { appClassOf } from './markets.js';

export const FAMILIES = [
  {
    id: 'road', name: 'Road vehicles', icon: '🚗',
    what: 'Machines that carry people or freight on public roads, where type approval and crash rules decide as much as the physics.',
    appIds: ['ev', 'ebus'],
  },
  {
    id: 'lmt', name: 'Light electric mobility', icon: '🚲',
    what: 'Small personal machines. Light, cheap, and regulated as consumer products rather than vehicles — which is why a fire in one makes the news.',
    appIds: ['ebike', 'escooter'],
  },
  {
    id: 'robotics', name: 'Robotics', icon: '🤖',
    what: 'Machines that move themselves and do work. They span a huge range: a lift truck moves tonnes at walking pace, a quadruped jumps on a 300 Wh pack.',
    appIds: ['robot', 'humanoid', 'cyberdog', 'robovac'],
  },
  {
    id: 'storage', name: 'Stationary storage', icon: '🔋',
    what: 'Packs that never move. Cycle economics and grid interconnection matter; mass and volume barely do.',
    appIds: ['solar-ess', 'ups'],
  },
  {
    id: 'portable', name: 'Portable & tools', icon: '🧰',
    what: 'Hand-carried machines, from a watch to a power station. Sized by what a person will carry and by burst current, not by range.',
    appIds: ['powertool', 'powerstation', 'wearable'],
  },
  {
    id: 'aerial', name: 'Aerial', icon: '🛸',
    what: 'Anything that has to lift its own battery. Every gram costs flight time, so energy density beats cycle life — the only family where that trade goes this way.',
    appIds: ['drone'],
  },
  {
    id: 'marine', name: 'Marine', icon: '⛵',
    what: 'Boats. A class society, not a product standard, is the gate — and salt water changes every material decision.',
    appIds: ['marine'],
  },
  {
    id: 'leisure', name: 'Leisure & auxiliary', icon: '🚐',
    what: 'House banks in vehicles: not traction, not grid storage. Drop-in packs living with an inverter and a shore-power charger.',
    appIds: ['rv'],
  },
];

export const familyById = (id) => FAMILIES.find((f) => f.id === id) || null;

/** Which family does this application belong to? */
export function familyOfApp(appId) {
  return FAMILIES.find((f) => f.appIds.includes(appId)) || null;
}

/** The presets in a family, in the order the family declares them. */
export function presetsInFamily(id) {
  const fam = familyById(id);
  if (!fam) return [];
  return fam.appIds.map((a) => PRESETS.find((p) => p.id === a)).filter(Boolean);
}

/**
 * The families with their members resolved, ready to render — plus the
 * release classes each family spans, because a family whose members answer to
 * different rulebooks is a fact the customer should see, not a tidy lie.
 */
export function familyIndex() {
  return FAMILIES.map((f) => {
    const members = presetsInFamily(f.id);
    const classes = [...new Set(members.map((m) => appClassOf(m.id)).filter(Boolean))];
    return {
      ...f, members, classes,
      count: members.length,
      mixedClasses: classes.length > 1,
      energySpanWh: members.length
        ? [Math.min(...members.map((m) => m.typicalEnergyWh)), Math.max(...members.map((m) => m.typicalEnergyWh))]
        : null,
    };
  });
}

/**
 * Every preset must live in exactly one family. Checked by test: a new
 * application that nobody filed is invisible in the picker, which is a far
 * worse bug than a duplicate.
 */
export function validateFamilies() {
  const errors = [];
  const seen = new Map();
  for (const f of FAMILIES) {
    if (!f.name || !f.icon || !f.what) errors.push(`${f.id}: incomplete family`);
    if (!f.appIds.length) errors.push(`${f.id}: has no members`);
    for (const a of f.appIds) {
      if (!PRESETS.some((p) => p.id === a)) errors.push(`${f.id}: unknown application "${a}"`);
      if (seen.has(a)) errors.push(`"${a}" is in both ${seen.get(a)} and ${f.id}`);
      seen.set(a, f.id);
    }
  }
  for (const p of PRESETS) {
    if (!seen.has(p.id)) errors.push(`"${p.id}" belongs to no family — it would not appear in the picker`);
  }
  return errors;
}
