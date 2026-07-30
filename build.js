'use strict';
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Reuse modules from the main project
const mainDir = path.join(__dirname, 'server');
const { getBrowser, closeBrowser } = require(path.join(mainDir, 'browser'));
const { deduplicate, normalizeAddress, descriptionSimilarity, getUrl } = require(path.join(mainDir, 'dedup'));
const { findNearestByCategory } = require(path.join(mainDir, 'airports'));
const { geocodeResults } = require(path.join(mainDir, 'geocode'));
const { buildUrls } = require(path.join(mainDir, 'portals'));
const { analyzeProperties } = require(path.join(mainDir, 'imageAnalyzer'));
const { attachFlyoverData } = require(path.join(mainDir, 'flyovers'));
const { initML, autoTagLocation } = require(path.join(mainDir, 'autotag'));
const seedData = require(path.join(mainDir, 'seedData'));
const zooplaParser = require(path.join(mainDir, 'parsers', 'zoopla'));
const otmParser = require(path.join(mainDir, 'parsers', 'onthemarket'));
const durrantsParser = require(path.join(mainDir, 'parsers', 'durrants'));
const rightmoveParser = require(path.join(mainDir, 'parsers', 'rightmove'));
const savillsParser = require(path.join(mainDir, 'parsers', 'savills'));
const spParser = require(path.join(mainDir, 'parsers', 'struttandparker'));
const jsParser = require(path.join(mainDir, 'parsers', 'jackson-stops'));

const parsers = {
  zoopla: zooplaParser, onthemarket: otmParser, durrants: durrantsParser,
  rightmove: rightmoveParser, savills: savillsParser, struttandparker: spParser, 'jackson-stops': jsParser,
};

const ALL_PORTALS = [
  { id: 'zoopla',         name: 'Zoopla',           enabled: true },
  { id: 'onthemarket',    name: 'OnTheMarket',       enabled: true },
  { id: 'durrants',       name: 'Durrants',          enabled: true },
  { id: 'rightmove',      name: 'Rightmove',         enabled: true },
  { id: 'savills',        name: 'Savills',           enabled: true },
  { id: 'struttandparker',name: 'Strutt & Parker',   enabled: true },
  { id: 'jackson-stops',  name: 'Jackson-Stops',     enabled: true },
  { id: 'winkworth',      name: 'Winkworth',         enabled: true },
];

const portalArg = process.argv.find(a => a.startsWith('--portals='));
const portalFilter = portalArg ? portalArg.split('=')[1].split(',').map(s => s.trim().toLowerCase()) : null;

const locationArg = process.argv.find(a => a.startsWith('--locations='));
const locationFilter = locationArg ? locationArg.split('=')[1].split(',').map(s => s.trim().toLowerCase()) : null;
function getPortals(config) {
  const disabled = (config.disabledPortals || []).map(s => s.toLowerCase());
  let portals = ALL_PORTALS.filter(p => !disabled.includes(p.id));
  if (portalFilter) portals = portals.filter(p => portalFilter.includes(p.id));
  if (disabled.length) console.log(`Disabled portals: ${disabled.join(', ')}`);
  return portals;
}

const pushEveryArg = process.argv.find(a => a.startsWith('--push-every='));
const PUSH_EVERY   = pushEveryArg ? (parseInt(pushEveryArg.split('=')[1]) || 0) : 0;
const RESUME       = process.argv.includes('--resume');
const USE_ML       = process.argv.includes('--ml-recommend') || process.argv.includes('--ml');

// ---- Utilities ----
const https = require('https');

function httpsGetJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'MetaHouseSearcher-build/1.0' } }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

