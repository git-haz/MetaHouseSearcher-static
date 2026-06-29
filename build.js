const fs = require('fs');
const path = require('path');

// Reuse modules from the main project
const mainDir = path.join(__dirname, '..', 'property-search', 'server');
const { closeBrowser } = require(path.join(mainDir, 'browser'));
const { deduplicate, normalizeAddress, descriptionSimilarity, getUrl } = require(path.join(mainDir, 'dedup'));
const { findNearestByCategory } = require(path.join(mainDir, 'airports'));
const { geocodeResults } = require(path.join(mainDir, 'geocode'));
const { buildUrls } = require(path.join(mainDir, 'portals'));
const { analyzeProperties } = require(path.join(mainDir, 'imageAnalyzer'));
const { attachFlyoverData } = require(path.join(mainDir, 'flyovers'));
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
  { id: 'zoopla', name: 'Zoopla', enabled: true },
  { id: 'onthemarket', name: 'OnTheMarket', enabled: true },
  { id: 'durrants', name: 'Durrants', enabled: true },
  { id: 'rightmove', name: 'Rightmove', enabled: true },
  { id: 'savills', name: 'Savills', enabled: true },
  { id: 'struttandparker', name: 'Strutt & Parker', enabled: true },
  { id: 'jackson-stops', name: 'Jackson-Stops', enabled: true },
  { id: 'winkworth', name: 'Winkworth', enabled: true },
];

// --portals=durrants,zoopla to limit which portals to scrape
const portalArg = process.argv.find(a => a.startsWith('--portals='));
const portalFilter = portalArg ? portalArg.split('=')[1].split(',').map(s => s.trim().toLowerCase()) : null;
const PORTALS = portalFilter
  ? ALL_PORTALS.filter(p => portalFilter.includes(p.id))
  : ALL_PORTALS;

const AUTO_REJECT_PATTERNS = [
  /\bsemi[-\s]?detached\b/i,
  /\blink[-\s]?detached\b/i,
  /\bend[-\s]?(?:of[-\s]?)?terrace\b/i,
  /\bterraced\b/i,
  /\bterrace\s+house\b/i,
];

function slugify(loc) {
  return loc.toLowerCase().trim().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
}

