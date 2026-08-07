// Seed knowledge captured from resolved battery-design engineering failures.
// Records are ordered by stable id so reviews, indexes and search ties remain
// deterministic across browser and Node runtimes.

import {
  ROOT_CAUSE_CATALOG_FORMAT,
  ROOT_CAUSE_RECORD_FORMAT,
  ROOT_CAUSE_SCHEMA_VERSION,
} from './schema.v1.js';

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

const record = (value) => ({
  format: ROOT_CAUSE_RECORD_FORMAT,
  revision: 1,
  status: 'resolved',
  ...value,
});

export const ROOT_CAUSE_SEED_CATALOG = deepFreeze({
  format: ROOT_CAUSE_CATALOG_FORMAT,
  version: ROOT_CAUSE_SCHEMA_VERSION,
  records: [
    record({
      id: 'rc-adaptive-integration-work-undercount',
      title: 'Service preflight omits adaptive thermal and module work',
      symptom: 'A simulation or calibration request passes its advertised work limit but executes far more thermal-node updates than the service budget permits.',
      evidence: [
        'The original endpoint estimate multiplied profile samples only by ceil(profileDtS/maxDtS) and therefore counted electrical time steps but not stability/accuracy-limited thermal microsteps.',
        'Each thermal microstep updates every module node, so a valid stiff request can advertise fewer than five million operations while requiring billions of node updates.',
        'Re-deriving work independently at the HTTP boundary lets the service estimate drift whenever the core integration plan changes.',
      ],
      detection: [
        {
          method: 'core-to-service work equivalence regression',
          signal: 'Preflight a legal maximum-conductance, minimum-heat-capacity request and compare the public estimate, executed integration counters and endpoint decision.',
          failureCondition: 'The boundary omits a thermal microstep or module multiplier, disagrees with core work evidence, or enters simulation before rejecting an over-budget request.',
        },
      ],
      causalChain: [
        'Electrical and thermal states use different internal step requirements.',
        'The service copies the older electrical-only ceil(dt/maxDt) formula instead of consuming the core integration plan.',
        'Adaptive thermal subdivision adds a hidden temporal multiplier and the module network adds a hidden spatial multiplier.',
        'The request passes preflight even though its actual node-update work exceeds the service contract.',
      ],
      rootCause: 'Work estimation was duplicated outside the simulator and modeled only the electrical time grid rather than the complete adaptive temporal plan multiplied by thermal-node count.',
      resolution: [
        'Export one immutable browser-safe estimateSim2Work plan from the simulator and use its exact thermalNodeUpdateCount at every service preflight.',
        'Return nodeWorkPerEvaluation and thermalNodeUpdateCount in calibration evidence while retaining the distinct temporal integrationStepCount.',
        'Reject excessive direct-simulation or calibration work before entering any integration or optimizer loop.',
      ],
      prevention: [
        'Make external resource gates consume a public core estimator rather than duplicating numerical formulas.',
        'Keep temporal steps and module-weighted node updates as separate named counters and test both at their exact boundaries.',
        'Treat any new adaptive solver dimension as a required update to work evidence, service capabilities and adversarial preflight tests.',
      ],
      regressionTests: [
        {
          path: 'tests/sim2.test.mjs',
          assertion: 'The immutable estimator matches adaptive simulation and calibration temporal/node work, and direct simulation rejects excessive node work before integration.',
        },
        {
          path: 'tests/runner-security.test.mjs',
          assertion: 'The authenticated simulation endpoint gates the exact core thermal-node estimate for a legal stiff request.',
        },
      ],
      affectedSurfaces: ['browser', 'cli', 'local-api'],
      tags: ['adaptive-integration', 'budget', 'preflight', 'thermal', 'work-accounting'],
      references: [
        {
          kind: 'implementation',
          locator: 'js/sim2.js',
          note: 'Canonical adaptive integration plan, public estimator and exact calibration counters.',
        },
        {
          kind: 'implementation',
          locator: 'desktop/bd.mjs',
          note: 'Local-service preflight consuming the core thermal-node estimate.',
        },
        {
          kind: 'test',
          locator: 'tests/runner-security.test.mjs',
          note: 'Endpoint adaptive-work rejection regression.',
        },
      ],
    }),
    record({
      id: 'rc-allof-closure-collision',
      title: 'Closed allOf branches reject one another’s properties',
      symptom: 'A valid composed DesignSpec fails closed validation because a property owned by one allOf branch is unknown to another branch.',
      evidence: [
        'The same object validates when closure is disabled but reports additional-property errors when every allOf branch is closed independently.',
        'Failures name legitimate sibling-branch properties rather than an actually unknown caller property.',
      ],
      detection: [
        {
          method: 'schema regression test',
          signal: 'Validate a composed object containing the union of all declared branch properties.',
          failureCondition: 'Any branch rejects a property declared by another branch in the same composition.',
        },
      ],
      causalChain: [
        'The schema composes object fragments with allOf.',
        'additionalProperties false is applied separately inside each fragment.',
        'Each fragment can see only its own property set and rejects the other fragments’ legitimate keys.',
      ],
      rootCause: 'Object closure was evaluated per allOf branch instead of over the union of properties evaluated by the complete composition.',
      resolution: [
        'Flatten simple object allOf compositions into one union before applying closed-key validation.',
        'Retain normal allOf evaluation for compositions that cannot be flattened safely.',
      ],
      prevention: [
        'Exercise every composed object in both ordinary and recursively closed validation modes.',
        'Treat schema composition and object closure as one semantic operation during validator changes.',
      ],
      regressionTests: [
        {
          path: 'tests/design-spec.test.mjs',
          assertion: 'Composed DesignSpec objects accept the union of declared properties and still reject a truly unknown key.',
        },
      ],
      affectedSurfaces: ['design-spec'],
      tags: ['allof', 'closed-schema', 'design-spec', 'validation'],
      references: [
        {
          kind: 'implementation',
          locator: 'js/design-spec.js',
          note: 'Closed-schema transformation and allOf object-union handling.',
        },
        {
          kind: 'test',
          locator: 'tests/design-spec.test.mjs',
          note: 'DesignSpec schema and normalization regression coverage.',
        },
      ],
    }),
    record({
      id: 'rc-calibration-holdout-relabel-leakage',
      title: 'Purpose-dependent dataset identity hides holdout leakage',
      symptom: 'An automatic tuning run accepts the same physical trial in both calibration and validation after only its dataset id or purpose is relabelled, producing optimistic holdout evidence.',
      evidence: [
        'The canonical dataset checksum intentionally covers the complete artifact, including id and purpose, so changing calibration to validation creates a different valid checksum for unchanged observations.',
        'A split guard that compares only complete dataset checksums therefore misses an exact physical trace copied across the training and holdout partitions.',
        'A single all-channel observation digest can also be changed by editing an unscored temperature channel or an excluded voltage sample while leaving the scored electrical evidence unchanged.',
        'Applying the scored-electrical collision rule inside one partition is also wrong: controlled multi-temperature or multi-SoC matrices deliberately reuse one current protocol, and may reproduce identical electrical samples before the later sensitivity gate distinguishes usefulness.',
        'Different raw traces can also collapse to the same optimizer input and scored voltage after block preprocessing, so raw-level identities alone do not protect the executed holdout objective.',
        'Raw-source and declared source-run identities catch additional duplicate derivations, but neither replaces a purpose-neutral identity computed from the canonical observations and trial context.',
      ],
      detection: [
        {
          method: 'adversarial partition-leakage regression',
          signal: 'Materialize calibration and validation datasets from the same observations while independently changing id, purpose, raw representation or source metadata, then build the tuning plan.',
          failureCondition: 'The planner accepts a cross-partition pair sharing a purpose-neutral observation, trial, raw scored-electrical, prepared scored-electrical, raw-source or complete source-run identity.',
        },
      ],
      causalChain: [
        'Dataset identity is defined over the complete governed artifact so any metadata or purpose change is traceable.',
        'The tuning split treats unequal complete checksums as evidence that calibration and holdout data are independent.',
        'Relabelling purpose or id changes that checksum without changing the physical samples or trial context.',
        'The optimizer is then scored on observations it already saw, and the resulting validation metric overstates generalization.',
      ],
      rootCause: 'A purpose-dependent artifact identity was reused as a partition-independence identity even though holdout leakage is a property of physical observations and trials, not their labels.',
      resolution: [
        'Derive purpose-neutral identities for the complete observation, electrical current history, scored electrical targets and full trial context so unscored-channel edits cannot disguise reused evidence.',
        'Across calibration and validation, reject overlap on complete observation, trial-content and scored-electrical identities, exact raw-source SHA-256 or a complete declared source-tool/model/run identity; retain electrical-history identity as explicit evidence and bind it into the scored-electrical identity.',
        'Version and checksum the exact preprocessing policy, derive a prepared scored-electrical identity from its state-driving current and selected voltage objective, and reject that overlap across partitions too.',
        'Apply scored-electrical collision rejection across calibration and validation partitions, while allowing controlled protocol reuse inside one partition only across declared SoC or ambient condition changes when its complete observation, trial, raw-source and source-run identities remain distinct.',
        'Return the overlap checks and their identities as governed planning evidence while stating that exact duplicate detection does not prove statistical independence or producer custody.',
      ],
      prevention: [
        'Test purpose and id relabelling explicitly instead of relying on unequal complete dataset checksums.',
        'Pair every cross-partition leakage test with a legitimate matched-condition matrix so a stronger duplicate rule cannot destroy the intended experiment design.',
        'When the dataset contract gains metadata, review whether that field belongs to artifact identity, physical-observation identity, trial identity or more than one of them.',
        'Never promote a caller-designated holdout to independent validation solely because its purpose field says validation.',
      ],
      regressionTests: [
        {
          path: 'tests/calibration-dataset.test.mjs',
          assertion: 'Dataset identity changes with purpose while canonical observation content remains inspectable for a separate purpose-neutral split check.',
        },
        {
          path: 'tests/ecm-tuning-plan.test.mjs',
          assertion: 'The tuning planner rejects calibration/holdout overlap through observation, trial, raw/prepared scored-electrical, raw-source and source-run checks without blocking controlled condition matrices inside training.',
        },
      ],
      affectedSurfaces: ['cli', 'local-api'],
      tags: ['calibration', 'data-leakage', 'holdout', 'identity', 'validation'],
      references: [
        {
          kind: 'implementation',
          locator: 'js/calibration-dataset.js',
          note: 'Complete canonical artifact identity whose purpose sensitivity requires a separate partition identity.',
        },
        {
          kind: 'implementation',
          locator: 'js/ecm-tuning.js',
          note: 'Whole-trial partition planner enforcing observation, trial, raw/preprocessed scored-electrical, raw-source and declared source-run disjointness.',
        },
        {
          kind: 'test',
          locator: 'tests/calibration-dataset.test.mjs',
          note: 'Dataset purpose and complete-checksum identity regressions.',
        },
      ],
    }),
    record({
      id: 'rc-calibration-initial-state-ambiguity',
      title: 'Calibration absorbs an undeclared initial state into fitted parameters',
      symptom: 'A fit can improve while compensating for unknown pre-trial RC polarization, hysteresis or thermal state rather than identifying the requested physical coefficients.',
      evidence: [
        'The simulator initializes both RC voltages and hysteresis to zero and every thermal node to ambient, but older calibration inputs declared only start SoC and ambient temperature.',
        'Two trials with the same current, SoC and ambient can produce different early voltage and temperature traces when one begins polarized or thermally soaked.',
      ],
      detection: [
        {
          method: 'initial-state contract regression',
          signal: 'Remove or change the dataset initial-state declaration and inspect the structured simulation and calibration result assumptions.',
          failureCondition: 'An undeclared or unsupported warm start is accepted, or the zero-RC, zero-hysteresis and ambient-node initialization is absent from returned evidence.',
        },
      ],
      causalChain: [
        'Dynamic ECM and thermal outputs depend on hidden states as well as coefficients and excitation.',
        'The numerical implementation chooses a rested equilibrium state when no explicit state vector is supplied.',
        'A dataset without the same declaration can contain a different prehistory while still matching topology, SoC and ambient metadata.',
        'The optimizer then changes resistances, time constants or thermal coefficients to explain an initial-condition mismatch.',
      ],
      rootCause: 'The calibration contract bound static trial context but did not bind the dynamic state at trial reset or expose the simulator’s implicit rested-state choice in result evidence.',
      resolution: [
        'Require every governed dataset to declare rested-equilibrium-at-ambient, the only currently supported initial state.',
        'Return a structured assumption per simulation or calibration trial stating zero RC polarization, zero hysteresis and all modeled thermal nodes at that trial’s ambient temperature.',
      ],
      prevention: [
        'Reject an absent or unsupported dataset initial state before optimization starts.',
        'Introduce non-rested calibration only with explicit versioned state variables, normalization rules and parameter-identifiability regressions.',
      ],
      regressionTests: [
        {
          path: 'tests/sim2.test.mjs',
          assertion: 'Simulation and calibration return structured rested-state assumptions and calibration rejects missing or unsupported dataset initial-state declarations.',
        },
        {
          path: 'tests/calibration-dataset.test.mjs',
          assertion: 'The canonical dataset binding requires exactly rested-equilibrium-at-ambient.',
        },
      ],
      affectedSurfaces: ['browser', 'cli', 'local-api'],
      tags: ['calibration', 'initial-state', 'model-identifiability', 'rested-state'],
      references: [
        {
          kind: 'implementation',
          locator: 'js/ecm-tuning.js',
          note: 'Versioned coverage gates, deterministic group selection and explicit skip/block evidence.',
        },
        {
          kind: 'implementation',
          locator: 'js/sim2.js',
          note: 'Rested initialization, dataset enforcement and structured result assumptions.',
        },
        {
          kind: 'implementation',
          locator: 'js/calibration-dataset.js',
          note: 'Closed governed initial-state declaration.',
        },
        {
          kind: 'test',
          locator: 'tests/sim2.test.mjs',
          note: 'Simulation and calibration initial-state evidence regressions.',
        },
      ],
    }),
    record({
      id: 'rc-calibration-parameter-identifiability-confounding',
      status: 'mitigated',
      title: 'Automatic ECM tuning selects parameters the traces cannot identify',
      symptom: 'Automatic tuning lowers the training objective by trading correlated resistance, RC, Arrhenius or thermal parameters against one another, but the fitted values are not uniquely supported and fail to transfer to holdout conditions.',
      evidence: [
        'R0, RC resistance and RC time constants can produce similar voltage curves when the trace lacks resolved current steps and sufficiently long relaxation windows.',
        'One ambient-temperature condition cannot separate reference resistance from its Arrhenius activation energy, even when both are individually fit-eligible.',
        'Counting excluded pulses or accepting matched zero-current trials can make a coverage gate pass even though the scored voltage samples have no sensitivity to the requested resistance parameter.',
        'A single good rested OCV sample cannot validate the start-SoC/OCV binding of every other trial used by a multi-condition family.',
        'Evaluating sample-rate and pulse-duration gates before deterministic block preprocessing can activate a fast parameter that the actual optimizer grid no longer resolves.',
        'Ranking candidate protocol families by size before qualification can select a larger invalid family and hide a smaller family that satisfies every governed gate.',
        'A zero-current holdout can report no regression for resistance parameters only because its voltage is invariant to those fitted values.',
        'A mid-SoC-only holdout has a zero symmetric SoC-resistance basis, and a vanishing time step can preserve that zero basis despite strong current signs.',
        'Charge and discharge signs with a vanishing time step do not move the fixed 600 s hysteresis state, so neither calibration nor holdout voltage can observe hystV.',
        'One dataset temperature channel cannot simultaneously represent the cell-average temperature required for near-isothermal Arrhenius evidence and the module maximum required by a thermal acceptance metric.',
        'An unrelated ohmic-only stage can otherwise claim structural readiness while unchanged initial RC time constants already violate the plan-wide ordering constraint required of every candidate.',
        'A module-maximum temperature channel alone does not uniquely identify module conduction, coolant conductance and worst-module current imbalance.',
        'Treating the complete allowlist as an automatic recipe drives compensating parameters toward bounds and turns optimizer convergence into a misleading identifiability claim.',
      ],
      detection: [
        {
          method: 'versioned excitation and coverage matrix regression',
          signal: 'Build plans for traces that independently add current steps, fast and slow relaxation, ambient-temperature span and thermal observability, then inspect selected and skipped parameter groups.',
          failureCondition: 'A parameter group is selected without its declared excitation/coverage preconditions, skipped without an explicit reason, or changes selection under a permutation that preserves the same governed evidence.',
        },
      ],
      causalChain: [
        'The model exposes bounded electrical and thermal parameters that a manual engineer may choose to fit.',
        'An automatic path mistakes technical fit eligibility for evidence that the submitted experiment identifies every eligible coefficient.',
        'The optimizer exploits correlated sensitivities and assigns one missing physical effect to another bounded parameter.',
        'Training error improves while fitted values become non-unique, hit limits or lose accuracy in a genuinely separate operating condition.',
      ],
      rootCause: 'Automatic parameter selection was driven by the model allowlist and available channel names rather than by a versioned experiment-coverage contract for each identifiable parameter group.',
      resolution: [
        'Define a versioned ECM tuning recipe with explicit sampling, current-excitation, relaxation-duration, temperature-span and near-isothermal coverage gates.',
        'Apply excitation gates to included scoring windows, require a valid rested OCV baseline for every used trial, and require nonzero resistance excitation in matched SoC and temperature families.',
        'Run coverage gates on the exact versioned preprocessed grid, choose deterministically among families that pass all gates before considering invalid candidates, and require every holdout to observe the active electrical groups.',
        'For SoC resistance, require scored nonzero-current holdout evidence at an off-mid basis; for hysteresis, require bidirectional scored state excursion over nonzero duration as well as charge/discharge SoC overlap.',
        'Assign validation channels explicit roles: cell-average temperature may establish Arrhenius observability, while at least one separate module-maximum trial is required when thermal acceptance limits are declared.',
        'Validate the initial two-RC ordering before planning any group, then enforce the same minimum time-constant ratio on every executor candidate and final adoption.',
        'Select only the parameter groups whose gates pass, preserve a deterministic stable order, and return every omitted group with its exact skipped reason.',
        'Require multi-condition temperature evidence before selecting Arrhenius activation energy and keep confounded thermal groups out of the automatic recipe when only module-maximum temperature is observed.',
        'Score the resulting parameters on disjoint validation trials and report bound hits or incomplete coverage without calling skipped groups calibrated.',
      ],
      prevention: [
        'Every parameter added to an automatic recipe must bring positive recovery, missing-excitation and confounding regressions before it is selectable.',
        'Version and content-address the selection recipe so a changed coverage rule cannot reuse older tuning evidence silently.',
        'Keep manual fit eligibility, automatic selection and validated model maturity as separate product claims.',
      ],
      regressionTests: [
        {
          path: 'tests/calibration-dataset.test.mjs',
          assertion: 'Canonical trials preserve the timing, segment, temperature-location and operating-context evidence required by tuning coverage gates.',
        },
        {
          path: 'tests/ecm-tuning-plan.test.mjs',
          assertion: 'The planner selects groups only when prepared excitation passes, rejects mid-SoC and zero-duration hysteresis holdouts, and supports separate Arrhenius and thermal validation-channel roles.',
        },
      ],
      affectedSurfaces: ['cli', 'local-api'],
      tags: ['arrhenius', 'calibration', 'confounding', 'ecm', 'identifiability', 'parameter-selection'],
      references: [
        {
          kind: 'implementation',
          locator: 'js/ecm-tuning.js',
          note: 'Preprocessing-aware group selection, family qualification, holdout excitation and explicit pending-sensitivity evidence.',
        },
        {
          kind: 'implementation',
          locator: 'js/sim2.js',
          note: 'Bounded ECM parameter definitions and calibration behavior that require experiment-aware automatic selection.',
        },
        {
          kind: 'test',
          locator: 'tests/calibration-dataset.test.mjs',
          note: 'Governed timing, segment, temperature and binding evidence regressions.',
        },
        {
          kind: 'test',
          locator: 'tests/ecm-tuning-plan.test.mjs',
          note: 'Excluded-evidence, preprocessed-grid, mixed-family, per-trial OCV and observable-holdout regressions.',
        },
      ],
    }),
    record({
      id: 'rc-calibration-result-artifact-shape',
      title: 'Calibration evidence envelope is mistaken for a parameter file',
      symptom: 'The CLI says a calibration result written with --out can be passed to sim2 --params, but the written JSON is a result envelope rather than the parameter object that sim2 accepts.',
      evidence: [
        'The calibration --out path is handled by the shared result emitter and therefore contains apiVersion, cell, metrics and fitted evidence around the params member.',
        'The documented follow-up command passes that complete envelope to --params, whose governed parameter boundary expects only named numeric model parameters.',
      ],
      detection: [
        {
          method: 'producer-to-consumer artifact regression',
          signal: 'Run calibration with both evidence and parameter outputs, then pass the declared reusable parameter artifact to sim2.',
          failureCondition: 'The documented parameter artifact contains result-wrapper keys, is rejected by sim2, or the evidence output is silently reduced to parameters.',
        },
      ],
      causalChain: [
        'One generic --out emitter serializes the complete command result.',
        'Human guidance describes that output as though it were the nested params member.',
        'The next command consumes a different JSON contract and rejects the wrapper or treats its keys as unknown parameters.',
      ],
      rootCause: 'One filename option was assigned two incompatible artifact roles—a complete calibration evidence record and a reusable model-parameter object—without an explicit projection between them.',
      resolution: [
        'Keep --out as the complete calibration evidence result and add a distinct --params-out projection containing only the validated parameter object.',
        'Describe and test each artifact by the contract of its actual downstream consumer.',
      ],
      prevention: [
        'Exercise documented producer-to-consumer command sequences, not only each command in isolation.',
        'Give differently shaped persisted artifacts different flags, format identities and user guidance.',
      ],
      regressionTests: [
        {
          path: 'tests/calibration-surfaces.test.mjs',
          assertion: 'The governed calibration CLI writes a full evidence result separately from a parameter-only artifact that sim2 accepts.',
        },
      ],
      affectedSurfaces: ['cli', 'local-api'],
      tags: ['artifact-contract', 'calibration', 'cli', 'output-shape'],
      references: [
        {
          kind: 'implementation',
          locator: 'desktop/bd.mjs',
          note: 'Calibration result projection and distinct persisted output flags.',
        },
        {
          kind: 'documentation',
          locator: 'docs/SYNTHETIC_CALIBRATION.md',
          note: 'Canonical dataset, evidence-result and parameter-artifact boundaries.',
        },
        {
          kind: 'test',
          locator: 'tests/calibration-surfaces.test.mjs',
          note: 'End-to-end calibration CLI artifact compatibility regression.',
        },
      ],
    }),
    record({
      id: 'rc-calibration-result-identity-gap',
      title: 'Calibration result cannot be tied to the executed request and implementation',
      symptom: 'Two calibration evidence files look comparable but do not prove that they used the same normalized datasets, algorithm, model implementation, cell definition or governed request.',
      evidence: [
        'A fitted parameter map and RMSE values alone omit the executable and request identities that produced them.',
        'Repeating raw source traces inside a result increases disclosure and artifact size without proving their origin or custody.',
        'A checksum stored beside its own content identifies bytes but does not authenticate the producer that supplied those bytes.',
      ],
      detection: [
        {
          method: 'result-lineage and privacy regression',
          signal: 'Change one governed request field, dataset, algorithm/model source or cell implementation and inspect the portable result; also search it for raw signal arrays.',
          failureCondition: 'The result identity remains unchanged, a required implementation identity is absent, or raw calibration samples are echoed into evidence.',
        },
      ],
      causalChain: [
        'Optimization produces useful numeric outputs from several versioned inputs and executable components.',
        'A convenience result initially serializes only metrics, fitted values and caller-facing metadata.',
        'Downstream reviewers cannot distinguish a changed request or implementation, while copying raw traces still does not establish trusted custody.',
      ],
      rootCause: 'Calibration evidence described numeric outcome but lacked a content-addressed lineage envelope separating reproducible identity, producer authentication and private source data.',
      resolution: [
        'Bind request, canonical dataset, algorithm version, model implementation and cell implementation checksums into a deterministic versioned result identity.',
        'State that these digests establish reproducible content identity rather than producer authentication, and keep raw signal arrays out of portable results.',
      ],
      prevention: [
        'Add identity-sensitivity tests for every governed input and executable implementation that can change a fit.',
        'Audit portable evidence recursively for raw current, voltage and temperature traces and require separate custody evidence when authenticity matters.',
      ],
      regressionTests: [
        {
          path: 'tests/calibration-surfaces.test.mjs',
          assertion: 'Calibration results carry deterministic request, dataset, algorithm, model and cell identities with identity-not-authentication semantics and no raw traces.',
        },
      ],
      affectedSurfaces: ['cli', 'local-api'],
      tags: ['artifact-identity', 'calibration', 'checksum', 'privacy', 'provenance'],
      references: [
        {
          kind: 'implementation',
          locator: 'desktop/bd.mjs',
          note: 'Governed calibration request and portable result evidence projection.',
        },
        {
          kind: 'implementation',
          locator: 'js/sim2.js',
          note: 'Versioned algorithm behavior and deterministic calibration evidence inputs.',
        },
        {
          kind: 'test',
          locator: 'tests/calibration-surfaces.test.mjs',
          note: 'Result identity sensitivity, privacy and reproducibility regressions.',
        },
      ],
    }),
    record({
      id: 'rc-calibration-trace-alignment-loss',
      title: 'Calibration silently compares misaligned trace samples',
      symptom: 'A calibration can report a plausible or improved RMSE even though current, voltage and temperature no longer describe the same samples.',
      evidence: [
        'A prefix-only RMSE based on the shorter array discards every unmatched tail value instead of rejecting unequal signal lengths.',
        'Dropping one malformed CSV row independently from a signal column shifts the remaining observations while leaving numeric arrays that still look usable.',
        'Inferring the sample period from only the first timestamp delta misses later gaps, and an unstated start-versus-end sample phase introduces a one-step offset.',
        'A reduction block crossing an include/exclude boundary can average current over the whole block while scoring voltage from only the included subset, so prediction and observation represent different source samples.',
        'Counting required modes or included samples on raw segments can claim acceptance coverage even when deterministic preprocessing merges that mode away or leaves fewer scored points than the declared minimum.',
        'The simulator previously stamped sample k at k·dt and combined a pre-transition terminal voltage with post-transition SoC and temperature in the same output row.',
        'A source trace can also declare current per cell while the plant consumes pack current, requiring multiplication by parallelCells; omitting it creates a parallel-count scaling error without changing array alignment.',
      ],
      detection: [
        {
          method: 'adversarial trace-alignment regression',
          signal: 'Change one signal length, corrupt one CSV row, perturb a non-first timestamp delta, shift the declared sample phase or current scope, place a segment boundary inside a reduction block, or make a required mode disappear on the prepared grid.',
          failureCondition: 'Import or calibration proceeds, compares a shared prefix, silently realigns a sample, or reports raw acceptance coverage that the prepared scored evidence does not retain.',
        },
      ],
      causalChain: [
        'Delimited columns and measured arrays enter the optimizer without one enforced row identity and time convention.',
        'Invalid values can be removed independently, or irregular timing can be summarized from the first interval alone.',
        'Independent reduction rules can also mix source rows at an include/exclude boundary while preserving equal output-array lengths.',
        'If simulator output rows mix start- and end-state values, even a correctly imported end-of-step observation is compared against a physically different instant.',
        'The objective compares only the common prefix and therefore hides both missing tails and one-step phase shifts behind a finite RMSE.',
      ],
      rootCause: 'The calibration boundary lacked a single fail-closed trace contract that binds equal signal cardinality, every timestamp interval and explicit sample phase before objective evaluation.',
      resolution: [
        'Normalize complete source rows into one immutable dataset with equal-length current, voltage and optional temperature signals plus explicit end-of-step alignment.',
        'Validate every timestamp delta, reject an invalid row rather than dropping fields independently, and require RMSE operands to have exactly equal nonzero lengths.',
        'Average current over each complete reduction block, retain end-of-step voltage and temperature, and leave every mixed-selection boundary block in state history but out of the scored objective.',
        'Evaluate minimum scored-sample and required-mode acceptance coverage on the exact prepared blocks; count a mode only when a complete scored block retains it without crossing into another mode.',
        'Normalize cell current to pack amperes by multiplying by parallelCells, and emit simulator time, voltage, SoC and temperature from the same transitioned end state at (k+1)·dt.',
      ],
      prevention: [
        'Never truncate calibration operands to their shortest shared prefix or infer a timebase from one interval.',
        'Keep malformed-row, unequal-array, nonuniform-time, one-sample phase-shift and non-factor-aligned segment-boundary cases in the governed import and optimizer regressions.',
        'Bind source time origin, first-sample offset, sample phase and current scope into the checksummed normalization record.',
      ],
      regressionTests: [
        {
          path: 'tests/calibration-import.test.mjs',
          assertion: 'Import rejects malformed rows and nonuniform timing, binds source/reset time and end-step phase, and converts declared cell current to pack current by parallelCells.',
        },
        {
          path: 'tests/sim2.test.mjs',
          assertion: 'Simulation emits physically aligned end-of-step rows; calibration rejects unequal lengths, preserves that phase and reports mixed preprocessing boundary blocks instead of scoring them.',
        },
        {
          path: 'tests/ecm-tuning-plan.test.mjs',
          assertion: 'Tuning acceptance uses prepared included-point counts and rejects a raw one-sample required mode that deterministic block preprocessing merges away.',
        },
      ],
      affectedSurfaces: ['browser', 'cli', 'local-api'],
      tags: ['calibration', 'csv', 'rmse', 'sample-alignment', 'timebase'],
      references: [
        {
          kind: 'implementation',
          locator: 'js/calibration-dataset.js',
          note: 'Canonical immutable signal lengths, timing and sample-alignment contract.',
        },
        {
          kind: 'implementation',
          locator: 'js/sim2.js',
          note: 'Calibration objective and strict full-trace RMSE behavior.',
        },
        {
          kind: 'implementation',
          locator: 'js/ecm-tuning.js',
          note: 'Prepared-grid acceptance sample and mode coverage checks.',
        },
        {
          kind: 'test',
          locator: 'tests/sim2.test.mjs',
          note: 'Optimizer input-alignment and RMSE regressions.',
        },
        {
          kind: 'test',
          locator: 'tests/ecm-tuning-plan.test.mjs',
          note: 'Prepared-grid sample-count and required-mode acceptance regressions.',
        },
      ],
    }),
    record({
      id: 'rc-calibration-work-undercount',
      title: 'Calibration reports less optimizer work than it performs',
      symptom: 'A calibration appears to remain inside its work limit even though simplex initialization, trial probes and final scoring run the simulator many more times than reported.',
      evidence: [
        'The returned iterations value counts outer Nelder-Mead loops but omits initialization, reflection, expansion, contraction, shrink and final before/after simulations.',
        'Allowing maxDtS in the fitted vector changes the number of integration substeps performed by each objective evaluation, so the optimizer mutates its own work cost.',
        'Time-integration counters alone do not bound local-API CPU work when every thermal step also loops over the caller-controlled module count.',
        'A largest-remainder stage allocation performed with floating-point products can exceed a caller-supplied safe-integer ceiling by one near Number.MAX_SAFE_INTEGER even though every input integer is individually valid.',
      ],
      detection: [
        {
          method: 'instrumented optimizer work regression',
          signal: 'Count every simulator invocation and integration substep across initialization, each Nelder-Mead branch and final result materialization, then weight the external service cap by module count.',
          failureCondition: 'The observed work exceeds the declared cap, differs from reported counters, changes because a solver-control parameter was fitted, or a large module count bypasses the local-service CPU limit.',
        },
      ],
      causalChain: [
        'The optimizer exposes a maximum outer-iteration count as though it were the complete computational budget.',
        'Each iteration performs a variable number of objective simulations and shrink can evaluate most simplex vertices again.',
        'Fitting maxDtS also changes simulation substeps, making both numerical fidelity and cost depend on the candidate vector.',
        'The thermal network performs work per module, so an HTTP boundary that caps only time substeps still leaves a caller-controlled multiplier.',
        'A weighted partition multiplies safe integers before division, crossing the exact-integer range and rounding a stage share upward.',
        'The reported counter and configured limit therefore understate and fail to bound actual work.',
      ],
      rootCause: 'Calibration governed loop iterations rather than every expensive simulation evaluation, while a numerical solver-control parameter was allowed to alter work from inside the physical fit vector.',
      resolution: [
        'Count and cap every objective simulation before it starts, including initialization, shrink and final materialization, and report both iterations and simulation evaluations.',
        'Freeze maxDtS as a run setting and reject it as a fitted physical parameter so candidates cannot change the integration-work contract.',
        'At the local-API boundary, cap module count and translate the module-weighted service budget into the core integration-step limit before optimization starts.',
        'Partition safe-integer stage ceilings with BigInt quotient/remainder arithmetic, convert only final bounded shares back to Number, and assert their exact sum.',
      ],
      prevention: [
        'Express calibration limits in directly measurable expensive operations and test every optimizer branch at the exact boundary.',
        'Keep solver controls outside the calibratable parameter allowlist unless a separately governed numerical-convergence study explicitly owns them.',
        'Account for every caller-controlled multiplicative dimension when a reusable core is exposed as a local service.',
        'Test weighted allocation at Number.MAX_SAFE_INTEGER as well as ordinary service ceilings; input validation alone does not make intermediate arithmetic exact.',
      ],
      regressionTests: [
        {
          path: 'tests/sim2.test.mjs',
          assertion: 'Calibration enforces and reports the exact simulation-evaluation budget across all simplex branches and refuses maxDtS as a fit target.',
        },
        {
          path: 'tests/calibration-surfaces.test.mjs',
          assertion: 'The authenticated calibration endpoint rejects requests exceeding its module-weighted work contract.',
        },
        {
          path: 'tests/ecm-tuning-plan.test.mjs',
          assertion: 'Every stage allocation sums exactly to its caller ceiling even at the maximum safe integer.',
        },
      ],
      affectedSurfaces: ['browser', 'cli', 'local-api'],
      tags: ['budget', 'calibration', 'optimizer', 'solver-control', 'work-accounting'],
      references: [
        {
          kind: 'implementation',
          locator: 'js/sim2.js',
          note: 'Nelder-Mead evaluation accounting, work limit and fit-parameter policy.',
        },
        {
          kind: 'test',
          locator: 'tests/sim2.test.mjs',
          note: 'Exact simulation-count, work-cap and solver-control rejection regressions.',
        },
        {
          kind: 'test',
          locator: 'tests/calibration-surfaces.test.mjs',
          note: 'Local-API module and work-multiplier boundary regression.',
        },
      ],
    }),
    record({
      id: 'rc-capability-contract-mismatch',
      title: 'Declared FMI capability disagrees with implementation',
      symptom: 'An importer selects an optional FMI operation because modelDescription.xml advertises support, but the exported function returns an error.',
      evidence: [
        'Changing canGetAndSetFMUstate from false to true leaves state serialization functions implemented only as explicit errors.',
        'Schema validation alone accepts the declaration because it cannot inspect native behavior.',
      ],
      detection: [
        {
          method: 'contract-to-implementation audit',
          signal: 'Compare every advertised CoSimulation capability with the generated C behavior and native probes.',
          failureCondition: 'The XML claims support for an operation whose implementation rejects or omits that operation.',
        },
      ],
      causalChain: [
        'Capability flags and function implementations are represented in separate generated artifacts.',
        'A textual XML edit can enable a capability without changing the C implementation.',
        'An importer trusts the declaration and calls an unsupported operation.',
      ],
      rootCause: 'Packaging validated XML shape but did not require the capability declaration to be the exact canonical projection of implemented behavior.',
      resolution: [
        'Reconstruct and byte-compare the complete canonical modelDescription.xml during packaging.',
        'Keep unsupported state, derivative and asynchronous features honestly declared false.',
      ],
      prevention: [
        'Add tamper cases for every optional capability flag that could change host behavior.',
        'Require behavioral native probes before enabling a capability in the canonical generator.',
      ],
      regressionTests: [
        {
          path: 'tests/fmi-package-design-binding.test.mjs',
          assertion: 'Packaging rejects a model description that advertises FMU state support while the generated implementation does not.',
        },
      ],
      affectedSurfaces: ['compiled-fmu', 'packaging'],
      tags: ['capability', 'fmi', 'model-description', 'packaging'],
      references: [
        {
          kind: 'implementation',
          locator: 'js/fmi.js',
          note: 'Canonical model description and unsupported FMI operation implementations.',
        },
        {
          kind: 'test',
          locator: 'tests/fmi-package-design-binding.test.mjs',
          note: 'Capability-declaration tamper regression.',
        },
      ],
    }),
    record({
      id: 'rc-cli-typo-default-fallback',
      title: 'Unknown CLI option silently falls back to a default',
      symptom: 'A misspelled governed export option appears to succeed but the intended value is ignored and a default drives the artifact.',
      evidence: [
        'The misspelling --enrgy is absent from parsed known options while export still has enough defaults to continue.',
        'The resulting artifact can look valid even though it does not represent the caller’s request.',
      ],
      detection: [
        {
          method: 'negative CLI invocation',
          signal: 'Invoke every governed command with one unknown and one duplicated option.',
          failureCondition: 'The command exits successfully or creates output before reporting the invalid option.',
        },
      ],
      causalChain: [
        'The generic argument parser records values but the command does not close its accepted option set.',
        'A misspelled key remains unused rather than being rejected.',
        'A command default supplies the missing intended value and masks the error.',
      ],
      rootCause: 'The command parsed options permissively and validated required values, but never validated the exact option envelope before applying defaults.',
      resolution: [
        'Define a command-specific option allowlist and reject unknown or duplicated flags before any output is written.',
        'Return a nonzero usage error that names the rejected option.',
      ],
      prevention: [
        'Add typo and duplicate-option cases whenever a governed CLI surface gains a flag.',
        'Perform envelope validation before default resolution or filesystem mutation.',
      ],
      regressionTests: [
        {
          path: 'tests/fmu-release.test.mjs',
          assertion: 'The FMU command rejects --enrgy, exits with a usage failure and creates no output directory.',
        },
      ],
      affectedSurfaces: ['cli', 'fmi-source-kit'],
      tags: ['cli', 'defaults', 'fail-closed', 'typo'],
      references: [
        {
          kind: 'implementation',
          locator: 'desktop/bd.mjs',
          note: 'FMU command option allowlist and duplicate detection.',
        },
        {
          kind: 'test',
          locator: 'tests/fmu-release.test.mjs',
          note: 'Unknown-option and no-partial-output release regression.',
        },
      ],
    }),
    record({
      id: 'rc-e2e-hidden-state-precondition',
      title: 'Browser test acts on a control in an inactive UI state',
      symptom: 'A browser test times out waiting for a visible control even though a hidden DOM locator already found content rendered beside that control.',
      evidence: [
        'The FMI export control is rendered inside the Results tab panel while the designer initially opens the Design tab.',
        'A locator text assertion can match the hidden runner panel, but Playwright role actions correctly wait for a visible button and time out.',
      ],
      detection: [
        {
          method: 'state-aware browser regression',
          signal: 'Navigate to the UI state that owns a control, assert that the control is visible, and only then perform the action.',
          failureCondition: 'The test relies on hidden DOM content or attempts the action before activating the owning tab, dialog or disclosure.',
        },
      ],
      causalChain: [
        'The application renders controls inside tab panels that remain in the DOM while inactive.',
        'A broad locator confirms text in the inactive panel without establishing user-visible state.',
        'The next role-based action requires a visible control and waits until the test timeout.',
      ],
      rootCause: 'The end-to-end test treated DOM presence as proof of an actionable UI state and omitted the navigation precondition a real user must satisfy.',
      resolution: [
        'Activate the Results tab before locating or clicking the FMI export control.',
        'Assert the target button is visible before arming the download event and performing the action.',
      ],
      prevention: [
        'Make every state-dependent browser test explicitly enter the tab, dialog or disclosure that owns its target control.',
        'Use visibility or accessibility-tree assertions for action preconditions rather than hidden-text DOM matches alone.',
      ],
      regressionTests: [
        {
          path: 'tests/e2e/runner.spec.mjs',
          assertion: 'The authenticated FMI export scenario opens Results and proves the export button is visible before clicking it.',
        },
      ],
      affectedSurfaces: ['browser', 'ci'],
      tags: ['browser', 'e2e', 'hidden-state', 'playwright', 'precondition'],
      references: [
        {
          kind: 'incident',
          locator: 'GitHub Actions run 31170518622 job 92841352833',
          note: 'Hosted failure that timed out while the export control remained in an inactive tab panel.',
        },
        {
          kind: 'test',
          locator: 'tests/e2e/runner.spec.mjs',
          note: 'Runner-origin export, download, mapping and accessibility regression.',
        },
      ],
    }),
    record({
      id: 'rc-final-artifact-identity-gap',
      title: 'A temporary build passes while the released artifact is different',
      symptom: 'Validation is green for an intermediate FMU, but the archive attached to the release was regenerated, repackaged or otherwise not the tested bytes.',
      evidence: [
        'A job can validate an unpacked or temporary archive and later create the published archive in a different step.',
        'Matching source inputs do not prove byte identity after compilation, metadata generation and ZIP packaging.',
      ],
      detection: [
        {
          method: 'artifact lineage audit',
          signal: 'Trace the exact FMU SHA-256 from native validation through artifact upload and release attachment.',
          failureCondition: 'Any downstream job regenerates the FMU or cannot prove it consumed the accepted digest.',
        },
      ],
      causalChain: [
        'Validation targets a convenient temporary build tree or archive.',
        'The release path rebuilds or repackages from source instead of promoting the accepted object.',
        'The published bytes have no inherited evidence even when the source revision is the same.',
      ],
      rootCause: 'Release confidence was attached to build intent rather than to the content identity and custody chain of the exact final archive.',
      resolution: [
        'Build the cross-platform FMU once in the gated reusable workflow and upload that exact archive with its SHA-256.',
        'Make release jobs verify and attach the accepted artifact without regeneration.',
      ],
      prevention: [
        'Bind evidence to FMU SHA-256, GUID, source revision, I/O checksum and package inventory.',
        'Fail release workflows that contain a second package or generation command after acceptance.',
      ],
      regressionTests: [
        {
          path: 'tests/fmu-release.test.mjs',
          assertion: 'CI, Pages and release workflows consume the gated artifact and the release attachment job does not regenerate it.',
        },
      ],
      affectedSurfaces: ['ci', 'compiled-fmu', 'release'],
      tags: ['artifact-identity', 'ci', 'release', 'sha256'],
      references: [
        {
          kind: 'workflow',
          locator: '.github/workflows/fmu.yml',
          note: 'Reusable workflow that produces and validates the compiled artifact.',
        },
        {
          kind: 'workflow',
          locator: '.github/workflows/release.yml',
          note: 'Release custody path for the already accepted FMU.',
        },
        {
          kind: 'test',
          locator: 'tests/fmu-release.test.mjs',
          note: 'No-regeneration and artifact-consumer workflow checks.',
        },
      ],
    }),
    record({
      id: 'rc-fmi-calibration-key-ignored',
      title: 'Valid calibration key is ignored by the reduced FMU',
      symptom: 'A calibration field accepted by the full simulation stack is supplied to FMU export, but the compiled reduced plant does not use it.',
      evidence: [
        'The full sim2 parameter vocabulary is larger than the coefficient subset implemented by the one-RC FMU.',
        'A valid full-model key such as rc2R can pass generic calibration validation without appearing in XML, C defaults or runtime equations.',
      ],
      detection: [
        {
          method: 'parameter influence test',
          signal: 'Change each accepted export override independently and compare GUID, XML start, generated C default and native trajectory.',
          failureCondition: 'An accepted override changes none of the representations or outputs that claim to consume it.',
        },
      ],
      causalChain: [
        'The full model and reduced FMU share a convenient parameter validation function.',
        'Validation establishes that a key is meaningful somewhere in sim2, not that it is mapped into this FMU.',
        'The exporter silently drops the valid but unmapped coefficient.',
      ],
      rootCause: 'Input validity was confused with target-model coverage; the exporter lacked an explicit allowlist for coefficients represented by the reduced equations.',
      resolution: [
        'Define the exact reduced-FMU override allowlist and reject every unknown or valid-but-unmapped key for governed exports.',
        'Keep legacy behavior visibly incomplete with deterministic ignored-key warnings.',
      ],
      prevention: [
        'Require one influence regression per accepted model coefficient.',
        'Treat expansion of the full calibration schema and expansion of the FMU equations as separate reviewed changes.',
      ],
      regressionTests: [
        {
          path: 'tests/fmi-design-binding.test.mjs',
          assertion: 'Governed export rejects both unknown keys and valid sim2 keys that the reduced FMU does not represent.',
        },
      ],
      affectedSurfaces: ['compiled-fmu', 'fmi-source-kit', 'local-api'],
      tags: ['calibration', 'fmi', 'parameter-mapping', 'reduced-model'],
      references: [
        {
          kind: 'implementation',
          locator: 'js/fmi.js',
          note: 'Exact reduced-model parameter override allowlist.',
        },
        {
          kind: 'test',
          locator: 'tests/fmi-design-binding.test.mjs',
          note: 'Unmapped and repair-requiring calibration rejection.',
        },
      ],
    }),
    record({
      id: 'rc-fmi-representation-drift',
      title: 'XML, I/O map, generated C and binary drift apart',
      symptom: 'An FMU imports with one declared scalar contract while its source or platform binary uses different value references, defaults or semantics.',
      evidence: [
        'modelDescription.xml, the JSON I/O map, generated C and native binaries are separate files that can each be edited or carried forward stale.',
        'A coordinated metadata rewrite can pass superficial checksum checks while the compiled binary still uses old defaults.',
      ],
      detection: [
        {
          method: 'cross-representation reconstruction',
          signal: 'Regenerate canonical XML and C, inspect binary starts through FMI calls and compare every scalar VR/start with the machine map.',
          failureCondition: 'Any representation differs in GUID, variable order, VR, unit, start, source contract or observed native value.',
        },
      ],
      causalChain: [
        'The same logical contract is serialized independently into XML, JSON, C and compiled code.',
        'Packaging initially checks that required files exist and individual hashes are well formed.',
        'A stale or jointly tampered representation remains internally plausible but disagrees with the executable behavior.',
      ],
      rootCause: 'The package treated each representation as self-describing evidence instead of rederiving all representations from one canonical contract and probing the executable.',
      resolution: [
        'Byte-compare canonical generated XML and C during packaging and verify the machine I/O map semantically.',
        'Load each native binary and check all fixed parameter and input starts against the canonical contract.',
      ],
      prevention: [
        'Keep one append-only scalar descriptor list as the only authored ABI.',
        'Add adversarial tests that rewrite one or several representations together and require packaging to reject them.',
      ],
      regressionTests: [
        {
          path: 'tests/fmi-package-design-binding.test.mjs',
          assertion: 'Coordinated XML, map and resource rewrites cannot hide stale generated C or native binary defaults.',
        },
        {
          path: 'tests/fmu-native.test.mjs',
          assertion: 'Native lifecycle evidence binds binary hashes, source contract, I/O checksum and all declared starts.',
        },
      ],
      affectedSurfaces: ['compiled-fmu', 'packaging'],
      tags: ['abi', 'binary', 'contract-drift', 'fmi', 'xml'],
      references: [
        {
          kind: 'implementation',
          locator: 'js/fmi-signal-map.js',
          note: 'Single immutable scalar ABI definition.',
        },
        {
          kind: 'implementation',
          locator: 'tools/fmu-build.mjs',
          note: 'Canonical reconstruction, inspection and package audit.',
        },
        {
          kind: 'test',
          locator: 'tests/fmi-package-design-binding.test.mjs',
          note: 'Cross-representation tamper regressions.',
        },
      ],
    }),
    record({
      id: 'rc-nelder-mead-bound-simplex-collapse',
      title: 'Bound clamping collapses the Nelder–Mead initial simplex',
      symptom: 'Calibration declares convergence immediately or cannot move a parameter when its starting value is already on a declared bound.',
      evidence: [
        'The original initializer perturbed every axis in the positive direction and then clamped the candidate to its upper bound.',
        'At an upper-bound starting value the perturbed vertex became byte-for-byte identical to x0, removing that independent simplex direction.',
      ],
      detection: [
        {
          method: 'boundary-rank optimizer regression',
          signal: 'Start every fitted parameter at its upper bound and limit work to x0 plus one vertex per fitted axis.',
          failureCondition: 'Fewer than n+1 distinct objective points are evaluated, the simplex reports false convergence, or no inward bound-safe candidate can improve the fit.',
        },
      ],
      causalChain: [
        'The initial simplex always proposes a positive coordinate perturbation.',
        'A fitted value already equals its upper bound, so constraint clamping maps the proposed point back to the base point.',
        'One or more simplex vertices are duplicates and the n-dimensional simplex becomes rank deficient.',
        'The cost spread can appear zero even though the objective improves in the untested inward direction.',
      ],
      rootCause: 'Constraint handling was applied after a one-direction initializer that did not consider available room on either side of each bounded coordinate.',
      resolution: [
        'For each axis, choose the direction with more available bound room and take a representable inward step based on parameter span and scale.',
        'Guarantee one distinct axis vertex per fitted dimension before the first objective evaluation.',
      ],
      prevention: [
        'Test initial-simplex rank at lower bounds, upper bounds, zero-valued starts and mixed parameter scales.',
        'Treat duplicate cached evaluations during initialization as a construction defect rather than as legitimate optimizer savings.',
      ],
      regressionTests: [
        {
          path: 'tests/sim2.test.mjs',
          assertion: 'A fit starting all selected parameters at their upper bounds evaluates n+1 distinct initial points and selects an improving inward vertex.',
        },
      ],
      affectedSurfaces: ['browser', 'cli', 'local-api'],
      tags: ['bounds', 'calibration', 'nelder-mead', 'optimizer', 'simplex'],
      references: [
        {
          kind: 'implementation',
          locator: 'js/sim2.js',
          note: 'Bound-aware full-rank initial simplex construction.',
        },
        {
          kind: 'test',
          locator: 'tests/sim2.test.mjs',
          note: 'Upper-bound simplex rank and improvement regression.',
        },
      ],
    }),
    record({
      id: 'rc-nullable-alias-projection',
      title: 'Nullable grouped option becomes an invalid legacy alias',
      symptom: 'A schema-valid browser DesignSpec is rejected by the governed API because an optional grouped null is copied into a non-nullable flat compatibility field.',
      evidence: [
        'The GUI legitimately emits null for unset requirements.maxMassKg, requirements.maxDimsMm and requirements.profileScaleW.',
        'Normalization copied those null sentinels to flat maxMassKg, maxDimsMm and profileScaleW, after which strict validation rejected the generated aliases.',
      ],
      detection: [
        {
          method: 'cross-shape normalization regression',
          signal: 'Strictly normalize grouped optional nulls and inspect both the grouped values and generated flat aliases.',
          failureCondition: 'Normalization creates a non-nullable flat property from a grouped null or rejects the otherwise valid grouped specification.',
        },
      ],
      causalChain: [
        'The grouped DesignSpec contract uses null as an explicit no-constraint value.',
        'Backwards-compatible normalization projects grouped properties onto older flat aliases whenever the key exists.',
        'The projection copies null even though the flat alias accepts only a concrete number, object or string.',
        'Strict validation evaluates the normalized object and rejects the alias created by normalization itself.',
      ],
      rootCause: 'Compatibility projection treated property presence as sufficient without reconciling the grouped nullable domain with the narrower legacy alias domain.',
      resolution: [
        'Project grouped compatibility aliases only when the source value is not null or undefined.',
        'Retain the grouped null so the caller’s explicit no-constraint state remains visible and immutable.',
      ],
      prevention: [
        'Test every grouped-to-flat alias at null, falsey-valid and representative concrete values under strict closed validation.',
        'Require browser-to-governed-API E2E coverage for the default unset optional fields.',
      ],
      regressionTests: [
        {
          path: 'tests/design-spec.test.mjs',
          assertion: 'Strict closed normalization preserves grouped nulls without creating invalid flat aliases.',
        },
        {
          path: 'tests/e2e/runner.spec.mjs',
          assertion: 'The default browser design exports through the governed runner and produces the canonical FMI download and mapping.',
        },
        {
          path: 'tests/runner-security.test.mjs',
          assertion: 'The authenticated governed FMU API accepts grouped optional nulls without generating invalid flat fields.',
        },
      ],
      affectedSurfaces: ['browser', 'ci', 'design-spec', 'local-api'],
      tags: ['alias', 'compatibility', 'design-spec', 'normalization', 'null'],
      references: [
        {
          kind: 'implementation',
          locator: 'js/design-spec.js',
          note: 'Grouped-to-flat compatibility projection and governed normalization.',
        },
        {
          kind: 'incident',
          locator: 'GitHub Actions run 31171091488 job 92843162531',
          note: 'Hosted runner export failure for unset optional browser requirements.',
        },
        {
          kind: 'test',
          locator: 'tests/design-spec.test.mjs',
          note: 'Strict grouped-null projection regression.',
        },
      ],
    }),
    record({
      id: 'rc-object-allowlist-prototype-bypass',
      title: 'Inherited object member bypasses an exact-key allowlist',
      symptom: 'A supposedly closed parameter map accepts a key such as constructor or toString, then silently carries or ignores it even though no governed parameter declares that name.',
      evidence: [
        'The allowlist was stored in a normal JavaScript object and membership was tested with a truthy property lookup.',
        'Names inherited from Object.prototype therefore appeared present even though they were not own entries in the parameter registry.',
        'Spreading the caller map retained the unexpected own property while later loops over declared parameter specifications never validated or used it.',
      ],
      detection: [
        {
          method: 'prototype-name boundary fuzzing',
          signal: 'Submit constructor, toString, valueOf and __proto__-shaped keys anywhere an object-backed allowlist guards external names.',
          failureCondition: 'Any inherited name passes membership without an own registry entry or survives into the governed result.',
        },
      ],
      causalChain: [
        'A plain object is used as a convenient string-to-definition lookup table.',
        'Validation treats lookup truthiness as proof of allowlist membership.',
        'Prototype-chain properties satisfy that test despite not belonging to the governed registry.',
        'The external object is merged before exact declared-key validation, so the unknown value is accepted or silently ignored.',
      ],
      rootCause: 'Object property lookup and own-key membership were treated as equivalent at a trust boundary even though normal objects inherit prototype members.',
      resolution: [
        'Test registry membership with Object.hasOwn, a Set, a Map or an intentionally null-prototype dictionary.',
        'Apply the same own-key rule at both the automatic tuning planner and the core calibrateDatasets parameter-override boundary.',
        'Keep the subsequent value validation driven by the same canonical registry so accepted names and validated names cannot diverge.',
      ],
      prevention: [
        'Include common prototype member names in every exact-key and parameter-allowlist negative test matrix.',
        'Ban truthy object lookup as a membership predicate at external request, configuration and model-parameter boundaries.',
      ],
      regressionTests: [
        {
          path: 'tests/ecm-tuning-plan.test.mjs',
          assertion: 'The governed ECM parameter override boundary rejects constructor as an unknown parameter rather than inheriting it from the registry prototype.',
        },
        {
          path: 'tests/sim2.test.mjs',
          assertion: 'The core governed-dataset calibrator rejects constructor and toString parameter overrides as unknown own-key violations.',
        },
      ],
      affectedSurfaces: ['browser', 'cli', 'local-api'],
      tags: ['allowlist', 'object-prototype', 'parameters', 'validation'],
      references: [
        {
          kind: 'implementation',
          locator: 'js/ecm-tuning.js',
          note: 'Own-key membership check for governed parameter overrides.',
        },
        {
          kind: 'implementation',
          locator: 'js/sim2.js',
          note: 'Core calibrateDatasets parameter override boundary using the same own-key registry rule.',
        },
        {
          kind: 'test',
          locator: 'tests/ecm-tuning-plan.test.mjs',
          note: 'Inherited registry-name rejection regression.',
        },
        {
          kind: 'test',
          locator: 'tests/sim2.test.mjs',
          note: 'Core constructor and toString override rejection regression.',
        },
      ],
    }),
    record({
      id: 'rc-packaged-dependency-omission',
      title: 'Packaged runtime omits a newly imported dependency tree',
      symptom: 'The source checkout runs correctly, but staged desktop bd and MCP entry points fail at startup because an imported top-level runtime tree is absent from the package.',
      evidence: [
        'The root-cause library imports schema and seed records from knowledge/root-causes while desktop staging previously copied js and desktop but not knowledge.',
        'The isolated packaged-tree smoke reports an import failure only after source-level tests have already passed.',
        'A healthy installed runner proves static imports resolved, but only an authenticated calibration request proves the newly shipped dataset/import/core path executes from the installed resource tree.',
      ],
      detection: [
        {
          method: 'isolated packaged-tree import and startup test',
          signal: 'Stage the declared runtime entries into a temporary tree, import the staged bd command and start its local runner.',
          failureCondition: 'A static runtime import resolves in the checkout but is missing from the staged tree or the staged entry point cannot start.',
        },
      ],
      causalChain: [
        'A runtime module adds a static import from a new top-level knowledge directory.',
        'Desktop packaging copies a manually maintained allowlist of top-level runtime entries.',
        'The allowlist is not updated with the new import, so source execution succeeds while the staged dependency closure is incomplete.',
        'Packaged bd and MCP startup resolve the missing import and fail before command dispatch.',
      ],
      rootCause: 'The packaging manifest was a manual top-level allowlist with no automatic dependency-closure check tying a newly imported runtime tree to the staged artifact.',
      resolution: [
        'Add the knowledge tree to the required staged runtime entries and to the independent MUST_SHIP regression list.',
        'Keep the isolated staged import/startup smoke as the acceptance test for the packaged dependency closure.',
        'Exercise one tiny governed calibration through both the staged runner and each installed Linux package.',
      ],
      prevention: [
        'Review desktop staging whenever a shipped entry point imports from a new top-level directory.',
        'Require both manifest membership and an isolated staged entry-point import so copying a name without usable dependencies cannot pass.',
        'When a packaged local-API capability gains a dependency path, add a bounded authenticated request to the installed smoke rather than relying on the capabilities probe alone.',
      ],
      regressionTests: [
        {
          path: 'tests/packaged-tree.test.mjs',
          assertion: 'Desktop staging must ship knowledge and calibration dependencies, then the isolated staged runner must execute an authenticated governed calibration without reaching back into the checkout.',
        },
        {
          path: 'tools/smoke-installed-linux.sh',
          assertion: 'Each installed .deb and AppImage runner answers one bounded authenticated canonical-dataset calibration request.',
        },
      ],
      affectedSurfaces: ['cli', 'local-api', 'mcp', 'packaging'],
      tags: ['dependency-closure', 'desktop', 'packaging', 'staging'],
      references: [
        {
          kind: 'implementation',
          locator: 'desktop-app/prepare.mjs',
          note: 'Explicit top-level runtime staging manifest.',
        },
        {
          kind: 'implementation',
          locator: 'js/root-cause-library.js',
          note: 'Runtime import of the versioned knowledge records.',
        },
        {
          kind: 'test',
          locator: 'tests/packaged-tree.test.mjs',
          note: 'Isolated staged-tree dependency and startup regression.',
        },
        {
          kind: 'test',
          locator: 'tools/smoke-installed-linux.sh',
          note: 'Installed Linux package launch and authenticated calibration execution gate.',
        },
      ],
    }),
    record({
      id: 'rc-product-surface-claim-drift',
      title: 'Product surface copy drifts from executable capability and metric contracts',
      symptom: 'Customer output assigns calibration behavior to a surface that does not implement it or labels a mixed-unit calibration objective as though it were voltage RMSE.',
      evidence: [
        'The add-on registry identifies concrete desktop-GUI, CLI, local-API and MCP surfaces, but freehand status copy used one slash-separated interface phrase for several different capabilities.',
        'The MCP tool registry contains design, mission, review and diagnosis operations but no operation that accepts a calibration dataset or runs the optimizer.',
        'The source and staged Node entry point implements a calibration CLI, while the installed desktop packages expose the runner application and do not yet install an independent bd command wrapper.',
        'Only the CLI importer accepts mapped delimited or columnar-JSON traces; the authenticated local API accepts canonical datasets and cannot normalize raw source exports.',
        'When temperature weighting is enabled, rmseBefore and rmseAfter are voltage RMSE plus weightTemp times temperature RMSE, but the earlier human formatter appended V to that combined score.',
      ],
      detection: [
        {
          method: 'negative surface-capability regression',
          signal: 'Compare the registry, capabilities response, visible GUI controls, MCP tool list, installed entry points, accepted request contracts and human metric labels with their executable implementations.',
          failureCondition: 'Customer-facing copy assigns a capability to a surface that cannot execute it or gives a combined objective the unit of only one constituent metric.',
        },
      ],
      causalChain: [
        'Several desktop-only capabilities are summarized in one manually written sentence.',
        'CLI, local API and MCP are treated as interchangeable automation surfaces.',
        'Source-tree and staged-entry execution is also treated as proof that the installed package ships a same-named command wrapper.',
        'Raw import and canonical fitting are described as one undifferentiated operation even though only the CLI owns the importer.',
        'A generic rmse field is formatted as volts without checking whether it contains a weighted temperature term.',
        'Customer copy therefore inherits behavior or units that the underlying surface and metric contracts do not provide.',
      ],
      rootCause: 'Customer-facing capability and metric prose was maintained independently from structured per-surface request and result contracts, so convenient grouping replaced an exact implementation projection.',
      resolution: [
        'Declare governed calibration as its own shipped add-on on CLI and local API only, separate from the desktop-GUI simulation add-on.',
        'State explicitly that MCP provides design and review automation but does not run calibration, and expose local-API capabilities separately from GUI and MCP lists.',
        'Describe CLI commands as source/staged entry-point capabilities until package manifests and installed-tree smoke tests prove a real installed wrapper.',
        'Assign mapped raw-trace normalization only to the CLI importer and describe both CLI and authenticated API fitting as canonical-dataset consumers.',
        'Print voltage and temperature RMSE separately with their physical units, then label their weighted sum as an objective score without a physical unit.',
      ],
      prevention: [
        'Test negative surface assertions as well as positive ones whenever a capability is added or moved.',
        'Build capability summaries from the surface registry where possible and keep unavoidable prose explicit rather than using ambiguous slash-grouped interfaces.',
        'Distinguish source, staged and installed entry points in release claims and exercise the exact path customers receive.',
        'Require exact wording tests when one add-on spans surfaces with different accepted input contracts.',
        'Drive human metric labels from explicit result fields and test every multi-metric weighting mode for correct units.',
      ],
      regressionTests: [
        {
          path: 'tests/addons.test.mjs',
          assertion: 'Calibration surface copy assigns raw normalization only to the CLI importer, canonical fitting to CLI/API, and explicitly excludes desktop GUI and MCP.',
        },
        {
          path: 'tests/calibration-surfaces.test.mjs',
          assertion: 'Capability responses separate GUI, CLI, API and MCP, while weighted CLI output keeps voltage, temperature and combined-objective units distinct.',
        },
        {
          path: 'tests/packaged-tree.test.mjs',
          assertion: 'Package tests distinguish the staged bd entry point from the installed runner and do not invent an unshipped installed CLI wrapper.',
        },
      ],
      affectedSurfaces: ['browser', 'cli', 'documentation', 'local-api', 'mcp', 'packaging'],
      tags: ['calibration', 'capability', 'messaging', 'metric-units', 'packaging', 'product-surface'],
      references: [
        {
          kind: 'implementation',
          locator: 'js/addons.js',
          note: 'Canonical shipped/planned status and concrete product-surface declarations.',
        },
        {
          kind: 'implementation',
          locator: 'js/desktop-link.js',
          note: 'Browser and authenticated desktop runner status copy.',
        },
        {
          kind: 'test',
          locator: 'tests/addons.test.mjs',
          note: 'Exact raw-import and canonical-fit surface wording assertions.',
        },
        {
          kind: 'test',
          locator: 'tests/calibration-surfaces.test.mjs',
          note: 'Weighted-objective human metric unit regression.',
        },
        {
          kind: 'test',
          locator: 'tests/packaged-tree.test.mjs',
          note: 'Staged and installed entry-point truthfulness regression.',
        },
      ],
    }),
    record({
      id: 'rc-rc-euler-step-instability',
      title: 'Euler RC update becomes unstable inside declared solver bounds',
      symptom: 'A valid short RC time constant and coarse allowed solver step produce oscillating or exploding polarization voltage and nonphysical heat.',
      evidence: [
        'The explicit Euler multiplier dt/tau can reach 600 with maxDtS=60 s and rc1TauS=0.1 s, far beyond its stable range.',
        'Heat was calculated from the newly overshot RC voltage squared, so one unstable state step was amplified into extreme or non-finite thermal bookkeeping.',
        'The same output row mixed pre-transition terminal voltage with post-transition RC, SoC and temperature states, obscuring the numerical failure phase.',
      ],
      detection: [
        {
          method: 'closed-form bound-extreme regression',
          signal: 'Run every minimum/maximum tau and maxDtS combination under a constant-current step and compare polarization with 1-exp(-dt/tau).',
          failureCondition: 'Polarization differs from the analytic update or any instantaneous/integrated heat value is negative or non-finite.',
        },
      ],
      causalChain: [
        'A continuous first-order RC state is advanced with explicit Euler integration.',
        'Declared parameter and solver bounds permit dt to be hundreds of time constants.',
        'Euler overshoots the bounded exponential relaxation and repeated steps amplify the error.',
        'Squaring the unstable voltage contaminates irreversible loss and thermal state.',
      ],
      rootCause: 'The implementation used a conditionally stable numerical approximation for a linear state whose exact constant-current exponential transition is available and inexpensive.',
      resolution: [
        'Advance each RC branch with an expm1-based exact exponential update that remains accurate for both very small and very large dt/tau.',
        'Integrate branch resistive heat consistently over the exact state transition and report instantaneous heat from the aligned end state.',
      ],
      prevention: [
        'Validate numerical methods across the Cartesian product of declared state and solver bounds, not only at default values.',
        'Use analytic transitions for linear submodels and keep energy/heat bookkeeping tied to the same state trajectory.',
      ],
      regressionTests: [
        {
          path: 'tests/sim2.test.mjs',
          assertion: 'All tau/maxDt bound combinations match the analytic RC step and retain finite non-negative instantaneous and integrated irreversible heat.',
        },
      ],
      affectedSurfaces: ['browser', 'cli', 'local-api'],
      tags: ['ecm', 'numerical-stability', 'rc-network', 'thermal'],
      references: [
        {
          kind: 'implementation',
          locator: 'js/sim2.js',
          note: 'Exact RC state transition and stable heat integration.',
        },
        {
          kind: 'test',
          locator: 'tests/sim2.test.mjs',
          note: 'Analytic step response and bound-extreme numerical regressions.',
        },
      ],
    }),
    record({
      id: 'rc-resource-self-checksum-trust',
      title: 'Duplicated resource and checksum are trusted together',
      symptom: 'A design or I/O resource is modified and its adjacent checksum is recomputed, allowing both altered values to appear mutually consistent.',
      evidence: [
        'A checksum proves content identity only relative to a trusted expected digest; a digest stored beside mutable content is another mutable claim.',
        'Copied module facts or semantic checksums can be jointly rewritten without preserving the DesignSpec-derived engineering relationships.',
      ],
      detection: [
        {
          method: 'semantic tamper test',
          signal: 'Change a derived fact, recompute every checksum available inside the resource and run package audit.',
          failureCondition: 'The altered resource passes without rederiving its facts from the bound DesignSpec and canonical contract.',
        },
      ],
      causalChain: [
        'A generated resource duplicates derived design facts for portability.',
        'The resource also carries a checksum calculated from those same facts.',
        'Validation compares the content only with its self-reported checksum rather than with an independent derivation.',
      ],
      rootCause: 'Integrity metadata and the data it was meant to protect shared the same trust boundary, so consistency was mistaken for authenticity and semantic correctness.',
      resolution: [
        'Recompute the semantic graph, module partition and physical arithmetic from the bound immutable design during verification.',
        'Bind the verified design snapshot and I/O contract checksums into the FMU GUID and package manifest.',
      ],
      prevention: [
        'Classify every checksum by its trusted input and expected source rather than by digest syntax alone.',
        'Include coordinated content-plus-checksum tampering in resource regression tests.',
      ],
      regressionTests: [
        {
          path: 'tests/fmi-package-design-binding.test.mjs',
          assertion: 'A self-consistent rewritten design resource fails independent semantic and physical revalidation.',
        },
      ],
      affectedSurfaces: ['compiled-fmu', 'design-spec', 'packaging'],
      tags: ['checksum', 'design-binding', 'provenance', 'semantic-validation'],
      references: [
        {
          kind: 'implementation',
          locator: 'js/fmi-export-snapshot.js',
          note: 'Design snapshot materialization and independent verification.',
        },
        {
          kind: 'test',
          locator: 'tests/fmi-package-design-binding.test.mjs',
          note: 'Design-resource forgery and semantic revalidation regressions.',
        },
      ],
    }),
    record({
      id: 'rc-schema-envelope-permissive',
      title: 'Strict payload validation leaves the request envelope permissive',
      symptom: 'A strict DesignSpec is validated correctly, but a misspelled sibling field in the surrounding API request is ignored or replaced by a default.',
      evidence: [
        'The nested spec can reject unknown design keys while wrapper keys such as param or modelname remain outside that validator.',
        'The endpoint can return a complete-looking export even though the caller’s wrapper option never reached the builder.',
      ],
      detection: [
        {
          method: 'boundary fuzz test',
          signal: 'Mutate each request-envelope key while keeping the nested governed document valid.',
          failureCondition: 'An unknown, misspelled or duplicated wrapper field is accepted or causes a silent default.',
        },
      ],
      causalChain: [
        'Validation is concentrated on the complex inner DesignSpec.',
        'The smaller outer request object is destructured without an exact-key check.',
        'Unknown wrapper keys disappear during destructuring and defaults mask the absent intended field.',
      ],
      rootCause: 'The trust boundary was drawn around the inner schema instead of around the complete external request envelope and every nested governed object.',
      resolution: [
        'Validate the API envelope against the exact allowed key set before destructuring or defaulting.',
        'Require a schema-versioned, recursively closed DesignSpec on the governed FMU endpoint.',
      ],
      prevention: [
        'Define and test a closed envelope for every external command, API and MCP operation.',
        'Pair positive schema fixtures with unknown-key, casing and singular/plural typo cases at every nesting level.',
      ],
      regressionTests: [
        {
          path: 'tests/runner-security.test.mjs',
          assertion: 'The FMU API rejects param, modelname, extra envelope fields and incomplete or unknown governed design values before export.',
        },
      ],
      affectedSurfaces: ['design-spec', 'local-api'],
      tags: ['api-envelope', 'closed-schema', 'defaults', 'validation'],
      references: [
        {
          kind: 'implementation',
          locator: 'desktop/bd.mjs',
          note: 'Local API request-envelope validation and governed export route.',
        },
        {
          kind: 'implementation',
          locator: 'js/design-spec.js',
          note: 'Recursive closed-key DesignSpec validation.',
        },
        {
          kind: 'test',
          locator: 'tests/runner-security.test.mjs',
          note: 'Outer-envelope and nested-spec negative tests.',
        },
      ],
    }),
    record({
      id: 'rc-signed-bound-evidence-miss',
      title: 'Multiplicative bound evidence misses signed parameter limits',
      symptom: 'A fitted negative parameter lands exactly on its declared lower bound but the result reports atBound false.',
      evidence: [
        'The former check compared value <= min*(1+epsilon), which moves a negative minimum farther below the legal interval rather than creating an inward tolerance.',
        'The same sign-dependent arithmetic applies different effective tolerances at lower and upper bounds and behaves poorly near zero.',
      ],
      detection: [
        {
          method: 'signed-bound calibration regression',
          signal: 'Fit a signed coefficient from exact synthetic traces initialized at its negative lower bound, positive upper bound and an interior negative value.',
          failureCondition: 'Either exact bound is not flagged or the interior value is reported as bound-limited.',
        },
      ],
      causalChain: [
        'Optimizer evidence tries to tolerate floating-point movement around declared parameter limits.',
        'Tolerance is implemented by multiplying each bound by one plus or minus epsilon.',
        'Multiplication reverses the intended inward direction for a negative lower bound and degenerates around zero.',
        'The reported constraint evidence disagrees with the optimizer’s actual legal interval.',
      ],
      rootCause: 'Bound proximity was defined as a multiplicative comparison against signed endpoint values instead of an absolute distance scaled by the declared interval.',
      resolution: [
        'Measure absolute distance from both endpoints using the maximum of a span-relative tolerance and a machine-precision absolute tolerance.',
        'Apply the same symmetric predicate to negative, positive and zero-adjacent parameter ranges.',
      ],
      prevention: [
        'Test every evidence predicate across negative lower, positive upper and interior signed values.',
        'Use interval span or explicit engineering tolerance for proximity; never infer direction by multiplying a signed endpoint.',
      ],
      regressionTests: [
        {
          path: 'tests/sim2.test.mjs',
          assertion: 'Synthetic entropyVK fits flag both -0.002 and +0.002 bounds while leaving an interior negative value unflagged.',
        },
      ],
      affectedSurfaces: ['browser', 'cli', 'local-api'],
      tags: ['bounds', 'calibration', 'evidence', 'signed-parameter'],
      references: [
        {
          kind: 'implementation',
          locator: 'js/sim2.js',
          note: 'Span-scaled absolute parameter-bound evidence predicate.',
        },
        {
          kind: 'test',
          locator: 'tests/sim2.test.mjs',
          note: 'Negative lower, positive upper and signed interior bound regressions.',
        },
      ],
    }),
    record({
      id: 'rc-source-revision-self-claim',
      title: 'Manifest Git SHA is accepted without a trusted expectation',
      symptom: 'A package reports a syntactically valid sourceRevision and is labeled verified even though no trusted checkout or caller supplied the expected commit.',
      evidence: [
        'Any producer able to alter a manifest can replace both content and its sourceRevision claim with another forty-character lowercase SHA.',
        'Offline audit can validate syntax and internal consistency but cannot establish which repository commit actually produced the bytes.',
      ],
      detection: [
        {
          method: 'provenance trust audit',
          signal: 'Run audit with a manifest SHA but without expectedSourceRevision or BATTERY_DESIGN_SOURCE_REVISION.',
          failureCondition: 'The audit reports verified provenance rather than an explicitly unverified manifest claim.',
        },
      ],
      causalChain: [
        'The build manifest contains a sourceRevision field.',
        'Audit validates that the field looks like a Git commit SHA.',
        'The manifest value is compared with itself or no external expected value and is promoted to verified.',
      ],
      rootCause: 'A provenance claim supplied by the artifact producer was treated as evidence from an independent trusted authority.',
      resolution: [
        'Distinguish no claim, unverified manifest claim and verified expected-revision match in audit results.',
        'Require the checked-out SHA from explicit input or environment for release packaging.',
      ],
      prevention: [
        'Make trust basis a structured field in every provenance result.',
        'Fail release packaging before metadata writes when a verified source revision is required but no expected revision exists.',
      ],
      regressionTests: [
        {
          path: 'tests/fmi-package-design-binding.test.mjs',
          assertion: 'Offline self-claims stay unverified and required packaging succeeds only on an exact trusted expected revision.',
        },
      ],
      affectedSurfaces: ['ci', 'compiled-fmu', 'packaging', 'release'],
      tags: ['git', 'provenance', 'source-revision', 'trust-boundary'],
      references: [
        {
          kind: 'implementation',
          locator: 'tools/fmu-build.mjs',
          note: 'Source-revision trust classification and required release gate.',
        },
        {
          kind: 'test',
          locator: 'tests/fmi-package-design-binding.test.mjs',
          note: 'No-claim, self-claim, mismatch and trusted-match regressions.',
        },
      ],
    }),
    record({
      id: 'rc-thermal-explicit-step-instability',
      title: 'Thermal Euler step violates stability, accuracy and state alignment',
      symptom: 'Legal thermal coefficients and solver steps produce exploding, severely over-damped or phase-misaligned module and coolant temperatures.',
      evidence: [
        'At cpCellJkgK=300, hCoolWK=500, uaAmbWK=200 and maxDtS=60, a one-cell node was advanced far beyond its C/G stability scale and diverged catastrophically.',
        'Using exactly C/G prevents sign oscillation but maps a one-time-constant cooling interval almost directly to equilibrium instead of the analytic exp(-1) remaining temperature.',
        'The coolant outlet retained the pre-update temperature of the final microstep while voltage, SoC and module temperature were reported from the transitioned end state.',
        'For one module the currentImbalance multiplier was applied to all generated pack heat, violating heat-capacity conservation; multi-node shares also require an exact unit sum.',
      ],
      detection: [
        {
          method: 'closed-form thermal and conservation regression',
          signal: 'Run the legal stiff one-node case, a one-time-constant zero-heat cooling decay, single/multi-node heat balances and an end-step coolant outlet calculation.',
          failureCondition: 'Any state is non-finite or leaves physical bounds, decay differs materially from exp(-1), generated heat is not conserved, or coolant output uses a pre-transition node state.',
        },
      ],
      causalChain: [
        'The electrical maxDt setting is reused as though it also resolved every thermal time constant.',
        'Large legal conductance and small node heat capacity make the fastest C/G thermal scale orders of magnitude shorter than that electrical step.',
        'Unrestricted Euler updates diverge, while a bare monotonicity limit is stable but too inaccurate for parameter calibration.',
        'Heat allocation and coolant reporting are then evaluated with inconsistent node multiplicity or state phase, contaminating otherwise finite results.',
      ],
      rootCause: 'The thermal network lacked one governed numerical contract tying declared coefficient bounds to accuracy-limited stable steps, conserved heat shares and fully end-of-step output semantics.',
      resolution: [
        'Substep the explicit thermal network at no more than 0.02*C/G for the worst local conductance, providing at least fifty steps per fastest time constant and non-negative update weights.',
        'Freeze a conservative thermal step across every calibration candidate and charge every added temporal and node update to its work evidence.',
        'Use exactly one total generated-heat share for a one-node network, unit-sum imbalance shares for multiple nodes, and reevaluate coolant outlet from final node temperatures for reporting.',
      ],
      prevention: [
        'Test numerical stability and convergence across the Cartesian product of declared thermal bounds, not only default packs.',
        'Compare linear one-node cases with closed-form exponential decay and enforce energy conservation independently of current-imbalance settings.',
        'Require every reported channel to name and regress its sample phase whenever integration gains internal microsteps.',
      ],
      regressionTests: [
        {
          path: 'tests/sim2.test.mjs',
          assertion: 'Legal stiff thermal cases remain bounded, match one-time-constant exponential cooling, conserve single/multi-node heat and report final-state coolant output.',
        },
      ],
      affectedSurfaces: ['browser', 'cli', 'local-api'],
      tags: ['energy-conservation', 'numerical-accuracy', 'numerical-stability', 'thermal'],
      references: [
        {
          kind: 'implementation',
          locator: 'js/sim2.js',
          note: 'Accuracy-limited thermal integration, conserved heat allocation and final-state reporting.',
        },
        {
          kind: 'test',
          locator: 'tests/sim2.test.mjs',
          note: 'Closed-form, bound-extreme, conservation and phase regressions.',
        },
      ],
    }),
    record({
      id: 'rc-tree-link-containment',
      title: 'Symlinks and hard links escape artifact-tree containment',
      symptom: 'Packaging reads or overwrites bytes outside the intended FMU tree through a symbolic link, hard link or linked output path.',
      evidence: [
        'Lexically safe relative paths can still resolve outside the tree through a symlink.',
        'A regular file with multiple hard links can mutate an external file when build metadata or output is rewritten in place.',
      ],
      detection: [
        {
          method: 'filesystem adversarial test',
          signal: 'Insert internal symlinks, source hard links and a hard-linked output into an otherwise valid build tree.',
          failureCondition: 'Packaging follows, rewrites or archives any linked entry instead of rejecting before mutation.',
        },
      ],
      causalChain: [
        'Path validation checks normalized strings and directory prefixes.',
        'Filesystem links redirect resolution or share an inode without changing the lexical path.',
        'A recursive inspector or writer crosses the intended artifact ownership boundary.',
      ],
      rootCause: 'Containment was enforced at the pathname layer without validating filesystem object type, real location and link count before reads and writes.',
      resolution: [
        'Reject symbolic links and multiply linked regular files throughout both the input tree and internal build metadata tree.',
        'Reject symlinked or hard-linked output targets and verify realpath containment before creating metadata.',
      ],
      prevention: [
        'Perform link and containment checks before any package output or coordinated metadata write.',
        'Keep adversarial link tests for inputs, internal temporary state, inspection evidence and final output.',
      ],
      regressionTests: [
        {
          path: 'tests/fmi-package-design-binding.test.mjs',
          assertion: 'Packaging rejects tree symlinks, source/internal hard links and linked output targets without creating an archive.',
        },
      ],
      affectedSurfaces: ['packaging', 'release'],
      tags: ['containment', 'hardlink', 'packaging', 'symlink'],
      references: [
        {
          kind: 'implementation',
          locator: 'tools/fmu-build.mjs',
          note: 'Recursive tree-entry, realpath and output-link checks.',
        },
        {
          kind: 'test',
          locator: 'tests/fmi-package-design-binding.test.mjs',
          note: 'Symlink and hard-link containment regressions.',
        },
      ],
    }),
  ],
});
