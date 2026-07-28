const http = require('http');
const https = require('https');

const cache = new Map();

function httpGet(url) {
  const mod = url.startsWith('https') ? https : http;
  return new Promise((resolve, reject) => {
    mod.get(url, { headers: { 'User-Agent': 'PropertySearchApp/1.0' } }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('Invalid JSON')); }
      });
    }).on('error', reject);
  });
}

function httpPost(url, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const parsed = new URL(url);
    const req = http.request({
      hostname: parsed.hostname,
      port: parsed.port || 80,
      path: parsed.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('Invalid JSON')); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function extractPostcode(address) {
  const full = address.match(/\b([A-Z]{1,2}\d{1,2}\s*\d[A-Z]{2})\b/i);
  if (full) return full[1].toUpperCase().replace(/\s+/g, ' ');
  const out = address.match(/\b([A-Z]{1,2}\d{1,2})\b/i);
  if (out) return out[1].toUpperCase();
  return null;
}

async function nominatimLookup(query) {
  const key = 'nom:' + query.toLowerCase().trim();
  if (cache.has(key)) return cache.get(key);

  try {
    const q = encodeURIComponent(query);
    const results = await httpGet(`https://nominatim.openstreetmap.org/search?q=${q}&format=json&limit=1&countrycodes=gb`);
    await sleep(1100);
    if (results.length > 0) {
      const coords = { lat: parseFloat(results[0].lat), lon: parseFloat(results[0].lon) };
      cache.set(key, coords);
      return coords;
    }
  } catch {}

  cache.set(key, null);
  return null;
}

async function postcodeLookup(postcode) {
  const key = 'pc:' + postcode.toUpperCase();
  if (cache.has(key)) return cache.get(key);

  try {
    // Try full postcode first
    const res = await httpGet(`http://api.postcodes.io/postcodes/${encodeURIComponent(postcode)}`);
    if (res.result) {
      const coords = { lat: res.result.latitude, lon: res.result.longitude };
      cache.set(key, coords);
      return coords;
    }
  } catch {}

  // Try as outcode
  const outcode = postcode.replace(/\s*\d[A-Z]{2}$/i, '').toUpperCase();
  const outKey = 'pc:' + outcode;
  if (cache.has(outKey)) return cache.get(outKey);

  try {
    const res = await httpGet(`http://api.postcodes.io/outcodes/${encodeURIComponent(outcode)}`);
    if (res.result) {
      const coords = { lat: res.result.latitude, lon: res.result.longitude };
      cache.set(outKey, coords);
      return coords;
    }
  } catch {}

  cache.set(key, null);
  return null;
}

async function geocodeResults(results, searchLocations) {
  console.log(`  Geocoding ${results.length} properties...`);

  // Group by unique address to avoid duplicate lookups
  const addressMap = new Map();
  for (const r of results) {
    if (r.lat != null) continue;
    const addr = r.address;
    if (!addressMap.has(addr)) addressMap.set(addr, []);
    addressMap.get(addr).push(r);
  }

  const uniqueAddresses = [...addressMap.keys()];
  console.log(`  ${uniqueAddresses.length} unique addresses to geocode`);

  // Strategy: try Nominatim with full address first (street-level accuracy),
  // fall back to postcodes.io, then search location name
  let nominatimCount = 0;
  let postcodeCount = 0;
  let fallbackCount = 0;

  for (const addr of uniqueAddresses) {
    let coords = null;

    let accuracy = null;

    // 1. Try Nominatim with the full address (best accuracy)
    coords = await nominatimLookup(addr + ', UK');
    if (coords) {
      nominatimCount++;
      accuracy = 'address';
    } else {
      // 2. Fall back to postcode lookup
      const pc = extractPostcode(addr);
      if (pc) {
        coords = await postcodeLookup(pc);
        if (coords) { postcodeCount++; accuracy = 'postcode'; }
      }
    }

    // 3. Fall back to search location name
    if (!coords) {
      for (const loc of searchLocations) {
        coords = await nominatimLookup(loc + ', UK');
        if (coords) { fallbackCount++; accuracy = 'area'; break; }
      }
    }

    if (coords) {
      for (const r of addressMap.get(addr)) {
        r.lat = coords.lat;
        r.lon = coords.lon;
        r.geoAccuracy = accuracy;
      }
    }
  }

  console.log(`  Geocoded: ${nominatimCount} via address, ${postcodeCount} via postcode, ${fallbackCount} via location fallback`);
}

module.exports = { geocodeResults, extractPostcode };
