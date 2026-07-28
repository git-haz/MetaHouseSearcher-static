#!/usr/bin/env node

// Build flyover reference data from CAA airport movement statistics.
// No API calls needed — uses downloaded CAA CSV + local airports database.
//
// Usage: node server/buildFlyoverFromCAA.js
//
// Output: public/flyover-reference.json

const fs = require('fs');
const path = require('path');
const config = require('./config');
const { geocodeResults } = require('./geocode');
const { loadAirports } = require('./airports');

const OUTPUT_PATH = path.join(__dirname, '..', 'public', 'flyover-reference.json');
const RADIUS_MILES = 20;

// CAA 2025 annual movement data (from Table 03.1 & 03.2)
// All UK reporting airports
const CAA_DATA = {
  // London Area
  'HEATHROW':       { icao: 'EGLL', total: 479996, transport: 477917, private: 310,   military: 2,    aeroClub: 0,     lat: 51.4700, lon: -0.4543 },
  'GATWICK':        { icao: 'EGKK', total: 263113, transport: 259391, private: 0,     military: 2,    aeroClub: 0,     lat: 51.1481, lon: -0.1903 },
  'STANSTED':       { icao: 'EGSS', total: 194881, transport: 188351, private: 0,     military: 37,   aeroClub: 0,     lat: 51.885,  lon: 0.235 },
  'LUTON':          { icao: 'EGGW', total: 134763, transport: 105060, private: 110,   military: 0,    aeroClub: 0,     lat: 51.8747, lon: -0.3683 },
  'LONDON CITY':    { icao: 'EGLC', total: 50992,  transport: 50098,  private: 0,     military: 0,    aeroClub: 0,     lat: 51.5053, lon: 0.0553 },
  'SOUTHEND':       { icao: 'EGMC', total: 30728,  transport: 5551,   private: 8776,  military: 165,  aeroClub: 12879, lat: 51.5714, lon: 0.6956 },
  'LONDON HELIPORT':{ icao: 'EGLW', total: 8976,   transport: 2820,   private: 2342,  military: 64,   aeroClub: 0,     lat: 51.4700, lon: -0.1789 },
  'BIGGIN HILL':    { icao: 'EGKB', total: 36286,  transport: 14580,  private: 5600,  military: 6,    aeroClub: 3957,  lat: 51.3308, lon: 0.0325 },
  'FARNBOROUGH':    { icao: 'EGLF', total: 31316,  transport: 15250,  private: 103,   military: 90,   aeroClub: 378,   lat: 51.2758, lon: -0.7764 },
  // South East
  'LYDD':           { icao: 'EGMD', total: 29348,  transport: 99,     private: 10528, military: 82,   aeroClub: 12957, lat: 50.9561, lon: 0.9392 },
  'SHOREHAM':       { icao: 'EGKA', total: 33610,  transport: 240,    private: 9036,  military: 176,  aeroClub: 22771, lat: 50.8356, lon: -0.2972 },
  'SOUTHAMPTON':    { icao: 'EGHI', total: 20092,  transport: 15960,  private: 0,     military: 36,   aeroClub: 5,     lat: 50.9503, lon: -1.3567 },
  'BOURNEMOUTH':    { icao: 'EGHH', total: 24861,  transport: 10337,  private: 4257,  military: 624,  aeroClub: 1884,  lat: 50.78,   lon: -1.8425 },
  // East
  'NORWICH':        { icao: 'EGSH', total: 26493,  transport: 13997,  private: 2799,  military: 208,  aeroClub: 4244,  lat: 52.6758, lon: 1.2828 },
  'CAMBRIDGE':      { icao: 'EGSC', total: 20609,  transport: 0,      private: 1007,  military: 181,  aeroClub: 15162, lat: 52.2053, lon: 0.1751 },
  // Midlands & North
  'BIRMINGHAM':     { icao: 'EGBB', total: 99140,  transport: 92960,  private: 206,   military: 55,   aeroClub: 0,     lat: 52.4539, lon: -1.7480 },
  'EAST MIDLANDS':  { icao: 'EGNX', total: 59874,  transport: 43089,  private: 600,   military: 28,   aeroClub: 0,     lat: 52.8311, lon: -1.3281 },
  'COVENTRY':       { icao: 'EGBE', total: 18712,  transport: 27,     private: 2274,  military: 31,   aeroClub: 0,     lat: 52.3697, lon: -1.4797 },
  'OXFORD KIDLINGTON': { icao: 'EGTK', total: 63408, transport: 251, private: 8896, military: 58, aeroClub: 0, lat: 51.8369, lon: -1.3200 },
  'GLOUCESTERSHIRE':{ icao: 'EGBJ', total: 70704,  transport: 563,    private: 11181, military: 333,  aeroClub: 33155, lat: 51.8942, lon: -2.1672 },
  'MANCHESTER':     { icao: 'EGCC', total: 203256, transport: 194562, private: 0,     military: 6,    aeroClub: 0,     lat: 53.3537, lon: -2.2750 },
  'LEEDS BRADFORD': { icao: 'EGNM', total: 38370,  transport: 33502,  private: 2351,  military: 51,   aeroClub: 1,     lat: 53.8659, lon: -1.6606 },
  'LIVERPOOL':      { icao: 'EGGP', total: 53750,  transport: 39327,  private: 3,     military: 419,  aeroClub: 0,     lat: 53.3336, lon: -2.8497 },
  'NEWCASTLE':      { icao: 'EGNT', total: 48552,  transport: 38605,  private: 6216,  military: 495,  aeroClub: 0,     lat: 55.0375, lon: -1.6917 },
  'HUMBERSIDE':     { icao: 'EGNJ', total: 16908,  transport: 4388,   private: 692,   military: 223,  aeroClub: 0,     lat: 53.5744, lon: -0.3508 },
  'BLACKPOOL':      { icao: 'EGNH', total: 38140,  transport: 5473,   private: 7077,  military: 230,  aeroClub: 22851, lat: 53.7717, lon: -3.0286 },
  // South West
  'BRISTOL':        { icao: 'EGGD', total: 78084,  transport: 73147,  private: 0,     military: 23,   aeroClub: 2092,  lat: 51.3827, lon: -2.7191 },
  'EXETER':         { icao: 'EGTE', total: 23639,  transport: 6842,   private: 4520,  military: 340,  aeroClub: 6695,  lat: 50.7344, lon: -3.4139 },
  'NEWQUAY':        { icao: 'EGHQ', total: 20008,  transport: 5079,   private: 1614,  military: 819,  aeroClub: 0,     lat: 50.4406, lon: -4.9954 },
  'CARDIFF':        { icao: 'EGFF', total: 16956,  transport: 7394,   private: 0,     military: 212,  aeroClub: 0,     lat: 51.3967, lon: -3.3433 },
  // Scotland
  'EDINBURGH':      { icao: 'EGPH', total: 124751, transport: 119986, private: 3236,  military: 22,   aeroClub: 0,     lat: 55.9500, lon: -3.3725 },
  'GLASGOW':        { icao: 'EGPF', total: 80008,  transport: 70133,  private: 0,     military: 240,  aeroClub: 3908,  lat: 55.8719, lon: -4.4331 },
  'ABERDEEN':       { icao: 'EGPD', total: 65611,  transport: 56018,  private: 0,     military: 274,  aeroClub: 1566,  lat: 57.2019, lon: -2.1978 },
  'INVERNESS':      { icao: 'EGPE', total: 19173,  transport: 10142,  private: 914,   military: 99,   aeroClub: 3261,  lat: 57.5425, lon: -4.0475 },
  'PRESTWICK':      { icao: 'EGPK', total: 20547,  transport: 4874,   private: 2355,  military: 2777, aeroClub: 3370,  lat: 55.5094, lon: -4.5867 },
  // N. Ireland
  'BELFAST CITY':   { icao: 'EGAC', total: 28635,  transport: 27812,  private: 156,   military: 2,    aeroClub: 0,     lat: 54.6181, lon: -5.8725 },
  'BELFAST INTL':   { icao: 'EGAA', total: 58180,  transport: 49143,  private: 0,     military: 3299, aeroClub: 0,     lat: 54.6575, lon: -6.2158 },
};