async function main() {
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'search-config.json'), 'utf8'));
  const docsDir = path.join(__dirname, 'docs');

  // Copy airports.json
  const airportsSource = path.join(__dirname, '..', 'property-search', 'public', 'airports.json');
  fs.copyFileSync(airportsSource, path.join(docsDir, 'airports.json'));
  console.log('Copied airports.json');

  const allResults = [];
  const allPortalLinks = [];

  for (const search of config.searches) {
    console.log(`\n=== Searching: ${search.location} (${search.radius} mile radius) ===`);

    const criteria = {
      locations: search.location,
      radius: String(search.radius),
      keywords: config.keywords || [],
      propertyTypes: config.propertyTypes || [],
      maxPrice: config.maxPrice || undefined,
      minBed: config.minBed || undefined,
    };

    const rmLocations = { wenhaston: 'REGION^1264', diss: 'REGION^425', harleston: 'REGION^11918', laxfield: 'REGION^14740' };

    for (const portal of PORTALS) {
      const urls = buildUrls(portal, criteria, rmLocations);
      for (const link of urls) {
        allPortalLinks.push({ ...link, searchLocation: search.location });
      }

      if (parsers[portal.id]) {
        for (const link of urls) {
          try {
            console.log(`  Scraping ${portal.name}: ${link.url}`);
            const listings = await parsers[portal.id].scrape(link.url);
            listings.forEach(l => l.searchLocation = search.location);
            console.log(`    Found ${listings.length} listings`);
            allResults.push(...listings);
          } catch (err) {
            console.error(`    Error: ${err.message}`);
          }
        }
      }
    }
  }

  await closeBrowser();

  // Deduplicate
  console.log(`\nTotal raw listings: ${allResults.length}`);
  let results = deduplicate(allResults);
  console.log(`After dedup: ${results.length}`);

  // Merge searchLocation for deduped results
  const locationMap = new Map();
  for (const r of allResults) {
    const key = (r.address || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!locationMap.has(key)) locationMap.set(key, new Set());
    locationMap.get(key).add(r.searchLocation);
  }
  for (const r of results) {
    const key = (r.address || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    r.searchLocations = [...(locationMap.get(key) || [])];
  }

  // Auto-reject
  let rejectedCount = 0;
  for (const r of results) {
    const text = `${r.title || ''} ${r.type || ''}`;
    r.autoRejected = AUTO_REJECT_PATTERNS.some(re => re.test(text));
    if (r.autoRejected) rejectedCount++;
  }
  console.log(`Auto-rejected: ${rejectedCount}`);

  // Geocode
  const allLocations = config.searches.map(s => s.location);
  console.log('\nGeocoding...');
  await geocodeResults(results, allLocations);
  const geocoded = results.filter(r => r.lat != null).length;
  console.log(`Geocoded: ${geocoded}/${results.length}`);

  // Airport distances
  for (const r of results) {
    const nearest = findNearestByCategory(r.lat, r.lon);
    r.nearestAirport = nearest.airport;
    r.nearestAirstrip = nearest.airstrip;
    r.nearestHeliport = nearest.heliport;
    const dists = [nearest.airport, nearest.airstrip, nearest.heliport]
      .filter(Boolean).map(a => a.distanceMiles);
    r.minAirportDistanceMiles = dists.length ? Math.min(...dists) : null;
  }

  // Flyover reference data
  const flyoverSource = path.join(__dirname, '..', 'property-search', 'public', 'flyover-reference.json');
  if (fs.existsSync(flyoverSource)) {
    fs.copyFileSync(flyoverSource, path.join(docsDir, 'flyover-reference.json'));
    console.log('Copied flyover-reference.json');
    attachFlyoverData(results, allLocations);
    const withFlyover = results.filter(r => r.flyoverRef).length;
    console.log(`Flyover data attached to ${withFlyover}/${results.length} properties`);
  }

  // Image analysis — only if --analyze flag is passed
  if (process.argv.includes('--analyze')) {
    const threshold = config.neighbourConfidenceThreshold || 0.95;
    console.log(`\nAnalyzing property images (threshold: ${threshold * 100}%)...`);
    await analyzeProperties(results, threshold);
    for (const r of results) {
      if (r.neighbourConfidence < threshold) r.neighbourDetected = false;
    }
    const flagged = results.filter(r => r.neighbourDetected).length;
    console.log(`Flagged: ${flagged}/${results.length}`);
  } else {
    console.log('\nSkipping image analysis (use --analyze to enable)');
  }

  // Keywords matched
  const keywords = (config.keywords || []).map(k => k.toLowerCase().trim()).filter(Boolean);
  for (const r of results) {
    r.keywordsMatched = 0;
    if (keywords.length > 0) {
      const text = `${r.title} ${r.description} ${r.address}`.toLowerCase();
      r.keywordsMatched = keywords.filter(kw => text.includes(kw)).length;
    }
  }

  // Merge into seed data
  console.log('\nMerging seed data...');
  const mergeStats = seedData.mergeResults(results);
  console.log(`Seed: ${mergeStats.added} new, ${mergeStats.updated} updated, ${mergeStats.duplicates} dupes (${mergeStats.total} total)`);

  // Build output from FULL seed (all accumulated properties, not just this scrape)
  const allSeedProperties = seedData.getAll();
  console.log(`\nFull seed: ${allSeedProperties.length} properties`);

  // Mark newly scraped properties
  const newKeys = new Set(results.map(r => seedData.dedupKey(r)));
  for (const p of allSeedProperties) {
    const key = seedData.dedupKey(p);
    p.isNew = newKeys.has(key);
    p.retrievedAt = p.seedAddedAt || p.addedAt || new Date().toISOString();
    if (p.seedUpdatedAt) p.lastUpdatedAt = p.seedUpdatedAt;
  }

  // Recheck all seed properties for duplicates using new logic
  let sameUrlRemoved = 0, definiteCount = 0, potentialCount = 0;

  // Reset flags
  for (const p of allSeedProperties) {
    delete p.hasDuplicates;
    delete p.duplicateKeys;
    delete p.hasPotentialDuplicates;
    delete p.potentialDuplicateOf;
    delete p.duplicateSimilarity;
  }

  // Phase 1: Same-URL dedup — remove duplicates from the list
  // Content identical: keep oldest. Content changed: keep newer.
  const urlSeen = new Map();
  const removeIndices = new Set();
  for (let i = 0; i < allSeedProperties.length; i++) {
    const p = allSeedProperties[i];
    const url = getUrl(p);
    if (!url) continue;

    if (urlSeen.has(url)) {
      const { idx, prop: existing } = urlSeen.get(url);
      const contentChanged = existing.price !== p.price
        || existing.postedDate !== p.postedDate
        || (existing.description || '') !== (p.description || '');

      if (contentChanged) {
        // Keep newer, discard older
        const existingDate = new Date(existing.retrievedAt || existing.seedAddedAt || 0).getTime();
        const newDate = new Date(p.retrievedAt || p.seedAddedAt || 0).getTime();
        if (newDate > existingDate) {
          // New is newer — keep new, remove old, preserve original retrieval date
          p.firstRetrievedAt = existing.retrievedAt || existing.seedAddedAt;
          removeIndices.add(idx);
          urlSeen.set(url, { idx: i, prop: p });
        } else {
          // Existing is newer — discard new
          removeIndices.add(i);
        }
      } else {
        // Content identical — keep oldest (lower index = earlier added), discard newer
        removeIndices.add(i);
      }
      sameUrlRemoved++;
    } else {
      urlSeen.set(url, { idx: i, prop: p });
    }
  }

  // Remove same-URL duplicates
  const dedupedSeed = allSeedProperties.filter((_, i) => !removeIndices.has(i));
  console.log(`Same-URL dedup: removed ${sameUrlRemoved} duplicates (${allSeedProperties.length} → ${dedupedSeed.length})`);

  // Phase 2: Cross-URL: group by normalised address + beds + baths
  const crossGroups = {};
  for (const p of dedupedSeed) {
    const addr = normalizeAddress(p.address || '');
    const key = `${addr}|${p.bedrooms || ''}|${p.bathrooms || ''}`;
    if (!crossGroups[key]) crossGroups[key] = [];
    crossGroups[key].push(p);
  }

  for (const [, group] of Object.entries(crossGroups)) {
    if (group.length < 2) continue;
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i], b = group[j];
        if (getUrl(a) === getUrl(b)) continue; // already handled

        if (a.price === b.price) {
          // Definite duplicate
          a.hasDuplicates = true;
          b.hasDuplicates = true;
          a.duplicateKeys = a.duplicateKeys || [];
          b.duplicateKeys = b.duplicateKeys || [];
          a.duplicateKeys.push(seedData.dedupKey(b));
          b.duplicateKeys.push(seedData.dedupKey(a));
          definiteCount++;
        } else {
          // Check for potential duplicate
          const sim = descriptionSimilarity(a.description, b.description);
          if (sim >= 0.5 && a.postedDate !== b.postedDate) {
            a.hasPotentialDuplicates = true;
            b.hasPotentialDuplicates = true;
            b.potentialDuplicateOf = getUrl(a);
            a.potentialDuplicateOf = getUrl(b);
            a.duplicateSimilarity = Math.round(sim * 100);
            b.duplicateSimilarity = Math.round(sim * 100);
            potentialCount++;
          }
        }
      }
    }
  }

  console.log(`Duplicate check: ${definiteCount} definite, ${potentialCount} potential`);

  const output = {
    generatedAt: new Date().toISOString(),
    searchConfig: config,
    locations: config.searches.map(s => s.location),
    totalResults: dedupedSeed.length,
    newResults: results.length,
    results: dedupedSeed,
    portalLinks: allPortalLinks,
    seedStats: mergeStats,
  };

  fs.writeFileSync(path.join(docsDir, 'results.json'), JSON.stringify(output, null, 2));
  console.log(`Wrote ${dedupedSeed.length} total properties (${results.length} new this run) to docs/results.json`);
  console.log(`Wrote ${allPortalLinks.length} portal links`);
  console.log('Build complete!');
}

main().catch(e => { console.error(e); process.exit(1); });
