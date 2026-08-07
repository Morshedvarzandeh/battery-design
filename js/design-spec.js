// design-spec.js — one portable, versioned input contract for every surface.
//
// The browser, CLI, MCP server and reports all speak this shape.  Older flat
// specifications remain valid: normalization projects the new nested
// `requirements`, `architecture`, `thermal`, `charging` and `climate` groups
// onto the established API fields before any engineering model sees them.

export const DESIGN_SPEC_SCHEMA_VERSION = '1.0.0';
export const DESIGN_SPEC_FORMAT = 'battery-design/design-spec';

// A small, dependency-free JSON-Schema description.  It is intentionally
// exported for clients that build forms or persist projects; runtime
// validation below remains authoritative and also checks physical ranges that
// JSON Schema alone cannot express clearly (ordered temperature windows, for
// example).
export const DESIGN_SPEC_SCHEMA = deepFreeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: `${DESIGN_SPEC_FORMAT}/${DESIGN_SPEC_SCHEMA_VERSION}`,
  title: 'Battery Design Specification',
  description: 'Portable, versioned input contract shared by the GUI, CLI, runner, reports and semantic exports.',
  type: 'object',
  properties: {
    schemaVersion: { const: DESIGN_SPEC_SCHEMA_VERSION },
    application: { type: 'string', minLength: 1 },
    cell: { type: 'string', minLength: 1 },
    s: { type: 'integer', minimum: 1 },
    p: { type: 'integer', minimum: 1 },
    energyWh: { $ref: '#/$defs/positive' },
    deliveredWh: { $ref: '#/$defs/positive' },
    nominalV: { $ref: '#/$defs/positive' },
    contPowerW: { $ref: '#/$defs/nonNegative' },
    peakPowerW: { $ref: '#/$defs/nonNegative' },
    chargeRateC: { $ref: '#/$defs/nonNegative' },
    maxMassKg: { $ref: '#/$defs/positive' },
    maxDimsMm: { $ref: '#/$defs/dimensions' },
    cyclesPerYear: { $ref: '#/$defs/positive' },
    targetYears: { $ref: '#/$defs/positive' },
    dod: { $ref: '#/$defs/fractionPositive' },
    ambientC: { $ref: '#/$defs/temperatureWindow' },
    market: { type: 'string', enum: ['eu', 'us', 'cn', 'intl'] },
    batteryCategory: {
      type: 'string', enum: ['ev', 'lmt', 'industrial', 'portable', 'sli'],
    },
    evaluationDate: { type: 'string', format: 'date' },
    regulatory: {
      type: 'object',
      properties: {
        batteryCategory: {
          type: ['string', 'null'], enum: ['ev', 'lmt', 'industrial', 'portable', 'sli', null],
        },
        evaluationDate: { type: ['string', 'null'], format: 'date' },
      },
      additionalProperties: true,
    },
    gridGPerKWh: { $ref: '#/$defs/nonNegative' },
    v2xPolicy: { type: 'string', enum: ['off', 'v2l', 'v2h', 'v2g', 'v2v'] },
    isolationStandard: { type: 'string', minLength: 1 },
    thermalOverride: { type: 'string', minLength: 1 },
    loopOverride: { type: 'string', minLength: 1 },
    obcOverride: { type: 'string', minLength: 1 },
    arrangement: { type: 'string', minLength: 1 },
    requirements: {
      type: 'object',
      properties: {
        application: { type: ['string', 'null'] },
        market: { type: ['string', 'null'] },
        v2xPolicy: { type: ['string', 'null'] },
        vRange: { $ref: '#/$defs/positiveWindow' },
        energyWh: { $ref: '#/$defs/nullablePositive' },
        deliveredWh: { $ref: '#/$defs/nullablePositive' },
        contPowerW: { $ref: '#/$defs/nullableNonNegative' },
        peakPowerW: { $ref: '#/$defs/nullableNonNegative' },
        chargeRateC: { $ref: '#/$defs/nullableNonNegative' },
        maxMassKg: { $ref: '#/$defs/nullablePositive' },
        maxDimsMm: {
          anyOf: [{ $ref: '#/$defs/dimensions' }, { type: 'null' }],
        },
        envTempC: {
          anyOf: [{ $ref: '#/$defs/temperatureWindow' }, { type: 'null' }],
        },
        ambientC: {
          anyOf: [{ $ref: '#/$defs/temperatureWindow' }, { type: 'null' }],
        },
        preferredChemistries: {
          type: 'array', items: { type: 'string', minLength: 1 }, uniqueItems: true,
        },
        cyclesPerYear: { $ref: '#/$defs/nullablePositive' },
        targetYears: { $ref: '#/$defs/nullablePositive' },
        profileScaleW: { $ref: '#/$defs/nullablePositive' },
        busLoad: { type: ['string', 'null'] },
      },
      additionalProperties: true,
    },
    climate: {
      type: 'object',
      properties: {
        id: { type: ['string', 'null'] },
        season: { type: ['string', 'null'] },
        ambientC: {
          anyOf: [{ $ref: '#/$defs/temperatureWindow' }, { type: 'null' }],
        },
      },
      additionalProperties: true,
    },
    architecture: {
      type: 'object',
      properties: {
        topology: { type: 'string', minLength: 1 },
        bmsTopology: { type: 'string', minLength: 1 },
        isolationStandard: { type: 'string', minLength: 1 },
        isolationContext: { type: 'string', minLength: 1 },
        emsOverride: { type: 'string', minLength: 1 },
        ems: { type: 'string', minLength: 1 },
        sModOverride: { type: ['integer', 'null'], minimum: 1 },
        channelsPerIc: { type: 'integer', minimum: 2, maximum: 25 },
        linkCapUF: { $ref: '#/$defs/positive' },
        prechargeTimeS: { $ref: '#/$defs/positive' },
        prechargesPerHour: { $ref: '#/$defs/nonNegative' },
        cellsPerTempSensor: { type: 'integer', minimum: 1 },
        targetEnergyWh: { $ref: '#/$defs/nullablePositive' },
        racksOverride: { type: ['integer', 'null'], minimum: 1 },
        lvBusV: { $ref: '#/$defs/positive' },
        auxPowerW: { $ref: '#/$defs/nonNegative' },
        interconnectMOhm: { $ref: '#/$defs/nonNegative' },
      },
      additionalProperties: true,
    },
    thermal: {
      type: 'object',
      properties: {
        loopOverride: { type: 'string', minLength: 1 },
        override: { type: 'string', minLength: 1 },
      },
      additionalProperties: true,
    },
    charging: {
      type: 'object',
      properties: { obcOverride: { type: 'string', minLength: 1 } },
      additionalProperties: true,
    },
    components: {
      type: 'object',
      properties: Object.fromEntries(['busbar', 'spacer', 'vent', 'cooling', 'tim', 'housing']
        .map((key) => [key, { type: ['string', 'null'] }])),
      additionalProperties: true,
    },
    layout: {
      type: 'object',
      properties: {
        arrangement: { type: 'string', minLength: 1 },
        orientation: { type: 'string', minLength: 1 },
        spacingMm: { $ref: '#/$defs/nonNegative' },
        layerGapMm: { $ref: '#/$defs/nonNegative' },
        wallMm: { $ref: '#/$defs/nonNegative' },
        headroomMm: { $ref: '#/$defs/nonNegative' },
        underMm: { $ref: '#/$defs/nonNegative' },
        rowExtraMm: { $ref: '#/$defs/nonNegative' },
        nx: { type: ['integer', 'null'], minimum: 0 },
        nz: { type: ['integer', 'null'], minimum: 1 },
        bay: {
          anyOf: [
            { $ref: '#/$defs/boxBay' }, { $ref: '#/$defs/roundBay' },
            { $ref: '#/$defs/lShapeBay' }, { $ref: '#/$defs/steppedBay' },
            { $ref: '#/$defs/polygonBay' }, { type: 'null' },
          ],
        },
      },
      additionalProperties: true,
    },
    vehicle: {
      type: 'object',
      properties: {
        label: { type: 'string' },
        curbKg: { $ref: '#/$defs/nonNegative' },
        payloadKg: { $ref: '#/$defs/nonNegative' },
        cd: { $ref: '#/$defs/nonNegative' },
        frontalAreaM2: { $ref: '#/$defs/positive' },
        crr: { $ref: '#/$defs/nonNegative' },
        driveEff: { $ref: '#/$defs/fractionPositive' },
        regenFrac: { $ref: '#/$defs/fraction' },
        auxW: { $ref: '#/$defs/nonNegative' },
        rotatingMass: { $ref: '#/$defs/nonNegative' },
        note: { type: 'string' },
      },
      additionalProperties: true,
    },
    driveMode: { type: 'string', enum: ['eco', 'normal', 'sport'] },
    gradePct: { type: 'number', minimum: -30, maximum: 30 },
    route: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        targetKph: { $ref: '#/$defs/positive' },
        points: {
          type: 'array', minItems: 2,
          items: { $ref: '#/$defs/routePoint' },
        },
      },
      required: ['points'],
      additionalProperties: true,
    },
    policyId: { type: 'string', minLength: 1 },
    profileId: { type: 'string', minLength: 1 },
    profileScaleW: { $ref: '#/$defs/positive' },
    profileTrace: { $ref: '#/$defs/profileTrace' },
    mission: {
      type: 'object',
      properties: {
        passes: { type: 'integer', minimum: 1 },
        startSoC: { $ref: '#/$defs/fraction' },
        ambientC: { type: 'number' },
        season: { type: 'string' },
        charge: {
          type: 'object',
          properties: {
            mode: { type: 'string', enum: ['none', 'topup', 'base'] },
            powerW: { $ref: '#/$defs/nonNegative' },
            minutes: { $ref: '#/$defs/nonNegative' },
          },
          additionalProperties: true,
        },
      },
      additionalProperties: true,
    },
    compareCellIds: {
      type: 'array', items: { type: 'string', minLength: 1 }, uniqueItems: true,
    },
    diagnostics: {
      type: 'object',
      properties: {
        rest: { type: 'boolean' }, pulse: { type: 'boolean' },
        relaxation: { type: 'boolean' }, thermal: { type: 'boolean' },
        aging: { type: 'boolean' }, assetId: { type: 'string' },
        modelVersion: { type: 'string' },
      },
      additionalProperties: true,
    },
    conditionMonitoring: {
      type: 'object',
      properties: {
        baselineWindows: { type: 'integer', minimum: 0 },
        operatingModes: {
          type: 'array', items: { type: 'string', minLength: 1 }, uniqueItems: true,
        },
        samplingHz: { $ref: '#/$defs/nullablePositive' },
      },
      additionalProperties: true,
    },
    electricalProtection: {
      type: 'object',
      properties: {
        precharge: { $ref: '#/$defs/precharge' },
        shunt: { $ref: '#/$defs/shunt' },
        fast: { $ref: '#/$defs/fastProtection' },
      },
      additionalProperties: true,
    },
    busbarMOhm: { $ref: '#/$defs/nonNegative' },
    contactorMOhm: { $ref: '#/$defs/nonNegative' },
    fuseRatingA: { $ref: '#/$defs/nullablePositive' },
    fuseI2t: { $ref: '#/$defs/nullablePositive' },
    contactorBreakingA: { $ref: '#/$defs/nullablePositive' },
    busbarAreaMm2: { $ref: '#/$defs/positive' },
    busbarKind: { type: 'string', minLength: 1 },
    linkFuseA: { $ref: '#/$defs/nullablePositive' },
    vesselId: { type: 'string', minLength: 1 },
    marine: { $ref: '#/$defs/marine' },
    twinShip: { $ref: '#/$defs/twinShip' },
    flight: {
      type: 'object',
      properties: {
        emptyMassKg: { $ref: '#/$defs/positive' },
        payloadKg: { $ref: '#/$defs/nonNegative' },
        rotorCount: { type: 'integer', minimum: 1 },
        rotorDiameterM: { $ref: '#/$defs/positive' },
        flightMinutes: { $ref: '#/$defs/positive' },
        cruiseSpeedMps: { $ref: '#/$defs/nonNegative' },
        headwindMps: { type: 'number' },
        altitudeM: { type: 'number', minimum: -500 },
        temperatureC: { type: 'number', exclusiveMinimum: -273.15 },
        propulsiveEfficiency: { $ref: '#/$defs/fractionPositive' },
        auxiliaryW: { $ref: '#/$defs/nonNegative' },
        hoverFraction: { $ref: '#/$defs/fractionPositive' },
      },
      additionalProperties: true,
    },
    efficiency: {
      type: 'object',
      properties: {
        chargeEff: { $ref: '#/$defs/fractionPositive' },
        batteryEff: { $ref: '#/$defs/fractionPositive' },
        dischargeEff: { $ref: '#/$defs/fractionPositive' },
        auxiliaryW: { $ref: '#/$defs/nonNegative' },
        cycleHours: { $ref: '#/$defs/nonNegative' },
      },
      additionalProperties: true,
    },
  },
  required: ['schemaVersion'],
  additionalProperties: true,
  $defs: {
    positive: { type: 'number', exclusiveMinimum: 0 },
    nonNegative: { type: 'number', minimum: 0 },
    nullablePositive: { type: ['number', 'null'], exclusiveMinimum: 0 },
    nullableNonNegative: { type: ['number', 'null'], minimum: 0 },
    fraction: { type: 'number', minimum: 0, maximum: 1 },
    fractionPositive: { type: 'number', exclusiveMinimum: 0, maximum: 1 },
    temperatureWindow: {
      type: 'array', minItems: 2, maxItems: 2, items: { type: 'number' },
      description: 'Ordered [low, high] temperature window; runtime validation enforces ordering.',
    },
    positiveWindow: {
      type: 'array', minItems: 2, maxItems: 2,
      items: { type: 'number', exclusiveMinimum: 0 },
      description: 'Ordered [low, high] positive window; consumers enforce ordering.',
    },
    dimensions: {
      type: 'object',
      properties: {
        x: { type: 'number', exclusiveMinimum: 0 },
        y: { type: 'number', exclusiveMinimum: 0 },
        z: { type: 'number', exclusiveMinimum: 0 },
      },
      required: ['x', 'y', 'z'],
      additionalProperties: true,
    },
    routePoint: {
      type: 'object',
      properties: {
        lat: { type: 'number', minimum: -90, maximum: 90 },
        lon: { type: 'number', minimum: -180, maximum: 180 },
        eleM: { type: 'number' }, tS: { type: 'number', minimum: 0 },
      },
      required: ['lat', 'lon'],
      additionalProperties: true,
    },
    profileTrace: {
      type: 'object',
      properties: {
        id: { type: 'string', minLength: 1 }, name: { type: 'string' },
        revision: { type: 'string' }, dtS: { type: 'number', exclusiveMinimum: 0 },
        p: {
          type: 'array', minItems: 2, maxItems: 500,
          items: { type: 'number', minimum: -1, maximum: 1 },
        },
        scaleW: { type: 'number', exclusiveMinimum: 0 },
        uploadedPeakW: { type: 'number', exclusiveMinimum: 0 },
        note: { type: 'string' },
      },
      required: ['id', 'dtS', 'p'],
      anyOf: [{ required: ['scaleW'] }, { required: ['uploadedPeakW'] }],
      additionalProperties: true,
    },
    bayPoint: {
      type: 'array', minItems: 2, maxItems: 2, items: { type: 'number' },
    },
    boxBay: {
      type: 'object',
      properties: {
        kind: { const: 'box' }, x: { $ref: '#/$defs/positive' },
        y: { $ref: '#/$defs/positive' }, z: { $ref: '#/$defs/positive' },
      },
      required: ['kind', 'x', 'y', 'z'], additionalProperties: true,
    },
    roundBay: {
      type: 'object',
      properties: {
        kind: { const: 'round' }, d: { $ref: '#/$defs/positive' },
        z: { $ref: '#/$defs/positive' },
      },
      required: ['kind', 'd', 'z'], additionalProperties: true,
    },
    lShapeBay: {
      type: 'object',
      properties: {
        kind: { const: 'lshape' }, x: { $ref: '#/$defs/positive' },
        y: { $ref: '#/$defs/positive' }, cutX: { $ref: '#/$defs/positive' },
        cutY: { $ref: '#/$defs/positive' }, z: { $ref: '#/$defs/positive' },
      },
      required: ['kind', 'x', 'y', 'cutX', 'cutY', 'z'], additionalProperties: true,
    },
    steppedBay: {
      type: 'object',
      properties: {
        kind: { const: 'stepped' }, xA: { $ref: '#/$defs/positive' },
        zA: { $ref: '#/$defs/positive' }, xB: { $ref: '#/$defs/positive' },
        zB: { $ref: '#/$defs/positive' }, y: { $ref: '#/$defs/positive' },
      },
      required: ['kind', 'xA', 'zA', 'xB', 'zB', 'y'], additionalProperties: true,
    },
    polygonBay: {
      type: 'object',
      properties: {
        kind: { const: 'poly' },
        points: { type: 'array', minItems: 3, items: { $ref: '#/$defs/bayPoint' } },
        z: { $ref: '#/$defs/positive' },
      },
      required: ['kind', 'points', 'z'], additionalProperties: true,
    },
    evidence: {
      type: 'object',
      properties: {
        kind: { type: 'string' }, part: { type: ['string', 'null'] },
        source: { type: ['string', 'null'] }, revision: { type: ['string', 'null'] },
        date: { type: ['string', 'null'], format: 'date' },
        url: { type: ['string', 'null'], format: 'uri' },
        sha256: { type: ['string', 'null'], pattern: '^[a-fA-F0-9]{64}$' },
      },
      additionalProperties: true,
    },
    precharge: {
      type: 'object',
      properties: {
        capacitanceUF: { $ref: '#/$defs/nullablePositive' },
        targetTimeS: { $ref: '#/$defs/nullablePositive' },
        closeGapV: { $ref: '#/$defs/nullableNonNegative' },
        resistanceOhm: { $ref: '#/$defs/nullablePositive' },
        resistanceTolerancePct: { $ref: '#/$defs/nullableNonNegative' },
        loadCurrentA: { $ref: '#/$defs/nullableNonNegative' },
        startsPerHour: { $ref: '#/$defs/nullableNonNegative' },
        designMarginPct: { $ref: '#/$defs/nullableNonNegative' },
        resistorVoltageRatingV: { $ref: '#/$defs/nullablePositive' },
        resistorPulseEnergyJ: { $ref: '#/$defs/nullablePositive' },
        resistorPulsePowerW: { $ref: '#/$defs/nullablePositive' },
        resistorContinuousPowerW: { $ref: '#/$defs/nullablePositive' },
        contactorId: { type: 'string' },
        contactorMakeA: { $ref: '#/$defs/nullablePositive' },
        contactorMechanicalCycles: { $ref: '#/$defs/nullablePositive' },
        supplierEvidence: { anyOf: [{ $ref: '#/$defs/evidence' }, { type: 'null' }] },
      },
      additionalProperties: true,
    },
    shunt: {
      type: 'object',
      properties: {
        referenceId: { type: ['string', 'null'] },
        supplier: { type: ['object', 'null'], additionalProperties: true },
        resistanceUOhm: { $ref: '#/$defs/nullablePositive' },
        resistanceTolerancePct: { $ref: '#/$defs/nullableNonNegative' },
        continuousRatingA: { $ref: '#/$defs/nullablePositive' },
        peakRatingA: { $ref: '#/$defs/nullablePositive' },
        peakDurationRatingS: { $ref: '#/$defs/nullablePositive' },
        conductorAreaMm2: { $ref: '#/$defs/nullablePositive' },
        maxOperatingC: { type: ['number', 'null'] },
        gainErrorPct: { $ref: '#/$defs/nullableNonNegative' },
        offsetErrorA: { $ref: '#/$defs/nullableNonNegative' },
        noiseErrorA: { $ref: '#/$defs/nullableNonNegative' },
        thermalResistanceKPerW: { $ref: '#/$defs/nullablePositive' },
        thermalTimeConstantS: { $ref: '#/$defs/nullablePositive' },
        ambientC: { type: 'number' },
        continuousA: { $ref: '#/$defs/nullableNonNegative' },
        peakA: { $ref: '#/$defs/nullableNonNegative' },
        peakDurationS: { $ref: '#/$defs/nullablePositive' },
        currentSegments: { type: ['array', 'null'], items: { type: 'object', additionalProperties: true } },
        tempcoPpmPerK: { type: 'number' },
        requiredAccuracyPct: { $ref: '#/$defs/nullablePositive' },
        evidence: { anyOf: [{ $ref: '#/$defs/evidence' }, { type: 'null' }] },
      },
      additionalProperties: true,
    },
    fastProtection: {
      type: 'object',
      properties: {
        thresholdA: { $ref: '#/$defs/nullablePositive' },
        totalDelayMs: { $ref: '#/$defs/nullableNonNegative' },
        shuntPeakRangeA: { $ref: '#/$defs/nullablePositive' },
        shuntErrorA: { $ref: '#/$defs/nullableNonNegative' },
        interrupterVoltageRatingV: { $ref: '#/$defs/nullablePositive' },
        interrupterCurrentRatingA: { $ref: '#/$defs/nullablePositive' },
        evidence: { anyOf: [{ $ref: '#/$defs/evidence' }, { type: 'null' }] },
      },
      additionalProperties: true,
    },
    shoreDeclaration: {
      type: 'object',
      properties: {
        declared: { type: 'boolean' }, scheme: { type: 'string' },
        method: { type: 'string' }, description: { type: 'string' },
      },
      additionalProperties: true,
    },
    shoreConnection: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['ac', 'dc'] },
        voltageV: { $ref: '#/$defs/positive' }, phases: { type: 'integer', enum: [1, 3] },
        frequencyHz: { $ref: '#/$defs/positive' }, powerFactor: { $ref: '#/$defs/fractionPositive' },
        ratedPowerKW: { $ref: '#/$defs/positive' }, ratedCurrentA: { $ref: '#/$defs/positive' },
        efficiency: { $ref: '#/$defs/fractionPositive' },
        outputVoltageMinV: { $ref: '#/$defs/positive' },
        outputVoltageMaxV: { $ref: '#/$defs/positive' },
        connector: {
          type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' } },
          additionalProperties: true,
        },
        earthing: { $ref: '#/$defs/shoreDeclaration' },
        isolation: { $ref: '#/$defs/shoreDeclaration' },
        interlock: { $ref: '#/$defs/shoreDeclaration' },
        emergencyDisconnect: { $ref: '#/$defs/shoreDeclaration' },
        evidence: { $ref: '#/$defs/evidence' },
      },
      additionalProperties: true,
    },
    twinEvidence: {
      type: 'object',
      properties: {
        powerBasis: { type: 'string', enum: ['dc-bus-trace', 'shaft-power-curve', 'resistance-curve'] },
        assetEvidence: { $ref: '#/$defs/twinAssetEvidence' },
        modelEvidence: { $ref: '#/$defs/twinModelEvidence' },
        calibrationEvidence: { $ref: '#/$defs/twinTrialEvidence' },
        validationEvidence: { $ref: '#/$defs/twinValidationEvidence' },
        replayEvidence: { $ref: '#/$defs/twinReplayEvidence' },
      },
      additionalProperties: true,
    },
    twinAssetEvidence: {
      type: 'object',
      properties: {
        assetId: { $ref: '#/$defs/stableId' }, vesselId: { $ref: '#/$defs/stableId' },
        evidenceId: { $ref: '#/$defs/stableId' }, revision: { type: 'string', minLength: 1 },
        issuedAt: { $ref: '#/$defs/isoInstant' }, sha256: { $ref: '#/$defs/sha256' },
      },
      required: ['assetId', 'vesselId', 'evidenceId', 'revision', 'issuedAt', 'sha256'],
      additionalProperties: true,
    },
    twinModelEvidence: {
      type: 'object',
      properties: {
        artifactId: { $ref: '#/$defs/stableId' },
        version: {
          type: 'string', pattern: '^v?\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?$',
        },
        vesselId: { $ref: '#/$defs/stableId' }, assetId: { $ref: '#/$defs/stableId' },
        sha256: { $ref: '#/$defs/sha256' },
      },
      required: ['artifactId', 'version', 'vesselId', 'assetId', 'sha256'],
      additionalProperties: true,
    },
    twinTrialEvidence: {
      type: 'object',
      properties: {
        trialId: { $ref: '#/$defs/stableId' }, vesselId: { $ref: '#/$defs/stableId' },
        assetId: { $ref: '#/$defs/stableId' }, datasetSha256: { $ref: '#/$defs/sha256' },
        modelArtifactSha256: { $ref: '#/$defs/sha256' },
        completedAt: { $ref: '#/$defs/isoInstant' },
      },
      required: ['trialId', 'vesselId', 'assetId', 'datasetSha256',
        'modelArtifactSha256', 'completedAt'],
      additionalProperties: true,
    },
    twinMetrics: {
      type: 'object',
      properties: {
        speedRmsKn: { $ref: '#/$defs/nonNegative' },
        courseRmsDeg: { $ref: '#/$defs/nonNegative' },
        powerRmsFraction: { $ref: '#/$defs/nonNegative' },
      },
      required: ['speedRmsKn', 'courseRmsDeg', 'powerRmsFraction'],
      additionalProperties: true,
    },
    twinValidationEvidence: {
      allOf: [
        { $ref: '#/$defs/twinTrialEvidence' },
        {
          type: 'object',
          properties: {
            result: { const: 'pass' }, metrics: { $ref: '#/$defs/twinMetrics' },
            limits: { $ref: '#/$defs/twinMetrics' },
          },
          required: ['result', 'metrics', 'limits'],
          additionalProperties: true,
        },
      ],
    },
    twinReplayEvidence: {
      type: 'object',
      properties: {
        replayId: { $ref: '#/$defs/stableId' }, vesselId: { $ref: '#/$defs/stableId' },
        assetId: { $ref: '#/$defs/stableId' }, datasetSha256: { $ref: '#/$defs/sha256' },
        modelArtifactSha256: { $ref: '#/$defs/sha256' },
        recordedAt: { $ref: '#/$defs/isoInstant' },
        maxAgeDays: { type: 'integer', minimum: 1, maximum: 365 },
        minSamples: { type: 'integer', minimum: 10 },
        minDurationS: { type: 'number', minimum: 60 },
      },
      required: ['replayId', 'vesselId', 'assetId', 'datasetSha256',
        'modelArtifactSha256', 'recordedAt', 'maxAgeDays', 'minSamples', 'minDurationS'],
      additionalProperties: true,
    },
    replaySample: {
      type: 'object',
      properties: {
        tS: { type: 'number', minimum: 0 }, operatingMode: { type: 'string' },
        actualSpeedKn: { type: 'number', minimum: 0 }, predictedSpeedKn: { type: 'number', minimum: 0 },
        actualCourseDeg: { type: 'number', minimum: 0, exclusiveMaximum: 360 },
        predictedCourseDeg: { type: 'number', minimum: 0, exclusiveMaximum: 360 },
        actualPowerW: { type: 'number' }, predictedPowerW: { type: 'number' },
      },
      required: ['tS', 'actualSpeedKn', 'predictedSpeedKn', 'actualCourseDeg',
        'predictedCourseDeg', 'actualPowerW', 'predictedPowerW'],
      additionalProperties: true,
    },
    replayOptions: {
      type: 'object',
      properties: {
        speedKn: { type: 'number', exclusiveMinimum: 0, maximum: 10 },
        courseDeg: { type: 'number', exclusiveMinimum: 0, maximum: 180 },
        powerFraction: { type: 'number', exclusiveMinimum: 0, maximum: 1 },
        consecutive: { type: 'integer', minimum: 1 },
      },
      additionalProperties: true,
    },
    marine: {
      type: 'object',
      properties: {
        vesselId: { type: 'string', minLength: 1 },
        referenceMassKg: { $ref: '#/$defs/nullablePositive' },
        payloadKg: { type: 'number', minimum: 0, maximum: 100000 },
        designSpeedKn: { type: 'number', minimum: 0.1, maximum: 100 },
        serviceSpeedKn: { type: 'number', minimum: 0.5, maximum: 15 },
        headCurrentKn: { type: 'number', minimum: -5, maximum: 5 },
        headwindKn: { type: 'number', minimum: 0, maximum: 50 },
        propulsionAtDesignW: { type: 'number', minimum: 1, maximum: 100000000 },
        hotelW: { type: 'number', minimum: 0, maximum: 1000000 },
        durationH: { type: 'number', minimum: 0.25, maximum: 24 },
        seaState: { type: 'string', enum: ['calm', 'moderate', 'rough'] },
        shoreConnection: { $ref: '#/$defs/shoreConnection' },
        twinEvidence: { $ref: '#/$defs/twinEvidence' },
        replaySamples: { type: 'array', minItems: 2, items: { $ref: '#/$defs/replaySample' } },
        replayOptions: { $ref: '#/$defs/replayOptions' },
      },
      additionalProperties: true,
    },
    twinShip: {
      type: 'object',
      properties: {
        readiness: { $ref: '#/$defs/twinEvidence' },
        evidence: { $ref: '#/$defs/twinEvidence' },
        replay: {
          anyOf: [
            { type: 'array', minItems: 2, items: { $ref: '#/$defs/replaySample' } },
            {
              type: 'object',
              properties: {
                samples: { type: 'array', minItems: 2, items: { $ref: '#/$defs/replaySample' } },
                options: { $ref: '#/$defs/replayOptions' },
                thresholds: { $ref: '#/$defs/replayOptions' },
              },
              additionalProperties: true,
            },
          ],
        },
      },
      additionalProperties: true,
    },
    stableId: {
      type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._:@/-]{2,127}$',
    },
    sha256: { type: 'string', pattern: '^[a-fA-F0-9]{64}$' },
    isoInstant: {
      type: 'string',
      pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,3})?(?:Z|[+-]\\d{2}:\\d{2})$',
    },
  },
});