// Norwich year-over-year for seasonal context
const NORWICH_YEARLY = {
  2015: 36045, 2016: 37190, 2017: 37307, 2018: 34287, 2019: 35187,
  2020: 24542, 2021: 30064, 2022: 31434, 2023: 28662, 2024: 30227, 2025: 26493,
};

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function milesToKm(mi) { return mi * 1.60934; }

function findNearbyCAAAirports(lat, lon, radiusMiles) {
  const radiusKm = milesToKm(radiusMiles);
  const nearby = [];
  for (const [name, data] of Object.entries(CAA_DATA)) {
    const dist = haversineKm(lat, lon, data.lat, data.lon);
    if (dist <= radiusKm) {
      nearby.push({ name, ...data, distanceMiles: Math.round(dist * 0.621371 * 10) / 10 });
    }
  }
  return nearby.sort((a, b) => a.distanceMiles - b.distanceMiles);
}

function findNearbyAllAirfields(lat, lon, radiusMiles) {
  const airports = loadAirports();
  const radiusKm = milesToKm(radiusMiles);
  return airports
    .filter(a => haversineKm(lat, lon, a.lat, a.lon) <= radiusKm)
    .map(a => ({
      name: a.name, icao: a.icao || null, category: a.category, usage: a.usage, active: a.active,
      distanceMiles: Math.round(haversineKm(lat, lon, a.lat, a.lon) * 0.621371 * 10) / 10,
    }))
    .sort((a, b) => a.distanceMiles - b.distanceMiles);
}

