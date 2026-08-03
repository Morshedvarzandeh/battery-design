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
| `range` | A drive-cycle study — consumption and range across mass × driving mode |
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