const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const isRecord = (value) => value != null && typeof value === 'object' && !Array.isArray(value);
const finite = (value) => typeof value === 'number' && Number.isFinite(value);

// Clone only data.  This removes prototypes/accessors from untrusted API
// inputs and means deepFreeze never freezes an object owned by the caller.
function cloneData(value, depth = 0, seen = new WeakSet()) {
  if (value == null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value !== 'object') return undefined;
  if (depth > 24) throw new RangeError('DesignSpec nesting exceeds the supported depth of 24.');
  if (seen.has(value)) throw new TypeError('DesignSpec must be acyclic plain data.');
  seen.add(value);
  let out;
  if (Array.isArray(value)) {
    out = value.map((item) => cloneData(item, depth + 1, seen));
  } else {
    out = {};
    for (const key of Object.keys(value)) {
      if (key === '__proto__' || key === 'prototype' || key === 'constructor') continue;
      const cloned = cloneData(value[key], depth + 1, seen);
      if (cloned !== undefined) out[key] = cloned;
    }
  }
  seen.delete(value);
  return out;
}

export function deepFreeze(value, seen = new WeakSet()) {
  if (value == null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

export function immutableSnapshot(value) {
  return deepFreeze(cloneData(value));
}

function issue(code, path, message, repair = null) {
  return { code, path, message, repair };
}

function copyIfMissing(target, key, source, sourceKey = key) {
  // Grouped fields may use null to mean “no optional constraint”.  Their
  // legacy flat aliases are non-nullable, so projecting that sentinel creates
  // a value that the same schema then rejects.  Preserve the grouped null and
  // leave the flat alias absent; real falsey values still project and are
  // validated normally.
  if (!own(target, key) && source && own(source, sourceKey) && source[sourceKey] != null) {
    target[key] = source[sourceKey];
  }
}

function jsonEqual(a, b) {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

function schemaTarget(ref) {
  if (typeof ref !== 'string' || !ref.startsWith('#/')) return null;
  return ref.slice(2).split('/').reduce((node, part) =>
    node?.[part.replaceAll('~1', '/').replaceAll('~0', '~')], DESIGN_SPEC_SCHEMA);
}

function matchesJsonType(value, type) {
  if (type === 'null') return value === null;
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return isRecord(value);
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'number') return finite(value);
  return typeof value === type;
}

function calendarDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function schemaIssue(path, message) {
  return issue('SCHEMA_CONSTRAINT', path, message, null);
}

// Closed-key validation is intentionally separate from normalization. A
// governed input must report the misspelled key the caller actually sent,
// before grouped aliases/defaults are projected into the canonical shape.
// Ordinary schema validation remains extension-tolerant.
//
// An object composed with allOf owns the UNION of the properties evaluated by
// its branches. Checking each branch in isolation would make a valid composed
// value impossible: every branch would reject the other branch's fields.
function applicableClosedSchemas(value, schema, path, seen = new Set()) {
  if (!schema || typeof schema !== 'object' || seen.has(schema)) return [];
  seen.add(schema);
  const applicable = [schema];
  if (schema.$ref) {
    const target = schemaTarget(schema.$ref);
    if (target) applicable.push(...applicableClosedSchemas(value, target, path, seen));
  }
  for (const branch of schema.allOf || []) {
    applicable.push(...applicableClosedSchemas(value, branch, path, seen));
  }
  if (schema.anyOf) {
    const compatible = schema.anyOf
      .filter((branch) => schemaIssues(value, branch, path).length === 0);
    for (const branch of compatible) {
      applicable.push(...applicableClosedSchemas(value, branch, path, seen));
    }
  }
  return applicable;
}

function closedKeyIssues(value, schema = DESIGN_SPEC_SCHEMA, path = '$') {
  if (!schema || typeof schema !== 'object') return [];
  if (schema.$ref && !schemaTarget(schema.$ref)) {
    return [schemaIssue(path, `Unresolved schema reference ${schema.$ref}.`)];
  }
  const applicable = applicableClosedSchemas(value, schema, path);
  const errors = [];

  if (Array.isArray(value)) {
    const itemSchemas = applicable.map((branch) => branch.items).filter(Boolean);
    for (const itemSchema of itemSchemas) {
      value.forEach((entry, index) => {
        errors.push(...closedKeyIssues(entry, itemSchema, `${path}[${index}]`));
      });
    }
  }

  if (isRecord(value)) {
    const propertySchemas = new Map();
    for (const branch of applicable) {
      if (!branch.properties) continue;
      for (const [key, childSchema] of Object.entries(branch.properties)) {
        if (!propertySchemas.has(key)) propertySchemas.set(key, []);
        propertySchemas.get(key).push(childSchema);
      }
    }
    // An intentionally open object bag has no declared properties. Governed
    // closure leaves it open until its schema is made explicit.
    if (propertySchemas.size) {
      for (const key of Object.keys(value)) {
        if (!propertySchemas.has(key)) {
          errors.push(issue(
            'SCHEMA_UNKNOWN_FIELD', `${path}.${key}`,
            'Field is not declared by the governed DesignSpec schema.', null,
          ));
        }
      }
      for (const [key, childSchemas] of propertySchemas) {
        if (!own(value, key)) continue;
        for (const childSchema of childSchemas) {
          errors.push(...closedKeyIssues(value[key], childSchema, `${path}.${key}`));
        }
      }
    }
  }
  return errors;
}

function mergeObjectAllOf(schema) {
  if (!Array.isArray(schema?.allOf) || !schema.allOf.length) return null;
  const branches = schema.allOf.map((branch) => branch.$ref ? schemaTarget(branch.$ref) : branch);
  const mergeable = branches.every((branch) => branch && branch.type === 'object'
    && branch.properties
    && Object.keys(branch).every((key) => ['type', 'properties', 'required', 'additionalProperties'].includes(key)));
  if (!mergeable) return null;
  const properties = {};
  const required = [];
  for (const branch of branches) {
    Object.assign(properties, branch.properties);
    for (const key of branch.required || []) if (!required.includes(key)) required.push(key);
  }
  return { type: 'object', properties, ...(required.length ? { required } : {}) };
}

function governedSchemaCopy(schema) {
  if (Array.isArray(schema)) return schema.map(governedSchemaCopy);
  if (!schema || typeof schema !== 'object') return schema;
  const merged = mergeObjectAllOf(schema);
  if (merged) return governedSchemaCopy(merged);
  const copy = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'additionalProperties') continue;
    copy[key] = governedSchemaCopy(value);
  }
  if (schema.properties) copy.additionalProperties = false;
  else if (own(schema, 'additionalProperties')) copy.additionalProperties = schema.additionalProperties;
  return copy;
}

