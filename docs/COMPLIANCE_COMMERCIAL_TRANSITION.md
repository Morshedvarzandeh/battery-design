# System compliance and commercial transition

This document is the governed roadmap for moving `battery-design` from
engineering screening toward evidence-backed product use. It records the
state of the public `main` tree at
`032638ba3ee2b7d6cd2ec730b529a63a96ca3ffb` (8 August 2026). Draft pull
requests and unmerged branches are outside this baseline.

It is not a certificate, declaration of conformity, legal opinion, laboratory
report, or type approval. A software result may close a **software gate**; it
cannot close a supplier, metrology, physical-test, FEA, accredited-laboratory,
notified-body, or approval-authority gate.

## Status vocabulary

- **Tested** — executable implementation with focused automated tests, within
  the boundary stated here.
- **Partial** — a narrower calculation or check exists, but the complete claim
  does not.
- **Contract only** — a schema, checklist, or mapping exists without the
  requested execution or evidence.
- **Not implemented** — no repository implementation was found.
- **External evidence** — the software may organize evidence, but a competent
  external activity must produce it.
- **Blocked** — a prerequisite must be resolved before work may proceed.

## 1. Mechanical and packaging verification

| Gate | Current state | Evidence boundary | Next independently testable task |
|---|---|---|---|
| Validate cylindrical, prismatic, and pouch dimensions | **Tested** | `js/cells.js` and `tools/validate.mjs` validate nominal schemas and plausible values; this is not supplier metrology or tolerance inspection. | Add tolerance/source fields and reject an untraceable dimension set. |
| Run custom-envelope packing intersections | **Partial** | `js/bay.js` has tested 2D polygon/footprint and layered-Z packing. There is no arbitrary 3D solid/mesh or internal-obstacle collision engine. | Define a closed 3D envelope/obstacle contract before claiming 3D intersection. |
| Calculate gravimetric and volumetric packaging efficiencies | **Partial** | `js/pack-engine.js` calculates packing efficiency, Wh/kg, and Wh/L. Some component masses remain estimates; an explicit cell-mass/total-pack-mass ratio is absent. | Add a provenance-aware mass efficiency with uncertainty/unknown handling. |
| Audit pouch swell-face compression | **Partial** | `js/engineering.js` provides a heuristic warning only; it does not calculate preload, force-deflection, swell, or end-plate stress. | First fix the `compression-foam` kind mismatch, then add a declared pressure-window contract. |
| Verify adjacent-cell mechanical isolation | **Partial** | Geometry enforces spacing and thermal-propagation heuristics. It does not resolve tolerance stack-up, abrasion, shock, or deflection. | Add worst-case tolerance and deflection inputs to the non-overlap gate. |
| Audit module and enclosure structural clearances | **Not implemented** | Cell spacing, layer gap, walls, and headroom exist; module-to-module and module-to-enclosure structural clearance do not. | Define module envelopes, mounting features, and load-case clearance outputs. |

## 2. Thermal and fluid-dynamics auditing

| Gate | Current state | Evidence boundary | Next independently testable task |
|---|---|---|---|
| Run Level-1 lumped thermal simulations over custom cycles | **Tested** | `js/sim1d.js` runs one lumped temperature with class/default resistance; it is not spatial thermal analysis. | Add a measured-reference regression without changing the Level-1 claim. |
| Map Level-2 ECM dynamic heat generation | **Tested** | `js/sim2.js` includes R0/RC irreversible heat, reversible heat, and module thermal states; it is not electrochemistry or CFD. | Preserve exact energy/heat balance against an independent reference trace. |
| Calculate continuous busbar I²R loss | **Tested** | `js/wiring.js` includes temperature-dependent resistance, voltage drop, and steady-state heat balance. Real routes and joints remain inputs/evidence. | Bind supplier conductor/joint evidence to one governed wiring case. |
| Evaluate reversible entropic heat against SOC curves | **Partial** | The Level-2 model uses one scalar `entropyVK`; it does not use a temperature-coefficient curve versus SOC. | Add a bounded, interpolated `dU/dT(SOC)` dataset with sign-convention tests. |
| Solve 1D mass flow with ε-NTU | **Partial** | `js/btms.js` sizes flow by `Q/(cp·ΔT)` and `js/sim2.js` evaluates ε-NTU at a supplied flow. No inverse ε-NTU flow solver exists. | Solve required flow against a declared heat-duty/outlet-temperature target. |
| Audit runaway propagation barriers | **Tested** | `js/runaway.js` compares conduction/radiation/interconnect cases. It explicitly excludes hot gas, flame, electrolyte, and ejecta and never clears a design as safe. | Add a physical-test evidence contract; retain the never-certify boundary. |

