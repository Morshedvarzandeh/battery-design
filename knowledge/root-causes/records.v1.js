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
        {
          path: 'tests/calibration-documentation.test.mjs',
          assertion: 'The Action 2 guide describes exact duplicate/leakage guards without promoting them into statistical-independence or custody evidence.',
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
        {
          kind: 'test',
          locator: 'tests/ecm-tuning-plan.test.mjs',
          note: 'Cross-partition purpose-neutral raw/preprocessed identity collision regressions.',
        },
        {
          kind: 'documentation',
          locator: 'docs/ECM_TUNING.md',
          note: 'Exact leakage-guard boundary and explicit statistical-independence limitation.',
        },
      ],
    }),
    record({
      id: 'rc-calibration-holdout-score-masking',
      title: 'Pooled holdout score hides a failed operating regime',
      symptom: 'Automatic tuning passes validation because many low-error samples dilute one failed trial or short operating segment in the pooled RMSE.',
      evidence: [
        'A single high-error sample or short pulse can remain below a pooled RMSE limit when a long easy trace contributes most of the sample count.',
        'A whole-trial metric can still hide the same failure when the affected operating mode occupies only one included segment.',
        'Reporting only an aggregate improvement therefore does not prove that the candidate transfers across every declared holdout condition.',
      ],
      detection: [
        {
          method: 'adversarial holdout aggregation regression',
          signal: 'Inject a large error into one short included validation segment while keeping the remaining full-rate samples exact, then evaluate the predeclared acceptance policy.',
          failureCondition: 'The pooled and whole-trial metrics pass and the candidate is adopted even though the affected segment exceeds its physical-unit RMSE or maximum-error limit.',
        },
      ],
      causalChain: [
        'Validation samples from different trials and operating modes are accumulated into one sum of squared error.',
        'Long or easy regimes dominate that sample-weighted aggregate.',
        'A localized model failure is numerically diluted below the caller threshold.',
        'The artifact presents an aggregate pass while the failed condition remains unsafe or unusable.',
      ],
      rootCause: 'Acceptance was evaluated only on a micro-averaged holdout score instead of applying the same predeclared physical-unit gates to every trial and included operating segment.',
      resolution: [
        'Score fixed holdout parameters at the original sample rate and preserve scalar metrics for every trial and every included segment.',
        'Apply voltage and eligible module-maximum temperature RMSE, maximum-absolute-error and no-regression gates per segment, per trial and in the pooled aggregate.',
        'Reject adoption when any condition fails while retaining the candidate as non-adopted diagnostic evidence.',
      ],
      prevention: [
        'Pair every pooled acceptance regression with a deliberately short bad regime that would be hidden by sample weighting.',
        'Treat new validation partitions or operating-mode labels as additional required acceptance levels, not presentation-only metadata.',
        'Keep raw traces out of portable evidence while content-addressing the scalar per-condition metric tree.',
      ],
      regressionTests: [
        {
          path: 'tests/ecm-tuning.test.mjs',
          assertion: 'A short bad validation segment fails its predeclared per-segment voltage gate even while the pooled and whole-trial RMSE values pass.',
        },
        {
          path: 'tests/calibration-documentation.test.mjs',
          assertion: 'The Action 2 guide requires original-rate pooled, per-trial and per-included-segment scoring and fail-closed adoption.',
        },
      ],
      affectedSurfaces: ['cli', 'local-api'],
      tags: ['acceptance', 'calibration', 'holdout', 'metrics', 'validation'],
      references: [
        {
          kind: 'implementation',
          locator: 'js/ecm-tuning-executor.js',
          note: 'Full-rate per-segment, per-trial and pooled scoring with fail-closed adoption.',
        },
        {
          kind: 'test',
          locator: 'tests/ecm-tuning.test.mjs',
          note: 'Localized holdout-error masking and non-adoption regression.',
        },
        {
          kind: 'documentation',
          locator: 'docs/ECM_TUNING.md',
          note: 'Fixed full-rate holdout levels and candidate-versus-adopted result boundary.',
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
        'A finite-difference probe chosen only by direction order can truncate to a near-zero step at a parameter bound and mistake floating-point roundoff for physical sensitivity even though a full inward probe is available.',
        'A module-maximum temperature channel alone does not uniquely identify module conduction, coolant conductance and worst-module current imbalance.',
        'Treating the complete allowlist as an automatic recipe drives compensating parameters toward bounds and turns optimizer convergence into a misleading identifiability claim.',
      ],
      detection: [
        {
          method: 'versioned excitation and coverage matrix regression',
          signal: 'Build plans for traces that independently add current steps, fast and slow relaxation, ambient-temperature span and thermal observability, then inspect selected and skipped parameter groups.',
          failureCondition: 'A parameter group is selected without its declared excitation/coverage preconditions, a bound-truncated numerical probe is treated as usable sensitivity, the group is skipped without an explicit reason, or selection changes under a permutation that preserves the same governed evidence.',
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
        'For numerical sensitivity, prefer a full governed normalized perturbation in either admissible direction, reject probes below the declared usable-step floor, and record the actual direction and delta in evidence.',
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
        {
          path: 'tests/ecm-tuning.test.mjs',
          assertion: 'Execution requires finite normalized sensitivity, full numerical rank and bounded correlation before fitting, and rejects rather than adopts a failed stage.',
        },
        {
          path: 'tests/calibration-documentation.test.mjs',
          assertion: 'The Action 2 guide distinguishes coverage gates from local numerical sensitivity and from any global-identifiability claim.',
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
          locator: 'js/ecm-tuning-executor.js',
          note: 'Normalized prediction-Jacobian sensitivity, constrained staged fitting and fixed full-rate holdout acceptance.',
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
        {
          kind: 'test',
          locator: 'tests/ecm-tuning.test.mjs',
          note: 'Sensitivity, constrained-candidate and non-adoption execution regressions.',
        },
        {
          kind: 'documentation',
          locator: 'docs/ECM_TUNING.md',
          note: 'Group skip/block, local sensitivity and identifiability-claim boundary.',
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
        'Bind request, canonical dataset, plan and policy versions, model implementation and cell implementation checksums into a deterministic versioned result identity.',
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
        {
          path: 'tests/ecm-tuning.test.mjs',
          assertion: 'ECM tuning results bind the rebuilt plan, execution policy, cell and trial identities, reject forged nested content, and retain no raw signal or Jacobian arrays.',
        },
        {
          path: 'tests/calibration-documentation.test.mjs',
          assertion: 'The Action 2 guide distinguishes content-addressed result identity from authentication, custody, independence and accuracy.',
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
          kind: 'implementation',
          locator: 'js/ecm-tuning-executor.js',
          note: 'Nested plan, execution-policy, trial, scalar-metric and result identities without raw signal retention.',
        },
        {
          kind: 'test',
          locator: 'tests/calibration-surfaces.test.mjs',
          note: 'Result identity sensitivity, privacy and reproducibility regressions.',
        },
        {
          kind: 'test',
          locator: 'tests/ecm-tuning.test.mjs',
          note: 'Nested checksum integrity, rechecksummed-plan rejection and raw-trace privacy regressions.',
        },
        {
          kind: 'documentation',
          locator: 'docs/ECM_TUNING.md',
          note: 'Portable tuning artifact and checksum non-authentication boundary.',
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
        'A staged tuner that runs d+1 numerical-sensitivity probes and then creates a separate d+1 optimizer simplex performs twice the minimum evaluations if the plan reserves only one set.',
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
        'Reserve one baseline-plus-axis sensitivity set and one independent optimizer simplex for every stage before distributing any additional proposal budget.',
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
          assertion: 'Every stage reserves separate sensitivity and optimizer simplex evaluations, and all allocations sum exactly to the caller ceiling even at the maximum safe integer.',
        },
        {
          path: 'tests/ecm-tuning.test.mjs',
          assertion: 'Executor preflight reserves fixed scoring, sensitivity and optimizer work, while exact cumulative temporal and module-weighted counters never reset between stages.',
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
          kind: 'implementation',
          locator: 'js/ecm-tuning-executor.js',
          note: 'Zero-simulation cumulative preflight and cross-stage proposal, temporal and module-weighted accounting.',
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
      id: 'rc-ci-native-test-count-drift',
      revision: 3,
      title: 'Native CI exact-count gate remains pinned to an older test population',
      symptom: 'A larger native solver campaign compiles and passes, but its hosted gate fails afterward because the workflow still expects the previous unit-binary and aggregate test counts.',
      evidence: [
        'DAE Iteration 3 pinned the KLU feature matrix to 73 unit cases and 130 total cases across eight Cargo result blocks.',
        'Iteration 4 added 18 dense event/restart unit cases and six KLU-gated internal seams, making the feature-on unit binary 97 cases and the complete matrix 154 while retaining the same eight result blocks.',
        'The Commit 2 workflow still named and asserted 130 total and the 73-case unit block, so fixing the earlier Rust 1.77 compilation failure alone would only expose a second deterministic CI failure.',
        'The later 18-case dense event/restart manifest target was accounted for atomically as its own result block, producing the then-current 172-case, nine-block dense-only checkpoint without rewriting the historical 154-case, eight-block incident.',
        'The complementary 18-case KLU event/restart manifest target was also accounted for atomically as a second 18-case result block, producing the current 190-case, ten-block matrix while retaining both earlier checkpoints.',
      ],
      detection: [
        {
          method: 'source-to-workflow native result-block audit',
          signal: 'Count every cfg-resolved Cargo test block for the exact feature matrix and compare its per-block distribution, result-line count and aggregate with each workflow assertion.',
          failureCondition: 'A current source test population differs from the named workflow total, any expected per-block count, or the asserted number of Cargo result lines.',
        },
      ],
      causalChain: [
        'The workflow intentionally uses literal per-binary and aggregate counts so skipped or unregistered tests fail closed.',
        'A later solver slice adds embedded tests without updating the separate workflow literals in the same change.',
        'Local cargo test reports success because it does not apply the hosted log-count assertions.',
        'Hosted CI reaches the exact-count step and rejects a healthy expanded campaign as if cases were missing.',
      ],
      rootCause: 'The executable test inventory and its fail-closed CI accounting were maintained as separate literals without one atomic review invariant tying every test-population change to the workflow distribution.',
      resolution: [
        'Update both debug and release KLU steps from the historical 73-case unit block and 130-case aggregate to the verified 97-case unit block and 154-case aggregate while preserving all eight result blocks.',
        'Keep the historical 48-case manifest campaign and 81-case dense baseline frozen by names; report the later embedded event seams as separate current evidence rather than rewriting old denominators.',
        'Add a repository test that pins the current workflow names, per-block unit expectation, aggregate and absence of the stale values beside the current Rust source accounting.',
        'When the 18-case dense event/restart manifest target is registered, add its 18-case result block to both hosted matrices in the same change, advancing current execution from 154 cases in eight blocks to 172 cases in nine blocks while retaining the original incident evidence.',
        'When the complementary 18-case KLU manifest target is registered, change the per-block multiplicity from one to two and advance both hosted matrices from 172 cases in nine blocks to 190 cases in ten blocks without rewriting either historical checkpoint.',
      ],
      prevention: [
        'Treat every added, removed, gated or moved Cargo test as a coordinated change to source inventory, documentation and exact hosted result-block assertions.',
        'Keep per-binary counts, aggregate totals and result-line counts together; changing only the headline total is insufficient.',
        'Separate frozen historical comparison populations from live CI execution counts so later coverage can grow without falsifying prior evidence.',
      ],
      regressionTests: [
        {
          path: 'tests/dae-iteration4-event-evidence.test.mjs',
          assertion: 'The historical Iteration 3 population, 154-case incident and 172-case dense-only checkpoint remain name-bound while current source and CI agree on the 97-case embedded unit binary, two separate 18-case manifest targets, 190 total cases and ten Cargo result blocks in debug and release.',
        },
        {
          path: 'tests/root-cause-library.test.mjs',
          assertion: 'The native CI count-drift cause remains independently searchable, preserves the historical 73/130 to 97/154 correction and records the later atomic 172-case/nine-block and 190-case/ten-block extensions without moving frozen multiplier populations.',
        },
      ],
      affectedSurfaces: ['ci'],
      tags: ['ci', 'evidence', 'rust', 'test-harness', 'testing'],
      references: [
        {
          kind: 'implementation',
          locator: '.github/workflows/ci.yml',
          note: 'Warning-denied debug and release KLU matrices with exact current 97-case embedded, two 18-case manifest targets, 190-case aggregate and ten-block accounting.',
        },
        {
          kind: 'test',
          locator: 'tests/dae-iteration4-event-evidence.test.mjs',
          note: 'Historical-name retention and current workflow/source count-coherence regression.',
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
      id: 'rc-dae-csc-quadratic-lowering',
      title: 'Sparse DAE lowering performs a dense quadratic dependency scan',
      symptom: 'A structurally sparse 10,000-variable chain stores only 19,999 Jacobian entries but lowering still performs roughly one hundred million row-column dependency checks before a sparse backend can start.',
      evidence: [
        'The original CSC builder iterated every variable column and then every residual row, scanning that row’s inputs to decide whether one coordinate existed.',
        'For an N-variable one-input chain, stored Jacobian structure is 2N-1 while the outer column-by-row traversal is N squared.',
        'The mismatch is hidden on the dense backend’s 256-variable admission limit but becomes a dominant pre-solve cost for the planned 1,000- and 10,000-variable KLU evidence.',
        'A sparse native matrix would therefore remove dense storage while retaining dense-time graph lowering unless the backend-neutral builder changed first.',
      ],
      detection: [
        {
          method: 'instrumented sparse-chain lowering regression',
          signal: 'Lower exact 1,000- and 10,000-variable one-input chains, record dependency visits, allocation requests and resulting CSC coordinates, and compare them with their analytical linear counts.',
          failureCondition: 'Traversal grows with variable_count squared, storage exceeds the exact 2N-1 nonzeros, columns are not sorted and unique, duplicate ports change structure, or the builder relies on a timing-only assertion.',
        },
      ],
      causalChain: [
        'The graph already stores each residual row’s small set of incoming dependencies.',
        'CSC output is column-oriented, so the first implementation discovers each column by rescanning every row instead of transposing the known row dependencies.',
        'Sparse storage remains linear while construction work becomes quadratic in variable count.',
        'Large-model sparse qualification spends dense-scale work before SUNDIALS or KLU receives the matrix.',
      ],
      rootCause: 'CSC orientation was implemented as a column-by-row search over the whole graph instead of a bounded transpose of the compiled row dependencies.',
      resolution: [
        'Traverse rows twice: first count each unique structural column dependency, then prefix-sum column pointers and fill row indices through per-column cursors.',
        'Use the row index as a generation marker so the diagonal, self-dependency and repeated source ports create one structural coordinate while numeric Jacobian evaluation still accumulates every derivative contribution.',
        'Process rows in stable variable order so every CSC column is strictly row-sorted without an additional sort.',
        'Instrument the builder itself and prove four bounded pattern-storage requests, exact linear row/input/nonzero work, deterministic 1,000- and 10,000-variable patterns, and unchanged existing Jacobian values.',
      ],
      prevention: [
        'For every sparse representation, measure construction work as a function of vertices, compiled edges and nonzeros rather than inferring scalability from output size alone.',
        'Use deterministic work counters and analytical structures for scale gates; wall-clock thresholds are environment-dependent and cannot prove complexity.',
        'Retain self-edge, repeated-port, duplicate-derivative, sorted-column and replay tests whenever graph lowering changes.',
        'Do not describe sparse adapter memory or runtime as globally bounded from this lowering result; KLU fill-in and process isolation remain separate gates.',
      ],
      regressionTests: [
        {
          path: 'rust-core/tests/dae_contract.rs',
          assertion: 'Exact 1,000- and 10,000-variable chain tests preserve deterministic 2N-1 CSC structure while existing duplicate, self-coupled and numerical Jacobian cases remain green.',
        },
        {
          path: 'tests/root-cause-library.test.mjs',
          assertion: 'The quadratic-lowering record stays searchable and preserves the two-pass, generation-marker, exact-work and non-KLU-memory-claim boundaries.',
        },
      ],
      affectedSurfaces: ['ci'],
      tags: ['complexity', 'csc', 'dae', 'jacobian', 'lowering', 'sparse'],
      references: [
        {
          kind: 'implementation',
          locator: 'rust-core/src/dae.rs',
          note: 'Two-pass deterministic CSC construction and test-only exact work observer.',
        },
        {
          kind: 'test',
          locator: 'rust-core/tests/dae_contract.rs',
          note: 'Large-chain structure, replay and existing Jacobian regressions.',
        },
        {
          kind: 'commit',
          locator: '9f4a43421de34efd067d38a070a0f2c4b9a859dc',
          note: 'Frozen pre-Iteration-3 main revision containing the quadratic CSC builder.',
        },
      ],
    }),
    record({
      id: 'rc-dae-lowering-contract-gap',
      title: 'DAE adapters reconstruct residual structure ad hoc',
      symptom: 'Two implicit backends can assign different variables, residual rows, sparse entries or event values to the same validated equation graph while both appear to accept it.',
      evidence: [
        'The original compiled-graph API exposed direct simulation but no backend-neutral residual-system contract for an external implicit solver.',
        'Differential states and algebraic block outputs have different ownership and ordering, so an adapter that rediscovers them can silently permute y, yp, residual and output vectors.',
        'A sparse Jacobian entry may receive more than one graph contribution; emitting one entry per source instead of one accumulated matrix position changes the Newton system.',
        'Step sources require sorted, deduplicated, right-continuous event handling, while a Limit exactly on a bound has no unique classical derivative and cannot be assigned an arbitrary Jacobian branch.',
        'The original event list merged times within an absolute 1e-12 tolerance, so distinct discontinuities at 1.0 and 1.0+5e-13 seconds collapsed into one event and omitted a required future backend restart.',
        'Permitting callbacks to resize buffers, partially write on an error or allocate work internally would make failure behavior and real-time cost depend on the selected backend.',
      ],
      detection: [
        {
          method: 'backend-neutral DAE contract regression',
          signal: 'Lower mixed differential/algebraic graphs and compare variable/output order, initialization, residuals, CSC pattern and values, event behavior, exact buffer requirements and stable failure codes with analytical expectations.',
          failureCondition: 'The lowering is nondeterministic, a callback partially writes after rejecting an input, duplicate Jacobian contributions are not accumulated, distinct finite event times merge, event values use the wrong side, or a nonsmooth derivative is guessed.',
        },
      ],
      causalChain: [
        'The built-in integrators evaluate derivatives and algebraic feedback through private compiled-graph traversal.',
        'A future IDA or sparse adapter needs residual rows, initialization, events and Jacobian storage rather than a complete built-in simulation.',
        'Without one lowering boundary, each adapter reconstructs graph ordering and callback rules independently.',
        'Backend-specific reconstruction creates incompatible equations, hidden allocations and platform-dependent results before numerical convergence can even be compared.',
      ],
      rootCause: 'The compiled graph had no versioned backend-neutral lowering contract that fixed variable and equation order, residual meaning, sparse storage, event semantics, initialization and caller-owned buffer behavior independently of a solver library.',
      resolution: [
        'Add dependency-free `DaeResidualSystem::lower` under `DAE_RESIDUAL_CONTRACT_VERSION` (`battery-design/dae-residual@1`) so future native adapters consume one checked projection of `CompiledGraph` instead of traversing it themselves.',
        'Order differential variables in compiled state order, then algebraic outputs in BlockId order; keep reported outputs in BlockId order, expose the corresponding numeric 1/0 differential/algebraic ID vector, and define residual rows as `yp - f(t, y)` followed by `y - rhs(t, y)`.',
        'Publish deterministic CSC columns with ascending rows, accumulate duplicate-source contributions, and expose exact buffer requirements plus exact-length no-partial-write initialization, event, residual, Jacobian and output callbacks.',
        'After lowering and initialization construction, keep successful caller-buffer callbacks heap-allocation-free; do not describe lowering itself as allocation-free.',
        'Sort step events and deduplicate only exact numeric equals, including the two signed-zero encodings; preserve every distinct finite event time, evaluate right-continuously at the exact event, reject non-finite values, and fail closed when a Limit Jacobian is requested exactly at a nonsmooth bound.',
        'Keep SUNDIALS and IDA outside the Iteration 1 lowering claim: a later optional Linux native reference may consume this contract only under its own tests and records, while SuiteSparse, KLU, product integration and any advanced WebAssembly ABI remain unshipped; lowering availability alone is not a solver capability.',
      ],
      prevention: [
        'Require every implicit backend to consume the versioned lowering contract and prohibit a second graph-to-residual traversal in adapter code.',
        'Cross-check residual and Jacobian values with analytical and independent finite-difference oracles, including duplicate contributions, sub-picosecond-separated events, signed zero, non-finite inputs and undersized or oversized buffers.',
        'Instrument post-lowering callback allocation counts, and keep construction-time allocation outside that narrower runtime guarantee.',
        'Separate residual-lowering conformance from solver, platform, package and release acceptance so product metadata exposes only executable backends that passed their own gates.',
      ],
      regressionTests: [
        {
          path: 'rust-core/tests/dae_contract.rs',
          assertion: 'Mixed-graph integration tests prove deterministic lowering, analytical residual/Jacobian values, duplicate accumulation, exact distinct-event preservation, right continuity and fail-closed buffers, inputs and nonsmooth points.',
        },
        {
          path: 'rust-core/tests/dae_allocation.rs',
          assertion: 'Allocator instrumentation proves zero heap allocations for successful caller-buffer callbacks after lowering without extending that guarantee to lowering or initialization construction.',
        },
        {
          path: 'tests/root-cause-library.test.mjs',
          assertion: 'The DAE lowering record remains searchable and preserves deterministic ordering, residual, CSC, event, buffer and unshipped-capability boundaries.',
        },
      ],
      affectedSurfaces: ['ci', 'documentation'],
      tags: ['dae', 'jacobian', 'lowering', 'residual', 'sparse'],
      references: [
        {
          kind: 'implementation',
          locator: 'rust-core/src/dae.rs',
          note: 'Dependency-free backend-neutral residual lowering and caller-owned callback contract.',
        },
        {
          kind: 'test',
          locator: 'rust-core/tests/dae_contract.rs',
          note: 'Independent contract, ordering, numerical, sparse, event and failure regressions.',
        },
        {
          kind: 'test',
          locator: 'rust-core/tests/dae_allocation.rs',
          note: 'Post-lowering successful callback allocation instrumentation.',
        },
        {
          kind: 'implementation',
          locator: 'rust-core/src/equations.rs',
          note: 'Compiled event-list construction preserving distinct finite times while merging signed zero.',
        },
        {
          kind: 'documentation',
          locator: 'docs/EQUATION_SOLVER.md',
          note: 'Exact Iteration 1 boundary and five-gate native DAE backend campaign.',
        },
        {
          kind: 'test',
          locator: 'tests/root-cause-library.test.mjs',
          note: 'DAE record retrieval, semantic-boundary and unshipped-capability assertions.',
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
      id: 'rc-hil-contract-deployment-gap',
      title: 'HIL test contract has no executable deployment mapping',
      symptom: 'A reviewed HIL contract reaches target integration through ad hoc glue because it does not identify model ports, physical endpoints, fault injectors or one machine-readable safe-state action.',
      evidence: [
        'The HIL test contract deliberately defines test timing, channel semantics, required fault names and safe output values, but it does not claim to be a target runtime manifest.',
        'A channel id and direction in the contract do not identify the future runtime ABI slot or physical driver endpoint, so integration code could omit, duplicate or reverse a channel without changing the reviewed contract.',
        'Required fault strings do not select a driver, scheduler or platform injector, nor state whether a sensor fault is bound to an input channel.',
        'The contract overrun action is reviewed human-readable text; interpreting that prose as executable safety logic would make target behavior depend on an unversioned parser.',
        'A contract may carry Number.MAX_SAFE_INTEGER as its maximum consecutive-overrun count, but the executable latch threshold is that value plus one and would no longer be an exactly representable safe integer.',
        'Canonical JSON serialization aliases NaN, Infinity and sparse array slots to null, so canonicalizing before validation can give an invalid graph the same FNV and SHA-256 identities as a different literal-null graph.',
        'A pre-canonical clone that assigns an enumerable own __proto__ key into an ordinary object invokes the legacy prototype setter instead of preserving a data property, so the guarded graph can alias a differently identified source graph.',
        'One draft validator treated every opaque runtime reference as a filesystem path and rejected the slash separators used by valid namespaced driver identities and physical endpoints.',
        'The existing graph checksum is a compact canonical graph identity, but a deployment artifact also needs the canonical graph SHA-256 and an exact runtime ABI identity without presenting either checksum as authentication.',
      ],
      detection: [
        {
          method: 'closed deployment-mapping regression',
          signal: 'Build a deployment plan from a trusted HIL contract and canonical equation graph, then independently omit, duplicate, reverse or mutate channel, fault, target, graph, ABI and safety mappings, including non-finite, sparse, cyclic and literal-null graph variants.',
          failureCondition: 'A plan is accepted without a finite dense pre-canonical graph walk, complete one-to-one direction-correct channels, allowlisted fault routes, exact contract/graph identities, an exactly representable latch threshold or safe outputs derived only from the reviewed contract.',
        },
      ],
      causalChain: [
        'A test-and-evidence contract is mistaken for an executable target manifest.',
        'Runtime port, physical endpoint and fault-injector choices therefore remain in ungoverned adapter code.',
        'Human overrun prose can be overread as a machine action while the declared safe values remain disconnected from one fixed runtime trigger.',
        'Without an owned deployment transform, the executable plus-one latch threshold is neither materialized nor checked for safe-integer overflow.',
        'If that transform serializes the graph before checking its raw values and array occupancy, or clones reserved keys through an ordinary object setter, distinct inputs collapse to the same canonical bytes and content identities.',
        'The eventual cycle loop can execute a mapping different from the one reviewed even though it still cites the original HIL contract.',
      ],
      rootCause: 'Test acceptance semantics and runtime deployment semantics were conflated, leaving no closed content-addressed adapter layer that binds the trusted HIL contract to one target, graph artifact, runtime ABI, channel map, fault map and derived safe vector.',
      resolution: [
        'Add a battery-design/hil-deployment-plan@1 builder and verifier that first reconstruct the complete hil-test-contract@2 and require its independently retained expected checksum.',
        'Walk the raw equation graph before canonical serialization and reject cycles, sparse arrays, unsupported prototypes and every non-finite number; reconstruct string-keyed data with null-prototype objects and explicit own data properties so JSON null-aliasing and __proto__ setters cannot precede validation or identity derivation.',
        'Bind the contract graph checksum to a validated canonical equation graph, add its canonical SHA-256 artifact identity and pin battery-design/hil-runtime-abi@1 plus an exact target profile.',
        'Validate simple opaque ids separately from relative namespaced references: permit deliberate slash-separated driver/endpoint namespaces while rejecting control characters, absolute/backslash paths, empty or traversal segments and prototype-control names.',
        'Map every contract input exactly once from a physical endpoint to a unique model port, and every output exactly once from a unique model port to a physical endpoint; reject missing, duplicate, unknown or cross-direction bindings.',
        'Keep direction structural in the separate input/output binding arrays, and enrich returned bindings only with quantity, unit, bounds and output safe values derived from the verified contract, never caller-authored semantic copies.',
        'Map every required fault exactly once through the fixed driver, scheduler or platform injector rules, including input-channel binding only for sensor faults.',
        'Derive the complete safe-output vector from contract output safeValue fields and expose only the fixed latch-declared-safe-outputs mode with the overrun-limit-exceeded-or-runtime-failure trigger; retain overrun.action as documentation only.',
        'Materialize overrunMissesBeforeLatch as maxConsecutive plus one and reject a deployment when that executable threshold would exceed the safe-integer range.',
        'Return a recursively frozen deterministic snapshot whose status says the deployment plan is ready while the runtime remains unqualified.',
      ],
      prevention: [
        'Do not let a future cycle loop consume a raw HIL test contract; its boundary must verify the exact deployment-plan schema, content checksum and independently retained expected identity.',
        'Pair every accepted mapping with missing, duplicate, reversed, inherited, sparse, non-finite, cyclic, literal-null-alias, own-__proto__, threshold-overflow and coordinated-tamper regressions.',
        'Keep runtime references opaque until a versioned driver owns their interpretation; a deployment plan must neither open them as paths nor reject its documented namespace grammar.',
        'Keep deployment and graph checksums described as content identity, never producer authentication, signed evidence, deadline proof or physical qualification.',
        'Keep the hil-runtime add-on planned until a named target passes the separately protected physical qualification campaign.',
      ],
      regressionTests: [
        {
          path: 'tests/hil-deployment.test.mjs',
          assertion: 'Deployment plans are closed, deterministic, deeply frozen and trusted-contract/graph bound; raw graph NaN/Infinity/sparse/cyclic/own-__proto__ aliases fail before canonicalization, namespaced runtime references follow a non-filesystem grammar, channel semantics are contract-derived, and invalid channel, fault, target, graph, ABI, latch-threshold and safe-state mappings fail before any runtime exists.',
        },
        {
          path: 'tests/root-cause-library.test.mjs',
          assertion: 'Search and exact lookup preserve the non-executable-contract cause, governed mapping resolution and no-hardware claim boundary.',
        },
      ],
      affectedSurfaces: ['browser', 'documentation'],
      tags: ['checksum', 'deployment', 'hil', 'runtime', 'safety'],
      references: [
        {
          kind: 'implementation',
          locator: 'js/hil-deployment.js',
          note: 'Closed HIL contract-to-runtime deployment-plan materialization and verification.',
        },
        {
          kind: 'test',
          locator: 'tests/hil-deployment.test.mjs',
          note: 'Positive, negative and adversarial deployment-mapping regressions.',
        },
        {
          kind: 'documentation',
          locator: 'docs/HIL_RUNTIME.md',
          note: 'Five-iteration runtime campaign and exact no-execution/no-hardware boundary.',
        },
      ],
    }),
    record({
      id: 'rc-hil-result-identity-gap',
      title: 'HIL verdict reuses the contract schema and omits result identity',
      symptom: 'A hardware-in-the-loop evaluation returns mutable pass, fail or unproven data under the contract schema, with no deterministic identity for the bounded verdict summary.',
      evidence: [
        'The evaluator returned schema battery-design/hil-test-contract@2 even though the object was an evaluation result with different fields and status semantics.',
        'Returned checks and headlines were mutable and had no result checksum binding them to the verified contract checksum.',
        'The pass identity check compared target ID, model version and graph checksum but never required evidence.modelId, while the returned pass result projected the contract model ID as if it had been proved.',
      ],
      detection: [
        {
          method: 'HIL result identity regression',
          signal: 'Evaluate absent, complete, partial, missing-model and wrong-model evidence against one verified contract, then clone and repeat each input.',
          failureCondition: 'A result uses the contract schema, remains mutable, lacks deterministic contract-bound identity, or missing/wrong model ID can retain identity pass.',
        },
      ],
      causalChain: [
        'The HIL contract is verified before evaluation, but the verdict is assembled as an informal return object.',
        'That object inherits the contract schema label even though it is neither structurally nor semantically a contract.',
        'One contract identity field is copied into the result without a corresponding evidence comparison.',
        'Consumers cannot persist or compare a stable verdict and may overread a projected model ID as measured identity proof.',
      ],
      rootCause: 'Contract verification, evidence identity checks and result materialization were not closed as one versioned, immutable, content-addressed evaluation boundary.',
      resolution: [
        'Require own evidence target ID, model ID, model version and graph checksum before the identity check can pass.',
        'Materialize every status through one deeply frozen battery-design/hil-test-result@1 shape bound to the verified @2 contract checksum.',
        'Checksum only the bounded result summary and state explicitly that it does not authenticate raw measurements, hardware custody or independent execution.',
      ],
      prevention: [
        'Use distinct versioned formats for input contracts and evaluation results.',
        'Pair every identity field projected into a pass result with an own-property evidence comparison and missing/wrong-value regressions.',
        'Name checksum scope precisely; add a separate bounded raw-evidence digest only if measurement custody becomes a governed requirement.',
      ],
      regressionTests: [
        {
          path: 'tests/loop-testing.test.mjs',
          assertion: 'Unproven, pass and fail HIL summaries share one frozen checksummed result shape; complete identity includes model ID; missing or wrong model ID fails identity; and different traces with the same bounded summary intentionally share summary identity.',
        },
      ],
      affectedSurfaces: ['browser'],
      tags: ['content-identity', 'evidence', 'hil', 'result-schema', 'trust-boundary'],
      references: [
        {
          kind: 'implementation',
          locator: 'js/loop-testing.js',
          note: 'Complete HIL evidence identity check and canonical result materialization.',
        },
        {
          kind: 'test',
          locator: 'tests/loop-testing.test.mjs',
          note: 'Result schema/freeze/checksum and missing/wrong model identity regressions.',
        },
        {
          kind: 'documentation',
          locator: 'docs/LOOP_TESTING.md',
          note: 'Result format plus summary-checksum and hardware-evidence trust boundary.',
        },
      ],
    }),
    record({
      id: 'rc-hil-timing-coverage-gap',
      title: 'Partial HIL timing trace is treated as complete-run evidence',
      symptom: 'One fast cycle can satisfy the HIL timing check for a much longer declared run, while a large complete trace can overflow the evaluator before producing a verdict.',
      evidence: [
        'The evaluator required only a non-empty cycleTimesUs array and checked that each supplied value was below the sample period.',
        'A 30-second contract at a one-millisecond period therefore accepted one measured cycle as timing evidence for all 30,000 required cycles.',
        'Maximum cycle time was calculated with Math.max spread syntax, which can throw when a legitimate timing trace exceeds the JavaScript argument limit.',
        'Direct floating-point ceil made 0.000123 seconds at a one-microsecond period appear as 123.00000000000001 cycles and incorrectly require cycle 124.',
        'Gating the iterative scan on complete coverage suppressed the maximum measured time for a valid but partial trace, weakening failure diagnostics.',
      ],
      detection: [
        {
          method: 'duration-coverage and large-trace regression',
          signal: 'Evaluate exact and just-over integer duration boundaries, a partial trace, the complete derived cycle count and a complete trace above typical function-argument limits.',
          failureCondition: 'Partial coverage passes, required/observed counts are absent, or a bounded complete trace throws instead of returning a timing verdict.',
        },
      ],
      causalChain: [
        'The contract declares both a sample period and a total test duration.',
        'Evidence validation checks only values present in the submitted timing array and never derives the number of cycles the duration requires.',
        'A short prefix is indistinguishable from a complete run and can satisfy every timing predicate.',
        'When complete evidence is eventually supplied, argument-spread reduction makes array size an unrelated runtime failure mode.',
      ],
      rootCause: 'Timing values were validated independently of declared run coverage, and their maximum was reduced through a call-stack-limited API instead of a bounded iterative scan.',
      resolution: [
        'Derive required cycles as ceil(durationS*1,000,000/samplePeriodUs) and reject contracts outside the governed one-million-sample evidence ceiling.',
        'Require observed evidence to cover at least the derived cycle count while retaining the exact sample-period deadline for every value.',
        'Convert the canonical decimal duration representation into an exact BigInt rational before ceiling, so decimal integer boundaries stay exact and every represented positive remainder requires the next cycle.',
        'Compute maximum cycle time with an iterative dense-array scan independent of the coverage verdict and expose required and observed counts in every HIL evidence result.',
      ],
      prevention: [
        'Tie every sampled-evidence acceptance rule to both value validity and declared coverage.',
        'Use safe-integer time/count domains and exact decimal-rational duration arithmetic; pair every boundary test with just-over and near-cap counterexamples.',
        'Cap external arrays before execution and avoid spread-based reductions on governed evidence.',
        'Keep partial, exact-complete and large-complete trace cases together in the HIL regression matrix.',
      ],
      regressionTests: [
        {
          path: 'tests/loop-testing.test.mjs',
          assertion: 'A partial HIL trace fails but retains its measured maximum; exact and just-over decimal boundaries derive 123 and 124 cycles; a represented near-cap remainder is not rounded down; a 200,000-cycle trace passes without spread overflow; and unsafe or over-cap contracts fail before evidence evaluation.',
        },
      ],
      affectedSurfaces: ['browser'],
      tags: ['array-bounds', 'coverage', 'hil', 'timing', 'validation'],
      references: [
        {
          kind: 'implementation',
          locator: 'js/loop-testing.js',
          note: 'Derived timing coverage, evidence ceiling and iterative maximum scan.',
        },
        {
          kind: 'test',
          locator: 'tests/loop-testing.test.mjs',
          note: 'Partial, complete, large and over-cap timing regressions.',
        },
        {
          kind: 'documentation',
          locator: 'docs/LOOP_TESTING.md',
          note: 'Public timing-coverage and evidence-limit contract.',
        },
      ],
    }),
    record({
      id: 'rc-ida-global-step-accounting-gap',
      title: 'Repeated IDASolve calls reset a nominal global step budget',
      symptom: 'A dense output request can consume more internal IDA steps than its declared maximum because each native solve call receives a fresh per-call work allowance.',
      evidence: [
        'SUNDIALS IDA applies IDASetMaxNumSteps to one IDASolve invocation, so calling IDASolve separately for each requested row does not create one cumulative request budget.',
        'A dense requested grid can therefore multiply the accepted internal work even when every individual native call stays below the configured maximum.',
        'IDA_ONE_STEP exposes exactly one successful internal step per call, while IDAGetNumSteps provides the cumulative native counter needed to detect resets, jumps and off-by-one advancement.',
        'Requested grid rows need interpolation inside the newly completed step; using a normal solve call for every row conflates output count with internal work and invites extrapolation.',
      ],
      detection: [
        {
          method: 'cumulative native-step budget regression',
          signal: 'Solve the same system at one output and at a dense output grid with an exact and one-below-exact step cap, while comparing IDAGetNumSteps deltas with successful IDA_ONE_STEP calls.',
          failureCondition: 'More than the configured global steps execute, a dense grid resets the budget, a successful step changes the native counter by anything other than one, or a grid row is evaluated outside the newly completed step.',
        },
      ],
      causalChain: [
        'The adapter needs multiple requested output rows from one initialized IDA session.',
        'The native maximum-step setting is assumed to cover the whole Rust request even though its scope is one IDASolve call.',
        'Repeated solve calls can each start with another native allowance.',
        'The Rust request can exceed its advertised work ceiling without any single native call reporting too much work.',
      ],
      rootCause: 'A per-IDASolve native work limit was treated as a cumulative request limit instead of accounting successful internal steps across the complete consumed session.',
      resolution: [
        'Advance only with IDA_ONE_STEP toward the final requested time and check the cumulative IDAGetNumSteps value before every native step.',
        'Set the native maximum to the remaining Rust-owned budget before each call, require every successful call to increase the native counter by exactly one, and stop before calling native code when the cumulative cap is exhausted.',
        'Drain requested rows only through IDAGetDky inside the just-completed logical interval, including an explicit upper bound because the pinned IDA 7.8.0 implementation does not provide that complete guard.',
        'Publish solve-statistic deltas from the post-initialization baseline and require one_step_calls to equal the cumulative internal-step delta.',
      ],
      prevention: [
        'Classify every native limit as per-call, per-session or process-wide before mapping it to a public request setting.',
        'Keep exact-budget, one-below-budget, many-output and dense-final-step cases together whenever the solve loop changes.',
        'Treat requested output rows and internal integration steps as separate bounded counters.',
      ],
      regressionTests: [
        {
          path: 'rust-dae-native/tests/solve_reference.rs',
          assertion: 'Public exponential and Robertson solves require the published cumulative internal-step count to equal the number of IDA_ONE_STEP calls while preserving the exact requested grid.',
        },
        {
          path: 'tests/root-cause-library.test.mjs',
          assertion: 'The global-step record remains independently searchable and preserves the per-call-reset cause, cumulative ONE_STEP resolution and no-extrapolation boundary.',
        },
      ],
      affectedSurfaces: ['ci', 'documentation'],
      tags: ['budget', 'dae', 'ida', 'step-accounting', 'sundials'],
      references: [
        {
          kind: 'implementation',
          locator: 'rust-dae-native/src/native.rs',
          note: 'Consumed IDA_ONE_STEP loop, cumulative counter invariant, remaining-budget registration and bounded dense interpolation.',
        },
        {
          kind: 'test',
          locator: 'rust-dae-native/src/native.rs',
          note: 'Embedded exact-cap, one-below-cap, many-output, interpolation and native-counter adversarial unit tests.',
        },
        {
          kind: 'test',
          locator: 'rust-dae-native/tests/solve_reference.rs',
          note: 'Public analytical and stiff reference cases binding cumulative steps to ONE_STEP calls.',
        },
      ],
    }),
    record({
      id: 'rc-ida-initial-target-span-gap',
      title: 'Finite increasing targets can still be unusable by IDA',
      symptom: 'A numerically increasing output grid passes Rust validation but IDA rejects it during initialization or solve because the first native target cannot produce a usable initial step.',
      evidence: [
        'IDA 7.8.0 estimates an initial step from 0.001 times the target distance, so a positive finite span can underflow to zero or have a non-finite reciprocal.',
        'At a large or closely spaced initial time, the scaled step can be nonzero yet initial_time plus that step rounds back to the initial time and cannot represent forward progress.',
        'IDA also rejects target distances below its roundoff threshold even though two finite floating-point values compare strictly increasing.',
        'Contract-consistent initialization sends the final requested time to IDASolve and may interpolate an earlier near-initial row, while corrected initialization separately sends the first requested time as IDACalcIC tout1.',
      ],
      detection: [
        {
          method: 'native-target admissibility boundary regression',
          signal: 'Probe minimum subnormal, reciprocal-overflow, IDA roundoff, nonrepresentable scaled-step and adjacent-float grids under both initial-condition policies before recording any native allocation.',
          failureCondition: 'An unusable native target reaches allocation or FFI, a representable boundary is rejected, ContractConsistent rejects a legal interpolated near-initial row, or correction accepts that same row as IDACalcIC tout1.',
        },
      ],
      causalChain: [
        'Request validation checks only that output times are finite and strictly increasing.',
        'IDA derives an initial native step from the distance between its initial time and the target passed to that native operation.',
        'IEEE-754 underflow, reciprocal overflow, roundoff distance or a nonrepresentable addition can make that derivation unusable despite a positive Rust comparison.',
        'Using the same grid point for both initial-condition policies either rejects legal interpolation or sends an invalid correction target into IDA.',
      ],
      rootCause: 'The adapter validated abstract time ordering but did not preflight the exact floating-point target span consumed by each IDA operation and initial-condition policy.',
      resolution: [
        'Mirror the pinned IDA 7.8.0 target-span gates before native allocation: require a finite positive distance, nonzero 0.001-scaled step, finite reciprocal, finite representable forward addition and the documented roundoff distance.',
        'For ContractConsistent validate the final IDASolve target while allowing earlier requested rows to be obtained by bounded interpolation.',
        'For CorrectAlgebraicAndDerivative validate both the final IDASolve target and the first requested IDACalcIC tout1 before allocating request resources.',
        'Use numeric equality for initial-time checks so SUNDIALS canonicalizing negative zero to positive zero is not reported as time drift.',
      ],
      prevention: [
        'Validate the exact argument passed to each native operation rather than applying one generic time-grid predicate.',
        'Keep underflow, reciprocal, adjacent-float, roundoff, representable-addition and signed-zero counterexamples at the pre-allocation boundary.',
        'When a native policy changes which grid point becomes tout or tout1, update its validation and paired policy-difference tests together.',
      ],
      regressionTests: [
        {
          path: 'rust-dae-native/tests/solve_reference.rs',
          assertion: 'Public analytical and corrected-initial-condition solves exercise both supported target policies over valid nontrivial spans.',
        },
        {
          path: 'tests/root-cause-library.test.mjs',
          assertion: 'The initial-target record remains independently searchable and preserves underflow, roundoff, representable-progress and final-versus-first policy semantics.',
        },
      ],
      affectedSurfaces: ['ci', 'documentation'],
      tags: ['dae', 'floating-point', 'ida', 'initial-conditions', 'time-grid'],
      references: [
        {
          kind: 'implementation',
          locator: 'rust-dae-native/src/lib.rs',
          note: 'Pre-allocation output-distance validation and separate IDASolve-final versus IDACalcIC-first target policy.',
        },
        {
          kind: 'test',
          locator: 'rust-dae-native/src/native.rs',
          note: 'Embedded subnormal, reciprocal, roundoff, 500/501-ULP, adjacent-float, signed-zero and policy-difference unit tests.',
        },
        {
          kind: 'test',
          locator: 'rust-dae-native/tests/solve_reference.rs',
          note: 'Public contract-consistent and corrected initial-condition solve regressions.',
        },
      ],
    }),
    record({
      id: 'rc-loop-contract-identity-gap',
      title: 'Loop-test execution trusts a mutable schema-labelled contract',
      symptom: 'A SIL plan or HIL contract changes after review, or a schema-only object reaches execution without the required governed fields.',
      evidence: [
        'The original builders froze only the outer object and arrays, leaving nested cases, expected limits, channels and run options mutable.',
        'The SIL runner and HIL evaluator checked only the schema string before consuming caller-owned nested content.',
        'Neither contract had a canonical content digest that a retained review record could compare with the executed snapshot.',
        'Sparse arrays were serialized like explicit nulls while map and every skipped their holes, allowing a one-hole SIL case list to pass without an adapter call and a one-hole HIL fault list to waive every fault check.',
        'A negative measured overrun count was treated as an integer and compared numerically below the allowed maximum, so impossible evidence could pass the overrun check.',
        'Requiring a checksum while retaining the original @1 schema would silently redefine already serialized documents instead of declaring a new wire contract.',
      ],
      detection: [
        {
          method: 'nested-mutation and forged-envelope regression',
          signal: 'Change a nested oracle or safe value; submit sparse arrays or a negative measured overrun count; omit or add fields; or submit only the expected schema label.',
          failureCondition: 'Execution or evidence evaluation starts without exact reconstruction, checksum verification and recursive immutability.',
        },
      ],
      causalChain: [
        'A version string is treated as sufficient proof that an object was created by the governed builder.',
        'Only the outer container is frozen, so nested acceptance limits and I/O facts remain caller-mutable.',
        'Array length is treated as evidence of content even though JavaScript iteration skips sparse slots and canonical JSON represents them as null.',
        'The runner consumes those values without reconstructing the canonical contract.',
        'The executed test can differ from the reviewed test while retaining the same visible schema label.',
      ],
      rootCause: 'Contract versioning, structural validation, immutable ownership and content identity were conflated; the execution boundary had no single verifier for untrusted serialized plans.',
      resolution: [
        'Create canonical deep-frozen SIL and HIL snapshots with deterministic content checksums.',
        'Close every governed contract object, validate arbitrary input/run-option data as finite JSON, and reject missing, unknown or invalid fields.',
        'Require dense arrays before every map/every operation so a declared case, channel or fault cannot be an absent slot.',
        'Accept measured overrun counts only as non-negative safe integers before comparing them with the contract maximum.',
        'Publish checksummed snapshots as @2 and rematerialize legacy @1 documents only through explicit migration helpers.',
        'Reconstruct and verify each contract before execution, with an optional independently retained expected checksum for custody-sensitive use.',
      ],
      prevention: [
        'Route every persisted loop-testing contract through one verifier at the execution boundary rather than checking its schema label directly.',
        'Test nested mutation, schema-only forgery, sparse arrays, signed count boundaries, unknown fields and coordinated new identities separately.',
        'Describe self-contained checksums as content identity, not producer authentication or hardware evidence.',
      ],
      regressionTests: [
        {
          path: 'tests/loop-testing.test.mjs',
          assertion: 'SIL and HIL snapshots are deterministic and deeply frozen; strict verification rejects nested mutation, sparse cases/faults, negative overrun evidence, unknown or missing fields and schema-only objects, while legacy @1 migration is explicit.',
        },
      ],
      affectedSurfaces: ['browser'],
      tags: ['checksum', 'contract', 'hil', 'immutability', 'sil', 'validation'],
      references: [
        {
          kind: 'implementation',
          locator: 'js/loop-testing.js',
          note: 'Canonical snapshot builders and strict execution-boundary verifiers.',
        },
        {
          kind: 'test',
          locator: 'tests/loop-testing.test.mjs',
          note: 'Contract identity, deep-freeze and forged-envelope regressions.',
        },
      ],
    }),
    record({
      id: 'rc-native-dae-callback-boundary-gap',
      title: 'Raw IDA callbacks lack one contained Rust boundary',
      symptom: 'A native residual or Jacobian callback can create aliased Rust views, unwind through C, lose the first model error behind a native flag or allocate unpredictably during nonlinear iteration.',
      evidence: [
        'SUNDIALS supplies opaque user data plus raw N_Vector and SUNMatrix handles whose nullness, lengths, storage shape and address ranges are not expressed in Rust types.',
        'Constructing mutable Rust slices before proving that callback inputs and outputs are disjoint would make overlapping native views immediate undefined behavior rather than a contained solver error.',
        'A DaeError must cross a C callback ABI represented only by an integer return code, so a later callback or IDA failure can obscure the first actionable model failure unless Rust retains it.',
        'A Rust panic may not unwind through the C frames, and Jacobian scatter work allocated inside each callback would make nonlinear cost depend on heap behavior.',
      ],
      detection: [
        {
          method: 'adversarial callback ABI regression',
          signal: 'Invoke residual and Jacobian callbacks with null, wrong-sized, aliased, nonsmooth, injected-error and injected-panic views while counting allocations across repeated successful callbacks.',
          failureCondition: 'A Rust slice is formed from an invalid or overlapping view, a panic crosses FFI, a later failure replaces the first DaeError, or a successful callback allocates after session construction.',
        },
      ],
      causalChain: [
        'IDA invokes Rust through an untyped C callback and opaque user-data address.',
        'The adapter maps native memory directly into Rust references without one preflighted ownership and failure boundary.',
        'Aliasing, unwind and error-precedence rules are then left to incidental callback order and foreign-library behavior.',
        'The nonlinear solve can become undefined, terminate the process or report the wrong cause despite a deterministic residual contract.',
      ],
      rootCause: 'The native callback seam had no pinned, prevalidated translation layer that jointly owned pointer-view safety, unwind containment, first-error preservation and callback workspace.',
      resolution: [
        'Pin one callback-state allocation for the session lifetime and register only its stable address as IDA user data.',
        'Validate every native handle, exact dimension, dense column-major storage span and mutable address-range disjointness before constructing Rust slices or writing callback output.',
        'Catch every residual and Jacobian unwind at the extern-C boundary, latch exactly the first DaeError or callback-panic identity, return a failure flag to IDA and prefer the latch over the later native flag.',
        'Preallocate residual/Jacobian scratch and CSC-to-dense scatter state during session construction; repeated successful callbacks perform zero heap allocations, without extending that claim to construction, solve orchestration or error paths.',
      ],
      prevention: [
        'Treat every foreign callback as a hostile raw-view boundary even when the current library is expected to provide well-formed handles.',
        'Keep null, shape, alias, first-error, panic and allocation tests paired for both residual and Jacobian callbacks.',
        'Never infer the underlying model failure from an IDA callback flag when a more specific Rust latch exists.',
        'Scope allocation claims to the measured successful callback region and name all excluded phases.',
      ],
      regressionTests: [
        {
          path: 'rust-dae-native/tests/solve_reference.rs',
          assertion: 'Public analytical, affine index-one and Robertson solves exercise the same registered residual and Jacobian callbacks through the native IDA runtime.',
        },
        {
          path: 'tests/root-cause-library.test.mjs',
          assertion: 'The callback record remains independently searchable and preserves alias preflight, panic containment, first-error precedence and narrowly scoped zero-allocation semantics.',
        },
      ],
      affectedSurfaces: ['ci', 'documentation'],
      tags: ['allocation', 'dae', 'ffi', 'ida', 'panic-containment'],
      references: [
        {
          kind: 'implementation',
          locator: 'rust-dae-native/src/native.rs',
          note: 'Pinned callback state, raw-view validation, error latch, unwind containment and preallocated dense callback workspace.',
        },
        {
          kind: 'test',
          locator: 'rust-dae-native/src/native.rs',
          note: 'Embedded callback alias, null, shape, kink, first-error, panic and repeated zero-allocation unit tests.',
        },
        {
          kind: 'test',
          locator: 'rust-dae-native/tests/solve_reference.rs',
          note: 'Public end-to-end native callback exercise on analytical and stiff index-one systems.',
        },
      ],
    }),
    record({
      id: 'rc-native-solver-build-provenance-gap',
      title: 'Native solver path loses source and linked-byte identity',
      symptom: 'A feature-on native build can report SUNDIALS 7.8.0 while consuming the wrong official asset, an unbounded extraction, a differently configured install or stale linked archives.',
      evidence: [
        'A version string, library search path and expected archive names do not bind the build to the official IDA-only release asset, its bounded archive inventory, build policy or exact linked bytes.',
        'The authoritative upstream lock is battery-design/sundials-source-lock@1 at native-backends/sundials/source-lock.json; a second conflicting source identity would make Task 2A provenance ambiguous.',
        'The official IDA-only distribution still installs mandatory native vector, matrix and iterative-solver modules because upstream exposes no dense-only binary switch; IDA-only must not be restated as a dense-only archive claim.',
        'The helper reuse check initially parsed receipt JSON semantically, so an identical duplicate key could pass the helper while build.rs rejected the same noncanonical raw receipt.',
        'A receipt stored beside mutable archives is useful only when every producer, reuse check and consumer independently recomputes its bound values and requires the same exact closed bytes.',
        'A self-consistent receipt can truthfully hash an empty but valid static archive, so content agreement alone does not prove that the archive supplies a usable IDA implementation; the real backend-identity link must still succeed.',
      ],
      detection: [
        {
          method: 'source-to-link provenance and tamper campaign',
          signal: 'Mutate the official lock, archive inventory, CMake policy, derived receipt, headers or linked archives; add an unexpected module; then run the Node build audit, adapter acceptance and real backend-identity binary.',
          failureCondition: 'Any stage accepts a different official asset, unsafe archive shape, enabled third-party solver, noncanonical receipt, mismatched linked bytes or unusable IDA archive under the pinned identity.',
        },
      ],
      causalChain: [
        'Task 2A identifies one official source asset, Task 2B builds and probes it, and the optional Rust feature later consumes a derived native link root.',
        'Source identity, archive safety, build configuration, installed-module scope and exact linked bytes are distinct trust boundaries.',
        'If those boundaries use separate informal labels or permissive receipts, producers and Cargo can accept different content under the same visible solver version.',
        'Runtime metadata then overstates what was actually compiled and linked.',
      ],
      rootCause: 'The native pipeline lacked one continuous, closed provenance chain from the authoritative official-source lock through bounded extraction and audited configuration to the exact derived archives Cargo links.',
      resolution: [
        'Use only the closed battery-design/sundials-source-lock@1 at native-backends/sundials/source-lock.json: it pins the official SUNDIALS 7.8.0 ida-7.8.0.tar.gz asset, tag object, commit, 5,022,403-byte length, SHA-256, BSD-3-Clause license and NOTICE identities.',
        'Use tools/verify-sundials-source.mjs and tools/build-sundials-ida.mjs for Tasks 2A and 2B so extraction admits one bounded regular-file IDA archive root, the static Release build fixes double precision and 64-bit indices, optional third-party solvers remain off, and an external installed-package lifecycle probe must pass.',
        'Preserve the upstream caveat: the official asset is IDA-only by solver family but its installed package contains mandatory native vector, matrix and iterative-solver modules; the reference selects serial vector, dense matrix and dense linear solver without claiming a dense-only binary.',
        'Bind the derived adapter link root back to that accepted source decision and emit one closed canonical battery-design/sundials-build-receipt@1 containing source, configuration, linked-archive digests and bounded toolchain identity.',
        'Require adapter reuse and rust-dae-native/build.rs to validate exact canonical receipt bytes, including duplicate or unknown keys, wrong nesting, malformed encoding and trailing data, plus the configuration and exact archive surface Cargo consumes before emitting link directives.',
        'Require the real feature-on backend-identity binary to link against the accepted archives, then probe runtime SUNDIALS 7.8.0 and expose dense serial identity only after successful construction; receipt consistency alone is not semantic usability.',
        'Describe hashes and the self-recomputed receipt as content/configuration self-consistency only: they do not authenticate the publisher, prove reproducible-build equivalence, establish compiler trust or preserve artifact custody and chain of possession.',
      ],
      prevention: [
        'Keep one authoritative source lock and make the Node verifier, Node builder, derived receipt and Cargo consumer carry that identity forward explicitly.',
        'Audit upstream installed-module scope separately from the exact archive surface consumed by the Rust adapter; never collapse IDA-only and dense-only into one claim.',
        'Run source-lock, archive-inventory, CMake-cache, receipt, archive-hash and real-link attacks at their respective boundaries.',
        'Keep publisher authentication, reproducible builds, signed custody and product release provenance as separate future gates; never infer them from adjacent SHA-256 values.',
      ],
      regressionTests: [
        {
          path: 'tests/sundials-source-lock.test.mjs',
          assertion: 'The authoritative official IDA-only source asset, tag/commit, length, digest and checked-in license identities remain closed, immutable and independently verified.',
        },
        {
          path: 'tests/sundials-native-build.test.mjs',
          assertion: 'The Node build contract rejects unsafe archive inventories, CMake policy drift, unexpected enabled modules and dynamic SUNDIALS linkage while preserving the upstream dense-only non-claim.',
        },
        {
          path: 'tools/test-native-dae-build.mjs',
          assertion: 'The adapter harness rejects duplicate canonical keys plus derived install, receipt and linked-archive tampering through both reuse and the Cargo link boundary.',
        },
        {
          path: 'rust-dae-native/tests/backend_identity.rs',
          assertion: 'A successfully constructed feature-on backend reports only the pinned SUNDIALS 7.8.0 IDA dense serial double-precision 64-bit identity and recreates without shared state.',
        },
        {
          path: 'tests/root-cause-library.test.mjs',
          assertion: 'The build-provenance record remains independently searchable and preserves canonical duplicate-key rejection, exact install-surface binding and the authentication/custody non-claim.',
        },
      ],
      affectedSurfaces: ['ci', 'documentation', 'packaging', 'release'],
      tags: ['build-receipt', 'content-identity', 'provenance', 'sundials', 'supply-chain'],
      references: [
        {
          kind: 'implementation',
          locator: 'native-backends/sundials/source-lock.json',
          note: 'Authoritative closed official IDA-only source, release, commit and license identity.',
        },
        {
          kind: 'implementation',
          locator: 'tools/verify-sundials-source.mjs',
          note: 'Closed-lock, exact archive and checked-in license/NOTICE verifier.',
        },
        {
          kind: 'implementation',
          locator: 'tools/build-sundials-ida.mjs',
          note: 'Bounded IDA-only archive extraction, audited native build and installed-package lifecycle probe.',
        },
        {
          kind: 'implementation',
          locator: 'rust-dae-native/build.rs',
          note: 'Independent lock, receipt, headers, macros, archive hashes and exact install-surface gate before linking.',
        },
        {
          kind: 'test',
          locator: 'tests/sundials-source-lock.test.mjs',
          note: 'Official lock shape, identity, mutation, digest, symlink and license regressions.',
        },
        {
          kind: 'test',
          locator: 'tests/sundials-native-build.test.mjs',
          note: 'Archive inventory, exact CMake policy, probe scope and dynamic-link regressions.',
        },
        {
          kind: 'test',
          locator: 'tools/test-native-dae-build.mjs',
          note: 'Derived adapter receipt, install-surface, archive-hash and real-link tamper campaign.',
        },
        {
          kind: 'test',
          locator: 'rust-dae-native/tests/backend_identity.rs',
          note: 'Runtime version and dense serial backend identity regression.',
        },
      ],
    }),
    record({
      id: 'rc-native-test-runner-context-capture',
      title: 'Nested Node test runner inherits its parent reporting context',
      symptom: 'A wrapper that executes a focused Node test campaign sees a successful child exit but an empty captured stdout, so it cannot prove the expected test, pass and failure counts.',
      evidence: [
        'The first Iteration 3 evidence-accounting run spawned node --test from inside a node:test case; the subprocess exited with status 0 but the wrapper’s exact 80-case summary assertion received an empty string.',
        'Running the same command directly produced the expected tests 80, pass 80 and fail 0 summary.',
        'Deleting the inherited NODE_TEST_CONTEXT control variable only for the nested subprocess restored the standalone report and made the focused wrapper pass without changing either governed source/build suite.',
      ],
      detection: [
        {
          method: 'nested focused-runner summary regression',
          signal: 'Spawn the governed source/build suites from a node:test case, require a normal exit, and parse exact tests, pass and fail totals from the independent child report.',
          failureCondition: 'The child exits successfully without a standalone summary, reports a different total, or the wrapper accepts status alone as proof that all expected cases executed.',
        },
      ],
      causalChain: [
        'The evidence-accounting test needs to verify the runtime-expanded total of a separate focused Node campaign.',
        'It launches node --test while already executing under Node’s test runner and passes the complete parent environment through unchanged.',
        'The child inherits NODE_TEST_CONTEXT and participates in the parent-managed reporting context instead of emitting the standalone CLI summary expected on captured stdout.',
        'A zero status remains visible, but the exact 80/80 accounting evidence disappears from the wrapper’s observation boundary.',
      ],
      rootCause: 'A nested Node test subprocess inherited its parent runner-control context even though the wrapper treated it as an independent CLI reporter.',
      resolution: [
        'Clone the subprocess environment and delete NODE_TEST_CONTEXT before launching the nested node --test command, without mutating the parent process environment.',
        'Require a normal unsignalled zero exit and independently assert the exact tests 80, pass 80 and fail 0 summary fields.',
        'Keep the exact 48-case Rust manifest accounting separate from this runtime-expanded 80-case Node source/build proof.',
      ],
      prevention: [
        'When a test launches another instance of the same test runner, isolate runner-private control variables and make the intended reporting channel explicit.',
        'Never treat a child status of zero as exact campaign-count evidence; assert the expected test, pass, fail, skip and filter boundary appropriate to that runner.',
        'Exercise evidence wrappers from inside the real parent harness rather than validating only the nested command at a shell prompt.',
      ],
      regressionTests: [
        {
          path: 'tests/dae-iteration3-evidence.test.mjs',
          assertion: 'The nested source/build runner removes only NODE_TEST_CONTEXT, exits normally and emits the exact 80/80 standalone summary.',
        },
        {
          path: 'tests/root-cause-library.test.mjs',
          assertion: 'The nested-runner cause remains independently searchable and preserves the empty-output symptom, isolated environment fix and exact-count requirement.',
        },
      ],
      affectedSurfaces: ['ci'],
      tags: ['child-process', 'evidence', 'node', 'test-harness', 'test-runner'],
      references: [
        {
          kind: 'test',
          locator: 'tests/dae-iteration3-evidence.test.mjs',
          note: 'Focused accounting wrapper that executes and parses the 80-case source/build truth suite from inside node:test.',
        },
        {
          kind: 'incident',
          locator: 'DAE Iteration 3 documentation and evidence campaign',
          note: 'Initial wrapper failure: child status 0 with empty captured stdout until the inherited runner context was removed.',
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
        'A SIL output path such as constructor.length could traverse inherited properties and satisfy an oracle even when the adapter reported no own output value.',
        'HIL identity, I/O, fault and safe-state evidence inherited from custom prototypes could satisfy pass checks without one own measured field.',
      ],
      detection: [
        {
          method: 'prototype-name boundary fuzzing',
          signal: 'Submit constructor, toString, valueOf and __proto__-shaped keys anywhere an object-backed allowlist or dotted output path guards external names.',
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
        'Traverse SIL output paths only through own properties and reject prototype-control path segments before execution.',
        'Require every HIL identity and measured-evidence lookup to be an own property of the supplied evidence maps.',
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
        {
          path: 'tests/loop-testing.test.mjs',
          assertion: 'SIL rejects prototype-control output paths and inherited output/unit properties cannot satisfy an oracle; inherited HIL identity, I/O, fault and safe-state values cannot prove a pass.',
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
          kind: 'implementation',
          locator: 'js/loop-testing.js',
          note: 'Own-property-only SIL output traversal, prototype-path rejection and HIL evidence lookups.',
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
        {
          kind: 'test',
          locator: 'tests/loop-testing.test.mjs',
          note: 'Inherited SIL output/unit and HIL evidence rejection regressions.',
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
        'The staged-tuning capability response initially advertised formats, group ids and resource ceilings but omitted the exact nine-field caller acceptance contract even though every field is mandatory and the request fails closed on omissions or additions.',
        'The CLI help rendered auto followed by all six group ids as one comma-separated alternative, which could be read as requiring the complete list even though any nonempty exact subset is accepted.',
        'Documentation initially labeled maxSamplesPerDataset as a calibration-only preprocessing cap even though both partitions can have a prepared planning grid while validation scoring alone remains fixed at the original full rate.',
      ],
      detection: [
        {
          method: 'negative surface-capability regression',
          signal: 'Compare the registry, capabilities response, visible GUI controls, MCP tool list, installed entry points, accepted request contracts and human metric labels with their executable implementations.',
          failureCondition: 'Customer-facing copy assigns a capability to a surface that cannot execute it, omits a required closed request field, misstates accepted group grammar or prepared-grid scope, or gives a combined objective the unit of only one constituent metric.',
        },
      ],
      causalChain: [
        'Several desktop-only capabilities are summarized in one manually written sentence.',
        'CLI, local API and MCP are treated as interchangeable automation surfaces.',
        'Source-tree and staged-entry execution is also treated as proof that the installed package ships a same-named command wrapper.',
        'Raw import and canonical fitting are described as one undifferentiated operation even though only the CLI owns the importer.',
        'A generic rmse field is formatted as volts without checking whether it contains a weighted temperature term.',
        'Capabilities, help and prose each hand-maintain a partial projection of the same closed request, so required fields and grid semantics can disappear or be simplified differently on each surface.',
        'Customer copy therefore inherits behavior or units that the underlying surface and metric contracts do not provide.',
      ],
      rootCause: 'Customer-facing capability and metric prose was maintained independently from structured per-surface request and result contracts, so convenient grouping replaced an exact implementation projection.',
      resolution: [
        'Declare governed Action 1 calibration and Action 2 staged ECM tuning as separate shipped add-ons on CLI and local API only, apart from the desktop-GUI simulation add-on.',
        'State explicitly that MCP provides design and review automation but runs neither calibration nor ECM tuning, and expose local-API capabilities separately from GUI and MCP lists.',
        'Describe calibration and tuning CLI commands as source/staged entry-point capabilities until package manifests and installed-tree smoke tests prove a real installed wrapper.',
        'Assign mapped raw-trace normalization only to the CLI importer and describe both CLI and authenticated API fitting as canonical-dataset consumers.',
        'Print voltage and temperature RMSE separately with their physical units, then label their weighted sum as an objective score without a physical unit.',
        'Advertise all nine required caller-acceptance field names in local-API capabilities, and test the exact ordered projection in source, staged and installed runners.',
        'Render group help as auto or one-to-six comma-separated ids rather than making the complete allowed-id catalog look like one required value.',
        'Label maxSamplesPerDataset as a prepared planning/optimizer-grid ceiling per dataset while stating separately that validation scoring always uses the original full-rate holdout.',
      ],
      prevention: [
        'Test negative surface assertions as well as positive ones whenever a capability is added or moved.',
        'Build capability summaries from the surface registry where possible and keep unavoidable prose explicit rather than using ambiguous slash-grouped interfaces.',
        'Distinguish source, staged and installed entry points in release claims and exercise the exact path customers receive.',
        'Require exact wording tests when one add-on spans surfaces with different accepted input contracts.',
        'Drive human metric labels from explicit result fields and test every multi-metric weighting mode for correct units.',
        'For every closed request, compare capabilities and help with the authoritative required/optional key sets and fail on an omitted required field.',
        'Name the data grid and partition role on every sample-count ceiling; a generic preprocessing label is insufficient when planning and scoring use different grids.',
      ],
      regressionTests: [
        {
          path: 'tests/addons.test.mjs',
          assertion: 'Action 1 and Action 2 are separate add-ons; raw normalization stays with the CLI importer, while tuning is declared exactly on CLI/local API and excludes desktop GUI and MCP.',
        },
        {
          path: 'tests/calibration-surfaces.test.mjs',
          assertion: 'Capability responses separate GUI, CLI, API and MCP, while weighted CLI output keeps voltage, temperature and combined-objective units distinct.',
        },
        {
          path: 'tests/packaged-tree.test.mjs',
          assertion: 'Package tests distinguish the staged bd entry point from the installed runner and pin exact tuning formats, caps and required acceptance fields without inventing an installed CLI wrapper.',
        },
        {
          path: 'tests/calibration-documentation.test.mjs',
          assertion: 'Product guides pin tune-ecm to CLI/local API, make negative GUI/MCP assertions and separate prepared-grid ceilings from original-full-rate validation scoring.',
        },
        {
          path: 'tests/ecm-tuning-surfaces.test.mjs',
          assertion: 'Source CLI/API tests pin exact acceptance-field discovery, subset group-help grammar, resource caps and negative GUI/MCP surfaces.',
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
          note: 'Exact Action 1/Action 2 separation and positive/negative tuning-surface assertions.',
        },
        {
          kind: 'test',
          locator: 'tests/calibration-surfaces.test.mjs',
          note: 'Weighted-objective human metric unit regression.',
        },
        {
          kind: 'test',
          locator: 'tests/packaged-tree.test.mjs',
          note: 'Staged entry-point and exact tuning capability-contract regression.',
        },
        {
          kind: 'documentation',
          locator: 'docs/ECM_TUNING.md',
          note: 'Canonical Action 2 CLI/local-API surface, artifact and non-claim boundary.',
        },
        {
          kind: 'test',
          locator: 'tests/calibration-documentation.test.mjs',
          note: 'Documentation surface, artifact and negative-proprietary-claim regressions.',
        },
        {
          kind: 'test',
          locator: 'tests/ecm-tuning-surfaces.test.mjs',
          note: 'Exact tuning capability, help grammar, acceptance-field and cap projection regressions.',
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
      id: 'rc-regression-path-containment-gap',
      revision: 2,
      title: 'Regression evidence path escapes its governed test root',
      symptom: 'A root-cause record can identify a path as local Rust regression evidence even though the same string traverses outside rust-core/tests or rust-dae-native/tests on Windows.',
      evidence: [
        'The original record schema admitted regression paths only below tests or tools, so a substantive Rust integration test could not be represented as governed evidence.',
        'The first Rust-path extension used a rust-core/tests prefix, a non-whitespace middle and a .rs suffix; that middle admitted Windows backslashes.',
        'A value such as rust-core/tests/..\\src\\dae.rs is an ordinary filename string on Linux but contains a parent traversal when a Windows consumer interprets the backslashes as separators.',
        'Iteration 2 needed the same governed evidence form below rust-dae-native/tests without broadening the grammar to arbitrary crates, source directories or file types.',
        'Prefix and suffix checks alone also do not state a portable policy for drive-letter, UNC, wrong-root, wrong-extension or explicit dot-segment inputs.',
      ],
      detection: [
        {
          method: 'cross-platform regression-path grammar test',
          signal: 'Validate one repository-relative Rust test path plus forward-slash traversal, backslash traversal, drive-letter, UNC, wrong-root and wrong-extension adversarial paths.',
          failureCondition: 'The governed Rust test is rejected or any absolute, traversing, backslash-separated, non-test-root or non-.rs Rust path is accepted.',
        },
      ],
      causalChain: [
        'Quality memory needs to cite the Rust integration test that proves a numerical resolution.',
        'The regression-path schema is expanded with a familiar prefix-and-suffix regular expression.',
        'Its permissive middle treats every non-whitespace character as path-safe and assumes the current platform separator rules.',
        'A catalog validated on Linux can therefore carry a string that escapes the governed test root when consumed on Windows.',
      ],
      rootCause: 'Repository containment was expressed as a Linux-oriented prefix plus a permissive character class instead of one platform-independent relative-path grammar.',
      resolution: [
        'Admit Rust regression evidence only below the exact rust-core/tests or rust-dae-native/tests prefix with a lowercase .rs suffix.',
        'Limit every accepted path to safe ASCII segments separated only by forward slashes, and reject single-dot or double-dot segments at any depth.',
        'Reject backslashes, drive-letter paths, UNC paths, absolute roots, wrong roots and wrong extensions while retaining the existing tests and tools path forms.',
        'Continue resolving every governed regression and local reference below the repository root and require the referenced file to exist.',
      ],
      prevention: [
        'Never use a generic non-whitespace class as a filesystem-containment policy.',
        'Pair every newly allowed evidence root with POSIX and Windows separators, absolute roots, dot segments, wrong roots and wrong extensions.',
        'Keep syntax validation and local existence checks separate: both must pass before a record becomes built-in evidence.',
      ],
      regressionTests: [
        {
          path: 'tests/root-cause-library.test.mjs',
          assertion: 'Real rust-core/tests and rust-dae-native/tests .rs paths validate while POSIX traversal, Windows traversal, drive-letter, UNC, wrong-root and wrong-extension paths fail closed for both roots.',
        },
      ],
      affectedSurfaces: ['browser', 'ci', 'documentation'],
      tags: ['containment', 'cross-platform', 'evidence', 'path', 'validation'],
      references: [
        {
          kind: 'implementation',
          locator: 'knowledge/root-causes/schema.v1.js',
          note: 'Forward-slash safe-segment grammar for governed regression paths.',
        },
        {
          kind: 'test',
          locator: 'tests/root-cause-library.test.mjs',
          note: 'Positive Rust path and cross-platform containment adversarial regressions.',
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
      id: 'rc-rust-msrv-float-pattern-lint-gap',
      revision: 2,
      title: 'Float-pattern test passes locally but fails the pinned Rust toolchain',
      symptom: 'A native solver campaign is green on the developer toolchain but its hosted Rust 1.77.2 gate fails before running the tests because warning denial rejects floating-point literals in a matches! pattern.',
      evidence: [
        'PR 75 CI run 31223697624 failed in the pinned SUNDIALS job while compiling rust-dae-native/src/native.rs, before the debug native campaign could execute.',
        'The interpolation regression matched interval_start_s: 0.5 and interval_end_s: 0.75 directly inside matches!, triggering illegal-floating-point-literal-pattern under Rust 1.77.2 with RUSTFLAGS=-Dwarnings.',
        'The same source compiled without that diagnostic on the available Rust 1.87.0 development toolchain, so a latest-toolchain-only local run did not reproduce the minimum-supported-toolchain gate.',
        'PR 79 CI run 31233721450 repeated the same failure class in three new event-restart assertions that matched event_time_s: 0.5 directly; both dense and KLU debug compilation stopped before their campaigns could run.',
      ],
      detection: [
        {
          method: 'pinned minimum-supported Rust test gate',
          signal: 'Compile and execute the complete feature-on native test campaign with the exact CI Rust version and RUSTFLAGS=-Dwarnings.',
          failureCondition: 'Source accepted by the development compiler emits any denied compatibility lint or fails to compile on Rust 1.77.2 before the native tests run.',
        },
      ],
      causalChain: [
        'An error enum is checked with matches! and floating-point constants are written as structural pattern fields.',
        'Compiler lint behavior differs between the available development toolchain and the project’s pinned minimum-supported Rust toolchain.',
        'Only the newer compiler is exercised before publication, so the compatibility diagnostic remains invisible locally.',
        'The exact-SHA hosted gate stops at compilation and skips the release and provenance portions of the native campaign.',
      ],
      rootCause: 'The regression encoded numerical values as floating-point patterns and prepublication verification did not compile that test with the exact warning-denied minimum-supported Rust toolchain used by CI.',
      resolution: [
        'Replace the matches! float pattern with full IdaError structural equality, carrying requested_time_s from the loop value and comparing the interval fields as ordinary values.',
        'For assertions that need partial structural matching, bind the floating-point field as a variable and compare it in the matches! guard instead of placing a float literal in the pattern.',
        'Keep the native CI job pinned to Rust 1.77.2 with RUSTFLAGS=-Dwarnings and require that exact gate before merge.',
      ],
      prevention: [
        'Do not encode floating-point expectations as Rust patterns; compare complete values or use explicit tolerance checks when the numerical contract is approximate.',
        'Treat the exact minimum-supported compiler and warning policy as a distinct compatibility test, not as interchangeable with a newer local compiler.',
        'When hosted compilation fails before test execution, preserve the compiler version, lint name, source construct and skipped downstream gates in the incident record.',
      ],
      regressionTests: [
        {
          path: 'tests/root-cause-library.test.mjs',
          assertion: 'The MSRV incident remains searchable, the native interpolation regression uses value equality instead of a float-literal pattern, and CI preserves Rust 1.77.2 with warning denial.',
        },
      ],
      affectedSurfaces: ['ci'],
      tags: ['compatibility', 'lint', 'msrv', 'rust', 'test-harness'],
      references: [
        {
          kind: 'test',
          locator: 'rust-dae-native/src/native.rs',
          note: 'Embedded interpolation-bound regression using complete IdaError equality rather than float literals in a pattern.',
        },
        {
          kind: 'implementation',
          locator: '.github/workflows/ci.yml',
          note: 'Exact Rust 1.77.2 warning-denied native SUNDIALS campaign.',
        },
        {
          kind: 'incident',
          locator: 'GitHub Actions run 31223697624 job 93013531192',
          note: 'Exact-head PR 75 failure at illegal-floating-point-literal-pattern before native test execution.',
        },
        {
          kind: 'incident',
          locator: 'GitHub Actions run 31233721450',
          note: 'Exact-head PR 79 recurrence in event-time patterns across both dense and KLU native jobs.',
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
      id: 'rc-shared-test-mutex-poison-cascade',
      title: 'Exact float assertion poisons a shared native test mutex',
      symptom: 'One harmless floating-point comparison failure turns most of the native solver campaign red with mutex-poison errors that hide the original numerical assertion.',
      evidence: [
        'A corrected initial-condition check expected exactly 12.0 but SUNDIALS returned 12.000000000000002, a normal representational difference for the accepted calculation.',
        'The assertion panicked while its test still owned the global instrumentation mutex.',
        'That 62-case campaign run reported 10 passes and 52 failures: one source assertion plus 51 follow-on lock().unwrap() poison failures unrelated to their solver behavior.',
        'The first exact-float failure was therefore buried under a much larger cascade and made the native campaign appear structurally broken.',
      ],
      detection: [
        {
          method: 'shared-harness failure isolation regression',
          signal: 'Force a panic while holding the native instrumentation lock, then acquire it for a later independently reset test and compare solver values with a stated numerical tolerance.',
          failureCondition: 'The later test fails only because the mutex is poisoned, or a mathematically accepted floating-point value is still required to be bitwise exact.',
        },
      ],
      causalChain: [
        'Many native tests serialize process-global allocation and lifecycle instrumentation through one mutex.',
        'A numerically overstrict exact-float assertion panics before its guard is dropped normally.',
        'Rust marks the shared mutex poisoned and later lock().unwrap() calls panic without exercising their test bodies.',
        'One local assertion produces dozens of misleading secondary failures.',
      ],
      rootCause: 'The test harness coupled an unjustified exact floating-point assertion with poison-fatal acquisition of a suite-wide instrumentation mutex.',
      resolution: [
        'Compare corrected floating-point components with explicit absolute and relative tolerances appropriate to the analytical contract.',
        'Centralize acquisition in a poison-recovering test_lock helper and reset each test’s instrumentation state after acquiring the guard.',
        'Continue reporting the original assertion failure while allowing unrelated tests to execute and provide independent evidence.',
      ],
      prevention: [
        'Use exact equality only for identities or values whose bit pattern is the contract; state tolerances for native numerical outputs.',
        'Do not let a process-global test lock turn one assertion into suite-wide skipped execution; recover the guard and reinitialize shared instrumentation explicitly.',
        'When a campaign shows many identical poison failures, inspect the first failing owner before triaging every downstream test.',
      ],
      regressionTests: [
        {
          path: 'tests/root-cause-library.test.mjs',
          assertion: 'The mutex-cascade record remains independently searchable and preserves the exact-float trigger, 51 secondary failures, tolerant comparison, poison recovery and explicit state-reset remedy.',
        },
      ],
      affectedSurfaces: ['ci'],
      tags: ['floating-point', 'mutex', 'rust', 'test-harness'],
      references: [
        {
          kind: 'test',
          locator: 'rust-dae-native/src/native.rs',
          note: 'Embedded corrected-initial-condition tolerance and poison-recovering serialized instrumentation harness.',
        },
        {
          kind: 'test',
          locator: 'rust-dae-native/tests/solve_reference.rs',
          note: 'Public corrected-initial-condition and numerical-reference regressions using explicit tolerances.',
        },
        {
          kind: 'incident',
          locator: 'DAE Iteration 2 native feature-on test campaign',
          note: 'One exact comparison failure poisoned TEST_LOCK and produced 51 misleading follow-on failures.',
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
      id: 'rc-sil-result-representation-gap',
      title: 'SIL execution evidence is mutable and compared by JSON key order',
      symptom: 'A software-in-the-loop run can report a false repeatability failure when an adapter reorders equivalent object keys, while incomplete or mutable adapter evidence can enter an unchecksummed result.',
      evidence: [
        'The former repeatability check compared JSON.stringify output, so two semantically identical plain objects with different insertion order were treated as different executions.',
        'The adapter echoed model version, graph checksum and solver but not model ID, leaving one plan identity field unproved at execution.',
        'Adapter output accepted undeclared fields and non-JSON values, and the returned result was neither deeply frozen nor bound to the verified plan checksum by its own checksum.',
        'Converting a thrown null-prototype object with String(error) raised a second exception, so adapter failure escaped instead of becoming checksummed fail evidence.',
      ],
      detection: [
        {
          method: 'SIL evidence representation regression',
          signal: 'Run the same verified plan against adapters that reorder keys, change one value, omit or alter identity, add a private field, or return a non-JSON value.',
          failureCondition: 'Key order changes repeatability, a value change does not, incomplete or open adapter evidence is accepted, or the result can be mutated without changing a bound checksum.',
        },
      ],
      causalChain: [
        'The adapter response is treated as an informal object rather than a closed execution-evidence contract.',
        'Repeatability is evaluated on JavaScript serialization order instead of a canonical semantic representation.',
        'The result projects mutable adapter data without a versioned result schema, verified-plan identity binding or content checksum.',
        'Consumers cannot reliably distinguish equivalent representations, changed execution values or later evidence mutation.',
      ],
      rootCause: 'SIL execution evidence lacked one canonical closed representation spanning adapter identity, semantic comparison, immutable result materialization and plan-bound content identity.',
      resolution: [
        'Normalize the adapter response to exact model, graph and solver identity plus closed finite-JSON outputs and units.',
        'Compare repeat executions with a canonical semantic digest so key order is irrelevant and value changes remain observable.',
        'Normalize arbitrary thrown values through guarded message extraction with a fixed non-throwing fallback.',
        'Materialize a deeply frozen battery-design/sil-test-result@1 carrying the verified @2 plan checksum and its own deterministic checksum.',
      ],
      prevention: [
        'Give every persisted execution result a versioned closed schema, canonical content identity and explicit parent-contract checksum.',
        'Test representation-only reordering separately from semantic mutation, identity mismatch, extra fields and non-JSON values.',
        'Include hostile thrown primitives, null-prototype objects and conversion failures in adapter-boundary regressions.',
        'Describe self-contained checksums as content identity, not producer authentication or proof of independent execution.',
      ],
      regressionTests: [
        {
          path: 'tests/loop-testing.test.mjs',
          assertion: 'SIL evidence accepts semantic key reordering, detects value changes, requires complete closed adapter identity, rejects non-JSON data, contains unrepresentable thrown values, and returns a frozen deterministic result bound to the plan checksum.',
        },
      ],
      affectedSurfaces: ['browser'],
      tags: ['canonicalization', 'content-identity', 'repeatability', 'sil', 'test-evidence'],
      references: [
        {
          kind: 'implementation',
          locator: 'js/loop-testing.js',
          note: 'Closed adapter normalization, canonical repeat comparison and checksummed SIL result materialization.',
        },
        {
          kind: 'implementation',
          locator: 'js/cosim-studio.js',
          note: 'Reference adapter echoes the complete governed model identity.',
        },
        {
          kind: 'documentation',
          locator: 'docs/LOOP_TESTING.md',
          note: 'SIL result representation, repeatability and checksum trust boundary.',
        },
        {
          kind: 'test',
          locator: 'tests/loop-testing.test.mjs',
          note: 'Canonical-order, semantic-change, adapter-closure, identity and immutable-result regressions.',
        },
      ],
    }),
    record({
      id: 'rc-solver-event-boundary-side-confusion',
      revision: 2,
      title: 'Event-terminal residual reuses the observable right-continuous side',
      symptom: 'A solver interval ending exactly at a step event can assemble its terminal residual with the post-event source value, while changing the ordinary residual to the pre-event value would break the caller-visible right-continuous convention.',
      evidence: [
        'The ordinary DAE residual is intentionally right-continuous: at exact event equality a StepSource uses its `after` value, matching the value callers observe at that time.',
        'An interval that approaches the same event from the left needs a different terminal equation: every source at that exact event time must still use `before`, while earlier sources use `after` and later sources use `before`.',
        'Two simultaneous sources share one event-table entry, but a source one representable floating-point value later is a separate entry and must not be swept into the selected left limit by an epsilon or tolerance.',
        'An invalid event index is rejected with `dae.invalid_event_index` before input inspection and without modifying the caller-owned residual destination.',
        'During a stop-limited native step, a callback at the selected event needs the indexed left residual, but a finite callback even one representable value beyond that stop is invalid native progress rather than permission to resume the ordinary right-continuous residual.',
        'Native dense interpolation is restricted to the open completed-step interval: a requested row equal to the current step endpoint is copied directly instead of being sent through `IDAGetDky`, and event equality is deferred until right-side correction.',
      ],
      detection: [
        {
          method: 'dual-sided exact-event residual regression',
          signal: 'At one selected event, compare the ordinary residual with the indexed left-limit residual for earlier, simultaneous, one-ULP-later and later StepSource values, then repeat with an invalid index and sentinel destination.',
          failureCondition: 'The ordinary residual stops being right-continuous, the selected simultaneous group is not entirely left-sided, a distinct nearby event is merged by tolerance, or any rejected call changes the destination.',
        },
        {
          method: 'native selected-event callback boundary regression',
          signal: 'With one event selected for the terminal step, invoke residual and Jacobian callbacks below, exactly at and one ULP beyond the event, repeat with non-finite callback times, and materialize ordinary and event rows at exact current time.',
          failureCondition: 'Equality uses the ordinary right side, a finite overshoot is evaluated on either side instead of failing with typed event context, non-finite time bypasses ordinary callback validation, or `IDAGetDky` is called at the current/event endpoint.',
        },
      ],
      causalChain: [
        'Caller-visible values at an exact scheduled time use the post-event side so time-series output is right-continuous.',
        'A solver interval ending at that boundary still represents the trajectory approaching from smaller times and therefore needs the pre-event side for its terminal residual.',
        'Reusing one time-only residual operation for both meanings either applies the post-event forcing too early or changes the established observable value at equality.',
        'Approximating the left side by subtracting an epsilon then makes classification depend on scale and can cross a distinct nearby event.',
        'Checking only whether a callback is equal to the event also leaves finite overshoot ambiguous and can silently apply the post-event equation before a governed restart.',
      ],
      rootCause: 'One residual entry point was being asked to represent two different sides of a discontinuity: right-continuous observable evaluation and the exact left-limit terminal equation.',
      resolution: [
        'Keep `DaeResidualSystem::residual_into` right-continuous at event equality so ordinary residual and caller-visible exact-time semantics continue to use each StepSource `after` value.',
        'Add `DaeResidualSystem::residual_event_left_limit_into`, keyed by the stable compiled event index, to evaluate the terminal residual at that event time without changing the ordinary operation.',
        'Select the left-sided group only when a StepSource `at_s` exactly equals the indexed event time: all exact simultaneous sources use `before`, earlier sources use `after`, later and representably distinct nearby sources use `before`; no event-time tolerance or nudged timestamp participates.',
        'Validate the event index before all input and destination work, return the typed index/count error, then retain the existing exact-length, finite-input and two-pass residual checks so every failure leaves caller storage unchanged.',
        'Keep the successful indexed event-left path inside the post-lowering zero-allocation callback contract and verify its Jacobian against finite differences at event equality.',
        'In the native `@2` callback state, route finite times below the selected event through the ordinary residual, exact equality through the indexed left-limit residual, and any finite overshoot to `ida.callback.event_boundary`; apply the same overshoot guard to Jacobian callbacks and let non-finite times reach the ordinary typed validation.',
        'Make `IDAGetDky` admissible only when `previous_time < requested_time < current_time`; publish exact current-step rows from the captured endpoint and exact event rows from the corrected state.',
      ],
      prevention: [
        'Name discontinuity-side operations explicitly; never silently change the side convention of a general residual or output API to satisfy a terminal-step need.',
        'Address scheduled discontinuities through the compiled event table and exact equality rather than `t - epsilon`, an absolute tolerance or a relative tolerance.',
        'Keep simultaneous, adjacent-representable, earlier/later, invalid-index and no-partial-write cases together whenever event lowering changes.',
        'Keep dense interpolation bounds open at both endpoints and account direct step/event rows separately so equality cannot silently move back onto the left interpolant.',
        'Preserve the first revision as core-only evidence: native restart remains a separate executable path, and only the opt-in `@2` dense and KLU backends consume this side contract; no product or deployment qualification follows.',
      ],
      regressionTests: [
        {
          path: 'rust-core/tests/dae_contract.rs',
          assertion: 'Executable contract cases preserve the ordinary right side, select the exact simultaneous left-limit group without merging a one-ULP-later event, and reject invalid indices, lengths and non-finite inputs atomically.',
        },
        {
          path: 'rust-core/tests/dae_allocation.rs',
          assertion: 'Allocator instrumentation includes the successful indexed event-left residual in the post-lowering zero-allocation callback set.',
        },
        {
          path: 'tests/root-cause-library.test.mjs',
          assertion: 'The event-side record remains independently searchable and preserves exact indexed classification, right-continuous ordinary evaluation, invalid-index atomicity, strict native callback overshoot rejection, no endpoint interpolation and the product-claim boundary.',
        },
      ],
      affectedSurfaces: ['ci'],
      tags: ['atomicity', 'continuity', 'dae', 'events', 'residual', 'solver'],
      references: [
        {
          kind: 'implementation',
          locator: 'rust-core/src/dae.rs',
          note: 'Separate right-continuous and exact indexed event-left residual paths with typed, atomic validation.',
        },
        {
          kind: 'test',
          locator: 'rust-core/tests/dae_contract.rs',
          note: 'Ordinary-side, exact/simultaneous/near-event, invalid-input destination-preservation and event-left Jacobian regressions.',
        },
        {
          kind: 'test',
          locator: 'rust-core/tests/dae_allocation.rs',
          note: 'Post-lowering zero-allocation regression for the successful event-left residual path.',
        },
        {
          kind: 'implementation',
          locator: 'rust-dae-native/src/native.rs',
          note: 'Pinned selected-event callback state with strict below/equality/overshoot routing for residual and Jacobian callbacks.',
        },
        {
          kind: 'test',
          locator: 'rust-dae-native/src/native.rs',
          note: 'Embedded exact, below, one-ULP-overshoot and non-finite selected-event callback regressions.',
        },
      ],
    }),
    record({
      id: 'rc-solver-event-consistent-restart-gap',
      title: 'Scheduled DAE events cross native history without a consistent restart',
      symptom: 'A native IDA solve can cross a StepSource discontinuity with pre-event integration history, publish an interpolated left state at equality, or restart from a requested row instead of the exact event endpoint.',
      evidence: [
        'The residual contract deliberately has two meanings at an event: the terminal integration interval needs the indexed left-limit equation, while caller-visible equality needs the corrected right-continuous state.',
        'Allowing IDA to step across that change without an exact stop and reinitialization leaves its multistep history based on equations that no longer apply.',
        'The exact stop endpoint must remain the state supplied to `IDAReInit`; dense-output materialization and correction are separate transitions with their own state-custody invariant.',
        'A requested row exactly at the event must come directly from the post-`IDACalcIC` consistent state; interpolating it from the left segment would expose the wrong side and misstate interpolation evidence.',
      ],
      detection: [
        {
          method: 'left-stop/restart/right-output trajectory regression',
          signal: 'Solve a graph-scheduled forcing change with requested rows before, exactly at and after the event while checking the published event/restart statistics.',
          failureCondition: 'The pre-event row is not left-sided, equality is not the corrected right state, the after-event trajectory is wrong, or differential state changes across correction.',
        },
      ],
      causalChain: [
        'A compiled StepSource changes the residual equation at an exact finite time.',
        'A multistep solver retains history and derivative information from the interval approaching that boundary.',
        'Without a governed stop, reinitialization and consistent-initial-condition correction, the old history becomes the starting state for the new equation.',
        'The resulting equality row and post-event trajectory can be finite and plausible while representing the wrong side of the discontinuity.',
      ],
      rootCause: 'The native adapter had no explicit state-machine seam that ended the left equation at a compiled event, rebuilt consistent right-side algebraic/derivative state and published equality without left interpolation.',
      resolution: [
        'Add `IdaEventPolicy::Restart { max_restarts }` while retaining `Reject` as the default fail-closed behavior; only events from `DaeResidualSystem::events()` in the exact interval `initial_time < event <= final_requested_time` are active.',
        'For each active event, select its indexed left residual, set `IDASetStopTime`, advance with `IDA_ONE_STEP`, accept intermediate `IDA_SUCCESS`, and require `IDA_TSTOP_RETURN` at the exact event bits before restarting.',
        'Clear the stop and left marker, call `IDAReInit`, run bounded `IDACalcIC(IDA_YA_YDP_INIT, target)` and `IDAGetConsistentIC`, and require bit-exact continuity for every differential y component.',
        'Publish an event-equality request directly from the corrected state, never through `IDAGetDky`; keep interpolated, step-endpoint and event-equality row counters distinct and require their sum to equal the requested row count.',
        'Coordinate the behavior change through `battery-design/dae-residual@2`, dense backend/result `@2` and KLU backend/result `@2`; historical `@1` records remain evidence of the earlier event-rejecting contracts.',
      ],
      prevention: [
        'Model every discontinuity as an explicit stop/reinitialize/correct transition rather than as an ordinary output time or a small integration step.',
        'Keep before/equality/after rows, final-time equality, differential continuity and direct-row accounting in the same executable campaign.',
        'Keep `Reject` as the compatibility default and do not infer browser, product, safety or deployment qualification from the source-only native reference path.',
      ],
      regressionTests: [
        {
          path: 'tests/root-cause-library.test.mjs',
          assertion: 'The native event-restart record remains searchable and bound to exact stop, reinitialization, consistent correction, right-side equality and coordinated @2 identities.',
        },
      ],
      affectedSurfaces: ['ci', 'documentation'],
      tags: ['continuity', 'dae', 'events', 'ida', 'restart', 'sundials'],
      references: [
        {
          kind: 'implementation',
          locator: 'rust-dae-native/src/lib.rs',
          note: 'Opt-in event policy, bounded event schedule, typed failure context and coordinated native @2 public contracts.',
        },
        {
          kind: 'implementation',
          locator: 'rust-dae-native/src/native.rs',
          note: 'Exact stop, reinitialization, correction, continuity and equality-publication state machine shared by dense and KLU sessions.',
        },
        {
          kind: 'test',
          locator: 'rust-dae-native/src/native.rs',
          note: 'Embedded left/equality/right trajectory, final-event and row-accounting regressions.',
        },
        {
          kind: 'test',
          locator: 'tests/root-cause-library.test.mjs',
          note: 'Governed memory assertions for the event restart seam and its contract boundaries.',
        },
      ],
    }),
    record({
      id: 'rc-solver-event-endpoint-capture-work-gap',
      title: 'Endpoint custody adds dimension work to every internal step',
      symptom: 'A state-custody fix can keep restart values correct while adding two full-dimension vector copies or scans to every successful native integration step, far beyond the declared request work evidence.',
      evidence: [
        'The first endpoint-preservation fix captured y and yp after every successful `IDA_ONE_STEP` even though most steps neither end at an event nor materialize an exact step-endpoint row.',
        'At the sparse ceilings of 10,000 variables and 10,000,000 internal steps, two full-vector operations per step permit roughly 200,000,000,000 additional element operations outside the original counter model.',
        'Interior requested rows use bounded dense interpolation and do not require persistent endpoint custody; only `IDA_TSTOP_RETURN` and a request exactly equal to current step time consume the captured state.',
        'A correct trajectory alone cannot expose the regression because unconditional copying changes work, not numerical output.',
      ],
      detection: [
        {
          method: 'endpoint-capture count invariant',
          signal: 'Solve through many internal steps with event and exact-step output boundaries, then compare the published endpoint capture count with event restarts plus direct step-endpoint rows.',
          failureCondition: 'A capture occurs for an ordinary step without a direct endpoint consumer, the count differs from restarts plus step-endpoint rows, or capture work is justified only by the much larger internal-step ceiling.',
        },
      ],
      causalChain: [
        'Restart correctness requires retaining y and yp at an event before later dense-output calls mutate session vectors.',
        'The initial fix generalizes that requirement into unconditional post-step endpoint capture.',
        'Each successful step therefore performs work proportional to DAE dimension even when no boundary consumer exists.',
        'Multiplying the maximum dimension by the global step ceiling creates an unreported work surface many orders larger than the result or event schedule.',
      ],
      rootCause: 'Endpoint capture was placed in the generic successful-step path instead of being gated by the two operations that actually consume authoritative endpoint state.',
      resolution: [
        'Determine whether the accepted step returned `IDA_TSTOP_RETURN` or contains a requested row exactly equal to current time before copying endpoint state.',
        'Capture y and yp only for those event or direct-step-output boundaries; keep strict interior rows on `IDAGetDky` without an endpoint copy.',
        'Publish `endpoint_state_captures()` with checked increment and require the exact invariant `endpoint_state_captures = event_restarts + step_endpoint_output_rows` for successful requests.',
        'This changes endpoint-copy work from proportional to `2 * dimension * internal_steps` to `2 * dimension * (event_restarts + step_endpoint_output_rows)`, whose two count terms already have explicit request ceilings.',
      ],
      prevention: [
        'Review the computational placement of every correctness fix separately from its numerical outcome and memory allocation behavior.',
        'For vector-wide work inside a solve loop, publish or derive a deterministic count and test it at a semantic boundary rather than relying on elapsed time.',
        'Keep many-step/no-endpoint and event/direct-endpoint cases together so unconditional O(dimension*steps) work cannot return unnoticed.',
      ],
      regressionTests: [
        {
          path: 'tests/root-cause-library.test.mjs',
          assertion: 'The endpoint-capture work record remains searchable and preserves the 200-billion-element worst case, semantic capture gate and exact published count invariant.',
        },
      ],
      affectedSurfaces: ['ci', 'documentation'],
      tags: ['accounting', 'complexity', 'dae', 'events', 'ida', 'work-bound'],
      references: [
        {
          kind: 'implementation',
          locator: 'rust-dae-native/src/native.rs',
          note: 'Semantically gated endpoint capture and checked capture-count publication in the shared native solve loop.',
        },
        {
          kind: 'implementation',
          locator: 'rust-dae-native/src/lib.rs',
          note: 'Public read-only endpoint_state_captures solve statistic.',
        },
        {
          kind: 'test',
          locator: 'rust-dae-native/src/native.rs',
          note: 'Embedded event trajectory asserts exact capture accounting independently of internal-step count.',
        },
        {
          kind: 'test',
          locator: 'tests/root-cause-library.test.mjs',
          note: 'Governed memory assertions for bounded endpoint-capture work.',
        },
      ],
    }),
    record({
      id: 'rc-solver-event-endpoint-state-custody',
      title: 'Dense output replaces the exact event endpoint before restart',
      symptom: 'A requested row shortly before an event can silently become the state supplied to `IDAReInit`, shifting the restarted trajectory away from the exact TSTOP endpoint.',
      evidence: [
        '`IDAGetDky` writes interpolated y or yp into the N_Vector supplied as its destination; it is not a read-only query on the session vectors.',
        'After `IDA_TSTOP_RETURN`, the adapter still has to publish requested rows strictly before the event from the final left interval.',
        'Using the live session y and yp as dense-output destinations overwrites the exact event endpoint before reinitialization.',
        'The defect is exposed only when a pre-event requested row falls inside the final stop step; coarser grids can appear correct because no interpolation occurs between TSTOP and restart.',
      ],
      detection: [
        {
          method: 'terminal-step endpoint custody regression',
          signal: 'Choose a pre-event output inside the final TSTOP step, then request equality and a post-event row and compare all three against the analytical piecewise trajectory.',
          failureCondition: 'The left row is wrong, `IDAReInit` receives the interpolated row rather than the stop endpoint, equality correction starts from the wrong differential state, or the post-event trajectory shifts.',
        },
      ],
      causalChain: [
        'IDA reaches the exact event and stores the terminal left y and yp in its session vectors.',
        'The result loop drains an earlier requested row through `IDAGetDky` into those same vectors.',
        'The dense-output write replaces the event endpoint with an interpolated state.',
        '`IDAReInit` then starts the right-side correction from a valid but temporally earlier state, so the failure need not trigger a native error.',
      ],
      rootCause: 'The adapter gave solver-owned endpoint vectors two incompatible custody roles: authoritative restart state and mutable destinations for pre-event dense-output materialization.',
      resolution: [
        'At `IDA_TSTOP_RETURN`, copy both event y and event yp into dedicated request-owned scratch before any requested row is materialized.',
        'Allow strictly pre-event `IDAGetDky` calls to use the session vectors, then restore both saved endpoint vectors before `IDAReInit`.',
        'Keep event equality out of dense interpolation and publish it only after right-side consistent correction.',
        'Verify differential continuity against the saved event y, not against whatever vector contents remain after output materialization.',
      ],
      prevention: [
        'Treat every native getter with an output vector as a write operation and document who owns authoritative state before and after the call.',
        'Separate solver endpoint custody from result-row scratch conceptually even when bounded implementation storage is reused.',
        'Keep a requested row inside the terminal stop step in restart regressions; endpoint-only grids do not exercise this aliasing sequence.',
      ],
      regressionTests: [
        {
          path: 'tests/root-cause-library.test.mjs',
          assertion: 'The endpoint-custody record remains searchable and preserves the IDAGetDky mutation, saved y/yp, restore-before-ReInit and terminal-step regression requirements.',
        },
      ],
      affectedSurfaces: ['ci', 'documentation'],
      tags: ['aliasing', 'dae', 'dense-output', 'events', 'ida', 'state-custody'],
      references: [
        {
          kind: 'implementation',
          locator: 'rust-dae-native/src/native.rs',
          note: 'Dedicated event y/yp custody across pre-event interpolation and restart.',
        },
        {
          kind: 'test',
          locator: 'rust-dae-native/src/native.rs',
          note: 'Embedded pre-event-in-terminal-step, equality and post-event analytical trajectory regression.',
        },
        {
          kind: 'test',
          locator: 'tests/root-cause-library.test.mjs',
          note: 'Governed memory assertions for native endpoint ownership across dense output.',
        },
      ],
    }),
    record({
      id: 'rc-solver-event-failure-context-loss',
      title: 'Event-active native failures lose event and phase evidence',
      symptom: 'A restarted solve can return a valid low-level callback, counter, interpolation or KLU error without identifying which compiled event and restart phase failed.',
      evidence: [
        'The event solve loop originally used ordinary `?` propagation at multiple getter, counter, progress, interpolation and accounting sites inside an active left segment.',
        'The same low-level error may be correct both inside and outside event handling, but an active restart additionally needs stable event index, exact event time and lifecycle phase to be actionable.',
        'KLU setup/solve failure has nested last-linear-flag evidence that must survive event wrapping even when the flag getter itself fails.',
        'A request ending exactly at an event can fail while collecting final statistics after event position has advanced, so current-loop state alone no longer identifies the terminal event.',
        'Blind wrapping at every helper can create repeated `EventRestartFailure` layers and make the public evidence shape depend on which helper noticed the error first.',
      ],
      detection: [
        {
          method: 'exact nested event-failure shape regression',
          signal: 'Inject non-finite y/yp at TSTOP, a terminal final-stat getter failure and an active-event KLU solve plus last-flag-getter failure, then compare the complete error tree and teardown order.',
          failureCondition: 'The outer error omits event index/time/phase, contains more than one event wrapper, changes the underlying callback/native/KLU evidence, continues into restart correction, or leaks native resources.',
        },
      ],
      causalChain: [
        'One event transition calls many generic helpers that correctly return typed low-level `IdaError` values.',
        'Direct propagation exits the event state machine before attaching the active compiled-event identity and phase.',
        'Callers receive the immediate failure but cannot determine which restart boundary owned it.',
        'Adding wrappers piecemeal can then double-wrap already contextual errors or lose a terminal event after the event cursor advances.',
      ],
      rootCause: 'Event context was implicit mutable loop state rather than one centralized, exactly-once error-mapping boundary spanning every active phase and terminal evidence read.',
      resolution: [
        'Route generic callback, native, KLU and phase failures from the active left segment through one `with_event_context` boundary that adds `EventRestartFailure { event_index, event_time_s, phase, source }` and leaves an already contextual error unchanged.',
        'Keep self-identifying `EventDifferentialDiscontinuity` and `ReinitCounterInvariant` failures as direct typed errors rather than adding a redundant event wrapper.',
        'Use explicit `IdaEventPhase` values for stop registration, left solve, stop clearing, reinitialization, consistent correction, equality publication and final evidence so the outer failure is stable.',
        'Retain the last completed event through terminal result/statistic collection, allowing a final getter failure after a terminal event to carry exactly one `FinalizeEvidence` context layer.',
        'Preserve the inner error without translation: callback `DaeError`, exact native stage/flag and KLU available/unavailable last-linear-flag evidence remain inspectable through the standard error source chain.',
        'On endpoint validation failure, stop before `IDAReInit`, `IDACalcIC` or `IDAGetConsistentIC` and preserve balanced native-resource teardown order.',
      ],
      prevention: [
        'Define one ownership boundary for contextual wrapping and make helpers return unwrapped domain errors unless they own a distinct nested phase.',
        'Test full error equality, not only the top-level code or display string, for every multi-stage native state machine.',
        'Keep dense callback, terminal-finalization and KLU nested-evidence injections together whenever event control flow changes.',
        'Retain completed-operation context until all result evidence that semantically belongs to that operation has been collected.',
      ],
      regressionTests: [
        {
          path: 'tests/root-cause-library.test.mjs',
          assertion: 'The event failure-context record remains searchable and preserves exactly one event wrapper, phase-specific evidence, unchanged nested native/KLU causes and fail-fast teardown.',
        },
      ],
      affectedSurfaces: ['ci', 'documentation'],
      tags: ['dae', 'diagnostics', 'error-context', 'events', 'ida', 'klu'],
      references: [
        {
          kind: 'implementation',
          locator: 'rust-dae-native/src/native.rs',
          note: 'Central exactly-once event context mapper, explicit lifecycle phases and retained terminal-event evidence context.',
        },
        {
          kind: 'implementation',
          locator: 'rust-dae-native/src/lib.rs',
          note: 'Typed EventRestartFailure source chain, IdaEventPhase and preserved callback/native/KLU error variants.',
        },
        {
          kind: 'test',
          locator: 'rust-dae-native/src/native.rs',
          note: 'Embedded TSTOP endpoint, terminal final-getter and active-event KLU nested-evidence failure regressions.',
        },
        {
          kind: 'test',
          locator: 'tests/root-cause-library.test.mjs',
          note: 'Governed memory assertions for exact event failure provenance.',
        },
      ],
    }),
    record({
      id: 'rc-solver-event-final-horizon-custody',
      title: 'Inactive post-final event contaminates the requested horizon',
      symptom: 'A Restart-policy solve with no active event can still evaluate a StepSource just beyond the requested final time and use that post-final equation when materializing the final row.',
      evidence: [
        '`IDA_ONE_STEP` may advance beyond its `tout`; the ordinary event-free adapter intentionally used `IDAGetDky` to recover an earlier requested final row from that completed step.',
        'Filtering restart events to `initial_time < event <= final_requested_time` controls which events restart the solver but does not by itself prevent native trial callbacks after the final horizon.',
        'A compiled event exactly one ULP after final is inactive for restart accounting yet changes the right-continuous StepSource value seen by an overshooting callback.',
        'The final interpolant can therefore be finite and deterministic but already influenced by behavior the request explicitly placed outside its horizon.',
        'The same exposure returns on the final segment after an earlier active event restart unless the terminal boundary is reinstalled.',
      ],
      detection: [
        {
          method: 'one-ULP post-horizon event isolation regression',
          signal: 'Solve a dense graph with a StepSource one representable value after final both before and after an earlier active restart, then repeat the no-active-restart case with KLU while recording stop, interpolation and restart calls.',
          failureCondition: 'The final row reflects post-final forcing, terminal native time overshoots final, `IDAGetDky` materializes final, a terminal-only stop increments event restarts, or the boundary is lost after reinitialization.',
        },
      ],
      causalChain: [
        'Public validation classifies the next graph event as inactive because it is later than the requested final time.',
        'The final IDA_ONE_STEP call treats final as `tout` but may take an accepted step whose internal callback time is later.',
        'The inactive StepSource switches during that trial and changes the equation used to form the step history/interpolant.',
        'Dense output at final then carries post-horizon influence even though no restart was counted and every requested time passed validation.',
      ],
      rootCause: 'Restart admission bounded the event list but did not give the final requested time custody over native step and callback execution after the last active event.',
      resolution: [
        'Under `IdaEventPolicy::Restart`, install `IDASetStopTime(final_requested_time)` whenever no active event remains, including the final segment after an earlier restart.',
        'Represent the terminal boundary separately from an event-left boundary: residual and Jacobian callbacks use ordinary right-continuous semantics through exact final equality, while any finite callback time beyond final fails with `ida.callback.horizon_boundary` before writes or sparse work.',
        'Require exact-time `IDA_TSTOP_RETURN` at the terminal stop, capture the endpoint and publish the final requested row directly as a step endpoint instead of calling `IDAGetDky`.',
        'Do not call `IDAReInit`, `IDACalcIC` or `IDAGetConsistentIC` for a terminal-only stop and do not increment event restart or event-equality counters.',
        'Apply the same terminal-stop state machine to dense and KLU sessions; executable cases cover dense isolation before and after a real active restart plus KLU isolation with no active restart.',
      ],
      prevention: [
        'Distinguish filtering scheduled transitions from constraining the numerical solver horizon; both gates are required.',
        'Treat a final requested time as a hard callback boundary whenever later graph behavior can change the residual.',
        'Keep inactive-near-final events, exact terminal native time, no-Dky final publication and zero terminal-only restarts in dense and sparse regression matrices.',
        'Do not infer service, browser, package or product integration from this source-only native horizon guard.',
      ],
      regressionTests: [
        {
          path: 'tests/root-cause-library.test.mjs',
          assertion: 'The final-horizon custody record remains searchable and preserves terminal stopping, ordinary equality, overshoot rejection, direct final publication and dense/KLU post-final isolation.',
        },
      ],
      affectedSurfaces: ['ci', 'documentation'],
      tags: ['custody', 'dae', 'events', 'horizon', 'ida', 'time-boundary'],
      references: [
        {
          kind: 'implementation',
          locator: 'rust-dae-native/src/native.rs',
          note: 'Separate terminal callback boundary and final-segment stop shared by dense and KLU sessions.',
        },
        {
          kind: 'implementation',
          locator: 'rust-dae-native/src/lib.rs',
          note: 'Typed callback horizon-boundary error and stable native stage evidence.',
        },
        {
          kind: 'test',
          locator: 'rust-dae-native/src/native.rs',
          note: 'Embedded ordinary-equality/overshoot callback, dense before/after-restart and KLU one-ULP post-final isolation regressions.',
        },
        {
          kind: 'test',
          locator: 'tests/root-cause-library.test.mjs',
          note: 'Governed memory assertions for final-horizon custody and non-product scope.',
        },
      ],
    }),
    record({
      id: 'rc-solver-event-reinit-counter-reset',
      title: 'IDA reinitialization resets counters inside a global solve budget',
      symptom: 'After one or more event restarts, published work statistics and the global step limit can describe only the last IDA segment even though earlier segments and event correction already consumed native work.',
      evidence: [
        '`IDAReInit` resets IDA and linear-solver statistics, so subtracting one initial baseline from the final native counters loses all work completed before each restart.',
        'A per-segment `IDASetMaxNumSteps` allowance is not a request-global cap unless Rust separately accounts every successful `IDA_ONE_STEP` across all segments.',
        'Event `IDACalcIC` work occurs after reinitialization and must remain in the segment statistics even though it does not authorize an extra integration step.',
        'KLU Jacobian evaluation and entry-work ceilings are callback-owned request counters and must persist across `IDAReInit` rather than resetting with SUNDIALS statistics.',
      ],
      detection: [
        {
          method: 'multi-segment counter and exact-cap regression',
          signal: 'Run a restarted event solve at its exact global step cap and across multiple segments, comparing successful ONE_STEP calls, checked segment deltas, event/direct-row counts and persistent sparse callback work.',
          failureCondition: 'Any statistic decreases or omits a completed segment, reinitialization leaves a raw counter nonzero, the exact cap blocks correction/equality after the final allowed step, an extra solve step runs, or KLU work restarts at zero.',
        },
      ],
      causalChain: [
        'One public solve request is divided into multiple native IDA sessions-in-place by scheduled event restarts.',
        '`IDAReInit` deliberately clears native history and counters for the next segment.',
        'Reading only the final raw values makes earlier work disappear and can restore a nominal per-call step allowance.',
        'Resource evidence and request admission then understate actual cumulative work despite every individual native segment appearing valid.',
      ],
      rootCause: 'Reset-scoped native counters were treated as request-scoped evidence instead of being snapshotted and accumulated by the Rust owner before every `IDAReInit`.',
      resolution: [
        'Snapshot the complete native statistic set at each segment boundary, compute checked nondecreasing deltas, and add them into Rust-owned cumulative totals before reinitialization.',
        'Immediately after `IDAReInit`, read every governed native and linear-solver counter, require it to be zero after reinitialization, and fail with `ida.events.reinit_counter_invariant` otherwise.',
        'Carry event correction work in the next segment delta, preserve callback-owned KLU evaluation/entry-work totals across restarts, and use checked addition for every accumulated field.',
        'Own one request-global successful-step count, set each native maximum from the remaining global allowance, and require cumulative internal steps to equal `one_step_calls` without spending another step for correction or direct equality publication.',
        'Expose restart and event-equality row counts separately; require interpolated plus step-endpoint plus event-equality rows to equal the requested output count.',
      ],
      prevention: [
        'Document every native counter as call-, segment- or request-scoped before using it in a public resource limit or result.',
        'Treat reinitialization as a mandatory accounting boundary: snapshot before it, assert reset after it, and never recover cumulative evidence from the final raw counter alone.',
        'Keep exact-cap, final-event equality, multiple-restart, integer-overflow and persistent KLU-work cases whenever event sequencing or statistics change.',
      ],
      regressionTests: [
        {
          path: 'tests/root-cause-library.test.mjs',
          assertion: 'The event counter-reset record remains searchable and preserves checked per-segment aggregation, zero-after-ReInit assertions, one global step cap, direct-row accounting and persistent KLU work.',
        },
      ],
      affectedSurfaces: ['ci', 'documentation'],
      tags: ['accounting', 'budget', 'dae', 'events', 'ida', 'restart'],
      references: [
        {
          kind: 'implementation',
          locator: 'rust-dae-native/src/native.rs',
          note: 'Counter snapshots, checked segment accumulation, reset invariants, global ONE_STEP budget and callback-owned KLU work state.',
        },
        {
          kind: 'implementation',
          locator: 'rust-dae-native/src/lib.rs',
          note: 'Published cumulative solver statistics, event restart/equality counters and typed reinitialization invariant failure.',
        },
        {
          kind: 'test',
          locator: 'rust-dae-native/src/native.rs',
          note: 'Embedded exact-global-cap, final-event equality, segment accounting and reinitialization regressions.',
        },
        {
          kind: 'test',
          locator: 'tests/root-cause-library.test.mjs',
          note: 'Governed memory assertions for reset-scoped versus request-scoped work evidence.',
        },
      ],
    }),
    record({
      id: 'rc-solver-event-segment-spacing-gap',
      title: 'Ordered event times can form unusable native IDA segments',
      symptom: 'An exact increasing event schedule can pass generic ordering checks but fail inside IDA because a left segment or post-event consistent-correction target is too close, nonrepresentable or non-finite.',
      evidence: [
        'The compiled event table preserves distinct finite times exactly, including adjacent representable values, but numerical ordering alone does not guarantee a usable IDA target span.',
        'Every active event creates a left `IDASolve` target and every restart creates an `IDACalcIC` target even when neither time appears in the caller output grid.',
        'When the last active event equals the final requested output, correction still needs a strictly later target; mirroring the preceding segment can overflow or round back to the event.',
        'Letting any invalid segment reach allocation or FFI turns a deterministic request-shape error into a late native failure with weaker event context.',
      ],
      detection: [
        {
          method: 'event-segment floating-boundary preflight regression',
          signal: 'Validate active events at underflow, reciprocal, roundoff and representable-progress boundaries, two nearby distinct events, an event equal to final output and a mirrored target that overflows.',
          failureCondition: 'An unusable segment allocates native resources, a usable exact boundary is rejected, distinct events are merged, the final-event correction target is not later, or the error omits event index/time and a stable code.',
        },
      ],
      causalChain: [
        'Graph lowering supplies a sorted exact event sequence and the output grid supplies one final horizon.',
        'Restart execution derives additional native solve and correction spans between those boundaries.',
        'IEEE-754 underflow, reciprocal overflow, roundoff distance or nonrepresentable addition can make a positive comparison unusable to pinned IDA 7.8.0.',
        'Without full preflight, allocation and native execution begin before the adapter discovers that the schedule cannot progress or calculate consistent conditions.',
      ],
      rootCause: 'Validation covered the caller output grid but not every derived event-to-event left segment and post-event correction target actually passed to IDA.',
      resolution: [
        'Before native allocation, filter active events only by exact `initial_time < event <= final_requested_time`, enforce the caller restart ceiling, and validate every previous-boundary-to-event span with the pinned IDA target admissibility gates.',
        'For post-event `IDACalcIC`, use the next active event as target, otherwise the later final output, and when event equals final derive `event + (event - previous_boundary)` as a mirrored horizon.',
        'Require each derived target distance, 0.001-scaled step, reciprocal and forward addition to be finite and representable under the same IDA 7.8.0 preflight used for initial targets.',
        'Reject failures before allocation as `ida.events.segment_too_close` or `ida.events.correction_target_invalid`, preserving the stable compiled event index and exact event time.',
        'Do not use an epsilon or tolerance to merge nearby events; simultaneous numeric equals share the compiled event, while every distinct representable time remains a separate restart.',
      ],
      prevention: [
        'Validate the complete derived native operation schedule, not only values supplied directly in the public output grid.',
        'Keep event-at-final and next-event correction policies explicit so a refactor cannot accidentally pass an equal `tout1` to `IDACalcIC`.',
        'Pair every floating-point rejection with the first accepted boundary and assert pre-allocation failure plus exact event evidence.',
      ],
      regressionTests: [
        {
          path: 'tests/root-cause-library.test.mjs',
          assertion: 'The event-spacing record remains searchable and preserves complete pre-allocation segment/correction validation, mirrored final-event targeting, exact distinct-event semantics and typed event evidence.',
        },
      ],
      affectedSurfaces: ['ci', 'documentation'],
      tags: ['dae', 'events', 'floating-point', 'ida', 'preflight', 'time-grid'],
      references: [
        {
          kind: 'implementation',
          locator: 'rust-dae-native/src/lib.rs',
          note: 'Event policy validation over every active left segment and derived consistent-correction target.',
        },
        {
          kind: 'implementation',
          locator: 'rust-dae-native/src/native.rs',
          note: 'Execution consumes the prevalidated next-event, final-time or mirrored correction target.',
        },
        {
          kind: 'test',
          locator: 'rust-dae-native/src/native.rs',
          note: 'Embedded event-span, correction-target, nearby-event and pre-allocation boundary regressions.',
        },
        {
          kind: 'test',
          locator: 'tests/root-cause-library.test.mjs',
          note: 'Governed memory assertions for the complete derived native event schedule.',
        },
      ],
    }),
    record({
      id: 'rc-solver-evidence-acceptance-drift',
      title: 'Solver evidence summary silently weakens the planned acceptance gate',
      symptom: 'A native solver iteration is documented as complete even though its original acceptance plan required tolerance-convergence and independently identified cross-solver evidence that the test campaign does not yet contain.',
      evidence: [
        'The checked-in Iteration 2 plan named stable failure mapping, tolerance-convergence and cross-solver conformance as separate Task 2H outputs.',
        'The first completion draft replaced those named gates with a looser analytical/index-one/stiff-reference summary and marked Task 2H complete.',
        'Comparing maximum BDF order 1 with order 5 at one tolerance proves order behavior, not convergence as tolerances tighten.',
        'Unprovenanced pinned Robertson values and agreement with another in-repository solver do not by themselves identify an independent external reference.',
      ],
      detection: [
        {
          method: 'planned-versus-delivered solver-evidence audit',
          signal: 'Compare every named acceptance item in the preimplementation solver plan with an executable regression and identified evidence provenance before changing its status to complete.',
          failureCondition: 'Documentation marks the evidence task complete after renaming or omitting a planned gate, or a fixed numerical reference has no solver, version, method and tolerance provenance.',
        },
      ],
      causalChain: [
        'A detailed solver campaign establishes several independent numerical acceptance requirements.',
        'Implementation accumulates strong analytical and stiff-problem tests but does not preserve a one-to-one checklist against the original wording.',
        'Completion documentation summarizes the available evidence in broader terms.',
        'The broader summary hides missing convergence and external-reference proof while presenting the task as complete.',
      ],
      rootCause: 'The completion review evaluated a rewritten evidence summary instead of reconciling each original acceptance item with a concrete test and provenance record.',
      resolution: [
        'Retain the original Task 2H acceptance names and add a real loose, medium and tight analytical tolerance-convergence regression.',
        'Cross-check the same ODE graph with rust-core’s independently implemented Dormand–Prince solver while checking both against the closed-form solution.',
        'Bind the stiff Robertson fixed values to an independently reproduced SciPy 1.17.0 solve_ivp Radau run with exact method, requested times, relative tolerance and absolute tolerance recorded beside the test.',
        'Update the exact native-case count to the verified 81-case campaign only after the new debug and release cases execute successfully.',
      ],
      prevention: [
        'Keep a stable acceptance matrix from plan through implementation and require an evidence locator for every row before completion.',
        'Do not treat order comparison, analytical accuracy, in-repository cross-checking and external-reference provenance as interchangeable evidence.',
        'Pin external numerical references by implementation version, method, tolerance, inputs and requested outputs; label fixed values as reference evidence rather than live dependency execution.',
      ],
      regressionTests: [
        {
          path: 'rust-dae-native/tests/solve_reference.rs',
          assertion: 'The native reference proves three-level tolerance convergence, agrees with independent rust-core Dormand–Prince on the same ODE graph, and checks the stiff Robertson DAE against an explicitly versioned SciPy Radau reference.',
        },
        {
          path: 'tests/root-cause-library.test.mjs',
          assertion: 'The acceptance-drift record and solver guide preserve the original evidence gates, external reference provenance and corrected 81-case campaign count.',
        },
      ],
      affectedSurfaces: ['ci', 'documentation'],
      tags: ['acceptance', 'cross-validation', 'dae', 'evidence', 'solver', 'tolerance'],
      references: [
        {
          kind: 'test',
          locator: 'rust-dae-native/tests/solve_reference.rs',
          note: 'Analytical tolerance-convergence, independent in-repository solver comparison and externally generated SciPy Radau Robertson reference cases.',
        },
        {
          kind: 'documentation',
          locator: 'docs/EQUATION_SOLVER.md',
          note: 'Stable Task 2H acceptance wording, exact evidence provenance and source-only product boundary.',
        },
      ],
    }),
    record({
      id: 'rc-solver-initial-time-contract-drift',
      title: 'Native request time drifts from the lowered DAE initial state',
      symptom: 'IDA can be initialized at a caller-selected time using y and yp that were calculated by the residual system for a different time and possibly a different side of a scheduled source event.',
      evidence: [
        '`DaeResidualSystem::lower` calculates and stores consistent initial y and yp at one exact finite `initialization_time_s` under `battery-design/dae-residual@2`.',
        'The native settings separately carry `initial_time_s`; before the fix, that value could reach `IDAInit` even though the borrowed vectors belonged to the system initialization time.',
        'A mismatch can produce finite solver output while silently seeding the wrong derivative or event side, so later native-time checks cannot reconstruct the lost contract relationship.',
        'IEEE-754 negative and positive zero compare numerically equal and must remain compatible even though the core accessor preserves the original sign bit.',
      ],
      detection: [
        {
          method: 'lowered-system/request time binding regression',
          signal: 'Initialize dense and KLU settings with one genuinely different finite time and with the opposite signed zero, observing allocation counters and the typed result.',
          failureCondition: 'A real mismatch reaches native allocation, the error omits both exact times, or numerically equal negative/positive zero is rejected as drift.',
        },
      ],
      causalChain: [
        'Lowering evaluates graph initial values and derivatives at the system initialization time.',
        'The native adapter accepts a second initial-time field while borrowing those already-computed vectors.',
        'If the two times differ, `IDAInit` labels one state as belonging to another time without recalculating it.',
        'The solver starts from an internally inconsistent temporal contract and may choose the wrong side of time-dependent graph behavior.',
      ],
      rootCause: 'The native request validated each initial time independently but did not bind its `IDAInit` time to the exact time at which the residual system produced the borrowed initial y and yp.',
      resolution: [
        'Store the exact finite lowering time in `DaeResidualSystem` and expose it through `initialization_time_s` as part of `battery-design/dae-residual@2`.',
        'In both dense and KLU request validation, compare settings time numerically with the system time before result allocation, callback construction or any native resource allocation.',
        'Reject a genuine mismatch with `ida.initial_time.system_mismatch` carrying both system and requested times, while accepting `-0.0` and `+0.0` as the same numerical instant.',
        'Coordinate the changed assumption through dense and KLU backend/result `@2` identities rather than silently redefining the historical `@1` contracts.',
      ],
      prevention: [
        'Bind every precomputed initial state to its evaluation time at the API boundary; do not allow downstream solver settings to relabel borrowed state.',
        'Run temporal consistency checks before allocations or FFI so the failure remains deterministic and side-effect free.',
        'Keep a true nonzero mismatch and signed-zero equivalence together whenever lowering or native initialization changes.',
      ],
      regressionTests: [
        {
          path: 'rust-core/tests/dae_contract.rs',
          assertion: 'The lowered system accessor preserves its exact finite initialization time, including the negative-zero sign bit.',
        },
        {
          path: 'tests/root-cause-library.test.mjs',
          assertion: 'The initial-time binding record remains searchable and preserves @2 ownership, pre-allocation mismatch rejection, exact evidence and signed-zero numerical equality.',
        },
      ],
      affectedSurfaces: ['ci', 'documentation'],
      tags: ['contract', 'dae', 'floating-point', 'ida', 'initial-conditions', 'time'],
      references: [
        {
          kind: 'implementation',
          locator: 'rust-core/src/dae.rs',
          note: 'Stored exact finite residual-system initialization time under the DAE residual @2 contract.',
        },
        {
          kind: 'implementation',
          locator: 'rust-dae-native/src/lib.rs',
          note: 'Dense and KLU pre-allocation time binding with typed mismatch evidence.',
        },
        {
          kind: 'test',
          locator: 'rust-core/tests/dae_contract.rs',
          note: 'Exact nonzero and signed-zero initialization-time accessor regressions.',
        },
        {
          kind: 'test',
          locator: 'rust-dae-native/src/native.rs',
          note: 'Embedded mismatch rejection, allocation-audit and signed-zero compatibility regressions.',
        },
        {
          kind: 'test',
          locator: 'tests/root-cause-library.test.mjs',
          note: 'Governed memory assertions for residual-system/native-request time ownership.',
        },
      ],
    }),
    record({
      id: 'rc-solver-sparse-build-provenance-gap',
      title: 'Sparse solver build inherits an ungoverned second source and link surface',
      symptom: 'A build can advertise SUNDIALS IDA with KLU while using an unpinned SuiteSparse tree, system fallback libraries, an incomplete static link, or incomplete license evidence.',
      evidence: [
        'The governed dense IDA source lock covers SUNDIALS, but enabling KLU introduces a second independently versioned SuiteSparse source, five selected components and a different native link surface.',
        'The official SuiteSparse 7.7.0 archive contains ordinary spaces in valid member names, so splitting verbose tar output on whitespace or banning spaces rejects the pinned upstream bytes even though traversal, control characters, links and device entries still must fail closed.',
        'The first curated archive list added standalone nvecserial and sunmatrixsparse archives because the installed CMake package exposes those components, but omit-one direct links still passed: the pinned libsundials_ida.a already embeds the serial-vector and sparse-matrix symbols. Keeping either redundant archive would create a receipt identity that the executable probe could not prove semantically usable.',
        'SUNDIALS derives SUNDIALS_ENABLE_SUNLINSOL_KLU from the requested KLU option and exposes many configure-check toggles, so accepting every enabled suffix or every *_CHECKS key silently broadens the audited configuration.',
        'KLU and BTF are LGPL-2.1-or-later while AMD, COLAMD and SuiteSparse_config are BSD-3-Clause; carrying only the umbrella project label or short component notices omits the full LGPL texts and does not establish static-distribution compliance.',
      ],
      detection: [
        {
          method: 'two-source sparse build and link audit',
          signal: 'Verify both source archives, parse their bounded inventories, configure only the selected components, inspect every generated cache option, publish an exact static surface, and run a real KLU factor and solve.',
          failureCondition: 'The build accepts source or configuration drift, reaches a system KLU/BLAS/CHOLMOD/OpenMP dependency, omits a required static archive or license text, or passes without executing the linked sparse solver.',
        },
      ],
      causalChain: [
        'A previously governed dense native backend adds KLU as an optional linear solver.',
        'The new option brings a separately released SuiteSparse source, generated SUNDIALS modules, transitive serial-vector symbols and component-specific licenses.',
        'If the old one-source receipt or a guessed archive list is reused, the visible backend name no longer identifies what was compiled and linked.',
        'Configuration-only tests can then pass while the actual sparse executable fails to link, falls back to host libraries or lacks the evidence required for distribution review.',
      ],
      rootCause: 'The sparse backend was treated as one more SUNDIALS flag instead of a separate governed two-source build, link, license and runtime-evidence boundary.',
      resolution: [
        'Pin SuiteSparse 7.7.0 and the exact selected SuiteSparse_config 7.7.0, AMD 3.3.2, BTF 2.3.2, COLAMD 3.3.3 and KLU 2.3.3 source and license identities in native-backends/suitesparse/source-lock.json.',
        'Verify the exact 85,876,065-byte archive and its measured inventory while parsing the complete tar path remainder so ordinary spaces remain valid and traversal, absolute paths, controls, backslashes, duplicates, links, devices and expansion excess remain rejected.',
        'Build only the five selected SuiteSparse components with CHOLMOD, BLAS, OpenMP, CUDA, Fortran and system fallbacks disabled; configure SUNDIALS 7.8.0 with KLU checks enabled and audit an exact allowlist of generated enabled options.',
        'Publish a separate canonical battery-design/native-dae-klu-build-receipt@2 that binds both locks, component versions, critical headers, nine exact license/notice files and exactly eight semantically exercised static archives; omit the redundant standalone nvecserial and sunmatrixsparse archives because the pinned IDA archive supplies those symbols for this adapter.',
        'Require the installed-prefix probe and the curated direct-link probe to create the serial vectors and sparse matrix, factor and solve a nonsymmetric system with KLU, construct IDA, verify runtime versions and reject governed dynamic dependencies.',
        'Carry the complete upstream LGPL-2.1 texts for BTF and KLU, but keep the implementation CI-only: hashes and bundled texts do not complete legal review, relinkable-object obligations, source-offer requirements, artifact custody or product-release approval.',
      ],
      prevention: [
        'Treat every optional native solver dependency as a new source, configuration, ABI, link and license boundary rather than extending an old receipt informally.',
        'Derive the accepted archive surface from a successful real link, remove redundant archives that the probe cannot distinguish from empty replacements, and keep the real factor/solve probe mandatory on initial build, reuse and self-consistent archive-tamper tests.',
        'Audit exact generated CMake keys instead of suffix classes, and add a rejection regression whenever a newly observed upstream-derived option is admitted.',
        'Keep the dense build unchanged and keep KLU out of browser, desktop, installer and release surfaces until a separately reviewed LGPL distribution plan and exact artifact campaign exist.',
      ],
      regressionTests: [
        {
          path: 'tests/suitesparse-source-lock.test.mjs',
          assertion: 'The closed SuiteSparse release, selected component versions, archive inventory and exact component license identities reject source, shape, digest, link and schema drift.',
        },
        {
          path: 'tests/sundials-klu-native-build.test.mjs',
          assertion: 'The KLU build contract accepts legitimate spaced archive names but rejects unsafe members, system fallbacks, unrelated enabled checks, receipt drift, missing archives and governed dynamic dependencies.',
        },
        {
          path: 'tools/test-native-dae-klu-build.mjs',
          assertion: 'The reuse campaign rejects lock, receipt, header, license and archive attacks, including self-consistent empty KLU and SUNLINSOL-KLU archives that only the real sparse link can expose.',
        },
        {
          path: 'tests/root-cause-library.test.mjs',
          assertion: 'The sparse two-source provenance cause remains independently searchable and preserves the CI-only and unresolved static-distribution boundary.',
        },
      ],
      affectedSurfaces: ['ci', 'documentation'],
      tags: ['klu', 'license', 'provenance', 'sparse', 'suitesparse', 'sundials'],
      references: [
        {
          kind: 'implementation',
          locator: 'native-backends/suitesparse/source-lock.json',
          note: 'Closed SuiteSparse release, selected-component and license identity.',
        },
        {
          kind: 'implementation',
          locator: 'tools/verify-suitesparse-source.mjs',
          note: 'Closed lock, archive and component-license verifier.',
        },
        {
          kind: 'implementation',
          locator: 'tools/build-sundials-ida-klu.mjs',
          note: 'Two-source bounded build, cache audit, curated @2 receipt and real installed/direct sparse probes.',
        },
        {
          kind: 'test',
          locator: 'tests/suitesparse-source-lock.test.mjs',
          note: 'Official source, component, archive and license identity regressions.',
        },
        {
          kind: 'test',
          locator: 'tests/sundials-klu-native-build.test.mjs',
          note: 'Archive, CMake, receipt, static surface, dynamic dependency and real-link contract regressions.',
        },
        {
          kind: 'test',
          locator: 'tools/test-native-dae-klu-build.mjs',
          note: 'Derived root and executable-link tamper campaign.',
        },
      ],
    }),
    record({
      id: 'rc-solver-sparse-jacobian-pattern-erasure',
      title: 'Sparse Jacobian callback assumes its CSC pattern survives matrix zeroing',
      symptom: 'IDA with KLU can receive an all-zero or malformed CSC structure on a later Jacobian evaluation even though the fixed sparsity pattern was installed when the matrix was created.',
      evidence: [
        'In SUNDIALS 7.8.0, SUNMatZero_Sparse clears the numeric data, row-index array and column-pointer array before IDA invokes the registered Jacobian callback.',
        'Installing the structural pattern only during matrix construction therefore leaves subsequent callbacks without the governed column boundaries and row locations required by KLU.',
        'A repeated-callback regression that deliberately zeros all three native arrays reproduces the boundary and requires every invocation to restore the exact compiled CSC columns, rows and values.',
      ],
      detection: [
        {
          method: 'repeated sparse Jacobian reconstruction test',
          signal: 'Zero the native sparse data, row indices and column pointers before each of two or more callback invocations, then compare all three arrays with the compiled DAE pattern and analytic values.',
          failureCondition: 'Any invocation preserves zeros, restores only numeric values, changes the sorted unique structure, or constructs Rust slices before validating native type, shape, pointers and alias boundaries.',
        },
      ],
      causalChain: [
        'The DAE lowering produces a deterministic fixed CSC sparsity pattern and the native KLU matrix is initialized with that pattern.',
        'IDA clears the sparse matrix before a later Jacobian callback, including its structural index arrays.',
        'A callback that writes only Jacobian values assumes the structure remains resident and hands KLU erased or invalid column and row metadata.',
        'Sparse factorization can then fail or operate on a matrix different from the governed residual Jacobian.',
      ],
      rootCause: 'The sparse adapter treated CSC structure as construction-time state even though the native matrix-zero operation erases both structure and values at the callback boundary.',
      resolution: [
        'Validate the native matrix type, dimensions, nonzero capacity, pointers, checked byte ranges and disjointness from y, yp and residual before constructing any Rust slice.',
        'On every successful sparse Jacobian callback, copy the complete compiled column-pointer and row-index arrays into the native matrix before copying freshly evaluated numeric values.',
        'Require a structural diagonal in every column before native allocation and preserve callback-first typed errors when validation or Jacobian evaluation fails.',
        'Exercise more than one real KLU Jacobian setup so the source-reference solve proves that repeated native zero-and-rebuild cycles remain executable.',
      ],
      prevention: [
        'Audit destructive semantics of every third-party matrix lifecycle operation instead of assuming a fixed-pattern sparse container preserves indices.',
        'Test callbacks against deliberately erased and malformed native views, including aliasing, wrong matrix type, null pointers and inconsistent CSC lengths.',
        'Keep the compiled DAE pattern as the sole source of truth and never infer restored structure from mutable native storage.',
      ],
      regressionTests: [
        {
          path: 'rust-dae-native/tests/klu_solve_reference.rs',
          assertion: 'A real KLU solve performs repeated Jacobian setups and remains accurate, proving that every native zero-and-rebuild cycle receives a complete CSC pattern and values.',
        },
        {
          path: 'rust-dae-native/tests/klu_backend_identity.rs',
          assertion: 'The KLU admission campaign preserves exact sorted unique CSC structure, structural diagonals and bounded known storage at 1,000 and 10,000 variables.',
        },
        {
          path: 'tests/root-cause-library.test.mjs',
          assertion: 'The sparse pattern-erasure cause remains searchable and bound to full per-callback structure restoration and pre-slice native-view validation.',
        },
      ],
      affectedSurfaces: ['ci', 'documentation'],
      tags: ['callback', 'csc', 'jacobian', 'klu', 'sparse', 'sundials'],
      references: [
        {
          kind: 'implementation',
          locator: 'rust-dae-native/src/native.rs',
          note: 'Validated sparse callback that restores column pointers, row indices and values on every invocation.',
        },
        {
          kind: 'test',
          locator: 'rust-dae-native/tests/klu_solve_reference.rs',
          note: 'Repeated sparse Jacobian setup, numerical reference, failure and lifecycle regressions.',
        },
        {
          kind: 'test',
          locator: 'rust-dae-native/tests/klu_backend_identity.rs',
          note: 'CSC identity, scale, structural and work-admission regressions.',
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
      id: 'rc-test-multiplier-denominator-drift',
      revision: 3,
      title: 'Test-count delta is mistaken for a promised coverage multiplier',
      symptom: 'A delivery reports that testing doubled because 91 top-level tests were added after a convenient checkpoint, even though the promised two-times comparison was against Action 1 and no stable denominator or identical counting population was recorded.',
      evidence: [
        'A count of tests newly added since a commit is a delta, while a two-times claim is a ratio that requires a named baseline population and denominator.',
        'Changing file globs, counting declarations instead of executed cases, or including different repository populations on only one side can change the apparent ratio without adding coverage.',
        'Action-focused and repository-global totals answer different questions; presenting either as the other hides whether the requested action itself received the promised depth.',
        'Using one exact repository-global top-level declaration count, pre-Action 1 commit 66f7240 had 708 tests and post-Action 1 commit 4da8c03 had 758, making the Action 1 denominator increase exactly 50.',
        'The 6094b3b checkpoint had 824 tests; the 91-test checkpoint delta was substantial but still only 91/50, while the corrected Action 2 tree must reach at least 858 total declarations for an increase of at least 100 over 4da8c03.',
        'For DAE Iteration 3, merged Iteration 2 SHA 9f4a43421de34efd067d38a070a0f2c4b9a859dc contains exactly 81 unique Cargo test function names across native.rs, feature_off.rs, backend_identity.rs and solve_reference.rs in a 67+1+2+11 population.',
        'Sorting those 81 names and applying the case-sensitive (csc|jacobian|matrix|sparse|linear_solver|resource|construction|drop|backend) filter produces the exact frozen 21-name sparse-readiness denominator; 48 new manifest-listed KLU cases therefore clear the 42-case floor at 2.29 times the proxy.',
        'PR 79 CI run 31233721450 exposed a different form of denominator drift: an Iteration 3 evidence test expected the current source to contain only its six historical KLU internal seams, so six later event/restart seams changed the live total to 12 and failed an otherwise preserved historical claim.',
      ],
      detection: [
        {
          method: 'reproducible test-population audit',
          signal: 'At each pinned revision run `rg -n "^test\\(" tests --glob "*.test.mjs" | wc -l`, label the result repository-global top-level test declarations, and subtract the same 4da8c03 population.',
          failureCondition: 'A multiplier is claimed without the 50-test Action 1 denominator and pinned revisions/command, a different population is used on either side, or the corrected Action 2 tree contains fewer than 858 declarations.',
        },
        {
          method: 'frozen DAE sparse-readiness name audit',
          signal: 'At 9f4a43421de34efd067d38a070a0f2c4b9a859dc extract every Cargo #[test] function name from the four declared Rust sources, require the 67+1+2+11 population, sort it and apply the exact case-sensitive sparse-readiness regular expression.',
          failureCondition: 'The population is not 81 unique names, the filter or case sensitivity changes, the frozen matching list is not exactly 21 names, or the 48-case numerator includes the six separately reported internal seam tests.',
        },
      ],
      causalChain: [
        'A request asks for twice the tests as complexity increases.',
        'Implementation adds many tests and reports the number added since a convenient commit.',
        'The delta is compared informally with an unstated memory of earlier coverage rather than a measured Action 1 denominator.',
        'A large but non-comparable number is promoted into a fulfilled multiplier claim and the shortfall appears only during final audit.',
      ],
      rootCause: 'The quality promise did not pin its comparison population, base revision and counting procedure before implementation, so a commit delta, an action-focused total and a repository-global total became interchangeable.',
      resolution: [
        'Pin pre-Action 1 commit 66f7240 at 708 declarations and post-Action 1 commit 4da8c03 at 758 declarations, establishing the exact repository-global Action 1 increase of 50.',
        'Use `rg -n "^test\\(" tests --glob "*.test.mjs" | wc -l` unchanged at every revision; this counts top-level test declarations, not runtime pass/skip events or action-only cases.',
        'Retain 6094b3b at 824 only as an intermediate Action 2 checkpoint, never as the Action 1 denominator.',
        'Label the comparison repository-global, state the 50-test denominator beside the multiplier, and require the current Action 2 tree to reach at least 858 declarations for a numerator increase of at least 100.',
        'For DAE Iteration 3 pin merged Iteration 2 SHA 9f4a43421de34efd067d38a070a0f2c4b9a859dc and the exact four-file Cargo test population: 67 native.rs, one feature_off.rs, two backend_identity.rs and 11 solve_reference.rs names.',
        'Freeze the sorted 81-name population, exact case-sensitive (csc|jacobian|matrix|sparse|linear_solver|resource|construction|drop|backend) filter and resulting 21 matching names in tests/dae-iteration3-evidence.test.mjs; compare only the 48 manifest-listed KLU cases against that denominator, yielding floor 42 and ratio 2.29.',
        'Verify historical retention by the frozen case names themselves; report later KLU-gated internal seams as a separate current population instead of requiring the live feature-gated count to remain equal to the historical six.',
      ],
      prevention: [
        'Turn qualitative test multipliers into a predeclared measurement note before coding: both boundary commits, denominator, exact command and whether declarations or runtime results are counted.',
        'Report raw revision counts and their subtraction with the ratio so reviewers can reproduce the claim without inferring what was counted.',
        'Keep global regression health separate from action-specific adversarial depth; both are valuable and neither substitutes for the other.',
        'For name-filtered focused proxies, freeze the complete source population and exact matching list beside the filter; a revision SHA or denominator alone is not reproducible when Git history is unavailable at runtime.',
        'Keep manifest-listed integration cases, internal unit seams and retained prior campaigns as separately reported populations instead of moving cases between numerator and denominator.',
      ],
      regressionTests: [
        {
          path: 'tests/dae-iteration3-evidence.test.mjs',
          assertion: 'The DAE Iteration 3 multiplier pins the merged baseline SHA, four-file 81-name population, exact case-sensitive filter, sorted 21 matches, 42-case floor and 48-case 2.29-times numerator without runtime Git access.',
        },
        {
          path: 'tests/root-cause-library.test.mjs',
          assertion: 'The revision-3 denominator-drift record remains searchable and preserves the repository-global correction, frozen DAE comparison and historical-name versus live-count distinction.',
        },
      ],
      affectedSurfaces: ['ci', 'documentation'],
      tags: ['audit', 'metrics', 'quality', 'testing'],
      references: [
        {
          kind: 'commit',
          locator: '66f7240',
          note: 'Pinned pre-Action 1 revision with 708 repository-global top-level test declarations.',
        },
        {
          kind: 'commit',
          locator: '4da8c03',
          note: 'Pinned post-Action 1 revision with 758 declarations and the 50-test denominator.',
        },
        {
          kind: 'commit',
          locator: '6094b3bd5e5afbb3069fd9ba8a7c5d1558600d6f',
          note: 'Intermediate Action 2 checkpoint with 824 declarations; not the Action 1 denominator.',
        },
        {
          kind: 'commit',
          locator: '9f4a43421de34efd067d38a070a0f2c4b9a859dc',
          note: 'Merged Iteration 2 baseline containing the frozen four-file population of 81 unique native Cargo test function names.',
        },
        {
          kind: 'test',
          locator: 'tests/dae-iteration3-evidence.test.mjs',
          note: 'Self-contained exact baseline population, case-sensitive proxy filter, 21 matching names, 48-case numerator and name-based historical retention accounting.',
        },
        {
          kind: 'incident',
          locator: 'GitHub Actions run 31233721450 job 93042358098',
          note: 'PR 79 exact-head Node gate where six later KLU event seams invalidated a live-count assertion for an otherwise frozen Iteration 3 population.',
        },
        {
          kind: 'test',
          locator: 'tests/ecm-tuning-plan.test.mjs',
          note: 'Action 2 planning and experiment-governance cases in the focused population.',
        },
        {
          kind: 'test',
          locator: 'tests/ecm-tuning.test.mjs',
          note: 'Action 2 bounded-execution and holdout cases in the focused population.',
        },
        {
          kind: 'test',
          locator: 'tests/ecm-tuning-surfaces.test.mjs',
          note: 'Action 2 CLI/local-API contract cases in the focused population.',
        },
        {
          kind: 'test',
          locator: 'tests/packaged-tree.test.mjs',
          note: 'Isolated staged-package execution cases in the focused population.',
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