function haversineDistMilesBuild(lat1, lon1, lat2, lon2) {
  const R = 3958.8;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function countInRadius(lat, lon, airportsArr, radii) {
  let airports = 0, airstrips = 0, helipads = 0;
  for (const a of airportsArr) {
    const dist = haversineDistMilesBuild(lat, lon, a.lat, a.lon);
    const cat = a.category || 'airstrip';
    if (cat === 'airport'  && dist <= radii.airport)  airports++;
    else if (cat === 'heliport' && dist <= radii.helipad)  helipads++;
    else if (cat === 'airstrip' && dist <= radii.airstrip) airstrips++;
  }
  return { airports, airstrips, helipads };
}

// AUTO_REJECT_PATTERNS is built in main() from config.autoReject.titlePatterns
let AUTO_REJECT_PATTERNS = [];
let AUTO_REJECT_MIN_PRICE = null;

function buildAutoRejectFromConfig(autoRejectConfig) {
  if (!autoRejectConfig) return;
  AUTO_REJECT_PATTERNS = (autoRejectConfig.titlePatterns || []).map(phrase => {
    // Convert phrase to regex: allow optional hyphen/space between words
    const escaped    = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const normalized = escaped.replace(/[-\s]+/g, '[-\\s]?');
    return { re: new RegExp(`\\b${normalized}\\b`, 'i'), label: phrase };
  });
  AUTO_REJECT_MIN_PRICE = autoRejectConfig.minPrice ?? null;
  console.log(`Auto-reject: ${AUTO_REJECT_PATTERNS.length} title pattern(s)${AUTO_REJECT_MIN_PRICE != null ? `, min price £${AUTO_REJECT_MIN_PRICE.toLocaleString()}` : ''}`);
}

function slugify(loc) {
  return loc.toLowerCase().trim().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
}

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms: ${label}`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function makePool(limit) {
  let active = 0;
  const queue = [];
  const next = () => { if (queue.length && active < limit) queue.shift()(); };
  return fn => new Promise((resolve, reject) => {
    const run = () => {
      active++;
      fn().then(
        v => { active--; resolve(v); next(); },
        e => { active--; reject(e); next(); },
      );
    };
    active < limit ? run() : queue.push(run);
  });
}

// ---- Baseline geocoding (runs once at startup) ----
async function geocodeBaseline(config, airportsArr, flyoverSource) {
  if (!config.baseline) return null;
  const bl = config.baseline;
  const radii = { airport: bl.airportRadiusMiles || 20, airstrip: bl.airstripRadiusMiles || 5, helipad: bl.helipadRadiusMiles || 15 };
  console.log(`\nBaseline: ${bl.name} (${bl.postcode})`);

  let blLat = null, blLon = null;
  try {
    const pcData = await httpsGetJson(`https://api.postcodes.io/postcodes/${(bl.postcode || '').replace(/\s+/g, '').toUpperCase()}`);
    if (pcData.status === 200) {
      blLat = pcData.result.latitude; blLon = pcData.result.longitude;
      console.log(`  Geocoded: ${blLat.toFixed(5)}, ${blLon.toFixed(5)}`);
    }
  } catch (err) { console.error(`  Geocoding baseline failed: ${err.message}`); }

  let blCircles = { airports: 0, airstrips: 0, helipads: 0 }, blFlightsPerDay = null;
  if (blLat && blLon) {
    blCircles = countInRadius(blLat, blLon, airportsArr, radii);
    console.log(`  Circles — airports: ${blCircles.airports}, airstrips: ${blCircles.airstrips}, helipads: ${blCircles.helipads}`);
    if (fs.existsSync(flyoverSource)) {
      const flyoverRef = JSON.parse(fs.readFileSync(flyoverSource, 'utf8'));
      const flyoverLocs = Array.isArray(flyoverRef.locations || flyoverRef) ? (flyoverRef.locations || flyoverRef) : Object.values(flyoverRef.locations || flyoverRef);
      let weightedSum = 0, totalWeight = 0;
      for (const loc of flyoverLocs) {
        if (loc.lat == null || loc.flightsPerDay == null) continue;
        const dist = Math.max(haversineDistMilesBuild(blLat, blLon, loc.lat, loc.lon), 0.5);
        const w = 1 / (dist * dist);
        weightedSum += w * loc.flightsPerDay;
        totalWeight += w;
      }
      if (totalWeight > 0) {
        blFlightsPerDay = Math.round((weightedSum / totalWeight) * 10) / 10;
        console.log(`  Flyover: interpolated (inverse-square weighted) → ${blFlightsPerDay} flights/day`);
      }
    }
  }

  return {
    name: bl.name, postcode: bl.postcode, lat: blLat, lon: blLon,
    airports: blCircles.airports, airstrips: blCircles.airstrips, helipads: blCircles.helipads,
    flightsPerDay: blFlightsPerDay, radii, altitudeCutoffFt: bl.altitudeCutoffFt || null,
  };
}

// ---- Per-property enrichment helpers ----
function attachAutoReject(results) {
  for (const r of results) {
    const text = `${r.title || ''} ${r.type || ''}`;
    const titleMatch = AUTO_REJECT_PATTERNS.some(({ re }) => re.test(text));
    const priceMatch = AUTO_REJECT_MIN_PRICE != null && r.price != null && r.price < AUTO_REJECT_MIN_PRICE;
    r.autoRejected = titleMatch || priceMatch;
  }
}

function attachAirportDistances(results) {
  for (const r of results) {
    if (r.lat == null) continue;
    const nearest = findNearestByCategory(r.lat, r.lon);
    r.nearestAirport   = nearest.airport;
    r.nearestAirstrip  = nearest.airstrip;
    r.nearestHeliport  = nearest.heliport;
    const dists = [nearest.airport, nearest.airstrip, nearest.heliport].filter(Boolean).map(a => a.distanceMiles);
    r.minAirportDistanceMiles = dists.length ? Math.min(...dists) : null;
  }
}

function attachKeywords(results, config) {
  const keywords = (config.keywords || []).map(k => k.toLowerCase().trim()).filter(Boolean);
  for (const r of results) {
    r.keywordsMatched = 0;
    if (keywords.length) {
      const text = `${r.title} ${r.description} ${r.address}`.toLowerCase();
      r.keywordsMatched = keywords.filter(kw => text.includes(kw)).length;
    }
  }
}

function attachBaselineComparison(results, airportsArr, baselineData) {
  if (!baselineData?.lat) return;
  for (const r of results) {
    if (r.isManual || r.lat == null) continue;
    const circles = countInRadius(r.lat, r.lon, airportsArr, baselineData.radii);
    const propFlights = r.flyoverRef?.flightsPerDay ?? null;
    const flightsDiffPct = (propFlights != null && baselineData.flightsPerDay != null && baselineData.flightsPerDay > 0)
      ? Math.round(((propFlights - baselineData.flightsPerDay) / baselineData.flightsPerDay) * 100) : null;
    r.baselineComparison = {
      airportsCount: circles.airports, airstripsCount: circles.airstrips, helipadsCount: circles.helipads,
      airportsDiff: circles.airports - baselineData.airports,
      airstripsDiff: circles.airstrips - baselineData.airstrips,
      helipadsDiff: circles.helipads - baselineData.helipads,
      flightsPerDay: propFlights, flightsDiffPct,
    };
  }
}

