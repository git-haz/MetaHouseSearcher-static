#!/usr/bin/env node

// Build-time script: generates static flyover reference data for configured search locations.
//
// Samples live air traffic via OpenSky /states/all with per-location bounding boxes.
// Filters out high-altitude transit traffic (>20,000ft).
// Queries all locations in parallel each round.
//
// Usage:
//   node server/buildFlyoverData.js --clientId ID --clientSecret SECRET [--duration MINUTES]
//
// Default duration: 360 minutes (6 hours)
//
// Output: public/flyover-reference.json

const fs = require('fs');
const path = require('path');
const https = require('https');
const config = require('./config');
const { geocodeResults } = require('./geocode');
const { loadAirports } = require('./airports');

const OUTPUT_PATH = path.join(__dirname, '..', 'public', 'flyover-reference.json');
const RADIUS_MILES = 20;
const SAMPLE_INTERVAL_MS = 300000; // 5 minutes between rounds
const MAX_ALTITUDE_FT = 20000;
const MAX_ALTITUDE_M = MAX_ALTITUDE_FT * 0.3048; // 6096m

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function bboxForRadius(lat, lon, radiusMiles) {
  const radiusKm = radiusMiles * 1.60934;
  const latDelta = radiusKm / 111.32;
  const lonDelta = radiusKm / (111.32 * Math.cos(lat * Math.PI / 180));
  return { lamin: lat - latDelta, lamax: lat + latDelta, lomin: lon - lonDelta, lomax: lon + lonDelta };
}

function findAirportsWithinRadius(lat, lon, radiusMiles) {
  const airports = loadAirports();
  const radiusKm = radiusMiles * 1.60934;
  return airports
    .filter(a => haversineKm(lat, lon, a.lat, a.lon) <= radiusKm)
    .map(a => ({
      icao: a.icao || null, name: a.name, category: a.category, usage: a.usage,
      distanceMiles: Math.round(haversineKm(lat, lon, a.lat, a.lon) * 0.621371 * 10) / 10,
    }));
}

function get(url, auth) {
  return new Promise((resolve, reject) => {
    const opts = {
      headers: { 'User-Agent': 'PropertySearchApp/1.0 (property search, contact: haroon@azizpour.de)' },
      timeout: 30000,
    };
    if (auth) opts.headers['Authorization'] = 'Basic ' + Buffer.from(auth).toString('base64');
    const req = https.get(url, opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode === 429) return reject(new Error('429'));
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('Invalid JSON')); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function queryLocation(loc, auth, retries = 2) {
  const bbox = bboxForRadius(loc.lat, loc.lon, RADIUS_MILES);
  const url = `https://opensky-network.org/api/states/all?lamin=${bbox.lamin}&lomin=${bbox.lomin}&lamax=${bbox.lamax}&lomax=${bbox.lomax}`;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await get(url, auth);
      if (!res.states) return { count: 0, aircraft: [], time: res.time };

      // Filter: only aircraft at or below 20,000ft
      // State vector index 7 = baro_altitude (meters), 13 = geo_altitude (meters)
      const lowAltitude = res.states.filter(s => {
        const alt = s[7] != null ? s[7] : s[13];
        return alt == null || alt <= MAX_ALTITUDE_M;
      });

      return {
        count: lowAltitude.length,
        countAll: res.states.length,
        filtered: res.states.length - lowAltitude.length,
        aircraft: lowAltitude.map(s => ({
          icao24: s[0],
          callsign: (s[1] || '').trim(),
          alt: s[7] != null ? Math.round(s[7] * 3.28084) : null, // meters to feet
        })),
        time: res.time,
      };
    } catch (err) {
      if (err.message === '429' && attempt < retries) {
        console.log(`    ${loc.name}: rate limited, waiting 30s...`);
        await sleep(30000);
        continue;
      }
      return { count: 0, aircraft: [], error: err.message };
    }
  }
}