## 3. Electrical integrity and safe bounds

| Gate | Current state | Evidence boundary | Next independently testable task |
|---|---|---|---|
| Evaluate HV creepage and clearance | **Partial** | `js/engineering.js` uses fixed IEC 60664-1-oriented rules of thumb, not the standard's complete table logic. CTI, altitude, impulse, coating, and path geometry are absent. | Define the required insulation-coordination inputs without copying licensed standard text. |
| Audit busbar cross-section against continuous current | **Tested** | `js/wiring.js` solves a steady-state conductor section and `js/engineering.js` checks utilization. Routing and joint qualification remain external. | Add a governed transient/current-duty trace separately. |
| Map contactor and precharge timing | **Tested** | `js/electrical-protection.js` models RC timing, tolerances, repetition, and supplier screens. Production closing must use measured DC-link voltage, not timer-only logic. | Add a state-machine contract with measured-voltage close criteria and faults. |
| Validate NTC sensor budgets and placement | **Partial** | `js/sensors.js` budgets sensors per module. It has no coordinate-level hotspot optimizer or placement marker output. | Add module coordinates and a deterministic coverage objective. |
| Verify CAN, SAE J1939, and NMEA 2000 topology/schema | **Contract only** | `js/architecture.js` selects protocol families by application. It does not validate DBC/PGN/SPN data, identifiers, termination, bitrate, addressing, or bus load. | Start with one closed CAN physical-topology and load-budget contract. |
| Ingest lab telemetry and calibrate ECM parameters | **Partial** | Governed import, dataset, calibration, and staged tuning exist in source CLI/local API. Current evidence is synthetic and no physical-lab dataset proves accuracy. | Ingest one rights-cleared lab dataset with separate calibration and validation trials. |

## 4. Safety and pressure-relief boundaries

`js/venting.js` is a compressible-flow **screen**, not CFD, a deflagration
solver, an explosion model, or a pressure-vessel approval tool.

| Gate | Current state | Evidence boundary | Next independently testable task |
|---|---|---|---|
| Calculate gas-release flow | **Partial** | Isentropic choked/subcritical mass flux is implemented. There is no velocity field or gas-generation prediction. | Rename customer claims to compressible-flow screening and add mixture-property inputs. |
| Calculate peak flow through a burst device | **Partial** | The high case uses declared gas mass divided by minimum duration: a scenario-average source flow, not a predicted transient peak through an actuating disc. | Add a time-resolved source/valve model only after measured input data exists. |
| Predict enclosure pressure-rise kinetics | **Not implemented** | Allowable pressure is an input; there is no pressure-time solution. | Define a bounded control-volume model and validation dataset. |
| Match burst threshold to gas spikes | **Partial** | `js/vent-layout.js` checks static opening-pressure headroom and temperature rating. It has no spike, inertia, or opening dynamics. | Add supplier opening curves and a transient pressure source. |
| Flag the structural/FEA sign-off boundary | **Tested** | `js/vent-layout.js` returns an advisory structural, CAD, and pressure-test approval checklist. It neither accepts evidence nor blocks execution, performs no FEA, and provides no liability shield. | Keep the advisory boundary visible in every report/API surface, then define a separate evidence-acceptance gate. |

## 5. Global regulatory and market standards

These are applicability and design-review screens. Only the competent test,
conformity-assessment, notified, certification, or approval body can close the
corresponding external gate.

| Gate | Current state | Evidence boundary | Next independently testable task |
|---|---|---|---|
| UN Manual of Tests and Criteria, 38.3 | **Partial + external evidence** | The repository maps the requirement and has a T5-style external-short screen, not a full current T1–T8 protocol or report. | Add an evidence manifest for each applicable test and current manual revision. |
| UN Regulation No. 100, Revision 3 | **Partial + external evidence** | Topology-specific isolation logic exists; the complete REESS/type-approval programme does not. | Build a clause-to-evidence matrix without claiming approval. |
| UL 2580 and UL 1973 | **Contract only + external evidence** | Descriptive applicability entries exist; there is no clause-level evaluator or accredited evidence. | Separate vehicle and stationary scopes and record licensed-standard review evidence. |
| China requirements and MIIT catalogue practice | **Partial + external evidence** | A China e-bus chemistry blocker and GB 38031 note exist. There is no live catalogue ingestion or general structural gate. | Name the exact current GB/GB-T requirement and snapshot the applicable catalogue evidence. |

