// vent-layout.js — supplier-backed vent quantity and placement screening.
//
// The pressure-relief equation lives in venting.js.  This module starts only
// after that equation has produced a required unobstructed free area.  It
// matches the area to a supplier-declared vent unit, checks that the unit is
// declared for the open market profile, and places as many units as required
// on explicitly permitted enclosure faces.
//
// Placement is geometric, not fire certification.  A face is eligible only
// when a human has already screened its external discharge direction.  The
// returned coordinates still require CAD, obstruction, duct-loss, water-
// ingress, occupant/egress and physical enclosure tests.

export const VENT_LAYOUT_SCHEMA = 'battery-design/vent-hardware-layout@1';

export const VENT_FACES = Object.freeze(['top', 'bottom', 'front', 'rear', 'left', 'right']);

export const VENT_MARKET_PROFILES = Object.freeze({
  'road-pack': Object.freeze({
    id: 'road-pack', label: 'Road vehicle battery pack', market: 'road', segment: null,
    hardwareClass: 'pack pressure-relief device or directed duct exit',
  }),
  'grid-home-pack': Object.freeze({
    id: 'grid-home-pack', label: 'Grid / Home battery enclosure', market: 'grid', segment: 'home',
    hardwareClass: 'pack or small-cabinet pressure-relief device',
  }),
  'grid-commercial-cabinet': Object.freeze({
    id: 'grid-commercial-cabinet', label: 'Grid / Small company cabinet', market: 'grid', segment: 'small-company',
    hardwareClass: 'cabinet pressure-relief device or directed duct exit',
  }),
  'grid-industrial-enclosure': Object.freeze({
    id: 'grid-industrial-enclosure', label: 'Grid / Industrial enclosure', market: 'grid', segment: 'industrial',
    hardwareClass: 'industrial cabinet or container pressure-relief hardware',
  }),
});

const MECHANISMS = Object.freeze([
  'pressure-relief-device', 'burst-opening', 'directed-duct-exit',
]);

const positive = (name, value) => {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a finite value greater than zero.`);
  }
  return value;
};

const nonNegative = (name, value) => {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a finite value at least zero.`);
  }
  return value;
};

const text = (name, value) => {
  const normalized = String(value || '').trim();
  if (!normalized) throw new RangeError(`${name} is required.`);
  return normalized;
};

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

export function ventMarketProfile(market, segment = null) {
  if (market === 'road') return VENT_MARKET_PROFILES['road-pack'];
  if (market !== 'grid') throw new RangeError(`Vent hardware selection is not enabled for market: ${market}`);
  const id = segment === 'home' ? 'grid-home-pack'
    : segment === 'small-company' ? 'grid-commercial-cabinet'
      : segment === 'industrial' ? 'grid-industrial-enclosure' : null;
  if (!id) throw new RangeError('Grid vent selection requires Home, Small company or Industrial segmentation.');
  return VENT_MARKET_PROFILES[id];
}

function faceGeometry(face, enclosure, source) {
  const { x: length, y: width, z: height } = enclosure;
  const geometries = {
    top: {
      width: length, height: width, sourceU: source.x, sourceV: source.y,
      normalDistance: height - source.z, vector: { x: 0, y: 0, z: 1 },
      point: (u, v) => ({ x: u, y: v, z: height }),
    },
    bottom: {
      width: length, height: width, sourceU: source.x, sourceV: source.y,
      normalDistance: source.z, vector: { x: 0, y: 0, z: -1 },
      point: (u, v) => ({ x: u, y: v, z: 0 }),
    },
    front: {
      width: length, height, sourceU: source.x, sourceV: source.z,
      normalDistance: source.y, vector: { x: 0, y: -1, z: 0 },
      point: (u, v) => ({ x: u, y: 0, z: v }),
    },
    rear: {
      width: length, height, sourceU: source.x, sourceV: source.z,
      normalDistance: width - source.y, vector: { x: 0, y: 1, z: 0 },
      point: (u, v) => ({ x: u, y: width, z: v }),
    },
    left: {
      width, height, sourceU: source.y, sourceV: source.z,
      normalDistance: source.x, vector: { x: -1, y: 0, z: 0 },
      point: (u, v) => ({ x: 0, y: u, z: v }),
    },
    right: {
      width, height, sourceU: source.y, sourceV: source.z,
      normalDistance: length - source.x, vector: { x: 1, y: 0, z: 0 },
      point: (u, v) => ({ x: length, y: u, z: v }),
    },
  };
  return { face, ...geometries[face] };
}

