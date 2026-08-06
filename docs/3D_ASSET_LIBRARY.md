# 3D asset-library architecture

The 3D layer is split into three authorities:

| Authority | Owns | Must not own |
|---|---|---|
| Engineering modules (`js/`) | dimensions, mounting, pack geometry, calculations, evidence and fit status | decorative geometry or renderer logic |
| Asset library (`assets3d/`) | original visual meshes, named parts, materials, licence, asset version/digest and camera preset | battery calculations, compartment claims or simulation physics |
| Godot (`garage3d/`) | GPU mesh creation, lighting, ocean/studio presentation, camera and interaction | car/ship geometry, engineering dimensions or application rules |

`designFromSpec → buildScene → portable asset payload → Godot` is the only
runtime path. A renderer cannot select a different car or ship model because
the complete selected asset—including mesh vertices—is already in the scene
payload.

## Reliability gates

- Asset IDs are unique and semantically versioned.
- Geometry is content-digested deterministically, and validation recomputes
  the digest so changed primitives fail closed.
- Only finite positive primitive bounds are accepted.
- Mesh triangle indices and non-zero triangle areas are validated.
- Every fixed asset remains inside its declared visual envelope.
- Unknown primitive kinds fail closed.
- Every current host category resolves through the catalog.
- Godot contains no car, ship or robot model switch.
- Real Godot smoke tests exercise box, explicit mesh and cylinder payloads.

## Fixed reusable assets

| Asset ID | Purpose |
|---|---|
| `marine/electric-catamaran-ferry` | Small electric catamaran/ferry visual |
| `marine/research-work-vessel` | Research/work-vessel visual with named deck equipment |
| `stationary/modular-bess` | Battery cabinets, service faces, protected DC collection, PCS and HVAC interface |
| `thermal/forced-air-duct` | Filter, pack duct, flow vanes, PWM fans and outlet plenum |
| `thermal/liquid-cold-plate-radiator` | Cold plate, channels, manifolds, pump, radiator/fans and reservoir; no chiller |
| `thermal/liquid-cold-plate-chiller` | The liquid-radiator loop plus its coolant-to-refrigerant chiller interface |

Host templates (car, van, bike, robots and the remaining application classes)
are parameterized by a declared `sizeM` schema. Every instantiated size receives
its own geometry digest; the template ID is not treated as a fixed mesh.

## Licence and provenance

The library geometry is original and separately MIT-licensed in
`assets3d/LICENSE`. No third-party CAD, mesh, texture or drawing is included.
Published specifications may establish cited outer dimensions in an
engineering study, but they do not make the visual asset a replica or grant a
right to copy source artwork.

## Maturity boundary

These assets are flat low-poly engineering visualizations. They support
orientation, communication and interaction. They are not production CAD,
hull offsets, compartment evidence, class drawings, collision meshes for
crush analysis or calibrated hydrodynamic models.