// ---- Process one location after scraping: enrich + write location file ----
async function processLocation(search, rawResults, portalLinks, config, resultsDir, airportsArr, flyoverSource, baselineData, ukTowns) {
  const slug = slugify(search.location);
  const now = new Date().toISOString();
  console.log(`\n  Processing ${search.location}: ${rawResults.length} raw listings`);

  // 1. Within-location dedup
  let results = deduplicate(rawResults);
  console.log(`  After dedup: ${results.length}`);

  // 2. Merge searchLocations array
  const locationMap = new Map();
  for (const r of rawResults) {
    const key = (r.address || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!locationMap.has(key)) locationMap.set(key, new Set());
    locationMap.get(key).add(r.searchLocation);
  }
  for (const r of results) {
    const key = (r.address || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    r.searchLocations = [...(locationMap.get(key) || new Set([r.searchLocation]))];
  }

  // 3. Stamp source location (used by flyover lookup to avoid wrong-centroid assignment)
  for (const r of results) r.sourceLocation = search.location;

  // 4. Auto-reject flag
  attachAutoReject(results);

  // 5. Geocode
  await geocodeResults(results, [search.location]);
  console.log(`  Geocoded: ${results.filter(r => r.lat != null).length}/${results.length}`);

  // 5. Airport distances
  attachAirportDistances(results);

  // 6. Flyover data
  if (fs.existsSync(flyoverSource)) {
    attachFlyoverData(results, config.searches.map(s => s.location));
  }

  // 7. Keywords
  attachKeywords(results, config);

  // 8. Image analysis (--analyze flag)
  if (process.argv.includes('--analyze')) {
    const threshold = config.neighbourConfidenceThreshold || 0.95;
    await analyzeProperties(results, threshold);
    for (const r of results) {
      if (r.neighbourConfidence < threshold) r.neighbourDetected = false;
    }
  }

  // 9. Auto-tag (distance gate + ML classification)
  const autoTagEnabled = (config.autoTag || config.recommend)?.enabled !== false;
  if (autoTagEnabled && ukTowns && ukTowns.length > 0) {
    const { chosenThreshold, totalTagged, eligibleCount } = await autoTagLocation(results, ukTowns, config);
    console.log(`  Auto-tagged: ${totalTagged}/${eligibleCount} eligible (threshold: ${Math.round(chosenThreshold * 100)}%)`);
  }

  // 10. Baseline comparison
  attachBaselineComparison(results, airportsArr, baselineData);

  // 10. Merge into seed
  const mergeStats = seedData.mergeResults(results);
  console.log(`  Seed: +${mergeStats.added} new, ~${mergeStats.updated} updated, ${mergeStats.duplicates} dupes`);

  // 11. Mark isNew + retrievedAt
  for (const r of results) {
    r.isNew = true;
    r.retrievedAt = r.seedAddedAt || now;
  }

  // 12. Merge with existing location file — preserve old entries, detect price/description changes
  const existingFilePath = path.join(resultsDir, `${slug}.json`);
  let preservedCount = 0, updatedCount = 0;
  if (fs.existsSync(existingFilePath)) {
    try {
      const existingData = JSON.parse(fs.readFileSync(existingFilePath, 'utf8'));
      const existingProps = existingData.properties || [];

      // Build lookup maps: URL → existing property, normalizedAddr → existing property
      const existingByUrl  = new Map();
      const existingByAddr = new Map();
      for (const ep of existingProps) {
        const u = getUrl(ep);
        if (u) existingByUrl.set(u, ep);
        const a = normalizeAddress(ep.address || '');
        if (a) existingByAddr.set(a, ep);
      }

      // Detect changes on freshly scraped results and record matched keys
      const matchedUrls  = new Set();
      const matchedAddrs = new Set();
      for (const np of results) {
        const u = getUrl(np);
        const a = normalizeAddress(np.address || '');
        const ep = (u && existingByUrl.get(u)) || (a && existingByAddr.get(a));
        if (ep) {
          const changedFields = [];
          if (ep.price != null && np.price != null && ep.price !== np.price) changedFields.push('price');
          if (ep.description && np.description && ep.description !== np.description) changedFields.push('description');
          if (changedFields.length > 0) {
            np.updated      = true;
            np.updatedFields = changedFields;
            if (changedFields.includes('price')) np.previousPrice = ep.price;
            updatedCount++;
          }
          if (u) matchedUrls.add(u);
          if (a) matchedAddrs.add(a);
        }
      }

      // Append existing properties not found in new scrape (preserve them)
      for (const ep of existingProps) {
        const u = getUrl(ep);
        const a = normalizeAddress(ep.address || '');
        if ((u && matchedUrls.has(u)) || (a && matchedAddrs.has(a))) continue;
        ep.isNew = false;
        delete ep.updated; // stale update flag from previous run
        results.push(ep);
        preservedCount++;
      }
    } catch (err) {
      console.warn(`  ⚠ Could not merge existing file: ${err.message}`);
    }
  }
  console.log(`  Merge: ${updatedCount} updated, ${preservedCount} preserved from previous build`);

  // 13. Write location file
  const output = {
    location: search.location,
    slug,
    generatedAt: now,
    count: results.length,
    properties: results,
    portalLinks,
  };
  fs.writeFileSync(path.join(resultsDir, `${slug}.json`), JSON.stringify(output, null, 2));
  console.log(`  ✓ docs/results/${slug}.json (${results.length} properties)`);
  return results.length;
}

// ---- Detail page description fetching ----
async function dismissCookies(page) {
  try {
    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button, a'))
        .find(b => /accept all|accept cookies|agree|allow all/i.test(b.textContent));
      if (btn) btn.click();
    });
    await new Promise(r => setTimeout(r, 600));
  } catch (_) {}
}