function capacityFor(face, unitWidthMm, unitHeightMm, edgeMm, spacingMm) {
  const columns = Math.max(0, Math.floor((face.width - 2 * edgeMm + spacingMm) / (unitWidthMm + spacingMm)));
  const rows = Math.max(0, Math.floor((face.height - 2 * edgeMm + spacingMm) / (unitHeightMm + spacingMm)));
  return { columns, rows, capacity: columns * rows };
}

function layoutOption(face, count, widthMm, heightMm, edgeMm, spacingMm, rotated) {
  const capacity = capacityFor(face, widthMm, heightMm, edgeMm, spacingMm);
  if (capacity.capacity < count) return null;
  let best = null;
  for (let columns = 1; columns <= Math.min(capacity.columns, count); columns++) {
    const rows = Math.ceil(count / columns);
    if (rows > capacity.rows) continue;
    const spanU = columns * widthMm + (columns - 1) * spacingMm;
    const spanV = rows * heightMm + (rows - 1) * spacingMm;
    const unused = columns * rows - count;
    const aspectPenalty = Math.abs((spanU / spanV) - (face.width / face.height));
    const score = unused * 1e9 + spanU * spanV + aspectPenalty;
    if (!best || score < best.score) best = {
      score, columns, rows, spanU, spanV, widthMm, heightMm, rotated,
    };
  }
  return best;
}

function placeOnFace(face, count, unit, edgeMm, spacingMm) {
  const direct = layoutOption(face, count, unit.widthMm, unit.heightMm, edgeMm, spacingMm, false);
  const rotated = unit.widthMm === unit.heightMm ? null
    : layoutOption(face, count, unit.heightMm, unit.widthMm, edgeMm, spacingMm, true);
  const option = !direct ? rotated : !rotated ? direct : direct.score <= rotated.score ? direct : rotated;
  if (!option) return null;

  const startU = clamp(
    face.sourceU - option.spanU / 2,
    edgeMm,
    face.width - edgeMm - option.spanU,
  );
  const startV = clamp(
    face.sourceV - option.spanV / 2,
    edgeMm,
    face.height - edgeMm - option.spanV,
  );
  const placements = [];
  for (let row = 0; row < option.rows && placements.length < count; row++) {
    const remaining = count - placements.length;
    const rowCount = Math.min(option.columns, remaining);
    const rowSpan = rowCount * option.widthMm + (rowCount - 1) * spacingMm;
    const rowOffset = (option.spanU - rowSpan) / 2;
    for (let column = 0; column < rowCount; column++) {
      const u = startU + rowOffset + option.widthMm / 2 + column * (option.widthMm + spacingMm);
      const v = startV + option.heightMm / 2 + row * (option.heightMm + spacingMm);
      placements.push({
        face: face.face,
        centerMm: face.point(u, v),
        footprintMm: { width: option.widthMm, height: option.heightMm },
        rotated: option.rotated,
        dischargeDirection: face.vector,
        sourceToFaceMm: face.normalDistance,
      });
    }
  }
  return { option, placements };
}

function validatePointInside(name, point, enclosure) {
  for (const axis of ['x', 'y', 'z']) {
    if (!Number.isFinite(point?.[axis]) || point[axis] < 0 || point[axis] > enclosure[axis]) {
      throw new RangeError(`${name} ${axis} coordinate must be inside the enclosure.`);
    }
  }
}