function estimateLocalTraffic(nearbyCAA, nearbyAll) {
  // For each CAA-reported airport, we know exact annual movements.
  // Weight contribution by inverse square of distance (closer airports contribute more noise).
  let weightedMovements = 0;
  let totalWeight = 0;
  const contributions = [];

  for (const apt of nearbyCAA) {
    const weight = 1 / Math.max(apt.distanceMiles, 1) ** 2;
    weightedMovements += apt.total * weight;
    totalWeight += weight;
    contributions.push({
      name: apt.name,
      icao: apt.icao,
      distanceMiles: apt.distanceMiles,
      annualMovements: apt.total,
      dailyMovements: Math.round(apt.total / 365 * 10) / 10,
      transport: apt.transport,
      private: apt.private,
      military: apt.military,
      aeroClub: apt.aeroClub,
      weight: Math.round(weight * 1000) / 1000,
    });
  }

  // Count non-CAA airfields (assumed ~500-2000 movements/year each for active ones)
  const nonCaaActive = nearbyAll.filter(a =>
    a.active && !nearbyCAA.some(c => c.icao === a.icao)
  );
  for (const af of nonCaaActive) {
    const estMovements = af.category === 'heliport' ? 500 : af.usage === 'military' ? 2000 : 1000;
    const weight = 1 / Math.max(af.distanceMiles, 1) ** 2;
    weightedMovements += estMovements * weight;
    totalWeight += weight;
  }

  const effectiveDailyMovements = totalWeight > 0 ? Math.round((weightedMovements / totalWeight) / 365 * 10) / 10 : 0;

  return { effectiveDailyMovements, contributions, nonCaaActiveCount: nonCaaActive.length };
}

