const fs = require('fs');
const path = require('path');

// Reuse modules from the main project
const mainDir = path.join(__dirname, '..', 'property-search', 'server');
const { closeBrowser } = require(path.join(mainDir, 'browser'));
const { deduplicate } = require(path.join(mainDir, 'dedup'));
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

  // Write output
  const output = {
    generatedAt: new Date().toISOString(),
    searchConfig: config,
    locations: config.searches.map(s => s.location),
    totalResults: results.length,
    results,
    portalLinks: allPortalLinks,
    seedStats: mergeStats,
  };

  fs.writeFileSync(path.join(docsDir, 'results.json'), JSON.stringify(output, null, 2));
  console.log(`\nWrote ${results.length} results to docs/results.json`);
  console.log(`Wrote ${allPortalLinks.length} portal links`);
  console.log('Build complete!');
}

main().catch(e => { console.error(e); process.exit(1); });
