# Rights and provenance baseline

**Audit scope:** public `main` at
`032638ba3ee2b7d6cd2ec730b529a63a96ca3ffb`, reviewed 8 August 2026.

**Purpose:** identify what must be resolved before any proprietary fork,
dual-license offer, commercial EULA, or CLA enforcement is claimed. This is an
engineering provenance record, not a legal opinion or a representation that
copyright subsists in every AI-assisted output.

## Independent classification axes

Ownership, license, and selection are separate questions. For example, a file
can be `OWNED` by its author and distributed publicly under AGPL, or it can be
third-party material used through an `EXPRESS_GRANT` without being owned by the
future commercial licensor.

### Chain-of-title or rights basis

| Status | Meaning |
|---|---|
| `OWNED` | The intended commercial licensor has documented ownership and authority for the planned licensing. |
| `EXPRESS_GRANT` | A rightsholder or authorized licensor has documented a grant sufficient for the planned use. This is not ownership unless the instrument is an assignment. |
| `UNRESOLVED` | Authorship, ownership, authority, source, or grant evidence is incomplete. |

### Applicable licenses and notices

Record every license that applies at the exact commit and path, including
historical outbound licenses and third-party licenses. This axis uses exact
identifiers and notice obligations, such as Apache-2.0, AGPL-3.0-or-later,
BSD-3-Clause, BSD-2-Clause, or MIT; it is not an ownership classification.

### Commercial selection

| Status | Meaning |
|---|---|
| `CLEARED` | Evidence supports the selected use, subject to all recorded license and notice conditions. |
| `EXCLUDED` | The item is deliberately omitted from the proprietary selection. |
| `BLOCKED` | Evidence or compatibility review is incomplete; do not cross the proprietary boundary. |

Only a path with a documented `OWNED` or sufficient `EXPRESS_GRANT` rights
basis, an exact applicable-license/notice record, and a `CLEARED` selection may
enter a future proprietary tree. Public-license status neither proves nor
disproves chain of title.

## License chronology

| Boundary | Observed root-license evidence | Chain-of-title status | Applicable license evidence | Commercial selection |
|---|---|---|---|---|
| `29cba0e` through the parent of `0302750` | No root `LICENSE` or `NOTICE` file was observed in these historical snapshots. | `UNRESOLVED` | Determine path by path; do not infer a license from later commits. | `BLOCKED` |
| Apache snapshots `0302750` through `5c7a317` | Root Apache-2.0 license and notice were present. | `UNRESOLVED` for the future licensor | Contents distributed in these snapshots retain the Apache-2.0 grants made to recipients, subject to path-level licenses and notices. | `BLOCKED` pending chain-of-title and exact-path review |
| License-change commit `0b119d7`, merged onto public `main` at `201baec`, and later root tree | Root changed to AGPL-3.0-or-later in PR #56. | `UNRESOLVED` unless ownership or a separate sufficient grant is documented | Current root outbound license is AGPL-3.0-or-later, subject to path-level licenses. | `BLOCKED` unless separately cleared; an AGPL-covered path may instead be `EXCLUDED` |

This chronology does not prove that every path in a commit had only the root
license. Path-level licenses and notices take precedence for their material.

## Git identities observed

`git shortlog -sne 032638ba3ee2b7d6cd2ec730b529a63a96ca3ffb` reports:

| Identity | Commits | Chain-of-title status | Applicable license evidence | Commercial selection | Missing evidence |
|---|---:|---|---|---|---|
| Morshed Varzandeh `<129369634+Morshedvarzandeh@users.noreply.github.com>` | 125 | `UNRESOLVED` | Root/path license chronology applies at each contribution commit. | `BLOCKED` | Confirm personal/company ownership, employer/contractor obligations, copied-source review, and authority of the future commercial licensor. |
| Claude `<noreply@anthropic.com>` | 69 | `UNRESOLVED` | Root/path license chronology applies at each contribution commit. | `BLOCKED` | Preserve the service, account type, applicable terms version, prompts/source inputs, and third-party provenance for material generated in each work period. AI authorship labels and provider terms do not prove copyrightability or clear copied material. |

Many commit bodies also contain Claude co-author trailers. No other human Git
author appears in the audited local history. That is not proof that there were
no other contributors: merged-PR actors, squash/rebase provenance, issue or chat
submissions, copied snippets, employer rights, generated assets, and unmerged
branches still need review.

## Separately licensed and third-party material already visible

