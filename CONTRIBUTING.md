# Adding cells and components

The databases are plain JavaScript data files. Anything you add — a new cell
you found on the market, a busbar, a cooling system, a supplier's spacer —
integrates with the whole app **by construction**: the pickers, the usage
optimizer, the four-perspective analysis and the 2D/3D views all read from
these files, and CI refuses the merge if a record breaks the contract.

## The loop

1. Add your record to the right file (see below).
2. Run the gate locally:
   ```bash
   node tools/validate.mjs        # data contracts
   node tests/sanity.mjs          # engine + data plausibility
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
`contrib/cells/` datasheet extractions, use those values verbatim and cite
the YAML path in `sourceNote`.

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
