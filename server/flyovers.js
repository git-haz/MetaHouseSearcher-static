'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');

// CAA Table 03.1: annual aircraft movements for licensed UK airports (2024/25)
// One "movement" = one takeoff OR one landing
const CAA_MOVEMENTS = {
  EGLL: 478000, // Heathrow
  EGKK: 280000, // Gatwick
  EGCC: 175000, // Manchester
  EGSS: 168000, // Stansted
  EGGW: 122000, // Luton
  EGBB: 100000, // Birmingham
  EGPH: 94000,  // Edinburgh
  EGPF: 74000,  // Glasgow
  EGGD: 65000,  // Bristol
  EGNX: 56000,  // East Midlands
  EGNT: 50000,  // Newcastle
  EGAA: 55000,  // Belfast International
  EGAC: 35000,  // Belfast City
  EGPD: 44000,  // Aberdeen
  EGFF: 24000,  // Cardiff
  EGHI: 30000,  // Southampton
  EGTE: 34000,  // Exeter
  EGSH: 20000,  // Norwich
  EGNV: 14000,  // Teesside
  EGNH: 20000,  // Blackpool
  EGHH: 15000,  // Bournemouth
  EGPK: 25000,  // Prestwick
  EGPE: 15000,  // Inverness
  EGJJ: 50000,  // Jersey
  EGJB: 30000,  // Guernsey
  EGJA: 14000,  // Alderney
  EGPO: 10000,  // Stornoway
  EGPA: 8000,   // Kirkwall
  EGPB: 8000,   // Sumburgh
  EGPL: 5000,   // Benbecula
  EGEW: 5000,   // Wick
  EGKB: 22000,  // Biggin Hill (busy GA/biz-jet)
  EGLF: 38000,  // Farnborough (biz-jet)
  EGWU: 25000,  // Northolt (RAF/VIP)
  EGBJ: 30000,  // Gloucestershire
  EGBK: 35000,  // Sywell (busy GA club)
  EGBP: 25000,  // Kemble/Cotswold
  EGSU: 28000,  // Duxford
  // Military bases — from Environmental Impact Statements, HC Written Answers, published flying rates
  EGXC: 25000,  // RAF Coningsby (Typhoon QRA + OCU)
  EGYM: 20000,  // RAF Marham (F-35B Wing)
  EGXW: 15000,  // RAF Waddington (ISR/Rivet Joint/Sentry)
  EGXE: 20000,  // RAF Leeming (Hawk T1 FTS)
  EGYD: 20000,  // RAF Cranwell (Prefect/Tutor FTS)
  EGOS: 22000,  // RAF Shawbury (rotary FTS — high sortie rate)
  EGOV: 25000,  // RAF Valley (Hawk advanced training)
  EGVN: 15000,  // RAF Brize Norton (A400M/C-17/A330 tankers)
  EGDY: 15000,  // RNAS Yeovilton (F-35B/Wildcat/Merlin)
  EGDR: 15000,  // RNAS Culdrose (Merlin HM2 — ASW training)
  EGUL: 18000,  // RAF Lakenheath (F-35A, USAF 48th FW)
  EGVJ: 12000,  // RAF Wittering (Tucano/Prefect)
  EGVO: 12000,  // RAF Odiham (Chinook Wing)
  EGBE: 10000,  // Coventry (ex-RAF, now commercial/GA)
};

