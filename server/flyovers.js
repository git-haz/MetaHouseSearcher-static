const fs = require('fs');
const path = require('path');
const https = require('https');

const REF_PATH = path.join(__dirname, '..', 'public', 'flyover-reference.json');

function loadReference() {
  try {
    return JSON.parse(fs.readFileSync(REF_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function haversineDistMiles(lat1, lon1, lat2, lon2) {
  const R = 3958.8;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function lookupFlyoverForProperty(property, searchLocations, ref) {
  if (!ref || !ref.locations) return null;

  // 1. Exact lookup by sourceLocation stamped at scrape time — always correct
  if (property.sourceLocation) {
    const key = property.sourceLocation.toLowerCase();
    if (ref.locations[key]) return ref.locations[key];
  }

  // 2. Address text match
  const addr = (property.address || '').toLowerCase();
  for (const loc of searchLocations) {
    const key = loc.toLowerCase();
    if (addr.includes(key) && ref.locations[key]) return ref.locations[key];
  }

  // 3. Nearest by Haversine (correct distance, not Manhattan)
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

// Inverse-square distance-weighted interpolation across all reference points.
// Gives each property its own flightsPerDay based on its actual coordinates
// rather than assigning a single search-location centroid's value.
function computeWeightedFlyover(lat, lon, ref) {
  const entries = Object.values(ref.locations).filter(d => d.lat != null && d.flightsPerDay != null);
  if (!entries.length) return null;

  let weightedSum = 0, totalWeight = 0;
  for (const d of entries) {
    const dist = Math.max(haversineDistMiles(lat, lon, d.lat, d.lon), 0.5);
    const w = 1 / (dist * dist);
    weightedSum += w * d.flightsPerDay;
    totalWeight += w;
  }

  const flightsPerDay = totalWeight > 0 ? Math.round((weightedSum / totalWeight) * 10) / 10 : 0;
  return {
    location: 'interpolated',
    flightsPerDay,
    interpolated: true,
    generatedAt: ref.generatedAt,
  };
}

function attachFlyoverData(results, searchLocations) {
  const ref = loadReference();
  if (!ref) return;

  const locNames = searchLocations.map(l => l.toLowerCase());
  for (const r of results) {
    // If property has coordinates, use per-property weighted interpolation (Option 3)
    if (r.lat != null) {
      const data = computeWeightedFlyover(r.lat, r.lon, ref);
      if (data) {
        r.flyoverRef = {
          location: data.location,
          flightsPerDay: data.flightsPerDay,
          interpolated: true,
          generatedAt: ref.generatedAt,
        };
      }
      continue;
    }

    // Fallback for properties without coordinates: use lookup (Option 1 sourceLocation path)
    const data = lookupFlyoverForProperty(r, locNames, ref);
    if (data) {
      r.flyoverRef = {
        location: data.location,
        flightsPerDay: data.flightsPerDay,
        avgUkFlightsPerHour: data.avgUkFlightsPerHour,
        seasonalFlag: data.seasonalFlag,
        monthly: data.monthly,
        seasonalDetail: data.seasonalDetail,
        generatedAt: ref.generatedAt,
      };
    }
  }
}

// Keep the live calculation for on-demand use
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
    { label: 'recent', begin: now - 7200, end: now },
    { label: 'mid', begin: now - 7200 * 2, end: now - 7200 },
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
        (f.estArrivalAirport && f.estArrivalAirport.startsWith('EG'))
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

module.exports = { calculateFlyovers, attachFlyoverData, loadReference };