async function fetchDetailDescription(page, url) {
  if (!url) return '';
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await new Promise(r => setTimeout(r, 1800));
    await dismissCookies(page);
    await new Promise(r => setTimeout(r, 400));

    return await page.evaluate((href) => {
      const isOTM     = href.includes('onthemarket.com');
      const isZoopla  = href.includes('zoopla.co.uk');
      const isDurrants = href.includes('durrants.com');

      if (isOTM) {
        const heading = Array.from(document.querySelectorAll('h2,h3,h4,strong'))
          .find(h => /description/i.test(h.textContent));
        if (heading) {
          let el = heading.parentElement;
          for (let i = 0; i < 4; i++) {
            const ps = el.querySelectorAll('p');
            if (ps.length) return Array.from(ps).map(p => p.textContent.trim()).join(' ');
            el = el.parentElement;
          }
        }
      }
      if (isZoopla) {
        for (const sel of ['[data-testid="listing_description"]','[data-testid="description"]','#listing-description','[class*="ListingDescription"]','[class*="listing-description"]']) {
          const el = document.querySelector(sel);
          if (el && el.textContent.length > 100)
            return Array.from(el.querySelectorAll('p,li') || []).map(e => e.textContent.trim()).filter(t => t.length > 10).join(' ');
        }
      }
      if (isDurrants) {
        for (const sel of ['.property-description','.entry-content','article','main']) {
          const el = document.querySelector(sel);
          if (el) return Array.from(el.querySelectorAll('p,li')).map(e => e.textContent.trim()).filter(t => t.length > 10).join(' ');
        }
      }
      // Generic: paragraphs longer than 80 chars
      return Array.from(document.querySelectorAll('p'))
        .filter(p => p.textContent.trim().length > 80)
        .map(p => p.textContent.trim()).join(' ');
    }, url);
  } catch (_) {
    return '';
  }
}

