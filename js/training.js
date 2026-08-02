// training.js — an interactive walkthrough of the design process, in the
// real UI (each step opens the real tab it talks about). Two tracks so
// nobody gets confused: SIMPLE teaches the five clicks a customer needs;
// ADVANCED adds the expert levers (weights, TCO basis, DoD, stacks,
// architecture, rules). Pure data; the driver lives in app.js.

export const TRAINING_TRACKS = {
  simple: {
    name: 'Simple — the five clicks',
    steps: [
      {
        tab: 'usage', title: '1 · Say what you are building',
        text: 'Tap an application card (e-bike, EV, e-bus, robot vacuum…). Everything below fills itself with sensible numbers for that application — including its own load profile. You never start from a blank form.',
      },
      {
        tab: 'usage', title: '2 · Check the load shape',
        text: 'The chart shows how your application really draws power over time. If it looks right, you are done here — the "Use profile" button turns the shape into the power numbers. Have your own measurements? One button uploads a CSV.',
      },
      {
        tab: 'fit', title: '3 · Give it your space',
        text: 'Type the bay size (or pick round / L-shape / stepped, draw it, or upload a CAD outline). Then press "Max fill" — the tool packs every battery in the library into YOUR space and ranks the results.',
      },
      {
        tab: 'fit', title: '4 · Pick a scenario',
        text: 'Each card is a complete design: energy, weight, cost over its life, and how it splits into modules. If your target is out of reach, the tool shows the closest possible solution and how many bays would cover it — never a dead end. Tap "Apply this fill" on the one you like.',
      },
      {
        tab: 'design', title: '5 · See your pack',
        text: 'The drawing is your pack with real dimensions. Switch to 3D to look around; the explode slider takes it apart and the legend names every component in view.',
      },
      {
        tab: 'results', title: 'Done — the report',
        text: 'The Results tab writes the customer document: economics, CO₂ payback, sensitivity, the architecture diagram — downloadable as PDF or Word. That is the whole flow: application → space → pick → report.',
      },
    ],
  },
  advanced: {
    name: 'Advanced — the expert levers',
    steps: [
      {
        tab: 'usage', title: '1 · Duty is money',
        text: 'Open "Advanced settings": cycles/year, target years and usable DoD drive the lifetime cost (TCO) and the CO₂ payback. A cheap cell with a short cycle life becomes the expensive option here — this is where that shows.',
      },
      {
        tab: 'usage', title: '2 · Seasons set the corners',
        text: 'The climate & season picker fills the design temperature window. Design for ALL YEAR; use a season button to see what winter does to charging (heater or inhibit below 0 °C) and what summer does to the cooling margin — the system temperature is ambient plus the pack\'s own heat rise.',
      },
      {
        tab: 'usage', title: '3 · Big systems are stacks',
        text: 'A 1 MWh plant, a ship or a bus is never one pack. Set the stack count yourself in Advanced settings, or leave it blank and the tool derives how many stacks of your design reach the energy target.',
      },
      {
        tab: 'fit', title: '4 · The optimizer is multi-objective',
        text: 'The weights sliders trade energy vs cost vs weight; the cost basis switch chooses purchase price or lifetime TCO. Pareto-optimal cards are marked — those are the designs nothing else beats on every objective at once.',
      },
      {
        tab: 'fit', title: '5 · The integration allowance is real',
        text: 'Real packs lose plan area to module walls, crash structure and manifolds. The 35% default is calibrated against the Tesla Model 3 pack (the OEM realizes ~64% of geometric ideal). Set 0 only when you want the bare geometric maximum.',
      },
      {
        tab: 'design', title: '5b · Why the spaces exist',
        text: 'Cell spacing absorbs swelling (10–20% thickness growth over life is the design allowance) and acts as the propagation break the abuse tests probe. Wall thickness is not prescribed by any standard — the crash/crush TESTS (ECE R100 Annex 4, GB 38031, UL 2580) are, and the wall must pass them. Headroom keeps the gas path to the vent free. The "Why these spaces exist" note under the sliders has the details.',
      },
      {
        tab: 'analysis', title: '6 · The architecture is part of electrical',
        text: 'Modules (divisor enumeration of S), BMS topology (the diagram changes with your choice), precharge sizing, fuse, DC-DC, the isolation standard (they conflict — you pick), the application\'s communication bus (J1939 / CAN / CANopen / Modbus) and the welding process per cell format. Its findings sit in the Electrical audit, not a silo.',
      },
      {
        tab: 'analysis', title: '6a · The EMS has architectures too',
        text: 'Where your application has an energy management system (storage plants, depots, vessels, fleets), the literature gives three families: centralized (one controller, simplest, single point of failure), hierarchical (three control levels with separate timescales — the IEEE 2030.7 microgrid framing, the default for multi-rack plants), and distributed (droop/price signals, no single failure point). Auto suggests from your stack count; the selector only appears when an EMS exists — a wearable never sees this question.',
      },
      {
        tab: 'therm', title: '6b · The thermal SYSTEM, not just the plate',
        text: 'The cold plate is the tip of a loop: pump, radiator, a refrigerant chiller when you must cool below ambient (owned by the vehicle AC / plant HVAC), a heater branch for winter charging — all run by the BTMS ECU, the third control unit: the BMS protects, the BTMS moves heat, the supervisor decides. The Thermal tab sizes the flow (ṁ = Q/(c_p·ΔT)) and the compressor cost.',
      },
      {
        tab: 'eu', title: '7 · Release rules before release',
        text: 'The Rules tab holds the market release checklist per application (pick EU / US / China / International) — including chemistry-market rules like China\'s e-bus exclusion of NMC — and the EU 2023/1542 timeline with what applies to THIS design.',
      },
      {
        tab: 'results', title: '8 · Stress-test the decision',
        text: 'The report\'s sensitivity table shows what a ±20% change in price, cycle life or duty does to the cost — replacement-pack jumps highlighted — and how far the winner\'s price can rise before the runner-up wins. Ship the PDF/Word to your customer.',
      },
    ],
  },
};
