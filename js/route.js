// route.js — a real journey, as numbers the models can drive.
//
// The tool has always simulated against a load PROFILE: a synthetic speed
// trace, WLTP-class, the same every time. That answers "does this pack survive
// a standard duty". It does not answer the question people actually have,
// which is "does it survive MY route" — the one with the hill outside town, or
// the crossing that always has a headwind.
//
// This turns a route into that answer. A route here is a list of points with a
// position and, where it is known, a height. Everything else — distance,
// gradient, bearing, speed — is derived, because those are the things that
// vary between two people describing the same journey and the things a
// physics model actually needs.
//
// WHERE THE ROUTE COMES FROM, AND WHY NOT GOOGLE.
//
// The obvious answer is to draw a line on Google Maps. Three things argue
// against it, and the third is decisive:
//
//   · Google Maps Platform needs an API key and a billing account, so the
//     tool would stop working the moment someone's card expired.
//   · Their terms restrict using Directions and Elevation data away from a
//     Google map, and restrict storing it — which is precisely what a
//     simulation does with it.
//   · Every part of this tool promises that nothing leaves your machine. A
//     route is not innocent data: a bus operator's actual routes, or a
//     delivery fleet's territory, is commercially sensitive, and sending it
//     to anyone is exactly the thing the customer-cell-library rule exists to
//     prevent.
//
// So a route arrives as a FILE — GPX from a phone, a fleet telematics export,
// a survey — or as points typed in. That is also what makes this a digital
// twin rather than a simulation: it is fed by what the real machine really
// did, not by a line someone drew.
//
// Pure math, no DOM, no network.

const R_EARTH_M = 6371000;
const toRad = (d) => (d * Math.PI) / 180;

/**
 * Great-circle distance between two points, in metres.
 *
 * The haversine form rather than the flat-earth shortcut, because the
 * shortcut's error grows with latitude and the marine legs this has to serve
 * are long enough for it to matter.
 */