// Pre-fetch detail pages for properties that could pass a distance gate (minMiles floor).
// Skips properties that already have fullDescription set.
function hvDist2(lat1, lon1, lat2, lon2) {
  const R = 3958.8, dLat = (lat2-lat1)*Math.PI/180, dLon = (lon2-lon1)*Math.PI/180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

async function enrichWithDetails(page, properties, ukTowns, minMiles) {
  for (const p of properties) {
    if (!p.lat || p.fullDescription) continue;
    const url = p.sources?.[0]?.url;
    if (!url) continue;
    let nearTown = Infinity;
    for (const t of ukTowns) { const d = hvDist2(p.lat, p.lon, t.lat, t.lon); if (d < nearTown) nearTown = d; }
    if (nearTown < minMiles) continue;
    const desc = (await fetchDetailDescription(page, url)).replace(/\s+/g, ' ').trim().slice(0, 3000);
    if (desc.length > 100) p.fullDescription = desc;
  }
}

// ---- Write index.json ----
function writeIndex(resultsDir, config, baselineData, availableSlugs, complete, totalResults, allPortalLinks) {
  const index = {
    generatedAt:       new Date().toISOString(),
    complete,
    searchConfig:      config,
    locations:         config.searches.map(s => s.location),
    totalLocations:    config.searches.length,
    completedLocations: availableSlugs.length,
    totalResults:      totalResults ?? null,
    available:         availableSlugs,
    baseline:          baselineData || null,
    portalLinks:       allPortalLinks || [],
  };
  fs.writeFileSync(path.join(resultsDir, 'index.json'), JSON.stringify(index, null, 2));
}

// ---- Final cross-location pass: same-URL dedup + duplicate detection ----
async function finalPass(resultsDir, slugs) {
  console.log('\n=== Final pass: cross-location dedup + duplicate detection ===');

  // Load all location files into a flat array, tracking offsets per slug
  const allProperties = [];
  const slugOffsets = {};

  for (const slug of slugs) {
    const filePath = path.join(resultsDir, `${slug}.json`);
    if (!fs.existsSync(filePath)) continue;
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    slugOffsets[slug] = { start: allProperties.length, count: data.properties.length, data };
    allProperties.push(...data.properties);
  }

  // Clear stale dupe flags
  for (const p of allProperties) {
    delete p.hasDuplicates; delete p.duplicateKeys;
    delete p.hasPotentialDuplicates; delete p.potentialDuplicateOf; delete p.duplicateSimilarity;
  }

  // Same-URL dedup
  let sameUrlRemoved = 0;
  const urlSeen = new Map();
  const removeIndices = new Set();

  for (let i = 0; i < allProperties.length; i++) {
    const p = allProperties[i];
    const url = getUrl(p);
    if (!url) continue;
    if (urlSeen.has(url)) {
      const { idx: existingIdx, prop: existing } = urlSeen.get(url);
      const contentChanged = existing.price !== p.price || existing.postedDate !== p.postedDate
        || (existing.description || '') !== (p.description || '');
      if (contentChanged) {
        const ed = new Date(existing.retrievedAt || 0).getTime();
        const nd = new Date(p.retrievedAt     || 0).getTime();
        if (nd > ed) { p.firstRetrievedAt = existing.retrievedAt; removeIndices.add(existingIdx); urlSeen.set(url, { idx: i, prop: p }); }
        else removeIndices.add(i);
      } else { removeIndices.add(i); }
      sameUrlRemoved++;
    } else { urlSeen.set(url, { idx: i, prop: p }); }
  }
  console.log(`Same-URL dedup: removed ${sameUrlRemoved}`);

  // Cross-URL duplicate check
  const crossGroups = {};
  for (let i = 0; i < allProperties.length; i++) {
    if (removeIndices.has(i)) continue;
    const p = allProperties[i];
    const key = `${normalizeAddress(p.address || '')}|${p.bedrooms || ''}|${p.bathrooms || ''}`;
    if (!crossGroups[key]) crossGroups[key] = [];
    crossGroups[key].push({ i, p });
  }
  let definiteCount = 0, potentialCount = 0;
  for (const group of Object.values(crossGroups)) {
    if (group.length < 2) continue;
    for (let a = 0; a < group.length; a++) {
      for (let b = a + 1; b < group.length; b++) {
        const { p: pa } = group[a], { p: pb } = group[b];
        if (getUrl(pa) === getUrl(pb)) continue;
        if (pa.price === pb.price) {
          pa.hasDuplicates = pb.hasDuplicates = true;
          (pa.duplicateKeys = pa.duplicateKeys || []).push(seedData.dedupKey(pb));
          (pb.duplicateKeys = pb.duplicateKeys || []).push(seedData.dedupKey(pa));
          definiteCount++;
        } else {
          const sim = descriptionSimilarity(pa.description, pb.description);
          if (sim >= 0.5 && pa.postedDate !== pb.postedDate) {
            pa.hasPotentialDuplicates = pb.hasPotentialDuplicates = true;
            pb.potentialDuplicateOf = getUrl(pa); pa.potentialDuplicateOf = getUrl(pb);
            pa.duplicateSimilarity  = pb.duplicateSimilarity  = Math.round(sim * 100);
            potentialCount++;
          }
        }
      }
    }
  }
  console.log(`Duplicate check: ${definiteCount} definite, ${potentialCount} potential`);

  // Rewrite location files with dupe flags applied and same-URL dupes removed
  let totalKept = 0;
  for (const slug of slugs) {
    const entry = slugOffsets[slug];
    if (!entry) continue;
    const { start, count, data } = entry;
    const kept = [];
    for (let i = start; i < start + count; i++) {
      if (!removeIndices.has(i)) kept.push(allProperties[i]);
    }
    data.properties = kept;
    data.count       = kept.length;
    data.dupePassAt  = new Date().toISOString();
    fs.writeFileSync(path.join(resultsDir, `${data.slug || slug}.json`), JSON.stringify(data, null, 2));
    totalKept += kept.length;
  }
  console.log(`Total after final pass: ${totalKept} properties across ${slugs.length} locations`);
  return totalKept;
}

// ---- Auto git push ----
function autoPush(done, total, isFinal) {
  const msg = isFinal
    ? `Build complete: ${total}/${total} locations`
    : `Build progress: ${done}/${total} locations`;
  console.log(`\n  → Git push: "${msg}"`);
  try {
    execSync(`git add docs/results/ seed-data.json && git diff --staged --quiet || git commit -m "${msg}" && git push`, {
      cwd: __dirname,
      stdio: 'pipe',
    });
    console.log('  ✓ Pushed');
  } catch (err) {
    console.warn(`  ⚠ Push failed: ${(err.stderr || err.message || '').toString().slice(0, 120)}`);
  }
}

// ---- --from-seed rebuild ----
async function buildFromSeed(config, resultsDir, airportsArr, flyoverSource, baselineData, ukTowns) {
  console.log('--from-seed: rebuilding location files from existing seed data');
  const allSeedProperties = seedData.getAll();
  console.log(`Full seed: ${allSeedProperties.length} properties`);

  // Build Rightmove location map
  const rmLocs = {};
  for (const s of config.searches) {
    if (!s.rightmoveId) continue;
    if (s.postcode) rmLocs[s.postcode.toLowerCase()] = s.rightmoveId;
    rmLocs[s.location.toLowerCase()] = s.rightmoveId;
  }

  // Group seed properties by searchLocation
  const byLocation = {};
  for (const p of allSeedProperties) {
    const loc = p.searchLocation || '__unknown__';
    if (!byLocation[loc]) byLocation[loc] = [];
    byLocation[loc].push(p);
  }

  const slugs = [];
  const allPortalLinks = [];
  const now = new Date().toISOString();

  for (const search of config.searches) {
    const slug = slugify(search.location);
    const props = (byLocation[search.location] || []).map(p => ({ ...p, isNew: false, retrievedAt: p.seedAddedAt || p.addedAt || now }));

    // Refresh criteria that may have changed since last scrape
    attachAutoReject(props);
    attachBaselineComparison(props, airportsArr, baselineData);
    if (ukTowns.length > 0) {
      await autoTagLocation(props, ukTowns, config);
    }

    // Build portal links
    const criteria = {
      locations: search.postcode || search.location,
      radius: String(search.radius),
      keywords: config.keywords || [],
      propertyTypes: config.propertyTypes || [],
      maxPrice: config.maxPrice,
      minBed: config.minBed,
    };
    const portalLinks = [];
    for (const portal of getPortals(config)) {
      for (const link of buildUrls(portal, criteria, rmLocs)) {
        portalLinks.push({ ...link, searchLocation: search.location });
        allPortalLinks.push({ ...link, searchLocation: search.location });
      }
    }

    const output = { location: search.location, slug, generatedAt: now, count: props.length, properties: props, portalLinks };
    fs.writeFileSync(path.join(resultsDir, `${slug}.json`), JSON.stringify(output, null, 2));
    console.log(`  ${search.location}: ${props.length} properties → docs/results/${slug}.json`);
    slugs.push(slug);
  }

  const total = await finalPass(resultsDir, slugs);
  writeIndex(resultsDir, config, baselineData, slugs, true, total, allPortalLinks);
  console.log('\nBuild complete!');
}

// ---- Auto-tag all location files (replaces adaptive recommend pass) ----
async function autoTagAllLocations(resultsDir, ukTowns, config, slugs, pushEvery = 0) {
  const ts = new Date().toISOString();
  let totalTagged = 0;
  let totalProperties = 0;
  let done = 0;

  for (const slug of slugs) {
    const filePath = path.join(resultsDir, `${slug}.json`);
    if (!fs.existsSync(filePath)) continue;
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const { chosenThreshold, totalTagged: tagged, eligibleCount } = await autoTagLocation(data.properties, ukTowns, config);
    data.autoTaggedAt = ts;
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    console.log(`  ${data.location}: ${tagged}/${eligibleCount} tagged (threshold: ${Math.round(chosenThreshold * 100)}%)`);
    totalTagged     += tagged;
    totalProperties += data.properties.length;
    done++;

    if (pushEvery > 0 && done % pushEvery === 0) {
      autoPush(done, slugs.length, false);
    }
  }

  return { totalTagged, totalProperties };
}

// ---- --rescore-flyover: stamp sourceLocation + re-attach flyover on all existing files ----
async function rescoreFlyoverResults(config, resultsDir, airportsArr, baselineData) {
  const indexPath = path.join(resultsDir, 'index.json');
  if (!fs.existsSync(indexPath)) {
    console.error('No docs/results/index.json found — run a full build first.');
    process.exit(1);
  }
  const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  let slugs = index.available || [];
  if (slugs.length === 0) {
    slugs = fs.readdirSync(resultsDir)
      .filter(f => f.endsWith('.json') && f !== 'index.json')
      .map(f => f.replace(/\.json$/, ''));
  }
  const flyoverSource = path.join(__dirname, 'data', 'flyover-reference.json');
  const searchLocations = config.searches.map(s => s.location);
  console.log(`\nRe-attaching flyover data for ${slugs.length} location file(s)…`);
  let done = 0;

  for (const slug of slugs) {
    const filePath = path.join(resultsDir, `${slug}.json`);
    if (!fs.existsSync(filePath)) continue;
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

    // Stamp sourceLocation from the file's own location field (fixes existing data)
    for (const p of data.properties) {
      if (!p.sourceLocation) p.sourceLocation = data.location;
    }

    // Re-attach flyover using corrected sourceLocation lookup
    if (fs.existsSync(flyoverSource)) {
      attachFlyoverData(data.properties, searchLocations);
    }

    // Re-attach baseline comparison (depends on flyoverRef.flightsPerDay)
    attachBaselineComparison(data.properties, airportsArr, baselineData);

    data.flyoverRescoredAt = new Date().toISOString();
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    done++;
    console.log(`  ${data.location}: ${data.properties.length} properties re-scored`);

    if (PUSH_EVERY > 0 && done % PUSH_EVERY === 0) {
      autoPush(done, slugs.length, false);
    }
  }

  index.flyoverRescoredAt = new Date().toISOString();
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));
  console.log(`\nDone. Flyover re-scored for ${done} locations.`);
  if (PUSH_EVERY > 0) autoPush(slugs.length, slugs.length, true);
}