| Material/path | Rights basis | Applicable license/notice evidence | Commercial selection | Required action |
|---|---|---|---|---|
| `native-backends/sundials/` | `EXPRESS_GRANT` from upstream rightsholders through the observed license; ownership is not claimed | SUNDIALS source lock and BSD-3-Clause `LICENSE`/`NOTICE` | `BLOCKED` pending release-specific distribution review | Preserve license/notice, source identity, build receipt, and distribution obligations. Review static-link distribution separately before release. |
| `native-backends/suitesparse/` | `EXPRESS_GRANT` from upstream rightsholders through the observed licenses; ownership is not claimed | SuiteSparse 7.7.0 source lock; BSD-3-Clause for SuiteSparse_config, AMD, and COLAMD; LGPL-2.1-or-later for BTF and KLU | `BLOCKED` pending release-specific static-distribution and license-compliance review | Preserve every component license and complete LGPL text, exact source identity, curated-archive receipt, and all applicable distribution obligations. Private-repository status alone does not change the license conditions. |
| `third_party/fmi-2.0.5/` | `EXPRESS_GRANT` from upstream rightsholders through the observed license; ownership is not claimed | FMI 2.0.5 BSD-2-Clause text and checksums | `BLOCKED` pending release-specific distribution review | Preserve the BSD text and provenance in every distribution containing it. |
| `vendor/three.module.min.js`, `vendor/OrbitControls.js` | `EXPRESS_GRANT` from upstream rightsholders through the observed license; ownership is not claimed | `vendor/THREE-LICENSE` | `BLOCKED` pending exact upstream/version review | Preserve the applicable notice and exact upstream/version evidence. |
| `assets3d/` | `UNRESOLVED` | Separate MIT license; repository documentation identifies original visual assets | `BLOCKED` | Confirm every mesh/primitive/texture is original or separately cleared; then retain the MIT license where distributed. |
| `garage3d/` | `UNRESOLVED` | Godot project and engine-related notices in repository/release material | `BLOCKED` | Inventory engine/runtime, fonts, icons, templates, and export artifacts at the exact shipped version. |
| Papers, standards, datasheets, supplier figures, profiles, and reference-derived constants | `UNRESOLVED` | `REFERENCES.md`, source notes, and model assumptions | `BLOCKED` | Distinguish facts/methods from copied expression, record permissions and extraction provenance, and never redistribute licensed standards text without authority. |

The existing list is a baseline, not a complete SBOM or copyright bill of
materials. Branches, release artifacts, package-manager dependencies, media,
fonts, generated reports, models, datasets, and future additions remain in
scope for the complete inventory.

## CLA readiness gate

CLA Assistant records assent to the agreement supplied by the project. It does
not create a legal entity, choose the governing law, transfer ownership by
itself, or retroactively bind old contributors.

Before enabling it as a required check:

- [ ] Identify the exact individual or company that will be the contracting
  party and commercial licensor.
- [ ] Obtain counsel-approved Individual and, where needed, Corporate forms.
- [ ] Decide whether the agreement is a non-exclusive CLA or a copyright
  assignment agreement; describe ownership accurately.
- [ ] Include copyright and patent grants, contributor/employer authority,
  outbound/dual-license rights, moral-rights treatment where lawful, governing
  law, privacy, retention, and withdrawal/error-correction procedures.
- [ ] Define which repositories, paths, contribution types, bots, and accounts
  the agreement covers.
- [ ] Configure the exact approved text in CLA Assistant and require its status
  check before future external merges.
- [ ] Seek separate retrospective assent from any historical external
  rightsholder. If it is not obtained, record the applicable public license and
  mark the commercial selection `EXCLUDED` or `BLOCKED`; exclude or
  independently rewrite the material for proprietary use.

## Immediate contribution policy

Until the CLA gate above is active, a pull-request declaration may record a
submitter's rights representation and disclose third-party material, but it is
not a substitute for the planned agreement. Maintainers must not interpret a
checkbox, GitHub account, commit signature, AGPL contribution, or AI label as a
copyright assignment or proprietary dual-license grant. Unless a separate
signed agreement applies, submission does not transfer ownership. To the extent
the submitter or an identified rightsholder controls the necessary rights, the
submitter represents authority to license the contribution to the public
project under AGPL-3.0-or-later. Disclosed third-party material remains governed
by its own terms. A copyrightable contribution without documented proprietary-
license authority must remain unmerged or be recorded as public-license-only in
this baseline (or its successor exact-path bill of materials) and excluded from
a future proprietary baseline.

## Exit criteria for Task 8A

- [x] Record the root-license chronology and irrevocable Apache baseline.
- [x] Enumerate Git author identities visible in the audited history.
- [x] Seed the separately licensed/third-party path inventory.
- [x] Define independent chain-of-title, applicable-license, and commercial-
  selection axes with a fail-closed rule.
- [x] State the limits of prospective CLA automation and retrospective assent.
- [ ] Review every merged PR actor, branch, tag, co-author trailer, copied
  source, AI work period, asset, dataset, and release artifact.
- [ ] Resolve employer/contractor and future legal-entity ownership questions.
- [ ] Produce an exact-path SBOM and rights bill of materials for the selected
  Community Edition release commit.
- [ ] Obtain qualified legal review before relying on this inventory for a
  commercial licensing transaction.

No private repository, relicensing, notice removal, EULA, proprietary header,
or claim of corporate ownership is authorized by this baseline.

## Primary references

- [Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0)
- [GNU Affero General Public License 3.0](https://www.gnu.org/licenses/agpl-3.0.html)
- [CLA Assistant project and operating model](https://github.com/cla-assistant/cla-assistant)
- [Apache Individual Contributor License Agreement](https://www.apache.org/licenses/icla.pdf)
- [GitHub Terms of Service, contributions under repository licenses](https://docs.github.com/site-policy/github-terms/github-terms-of-service)