function normalizedUnit(unit, profileId) {
  const normalized = {
    id: text('Supplier vent id', unit?.id),
    name: text('Supplier vent name', unit?.name),
    supplier: text('Vent supplier', unit?.supplier),
    partNumber: text('Vent part number', unit?.partNumber),
    freeAreaCm2: positive('Supplier-declared vent free area', unit?.freeAreaCm2),
    widthMm: positive('Vent footprint width', unit?.widthMm),
    heightMm: positive('Vent footprint height', unit?.heightMm),
    mechanism: text('Vent mechanism', unit?.mechanism),
    marketProfiles: Array.isArray(unit?.marketProfiles)
      ? [...new Set(unit.marketProfiles.map((item) => String(item).trim()).filter(Boolean))] : [],
    evidenceBasis: text('Supplier vent evidence basis', unit?.evidenceBasis),
  };
  if (!MECHANISMS.includes(normalized.mechanism)) {
    throw new RangeError(`Vent mechanism must be one of: ${MECHANISMS.join(', ')}.`);
  }
  if (!normalized.marketProfiles.includes(profileId)) {
    throw new RangeError(`Supplier vent ${normalized.partNumber} is not declared for market profile ${profileId}.`);
  }
  const footprintAreaCm2 = normalized.widthMm * normalized.heightMm / 100;
  if (normalized.freeAreaCm2 > footprintAreaCm2) {
    throw new RangeError('Supplier-declared free area cannot exceed the physical vent footprint.');
  }
  return normalized;
}

/**
 * Select a quantity of one verified supplier vent and place it on permitted
 * faces.  Required area is the high case from sizeEmergencyVent().
 */
