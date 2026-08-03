// Families — sixteen machines, eight kinds of machine.
//
// A flat grid of every application asks the customer to scan the lot and work
// out which is theirs. The picker groups them instead. These tests guard the
// thing that would silently break it: an application filed under no family is
// invisible in the interface, however well it works underneath.
import { test } from 'node:test';
import { ok } from './helpers.mjs';
import { FAMILIES, familyById, familyOfApp, presetsInFamily, familyIndex, validateFamilies } from '../js/families.js';
import { PRESETS } from '../js/presets.js';
import { appClassOf } from '../js/markets.js';
import { designFromSpec } from '../js/api.js';

test('every application is filed exactly once', () => {
  const errors = validateFamilies();
  ok(errors.length === 0, `no application is orphaned or duplicated: ${errors.join('; ')}`);
  const total = FAMILIES.reduce((n, f) => n + f.appIds.length, 0);
  ok(total === PRESETS.length, `all ${PRESETS.length} presets are reachable through the picker`);
});

test('each family explains itself and resolves its members', () => {
  for (const f of familyIndex()) {
    ok(f.icon && f.name && f.what.length > 40, `${f.id}: named, iconed and explained`);
    ok(f.members.length === f.appIds.length, `${f.id}: every member resolves to a real preset`);
    ok(f.energySpanWh && f.energySpanWh[0] <= f.energySpanWh[1], `${f.id}: reports its energy span`);
  }
  ok(familyById('robotics') && familyById('nope') === null, 'lookup');
});

test('robotics holds the four kinds of robot, quadrupeds included', () => {
  const bots = presetsInFamily('robotics').map((p) => p.id);
  ok(bots.length === 4, `four types (${bots.join(', ')})`);
  for (const id of ['robot', 'humanoid', 'cyberdog', 'robovac']) ok(bots.includes(id), `${id} is in robotics`);
  ok(familyOfApp('cyberdog').id === 'robotics', 'a quadruped is found from its application id');
  ok(familyOfApp('nonexistent') === null, 'an unknown application belongs to no family');
});

test('the quadruped is a real, fully worked application', () => {
  const d = designFromSpec({ application: 'cyberdog' });
  ok(d.pack.energyWh > 100 && d.pack.energyWh < 1500, `a hot-swap-sized pack (${d.pack.energyWh.toFixed(0)} Wh)`);
  ok(d.application.class === appClassOf('cyberdog'), 'it has a release class like every other application');
  ok(d.simulation?.profile?.name && /quadruped|patrol/i.test(d.simulation.profile.name),
    'and its own load profile — standing, trotting, and the jump that sets peak current');
  ok(d.architecture.comms?.primary, 'with an explicit comms mapping');
  ok(!/undefined|NaN/.test(JSON.stringify(d.pack)), 'no gaps in the pack it produces');
  // Peak matters more than energy here — that is the whole character of the machine.
  const preset = PRESETS.find((p) => p.id === 'cyberdog');
  ok(preset.peakPowerW / preset.contPowerW >= 5, 'peak is many times continuous, as a jumping machine demands');
});

test('a family that spans two rulebooks says so', () => {
  const idx = familyIndex();
  const mixed = idx.filter((f) => f.mixedClasses);
  for (const f of mixed) ok(f.classes.length > 1, `${f.id} really does span ${f.classes.join(' and ')}`);
  // Robotics is the interesting one: a lift truck and a robot vacuum do not
  // answer to the same standards, and pretending otherwise would be a lie.
  const bots = idx.find((f) => f.id === 'robotics');
  ok(bots.mixedClasses, 'robotics spans industrial and portable, and the picker admits it');
});
