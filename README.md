# battery-design

A 3D battery pack designer that runs entirely in the browser — a static page
with no build step and no server. Open `index.html` from any static file
server (or enable GitHub Pages on this repo and it just works); Three.js is
vendored, so it also works offline.

Cell data is curated from public datasheets, several extracted via the
companion [battery-data](https://github.com/morshedvarzandeh/battery-data)
project's provenance-first datasheet pipeline.

## What it does

- **Design** — pick a cell (cylindrical 18650/21700/26650/32700/4680,
  prismatic LFP/LTO, NMC pouches, Na-ion), set series × parallel, choose grid
  or staggered-hex packing for cylinders and stacking for prismatic/pouch,
  and adjust cell spacers, wall thickness and busbar headroom. The 3D view
  colors cells by series group (following the actual serpentine welding
  order) or chemistry, shows the enclosure and series current path, and
  explodes for inspection.
- **From usage** — start from an application preset (e-bike, drone, ESS, EV,
  power tool, …) or raw requirements (voltage window, energy, continuous and
  peak power, charge rate, mass/size limits, temperature, cycle-life target).
  The optimizer enumerates cell × S × P candidates, sizes P by the binding
  constraint, checks feasibility, and ranks the survivors with reasons and
  warnings.
- **Fit box** — enumerate arrangements, orientations and layer counts to
  pack the current configuration into a target envelope, or just minimize
  volume.
- **Standards** — a rule engine audits the design against UN 38.3 / IATA
  transport thresholds, ECE R100 / ISO 6469-3 voltage classes, IEC 62619 /
  IEC 62133-2 protection requirements, thermal-propagation spacing practice,
  and a certification-path map by application. Findings carry the actual
  numbers and the standard they derive from.

## Honesty rules

- Every cell record carries `dataQuality` (`datasheet` vs `estimate`) and a
  `sourceNote` saying exactly what was estimated.
- Pack mass adds 8% for interconnects plus an aluminium-wall estimate, and
  the UI says so. DCIR is cells-only (interconnects excluded), labeled.
- Standards output is engineering guidance derived from public standards —
  not certification, and the page repeats that disclaimer.
- Hex (staggered) packing is only offered where it is geometrically real:
  upright cylinders. Lying cylinders and prismatic cells pack rectangularly.

## Architecture

| File | Role |
|---|---|
| `js/cells.js` | Cell library + chemistry data (self-contained, no imports) |
| `js/presets.js` | Application usage presets |
| `js/standards.js` | Standards rule engine over a computed design context |
| `js/pack-engine.js` | Pure electrical + layout math (Z-up, mm) |
| `js/optimizer.js` | Requirement search + space fitting |
| `js/viewer3d.js` | Three.js instanced rendering |
| `js/app.js` | UI state and wiring |

The data modules are import-free so they can be consumed by tooling (node
scripts, tests) without a browser.
