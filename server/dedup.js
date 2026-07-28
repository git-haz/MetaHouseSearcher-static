function normalizeAddress(addr) {
  return addr
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\b(street|st|road|rd|lane|ln|avenue|ave|drive|dr|close|cl|court|ct|place|pl|way|crescent|cres|terrace|ter)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function getUrl(listing) {
  return listing.sources && listing.sources[0] ? listing.sources[0].url : '';
}

function descriptionSimilarity(a, b) {
  if (!a || !b) return 0;
  const wordsA = a.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 3);
  const wordsB = new Set(b.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 3));
  if (!wordsA.length || !wordsB.size) return 0;
  const overlap = wordsA.filter(w => wordsB.has(w)).length;
  return overlap / Math.max(wordsA.length, wordsB.size);
}

function parseDate(dateStr) {
  if (!dateStr) return null;
  const m = dateStr.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return new Date(parseInt(m[3]), parseInt(m[2]) - 1, parseInt(m[1]));
  return null;
}

function isNewer(a, b) {
  const da = parseDate(a.postedDate);
  const db = parseDate(b.postedDate);
  if (da && db) return da > db;
  if (da && !db) return true;
  return false;
}

function deduplicate(listings) {
  const result = [];
  const urlMap = new Map();

  // Phase 1: Same-URL dedup — always a duplicate
  // If content identical: keep oldest (preserve original retrieval date)
  // If anything changed (price, description, date): keep newer, discard older
  for (const listing of listings) {
    const url = getUrl(listing);
    if (!url) { result.push({ ...listing }); continue; }

    if (urlMap.has(url)) {
      const existing = urlMap.get(url);
      const contentChanged = existing.price !== listing.price
        || existing.postedDate !== listing.postedDate
        || (existing.description || '') !== (listing.description || '');

      if (contentChanged) {
        // Keep the newer version but preserve the original retrieval date
        if (isNewer(listing, existing)) {
          const oldRetrieved = existing.retrievedAt || existing.seedAddedAt;
          urlMap.set(url, { ...listing, firstRetrievedAt: oldRetrieved });
        }
        // else keep existing (it's already newer)
      }
      // Content identical — keep existing (oldest), just merge extras
      const kept = urlMap.get(url);
      if (listing.images && listing.images.length > (kept.images?.length || 0)) kept.images = listing.images;
      if (listing.lat != null && kept.lat == null) { kept.lat = listing.lat; kept.lon = listing.lon; }
    } else {
      urlMap.set(url, { ...listing });
    }
  }

  result.push(...urlMap.values());

  // Phase 2: Cross-URL dedup — same address + beds + baths + price = definite duplicate
  // Same address + beds + baths + different price + similar description = potential duplicate
  const final = [];
  const addrGroups = new Map();

  for (const p of result) {
    const addr = normalizeAddress(p.address);
    const exactKey = `${addr}|${p.bedrooms || ''}|${p.bathrooms || ''}|${p.price || ''}`;

    let merged = false;

    // Check for exact match (address + beds + baths + price)
    for (const f of final) {
      const fKey = `${normalizeAddress(f.address)}|${f.bedrooms || ''}|${f.bathrooms || ''}|${f.price || ''}`;
      if (fKey === exactKey && getUrl(f) !== getUrl(p)) {
        // Definite duplicate — merge sources
        f.sources.push(...p.sources);
        if (p.images && p.images.length > (f.images?.length || 0)) f.images = p.images;
        if (!f.description && p.description) f.description = p.description;
        if (p.lat != null && f.lat == null) { f.lat = p.lat; f.lon = p.lon; }
        if (p.postedDate && !f.postedDate) f.postedDate = p.postedDate;
        if (p.agent && !f.agent) f.agent = p.agent;
        if (p.agentPhone && !f.agentPhone) f.agentPhone = p.agentPhone;
        merged = true;
        break;
      }
    }

    if (!merged) {
      // Check for potential duplicate (same address + beds + baths, different price, similar description)
      for (const f of final) {
        const fAddr = normalizeAddress(f.address);
        if (fAddr === addr && f.bedrooms === p.bedrooms && f.bathrooms === p.bathrooms
            && f.price !== p.price && getUrl(f) !== getUrl(p)) {
          const sim = descriptionSimilarity(f.description, p.description);
          if (sim >= 0.5 && f.postedDate !== p.postedDate) {
            p.potentialDuplicateOf = getUrl(f);
            p.duplicateSimilarity = Math.round(sim * 100);
            f.hasPotentialDuplicates = true;
            p.hasPotentialDuplicates = true;
          }
        }
      }
      final.push(p);
    }
  }

  return final;
}

module.exports = { deduplicate, normalizeAddress, descriptionSimilarity, getUrl };