async function main() {
  console.log('Building flyover reference from CAA airport movement data (2025)\n');

  const searchConfig = config.getSearchConfig();
  const configLocations = searchConfig.locations || [];
  if (!configLocations.length) { console.error('No locations configured.'); process.exit(1); }

  // Always include London reference points alongside configured locations
  const LONDON_REFS = [
    { name: 'London Central', lat: 51.5074, lon: -0.1278 },
    { name: 'London Heathrow Area', lat: 51.4700, lon: -0.4543 },
    { name: 'London Gatwick Area', lat: 51.1481, lon: -0.1903 },
    { name: 'London Stansted Area', lat: 51.885, lon: 0.235 },
    { name: 'London City Area', lat: 51.5053, lon: 0.0553 },
    { name: 'London Luton Area', lat: 51.8747, lon: -0.3683 },
  ];

  const locResults = configLocations.map(l => ({ address: l.name, lat: null, lon: null }));
  await geocodeResults(locResults, configLocations.map(l => l.name));

  // Append London refs (already have coordinates)
  for (const lr of LONDON_REFS) {
    locResults.push({ address: lr.name, lat: lr.lat, lon: lr.lon });
  }

  const results = {};

  for (const loc of locResults) {
    if (loc.lat == null) { console.log(`  Skipping ${loc.address} — could not geocode`); continue; }

    const name = loc.address;
    console.log(`\n=== ${name} (${loc.lat.toFixed(4)}, ${loc.lon.toFixed(4)}) ===`);

    const nearbyCAA = findNearbyCAAAirports(loc.lat, loc.lon, RADIUS_MILES);
    const nearbyAll = findNearbyAllAirfields(loc.lat, loc.lon, RADIUS_MILES);

    console.log(`  CAA-reported airports within ${RADIUS_MILES}mi: ${nearbyCAA.length}`);
    nearbyCAA.forEach(a => console.log(`    ${a.name} (${a.icao}): ${a.distanceMiles}mi — ${a.total} movements/yr (${Math.round(a.total/365)}/day)`));

    console.log(`  All airfields within ${RADIUS_MILES}mi: ${nearbyAll.length} (${nearbyAll.filter(a => a.active).length} active)`);

    const traffic = estimateLocalTraffic(nearbyCAA, nearbyAll);
    console.log(`  Effective daily movements (distance-weighted): ${traffic.effectiveDailyMovements}`);

    // Seasonal assessment based on Norwich data (nearest major airport for all Suffolk towns)
    const norwichTrend = Object.entries(NORWICH_YEARLY).map(([y, v]) => ({ year: parseInt(y), movements: v }));
    const recentYears = norwichTrend.filter(t => t.year >= 2022);
    const avg = recentYears.reduce((s, t) => s + t.movements, 0) / recentYears.length;
    const max = Math.max(...recentYears.map(t => t.movements));
    const min = Math.min(...recentYears.map(t => t.movements));
    let seasonalFlag = 'stable';
    if (avg > 0 && (max - min) / avg > 0.3) seasonalFlag = 'moderate_variance';
    if (avg > 0 && (max - min) / avg > 0.5) seasonalFlag = 'high_variance';

    results[name.toLowerCase()] = {
      location: name,
      lat: loc.lat,
      lon: loc.lon,
      radiusMiles: RADIUS_MILES,
      flightsPerDay: traffic.effectiveDailyMovements,
      nearbyCAAAirports: traffic.contributions,
      nearbyAirfields: nearbyAll.length,
      nearbyActiveAirfields: nearbyAll.filter(a => a.active).length,
      nonCaaActiveAirfields: traffic.nonCaaActiveCount,
      seasonalFlag,
      yearlyTrend: norwichTrend,
      dataSource: 'CAA Table 03.1 (2025 annual)',
    };
  }

  const output = {
    generatedAt: new Date().toISOString(),
    method: 'CAA annual airport movement statistics (2025) + OurAirports database',
    dataYear: 2025,
    radiusMiles: RADIUS_MILES,
    note: 'flightsPerDay is distance-weighted: closer airports contribute more. Non-CAA airfields estimated at 500-2000 movements/year.',
    locations: results,
  };

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
  console.log(`\nSaved to ${OUTPUT_PATH}\n`);

  console.log('Summary:');
  for (const [name, data] of Object.entries(results)) {
    console.log(`  ${name}: ${data.flightsPerDay} effective movements/day | ${data.nearbyCAAAirports.length} CAA airports, ${data.nearbyActiveAirfields} active airfields | ${data.seasonalFlag}`);
  }
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