// ---- --rescore: re-run auto-tag on all existing docs/results/ files ----
async function rescoreResults(config, resultsDir, ukTowns) {
  const indexPath = path.join(resultsDir, 'index.json');
  if (!fs.existsSync(indexPath)) {
    console.error('No docs/results/index.json found — run a full build first.');
    process.exit(1);
  }
  const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  let slugs = index.available || [];
  if (slugs.length === 0) {
    slugs = fs.readdirSync(resultsDir)
      .filter(f => f.endsWith('.json') && f !== 'index.json')
      .map(f => f.replace(/\.json$/, ''));
    if (slugs.length > 0) console.log(`index.available was empty — found ${slugs.length} file(s) by directory scan`);
  }
  console.log(`\nAuto-tagging ${slugs.length} location file(s)…`);

  const { totalTagged, totalProperties } = await autoTagAllLocations(resultsDir, ukTowns, config, slugs, PUSH_EVERY);

  index.available          = slugs;
  index.complete           = true;
  index.completedLocations = slugs.length;
  index.totalResults       = totalProperties;
  index.rescoredAt         = new Date().toISOString();
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));
  console.log(`\nDone. ${totalTagged} properties auto-tagged across ${totalProperties} total.`);
  if (PUSH_EVERY > 0) autoPush(slugs.length, slugs.length, true);
}

