// venting.js — emergency pressure-relief sizing for a declared gas-release
// scenario.
//
// This is a compressible-orifice calculation, not a deflagration model.  It
// answers one narrow question: what free flow area is needed to discharge a
// measured mass of hot gas inside a declared time while holding the enclosure
// at or below a declared gauge pressure?  It does not predict gas generation,
// flame, ejecta, vent opening dynamics, duct losses or explosion severity.
// Those inputs and outcomes require cell/module fire testing and the
// applicable enclosure/deflagration standard.
//
// Pure math, no DOM.

export const VENT_SIZING_SCHEMA = 'battery-design/emergency-vent-screen@1';

const positive = (name, value) => {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a finite value greater than zero.`);
  }
  return value;
};

/**
 * Isentropic mass flux through a thin opening.
 *
 * Pressures are absolute Pa, temperature is K and R is J/(kg.K).  The
 * discharge coefficient is applied here, so area = mass flow / massFlux.
 */
export function compressibleMassFlux({
  upstreamPa, downstreamPa, temperatureK, dischargeCoefficient,
  specificGasConstantJPerKgK, gamma,
}) {
  positive('Upstream pressure', upstreamPa);
  positive('Downstream pressure', downstreamPa);
  positive('Gas temperature', temperatureK);
  positive('Discharge coefficient', dischargeCoefficient);
  positive('Specific gas constant', specificGasConstantJPerKgK);
  if (!Number.isFinite(gamma) || gamma <= 1) throw new RangeError('Heat-capacity ratio gamma must be greater than one.');
  if (downstreamPa >= upstreamPa) throw new RangeError('Upstream absolute pressure must exceed downstream pressure.');
  if (dischargeCoefficient > 1) throw new RangeError('Discharge coefficient cannot exceed one.');

  const pressureRatio = downstreamPa / upstreamPa;
  const criticalPressureRatio = (2 / (gamma + 1)) ** (gamma / (gamma - 1));
  const scale = dischargeCoefficient * upstreamPa
    * Math.sqrt(gamma / (specificGasConstantJPerKgK * temperatureK));
  if (pressureRatio <= criticalPressureRatio) {
    return {
      regime: 'choked', pressureRatio, criticalPressureRatio,
      kgPerM2S: scale * (2 / (gamma + 1)) ** ((gamma + 1) / (2 * (gamma - 1))),
    };
  }
  const term = pressureRatio ** (2 / gamma)
    - pressureRatio ** ((gamma + 1) / gamma);
  return {
    regime: 'subcritical', pressureRatio, criticalPressureRatio,
    kgPerM2S: dischargeCoefficient * upstreamPa * Math.sqrt(
      (2 * gamma / (specificGasConstantJPerKgK * temperatureK * (gamma - 1))) * term,
    ),
  };
}

const diameterMm = (areaM2) => Math.sqrt(4 * areaM2 / Math.PI) * 1000;

function sizeOne({ gasLPerCell, releaseDurationS, ...common }) {
  const totalGasM3AtReference = common.ventingCells * gasLPerCell / 1000;
  const gasMassKg = common.referencePressureKPa * 1000 * totalGasM3AtReference
    / (common.specificGasConstantJPerKgK * (common.referenceTemperatureC + 273.15));
  const massFlowKgPerS = gasMassKg / releaseDurationS;
  const flux = compressibleMassFlux({
    upstreamPa: (common.ambientPressureKPa + common.allowableGaugePressureKPa) * 1000,
    downstreamPa: common.ambientPressureKPa * 1000,
    temperatureK: common.ventGasTemperatureC + 273.15,
    dischargeCoefficient: common.dischargeCoefficient,
    specificGasConstantJPerKgK: common.specificGasConstantJPerKgK,
    gamma: common.gamma,
  });
  const areaM2 = massFlowKgPerS / flux.kgPerM2S;
  return {
    gasLPerCell, releaseDurationS, totalGasM3AtReference, gasMassKg,
    massFlowKgPerS, massFluxKgPerM2S: flux.kgPerM2S,
    areaM2, areaCm2: areaM2 * 10_000, equivalentDiameterMm: diameterMm(areaM2),
    regime: flux.regime, pressureRatio: flux.pressureRatio,
    criticalPressureRatio: flux.criticalPressureRatio,
  };
}

/**
 * Calculate a low/high free-area range from an explicitly declared scenario.
 * No gas-yield default is supplied: measured cell/module gas data or a
 * deliberately documented customer scenario is required.
 */
export function sizeEmergencyVent(input) {
  const p = {
    ventingCells: input?.ventingCells,
    gasVolumeLowLPerCell: input?.gasVolumeLowLPerCell,
    gasVolumeHighLPerCell: input?.gasVolumeHighLPerCell,
    releaseDurationLowS: input?.releaseDurationLowS,
    releaseDurationHighS: input?.releaseDurationHighS,
    allowableGaugePressureKPa: input?.allowableGaugePressureKPa,
    ambientPressureKPa: input?.ambientPressureKPa ?? 101.325,
    ventGasTemperatureC: input?.ventGasTemperatureC,
    referenceTemperatureC: input?.referenceTemperatureC ?? 20,
    referencePressureKPa: input?.referencePressureKPa ?? 101.325,
    dischargeCoefficient: input?.dischargeCoefficient,
    specificGasConstantJPerKgK: input?.specificGasConstantJPerKgK,
    gamma: input?.gamma,
    gasDataBasis: String(input?.gasDataBasis || '').trim(),
  };
  if (!Number.isInteger(p.ventingCells) || p.ventingCells < 1) throw new RangeError('Venting cell count must be a positive integer.');
  for (const [name, value] of [
    ['Low gas volume per cell', p.gasVolumeLowLPerCell],
    ['High gas volume per cell', p.gasVolumeHighLPerCell],
    ['Minimum release duration', p.releaseDurationLowS],
    ['Maximum release duration', p.releaseDurationHighS],
    ['Allowable gauge pressure', p.allowableGaugePressureKPa],
    ['Ambient pressure', p.ambientPressureKPa],
    ['Reference pressure', p.referencePressureKPa],
    ['Discharge coefficient', p.dischargeCoefficient],
    ['Specific gas constant', p.specificGasConstantJPerKgK],
  ]) positive(name, value);
  if (!Number.isFinite(p.ventGasTemperatureC) || p.ventGasTemperatureC <= -273.15) throw new RangeError('Vent-gas temperature must be above absolute zero.');
  if (!Number.isFinite(p.referenceTemperatureC) || p.referenceTemperatureC <= -273.15) throw new RangeError('Reference temperature must be above absolute zero.');
  if (!Number.isFinite(p.gamma) || p.gamma <= 1) throw new RangeError('Heat-capacity ratio gamma must be greater than one.');
  if (p.dischargeCoefficient > 1) throw new RangeError('Discharge coefficient cannot exceed one.');
  if (p.gasVolumeHighLPerCell < p.gasVolumeLowLPerCell) throw new RangeError('High gas volume must not be below low gas volume.');
  if (p.releaseDurationHighS < p.releaseDurationLowS) throw new RangeError('Maximum release duration must not be below minimum release duration.');
  if (!p.gasDataBasis) throw new RangeError('Name the measurement or scenario basis used for gas volume and release duration.');

  const common = p;
  const low = sizeOne({ gasLPerCell: p.gasVolumeLowLPerCell, releaseDurationS: p.releaseDurationHighS, ...common });
  const high = sizeOne({ gasLPerCell: p.gasVolumeHighLPerCell, releaseDurationS: p.releaseDurationLowS, ...common });
  return {
    schema: VENT_SIZING_SCHEMA,
    status: 'conditional',
    headline: `Calculated free vent area: ${low.areaCm2.toFixed(1)}–${high.areaCm2.toFixed(1)} cm²`,
    inputs: p,
    low, high,
    equations: {
      gasMass: 'm_gas = P_ref · (N_cells · V_gas,cell) / (R_gas · T_ref)',
      massFlow: 'm_dot = m_gas / Δt_release',
      criticalRatio: 'r_critical = [2 / (γ + 1)]^[γ / (γ - 1)]',
      chokedFlux: 'G = C_d · P_0 · sqrt[γ / (R·T_0)] · [2/(γ+1)]^[(γ+1)/(2(γ-1))]',
      subcriticalFlux: 'G = C_d · P_0 · sqrt{2γ/[R·T_0(γ-1)] · [r^(2/γ) - r^((γ+1)/γ)]}',
      area: 'A_free = m_dot / G',
      diameter: 'd_equivalent = sqrt(4·A_free/π)',
    },
    limitations: [
      'Conditional pressure-relief screen only; it is not NFPA 68 deflagration vent sizing and cannot certify an enclosure.',
      'Gas yield, gas composition and release duration must come from representative cell/module abuse testing; chemistry name alone is not sufficient.',
      'Opening pressure/transient, vent inertia, ducts, bends, filters, flame, ejecta, combustion, structural response and external exclusion zones are not modeled.',
    ],
    requiredTests: [
      'Representative cell-level gas volume, composition, temperature and release-rate measurement at the declared state of charge and aging condition.',
      'Module-level propagation, heat-release and gas-release testing.',
      'Enclosure pressure/vent-opening test with the production vent, duct and obstruction geometry.',
      'Applicable fire, deflagration and installation-level testing, including UL 9540A where relevant.',
    ],
  };
}