## 6. EU Battery Passport and sustainability

Regulation (EU) 2023/1542 must be evaluated from the consolidated law and
applicable delegated/implementing acts. A nominal date is not sufficient where
the Regulation says "whichever is later". Regulation (EU) 2025/1561 moved the
battery due-diligence application date to 18 August 2027. The Article 77
battery-passport date remains 18 February 2027 for LMT batteries, EV batteries,
and industrial batteries above 2 kWh.

| Gate | Current state | Evidence boundary | Next independently testable task |
|---|---|---|---|
| Log carbon-footprint declaration/performance gates | **Partial** | `js/eurules.js` contains static milestone text and `js/lca.js` is explicitly a screening estimate. There is no audited declaration or numeric performance-class engine. | Replace unconditional carbon dates with act-aware effective-date records. |
| Check recycled-content thresholds | **Partial** | Chemistry-aware 2031/2036 messages exist. Component/supplier records do not carry actual verified recycled-content fractions. | Define a provenance-bearing material-content record and calculation. |
| Validate Battery Passport metadata | **Contract only** | The ontology maps applicability and SoH access. There is no Article 77/Annex XIII payload, QR identifier, access-control, supply-chain, or interoperability validator. | Define a versioned passport payload contract against official requirements. |
| Monitor rolling legal gates | **Partial** | Passport applicability is date-evaluated; other milestones are static text and there is no Official Journal update process. | Create a cited legal-source registry with `adopted`, `effective`, `dependent-act-pending`, and `superseded` states. |

## 7. Interface, HIL, and telemetry validation

| Gate | Current state | Evidence boundary | Next independently testable task |
|---|---|---|---|
| Execute SIL timing with the Rust core | **Partial** | The generic SIL runner is adapter-neutral; the Co-simulation Studio path uses Rust/Wasm. Existing checks cover identity, units, ranges, and repeatability, not deadline, latency, or jitter. | Add monotonic-clock timing evidence with declared platform, adapter, and sample budget. |
| Ingest real execution telemetry | **Partial** | `js/loop-testing.js` evaluates pre-shaped HIL evidence. There is no raw CSV/binary parser, target adapter, custody, signature, or provenance authentication. | Define one bounded, signed canonical telemetry import. |
| Cross-examine physical logs and the digital twin | **Tested** | The tested boundary is marine replay: `js/marine-workspace.js` recomputes aligned speed/course/power residuals and energy. It does not run/align the model or authenticate evidence. | Generalize the content-addressed replay contract beyond marine without weakening provenance. |
| Expose layout and cell variables through MCP | **Tested** | `desktop/mcp-server.mjs` exposes structured static/reduced-model design facts. It does not expose live telemetry or every cell coordinate. | Add only versioned, bounded surfaces with explicit confidentiality labels. |

## 8. Public rights baseline and contribution governance — now

- [x] Retain AGPL-3.0-or-later for the current public tree and describe it as
  source-sharing copyleft, not a prohibition on commercial use.
- [x] Record the root license change authored at `0b119d7` and merged onto
  public `main` at `201baec`.
- [x] Start the contributor, AI-output, dependency, asset, and notice inventory
  in `RIGHTS_PROVENANCE_BASELINE.md`.
- [x] Add a prospective inbound-AGPL and authority declaration to the
  pull-request workflow. It records the public license and provenance evidence;
  it is not a CLA, assignment, or proprietary/dual-license grant.
- [ ] Resolve the legal entity, governing law, privacy/retention process, and
  counsel-approved Individual/Corporate CLA text.
- [ ] Configure CLA Assistant as a required check for future pull requests only
  after that agreement is approved.
- [ ] Review historical external contributions separately. A later CLA check
  cannot retroactively bind an earlier contributor.
- [x] Task 8A removed no existing license or notice.
- [ ] Verify the complete source, build, and release notice set at the exact
  Community Edition release commit.

AGPL permits commercial activity. Its relevant protection is reciprocal source
availability when covered software is conveyed and, for modified network
software, the Section 13 source offer. Contents distributed in root snapshots
from `0302750` through `5c7a317` remain available under the perpetual
Apache-2.0 grants made for those snapshots. Earlier snapshots require separate
path-level review because no root license file was observed there.

