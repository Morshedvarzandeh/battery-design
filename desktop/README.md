# The designer without a browser

The web app is deliberately small: one browser tab, instant answers, nothing
to install, nothing uploaded. That ceiling is real, though — sweeping the whole
cell library, running a mission at fine resolution for hours, or studying mass
across a range is minutes of computation, not milliseconds.

This directory removes the ceiling. **Same modules, no second implementation**
— the desktop runner imports `js/api.js`, which imports exactly the code the
web app uses. There is nothing here that can disagree with what the page says.

Requirements: **Node 18+**. No dependencies, no install step, no account, no
network. Nothing leaves your machine.

---

## The command line

```bash
node desktop/bd.mjs help
```

| Command | What it does |
|---|---|
| `design` | One design, fully worked — geometry, architecture, thermal, charging, cost, audit |
| `mission` | The design driven through time, with optional charging during the run |
| `sweep` | One variable across a range: every cell, or mass, payload, energy |
| `search` | The whole design space — every cell × every energy target — ranked |
| `range` | A drive-cycle study — consumption and range across mass × driving mode |
| `sim2` | The full model: RC dynamics, entropic heat, per-module temperatures, coolant, aging |
| `calibrate` | Correct the model against **your** measured data |
| `params` | Every coefficient, with units, bounds and where its default came from |
| `apps` / `cells` | The application presets and the cell library |
| `serve` | The web UI, served from your own machine, offline |

Examples:

```bash
# A 60 kWh EV pack, designed for selling power back to the grid
node desktop/bd.mjs design --app ev --energy 60000 --v2x v2g

# Every LFP cell in the library on the same duty, ranked by cost per kWh delivered
node desktop/bd.mjs sweep --app ev --energy 60000 --vary cell --chemistry LFP

# What 400 kg of extra vehicle costs you, in every driving mode
node desktop/bd.mjs range --app ev --energy 60000 --from 1400 --to 1800 --step 100

# Six passes of a bus route with a 90-minute charge at the depot
node desktop/bd.mjs mission --app ebus --passes 6 --charge base --minutes 90

# The full result as JSON, to keep, diff or feed to something else
node desktop/bd.mjs design --app ebike --json --out ebike.json
```

Add `--json` to any command for machine-readable output, `--out FILE` to write
it to disk.

---

## The level-2 model, and correcting it against your own cell

`js/sim2.js` is the simulation the desktop tier exists for. The browser model
(level 1) answers *"does this pack survive the duty?"* with one resistance and
one thermal mass. Every number in it is fixed by the tool, which is fine for a
first look and useless for an engineering decision.

This one is built the other way round: **every coefficient is a named, bounded,
documented parameter you can change — and given your measurements, the model
corrects itself to match them.**

```bash
node desktop/bd.mjs params --cell eve-lf280k        # every knob, with bounds and sources
node desktop/bd.mjs sim2 --app ev --modules 8 --ambient 35 --years 8
node desktop/bd.mjs calibrate --data pulse-test.csv --cell eve-lf280k --s 16 \
      --fit r0Ref,rc1R,rc1TauS --out my-cell.json
node desktop/bd.mjs sim2 --app ev --params my-cell.json   # now it is YOUR cell
```

### What it models

- **Equivalent circuit** — OCV + R0 + two RC branches, with Arrhenius
  temperature dependence, SoC-dependent resistance rise at both ends of the
  window, and optional one-state hysteresis (on by default for LFP, whose flat
  plateau really has it).
- **Heat** — irreversible I²R in every element *plus* the reversible entropic
  term I·T·(dU/dT), which cools the pack on charge and warms it on discharge.
  That term is why measured charge-side data embarrasses I²R-only models.
- **Thermal network** — a chain of module nodes with conduction between
  neighbours, convection into a coolant stream that warms as it flows, and
  loss to ambient. Not one lumped mass: modules reach different temperatures,
  and the *spread* is usually what limits the design. The coolant uses the
  ε-NTU effectiveness relation, so a stopped pump removes no heat and a fast
  one is limited by the cold plate rather than the flow.
- **Aging** — calendar (√t, Arrhenius, SoC-weighted) and cycle (√throughput,
  C-rate weighted), reported as a year-by-year capacity and resistance
  schedule with the year it crosses 80%.

### What it does not model, said plainly

- **No electrochemistry.** This is an equivalent-circuit model, not a
  Newman/P2D model: no lithium concentration, no particle diffusion, no
  plating criterion beyond a temperature gate. Every run prints this.
- **No 3-D fields.** The thermal network is lumped, not CFD. It will tell you
  a module runs 8 K hotter than its neighbour; it will not tell you which
  corner of it.
- **The defaults are class-typical, not your cell.** That is the whole reason
  `calibrate` exists.

### Calibration, and how it is proved

Give it what you measured — `time_s,current_A,voltage_V[,temp_C]` — and the
parameters you think are wrong, and a Nelder-Mead simplex searches for the
values that reproduce your data. It reports the RMSE before and after, how far
each parameter moved, and flags any that hit their bound (which usually means
the model is missing an effect, not that your cell is extreme).

The test suite proves this works the only way that means anything: it generates
measurements from **known** parameters, starts the fitter from the wrong
defaults, and requires it to recover the truth. It does, to within 0.1%.

---

## Speed: what is actually slow, measured

A fair question is whether this should be written in something faster. Here is
the evidence, measured on a 4-core machine rather than assumed.