// MCP/forms can advertise the exact same closure policy used by
// normalizeDesignSpec(..., { closed:true }). Open supplier/current-segment
// bags stay open; composed validation evidence is merged into one closed
// object so its allOf branches cannot reject one another.
const governedDesignSpecSchema = governedSchemaCopy(DESIGN_SPEC_SCHEMA);
governedDesignSpecSchema.$id = `${DESIGN_SPEC_FORMAT}/${DESIGN_SPEC_SCHEMA_VERSION}/governed`;
export const GOVERNED_DESIGN_SPEC_SCHEMA = deepFreeze(governedDesignSpecSchema);

// Small Draft 2020-12 evaluator for the vocabulary used by the exported
// contract. Keeping it beside the schema means validation is available in a
// browser, CLI or MCP process without a second dependency or a divergent
// hand-written field list.
function schemaIssues(value, schema = DESIGN_SPEC_SCHEMA, path = '$') {
  if (!schema || typeof schema !== 'object') return [];
  const errors = [];
  if (schema.$ref) {
    const target = schemaTarget(schema.$ref);
    if (!target) return [schemaIssue(path, `Unresolved schema reference ${schema.$ref}.`)];
    errors.push(...schemaIssues(value, target, path));
  }
  if (schema.allOf) {
    for (const branch of schema.allOf) errors.push(...schemaIssues(value, branch, path));
  }
  if (schema.anyOf && !schema.anyOf.some((branch) => schemaIssues(value, branch, path).length === 0)) {
    errors.push(schemaIssue(path, 'Value does not match any allowed schema shape.'));
    return errors;
  }

  const types = schema.type == null ? null : (Array.isArray(schema.type) ? schema.type : [schema.type]);
  if (types && !types.some((type) => matchesJsonType(value, type))) {
    errors.push(schemaIssue(path, `Expected ${types.join(' or ')}, received ${value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value}.`));
    return errors;
  }
  if (own(schema, 'const') && !jsonEqual(value, schema.const)) {
    errors.push(schemaIssue(path, `Expected the constant ${JSON.stringify(schema.const)}.`));
  }
  if (schema.enum && !schema.enum.some((entry) => jsonEqual(value, entry))) {
    errors.push(schemaIssue(path, `Expected one of ${schema.enum.map((entry) => JSON.stringify(entry)).join(', ')}.`));
  }

  if (typeof value === 'string') {
    if (schema.minLength != null && value.length < schema.minLength) {
      errors.push(schemaIssue(path, `String must contain at least ${schema.minLength} character(s).`));
    }
    if (schema.pattern && !(new RegExp(schema.pattern).test(value))) {
      errors.push(schemaIssue(path, `String does not match ${schema.pattern}.`));
    }
    if (schema.format === 'date' && !calendarDate(value)) {
      errors.push(schemaIssue(path, 'Expected a real calendar date in YYYY-MM-DD form.'));
    }
    if (schema.format === 'uri') {
      try {
        const url = new URL(value);
        if (!url.protocol) throw new TypeError('missing scheme');
      } catch {
        errors.push(schemaIssue(path, 'Expected an absolute URI.'));
      }
    }
  }

  if (finite(value)) {
    if (schema.minimum != null && value < schema.minimum) {
      errors.push(schemaIssue(path, `Number must be at least ${schema.minimum}.`));
    }
    if (schema.maximum != null && value > schema.maximum) {
      errors.push(schemaIssue(path, `Number must be at most ${schema.maximum}.`));
    }
    if (schema.exclusiveMinimum != null && value <= schema.exclusiveMinimum) {
      errors.push(schemaIssue(path, `Number must be greater than ${schema.exclusiveMinimum}.`));
    }
    if (schema.exclusiveMaximum != null && value >= schema.exclusiveMaximum) {
      errors.push(schemaIssue(path, `Number must be less than ${schema.exclusiveMaximum}.`));
    }
  }

  if (Array.isArray(value)) {
    if (schema.minItems != null && value.length < schema.minItems) {
      errors.push(schemaIssue(path, `Array must contain at least ${schema.minItems} item(s).`));
    }
    if (schema.maxItems != null && value.length > schema.maxItems) {
      errors.push(schemaIssue(path, `Array must contain at most ${schema.maxItems} item(s).`));
    }
    if (schema.uniqueItems) {
      const keys = value.map((entry) => JSON.stringify(entry));
      if (new Set(keys).size !== keys.length) errors.push(schemaIssue(path, 'Array items must be unique.'));
    }
    if (schema.items) value.forEach((entry, index) => {
      errors.push(...schemaIssues(entry, schema.items, `${path}[${index}]`));
    });
  }

  if (isRecord(value)) {
    for (const key of schema.required || []) {
      if (!own(value, key)) errors.push(schemaIssue(`${path}.${key}`, 'Required field is missing.'));
    }
    for (const [key, childSchema] of Object.entries(schema.properties || {})) {
      if (own(value, key)) errors.push(...schemaIssues(value[key], childSchema, `${path}.${key}`));
    }
  }
  return errors;
}

