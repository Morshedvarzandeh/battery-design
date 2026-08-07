# .owi — this repository's AI work manifest

`project.json` lists the features to build. The
[Open Workforce Index](https://github.com/Morshedvarzandeh/Open-Workforce-Index)
allocator staffs each one to the cheapest qualified AI worker at real
published prices, prices the whole plan, and explains every exclusion.

## Run the plan

```bash
# once: get the engine next to this repo (needs Rust 1.87+ and Python 3)
git clone https://github.com/Morshedvarzandeh/Open-Workforce-Index owi
cd owi

# build the index: real prices + roster (incl. this repo's web/rust workers)
cargo run -q -p workforce-cli -- prices --index .data/index.sqlite \
  --input examples/litellm-prices-sample.json \
  --options examples/price-import-options.json
cargo run -q -p workforce-cli -- seed --index .data/index.sqlite \
  --input examples/manager-scenario-seed.json
cargo run -q -p workforce-cli -- seed --index .data/index.sqlite \
  --input projects/battery-design-roster.json

# staff and price this repo's work
python3 tools/owi_plan.py --owi-repo . \
  --project ../battery-design/.owi/project.json \
  --index .data/index.sqlite --local .data/local.sqlite \
  --work-dir /tmp/owi-plan
```

Also available from the same checkout: `tools/owi-do "task" --run` (one-shot
ask/run), `tools/owi-serve` (the same as a local page), and
`tools/owi_console.py` (this manifest as a live-dial GUI). The full ladder is
written in
[docs/WORKFLOW.md](https://github.com/Morshedvarzandeh/Open-Workforce-Index/blob/main/docs/WORKFLOW.md).

Prices and decisions are real; starting abilities are assumed
(`vendor_reported`, discounted 10×) until measured — the plan says so itself.
