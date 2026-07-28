const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', 'public', 'airports.json');

function loadAirports() {
  try {
    const data = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return data.airfields || [];
  } catch {
    return [];
  }
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function kmToMiles(km) { return km * 0.621371; }

function withDistance(airfield, lat, lon) {
  const km = haversineKm(lat, lon, airfield.lat, airfield.lon);
  return {
    name: airfield.name,
    icao: airfield.icao,
    category: airfield.category || 'airstrip',
    usage: airfield.usage || 'private',
    active: airfield.active !== false,
    distanceKm: km,
    distanceMiles: kmToMiles(km),
  };
}

function findNearestByCategory(lat, lon) {
  const airfields = loadAirports();
  if (!airfields.length || lat == null || lon == null) {
    return { airport: null, airstrip: null, heliport: null };
  }

  const all = airfields.map(a => withDistance(a, lat, lon));
  all.sort((a, b) => a.distanceKm - b.distanceKm);

  return {
    airport: all.find(a => a.category === 'airport') || null,
    airstrip: all.find(a => a.category === 'airstrip') || null,
    heliport: all.find(a => a.category === 'heliport') || null,
  };
}

// Keep backward compat for any code using the old API
function findNearestAirports(lat, lon, count = 3) {
  const airfields = loadAirports();
  if (!airfields.length || lat == null || lon == null) return [];

  return airfields
    .map(a => withDistance(a, lat, lon))
    .sort((a, b) => a.distanceKm - b.distanceKm)
    .slice(0, count);
}

module.exports = { findNearestByCategory, findNearestAirports, loadAirports };
