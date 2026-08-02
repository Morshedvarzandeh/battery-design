// excel.js — the engineer's workbook. Engineers trust spreadsheets they can
// interrogate, so this export is not a dump of numbers: it is a SpreadsheetML
// (Excel 2003 XML) workbook whose computed cells carry LIVE formulas over
// named input cells (=PackCost/ThroughputKWh, =CEILING(...)). Change a yellow
// input and the whole chain recomputes in Excel/LibreOffice — the reader can
// check every step against their own formulas, and the "Your value" column +
// Feedback sheet turn the checked file into feedback we learn from.
//
// No dependencies, no binary format: one XML string, generated client-side.
// The feedback address is passed in at runtime (never hardcoded here).

const XMLH = `<?xml version="1.0"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:o="urn:schemas-microsoft-com:office:office"
 xmlns:x="urn:schemas-microsoft-com:office:excel"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:html="http://www.w3.org/TR/REC-html40">
<Styles>
 <Style ss:ID="t"><Font ss:Bold="1" ss:Size="13"/></Style>
 <Style ss:ID="hd"><Font ss:Bold="1"/><Interior ss:Color="#E7EEEC" ss:Pattern="Solid"/></Style>
 <Style ss:ID="in"><Interior ss:Color="#FFF4CC" ss:Pattern="Solid"/>
  <Borders><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#D8CDA0"/></Borders></Style>
 <Style ss:ID="calc"><Interior ss:Color="#EAF3F0" ss:Pattern="Solid"/></Style>
 <Style ss:ID="mut"><Font ss:Color="#707A74" ss:Size="9"/></Style>
 <Style ss:ID="link"><Font ss:Color="#0B6E5F" ss:Underline="Single"/></Style>
</Styles>`;

const xesc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[ch]));

const cellXml = ({ v = null, num = false, style = null, formula = null, href = null } = {}) => {
  const attrs =
    (style ? ` ss:StyleID="${style}"` : '') +
    (formula ? ` ss:Formula="${xesc(formula)}"` : '') +
    (href ? ` ss:HRef="${xesc(href)}"` : '');
  if (v == null && !formula) return `<Cell${attrs}/>`;
  const type = num ? 'Number' : 'String';
  const val = num ? (v == null || !isFinite(v) ? 0 : v) : xesc(v);
  return `<Cell${attrs}><Data ss:Type="${type}">${val}</Data></Cell>`;
};
const rowXml = (cells) => `<Row>${cells.map(cellXml).join('')}</Row>`;

// One computed row: label | live formula | unit | the formula written out |
// an empty yellow "Your value" cell for the reader's own number.
const calcRow = (label, formula, value, unit, asWritten) => rowXml([
  { v: label },
  { formula, v: value, num: true, style: 'calc' },
  { v: unit, style: 'mut' },
  { v: asWritten, style: 'mut' },
  { v: null, style: 'in' },
]);
const headRow = () => rowXml([
  { v: 'Quantity', style: 'hd' }, { v: 'Value (live formula)', style: 'hd' },
  { v: 'Unit', style: 'hd' }, { v: 'Formula as written', style: 'hd' },
  { v: 'Your value (edit me)', style: 'hd' },
]);
const titleRow = (t) => rowXml([{ v: t, style: 't' }]);
const noteRow = (t) => rowXml([{ v: t, style: 'mut' }]);
const sheet = (name, cols, rows) =>
  `<Worksheet ss:Name="${xesc(name)}"><Table>` +
  cols.map((w) => `<Column ss:Width="${w}"/>`).join('') +
  rows.join('\n') + `</Table></Worksheet>`;

// The named INPUT cells — fixed layout so the names always resolve.
// [name, label, value(R)=>number, unit, note]
const INPUTS = [
  ['CellPrice', 'Cell price', (R) => R.cell.priceUSD, 'USD/cell', 'library estimate — replace with your quote'],
  ['SCount', 'Series count S', (R) => R.summary.s, '', ''],
  ['PCount', 'Parallel count P', (R) => R.summary.p, '', ''],
  ['VNom', 'Cell nominal voltage', (R) => R.cell.nominalV, 'V', ''],
  ['CapAh', 'Cell capacity', (R) => R.cell.capacityAh, 'Ah', ''],
  ['CellMassG', 'Cell mass', (R) => R.cell.massG, 'g', ''],
  ['DoD', 'Usable depth of discharge', (R) => R.usage?.dod, 'fraction', '0–1'],
  ['CyclesYr', 'Cycles per year', (R) => R.usage?.cyclesPerYear, '1/yr', 'from the duty cycle'],
  ['Years', 'Service target', (R) => R.usage?.targetYears, 'yr', ''],
  ['CycleLife', 'Cell cycle life', (R) => R.cell.cycleLife, 'cycles', 'to 80% capacity, datasheet class'],
  ['GridG', 'Displaced source intensity', (R) => R.co2?.gridGPerKWh, 'g CO2e/kWh', ''],
  ['MfgFactor', 'Manufacturing footprint', (R) => R.co2?.mfgFactor, 'kg CO2e/kWh', 'chemistry-class estimate'],
  ['HeatW', 'Continuous heat at max load', (R) => R.thermal?.heatContW, 'W', 'I²R at max continuous'],
  ['CpKJ', 'Coolant specific heat', (R) => R.thermal?.coolant?.cpKJperKgK, 'kJ/(kg·K)', '50/50 water-glycol'],
  ['RhoKgL', 'Coolant density', (R) => R.thermal?.coolant?.rhoKgPerL, 'kg/L', ''],
  ['DTK', 'Design coolant ΔT', (R) => R.thermal?.coolant?.dTdesignK, 'K', 'inlet→outlet rise'],
  ['COP', 'Chiller COP', (R) => R.thermal?.chillerCOP, '', 'conservative automotive class'],
];
const INPUT_START_ROW = 4; // title, note, blank, header, then data