// Return both the immutable canonical spec and any visible repairs.  The
// public engine uses safe repair mode for backwards compatibility; clients
// that author governed records can request strict mode and reject all repairs.
export function canonicalizeDesignSpec(input = {}, { strict = false, closed = false } = {}) {
  const issues = [];
  let source = input;
  if (!isRecord(source)) {
    issues.push(issue(
      'SPEC_NOT_OBJECT', '$', 'DesignSpec must be an object.',
      'Used an empty specification so safe defaults can be resolved.',
    ));
    source = {};
  }
  const spec = cloneData(source);
  if (closed) issues.push(...closedKeyIssues(spec));

  if (spec.schemaVersion != null && spec.schemaVersion !== DESIGN_SPEC_SCHEMA_VERSION) {
    issues.push(issue(
      'SCHEMA_VERSION_UNSUPPORTED', 'schemaVersion',
      `Unsupported DesignSpec schema version "${spec.schemaVersion}".`,
      `Normalized through the backwards-compatible ${DESIGN_SPEC_SCHEMA_VERSION} contract.`,
    ));
  }
  spec.schemaVersion = DESIGN_SPEC_SCHEMA_VERSION;

  // New grouped fields project onto the long-standing flat API.  Flat values
  // win when both are supplied, which keeps old integrations deterministic.
  const requirements = isRecord(spec.requirements) ? spec.requirements : null;
  for (const key of [
    'energyWh', 'deliveredWh', 'contPowerW', 'peakPowerW', 'chargeRateC',
    'maxMassKg', 'maxDimsMm', 'cyclesPerYear', 'targetYears', 'profileScaleW',
  ]) copyIfMissing(spec, key, requirements);
  copyIfMissing(spec, 'dod', requirements);
  if (!own(spec, 'ambientC')) {
    if (Array.isArray(requirements?.ambientC)) spec.ambientC = requirements.ambientC;
    else if (Array.isArray(requirements?.envTempC)) spec.ambientC = requirements.envTempC;
  }
  if (!own(spec, 'nominalV') && Array.isArray(requirements?.vRange)
      && requirements.vRange.length === 2
      && requirements.vRange.every(finite)) {
    spec.nominalV = (requirements.vRange[0] + requirements.vRange[1]) / 2;
  }

  const climate = isRecord(spec.climate) ? spec.climate : null;
  if (!own(spec, 'ambientC') && Array.isArray(climate?.ambientC)) spec.ambientC = climate.ambientC;

  const architecture = isRecord(spec.architecture) ? spec.architecture : null;
  copyIfMissing(spec, 'isolationStandard', architecture, 'isolationStandard');
  copyIfMissing(spec, 'isolationStandard', architecture, 'isolationContext');

  const thermal = isRecord(spec.thermal) ? spec.thermal : null;
  if (!own(spec, 'thermalOverride')) {
    if (own(spec, 'loopOverride')) spec.thermalOverride = spec.loopOverride;
    else if (thermal && own(thermal, 'loopOverride')) spec.thermalOverride = thermal.loopOverride;
    else if (thermal && own(thermal, 'override')) spec.thermalOverride = thermal.override;
  }

  const charging = isRecord(spec.charging) ? spec.charging : null;
  if (!own(spec, 'obcOverride') && charging && own(charging, 'obcOverride')) {
    spec.obcOverride = charging.obcOverride;
  }

  const regulatory = isRecord(spec.regulatory) ? spec.regulatory : null;
  copyIfMissing(spec, 'batteryCategory', regulatory);
  copyIfMissing(spec, 'evaluationDate', regulatory);

  // DoD is a physical multiplier used by range, TCO, V2X and marine sizing.
  // Invalid values must never pass through to those calculations.  Safe mode
  // repairs them to the established 80% default and records the repair.
  if (spec.dod == null) spec.dod = 0.8;
  if (!finite(spec.dod) || !(spec.dod > 0 && spec.dod <= 1)) {
    issues.push(issue(
      'DOD_OUT_OF_RANGE', 'dod',
      `Depth of discharge must be a finite fraction in (0, 1]; received ${String(spec.dod)}.`,
      'Used 0.8.',
    ));
    spec.dod = 0.8;
  }

  if (spec.ambientC != null) {
    if (!Array.isArray(spec.ambientC) || spec.ambientC.length !== 2
        || !spec.ambientC.every(finite) || spec.ambientC[0] > spec.ambientC[1]) {
      issues.push(issue(
        'AMBIENT_WINDOW_INVALID', 'ambientC',
        'ambientC must be an ordered pair of finite temperatures [low, high].',
        'Removed the invalid window so the application default is used.',
      ));
      delete spec.ambientC;
    }
  }

  for (const key of ['energyWh', 'deliveredWh', 'cyclesPerYear', 'targetYears']) {
    if (spec[key] != null && (!finite(spec[key]) || spec[key] <= 0)) {
      issues.push(issue(
        'POSITIVE_VALUE_REQUIRED', key,
        `${key} must be a positive finite number.`,
        'Removed the invalid value so a safe application default is used.',
      ));
      delete spec[key];
    }
  }

  if (isRecord(spec.mission)) {
    const mission = spec.mission;
    if (mission.startSoC != null
        && (!finite(mission.startSoC) || mission.startSoC < 0 || mission.startSoC > 1)) {
      issues.push(issue(
        'SOC_OUT_OF_RANGE', 'mission.startSoC',
        'Mission startSoC must be a finite fraction in [0, 1].',
        'Used 1.0.',
      ));
      mission.startSoC = 1;
    }
    if (mission.passes != null
        && (!finite(mission.passes) || mission.passes < 1 || !Number.isInteger(mission.passes))) {
      issues.push(issue(
        'MISSION_PASSES_INVALID', 'mission.passes',
        'Mission passes must be a positive integer.',
        'Used one pass.',
      ));
      mission.passes = 1;
    }
  }

  if (strict) issues.push(...schemaIssues(spec));
  if (strict && issues.length) {
    throw new DesignSpecValidationError(issues);
  }
  return { spec: deepFreeze(spec), issues: deepFreeze(issues) };
}

export class DesignSpecValidationError extends TypeError {
  constructor(issues) {
    super(`DesignSpec is invalid: ${issues.map((entry) => `${entry.path}: ${entry.message}`).join(' ')}`);
    this.name = 'DesignSpecValidationError';
    this.issues = issues;
  }
}

export function normalizeDesignSpec(input = {}, options = {}) {
  return canonicalizeDesignSpec(input, options).spec;
}

export function validateDesignSpec(input = {}, { closed = false } = {}) {
  const { spec, issues } = canonicalizeDesignSpec(input, { closed });
  const errors = [...issues, ...schemaIssues(spec)];
  return deepFreeze({ valid: errors.length === 0, errors, normalized: spec });
}