| Operation | Cost |
|---|---|
| One complete design (geometry, architecture, thermal, audit, cost, mission), warm | **0.63 ms** |
| Same, plus vehicle physics over the full WLTP trace and a V2G policy | **0.85 ms** |
| Mission simulation, 360 steps | 0.54 ms — about **670,000 physics steps/second** |
| E-bus pack, 30,000 cells laid out | 4.8 ms |
| One design inside a big heterogeneous sweep | ~3.4 ms |

The arithmetic is not the problem. Note the last row: a design costs five times
more inside a sweep than in a tight loop of identical designs. That gap is
object allocation and garbage collection, not physics — the engine builds a
complete result object for every design even when the sweep only reads six
numbers from it.

**So the first fix was the cores, not the language.** `search` and `sweep` fan
out across worker threads:

| Job | 1 thread | 4 threads |
|---|---|---|
| 943 designs | 3.1 s | 2.0 s (1.6×) |
| 9,223 designs | 31.7 s | 14.8 s (2.1×) |

Small jobs deliberately stay serial: a worker costs tens of milliseconds to
start and load modules, which is more than a few hundred designs are worth.
`--jobs N` sets the thread count, `--jobs 1` forces serial. **Parallel and
serial return identical rows in identical order** — there is a test for it,
because a fast answer that disagrees with the slow one is worthless.

### Why not Rust or Java

Java offers nothing here: the same JIT-compiled performance class as V8, plus a
runtime dependency, minus any way to run in a browser.

Rust is genuinely faster — typically 2–5× on this kind of work, more on tight
numeric loops. The cost is the thing this project cannot pay: a **second
implementation of the physics**. The whole point of `desktop/` importing
`js/api.js` is that the page and the runner cannot disagree. Two codebases in
two languages will drift, and the first time the site says 135 Wh/km and the
desktop says 138, every number in both becomes suspect.

If the arithmetic ever does become the wall, the order is: exhaust the cores
(done), then stop allocating full result objects in sweeps, then move the
proven hot kernel to **Rust compiled to WebAssembly** — one implementation that
runs in both the browser and Node, so the web app gets faster too and nothing
drifts. Rust as a separate native binary buys speed and drift; Rust as WASM
buys speed without it.

---

## Letting an AI use the designer

`mcp-server.mjs` is a [Model Context Protocol](https://modelcontextprotocol.io)
server. Point Claude — or any MCP-speaking agent — at it, and the assistant can
size packs, run missions and compare cells **by calling the designer**, instead
of guessing about batteries from memory.

Add it to your MCP client configuration (Claude Desktop, Claude Code, or any
other MCP host):

```json
{
  "mcpServers": {
    "battery-design": {
      "command": "node",
      "args": ["/absolute/path/to/battery-design/desktop/mcp-server.mjs"]
    }
  }
}
```

Then ask in plain language:

> *"Design a 60 kWh pack for an EV conversion using LFP, run it over the WLTP
> cycle at 1,800 kg, and tell me what V2G would add."*

The tools available to the assistant:

| Tool | What the assistant gets |
|---|---|
| `list_applications` | The presets, their typical energy/voltage/power, and which design concepts each one needs |
| `list_cells` | The cell library, including whether each figure is a datasheet value or an estimate |
| `design_pack` | A complete design: pack, architecture, BMS, thermal, sensors, charging, cost, CO₂, release checklist |
| `run_mission` | The design through time — SoC, sag, temperature, losses, and whether it ran out |
| `compare_cells` | Several cells on the same mission, ranked by cost per kWh **delivered** |
| `explain_v2x` | What feeding power back would mean: modes, verdicts, parts added, export budget, wear floor |
| `explain_concept` | A design concept and which applications actually need it |

It is one file, about 300 lines, JSON-RPC over stdio. Read it before you run
it — that is the point of it being short.

### What the assistant is told

The server states plainly that its numbers come from the design modules rather
than from a language model, and that estimated values are marked as estimates.
An assistant that repeats a figure should be able to say where it came from —
the cell records carry their own data quality, and every assumption without a
public source is listed in [REFERENCES.md](../REFERENCES.md) §8.

### Without an MCP client

On the Results tab there is **"Copy this design for an AI assistant"**: it puts
the design on your clipboard as a written brief plus JSON, ready to paste into
any chatbot. Your own private cell records are never included — they stay on
your device, as promised in the NOTICE.

---

## The JSON engine directly

```js
import { designFromSpec, briefFromDesign } from './js/api.js';

const design = designFromSpec({
  application: 'ev',
  energyWh: 60000,
  cell: 'byd-blade-lfp-150ah',
  v2xPolicy: 'v2g',
  vehicle: { curbKg: 1800 },
  profileId: 'vehicle',      // derive the load from the vehicle's physics
});

console.log(briefFromDesign(design));   // the one-screen answer
console.log(design.cost.usdPerKWhDelivered);
```

`designFromSpec` runs unchanged in a browser and in Node, takes plain data and
returns plain data. Everything it can be given is listed in `SPEC_FIELDS`.

One deliberate roughness: `isolationStandard` has no safe default and must be
stated (`ece-r100` or `iso-6469-dc`). The sources genuinely conflict — 500 Ω/V
against 100 Ω/V — and the module refuses to average them or pick quietly. The
API defaults to ECE R100 and records the choice in the result.