export function selectVentHardwareLayout(input) {
  const profile = ventMarketProfile(input?.market, input?.segment ?? null);
  const requiredFreeAreaCm2 = positive('Required free vent area', input?.requiredFreeAreaCm2);
  const enclosure = {
    x: positive('Enclosure X dimension', input?.enclosure?.x),
    y: positive('Enclosure Y dimension', input?.enclosure?.y),
    z: positive('Enclosure Z dimension', input?.enclosure?.z),
  };
  const source = { x: input?.source?.x, y: input?.source?.y, z: input?.source?.z };
  validatePointInside('Gas-source', source, enclosure);
  const edgeClearanceMm = nonNegative('Vent edge clearance', input?.edgeClearanceMm);
  const minimumSpacingMm = nonNegative('Minimum inter-vent spacing', input?.minimumSpacingMm);
  const allowedFaces = [...new Set((input?.allowedFaces || []).map((face) => String(face).trim()))];
  if (!allowedFaces.length) throw new RangeError('At least one human-screened discharge face is required.');
  if (allowedFaces.some((face) => !VENT_FACES.includes(face))) {
    throw new RangeError(`Allowed vent faces must be chosen from: ${VENT_FACES.join(', ')}.`);
  }
  const preferredFace = input?.preferredFace ? String(input.preferredFace) : null;
  if (preferredFace && !allowedFaces.includes(preferredFace)) {
    throw new RangeError('Preferred vent face must also be in the allowed-face list.');
  }
  const unit = normalizedUnit(input?.unit, profile.id);
  const maxVentCount = input?.maxVentCount ?? 128;
  if (!Number.isInteger(maxVentCount) || maxVentCount < 1) {
    throw new RangeError('Maximum vent count must be a positive integer.');
  }
  const quantity = Math.ceil(requiredFreeAreaCm2 / unit.freeAreaCm2);
  if (quantity > maxVentCount) {
    return {
      schema: VENT_LAYOUT_SCHEMA, status: 'blocked', marketProfile: profile,
      requiredFreeAreaCm2, unit, requiredQuantity: quantity, placedQuantity: 0,
      totalDeclaredFreeAreaCm2: 0, placements: [],
      headline: `${quantity} vents are required, above the declared limit of ${maxVentCount}.`,
      correctiveActions: [
        'Select a verified higher-flow vent for this market profile.',
        'Increase the reviewed maximum vent count and available enclosure faces.',
        'Change the gas-release or pressure scenario only when new test or structural evidence supports it.',
      ],
    };
  }

  const faces = allowedFaces.map((face) => faceGeometry(face, enclosure, source)).map((face) => {
    const direct = capacityFor(face, unit.widthMm, unit.heightMm, edgeClearanceMm, minimumSpacingMm);
    const rotated = capacityFor(face, unit.heightMm, unit.widthMm, edgeClearanceMm, minimumSpacingMm);
    return { ...face, capacity: Math.max(direct.capacity, rotated.capacity) };
  }).sort((a, b) => {
    const preferredDifference = Number(b.face === preferredFace) - Number(a.face === preferredFace);
    if (preferredDifference) return preferredDifference;
    return a.normalDistance - b.normalDistance || b.capacity - a.capacity || a.face.localeCompare(b.face);
  });

  const totalCapacity = faces.reduce((sum, face) => sum + face.capacity, 0);
  if (totalCapacity < quantity) {
    return {
      schema: VENT_LAYOUT_SCHEMA, status: 'blocked', marketProfile: profile,
      requiredFreeAreaCm2, unit, requiredQuantity: quantity, placedQuantity: 0,
      totalDeclaredFreeAreaCm2: 0, placements: [],
      faceCapacity: Object.fromEntries(faces.map((face) => [face.face, face.capacity])),
      headline: `${quantity} vents are required, but only ${totalCapacity} fit the permitted faces.`,
      correctiveActions: [
        'Select a verified smaller-footprint or higher-free-area vent.',
        'Provide another externally safe discharge face or a tested directed duct exit.',
        'Revise the enclosure geometry and repeat the obstruction/clearance review.',
        'Do not raise allowable enclosure pressure without structural evidence and human approval.',
      ],
    };
  }

  let remaining = quantity;
  const placements = [];
  for (const face of faces) {
    if (!remaining || !face.capacity) continue;
    const count = Math.min(remaining, face.capacity);
    const placed = placeOnFace(face, count, unit, edgeClearanceMm, minimumSpacingMm);
    if (!placed) continue;
    for (const placement of placed.placements) {
      placements.push({
        id: `vent-${String(placements.length + 1).padStart(2, '0')}`,
        ...placement,
      });
    }
    remaining -= placed.placements.length;
  }
  if (remaining) throw new Error('Internal vent placement capacity mismatch.');

  const totalDeclaredFreeAreaCm2 = quantity * unit.freeAreaCm2;
  return {
    schema: VENT_LAYOUT_SCHEMA,
    status: 'provisional',
    marketProfile: profile,
    requiredFreeAreaCm2,
    unit,
    requiredQuantity: quantity,
    placedQuantity: placements.length,
    totalDeclaredFreeAreaCm2,
    freeAreaMarginCm2: totalDeclaredFreeAreaCm2 - requiredFreeAreaCm2,
    enclosureMm: enclosure,
    gasSourceMm: source,
    allowedFaces,
    preferredFace,
    edgeClearanceMm,
    minimumSpacingMm,
    faceCapacity: Object.fromEntries(faces.map((face) => [face.face, face.capacity])),
    placements,
    headline: quantity === 1
      ? `One ${unit.name} covers the calculated free area and fits the permitted enclosure face.`
      : `${quantity} × ${unit.name} cover the calculated free area and fit the permitted enclosure faces.`,
    placementBasis: 'Faces are ranked by human preference, then shortest normal path from the modelled gas source. Units are centered near the source projection while respecting declared edge and inter-vent clearances.',
    approvalChecklist: [
      'Confirm each discharge direction terminates in a safe exterior area, away from occupants, egress, responders, air intakes, ignition sources and adjacent equipment.',
      'Confirm CAD structure, seals, service access, crash/load paths, water ingress and every internal obstruction or duct loss.',
      'Confirm supplier free area, opening pressure, temperature capability, flow direction, tolerance and non-reclosing/reclosing behavior from the cited part evidence.',
      'Validate the production enclosure, all installed vents and any ducts with representative gas-release and pressure testing.',
      'Use a qualified fire-protection review and the applicable deflagration/explosion-prevention analysis for ESS installations.',
    ],
  };
}
