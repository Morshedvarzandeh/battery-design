# References

Every rule, threshold and default in this tool should be traceable to something
you can look up. This file is that index.

**How to read it.** No standard is reproduced here — these are *citations*, with
the clause or practice the tool leans on and the module that uses it. Obtain the
documents themselves from the issuing bodies (IEC, ISO, UL, NFPA, UNECE, SAC/GB,
CEN, IEEE, SAE). Standards are revised: the tool names the edition it was written
against where the edition matters, and the release checklist tells the customer
to verify the current edition with their test house. That instruction is not
boilerplate — treat it as part of the output.

**The most important section is the last one.** [§8 Assumptions without a public
source](#8-assumptions-with-no-public-source) lists every number in this project
that is *not* backed by a citation. A tool that hides those is harder to trust
than one that prints them.

---

## 1 · Transport

| Reference | Title / scope | Used for | Module |
|---|---|---|---|
| **UN 38.3** | UN *Manual of Tests and Criteria*, Part III sub-section 38.3 — lithium battery transport tests (T1–T8) | The universal gate: appears in every application × market checklist, because nothing ships without it | `markets.js`, `standards.js` |
| **IATA/ICAO PI 965** | Packing Instruction 965, Section IB (lithium-ion cells/batteries shipped by air) | Air-transport wording in the safety findings | `standards.js` |
| **IEC 62281** | Safety of primary and secondary lithium cells and batteries during transport | Transport safety design guidance alongside UN 38.3 | `standards.js` |
| **ADR SP 188** | European Agreement concerning the International Carriage of Dangerous Goods by Road — Special Provision 188 (excepted lithium cells and batteries) | The road-transport exception route for small cells/batteries in Europe | `standards.js` |

## 2 · Cell and system safety

| Reference | Title / scope | Used for | Module |
|---|---|---|---|
| **IEC 62133-2** | Safety requirements for portable sealed secondary lithium cells and batteries — Part 2: Lithium systems | Portable-class applications (wearables, tools, vacuums, power stations) | `standards.js` |
| **IEC 62619** | Safety requirements for secondary lithium cells and batteries for industrial applications | Industrial and stationary classes; propagation and spacing guidance | `standards.js`, `engineering.js` |
| **IEC 63056** | Safety requirements for secondary lithium cells and batteries for use in electrical energy storage systems | Stationary storage | `standards.js` |
| **IEC 62933-5-2** | Electrical energy storage systems — Part 5-2: Safety requirements for grid-integrated EES — electrochemical systems | Grid-connected storage | `standards.js` |
| **UL 1973** | Batteries for use in stationary, vehicle auxiliary power and light electric rail applications | Stationary, auxiliary (RV) classes | `standards.js` |
| **UL 2580** | Batteries for use in electric vehicles | Vehicle class; abuse/crush test framing | `standards.js`, `engineering.js` |
| **UL 9540** | Energy storage systems and equipment | US stationary listing | `standards.js`, `markets.js` |
| **UL 9540A** | Test method for evaluating thermal runaway fire propagation in battery energy storage systems | Propagation testing for stationary systems | `standards.js`, `markets.js` |
| **UL 2271** | Batteries for use in light electric vehicle (LEV) applications | Light means of transport (e-bike, e-scooter) | `standards.js` |
| **UL 2272** | Electrical systems for personal e-mobility devices | Personal e-mobility | `standards.js` |
| **UL 2849** | Electrical systems for eBikes | E-bike systems | `standards.js` |
| **UL 2743** | Portable power packs | Portable power stations | `standards.js` |
| **UL 2054** | Household and commercial batteries | Consumer-class packs | `standards.js` |
| **UL 583** | Electric-battery-powered industrial trucks | Industrial trucks / AGVs | `standards.js` |
| **UL 94** | Tests for flammability of plastic materials for parts in devices and appliances | Housing and holder material class | `components.js` |
| **NFPA 855** | Standard for the installation of stationary energy storage systems | US stationary installation | `standards.js`, `markets.js` |
| **NFPA 68** | Standard on explosion protection by deflagration venting | Vent-path sizing guidance | `standards.js`, `components.js` |
| **NFPA 1192** | Standard on recreational vehicles | Auxiliary (RV) class | `standards.js` |
| **SAE J2929** | Safety standard for electric and hybrid vehicle propulsion battery systems using lithium-based rechargeable cells | Vehicle-class safety reference | `standards.js` |
| **NIOSH lifting guideline** | US National Institute for Occupational Safety and Health revised lifting equation | The handling warning when a module or pack passes the mass at which one person can lift it safely | `standards.js`, `engineering.js` |

## 3 · Vehicles, light transport, marine, industrial

| Reference | Title / scope | Used for | Module |
|---|---|---|---|
| **UN ECE R100** (incl. **UN ECE R100 Annex 4**) | Uniform provisions concerning the approval of vehicles with regard to specific requirements for the electric power train | Vehicle approval; **Annex 4** mechanical/crush tests behind the wall-thickness guidance; the 500 Ω/V isolation option | `standards.js`, `architecture.js`, `engineering.js` |
| **UN ECE R10** | Electromagnetic compatibility | Vehicle and auxiliary classes | `standards.js` |
| **FMVSS 305 / 305a** | US Federal Motor Vehicle Safety Standard No. 305 — electric-powered vehicles: electrolyte spillage and electrical shock protection (305a is the updated rule) | The US vehicle gate, the counterpart to ECE R100 in the EU checklist | `markets.js` |
| **ISO 6469-1** | Electrically propelled road vehicles — Safety specifications — Part 1: Rechargeable energy storage system | Vehicle RESS requirements | `standards.js` |
| **ISO 6469-3** | Part 3: Electrical safety | The **100 Ω/V DC** isolation option — deliberately in conflict with ECE R100's 500 Ω/V, which is why the tool makes the standard an explicit choice and refuses to average them | `architecture.js` |
| **ISO 12405** | Test specification for lithium-ion traction battery packs and systems | Vehicle pack testing | `standards.js` |
| **ISO 26262** | Road vehicles — Functional safety (ASIL) | BMS functional-safety expectation per hazard analysis | `standards.js`, `architecture.js` |
| **IEC 61508** | Functional safety of electrical/electronic/programmable electronic safety-related systems | Industrial functional-safety counterpart | `standards.js` |
| **IEC 60664-1** | Insulation coordination for equipment within low-voltage systems — Part 1 | Creepage and clearance requirements by voltage and pollution degree | `engineering.js` |
| **EN 15194** | Cycles — Electrically power assisted cycles (EPAC) | E-bike class | `standards.js` |
| **EN 50604-1** | Secondary lithium batteries for light EV applications | Light electric vehicles | `standards.js` |
| **EN 1175** | Safety of industrial trucks — Electrical requirements | Industrial trucks | `standards.js` |
| **ISO 3691-4** | Industrial trucks — Safety requirements and verification — Part 4: Driverless industrial trucks | AGV / driverless trucks | `standards.js` |
| **Machinery Directive 2006/42/EC** (superseded by **Machinery Regulation (EU) 2023/1230**, applying from January 2027) | Essential health and safety requirements for machinery placed on the EU market | The EU gate for AGVs, AMRs and humanoid platforms — the machine, not the battery, is what is certified | `markets.js` |
| **ANSI/ITSDF B56.5** | Safety standard for driverless, automatic guided industrial vehicles and automated functions of manned industrial vehicles | The US counterpart for driverless industrial vehicles | `markets.js` |
| **ABYC E-13** | Lithium-ion batteries (American Boat & Yacht Council) | Marine class | `standards.js` |
| **Class society type approval** — DNV, Lloyd's Register, Bureau Veritas (and equivalents) | Battery-system type approval under the society's own rules | For commercial vessels the **class society is the gate**, not a product norm — the checklist says so explicitly | `markets.js` |
| **MGN 550** | UK Maritime & Coastguard Agency Marine Guidance Note for battery-powered vessels | UK marine expectation | `markets.js` |
| **USCG** requirements / class approval | United States Coast Guard commercial-vessel requirements | US marine gate | `markets.js` |

## 4 · China

| Reference | Title / scope | Used for | Module |
|---|---|---|---|
| **GB 38031** (2020; **2025** revision) | Electric vehicles traction battery safety requirements. The 2025 revision requires no fire and no explosion after an internal thermal runaway event | China vehicle gate; the note that this requirement is chemistry-blind but harder for high-nickel packs | `markets.js` |
| **GB 18384** | Safety requirements for electric vehicles | China vehicle gate | `markets.js` |
| **GB/T 31498** | Post-crash safety requirements for electric vehicles | China vehicle gate | `markets.js` |
| **GB/T 36276** | Lithium-ion battery for electrical energy storage | China stationary storage | `markets.js` |
| **GB 42295** (with CCC compulsory certification) | Electric bicycles — electrical safety requirements | China light-means-of-transport gate | `markets.js` |
| **GB 31241** | Lithium-ion cells and batteries used in portable electronic equipment — safety requirements | China portable-class gate | `markets.js` |
| **CCS rules** | China Classification Society rules for battery system approval | China marine gate | `markets.js` |
| **MIIT recommended-vehicle catalogue practice** | Since 2017, catalogue practice has kept NMC/NCA out of urban e-buses on safety grounds; programmes ship LFP or LTO | The **blocker** raised for a Chinese e-bus on NMC. This is administrative *practice*, not a published prohibition — the tool says so and tells you to verify the current catalogue before committing a chemistry | `markets.js` |

## 5 · Communication, control and grid interface

| Reference | Scope | Used for | Module |
|---|---|---|---|
| **ISO 11898** | Road vehicles — Controller area network (CAN) | Vehicle bus | `architecture.js` |
| **ISO 14229 (UDS)** | Unified diagnostic services | Diagnostics; also the route by which live state-of-health is exposed for the EU battery passport | `architecture.js`, `eurules.js` |
| **ISO 15118 / DIN 70121** | Vehicle-to-grid communication interface / DC charging communication | Charge-session control in the supervisory layer | `architecture.js` |
| **SAE J1939** | Serial control and communications heavy-duty vehicle network | Buses, trucks, lift trucks | `architecture.js` |
| **CANopen (CiA)** | Industrial device profile | AGVs and industrial trucks | `architecture.js` |
| **Modbus / SunSpec** | Field bus and DER information models | Stationary storage and inverters | `architecture.js` |
| **IEC 61850** | Communication networks and systems for power utility automation | Utility-scale storage interface | `architecture.js` |
| **NMEA 2000** | Marine electronics network | Marine systems | `architecture.js` |
| **IEEE 2030.7** | Standard for the specification of microgrid controllers | The three-level (primary / secondary / tertiary) hierarchical EMS architecture and its timescales | `architecture.js` |
| **IEC 61851-1** | Electric vehicle conductive charging system — Part 1: General requirements (charging modes, control pilot) | The AC charging baseline behind the connector/comms rows | `charging.js` |
| **IEC 62196-2** | Plugs, socket-outlets, vehicle connectors — Part 2: AC pin and contact-tube accessories (Type 2) | The EU AC connector | `charging.js` |
| **IEC 62196-3** | Part 3: DC and AC/DC pin and contact-tube vehicle couplers (CCS) | The EU DC fast-charge coupler | `charging.js` |
| **SAE J1772** | SAE electric vehicle conductive charge coupler | The North American AC connector and pilot | `charging.js` |
| **SAE J3400** | NACS electric vehicle coupler | The North American NACS connector | `charging.js` |
| **GB/T 20234** (.2 AC, .3 DC) | Connection set for conductive charging of electric vehicles | The China AC and DC connectors | `charging.js` |
| **GB/T 27930** | Communication protocols between off-board conductive charger and battery management system | China charge communication | `charging.js` |
| **ISO 15118-20** | Road vehicles — vehicle to grid communication interface — Part 20: 2nd generation network layer and application protocol requirements | Bidirectional power transfer (BPT) — the charge-session standard behind V2G over CCS | `v2x.js` |
| **CHAdeMO** | CHAdeMO DC charging protocol (bidirectional since 1.0) | The other established V2G session route | `v2x.js` |
| **IEEE 1547** | Standard for interconnection and interoperability of distributed energy resources with associated electric power systems interfaces | What the grid-facing inverter must satisfy before a vehicle may export | `v2x.js` |
| **UL 1741 (+SA/SB)** | Inverters, converters, controllers and interconnection system equipment for use with distributed energy resources | North American certification of the grid-tied inverter path | `v2x.js` |
| **UL 9741** | Bidirectional electric vehicle charging system equipment | The bidirectional EVSE class behind V2H/V2G installations | `v2x.js` |
| **EN 50549-1/-2** | Requirements for generating plants to be connected in parallel with distribution networks | The EU grid-code gate: exporting makes the machine a generating plant | `v2x.js`, `markets.js` |
| **IEC 62109** | Safety of power converters for use in photovoltaic power systems | Equipment safety for the inverter behind a V2L output | `v2x.js` |
| **IEC 60364-4-41** | Low-voltage electrical installations — protection against electric shock | Residual-current protection on a socket that has become a source | `v2x.js` |

## 6 · Regulation

| Reference | Scope | Used for | Module |
|---|---|---|---|
| **Regulation (EU) 2023/1542** | Batteries and waste batteries (repealing Directive 2006/66/EC) | The Rules tab timeline and applicability: carbon-footprint declaration, digital battery passport (>2 kWh industrial and all EV batteries), recycled-content targets for Co/Ni/Li/Pb, collection targets, and the two distinct metrics the tool deliberately keeps apart — **recycling efficiency** (mass of the battery recovered) versus **material recovery** (per-element recovery) | `eurules.js` |

## 7 · Literature, data sources and prior art

### 7.1 Papers

- **Lee, S. S., Kim, T. H., Hu, S. J., Cai, W. W., & Abell, J. A. (2010).**
  *Joining Technologies for Automotive Lithium-Ion Battery Manufacturing – A Review.*
  ASME 2010 International Manufacturing Science and Engineering Conference,
  **MSEC2010-34168**. — Basis for the welding/joining recommendation per cell
  format (resistance spot for cylindrical, laser for prismatic terminals,
  ultrasonic for pouch tabs) and the cautions attached to each. → `architecture.js`
- **Gillespie, T. D. (1992).** *Fundamentals of Vehicle Dynamics.* SAE
  International, **R-114**. — The road-load equation the vehicle model
  integrates: rolling resistance, aerodynamic drag, grade and inertial terms,
  and the rotating-mass factor that makes acceleration cost more than m·a.
  → `vehicle.js`
- **Ehsani, M., Gao, Y., Longo, S., & Ebrahimi, K. (2018).** *Modern Electric,
  Hybrid Electric, and Fuel Cell Vehicles* (3rd ed.). CRC Press. — Drivetrain
  efficiency and regenerative-braking recovery treated as fractions of wheel
  power, which is how the tool books regen against braking energy. → `vehicle.js`
- **UNECE Global Technical Regulation No. 15 (WLTP).** — The published Class 3
  cycle STRUCTURE used by the EV speed trace: four phases (Low / Medium / High /
  Extra-High), their durations, distances and peak speeds. The tool synthesizes
  a trace that matches those published aggregates; it does not reproduce the
  homologation second-by-second data. → `vehicle.js`
- **Microgrid EMS literature (survey-level).** The centralized / hierarchical /
  distributed families, and the finding that no universal crossover between them
  exists — which is why the tool treats the choice as an input with a
  scale-based suggestion rather than a computed answer. → `architecture.js`

### 7.2 Cell data

Cell records are transcribed from **public manufacturer datasheets** for:
A123 Systems · BYD (FinDreams) · CATL · EVE Energy · LG Energy Solution ·
Molicel (E-One Moli) · Panasonic · Panasonic/Tesla · Samsung SDI · Toshiba (SCiB).
Generic entries are labelled *Generic* and are class-typical, not a specific SKU.

Every cell carries a `sourceNote` naming the document and stating **exactly which
fields were estimated** rather than published, plus a `basis` / `inferredFields`
pair that the CI data gate (`tools/validate.mjs`) enforces. Several records were
extracted with the companion provenance-first pipeline,
[battery-data](https://github.com/morshedvarzandeh/battery-data).

*Customer-supplied cells never leave the device and are never published — see the
privacy note in `js/mycells.js`.*

### 7.3 Component and supplier classes

`js/components.js` describes **market-representative classes** (busbar and cell
contact systems, spacers/holders, venting, cooling, thermal interface materials,
enclosures) with example suppliers named for orientation. Properties are
class-typical ranges from public supplier literature, not a quotation for a
specific part number, and each entry states its `dataQuality`.

### 7.4 Patent landscape

`js/patents.js` maps a design to families of publicly filed prior art —
cell-to-pack structures (BYD Blade, CATL CTP), serpentine ribbon cooling and
tabless electrodes (Tesla), wire-bond interconnects, immersion cooling,
phase-change matrices, aerogel barriers, cell vent channels, flex-PCB cell
contact systems, structural packs. **Every entry links to Google Patents only**,
and the module carries an explicit disclaimer: this is landscape awareness for
design conversations, **not** a freedom-to-operate opinion. Get an attorney for
that.

### 7.5 Market validation anchor

`tools/validate-vs-market.mjs` checks the whole chain against a **production
pack**: the Tesla Model 3 Long Range (4,416 × 2170 cells, 96S46P, ~78 kWh
nominal). The same bay geometry admits ~6,956 cells, so the manufacturer
realises ~64% of the geometric ideal — the origin of the tool's default **35%
integration allowance** for structure, manifolds and crash provision. This gate
runs on every change; the modelled pack must land within 1% of the real one.

---

## 8 · Assumptions with no public source

These are the numbers the tool uses that are **not** backed by a citation. They
are exposed as inputs wherever possible, and stated as estimates in the output.

| Assumption | Value used | Why it is not sourced |
|---|---|---|
| Cell DCIR, where unpublished | estimated per record | Most datasheets omit it; every estimate is flagged in the cell's `sourceNote` |
| Cell price | estimated per record | Prices are quotation- and volume-dependent; the workbook exposes the field so you can drop in your own quote |
| Pack interconnect resistance | 10–30 mΩ (default 20) | A 3× spread across busbars, joints, contactors, fuse and shunt — exposed as an input, never hidden |
| Contactor mass | ≈150 g + 1 g/A | A weak empirical fit (n = 23) for budgeting only; stated as such in the output |
| Chiller COP | 2.5 | Conservative automotive class value; exposed in the thermal model |
| Coolant properties | 50/50 water-glycol, c_p 3.6 kJ/(kg·K), ρ 1.07 kg/L, design ΔT 5 K | Standard class values; all exposed in the Excel workbook as named inputs |
| Manufacturing CO₂ footprint | 45–90 kg CO₂e per kWh by chemistry | Literature-class estimates that vary by factory, grid and year — good for comparing options, not an audited LCA |
| OCV(SoC) curves | chemistry-class shapes (LFP flat plateau, NMC slope, Na-ion near-linear) anchored to each cell's own voltage window | Manufacturers do not publish OCV tables; the simulation states this in its assumptions list on every run |
| Cell swelling allowance | 10–20% thickness growth over life | Design practice, not a standard requirement |
| Wall thickness | **not prescribed** | No standard specifies a millimetre value. The crash/crush **tests** (ECE R100 Annex 4, GB 38031, UL 2580) prescribe outcomes; the wall must pass them. The tool says this rather than inventing a number |
| Daisy-chain node limit | 62 nodes | Common AFE-family device limit; treated as a hard architectural limit and named as the reason in the verdict |
| Temperature-sensor ratio | 1 per 6 cells (1 per 3 for full observability) | Design practice; both figures are reported so the trade-off is visible |
| OBC efficiency | 93% | Class-typical AC→DC conversion efficiency; exposed as a named input in the workbook and stated wherever charge times are shown |
| CV taper model | CC to 80% SoC, then 0.45× average rate | A class simplification of the constant-voltage tail — real taper curves are cell-specific and unpublished |
| Mission charge power | the cell's rated continuous charge current (base charging additionally throttled by the OBC) | Mission-charging power in the simulation comes from the cell's own datasheet rating, not an invented charger |
| BMS topology crossover | none | No sourced quantitative crossover between centralized / master-slave / wireless exists, so the tool suggests by scale and says openly that the rule is not sourced |
| Vehicle class defaults (mass, Cd, frontal area, Crr, drivetrain efficiency, auxiliary load) | per application, e.g. 1250 kg / 0.29 / 2.2 m² for a C-segment EV | Class-typical values for sizing, not any specific vehicle — every one is an exposed input the customer overwrites with their own |
| Driving-mode factors | Eco 0.94× speed, 0.80× acceleration, 1.25× regen; Sport 1.06× / 1.40× / 0.85× | A class model of driver behaviour. No standard defines "Sport"; the factors are stated and exposed so the customer can dispute them |
| Rotating-mass factor ε | 0.02–0.07 by machine | Wheels, gears and rotor inertia add to the effective mass under acceleration; the value is a class estimate |
| Synthesized WLTP Class 3 trace | matches the published phase durations, distances and peak speeds within ~5% | The phase aggregates are public; the second-by-second homologation trace is not reproduced, and the tool says so wherever the trace is used |
| V2G wear floor | (cell price × count) ÷ (nameplate cycle life × usable energy) | Uses the **nameplate** cycle life — shallow V2G micro-cycling usually ages more gently per kWh, so the floor is a conservative first-order ceiling on wear cost, stated as such wherever it appears |

---

## 9 · Citing this tool

If a report, paper or tender document leans on output from this project, please
cite it — see [CITATION.cff](CITATION.cff), or:

> Varzandeh, M. (2026). *battery-design: an in-browser battery pack design,
> architecture and mission-simulation tool.*
> https://github.com/Morshedvarzandeh/battery-design

## 10 · Corrections

A wrong reference is worse than a missing one. If a citation here is out of date,
mis-stated, or attached to the wrong requirement, please
[open an issue](https://github.com/Morshedvarzandeh/battery-design/issues) — say
which standard and which edition, and it will be fixed. Data corrections with a
public datasheet behind them are especially welcome; see
[CONTRIBUTING.md](CONTRIBUTING.md).
