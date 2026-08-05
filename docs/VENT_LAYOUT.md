# Vent hardware selection and placement boundary

Emergency venting is intentionally split into two calculations:

1. `js/venting.js` calculates the low/high **unobstructed free area** for a
   declared pressure-relief gas case.
2. `js/vent-layout.js` matches the high-case area to one supplier-declared
   vent unit, selects the required quantity and places those units on
   explicitly permitted enclosure faces.

The second calculation does not turn the first into NFPA 68 deflagration
sizing. The NFPA Research Foundation's BESS hazard review states that
deflagration exhaust must go to a safe area, warns that unsafe direction can
endanger the public and responders, and notes that detailed design commonly
uses CFD. Those outcomes remain outside this geometric screen:

- [Landscape of Battery Energy Storage System Hazards and Mitigation Strategies](https://content.nfpa.org/-/media/Project/Storefront/Catalog/Files/Research/Research-Foundation/Reports/Electrical/RFBatteryEnergyStorageSystemLandscape.pdf)
- [NFPA ESS safety fact sheet](https://www.nfpa.org/-/media/project/storefront/catalog/files/code-or-topic-fact-sheets/ESSFactSheet.pdf)
- [DOE Energy Storage Safety Strategic Plan](https://www.energy.gov/sites/default/files/2024-05/EED_2827_FIG_SafetyStrategy%20240505v2.pdf)

## Required supplier evidence

The selector refuses to invent a vent product. Each candidate supplies:

- supplier, part number and stable catalog record id;
- unobstructed free flow area;
- physical width and height;
- pressure-relief mechanism;
- declared Road or Grid customer profiles;
- datasheet/drawing/flow-curve evidence basis.

The free area must not exceed the outside footprint. A matching outside
diameter is not accepted as a matching flow area.

## Market profiles

The first release keeps four isolated profiles:

| Product workspace | Required supplier profile | Hardware class shown to the customer |
|---|---|---|
| Road | `road-pack` | Pack pressure-relief device or directed duct exit |
| Grid / Home | `grid-home-pack` | Pack or small-cabinet pressure-relief device |
| Grid / Small company | `grid-commercial-cabinet` | Cabinet device or directed duct exit |
| Grid / Industrial | `grid-industrial-enclosure` | Industrial cabinet/container pressure-relief hardware |

These labels are compatibility partitions, not legal vent-size limits. The
software uses the actual supplier free area and actual pack geometry; it does
not hard-code an invented "typical" vent size for a market.

## Quantity rule

For the conservative high gas case:

```text
N_area = ceil(A_required,high / A_free,supplier-unit)
```

The design is blocked if `N_area` exceeds the reviewed maximum vent count or
if those units do not fit the permitted faces with the declared edge and
inter-vent clearances. The software never responds by silently increasing
allowable enclosure pressure.

## Placement rule

The propagation study supplies the preliminary enclosure X/Y/Z dimensions
and the worst-enclosed trigger-cell location. A human must mark which outer
faces already have an acceptable discharge direction and may optionally name
a preferred face.

For each permitted face the algorithm:

1. checks both supplier-unit orientations;
2. calculates how many footprints fit after edge and unit-to-unit clearance;
3. ranks faces by human preference, shortest normal distance from the gas
   source, available capacity and stable face name;
4. centers the required array near the source projection while preserving
   the clearances;
5. returns each unit's face, center X/Y/Z coordinate, footprint, rotation and
   outward discharge vector.

If one face cannot hold all required units, the selector continues on the
next permitted face. If the complete permitted set is insufficient, the
result is `blocked` and proposes only reviewable changes: another verified
vent, another safe face/directed duct, or revised enclosure geometry.

## Status and approval

- `needs-input` — representative gas volume/release evidence is absent.
- `needs-hardware` — the free-area equation ran, but supplier or placement
  evidence is incomplete.
- `fail` — the declared vent quantity cannot fit the declared constraints.
- `conditional` — a provisional quantity and coordinate layout exists, but
  production review and testing remain mandatory.

Every coordinate still requires CAD review for structure, seals, service
access, crash/load paths, water ingress, ducts and obstructions. Every
discharge direction requires an external safe-area review covering occupants,
egress, responders, intakes, ignition sources and adjacent equipment. The
production enclosure, vents and ducts require representative pressure and
gas-release testing; ESS explosion prevention/protection requires the
applicable qualified fire-protection analysis.