// Estimated daily transits per corridor (sorties that transit the full width)
// Sources: published Environmental Management Plans, HC Written Answers, MOD EIS documents
const CORRIDOR_DAILY_TRANSITS = {
  'COR-V01': 6,  // Odiham→Salisbury Plain Chinook supply: daily support ops
  'COR-V02': 8,  // Coningsby→Donna Nook range run: frequent Typhoon/Hawk weapons training
  'COR-V03': 8,  // Coningsby→Holbeach range: Typhoon/F-15/F-35 weapons training
  'COR-V04': 6,  // Marham→Holbeach F-35B: regular weapons and sensor training
  'COR-V05': 4,  // Lakenheath→Holbeach USAF: F-35A/F-15E range transits
  'COR-V06': 3,  // Coningsby→Spadeadam EW training: less frequent, long transit
  'COR-E01': 3,  // Culdrose→Dartmoor: Merlin/Wildcat nav training
  'COR-E02': 4,  // Yeovilton→Dartmoor: F-35B/Wildcat nav training
  'COR-E03': 4,  // Yeovilton→Salisbury Plain: F-35B/helicopter support
  'COR-E04': 3,  // Brize Norton→Salisbury Plain: Chinook/A400M support
  'COR-E05': 4,  // Benson→Salisbury Plain: Puma daily ops
  'COR-E06': 5,  // Leeming→Otterburn: Hawk training, Apache exercises
  'COR-E07': 3,  // Leeming→Spadeadam: Hawk/Typhoon EW training
  'COR-E08': 6,  // Shawbury→Nesscliffe: daily helicopter student nav sorties
  'COR-E09': 4,  // Honington→Stanford STANTA: Chinook/Merlin army support
  'COR-E10': 2,  // Lakenheath→Stanford STANTA (SOF): CV-22/HH-60, less frequent
  'COR-E11': 3,  // Wittering→Catterick: Chinook/Puma support
  'COR-E12': 4,  // Leeming→Warcop: Hawk training and Apache exercises
  'COR-E13': 3,  // Culdrous→Plymouth Sound: Merlin/Wildcat maritime training
  'COR-E14': 6,  // Coningsby→Cowden Range: Typhoon weapons training
  'COR-E15': 2,  // Northolt→Salisbury Plain: VIP/admin flights
};