export function haversineM(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const s = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH_M * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Initial bearing from a to b, degrees from north. Wind and current need it. */
export function bearingDeg(a, b) {
  const dLon = toRad(b.lon - a.lon);
  const y = Math.sin(dLon) * Math.cos(toRad(b.lat));
  const x = Math.cos(toRad(a.lat)) * Math.sin(toRad(b.lat))
    - Math.sin(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.cos(dLon);
  return (Math.atan2(y, x) * 180) / Math.PI;
}

/**
 * A route from raw points.
 *
 * Segments carry what the models ask for: how far, how steep, which way, and
 * how fast if the points were timestamped. Gradient is the one worth care —
 * consumer GPS height is noisy by several metres per fix, and differentiating
 * noise produces gradients that are pure invention. So it is smoothed over a
 * window, and the raw figure is kept beside it so nobody has to take the
 * smoothing on trust.
 */
export function buildRoute({ points, name = 'Route', smoothMetres = 60 }) {
  if (!Array.isArray(points) || points.length < 2) return null;
  const clean = points.filter((p) => Number.isFinite(p?.lat) && Number.isFinite(p?.lon));
  if (clean.length < 2) return null;

  // Height is optional and often absent. Smoothed before any gradient is
  // taken from it — but over a DISTANCE, not over a count of fixes.
  //
  // That distinction is the whole thing. GPS height error is per-fix and a
  // few metres wide, so averaging five fixes is right for a 1 Hz recording
  // where five fixes span 70 m. Applied to points a kilometre apart it
  // averages away the mountain: on a test climb of 238 m it reported 103 m
  // and lost the descent entirely, which would make every hilly route look
  // cheap. Over a fixed 60 m window a sparse route is left alone, because
  // there is no per-fix noise left to remove at that spacing.
  const hasElevation = clean.some((p) => Number.isFinite(p.eleM));
  const ele = clean.map((p) => (Number.isFinite(p.eleM) ? p.eleM : null));
  // Cumulative distance along the track, so the window can be measured in
  // metres rather than in indices.
  const along = [0];
  for (let i = 1; i < clean.length; i++) along.push(along[i - 1] + haversineM(clean[i - 1], clean[i]));

  const smoothed = ele.map((_, i) => {
    if (!hasElevation) return null;
    const half = smoothMetres / 2;
    let sum = 0, n = 0;
    for (let j = i; j >= 0 && along[i] - along[j] <= half; j--) { if (ele[j] != null) { sum += ele[j]; n++; } }
    for (let j = i + 1; j < ele.length && along[j] - along[i] <= half; j++) { if (ele[j] != null) { sum += ele[j]; n++; } }
    return n ? sum / n : null;
  });

  const segments = [];
  let cumM = 0, climbM = 0, descentM = 0;
  for (let i = 1; i < clean.length; i++) {
    const a = clean[i - 1], b = clean[i];
    const lengthM = haversineM(a, b);
    if (!(lengthM > 0)) continue;             // duplicate fixes are common
    const dEle = smoothed[i] != null && smoothed[i - 1] != null ? smoothed[i] - smoothed[i - 1] : null;
    // Gradient as a percentage of horizontal run — the same convention the
    // vehicle model already takes as gradePct.
    const gradePct = dEle != null ? (dEle / lengthM) * 100 : 0;
    const dtS = Number.isFinite(a.tS) && Number.isFinite(b.tS) && b.tS > a.tS ? b.tS - a.tS : null;
    cumM += lengthM;
    if (dEle != null) { if (dEle > 0) climbM += dEle; else descentM -= dEle; }
    segments.push({
      index: segments.length,
      from: { lat: a.lat, lon: a.lon }, to: { lat: b.lat, lon: b.lon },
      lengthM, cumulativeM: cumM,
      eleM: smoothed[i], deltaEleM: dEle,
      gradePct: Math.max(-30, Math.min(30, gradePct)),
      rawGradePct: dEle != null && ele[i] != null && ele[i - 1] != null
        ? ((ele[i] - ele[i - 1]) / lengthM) * 100 : null,
      bearingDeg: bearingDeg(a, b),
      dtS, speedMps: dtS ? lengthM / dtS : null,
    });
  }
  if (!segments.length) return null;

  const timed = segments.every((s) => s.dtS != null);
  const durationS = timed ? segments.reduce((s, x) => s + x.dtS, 0) : null;
  const grades = segments.map((s) => s.gradePct);

  return {
    name, points: clean, segments,
    hasElevation, timed,
    totals: {
      distanceM: cumM, distanceKm: cumM / 1000,
      climbM: hasElevation ? climbM : null,
      descentM: hasElevation ? descentM : null,
      durationS,
      avgSpeedKph: durationS ? (cumM / durationS) * 3.6 : null,
      maxGradePct: Math.max(...grades),
      minGradePct: Math.min(...grades),
      pointCount: clean.length,
    },
    notes: [
      ...(hasElevation
        ? [`Height smoothed over a ${smoothMetres} m window before any gradient is taken from it — over a DISTANCE, not a count of fixes. GPS height error is per-fix and a few metres wide, so a dense recording gets the smoothing it needs while a sparse route is left alone: averaging by fix count would flatten a mountain recorded a kilometre at a time. The unsmoothed gradient is kept on every segment so this can be checked rather than trusted.`]
        : ['No height data in this route, so every gradient is zero. On anything but flat ground that understates the energy: a climb is paid for in full and only part of it comes back through regeneration.']),
      ...(timed ? [] : ['No timestamps, so this is a shape rather than a drive. Speed has to come from a profile or a limit, and the answer is what the route COULD cost rather than what it did.']),
    ],
  };
}

/**
 * Parse GPX. Track points first, then route points — a recorded track is the
 * real thing and a planned route is an intention, so where a file has both,
 * the record wins.
 *
 * Deliberately a small regex reader rather than an XML parser: it runs
 * identically in Node and the browser with nothing added, and GPX is regular
 * enough that the strictness buys nothing.
 */
export function parseGpx(xml) {
  if (typeof xml !== 'string' || !/<gpx/i.test(xml)) return null;
  const name = (xml.match(/<name>([^<]*)<\/name>/i) || [])[1]?.trim() || 'Imported route';
  const pick = (tag) => {
    const out = [];
    const re = new RegExp(`<${tag}[^>]*lat="([-\\d.]+)"[^>]*lon="([-\\d.]+)"[^>]*>([\\s\\S]*?)<\\/${tag}>|<${tag}[^>]*lat="([-\\d.]+)"[^>]*lon="([-\\d.]+)"[^>]*\\/>`, 'gi');
    let m;
    while ((m = re.exec(xml)) !== null) {
      const lat = parseFloat(m[1] ?? m[4]);
      const lon = parseFloat(m[2] ?? m[5]);
      const body = m[3] || '';
      const eleM = parseFloat((body.match(/<ele>([-\d.]+)<\/ele>/i) || [])[1]);
      const time = (body.match(/<time>([^<]+)<\/time>/i) || [])[1];
      const tS = time ? Date.parse(time) / 1000 : NaN;
      out.push({
        lat, lon,
        ...(Number.isFinite(eleM) ? { eleM } : {}),
        ...(Number.isFinite(tS) ? { tS } : {}),
      });
    }
    return out;
  };
  const points = pick('trkpt').length ? pick('trkpt') : pick('rtept');
  if (points.length < 2) return null;
  // Timestamps are absolute; the models want seconds from the start.
  const t0 = points.find((p) => Number.isFinite(p.tS))?.tS;
  if (t0 != null) for (const p of points) if (Number.isFinite(p.tS)) p.tS -= t0;
  return buildRoute({ points, name });
}

/**
 * A route as a speed trace the existing models already understand.
 *
 * This is the seam that makes the whole thing cheap: `driveCyclePower` has
 * always taken a trace and a gradient, so a route does not need a new physics
 * model — it needs to become a trace. Where the route was timed, the speeds
 * are what was actually driven. Where it was not, a target speed is applied
 * and the answer is what the route WOULD cost.
 */
export function routeToTrace(route, { targetKph = null, dtS = 1 } = {}) {
  if (!route?.segments?.length) return null;
  const v = [], grade = [];
  for (const seg of route.segments) {
    const mps = route.timed && seg.speedMps != null
      ? seg.speedMps
      : (targetKph != null ? targetKph / 3.6 : 13.9);   // 50 km/h if nothing says otherwise
    if (!(mps > 0)) continue;
    const steps = Math.max(1, Math.round(seg.lengthM / mps / dtS));
    // The existing trace convention is km/h — driveCyclePower divides by 3.6 —
    // so emit km/h here rather than the m/s the route works in. Getting this
    // wrong understates every speed by 3.6x and every aerodynamic term by
    // roughly thirteen, which would have looked like a suspiciously efficient
    // vehicle rather than like a bug.
    for (let i = 0; i < steps; i++) { v.push(mps * 3.6); grade.push(seg.gradePct); }
  }
  if (!v.length) return null;
  return {
    id: 'route', name: route.name, dtS, v, grade,
    distanceM: route.totals.distanceM,
    estimated: !route.timed,
  };
}

/** Sanity for the tests, and for anyone handed a file of unknown provenance. */
export function validateRoute(route) {
  const errors = [];
  if (!route?.segments?.length) return ['no segments'];
  for (const s of route.segments) {
    if (!(s.lengthM > 0)) errors.push(`segment ${s.index}: zero length`);
    if (!Number.isFinite(s.gradePct)) errors.push(`segment ${s.index}: gradient is not a number`);
  }
  // A route whose points jump implausibly far between fixes is usually two
  // journeys concatenated, and simulating it as one is nonsense.
  const jumps = route.segments.filter((s) => s.lengthM > 20000);
  if (jumps.length) {
    errors.push(`${jumps.length} segment(s) jump over 20 km between consecutive points — this is usually two journeys in one file, or a dropped signal`);
  }
  return errors;
}
