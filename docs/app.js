// --- Persistent lists & notes ---
const LIST_NAMES = ['favorite', 'seen', 'view', 'viewed', 'in_progress', 'rejected'];
const LIST_LABELS = { favorite: 'Favorites', seen: 'Seen', view: 'To View', viewed: 'Viewed', in_progress: 'In Progress', rejected: 'Rejected', excluded: 'Exclusion Zone', neighbour: '⚠ Neighbour', neighbour_confirmed: '🏘 Neighbour Confirmed' };

let propertyLists = loadJSON('propertyLists', {});
let propertyNotes = loadJSON('propertyNotes', {});
let neighbourStatus = loadJSON('neighbourStatus', {});
function saveNeighbourStatus() { localStorage.setItem('neighbourStatus', JSON.stringify(neighbourStatus)); }

function loadJSON(key, def) { try { return JSON.parse(localStorage.getItem(key) || JSON.stringify(def)); } catch { return def; } }
function saveLists() { localStorage.setItem('propertyLists', JSON.stringify(propertyLists)); }
function saveNotes() { localStorage.setItem('propertyNotes', JSON.stringify(propertyNotes)); }

function pkey(p) { return (p.address || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }

function isInList(listName, key) { return !!(propertyLists[listName] && propertyLists[listName][key]); }
function addToList(listName, property) {
  if (!propertyLists[listName]) propertyLists[listName] = {};
  propertyLists[listName][pkey(property)] = {
    title: property.title, price: property.price, address: property.address,
    bedrooms: property.bedrooms, bathrooms: property.bathrooms, sqft: property.sqft,
    type: property.type, description: property.description, images: property.images,
    sources: property.sources, nearestAirport: property.nearestAirport,
    nearestAirstrip: property.nearestAirstrip, nearestHeliport: property.nearestHeliport,
    minAirportDistanceMiles: property.minAirportDistanceMiles,
    lat: property.lat, lon: property.lon, geoAccuracy: property.geoAccuracy,
    postedDate: property.postedDate, agent: property.agent, agentPhone: property.agentPhone,
    neighbourDetected: property.neighbourDetected || false,
    neighbourConfidence: property.neighbourConfidence || 0,
    flyoverRef: property.flyoverRef || property.flyover || null,
    searchLocations: property.searchLocations,
    addedAt: new Date().toISOString(),
  };
  saveLists();
}
function removeFromList(listName, key) { if (propertyLists[listName]) { delete propertyLists[listName][key]; saveLists(); } }
function getListProperties(listName) { return propertyLists[listName] ? Object.entries(propertyLists[listName]).map(([k, v]) => ({ ...v, _key: k })) : []; }

// --- Exclusion Zones ---
let exclusionZones = loadJSON('exclusionZones', []);
let zonePolygonLayers = [];
let drawControl = null;
let pendingZoneLatLngs = null;
const ZONE_COLORS = ['#e65100', '#6a1b9a', '#1565c0', '#2e7d32', '#c62828'];

function saveZones() { localStorage.setItem('exclusionZones', JSON.stringify(exclusionZones)); }
function pointInPolygon(lat, lon, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const yi = poly[i][0], xi = poly[i][1], yj = poly[j][0], xj = poly[j][1];
    if (((yi > lat) !== (yj > lat)) && (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}
function isInAnyExclusionZone(p) {
  if (p.lat == null) return false;
  return exclusionZones.some(z => pointInPolygon(p.lat, p.lon, z.points));
}
function getExclusionZoneNames(p) {
  if (p.lat == null) return [];
  return exclusionZones.filter(z => pointInPolygon(p.lat, p.lon, z.points)).map(z => z.name);
}

function getPropertyTags(p) {
  const key = pkey(p);
  const tags = [];
  for (const list of LIST_NAMES) { if (propertyLists[list] && propertyLists[list][key]) tags.push(list); }
  if (isInAnyExclusionZone(p)) tags.push('excluded');
  const ns = neighbourStatus[key];
  if (ns === 'confirmed') tags.push('neighbour_confirmed');
  else if (ns === 'dismissed') { /* no tag */ }
  else if (p.neighbourDetected) tags.push('neighbour');
  return tags;
}

// --- Auto reject ---
const AUTO_REJECT_PATTERNS = [/\bsemi[-\s]?detached\b/i, /\blink[-\s]?detached\b/i, /\bend[-\s]?(?:of[-\s]?)?terrace\b/i, /\bterraced\b/i, /\bterrace\s+house\b/i];
function autoRejectProperties(results) {
  for (const r of results) {
    const key = pkey(r);
    if (isInList('rejected', key)) continue;
    if (AUTO_REJECT_PATTERNS.some(re => re.test(`${r.title || ''} ${r.type || ''}`))) addToList('rejected', r);
  }
}

// --- State ---
let allData = null;
let currentResults = [];
let selectedLocations = [];
let textFilterKeywords = [];
let hiddenTags = ['rejected'];
let showFlyover = true;
let showNeighbour = true;
let showAirports = true;
let activeView = 'list';
let activeListTab = 'favorite';
let map = null;
let mapMarkers = [];

// --- Load data ---
async function init() {
  try {
    const res = await fetch('results.json');
    allData = await res.json();
    currentResults = allData.results;

    const dateStr = new Date(allData.generatedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    const seedInfo = allData.seedStats ? ` · Seed: ${allData.seedStats.total} total` : '';
    document.getElementById('lastUpdated').textContent = `Last updated: ${dateStr} · ${allData.totalResults} results${seedInfo}`;

    // Location checkboxes
    selectedLocations = [...allData.locations];
    const locChecks = document.getElementById('locationChecks');
    locChecks.innerHTML = allData.locations.map(loc =>
      `<label class="pt-check"><input type="checkbox" value="${loc}" checked> ${loc}</label>`
    ).join('');
    locChecks.addEventListener('change', () => {
      selectedLocations = [];
      locChecks.querySelectorAll('input:checked').forEach(cb => selectedLocations.push(cb.value));
      renderResults(currentResults);
    });

    // Portal links
    const linksEl = document.getElementById('portal-links-inline');
    linksEl.innerHTML = allData.portalLinks.map(l =>
      `<a href="${l.url}" target="_blank" rel="noopener" class="portal-link">${l.portal} (${l.searchLocation})</a>`
    ).join('');

    autoRejectProperties(currentResults);
    renderResults(currentResults);
  } catch (err) {
    document.getElementById('results-area').innerHTML = `<div class="empty-state"><h2>Error loading results</h2><p>${err.message}</p></div>`;
  } finally {
    document.getElementById('loading-overlay').classList.remove('active');
  }
}

// --- Navigation ---
document.querySelectorAll('header nav a').forEach(link => {
  link.addEventListener('click', e => {
    e.preventDefault();
    document.querySelectorAll('header nav a').forEach(l => l.classList.remove('active'));
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    link.classList.add('active');
    document.getElementById(link.dataset.page).classList.add('active');
    if (link.dataset.page === 'lists-page') renderListPage();
  });
});

// --- Filters ---
document.getElementById('textFilter').addEventListener('input', e => {
  textFilterKeywords = e.target.value ? e.target.value.split(',').map(k => k.trim().toLowerCase()).filter(Boolean) : [];
  renderResults(currentResults);
});

document.getElementById('hideTagsChecks').addEventListener('change', () => {
  hiddenTags = [];
  document.querySelectorAll('#hideTagsChecks input:checked').forEach(cb => hiddenTags.push(cb.value));
  renderResults(currentResults);
});

// Display toggles
document.getElementById('displayToggles').addEventListener('change', () => {
  showFlyover = document.getElementById('showFlyover').checked;
  showNeighbour = document.getElementById('showNeighbour').checked;
  showAirports = document.getElementById('showAirports').checked;
  renderResults(currentResults);
});

// Display filter inputs
const displayFilterIds = ['filterMinPrice', 'filterMaxPrice', 'filterMinBeds', 'filterMaxBeds', 'filterMinBaths', 'filterMaxBaths', 'filterMinGarden'];
displayFilterIds.forEach(id => {
  document.getElementById(id).addEventListener('input', () => renderResults(currentResults));
});

function getNum(id) { const v = Number(document.getElementById(id).value); return isNaN(v) || v === 0 ? null : v; }

function extractGardenSize(p) {
  const text = `${p.description || ''} ${p.title || ''}`;
  // Match patterns like "0.5 acre", "1/4 acre", "2 acres", "500 sq ft garden"
  const acreMatch = text.match(/([\d.]+)\s*acres?\b/i);
  if (acreMatch) return parseFloat(acreMatch[1]) * 43560;
  const fractionAcre = text.match(/(\d+)\/(\d+)\s*(?:of an?\s*)?acres?\b/i);
  if (fractionAcre) return (parseInt(fractionAcre[1]) / parseInt(fractionAcre[2])) * 43560;
  const sqftMatch = text.match(/([\d,]+)\s*sq\s*(?:ft|feet)\s*(?:garden|plot|land)/i);
  if (sqftMatch) return parseInt(sqftMatch[1].replace(',', ''));
  return null;
}

function applyFilters(results) {
  let filtered = results;

  if (selectedLocations.length < (allData?.locations?.length || 0)) {
    filtered = filtered.filter(r => r.searchLocations && r.searchLocations.some(sl => selectedLocations.includes(sl)));
  }

  if (hiddenTags.length > 0) {
    filtered = filtered.filter(r => !hiddenTags.some(ht => getPropertyTags(r).includes(ht)));
  }

  if (textFilterKeywords.length > 0) {
    filtered = filtered.filter(r => {
      const text = `${r.title} ${r.description} ${r.address} ${r.type}`.toLowerCase();
      return textFilterKeywords.every(kw => text.includes(kw));
    });
  }

  const minPrice = getNum('filterMinPrice');
  const maxPrice = getNum('filterMaxPrice');
  const minBeds = getNum('filterMinBeds');
  const maxBeds = getNum('filterMaxBeds');
  const minBaths = getNum('filterMinBaths');
  const maxBaths = getNum('filterMaxBaths');
  const minGarden = getNum('filterMinGarden');

  if (minPrice) filtered = filtered.filter(r => r.price >= minPrice);
  if (maxPrice) filtered = filtered.filter(r => r.price <= maxPrice);
  if (minBeds) filtered = filtered.filter(r => r.bedrooms != null && r.bedrooms >= minBeds);
  if (maxBeds) filtered = filtered.filter(r => r.bedrooms != null && r.bedrooms <= maxBeds);
  if (minBaths) filtered = filtered.filter(r => r.bathrooms != null && r.bathrooms >= minBaths);
  if (maxBaths) filtered = filtered.filter(r => r.bathrooms != null && r.bathrooms <= maxBaths);
  if (minGarden) filtered = filtered.filter(r => { const g = extractGardenSize(r); return g != null && g >= minGarden; });

  // Hide dismissed duplicates
  filtered = filtered.filter(r => {
    const dk = pkey(r) + '__' + (r.agent || r.sources?.[0]?.portal || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    return !dismissedDupes[dk];
  });

  return filtered;
}

// --- View toggle ---
document.getElementById('viewToggle').addEventListener('click', e => {
  if (!e.target.classList.contains('view-btn')) return;
  document.querySelectorAll('.view-btn').forEach(b => b.classList.remove('active'));
  e.target.classList.add('active');
  activeView = e.target.dataset.view;
  if (activeView === 'map') {
    document.getElementById('results-area').style.display = 'none';
    document.getElementById('map-area').style.display = 'block';
    renderMap(currentResults);
  } else {
    document.getElementById('map-area').style.display = 'none';
    document.getElementById('results-area').style.display = 'block';
  }
});

// --- Render results ---
function renderResults(results) {
  const filtered = applyFilters(results);
  const area = document.getElementById('results-area');

  if (!filtered.length) {
    area.innerHTML = '<div class="empty-state"><h2>No results match your filters.</h2></div>';
    return;
  }

  let html = `
    <div class="results-bar">
      <span>${filtered.length} properties</span>
      <div class="results-controls">
        <label style="font-size:12px;margin-right:4px;">Min airport dist:</label>
        <input type="number" id="minAirportDist" placeholder="mi" min="0" step="1" style="width:70px;">
        <select id="sortBy">
          <option value="price-asc">Price: Low to High</option>
          <option value="price-desc">Price: High to Low</option>
          <option value="location-asc">Location: A-Z</option>
          <option value="location-desc">Location: Z-A</option>
          <option value="keywords-desc">Keywords Matched: Most</option>
          <option value="keywords-asc">Keywords Matched: Fewest</option>
          <option value="airport-desc">Airport Dist: Furthest</option>
          <option value="airport-asc">Airport Dist: Nearest</option>
          <option value="retrieved-desc">Retrieved: Newest First</option>
          <option value="retrieved-asc">Retrieved: Oldest First</option>
        </select>
      </div>
    </div>
    <div class="results-grid">${filtered.map(p => renderCard(p, 'search')).join('')}</div>
  `;
  area.innerHTML = html;

  document.getElementById('sortBy').addEventListener('change', applySort);
  document.getElementById('minAirportDist')?.addEventListener('input', applyAirportFilter);
  if (activeView === 'map') renderMap(results);
}

function renderCard(p, context) {
  const key = pkey(p);
  const tags = getPropertyTags(p);
  const note = propertyNotes[key];
  const images = p.images && p.images.length ? p.images : ['https://placehold.co/400x300/e0e0e0/999?text=No+Image'];
  const multi = images.length > 1;
  const cid = 'c-' + key + '-' + context;
  const ek = key.replace(/'/g, "\\'");

  const zoneNames = getExclusionZoneNames(p);
  const visibleTags = tags.filter(t => {
    if ((t === 'neighbour' || t === 'neighbour_confirmed') && !showNeighbour) return false;
    return true;
  });
  const badgesHtml = visibleTags.length > 0 ? `<div class="card-tag-badges">${visibleTags.map(t => {
    if (t === 'excluded' && zoneNames.length) return zoneNames.map(zn => `<span class="tag-badge tag-badge-excluded">⚠ ${zn}</span>`).join('');
    return `<span class="tag-badge tag-badge-${t}">${LIST_LABELS[t] || t}</span>`;
  }).join('')}</div>` : '';

  const carouselHtml = `<div class="card-carousel" id="${cid}">
    ${images.map((img, i) => `<img src="${img}" alt="${p.title}" loading="lazy" class="${i === 0 ? 'active' : ''}">`).join('')}
    ${multi ? `<button class="carousel-btn carousel-prev" onclick="carouselNav('${cid}',-1)">&#8249;</button><button class="carousel-btn carousel-next" onclick="carouselNav('${cid}',1)">&#8250;</button><span class="carousel-counter">1 / ${images.length}</span><div class="carousel-dots">${images.map((_, i) => `<span class="carousel-dot${i === 0 ? ' active' : ''}"></span>`).join('')}</div>` : ''}
  </div>`;

  const fmtSI = (item, icon) => item ? `<span class="airport-summary-item${item.active === false ? ' airport-inactive' : ''}" title="${item.name} (${item.usage})">${icon} ${item.distanceMiles.toFixed(1)}mi</span>` : '';
  const fmtDI = (item, label, icon) => item ? `<div class="airport-item${item.active === false ? ' airport-inactive' : ''}">${icon} <strong>${label}:</strong> ${item.name}${item.icao ? ' (' + item.icao + ')' : ''} — <span class="airport-dist">${item.distanceMiles.toFixed(1)} mi</span> <span class="airport-usage airport-usage-${item.usage}">${item.usage}</span>${item.active === false ? ' <span class="airport-usage" style="background:#f1f3f4;color:#999;">inactive</span>' : ''}</div>` : '';
  const hasAirport = p.nearestAirport || p.nearestAirstrip || p.nearestHeliport;
  const airportHtml = hasAirport ? `<details class="card-airports"><summary class="airport-summary-row">${fmtSI(p.nearestAirport, '✈')}${fmtSI(p.nearestAirstrip, '🛩')}${fmtSI(p.nearestHeliport, '🚁')}</summary><div class="airport-list">${fmtDI(p.nearestAirport, 'Airport', '✈')}${fmtDI(p.nearestAirstrip, 'Airstrip', '🛩')}${fmtDI(p.nearestHeliport, 'Heliport', '🚁')}</div></details>` : '';

  const geoIcons = { address: '📍', postcode: '📮', area: '🗺️' };
  const geoTitles = { address: 'Street-level', postcode: 'Postcode centroid', area: 'Area estimate' };
  const geoIcon = p.geoAccuracy ? `<span class="geo-accuracy geo-${p.geoAccuracy}" title="${geoTitles[p.geoAccuracy]}">${geoIcons[p.geoAccuracy]}</span>` : '';

  const postedHtml = p.postedDate ? `<span class="card-posted">${p.postedDate}</span>` : '';
  const agentHtml = p.agent ? `<span class="card-agent">${p.agent}${p.agentPhone ? ' · ' + p.agentPhone : ''}</span>` : '';
  const noteHtml = note ? `<div class="card-note" onclick="openNote('${ek}','${context}')">${note}</div>` : '';

  const fd = p.flyoverRef || p.flyover;
  const flyoverMonthly = fd?.monthly ? fd.monthly.filter(m => m.hours > 0) : [];
  const flyoverHtml = fd ? `
    <div class="card-flyover">
      ✈ <span class="flyover-rate">${fd.flightsPerDay} flights/day</span> est.
      ${fd.location ? `<span style="font-size:11px;color:var(--text-muted);">(ref: ${fd.location})</span>` : ''}
      ${fd.seasonalFlag === 'high_variance' ? '<span class="flyover-seasonal-high"> — seasonal variance</span>' : ''}
      ${fd.seasonalFlag === 'very_high_variance' ? '<span class="flyover-seasonal-high"> — high seasonal variance</span>' : ''}
      ${fd.seasonalFlag === 'stable' ? '<span class="flyover-seasonal-stable"> — stable</span>' : ''}
      ${fd.seasonalFlag === 'low_traffic' ? '<span class="flyover-seasonal-stable"> — low traffic</span>' : ''}
      ${flyoverMonthly.length > 0 ? `<br><span style="font-size:11px;color:var(--text-muted);">${flyoverMonthly.map(m => m.month + ': ' + m.flightsPerDay + '/day').join(' · ')}</span>` : ''}
    </div>` : '';

  return `<div class="property-card" data-key="${key}">
    ${carouselHtml}
    <div class="card-body">
      ${badgesHtml}
      ${showFlyover ? flyoverHtml : ''}
      <div class="card-price">£${p.price.toLocaleString()} ${postedHtml}</div>
      <div class="card-meta-row">
        ${p.retrievedAt || p.seedAddedAt ? `<span class="card-retrieved" title="Retrieved ${new Date(p.retrievedAt || p.seedAddedAt).toISOString()}">${new Date(p.retrievedAt || p.seedAddedAt).toLocaleDateString('en-GB', {day:'numeric',month:'short'})}</span>` : ''}
        ${p.isNew ? '<span class="card-new-badge">NEW</span>' : ''}
        ${propertyHasDuplicates(p) ? `<button class="card-dupe-btn" onclick="showDuplicates('${ek}')">⚠ Duplicates — choose one</button>` : ''}
        ${!propertyHasDuplicates(p) && propertyHasPotentialDuplicates(p) ? `<button class="card-dupe-btn card-dupe-potential" onclick="showDuplicates('${ek}')">? Potential duplicate (${p.duplicateSimilarity || ''}% match) — confirm</button>` : ''}
      </div>
      <div class="card-title">${p.title}</div>
      <div class="card-address">${geoIcon} ${p.address}</div>
      ${agentHtml ? `<div class="card-agent-line">${agentHtml}</div>` : ''}
      <div class="card-specs">
        ${p.bedrooms != null ? `<span>${p.bedrooms} bed</span>` : ''}
        ${p.bathrooms != null ? `<span>${p.bathrooms} bath</span>` : ''}
        ${p.sqft ? `<span>${p.sqft.toLocaleString()} sq ft</span>` : ''}
        <span>${p.type || ''}</span>
      </div>
      ${p.description ? `<div class="card-description">${p.description}</div>` : ''}
      ${showAirports ? airportHtml : ''}
      <div class="card-sources">${p.sources.map(s => `<a href="${s.url}" target="_blank" rel="noopener" class="source-tag">${s.portal}</a>`).join('')}</div>
      <div class="card-actions">
        <button class="action-btn ${isInList('favorite', key) ? 'active-favorite' : ''}" onclick="toggleList('favorite','${ek}','${context}')">${isInList('favorite', key) ? '★' : '☆'} Fav</button>
        ${['seen', 'view', 'viewed', 'in_progress', 'rejected'].map(s =>
          `<button class="action-btn ${isInList(s, key) ? 'active-' + s : ''}" onclick="toggleList('${s}','${ek}','${context}')">${LIST_LABELS[s]}</button>`
        ).join('')}
        <button class="action-btn" onclick="openNote('${ek}','${context}')">${note ? 'Edit Note' : '+ Note'}</button>
      </div>
      ${noteHtml}
    </div>
  </div>`;
}

// --- Carousel ---
window.carouselNav = function(cid, dir) {
  const el = document.getElementById(cid);
  if (!el) return;
  const imgs = el.querySelectorAll('img');
  const dots = el.querySelectorAll('.carousel-dot');
  const counter = el.querySelector('.carousel-counter');
  let cur = 0;
  imgs.forEach((img, i) => { if (img.classList.contains('active')) cur = i; });
  imgs[cur].classList.remove('active');
  if (dots[cur]) dots[cur].classList.remove('active');
  cur = (cur + dir + imgs.length) % imgs.length;
  imgs[cur].classList.add('active');
  if (dots[cur]) dots[cur].classList.add('active');
  if (counter) counter.textContent = `${cur + 1} / ${imgs.length}`;
};

// --- Map ---
function renderMap(results) {
  const filtered = applyFilters(results);
  if (!map) {
    map = L.map('map').setView([52.5, 0.5], 10);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '&copy; OpenStreetMap contributors', maxZoom: 18 }).addTo(map);
  }
  mapMarkers.forEach(m => map.removeLayer(m));
  mapMarkers = [];
  const bounds = [];
  for (const p of filtered) {
    if (p.lat == null) continue;
    bounds.push([p.lat, p.lon]);
    const tags = getPropertyTags(p);
    const tb = tags.length ? '<div style="margin-bottom:4px;">' + tags.map(t => `<span class="tag-badge tag-badge-${t}" style="font-size:10px;">${LIST_LABELS[t]}</span> `).join('') + '</div>' : '';
    const zn = getExclusionZoneNames(p);
    const popup = `<div style="max-width:250px;font-size:13px;">${tb}<strong style="color:var(--primary);">£${p.price.toLocaleString()}</strong>${p.postedDate ? ' <span style="font-size:11px;color:#666;">' + p.postedDate + '</span>' : ''}<br><strong>${p.title}</strong><br><span style="color:#666;">${p.address}</span><br>${p.agent ? '<span style="font-size:11px;">' + p.agent + '</span><br>' : ''}${p.sources.map(s => `<a href="${s.url}" target="_blank" style="color:var(--primary);">${s.portal}</a>`).join(' ')}${zn.length ? '<br><span style="color:#e65100;font-size:11px;">⚠ ' + zn.join(', ') + '</span>' : ''}</div>`;
    mapMarkers.push(L.marker([p.lat, p.lon]).addTo(map).bindPopup(popup));
  }
  if (bounds.length) map.fitBounds(bounds, { padding: [30, 30], maxZoom: 14 });
  drawZonesOnMap();
  renderZoneList();
}

// --- Airport circles on map ---
let airportData = null;
let airportCircleLayers = [];
let airportCircleConfig = loadJSON('airportCircleConfig', { airport: false, airstrip: false, heliport: false, radiusAirport: 20, radiusAirstrip: 15, radiusHelipad: 20 });
function saveAirportCircleConfig() { localStorage.setItem('airportCircleConfig', JSON.stringify(airportCircleConfig)); }

async function loadAirportData() {
  if (airportData) return airportData;
  try {
    const res = await fetch('airports.json');
    const data = await res.json();
    airportData = data.airfields || [];
  } catch { airportData = []; }
  return airportData;
}

function milesToMeters(miles) { return miles * 1609.344; }

function drawAirportCircles() {
  airportCircleLayers.forEach(l => map.removeLayer(l));
  airportCircleLayers = [];
  if (!map || !airportData) return;

  const anyEnabled = airportCircleConfig.airport || airportCircleConfig.airstrip || airportCircleConfig.heliport;
  if (!anyEnabled) return;

  const bounds = map.getBounds();
  const visible = airportData.filter(a =>
    a.lat >= bounds.getSouth() - 0.5 && a.lat <= bounds.getNorth() + 0.5 &&
    a.lon >= bounds.getWest() - 0.5 && a.lon <= bounds.getEast() + 0.5
  );

  const colorMap = { airport: '#c62828', airstrip: '#1565c0', heliport: '#6a1b9a' };
  const radiusMap = {
    airport: airportCircleConfig.radiusAirport || 20,
    airstrip: airportCircleConfig.radiusAirstrip || 15,
    heliport: airportCircleConfig.radiusHelipad || 20,
  };

  for (const a of visible) {
    const cat = a.category || 'airstrip';
    if (!airportCircleConfig[cat]) continue;

    const circle = L.circle([a.lat, a.lon], {
      radius: milesToMeters(radiusMap[cat]),
      color: colorMap[cat],
      fillColor: colorMap[cat],
      fillOpacity: 0.2,
      weight: 1,
      interactive: true,
    }).addTo(map);
    circle.bindTooltip(`${a.name}${a.icao ? ' (' + a.icao + ')' : ''} — ${cat} (${a.usage})${a.active === false ? ' [inactive]' : ''}\n${radiusMap[cat]} mi radius`, { direction: 'top' });
    airportCircleLayers.push(circle);
  }
}

// Restore saved state into checkboxes
document.getElementById('showAirportCircles').checked = airportCircleConfig.airport;
document.getElementById('showAirstripCircles').checked = airportCircleConfig.airstrip;
document.getElementById('showHelipadCircles').checked = airportCircleConfig.heliport;
document.getElementById('radiusAirport').value = airportCircleConfig.radiusAirport || 20;
document.getElementById('radiusAirstrip').value = airportCircleConfig.radiusAirstrip || 15;
document.getElementById('radiusHelipad').value = airportCircleConfig.radiusHelipad || 20;

async function onAirportConfigChange() {
  airportCircleConfig.airport = document.getElementById('showAirportCircles').checked;
  airportCircleConfig.airstrip = document.getElementById('showAirstripCircles').checked;
  airportCircleConfig.heliport = document.getElementById('showHelipadCircles').checked;
  airportCircleConfig.radiusAirport = parseInt(document.getElementById('radiusAirport').value) || 20;
  airportCircleConfig.radiusAirstrip = parseInt(document.getElementById('radiusAirstrip').value) || 15;
  airportCircleConfig.radiusHelipad = parseInt(document.getElementById('radiusHelipad').value) || 20;
  saveAirportCircleConfig();

  await loadAirportData();
  drawAirportCircles();

  const anyEnabled = airportCircleConfig.airport || airportCircleConfig.airstrip || airportCircleConfig.heliport;
  if (anyEnabled) { map.off('moveend', drawAirportCircles); map.on('moveend', drawAirportCircles); }
  else { map.off('moveend', drawAirportCircles); }
}

document.querySelectorAll('.airport-circles-config input').forEach(el => {
  el.addEventListener('change', onAirportConfigChange);
  if (el.type === 'number') el.addEventListener('input', onAirportConfigChange);
});

// --- Zones on map ---
function drawZonesOnMap() {
  if (!map) return;
  zonePolygonLayers.forEach(l => map.removeLayer(l));
  zonePolygonLayers = [];
  exclusionZones.forEach((z, i) => {
    if (z.hidden) return;
    const color = ZONE_COLORS[i % ZONE_COLORS.length];
    const poly = L.polygon(z.points, { color, fillColor: color, fillOpacity: 0.15, weight: 2, dashArray: '6 4' }).addTo(map);
    poly.bindTooltip(z.name, { permanent: false, direction: 'center' });
    zonePolygonLayers.push(poly);
  });
}
function renderZoneList() {
  const list = document.getElementById('zoneList');
  if (!list) return;
  if (!exclusionZones.length) { list.innerHTML = '<div style="font-size:12px;color:var(--text-muted);padding:4px 0;">No zones. Click "Draw Zone" to add one.</div>'; return; }
  list.innerHTML = exclusionZones.map((z, i) => `<div class="zone-item"><span><span class="zone-color" style="background:${ZONE_COLORS[i % ZONE_COLORS.length]};"></span>${z.name} (${z.points.length} points)</span><div class="zone-item-actions"><button class="btn btn-outline btn-sm" onclick="renameZone(${i})">Rename</button><button class="btn btn-outline btn-sm" onclick="toggleZoneVis(${i})">${z.hidden ? 'Show' : 'Hide'}</button><button class="btn btn-danger btn-sm" onclick="deleteZone(${i})">Delete</button></div></div>`).join('');
}
window.deleteZone = function(i) { exclusionZones.splice(i, 1); saveZones(); renderZoneList(); drawZonesOnMap(); renderResults(currentResults); };
window.toggleZoneVis = function(i) { exclusionZones[i].hidden = !exclusionZones[i].hidden; saveZones(); renderZoneList(); drawZonesOnMap(); };
window.renameZone = function(i) {
  document.getElementById('zoneNameInput').value = exclusionZones[i].name;
  document.getElementById('zoneNameModal').classList.add('active');
  document.getElementById('zoneNameInput').focus();
  pendingZoneLatLngs = null;
  const origSave = document.getElementById('zoneNameSave').onclick;
  document.getElementById('zoneNameSave').onclick = () => {
    const name = document.getElementById('zoneNameInput').value.trim() || 'Unnamed Zone';
    exclusionZones[i].name = name;
    saveZones();
    document.getElementById('zoneNameModal').classList.remove('active');
    renderZoneList(); drawZonesOnMap();
    if (currentResults.length) renderResults(currentResults);
    document.getElementById('zoneNameSave').onclick = origSave;
  };
};

document.getElementById('startDrawZone').addEventListener('click', () => {
  if (!map) return;
  if (drawControl) { map.removeControl(drawControl); drawControl = null; }
  const drawnItems = new L.FeatureGroup(); map.addLayer(drawnItems);
  drawControl = new L.Control.Draw({ draw: { polygon: { allowIntersection: false, shapeOptions: { color: '#e65100', fillOpacity: 0.15 }, maxPoints: 5 }, polyline: false, rectangle: false, circle: false, marker: false, circlemarker: false }, edit: false });
  map.addControl(drawControl);
  map.once(L.Draw.Event.CREATED, function(e) {
    const latlngs = e.layer.getLatLngs()[0].map(ll => [ll.lat, ll.lng]);
    if (latlngs.length < 3) return;
    pendingZoneLatLngs = latlngs;
    map.removeControl(drawControl); drawControl = null; map.removeLayer(drawnItems);
    document.getElementById('zoneNameInput').value = '';
    document.getElementById('zoneNameModal').classList.add('active');
    document.getElementById('zoneNameInput').focus();
  });
});
document.getElementById('zoneNameSave').addEventListener('click', () => {
  const name = document.getElementById('zoneNameInput').value.trim() || 'Unnamed Zone';
  if (pendingZoneLatLngs) { exclusionZones.push({ name, points: pendingZoneLatLngs, hidden: false }); saveZones(); pendingZoneLatLngs = null; }
  document.getElementById('zoneNameModal').classList.remove('active');
  renderZoneList(); drawZonesOnMap(); renderResults(currentResults);
});
document.getElementById('zoneNameCancel').addEventListener('click', () => { pendingZoneLatLngs = null; document.getElementById('zoneNameModal').classList.remove('active'); });

// --- Sorting & airport filter ---
function applySort() {
  const [field, dir] = document.getElementById('sortBy').value.split('-');
  currentResults.sort((a, b) => {
    if (field === 'location') return dir === 'asc' ? a.address.localeCompare(b.address) : b.address.localeCompare(a.address);
    if (field === 'retrieved') {
      const da = new Date(a.retrievedAt || a.seedAddedAt || 0).getTime();
      const db = new Date(b.retrievedAt || b.seedAddedAt || 0).getTime();
      return dir === 'asc' ? da - db : db - da;
    }
    const k = field === 'price' ? 'price' : field === 'keywords' ? 'keywordsMatched' : 'minAirportDistanceMiles';
    return dir === 'asc' ? (a[k] || 0) - (b[k] || 0) : (b[k] || 0) - (a[k] || 0);
  });
  renderResults(currentResults);
}
function applyAirportFilter() {
  const minDist = parseFloat(document.getElementById('minAirportDist').value);
  if (isNaN(minDist) || minDist <= 0) { renderResults(currentResults); return; }
  const filtered = applyFilters(currentResults).filter(r => r.minAirportDistanceMiles == null || r.minAirportDistanceMiles >= minDist);
  const grid = document.querySelector('.results-grid');
  if (grid) grid.innerHTML = filtered.length ? filtered.map(p => renderCard(p, 'search')).join('') : '<div class="empty-state" style="grid-column:1/-1;"><h2>No properties this far from airports</h2></div>';
}

// --- Duplicate chooser ---
let dismissedDupes = loadJSON('dismissedDupes', {});
let notDuplicates = loadJSON('notDuplicates', []);
function saveDismissedDupes() { localStorage.setItem('dismissedDupes', JSON.stringify(dismissedDupes)); }
function saveNotDuplicates() { localStorage.setItem('notDuplicates', JSON.stringify(notDuplicates)); }

function dupeKey(p) {
  return pkey(p) + '__' + (p.agent || p.sources?.[0]?.portal || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function areSeparated(dk1, dk2) {
  return notDuplicates.some(pair => (pair[0] === dk1 && pair[1] === dk2) || (pair[0] === dk2 && pair[1] === dk1));
}

function getDuplicateGroup(property) {
  const addrKey = (property.address || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const myDk = dupeKey(property);
  return currentResults.filter(r => {
    const ak = (r.address || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (ak !== addrKey) return false;
    const rDk = dupeKey(r);
    if (rDk === myDk) return true;
    return !areSeparated(myDk, rDk);
  });
}

function propertyHasDuplicates(p) {
  if (!p.hasDuplicates && !p.hasPotentialDuplicates) return false;
  return getDuplicateGroup(p).length > 1;
}

function propertyHasPotentialDuplicates(p) {
  return p.hasPotentialDuplicates && !dismissedDupes[dupeKey(p)];
}

window.showDuplicates = function(key) {
  const property = currentResults.find(r => pkey(r) === key);
  if (!property) return;

  const dupes = getDuplicateGroup(property);
  const addrKey = (property.address || '').toLowerCase().replace(/[^a-z0-9]/g, '');

  const grid = document.getElementById('dupeGrid');
  grid.innerHTML = dupes.map(d => {
    const dk = dupeKey(d);
    const img = d.images && d.images[0] ? d.images[0] : 'https://placehold.co/400x300/e0e0e0/999?text=No+Image';
    const isDismissed = dismissedDupes[dk];
    return `<div class="dupe-card" style="${isDismissed ? 'opacity:0.4;' : ''}">
      <img src="${img}" alt="${d.title}" loading="lazy">
      <div class="dupe-price">£${d.price.toLocaleString()}</div>
      <div><strong>${d.title}</strong></div>
      <div>${d.address}</div>
      <div class="dupe-source">${d.agent || ''} · ${d.sources?.map(s => s.portal).join(', ') || ''}</div>
      <div class="dupe-source">Retrieved: ${d.retrievedAt ? new Date(d.retrievedAt).toLocaleDateString('en-GB') : 'unknown'}</div>
      ${d.description ? `<div class="dupe-desc">${d.description}</div>` : ''}
      <div style="display:flex;gap:6px;flex-wrap:wrap;">
        ${d.sources?.map(s => `<a href="${s.url}" target="_blank" rel="noopener" class="source-tag">${s.portal}</a>`).join('') || ''}
      </div>
      <div style="display:flex;gap:6px;margin-top:auto;">
        ${isDismissed
          ? `<button class="btn btn-outline btn-sm" onclick="restoreDuplicate('${dk}')">Restore</button>`
          : `<button class="dupe-keep-btn" onclick="keepDuplicate('${dk}','${addrKey}')">Keep this one</button>`}
        <button class="btn btn-outline btn-sm" onclick="markNotDuplicate('${dk}','${addrKey}')">Not a duplicate</button>
      </div>
    </div>`;
  }).join('');

  document.getElementById('dupeModal').classList.add('active');
};

window.keepDuplicate = function(keepKey, addrKey) {
  const dupes = getDuplicateGroupByAddr(addrKey, keepKey);
  for (const d of dupes) {
    const dk = dupeKey(d);
    if (dk !== keepKey) dismissedDupes[dk] = true;
    else delete dismissedDupes[dk];
  }
  saveDismissedDupes();
  document.getElementById('dupeModal').classList.remove('active');
  renderResults(currentResults);
};

window.restoreDuplicate = function(dk) {
  delete dismissedDupes[dk];
  saveDismissedDupes();
  // Re-render the modal
  const modal = document.getElementById('dupeModal');
  if (modal.classList.contains('active')) {
    const firstVisible = currentResults.find(r => dupeKey(r) === dk);
    if (firstVisible) showDuplicates(pkey(firstVisible));
  }
  renderResults(currentResults);
};

window.markNotDuplicate = function(dk, addrKey) {
  // Mark this property as NOT a duplicate of all others in the group
  const group = getDuplicateGroupByAddr(addrKey, null);
  for (const d of group) {
    const otherDk = dupeKey(d);
    if (otherDk !== dk && !areSeparated(dk, otherDk)) {
      notDuplicates.push([dk, otherDk]);
    }
  }
  // Restore it if it was dismissed
  delete dismissedDupes[dk];
  saveDismissedDupes();
  saveNotDuplicates();
  document.getElementById('dupeModal').classList.remove('active');
  renderResults(currentResults);
};

function getDuplicateGroupByAddr(addrKey, keepKey) {
  return currentResults.filter(r => {
    const ak = (r.address || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    return ak === addrKey;
  });
}

document.getElementById('dupeModal').addEventListener('click', e => {
  if (e.target === e.currentTarget) e.currentTarget.classList.remove('active');
});

// --- Tags / lists ---
window.toggleList = function(listName, key, context) {
  if (isInList(listName, key)) { removeFromList(listName, key); refreshView(context); return; }
  const property = currentResults.find(r => pkey(r) === key) || findInLists(key);
  if (!property) return;
  pendingL = { listName, key, context, property };
  document.getElementById('noteModalTitle').textContent = `Add to "${LIST_LABELS[listName]}" — Add a note (optional)`;
  document.getElementById('noteText').value = propertyNotes[key] || '';
  document.getElementById('noteModal').classList.add('active');
  document.getElementById('noteText').focus();
};
let pendingL = null;
function findInLists(key) { for (const l of LIST_NAMES) { if (propertyLists[l]?.[key]) return propertyLists[l][key]; } return null; }

document.getElementById('noteSaveBtn').addEventListener('click', () => {
  if (pendingL) { addToList(pendingL.listName, pendingL.property); const n = document.getElementById('noteText').value.trim(); if (n) { propertyNotes[pendingL.key] = n; saveNotes(); } }
  document.getElementById('noteModal').classList.remove('active');
  const ctx = pendingL?.context; pendingL = null; refreshView(ctx);
});
document.getElementById('noteCancelBtn').addEventListener('click', () => {
  if (pendingL) addToList(pendingL.listName, pendingL.property);
  document.getElementById('noteModal').classList.remove('active');
  const ctx = pendingL?.context; pendingL = null; refreshView(ctx);
});
document.getElementById('noteModal').addEventListener('click', e => { if (e.target === e.currentTarget) e.currentTarget.classList.remove('active'); });

window.openNote = function(key, context) {
  document.getElementById('noteModalTitle').textContent = 'Edit Note';
  document.getElementById('noteText').value = propertyNotes[key] || '';
  document.getElementById('noteModal').classList.add('active');
  document.getElementById('noteText').focus();
  document.getElementById('noteSaveBtn').onclick = () => {
    const n = document.getElementById('noteText').value.trim();
    if (n) { propertyNotes[key] = n; } else { delete propertyNotes[key]; }
    saveNotes(); document.getElementById('noteModal').classList.remove('active'); refreshView(context);
  };
};

function refreshView(ctx) { if (ctx === 'search') renderResults(currentResults); else renderListPage(); }

// --- My Lists ---
document.getElementById('listsTabs').addEventListener('click', e => {
  if (!e.target.classList.contains('tab')) return;
  document.querySelectorAll('#listsTabs .tab').forEach(t => t.classList.remove('active'));
  e.target.classList.add('active');
  activeListTab = e.target.dataset.list;
  renderListPage();
});
document.getElementById('exportCsvBtn').addEventListener('click', exportCsv);

function renderListPage() {
  document.querySelectorAll('#listsTabs .tab').forEach(t => {
    const count = getListProperties(t.dataset.list).length;
    let span = t.querySelector('.tab-count');
    if (!span) { span = document.createElement('span'); span.className = 'tab-count'; t.appendChild(span); }
    span.textContent = count;
  });
  const props = getListProperties(activeListTab);
  document.getElementById('listCount').textContent = `${props.length} properties`;
  const area = document.getElementById('list-area');
  if (!props.length) { area.innerHTML = `<div class="empty-state"><h2>No properties in ${LIST_LABELS[activeListTab]}</h2></div>`; return; }
  area.innerHTML = `<div class="results-grid">${props.map(p => renderCard(p, 'list')).join('')}</div>`;
}

function exportCsv() {
  const props = getListProperties(activeListTab);
  if (!props.length) return;
  const headers = ['Title', 'Address', 'Price', 'Bedrooms', 'Bathrooms', 'Type', 'Posted', 'Agency', 'Phone', 'Link', 'Nearest Airport', 'Airport Dist (mi)', 'Nearest Airstrip', 'Airstrip Dist (mi)', 'Nearest Heliport', 'Heliport Dist (mi)', 'Note'];
  const fmtName = a => a ? `${a.name} (${a.usage})` : '';
  const fmtDist = a => a ? a.distanceMiles.toFixed(1) : '';
  const rows = props.map(p => {
    const agency = p.sources?.map(s => s.portal).join('; ') || '';
    const link = p.sources?.map(s => s.url).join('; ') || '';
    const phone = p.agentPhone || (() => { const m = (p.description || '').match(/(?:(?:\+44|0)\s*\d[\d\s]{8,12}\d)/); return m ? m[0].trim() : ''; })();
    return [p.title, p.address, p.price, p.bedrooms, p.bathrooms, p.type, p.postedDate || '', p.agent || agency, phone, link,
      fmtName(p.nearestAirport), fmtDist(p.nearestAirport), fmtName(p.nearestAirstrip), fmtDist(p.nearestAirstrip), fmtName(p.nearestHeliport), fmtDist(p.nearestHeliport),
      propertyNotes[pkey(p)] || propertyNotes[p._key] || ''];
  });
  const csv = [headers, ...rows].map(r => r.map(c => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = `property-list-${activeListTab}-${new Date().toISOString().slice(0, 10)}.csv`; a.click();
}

// --- Init ---
init();
