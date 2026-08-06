# Reusable 3D asset library

`assets3d/catalog.js` is the only source of car, vessel, stationary-storage,
thermal-equipment, machine, robot and product-host visual geometry. Engineering modules provide dimensions and
evidence; `js/scene3d.js` resolves the selected asset; Godot only renders the
portable payload.

Every asset carries:

- a stable `assetId` and semantic version;
- a deterministic geometry digest;
- explicit coordinate system and visual envelope;
- original/open-source licence metadata;
- named primitives and materials;
- a scene/camera presentation contract.

The fixed marine, modular-BESS and thermal-system assets are original
flat low-poly engineering visualizations. They do
not copy third-party CAD, meshes, drawings or textures. Public vessel material
is used only for cited principal particulars in `js/vessels.js`.

The visual decision report uses the same portable assets. Forced air, a
radiator-only liquid loop and a liquid loop with chiller each resolve to a
different reusable asset, so a report cannot add a chiller that was not
selected. Passive and motion-induced air concepts explicitly show that no
dedicated loop hardware is present. The renderer does not size any part; the
engineering snapshot supplies every displayed value.

The contents of this directory are available under the [MIT licence](LICENSE),
so they can be reused independently. The surrounding battery-design
application remains licensed under its repository-level AGPL licence.