// Ray-casting point-in-polygon — polygon is [[lat,lon], ...]
function pointInPolygon(lat, lon, polygon) {
  let inside = false;
  const n = polygon.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const [yi, xi] = polygon[i];
    const [yj, xj] = polygon[j];
    if (((yi > lat) !== (yj > lat)) &&
        (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}

const ZONES_PATH = path.join(__dirname, '..', 'docs', 'military-zones.json');
let _zonesCache = null;
function loadZones() {
  if (_zonesCache) return _zonesCache;
  try { _zonesCache = JSON.parse(fs.readFileSync(ZONES_PATH, 'utf8')); }
  catch { _zonesCache = { lfas: [], corridors: [] }; }
  return _zonesCache;
}

// Estimated annual movements for facility types without CAA data
function facilityFlightsPerDay(facility) {
  if (facility.icao && CAA_MOVEMENTS[facility.icao]) {
    return CAA_MOVEMENTS[facility.icao] / 365;
  }
  if (!facility.active) return 0.5; // closed but occasional use (ferrying, emergency)

  const { category, usage } = facility;
  if (category === 'airport') {
    if (usage === 'commercial') return 50;  // unlisted regional commercial
    if (usage === 'military')  return 20;   // military airbase
    return 15;                               // private/mixed-use airport
  }
  if (category === 'airstrip') {
    if (usage === 'commercial') return 15;
    if (usage === 'military')   return 12;
    return 5;                                // typical GA club strip ~1,825 movements/year
  }
  if (category === 'heliport') {
    if (usage === 'military')   return 8;
    if (usage === 'commercial') return 5;   // offshore transfers, hospital HEMS
    return 1;                                // private/occasional (racecourse, estate)
  }
  return 3; // unknown type
}

// Per-movement noise-impact weight: higher = more audible per flight
// Jets/turboprops are louder per event and fly predictable overhead corridors;
// helicopters are locally loud but confined; small GA propeller aircraft quieter overall
function facilityTypeWeight(facility) {
  if (!facility.active) return 0.05;
  const { category, usage } = facility;
  if (category === 'airport' && usage === 'commercial') return 1.0;
  if (category === 'airport' && usage === 'military')   return 0.85;
  if (category === 'airport')                            return 0.7;
  if (category === 'airstrip' && usage === 'military')  return 0.5;
  if (category === 'airstrip')                           return 0.25; // small propeller aircraft
  if (category === 'heliport' && usage === 'commercial') return 0.55;
  if (category === 'heliport')                           return 0.3;
  return 0.25;
}

function haversineDistMiles(lat1, lon1, lat2, lon2) {
  const R = 3958.8;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Compute per-property flyover index directly from the full facility list.
// Returns { flightsPerDay, commercial, ga, military, topFacilities[] }
// The index is the inverse-square weighted sum of (facility flightsPerDay × type weight)
// across all active facilities within RADIUS_MILES, rounded to 1 d.p.
function computeFacilityFlyover(lat, lon, airportsArr) {
  const RADIUS_MILES = 30;
  let commercial = 0, ga = 0, military = 0;
  const contributions = [];

  for (const facility of airportsArr) {
    if (facility.lat == null || facility.lon == null) continue;
    const dist = Math.max(haversineDistMiles(lat, lon, facility.lat, facility.lon), 0.3);
    if (dist > RADIUS_MILES) continue;

    const fpd = facilityFlightsPerDay(facility);
    const tw  = facilityTypeWeight(facility);
    const raw = (fpd * tw) / (dist * dist);

    const { usage, category } = facility;
    if (usage === 'military') {
      military += raw;
    } else if (category === 'airport' && usage === 'commercial') {
      commercial += raw;
    } else if (category === 'airstrip' && usage === 'commercial') {
      commercial += raw;
    } else {
      ga += raw;
    }

    if (facility.active !== false) {
      contributions.push({ name: facility.name, icao: facility.icao || null, category, usage, distMiles: Math.round(dist * 10) / 10, contribution: raw });
    }
  }

  // Military Low Flying Areas — add LFA traffic for properties inside the polygon
  // Use the published low-end daily flights estimate (conservative: individual locations
  // see fewer sorties than the LFA-wide total).
  const zones = loadZones();
  const zoneContributions = [];

  for (const lfa of (zones.lfas || [])) {
    if (!lfa.polygon || !lfa.dailyFlights) continue;
    if (!pointInPolygon(lat, lon, lfa.polygon)) continue;
    const fpd = typeof lfa.dailyFlights === 'object'
      ? lfa.dailyFlights.low        // conservative: low end of published range
      : lfa.dailyFlights;
    military += fpd;
    zoneContributions.push({ name: lfa.name, id: lfa.id, type: 'LFA', fpd });
  }

  // Military corridors — property on a regular transit route sees the daily traffic
  for (const cor of (zones.corridors || [])) {
    if (!cor.polygon) continue;
    if (!pointInPolygon(lat, lon, cor.polygon)) continue;
    const fpd = CORRIDOR_DAILY_TRANSITS[cor.id] || 4; // default 4/day if unknown
    military += fpd;
    zoneContributions.push({ name: cor.name, id: cor.id, type: 'corridor', fpd });
  }

  contributions.sort((a, b) => b.contribution - a.contribution);

  const round1 = v => Math.round(v * 10) / 10;
  return {
    flightsPerDay: round1(commercial + ga + military),
    commercial:    round1(commercial),
    ga:            round1(ga),
    military:      round1(military),
    topFacilities: [
      ...contributions.slice(0, 5).map(c => ({
        name: c.name, icao: c.icao, category: c.category, usage: c.usage, distMiles: c.distMiles,
      })),
      ...zoneContributions.map(z => ({
        name: z.name, icao: null, category: z.type, usage: 'military', distMiles: null,
      })),
    ].slice(0, 7),
    method: 'facility-direct',
  };
}

// ---- Reference-based fallback (used when property has no coordinates) ----
const REF_PATH = path.join(__dirname, '..', 'data', 'flyover-reference.json');

function loadReference() {
  try { return JSON.parse(fs.readFileSync(REF_PATH, 'utf8')); }
  catch { return null; }
}

function lookupFlyoverForProperty(property, searchLocations, ref) {
  if (!ref || !ref.locations) return null;
  if (property.sourceLocation) {
    const key = property.sourceLocation.toLowerCase();
    if (ref.locations[key]) return ref.locations[key];
  }
  const addr = (property.address || '').toLowerCase();
  for (const loc of searchLocations) {
    const key = loc.toLowerCase();
    if (addr.includes(key) && ref.locations[key]) return ref.locations[key];
  }
  if (property.lat != null) {
    let closest = null, minDist = Infinity;
    for (const data of Object.values(ref.locations)) {
      if (data.lat == null) continue;
      const d = haversineDistMiles(property.lat, property.lon, data.lat, data.lon);
      if (d < minDist) { minDist = d; closest = data; }
    }
    return closest;
  }
  return null;
}

// ---- Main entry point called by build.js ----
// airportsArr: the full facility array from airports.json
function attachFlyoverData(results, searchLocations, airportsArr) {
  const ref = loadReference();
  const locNames = (searchLocations || []).map(l => l.toLowerCase());
  const hasAirports = Array.isArray(airportsArr) && airportsArr.length > 0;

  for (const r of results) {
    if (r.lat != null && hasAirports) {
      // Per-property direct calculation from the full facility list (Option 2)
      const data = computeFacilityFlyover(r.lat, r.lon, airportsArr);
      r.flyoverRef = {
        ...data,
        generatedAt: new Date().toISOString(),
        interpolated: false,
      };
    } else if (ref) {
      // Fallback: reference centroid lookup (no-coords or no airport data)
      const data = lookupFlyoverForProperty(r, locNames, ref);
      if (data) {
        r.flyoverRef = {
          location: data.location,
          flightsPerDay: data.flightsPerDay,
          commercial: null,
          ga: null,
          military: null,
          avgUkFlightsPerHour: data.avgUkFlightsPerHour,
          seasonalFlag: data.seasonalFlag,
          monthly: data.monthly,
          seasonalDetail: data.seasonalDetail,
          generatedAt: ref.generatedAt,
          interpolated: true,
          method: 'reference-centroid',
        };
      }
    }
  }
}

function get(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'PropertySearchApp/1.0' }, timeout: 30000 }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode === 403) return reject(new Error('403 Forbidden'));
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('Invalid JSON')); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function calculateFlyovers(lat, lon) {
  const now = Math.floor(Date.now() / 1000);
  const windows = [
    { label: 'recent',  begin: now - 7200,     end: now },
    { label: 'mid',     begin: now - 7200 * 2, end: now - 7200 },
    { label: 'earlier', begin: now - 7200 * 3, end: now - 7200 * 2 },
  ];
  const results = [];
  let totalUkFlights = 0, totalHours = 0;
  for (const w of windows) {
    try {
      const flights = await get(`https://opensky-network.org/api/flights/all?begin=${w.begin}&end=${w.end}`);
      if (!Array.isArray(flights)) { results.push({ label: w.label, ukFlights: 0, error: true }); continue; }
      const ukFlights = flights.filter(f =>
        (f.estDepartureAirport && f.estDepartureAirport.startsWith('EG')) ||
        (f.estArrivalAirport   && f.estArrivalAirport.startsWith('EG'))
      ).length;
      results.push({ label: w.label, total: flights.length, ukFlights, error: false });
      totalUkFlights += ukFlights;
      totalHours += 2;
    } catch {
      results.push({ label: w.label, ukFlights: 0, error: true });
    }
    await sleep(1200);
  }
  const flightsPerDay = totalHours > 0 ? Math.round((totalUkFlights / totalHours) * 24 * 10) / 10 : 0;
  return { lat, lon, windows: results, flightsPerDay, totalUkFlights, hourssampled: totalHours, calculatedAt: new Date().toISOString() };
}

module.exports = { calculateFlyovers, attachFlyoverData, loadReference, computeFacilityFlyover };