// ---- main ----
async function main() {
  const config    = JSON.parse(fs.readFileSync(path.join(__dirname, 'search-config.json'), 'utf8'));
  buildAutoRejectFromConfig(config.autoReject);
  const docsDir   = path.join(__dirname, 'docs');
  const resultsDir = path.join(docsDir, 'results');
  const timeout   = config.queryTimeoutMs || 10000;
  const concurrency = config.maxConcurrentPortals || 2;
  const fromSeed  = process.argv.includes('--from-seed');
  const rescore         = process.argv.includes('--rescore');
  const rescoreFlyover  = process.argv.includes('--rescore-flyover');

  // Ensure results/ directory exists
  if (!fs.existsSync(resultsDir)) fs.mkdirSync(resultsDir, { recursive: true });

  // Push any uncommitted results left over from a previous partial run before starting new queries
  if (PUSH_EVERY > 0) {
    try {
      const status = execSync('git status --porcelain docs/results/ seed-data.json', { cwd: __dirname }).toString().trim();
      if (status) {
        console.log('\nUnpublished results found from previous run — pushing before starting new queries...');
        execSync('git add docs/results/ seed-data.json && git diff --staged --quiet || (git commit -m "Push unpublished results before new build" && git push)', { cwd: __dirname, stdio: 'pipe' });
        console.log('✓ Unpublished results pushed\n');
      }
    } catch (err) {
      console.warn(`⚠ Pre-build push failed: ${(err.stderr || err.message || '').toString().slice(0, 120)}`);
    }
  }

  // Copy static assets
  const airportsSource  = path.join(__dirname, 'data', 'airports.json');
  const flyoverSource   = path.join(__dirname, 'data', 'flyover-reference.json');
  const ukTownsSource   = path.join(__dirname, 'data', 'uk-towns.json');
  fs.copyFileSync(airportsSource, path.join(docsDir, 'airports.json'));
  console.log('Copied airports.json');
  if (fs.existsSync(flyoverSource)) {
    fs.copyFileSync(flyoverSource, path.join(docsDir, 'flyover-reference.json'));
    console.log('Copied flyover-reference.json');
  }

  // Load airports array for countInRadius (baseline comparison)
  const airportsArr = JSON.parse(fs.readFileSync(path.join(docsDir, 'airports.json'), 'utf8')).airfields || [];

  // Load UK towns for auto-tag distance gate
  const autoTagCfg    = config.autoTag || config.recommend || {};
  const autoTagEnabled = autoTagCfg.enabled !== false;
  let ukTowns = [];
  if (autoTagEnabled) {
    if (!fs.existsSync(ukTownsSource)) {
      console.warn('⚠ uk-towns.json not found — run: node scripts/fetch-uk-towns.js');
      console.warn('  Auto-tag step will be skipped.');
    } else {
      ukTowns = JSON.parse(fs.readFileSync(ukTownsSource, 'utf8'));
      const minPop = autoTagCfg.minTownPopulation ?? 15000;
      fs.copyFileSync(ukTownsSource, path.join(docsDir, 'uk-towns.json'));
      console.log(`Loaded ${ukTowns.length} UK towns (pop≥${minPop.toLocaleString()}) for auto-tag checks`);
      if (USE_ML) {
        try {
          const { pipeline, env } = require('@xenova/transformers');
          env.cacheDir = path.join(mainDir, '..', '.model-cache');
          env.allowRemoteModels = false;
          await initML(pipeline);
        } catch (err) {
          console.warn(`ML not available (${err.message.slice(0, 80)}), using keyword scoring`);
        }
      }
    }
  }

  // Geocode baseline once up front
  const baselineData = await geocodeBaseline(config, airportsArr, flyoverSource);

  if (fromSeed) {
    return await buildFromSeed(config, resultsDir, airportsArr, flyoverSource, baselineData, ukTowns);
  }

  if (rescore) {
    return await rescoreResults(config, resultsDir, ukTowns);
  }

  if (rescoreFlyover) {
    return await rescoreFlyoverResults(config, resultsDir, airportsArr, baselineData);
  }

  const PORTALS = getPortals(config);

  // Build Rightmove location ID map
  const rmLocations = {};
  for (const s of config.searches) {
    if (!s.rightmoveId) continue;
    if (s.postcode) rmLocations[s.postcode.toLowerCase()] = s.rightmoveId;
    rmLocations[s.location.toLowerCase()] = s.rightmoveId;
  }

  // Load existing index when doing a partial (--locations=) build so old results are preserved
  let existingSlugs        = [];
  let existingTotalResults = 0;
  let existingPortalLinks  = [];
  const indexPath = path.join(resultsDir, 'index.json');
  if ((locationFilter || RESUME) && fs.existsSync(indexPath)) {
    try {
      const existing       = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
      existingSlugs        = existing.available        || [];
      existingTotalResults = existing.totalResults     || 0;
      existingPortalLinks  = existing.portalLinks      || [];
      console.log(`Partial build: preserving ${existingSlugs.length} existing locations`);
    } catch {}
  }

  // Filter searches to only the requested locations
  const activeSearches = locationFilter
    ? config.searches.filter(s =>
        locationFilter.includes(s.location.toLowerCase()) ||
        locationFilter.includes(slugify(s.location))
      )
    : RESUME
    ? config.searches.filter(s => !existingSlugs.includes(slugify(s.location)))
    : config.searches;
  if (locationFilter) console.log(`Location filter: ${activeSearches.map(s => s.location).join(', ')}`);
  if (RESUME) console.log(`Resume: skipping ${existingSlugs.length} already-built locations, ${activeSearches.length} remaining`);

  // Write initial index keeping existing results visible while new ones build
  writeIndex(resultsDir, config, baselineData, existingSlugs, existingSlugs.length > 0, existingSlugs.length > 0 ? existingTotalResults : null, existingPortalLinks);

  const allPortalLinks  = [];
  const completedSlugs  = [];

  for (let si = 0; si < activeSearches.length; si++) {
    const search   = activeSearches[si];
    const slug     = slugify(search.location);
    const queryLoc = search.postcode || search.location;
    console.log(`\n=== [${si + 1}/${activeSearches.length}] ${search.location}${search.postcode ? ` (${search.postcode})` : ''} ===`);

    const criteria = {
      locations:     queryLoc,
      radius:        String(search.radius),
      keywords:      config.keywords      || [],
      propertyTypes: config.propertyTypes || [],
      maxPrice:      config.maxPrice      || undefined,
      minBed:        config.minBed        || undefined,
    };
    const countyCriteria = search.county ? { ...criteria, locations: search.county } : null;

    // Build portal links for this location
    const locationPortalLinks = [];
    for (const portal of PORTALS) {
      for (const link of buildUrls(portal, criteria, rmLocations)) {
        locationPortalLinks.push({ ...link, searchLocation: search.location });
        allPortalLinks.push({ ...link, searchLocation: search.location });
      }
    }

    // Scrape all portals concurrently
    const pool          = makePool(concurrency);
    const locationResults = [];

    const portalTasks = PORTALS.flatMap(portal => {
      if (!parsers[portal.id]) return [];
      const urls = buildUrls(portal, criteria, rmLocations);

      return urls.map(link => pool(async () => {
        let listings = [];
        const tStart = Date.now();
        console.log(`  → [${new Date().toLocaleTimeString()}] ${portal.name} | ${search.location}: ${link.url}`);
        try {
          listings = await withTimeout(parsers[portal.id].scrape(link.url), timeout, link.url);
        } catch (err) {
          console.log(`  ← [${new Date().toLocaleTimeString()}] ${portal.name} | ${search.location}: ERROR after ${((Date.now()-tStart)/1000).toFixed(1)}s — ${err.message.slice(0, 80)}`);
        }

        // County fallback
        if (listings.length === 0 && countyCriteria) {
          try {
            const fallbackUrls  = buildUrls(portal, countyCriteria, rmLocations);
            const fallbackLink  = fallbackUrls[0];
            if (fallbackLink && fallbackLink.url !== link.url) {
              console.log(`  → [${new Date().toLocaleTimeString()}] ${portal.name} | ${search.location} [county fallback: ${search.county}]`);
              listings = await withTimeout(parsers[portal.id].scrape(fallbackLink.url), timeout, fallbackLink.url);
            }
          } catch (err) {
            console.log(`  ← County fallback failed: ${err.message.slice(0, 80)}`);
          }
        }

        // Verbose response summary
        const elapsed = ((Date.now() - tStart) / 1000).toFixed(1);
        const rejectTally = {};
        for (const l of listings) {
          const text = `${l.title || ''} ${l.type || ''}`;
          for (const { re, label } of AUTO_REJECT_PATTERNS) {
            if (re.test(text)) { rejectTally[label] = (rejectTally[label] || 0) + 1; break; }
          }
        }
        const totalRejected  = Object.values(rejectTally).reduce((a, b) => a + b, 0);
        const rejectDetail   = totalRejected > 0
          ? `, ${totalRejected} auto-reject (${Object.entries(rejectTally).map(([k, v]) => `${k}: ${v}`).join(', ')})`
          : '';
        console.log(`  ← [${new Date().toLocaleTimeString()}] ${portal.name} | ${search.location}: ${listings.length} returned, ${listings.length - totalRejected} kept${rejectDetail} [${elapsed}s]`);

        listings.forEach(l => l.searchLocation = search.location);
        locationResults.push(...listings);
      }));
    });

    await Promise.allSettled(portalTasks);

    // Enrich + write location file immediately
    await processLocation(search, locationResults, locationPortalLinks, config, resultsDir, airportsArr, flyoverSource, baselineData, ukTowns);
    completedSlugs.push(slug);

    // Update index so app can see the new location (merged with existing)
    writeIndex(resultsDir, config, baselineData, [...new Set([...existingSlugs, ...completedSlugs])], false, null, [...existingPortalLinks, ...allPortalLinks]);

    // Auto push every N locations
    if (PUSH_EVERY > 0 && (si + 1) % PUSH_EVERY === 0) {
      autoPush(si + 1, config.searches.length, false);
    }
  }

  await closeBrowser();

  // Final cross-location pass (dupe detection + same-URL dedup)
  const totalResults = await finalPass(resultsDir, completedSlugs);

  // Auto-tag pass across ALL location files (new + existing) — removes old recommend tags
  if (autoTagEnabled && ukTowns.length > 0) {
    const allSlugsForTag = [...new Set([...existingSlugs, ...completedSlugs])];
    console.log(`\nRunning auto-tag pass on ${allSlugsForTag.length} location(s)…`);
    const { totalTagged, totalProperties } = await autoTagAllLocations(resultsDir, ukTowns, config, allSlugsForTag);
    console.log(`Auto-tag: ${totalTagged} properties tagged across ${totalProperties} total`);
  }

  // Write complete index (merge new slugs with existing)
  const allSlugs = [...new Set([...existingSlugs, ...completedSlugs])];
  writeIndex(resultsDir, config, baselineData, allSlugs, true, (totalResults || 0) + existingTotalResults, [...existingPortalLinks, ...allPortalLinks]);
  console.log('\nBuild complete!');

  // Final git push
  if (PUSH_EVERY > 0) {
    autoPush(config.searches.length, config.searches.length, true);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
