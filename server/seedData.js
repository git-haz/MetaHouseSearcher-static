const fs = require('fs');
const path = require('path');

const SEED_PATH = path.join(__dirname, '..', 'seed-data.json');

function load() {
  try {
    return JSON.parse(fs.readFileSync(SEED_PATH, 'utf8'));
  } catch {
    return { properties: {}, lastUpdated: null };
  }
}

function save(data) {
  fs.writeFileSync(SEED_PATH, JSON.stringify(data, null, 2));
}

function dedupKey(property) {
  const addr = (property.address || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const agent = (property.agent || property.sources?.[0]?.portal || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return `${addr}__${agent}`;
}

function parsePostedDate(dateStr) {
  if (!dateStr) return null;
  const m = dateStr.match(/(\d{1,2})\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s*(\d{4})?/i);
  if (m) {
    const months = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
    return new Date(m[3] ? parseInt(m[3]) : new Date().getFullYear(), months[m[2].toLowerCase()], parseInt(m[1]));
  }
  const reduced = dateStr.match(/reduced\s+(\w+)/i);
  if (reduced) return new Date();
  const added = dateStr.match(/added\s+(\w+)/i);
  if (added) return new Date();
  return null;
}

function mergeResults(newResults) {
  const seed = load();
  let added = 0, updated = 0, duplicates = 0;

  for (const prop of newResults) {
    const key = dedupKey(prop);
    const existing = seed.properties[key];

    if (!existing) {
      seed.properties[key] = { ...prop, seedAddedAt: new Date().toISOString() };
      added++;
    } else {
      const newDate = parsePostedDate(prop.postedDate);
      const existingDate = parsePostedDate(existing.postedDate);
      const existingUrl = existing.sources?.[0]?.url || '';
      const newUrl = prop.sources?.[0]?.url || '';
      const urlChanged = newUrl && existingUrl && newUrl !== existingUrl;

      if (urlChanged || (newDate && existingDate && newDate > existingDate)) {
        seed.properties[key] = { ...prop, seedAddedAt: existing.seedAddedAt, seedUpdatedAt: new Date().toISOString() };
        updated++;
      } else {
        existing.potentialDuplicate = true;
        existing.lastSeenAt = new Date().toISOString();
        duplicates++;
      }
    }
  }

  seed.lastUpdated = new Date().toISOString();
  save(seed);

  return { added, updated, duplicates, total: Object.keys(seed.properties).length };
}

function getAll() {
  const seed = load();
  return Object.values(seed.properties);
}

function getStats() {
  const seed = load();
  const props = Object.values(seed.properties);
  return {
    total: props.length,
    duplicates: props.filter(p => p.potentialDuplicate).length,
    lastUpdated: seed.lastUpdated,
  };
}

module.exports = { mergeResults, getAll, getStats, dedupKey };