## 9. Private repository transition — blocked until rights clearance

- [ ] Publish an immutable, evidence-backed Community Edition release from an
  approved commit, including checksums, changelog, and SBOM.
- [ ] Use `v1.0.0` with release title **Community Edition**, or use a tag such as
  `community-v1.0.0`. Under SemVer, `v1.0.0-community` is a pre-release, not a
  final release.
- [ ] Freeze the release. Archive the whole public repository only if public
  maintenance is genuinely ending; a tag alone does not freeze a repository.
- [ ] Create a standalone organization-owned private repository after the
  organization and access model exist. A GitHub fork of a public repository
  cannot be made private.
- [ ] Choose either a rights-cleared full-history mirror or a separately
  versioned public component pinned to an exact release. Do not duplicate the
  same source both ways without a defined ownership model.
- [ ] Treat a submodule as a versioning boundary, never as an AGPL or copyright
  firewall.
- [ ] Apply least privilege, protected branches/tags, required reviews, secure
  2FA, controlled deploy credentials, and offboarding.
- [ ] Use IP allowlisting only on a GitHub plan and network/runner design that
  supports it, with a tested recovery path.

## 10. Commercial license and EULA — proprietary files only

- [ ] Retain every third-party license and notice whenever its terms require it,
  even when that license permits use inside a proprietary product.
- [ ] Replace the root AGPL notice only in a separately licensed copy after
  complete chain-of-title clearance and exclusion of material available only
  under AGPL; leave the public AGPL tree unchanged.
- [ ] Have counsel draft a commercial agreement that expressly excludes open-
  source components governed by their own licenses.
- [ ] Define users, sites, instances, nodes, environments, and cluster limits
  precisely and bind entitlements to the accepted agreement version.
- [ ] Qualify reverse-engineering and benchmarking clauses by jurisdiction and
  preserve mandatory interoperability, observation/testing, security,
  regulatory, audit, and disclosure rights.
- [ ] Apply proprietary headers and an SPDX `LicenseRef-...` only to files
  verified as wholly proprietary.
- [ ] Maintain the commercial agreement, `LICENSES/`, third-party notices, and
  SBOM separately. Merely committing `LICENSE.md` does not prove customer
  assent.
- [ ] Protect confidential material through access controls, NDAs, encryption,
  logging, device controls, and offboarding; a header alone is insufficient.

## Work order

Items 1 through 4 below are each a separate branch, commit, exact-SHA CI gate,
and review:

1. **8A — rights and provenance baseline** (this document set; no relicensing).
2. **1A — repair pouch compression-foam classification** with a regression test.
3. **6A — make EU carbon/due-diligence dates act-aware** using official sources.
4. **3A — add a measured-voltage precharge state-machine contract**.
5. Continue the existing DAE/HIL campaigns without mixing their commits into
   compliance-governance changes.

CLA deployment is the next legal action only after the project has a named legal
counterparty and approved agreement. The private transition remains blocked
until every file selected for it is cleared in the rights inventory.

## Primary legal and platform references

- [Regulation (EU) 2023/1542](https://eur-lex.europa.eu/eli/reg/2023/1542/oj/eng)
- [Regulation (EU) 2025/1561 postponing battery due diligence](https://eur-lex.europa.eu/eli/reg/2025/1561/oj/eng)
- [UNECE Manual of Tests and Criteria, Revision 8 and Amendment 1](https://unece.org/transport/standards/transport/dangerous-goods/un-manual-tests-and-criteria-rev8-2023)
- [UN Regulation No. 100, Revision 3](https://unece.org/transport/documents/2022/03/standards/regulation-no-100-rev3)
- [GitHub fork visibility](https://docs.github.com/en/pull-requests/reference/forks)
- [GitHub immutable releases](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases)
- [GitHub repository archiving](https://docs.github.com/en/repositories/archiving-a-github-repository/archiving-repositories)
- [GitHub organization IP allowlists](https://docs.github.com/en/enterprise-cloud@latest/organizations/keeping-your-organization-secure/managing-security-settings-for-your-organization/managing-allowed-ip-addresses-for-your-organization)
- [Semantic Versioning 2.0.0](https://semver.org/)
- [Directive 2009/24/EC on the legal protection of computer programs](https://eur-lex.europa.eu/eli/dir/2009/24/oj/eng)
