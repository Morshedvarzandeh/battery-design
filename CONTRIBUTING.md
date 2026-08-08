# Adding cells and components

## Contribution rights and current license

The current public tree is licensed under AGPL-3.0-or-later, except for
material that carries its own license or notice. By submitting a pull request,
you confirm that you created the contribution or have authority to submit it,
and that you have disclosed any third-party code, data, media, model, standard,
datasheet, or other material it contains.

Unless a separate signed agreement expressly applies, submission does not
transfer ownership. To the extent that you or an identified rightsholder
controls the necessary rights, you represent that you are authorized to license
the contribution to this public project under AGPL-3.0-or-later on the same
inbound-and-outbound terms. Disclosed third-party material remains governed by
its own terms. The public-project grant is not a separate proprietary or
dual-license grant.

No Contributor License Agreement is active for this repository yet. A pull
request, checkbox, commit signature, or GitHub account does **not** transfer
copyright ownership or grant a separate proprietary/dual-license right. Until
a counsel-approved agreement and signer check are active, a copyrightable
contribution from anyone whose proprietary-license authority is not documented
must either remain unmerged or be recorded as public-license-only in the rights
baseline (or its successor exact-path bill of materials) and excluded from any
future proprietary baseline.

See [the rights and provenance baseline](docs/RIGHTS_PROVENANCE_BASELINE.md)
and [the governed compliance roadmap](docs/COMPLIANCE_COMMERCIAL_TRANSITION.md)
before changing licensing, notices, release boundaries, or commercial code.

The databases are plain JavaScript data files. Anything you add — a new cell
you found on the market, a busbar, a cooling system, a supplier's spacer —
integrates with the whole app **by construction**: the pickers, the usage
optimizer, the four-perspective analysis and the 2D/3D views all read from
these files, and CI refuses the merge if a record breaks the contract.

## The loop

1. Add your record to the right file (see below).
2. Run the gate locally:
   ```bash
   npm run validate               # contracts, types, tests and market checks
   ```
3. Open a pull request. CI runs the same gate on every PR; a green check
   means the new entry is fully integrated.

## Adding a component — `js/components.js`

Pick the category array (`busbar`, `spacer`, `vent`, `cooling`, `tim`,
`housing`) and append an object. Rules the validator enforces:

- **Every field present** — use `null` for unknown, never omit a field.
  Each category's required fields are listed in `tools/validate.mjs`.
- **`forms`** — the cell shapes it physically applies to
  (`cylindrical` / `prismatic` / `pouch`). This is what makes the picker
  show it only where it makes engineering sense.
- **`suppliers`** — at least one representative market example (not an
  endorsement). Only "absence" entries (passive air, dry contact, direct
  bond) may have `suppliers: null`.
- **`dataQuality: 'typical-class'`** — properties describe the product
  class, not one SKU. If you have a specific SKU's datasheet, still enter
  class-typical values and name the SKU in `notes`.
- **Cooling** needs `htcWm2K: [lo, hi]` and a `viz` hint
  (`bottom` / `side` / `between` / `null`) so the 2D and 3D views can draw
  it. **TIM** needs `thicknessMm: [lo, hi]`. **Vents** need
  `level: 'cell' | 'pack'`.

If the component should be the default for a shape, update
`DEFAULTS_BY_FORM` — the validator checks the id exists and supports that
form.

## Adding a cell — `js/cells.js`

Follow the geometry convention documented at the top of the file
(cylindrical `{d, h}`; prismatic/pouch `{w, t, h}` with `t ≤ w`). The
validator additionally enforces voltage ordering, positive mass/capacity/
current limits, `[min, max]` temperature windows, and a plausible Wh/kg.

Two honesty rules are load-bearing:

- `dataQuality: 'datasheet'` only if capacity, voltages, current limits,
  mass and dims all come from a real datasheet you are confident about.
  Otherwise `'estimate'`.
- `sourceNote` must say where the numbers came from and exactly what was
  estimated. Current limits may not be omitted — if the maker publishes
  none, enter a conservative estimate and say so in the note.

If the cell exists in the companion
[battery-data](https://github.com/morshedvarzandeh/battery-data) repo's
`contrib/cells/` datasheet extractions, record the exact source commit and YAML
path, the repository license applicable at that commit, the original
datasheet/source provenance, and the authority to reuse the values. Citation
alone is not permission; do not copy values or expression verbatim unless the
applicable license or permission allows it.

## Adding an application preset — `js/presets.js`

Append to `PRESETS`; the validator checks the voltage/energy windows contain
their typicals and that chemistry preferences name known chemistries.

## What you get for free

Once the gate is green, with no further wiring your entry:

- appears in the **Parts** pickers for its `forms` (components) or the cell
  selector (cells);
- is scored by the **Usage** optimizer (cells) and analyzed by the
  **Analysis** tab's mechanical/thermal/electrical/safety rules
  (components — ampacity, ΔT, mass budget, venting, propagation…);
- renders in the **2D layout** and the on-demand **3D view** (cooling
  hardware via its `viz` hint, housings via material tint);
- ships to the live site on the next merge to `main` (GitHub Pages deploys
  automatically).
