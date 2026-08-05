// efficiency.js — one plain round-trip-efficiency answer, with the loss
// chain kept visible for engineers and software clients.
//
// RTE is not a cell-only number. It includes charge conversion, the battery
// itself, discharge conversion and the auxiliaries that remain on while
// energy moves. The defaults below are class estimates; callers can replace
// every term with measured PCS/inverter and pack data.

import { appClassOf } from './markets.js';

const BASE = {
  chargeEff: 0.96,
  batteryEff: 0.98,
  dischargeEff: 0.96,
  auxiliaryW: 0,
  cycleHours: 2,
};

const BY_CLASS = {
  stationary: { chargeEff: 0.97, batteryEff: 0.98, dischargeEff: 0.97, auxiliaryW: 18, cycleHours: 4 },
  industrial: { chargeEff: 0.95, batteryEff: 0.97, dischargeEff: 0.95, auxiliaryW: 80, cycleHours: 6 },
  auxiliary: { chargeEff: 0.95, batteryEff: 0.98, dischargeEff: 0.93, auxiliaryW: 12, cycleHours: 8 },
  marine: { chargeEff: 0.95, batteryEff: 0.98, dischargeEff: 0.95, auxiliaryW: 10, cycleHours: 4 },
  vehicle: { chargeEff: 0.95, batteryEff: 0.98, dischargeEff: 0.95, auxiliaryW: 0, cycleHours: 2 },
  lmt: { chargeEff: 0.93, batteryEff: 0.97, dischargeEff: 0.92, auxiliaryW: 0, cycleHours: 2 },
  portable: { chargeEff: 0.92, batteryEff: 0.97, dischargeEff: 0.90, auxiliaryW: 3, cycleHours: 2 },
};

const BY_APP = {
  'solar-ess': { auxiliaryW: 15, cycleHours: 4 },
  ups: { chargeEff: 0.94, dischargeEff: 0.94, auxiliaryW: 45, cycleHours: 1 },
  powerstation: { chargeEff: 0.92, dischargeEff: 0.89, auxiliaryW: 8, cycleHours: 2 },
};

const boundedEff = (v, fallback) => Number.isFinite(v)
  ? Math.max(0.5, Math.min(1, v)) : fallback;

export function efficiencyDefaultsFor(application) {
  const cls = appClassOf(application);
  return { ...BASE, ...(BY_CLASS[cls] || {}), ...(BY_APP[application] || {}) };
}

/**
 * Energy delivered is the customer-facing basis. The result answers the
 * manager's question directly: how much must be bought/charged, and how much
 * is lost, to deliver that amount once.
 */
export function roundTripPlan({
  application = null,
  deliveredWh = 1000,
  chargeEff = null,
  batteryEff = null,
  dischargeEff = null,
  auxiliaryW = null,
  cycleHours = null,
} = {}) {
  const d = efficiencyDefaultsFor(application);
  const etaCharge = boundedEff(chargeEff, d.chargeEff);
  const etaBattery = boundedEff(batteryEff, d.batteryEff);
  const etaDischarge = boundedEff(dischargeEff, d.dischargeEff);
  const auxW = Number.isFinite(auxiliaryW) ? Math.max(0, auxiliaryW) : d.auxiliaryW;
  const hours = Number.isFinite(cycleHours) ? Math.max(0, cycleHours) : d.cycleHours;
  const delivered = Number.isFinite(deliveredWh) ? Math.max(0, deliveredWh) : 0;
  const conversionRte = etaCharge * etaBattery * etaDischarge;
  const conversionInputWh = conversionRte > 0 ? delivered / conversionRte : null;
  const auxiliaryWh = auxW * hours;
  const inputWh = conversionInputWh == null ? null : conversionInputWh + auxiliaryWh;
  const rte = inputWh > 0 ? delivered / inputWh : conversionRte;

  return {
    application,
    rte,
    conversionRte,
    deliveredWh: delivered,
    inputWh,
    lossWh: inputWh == null ? null : inputWh - delivered,
    auxiliaryWh,
    components: {
      chargeEff: etaCharge,
      batteryEff: etaBattery,
      dischargeEff: etaDischarge,
      auxiliaryW: auxW,
      cycleHours: hours,
    },
    dataQuality: 'class estimate',
    note: 'RTE includes charge conversion, battery energy efficiency, discharge conversion and active auxiliaries. Replace the class defaults with measured PCS/inverter and pack data before guaranteeing performance.',
  };
}
