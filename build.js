'use strict';
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Reuse modules from the main project
const mainDir = path.join(__dirname, '..', 'property-search', 'server');
const { getBrowser, closeBrowser } = require(path.join(mainDir, 'browser'));
const { deduplicate, normalizeAddress, descriptionSimilarity, getUrl } = require(path.join(mainDir, 'dedup'));
const { findNearestByCategory } = require(path.join(mainDir, 'airports'));
const { geocodeResults } = require(path.join(mainDir, 'geocode'));
const { buildUrls } = require(path.join(mainDir, 'portals'));
const { analyzeProperties } = require(path.join(mainDir, 'imageAnalyzer'));
const { attachFlyoverData } = require(path.join(mainDir, 'flyovers'));
const { initML, assessProperty } = require(path.join(mainDir, 'recommend'));
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
const PORTALS = portalFilter ? ALL_PORTALS.filter(p => portalFilter.includes(p.id)) : ALL_PORTALS;

const pushEveryArg = process.argv.find(a => a.startsWith('--push-every='));
const PUSH_EVERY   = pushEveryArg ? (parseInt(pushEveryArg.split('=')[1]) || 0) : 0;
const USE_ML       = process.argv.includes('--ml-recommend');

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
      let nearestRef = null, nearestDist = Infinity;
      for (const loc of flyoverLocs) {
        if (loc.lat == null) continue;
        const d = haversineDistMilesBuild(blLat, blLon, loc.lat, loc.lon);
        if (d < nearestDist) { nearestDist = d; nearestRef = loc; }
      }
      if (nearestRef) { blFlightsPerDay = nearestRef.flightsPerDay; console.log(`  Flyover: ${nearestRef.location} (${nearestDist.toFixed(1)} mi) → ${blFlightsPerDay} flights/day`); }
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

  // 3. Auto-reject flag
  attachAutoReject(results);

  // 4. Geocode
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

  // 9. Recommendation assessment (--recommend or config.recommend.enabled)
  const recommendEnabled = process.argv.includes('--recommend') || process.argv.includes('--ml-recommend') || config.recommend?.enabled;
  if (recommendEnabled && ukTowns && ukTowns.length > 0) {
    // Fetch detail pages for properties that could pass the distance gate
    const _browser = await getBrowser();
    const _page = await _browser.newPage();
    const minMiles = Math.min(
      config.recommend?.minDistanceToTownMiles    ?? 15,
      config.recommend?.minDistanceToAirportMiles ?? 15,
      config.recommend?.minDistanceToHelipadMiles ?? 15,
      5 // always fetch down to the adaptive floor
    );
    await enrichWithDetails(_page, results, ukTowns, minMiles);
    await _page.close();

    let recommended = 0;
    for (const r of results) {
      if (r.lat == null) continue;
      const assessment = await assessProperty(r, ukTowns, config);
      Object.assign(r, assessment);
      if (r.recommended) recommended++;
    }
    console.log(`  Recommended: ${recommended}/${results.length}`);
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

  // 12. Write location file
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
    execSync(`git add docs/results/ && git commit -m "${msg}" && git push`, {
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
      for (const r of props) {
        if (r.lat == null) continue;
        const assessment = await assessProperty(r, ukTowns, config);
        Object.assign(r, assessment);
      }
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
    for (const portal of PORTALS) {
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

// ---- Adaptive recommendation scoring across all location files ----
// Starts at config distances, reduces by 1 mile per iteration until ≥1 result or floor (5mi) is reached.
async function adaptiveRescore(resultsDir, ukTowns, config, slugs, page) {
  const rec      = config.recommend || {};
  const MIN_FLOOR = 5;

  let minTown    = rec.minDistanceToTownMiles    ?? 15;
  let minAirport = rec.minDistanceToAirportMiles ?? 15;
  let minHelipad = rec.minDistanceToHelipadMiles ?? 15;

  // Pre-fetch detail pages once (for all props that could pass even the most lenient gate).
  // Stores result in property.fullDescription so assessProperty picks it up automatically.
  if (page) {
    console.log('  Fetching detail pages for distance-eligible properties…');
    for (const slug of slugs) {
      const filePath = path.join(resultsDir, `${slug}.json`);
      if (!fs.existsSync(filePath)) continue;
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const before = data.properties.filter(p => p.fullDescription).length;
      await enrichWithDetails(page, data.properties, ukTowns, MIN_FLOOR);
      const after = data.properties.filter(p => p.fullDescription).length;
      if (after > before) {
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
        console.log(`    ${slug}: fetched ${after - before} detail page(s)`);
      }
    }
  }

  let finalData  = null;
  let finalCount = 0;
  let effectiveMins = { minTown, minAirport, minHelipad };

  while (true) {
    const iterConfig = {
      ...config,
      recommend: { ...rec, minDistanceToTownMiles: minTown, minDistanceToAirportMiles: minAirport, minDistanceToHelipadMiles: minHelipad },
    };

    let totalRecommended = 0;
    const iteration = [];
    for (const slug of slugs) {
      const filePath = path.join(resultsDir, `${slug}.json`);
      if (!fs.existsSync(filePath)) continue;
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      let recommended = 0;
      for (const r of data.properties) {
        if (r.lat == null) continue;
        const assessment = await assessProperty(r, ukTowns, iterConfig);
        Object.assign(r, assessment);
        if (r.recommended) recommended++;
      }
      totalRecommended += recommended;
      iteration.push({ filePath, data, recommended });
    }

    const atFloor = minTown <= MIN_FLOOR && minAirport <= MIN_FLOOR && minHelipad <= MIN_FLOOR;
    console.log(`  town≥${minTown}mi airport≥${minAirport}mi helipad≥${minHelipad}mi → ${totalRecommended} recommended`);

    if (totalRecommended > 0 || atFloor) {
      finalData  = iteration;
      finalCount = totalRecommended;
      effectiveMins = { minTown, minAirport, minHelipad };
      break;
    }

    minTown    = Math.max(MIN_FLOOR, minTown    - 1);
    minAirport = Math.max(MIN_FLOOR, minAirport - 1);
    minHelipad = Math.max(MIN_FLOOR, minHelipad - 1);
  }

  const ts = new Date().toISOString();
  let totalProperties = 0;
  for (const { filePath, data, recommended } of finalData) {
    data.rescoredAt = ts;
    data.effectiveRecommendConfig = effectiveMins;
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    console.log(`  ${data.location}: ${recommended}/${data.properties.length} recommended`);
    totalProperties += data.properties.length;
  }

  return { totalRecommended: finalCount, totalProperties, slugs: finalData.map(d => d.filePath), ...effectiveMins };
}

// ---- --rescore: re-run recommendation on existing docs/results/ files ----
async function rescoreResults(config, resultsDir, ukTowns) {
  const indexPath = path.join(resultsDir, 'index.json');
  if (!fs.existsSync(indexPath)) {
    console.error('No docs/results/index.json found — run a full build first.');
    process.exit(1);
  }
  const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  // Prefer index.available, but fall back to scanning the directory so --rescore
  // works even when a previous build crashed before writing the final index.
  let slugs = index.available || [];
  if (slugs.length === 0) {
    slugs = fs.readdirSync(resultsDir)
      .filter(f => f.endsWith('.json') && f !== 'index.json')
      .map(f => f.replace(/\.json$/, ''));
    if (slugs.length > 0) console.log(`index.available was empty — found ${slugs.length} file(s) by directory scan`);
  }
  console.log(`\nRescoring ${slugs.length} location file(s) with adaptive distance reduction…`);

  const browser = await getBrowser();
  const page    = await browser.newPage();
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-GB,en;q=0.9' });

  const { totalRecommended, totalProperties, minTown, minAirport, minHelipad } =
    await adaptiveRescore(resultsDir, ukTowns, config, slugs, page);

  await closeBrowser();

  // Rebuild index with correct available list and complete flag
  index.available          = slugs;
  index.complete           = true;
  index.completedLocations = slugs.length;
  index.totalResults       = totalProperties;
  index.rescoredAt         = new Date().toISOString();
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));
  console.log(`\nDone. ${totalRecommended}/${totalProperties} recommended (town≥${minTown}mi, airport≥${minAirport}mi, helipad≥${minHelipad}mi)`);
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
  const rescore   = process.argv.includes('--rescore');

  // Ensure results/ directory exists
  if (!fs.existsSync(resultsDir)) fs.mkdirSync(resultsDir, { recursive: true });

  // Copy static assets
  const airportsSource  = path.join(__dirname, '..', 'property-search', 'public', 'airports.json');
  const flyoverSource   = path.join(__dirname, '..', 'property-search', 'public', 'flyover-reference.json');
  const ukTownsSource   = path.join(__dirname, '..', 'property-search', 'public', 'uk-towns.json');
  fs.copyFileSync(airportsSource, path.join(docsDir, 'airports.json'));
  console.log('Copied airports.json');
  if (fs.existsSync(flyoverSource)) {
    fs.copyFileSync(flyoverSource, path.join(docsDir, 'flyover-reference.json'));
    console.log('Copied flyover-reference.json');
  }

  // Load airports array for countInRadius (baseline comparison)
  const airportsArr = JSON.parse(fs.readFileSync(path.join(docsDir, 'airports.json'), 'utf8')).airfields || [];

  // Load UK towns for recommendation distance check
  const recommendEnabled = process.argv.includes('--recommend') || process.argv.includes('--ml-recommend') || config.recommend?.enabled;
  let ukTowns = [];
  if (recommendEnabled) {
    if (!fs.existsSync(ukTownsSource)) {
      console.warn('⚠ uk-towns.json not found — run: node scripts/fetch-uk-towns.js');
      console.warn('  Recommendation step will be skipped.');
    } else {
      ukTowns = JSON.parse(fs.readFileSync(ukTownsSource, 'utf8'));
      const minPop = config.recommend?.minTownPopulation ?? 10000;
      if (minPop > 0) ukTowns = ukTowns.filter(t => t.pop >= minPop);
      fs.copyFileSync(ukTownsSource, path.join(docsDir, 'uk-towns.json'));
      console.log(`Loaded ${ukTowns.length} UK towns (pop≥${minPop.toLocaleString()}) for recommendation checks`);
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

  // Build Rightmove location ID map
  const rmLocations = {};
  for (const s of config.searches) {
    if (!s.rightmoveId) continue;
    if (s.postcode) rmLocations[s.postcode.toLowerCase()] = s.rightmoveId;
    rmLocations[s.location.toLowerCase()] = s.rightmoveId;
  }

  // Write initial empty index so app can detect a build is in progress
  writeIndex(resultsDir, config, baselineData, [], false, null, []);

  const allPortalLinks  = [];
  const completedSlugs  = [];

  for (let si = 0; si < config.searches.length; si++) {
    const search   = config.searches[si];
    const slug     = slugify(search.location);
    const queryLoc = search.postcode || search.location;
    console.log(`\n=== [${si + 1}/${config.searches.length}] ${search.location}${search.postcode ? ` (${search.postcode})` : ''} ===`);

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

    // Update index so app can see the new location
    writeIndex(resultsDir, config, baselineData, completedSlugs, false, null, allPortalLinks);

    // Auto push every N locations
    if (PUSH_EVERY > 0 && (si + 1) % PUSH_EVERY === 0) {
      autoPush(si + 1, config.searches.length, false);
    }
  }

  await closeBrowser();

  // Final cross-location pass (dupe detection + same-URL dedup)
  const totalResults = await finalPass(resultsDir, completedSlugs);

  // Adaptive recommendation pass across all locations
  if (recommendEnabled && ukTowns.length > 0) {
    console.log('\nRunning adaptive recommendation pass…');
    const _browser = await getBrowser();
    const _page    = await _browser.newPage();
    await _page.setExtraHTTPHeaders({ 'Accept-Language': 'en-GB,en;q=0.9' });
    const { totalRecommended, minTown, minAirport, minHelipad } =
      await adaptiveRescore(resultsDir, ukTowns, config, completedSlugs, _page);
    await _page.close();
    console.log(`Recommendation: ${totalRecommended} recommended (town≥${minTown}mi, airport≥${minAirport}mi, helipad≥${minHelipad}mi)`);
  }

  // Write complete index
  writeIndex(resultsDir, config, baselineData, completedSlugs, true, totalResults, allPortalLinks);
  console.log('\nBuild complete!');

  // Final git push
  if (PUSH_EVERY > 0) {
    autoPush(config.searches.length, config.searches.length, true);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
