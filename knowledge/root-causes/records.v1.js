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
