// mycells.js — customer-supplied cells that are NOT in the public library.
//
// PRIVACY CONTRACT (the whole point of this module):
//   - A customer's cell is stored in THEIR browser's localStorage only.
//     It is never uploaded anywhere, never added to the public database,
//     and never appears in the repository.
//   - "Send privately" opens the CUSTOMER'S OWN email client with the
//     datasheet JSON addressed to the maintainer — the data travels by
//     ordinary private email, nothing else sees it. The customer attaches
//     their datasheet PDF in the mail if they have one.
// Pure logic here; DOM wiring lives in app.js.

const STORE_KEY = 'bd-my-cells';

// Maintainer contact, assembled at runtime so address scrapers reading the
// public source don't harvest it.
export const OWNER_EMAIL = ['morshed', 'varzandeh'].join('.') + '@' + 'gmail' + '.com';

export function loadMyCells() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch { return []; }
}

export function saveMyCells(list) {
  localStorage.setItem(STORE_KEY, JSON.stringify(list));
}

// Turns the form values into a library-compatible cell record.
export function normalizeCustomCell(f) {
  const id = 'my-' + `${f.manufacturer}-${f.model}`.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  const dims = f.form === 'cylindrical'
    ? { d: +f.d, h: +f.h }
    : { w: +f.w, t: +f.t, h: +f.h };
  return {
    id,
    name: `${f.manufacturer} ${f.model} (yours)`,
    manufacturer: f.manufacturer, model: f.model,
    form: f.form,
    formFactor: f.form === 'cylindrical' ? `${Math.round(+f.d)}${Math.round(+f.h)}` : f.form,
    chemistry: f.chemistry,
    dims,
    massG: +f.massG,
    capacityAh: +f.capacityAh,
    nominalV: +f.nominalV, vMax: +f.vMax, vMin: +f.vMin,
    maxContDischargeA: +f.maxContDischargeA,
    maxPulseDischargeA: null,
    maxContChargeA: +f.maxContChargeA,
    dcirMOhm: f.dcirMOhm ? +f.dcirMOhm : null,
    cycleLife: f.cycleLife ? +f.cycleLife : null,
    tempDischargeC: [-20, 60],
    tempChargeC: [0, 45],
    priceUSD: f.priceUSD ? +f.priceUSD : null,
    dataQuality: 'estimate',
    sourceNote: 'Customer-supplied datasheet values, stored on this device only — never published. Temperature windows are generic defaults unless edited.',
  };
}

// Same contract rules the public library enforces, in-browser.
export function validateCustomCell(c) {
  const errs = [];
  if (!c.manufacturer?.trim() || !c.model?.trim()) errs.push('Manufacturer and model are required.');
  if (!['cylindrical', 'prismatic', 'pouch'].includes(c.form)) errs.push('Pick a cell shape.');
  const pos = (v) => isFinite(+v) && +v > 0;
  if (c.form === 'cylindrical') {
    if (!pos(c.d) || !pos(c.h)) errs.push('Diameter and height must be positive numbers (mm).');
  } else {
    if (!pos(c.w) || !pos(c.t) || !pos(c.h)) errs.push('Width, thickness and height must be positive numbers (mm).');
    else if (+c.t > +c.w) errs.push('Thickness must not exceed width (t ≤ w).');
  }
  if (!pos(c.capacityAh)) errs.push('Capacity (Ah) must be positive.');
  if (!pos(c.massG)) errs.push('Mass (g) must be positive.');
  if (!(pos(c.nominalV) && pos(c.vMax) && pos(c.vMin) && +c.vMin < +c.nominalV && +c.nominalV < +c.vMax)) {
    errs.push('Voltages must satisfy min < nominal < max.');
  }
  if (!pos(c.maxContDischargeA) || !pos(c.maxContChargeA)) {
    errs.push('Continuous discharge and charge currents must be positive (estimate conservatively if the datasheet is silent).');
  }
  if (pos(c.capacityAh) && pos(c.massG) && pos(c.nominalV)) {
    const whkg = (+c.nominalV * +c.capacityAh) / (+c.massG / 1000);
    if (whkg < 20 || whkg > 400) errs.push(`These numbers give ${Math.round(whkg)} Wh/kg — outside the plausible 20–400 range; check units.`);
  }
  return errs;
}

// mailto: URL that opens the customer's own mail client, pre-addressed.
export function buildMailto(cell) {
  const subject = `battery-design: customer cell datasheet — ${cell.manufacturer} ${cell.model}`;
  const body =
    'Hello,\n\nA customer submitted this cell from the battery-design app.\n' +
    'Datasheet PDF attached where available.\n\n' +
    JSON.stringify(cell, null, 2) + '\n';
  return `mailto:${OWNER_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}
