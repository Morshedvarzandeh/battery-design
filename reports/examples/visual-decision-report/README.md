# Audited visual decision-report example

`Battery_Design_Visual_Decision_Report_Example_52s.mp4` is the publication
master that established the visual language for the reusable **Animated visual
decision report** in the Results tab.

This MP4 is an audited example, not a template with fixed numbers pasted over a
new design. The application generates each new visual report from its existing
report snapshot through `js/visual-report.js`. That live export uses the exact
selected pack, available mission simulation, thermal-system choice, findings,
semantic root and portable 3D assets.

## Example calculation boundary

- LG INR18650-MJ1 example cell.
- 110S × 43P = 4,730 cells.
- 399.85 V and 150.5 Ah nominal.
- 60.177 kWh at nominal capacity; 57.598 kWh at the datasheet minimum capacity.
- 1,270.4 × 1,264.9 × 87.3 mm cell-layout screen using manufacturer maximum
  cell dimensions and a declared 1,800 × 1,400 × 150 mm example bay.
- 270.1 kg preliminary mass with production-integration exclusions shown in
  the film.
- Synthesized WLTP-structured duty and simplified equivalent-circuit / lumped
  thermal model; not homologation, CFD, certification or a manufacturer
  vehicle specification.

The exact computed dataset is in `report-data.json`. `generate-data.mjs`
rebuilds it from the checked-in engineering modules, while `node
generate-data.mjs --check` performs a read-only byte-for-byte freshness check.
`manifest.json` records the encoded-master identity. Repository tests run that
generator check and independently reconcile the pack arithmetic, clearances,
thermal-margin identities and file digest.

The five car renders are CC BY 4.0 derivatives. See [CREDITS.md](CREDITS.md).
The stationary-storage and vessel visuals are original Battery Design work.