async function sampleAllLocationsParallel(locations, auth) {
  // Query all locations in parallel
  const promises = locations.map(loc => queryLocation(loc, auth));
  const results = await Promise.all(promises);

  const out = {};
  locations.forEach((loc, i) => { out[loc.name] = results[i]; });
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  let auth = null;

  const clientIdIdx = args.indexOf('--clientId');
  const clientSecretIdx = args.indexOf('--clientSecret');
  if (clientIdIdx >= 0 && clientSecretIdx >= 0) {
    auth = args[clientIdIdx + 1] + ':' + args[clientSecretIdx + 1];
    console.log('Authenticated access');
  } else {
    console.log('Anonymous access (limited)');
  }

  const durationIdx = args.indexOf('--duration');
  const durationMinutes = durationIdx >= 0 ? parseInt(args[durationIdx + 1]) : 360;
  const sampleCount = Math.max(1, Math.floor(durationMinutes / 5));

  console.log(`Duration: ${durationMinutes} min, ${sampleCount} rounds, 5 min apart`);
  console.log(`Altitude filter: ≤${MAX_ALTITUDE_FT} ft (${Math.round(MAX_ALTITUDE_M)}m)`);
  console.log(`Queries: all locations in parallel per round\n`);

  const searchConfig = config.getSearchConfig();
  const configLocations = searchConfig.locations || [];
  if (!configLocations.length) { console.error('No locations configured.'); process.exit(1); }

  const locResults = configLocations.map(l => ({ address: l.name, lat: null, lon: null }));
  await geocodeResults(locResults, configLocations.map(l => l.name));

  const locations = locResults.filter(l => l.lat != null).map(l => ({
    name: l.address, lat: l.lat, lon: l.lon,
  }));

  console.log(`\n${locations.length} locations:`);
  for (const loc of locations) {
    const nearby = findAirportsWithinRadius(loc.lat, loc.lon, RADIUS_MILES);
    console.log(`  ${loc.name}: ${nearby.length} airports within ${RADIUS_MILES}mi`);
  }

  // Sampling
  const uniqueAircraft = {};
  const sampleCounts = {};
  const altFilteredCounts = {};
  for (const loc of locations) {
    uniqueAircraft[loc.name] = new Set();
    sampleCounts[loc.name] = [];
    altFilteredCounts[loc.name] = 0;
  }

  const startTime = Date.now();
  console.log(`\nStarting ${sampleCount} rounds at ${new Date().toISOString().slice(11, 19)} UTC...\n`);

  // Header
  const nameHeader = locations.map(l => l.name.substring(0, 12).padEnd(12)).join(' | ');
  console.log(`  Round   Time      ${nameHeader}`);
  console.log(`  ${'─'.repeat(10 + 2 + 8 + 2 + locations.length * 15)}`);

  for (let i = 0; i < sampleCount; i++) {
    const roundTime = new Date().toISOString().slice(11, 16);
    const round = await sampleAllLocationsParallel(locations, auth);

    const parts = [];
    for (const loc of locations) {
      const r = round[loc.name];
      if (r.error) {
        parts.push('ERR'.padEnd(12));
        sampleCounts[loc.name].push(0);
      } else {
        r.aircraft.forEach(a => uniqueAircraft[loc.name].add(a.icao24));
        sampleCounts[loc.name].push(r.count);
        altFilteredCounts[loc.name] += (r.filtered || 0);
        parts.push(`${r.count} (↑${r.filtered || 0})`.padEnd(12));
      }
    }
    const roundNum = String(i + 1).padStart(3) + '/' + sampleCount;
    console.log(`  ${roundNum}  ${roundTime}   ${parts.join(' | ')}`);

    if (i < sampleCount - 1) await sleep(SAMPLE_INTERVAL_MS);
  }

  const elapsedMinutes = (Date.now() - startTime) / 60000;
  console.log(`\nSampling complete: ${Math.round(elapsedMinutes)} minutes elapsed\n`);

  // Build reference
  const results = {};
  for (const loc of locations) {
    const counts = sampleCounts[loc.name];
    const validCounts = counts.filter(c => c >= 0);
    const totalSeen = uniqueAircraft[loc.name].size;
    const avgPerSample = validCounts.length > 0 ? validCounts.reduce((a, b) => a + b, 0) / validCounts.length : 0;
    const flightsPerHour = totalSeen / (elapsedMinutes / 60);
    const flightsPerDay = Math.round(flightsPerHour * 24 * 10) / 10;

    const max = validCounts.length ? Math.max(...validCounts) : 0;
    const min = validCounts.length ? Math.min(...validCounts) : 0;
    let seasonalFlag = 'unknown';
    if (validCounts.length >= 3) {
      if (avgPerSample === 0) seasonalFlag = 'low_traffic';
      else if ((max - min) / avgPerSample > 1.0) seasonalFlag = 'high_variance';
      else if ((max - min) / avgPerSample > 0.5) seasonalFlag = 'moderate_variance';
      else seasonalFlag = 'stable';
    }

    // Hourly breakdown (group samples by hour of day)
    const hourly = {};
    const samplesStart = new Date(startTime);
    validCounts.forEach((c, idx) => {
      const sampleTime = new Date(samplesStart.getTime() + idx * SAMPLE_INTERVAL_MS);
      const hour = sampleTime.getHours();
      if (!hourly[hour]) hourly[hour] = [];
      hourly[hour].push(c);
    });
    const hourlyAvg = Object.entries(hourly).map(([h, vals]) => ({
      hour: parseInt(h),
      avgAircraft: Math.round(vals.reduce((a, b) => a + b, 0) / vals.length * 10) / 10,
      samples: vals.length,
    })).sort((a, b) => a.hour - b.hour);

    const nearbyAirports = findAirportsWithinRadius(loc.lat, loc.lon, RADIUS_MILES);

    results[loc.name.toLowerCase()] = {
      location: loc.name,
      lat: loc.lat, lon: loc.lon,
      radiusMiles: RADIUS_MILES,
      maxAltitudeFt: MAX_ALTITUDE_FT,
      nearbyAirports,
      flightsPerDay,
      uniqueAircraftSeen: totalSeen,
      highAltitudeFiltered: altFilteredCounts[loc.name],
      avgAircraftPerSample: Math.round(avgPerSample * 10) / 10,
      peakAircraftInSample: max,
      sampleCount: validCounts.length,
      samplingDurationMinutes: Math.round(elapsedMinutes),
      seasonalFlag,
      seasonalDetail: { min, max, avg: Math.round(avgPerSample * 10) / 10 },
      hourly: hourlyAvg,
    };
  }

  const output = {
    generatedAt: new Date().toISOString(),
    method: 'OpenSky /states/all bbox sampling, parallel, ≤20000ft',
    radiusMiles: RADIUS_MILES,
    maxAltitudeFt: MAX_ALTITUDE_FT,
    sampleIntervalMinutes: SAMPLE_INTERVAL_MS / 60000,
    totalRounds: sampleCount,
    durationMinutes: Math.round(elapsedMinutes),
    locations: results,
  };

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
  console.log(`Saved to ${OUTPUT_PATH}\n`);
  console.log('Summary:');
  for (const [name, data] of Object.entries(results)) {
    console.log(`  ${name}: ${data.flightsPerDay} flights/day | ${data.uniqueAircraftSeen} unique (${data.highAltitudeFiltered} high-alt filtered) | ${data.nearbyAirports.length} airports | ${data.seasonalFlag}`);
  }
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