export function buildWorkbookXml(R, { feedbackEmail = null, appUrl = 'https://morshedvarzandeh.github.io/battery-design/' } = {}) {
  const names = INPUTS.map(([name], i) =>
    `<NamedRange ss:Name="${name}" ss:RefersTo="=Inputs!R${INPUT_START_ROW + 1 + i}C2"/>`).join('\n ');

  const inputsSheet = sheet('Inputs', [170, 90, 90, 200, 110], [
    titleRow(`Inputs — ${R.application} · ${R.summary.s}S${R.summary.p}P · ${R.cell.name}`),
    noteRow('Yellow cells are the inputs. Change any of them — every sheet recomputes. Generated ' + R.date + '.'),
    rowXml([]),
    rowXml([{ v: 'Input (named cell)', style: 'hd' }, { v: 'Value', style: 'hd' }, { v: 'Unit', style: 'hd' }, { v: 'Note', style: 'hd' }, { v: 'Name', style: 'hd' }]),
    ...INPUTS.map(([name, label, get, unit, note]) => rowXml([
      { v: label },
      { v: get(R) ?? null, num: true, style: 'in' },
      { v: unit, style: 'mut' },
      { v: note, style: 'mut' },
      { v: name, style: 'mut' },
    ])),
  ]);

  const S = R.summary;
  const packSheet = sheet('Pack', [170, 110, 90, 250, 110], [
    titleRow('Pack — electrical build-up from the cell'),
    noteRow('Every value is a live formula over the named Inputs cells.'),
    rowXml([]),
    headRow(),
    calcRow('Cell count', '=SCount*PCount', S.cellCount, 'cells', 'N = S × P'),
    calcRow('Nominal voltage', '=SCount*VNom', S.nominalV, 'V', 'V_nom = S × V_cell'),
    calcRow('Capacity', '=PCount*CapAh', S.capacityAh, 'Ah', 'Ah = P × Ah_cell'),
    calcRow('Energy', '=SCount*PCount*VNom*CapAh', S.energyWh, 'Wh', 'E = S × P × V_cell × Ah_cell'),
    calcRow('Cells mass', '=SCount*PCount*CellMassG/1000', (S.cellCount * (R.cell.massG ?? 0)) / 1000, 'kg', 'm = N × m_cell / 1000'),
  ]);

  const C = R.cost || {};
  const econSheet = sheet('Economics', [170, 110, 90, 320, 110], [
    titleRow('Economics — the lifetime cost chain'),
    noteRow('The TCO logic: cells are bought again when the duty outlives the cycle life.'),
    rowXml([]),
    headRow(),
    calcRow('Pack cost (cells)', '=CellPrice*SCount*PCount', C.upfrontUSD, 'USD', 'cost = price × N'),
    calcRow('Cost per kWh capacity', '=CellPrice*SCount*PCount/(SCount*PCount*VNom*CapAh/1000)', C.usdPerKWhCap, 'USD/kWh', 'cost / (E/1000)'),
    calcRow('Lifetime throughput', '=CycleLife*(SCount*PCount*VNom*CapAh)*DoD/1000', C.throughputKWh, 'kWh', 'cycle life × E × DoD / 1000'),
    calcRow('Cost per kWh DELIVERED', '=(CellPrice*SCount*PCount)/(CycleLife*(SCount*PCount*VNom*CapAh)*DoD/1000)', C.usdPerKWhDelivered, 'USD/kWh', 'cost / throughput — the honest number'),
    calcRow('Service life of one pack', '=CycleLife/CyclesYr', C.serviceYears, 'yr', 'cycle life / cycles-per-year'),
    calcRow('Packs needed over target', '=MAX(1,CEILING(CyclesYr*Years/CycleLife,1))', C.replacements, 'packs', 'ceil(cycles needed / cycle life), min 1'),
    calcRow('Lifetime cost (TCO)', '=CellPrice*SCount*PCount*MAX(1,CEILING(CyclesYr*Years/CycleLife,1))', C.tcoUSD, 'USD', 'pack cost × packs needed'),
  ]);

  const E = R.co2 || {};
  const co2Sheet = sheet('CO2', [170, 110, 90, 320, 110], [
    titleRow('CO2 — manufacturing footprint vs displaced emissions'),
    noteRow('Class estimates for comparing options — not an audited LCA.'),
    rowXml([]),
    headRow(),
    calcRow('Manufacturing footprint', '=(SCount*PCount*VNom*CapAh/1000)*MfgFactor', E.mfgKgPerPack, 'kg CO2e', '(E/1000) × factor'),
    calcRow('Delivered per cycle', '=SCount*PCount*VNom*CapAh*DoD/1000', E.deliveredKWhPerPack != null && E.capacityKWh ? (E.deliveredKWhPerPack / (R.cell.cycleLife || 1)) : null, 'kWh', 'E × DoD / 1000'),
    calcRow('Delivered over cell life', '=CycleLife*SCount*PCount*VNom*CapAh*DoD/1000', E.deliveredKWhPerPack, 'kWh', 'cycle life × per-cycle'),
    calcRow('Avoided over cell life', '=CycleLife*SCount*PCount*VNom*CapAh*DoD/1000*GridG/1000', E.avoidedKgPerPack, 'kg CO2e', 'delivered × grid intensity / 1000'),
    calcRow('Net over cell life', '=CycleLife*SCount*PCount*VNom*CapAh*DoD/1000*GridG/1000-(SCount*PCount*VNom*CapAh/1000)*MfgFactor', E.netKgPerPack, 'kg CO2e', 'avoided − manufacturing'),
    calcRow('Payback point', '=((SCount*PCount*VNom*CapAh/1000)*MfgFactor)/(SCount*PCount*VNom*CapAh*DoD/1000*GridG/1000)', E.paybackCycles, 'cycles', 'mfg / avoided-per-cycle'),
    calcRow('Payback in years', '=(((SCount*PCount*VNom*CapAh/1000)*MfgFactor)/(SCount*PCount*VNom*CapAh*DoD/1000*GridG/1000))/CyclesYr', E.paybackYears, 'yr', 'payback cycles / cycles-per-year'),
  ]);

  const T = R.thermal;
  const thermalSheet = T && (T.flowLpm != null || T.compressorKW != null) ? sheet('Thermal', [170, 110, 90, 320, 110], [
    titleRow('Thermal — first-order loop sizing'),
    noteRow('ṁ = Q / (c_p · ρ · ΔT); the chiller compressor is duty / COP.'),
    rowXml([]),
    headRow(),
    ...(T.flowLpm != null ? [calcRow('Coolant flow', '=(HeatW/1000)/(CpKJ*RhoKgL*DTK)*60', T.flowLpm, 'L/min', 'Q[kW] / (c_p × ρ × ΔT) × 60')] : []),
    ...(T.compressorKW != null ? [
      calcRow('Chiller duty', '=HeatW/1000', T.chillerKW, 'kW', 'the continuous heat, in kW'),
      calcRow('Compressor electrical', '=(HeatW/1000)/COP', T.compressorKW, 'kW', 'duty / COP — paid by the higher system'),
    ] : []),
  ]) : '';

  const fb = [];
  fb.push(titleRow('Feedback — check us, then teach us'));
  fb.push(noteRow('This workbook is meant to be argued with.'));
  fb.push(rowXml([]));
  fb.push(rowXml([{ v: '1.', style: 'hd' }, { v: 'Change the yellow Inputs — every sheet recomputes live.' }]));
  fb.push(rowXml([{ v: '2.', style: 'hd' }, { v: 'Put your own numbers/formulas in the "Your value" column wherever you disagree.' }]));
  fb.push(rowXml([{ v: '3.', style: 'hd' }, { v: 'Send the edited file back — your corrections update the tool and its data. That is the loop.' }]));
  fb.push(rowXml([]));
  if (feedbackEmail) {
    fb.push(rowXml([{ v: 'Email', style: 'hd' },
      { v: feedbackEmail, style: 'link', href: `mailto:${feedbackEmail}?subject=${encodeURIComponent(`battery-design workbook feedback — ${R.application} ${R.summary.s}S${R.summary.p}P`)}` }]));
  }
  fb.push(rowXml([{ v: 'App', style: 'hd' }, { v: appUrl, style: 'link', href: appUrl }]));
  fb.push(rowXml([{ v: 'Issues', style: 'hd' },
    { v: 'github.com/Morshedvarzandeh/battery-design/issues', style: 'link', href: 'https://github.com/Morshedvarzandeh/battery-design/issues' }]));
  const feedbackSheet = sheet('Feedback', [70, 460], fb);

  return `${XMLH}\n<Names>\n ${names}\n</Names>\n` +
    [inputsSheet, packSheet, econSheet, co2Sheet, thermalSheet, feedbackSheet].filter(Boolean).join('\n') +
    '\n</Workbook>';
}

export function workbookFilename(R) {
  return `pack-workbook-${R.cell.id}-${R.summary.s}s${R.summary.p}p.xls`;
}
