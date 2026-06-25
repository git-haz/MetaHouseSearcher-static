// --- Persistent lists & notes ---
const LIST_NAMES = ['favorite', 'seen', 'view', 'viewed', 'in_progress', 'rejected'];
const LIST_LABELS = { favorite: 'Favorites', seen: 'Seen', view: 'To View', viewed: 'Viewed', in_progress: 'In Progress', rejected: 'Rejected', excluded: 'Exclusion Zone' };

let propertyLists = loadJSON('propertyLists', {});
let propertyNotes = loadJSON('propertyNotes', {});

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

    document.getElementById('lastUpdated').textContent = `Last updated: ${new Date(allData.generatedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}`;

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
          <option value="airport-desc">Airport Dist: Furthest</option>
          <option value="airport-asc">Airport Dist: Nearest</option>
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

  const badgesHtml = tags.length > 0 ? `<div class="card-tag-badges">${tags.map(t => `<span class="tag-badge tag-badge-${t}">${LIST_LABELS[t]}</span>`).join('')}</div>` : '';

  const carouselHtml = `<div class="card-carousel" id="${cid}">
    ${images.map((img, i) => `<img src="${img}" alt="${p.title}" loading="lazy" class="${i === 0 ? 'active' : ''}">`).join('')}
    ${multi ? `<button class="carousel-btn carousel-prev" onclick="carouselNav('${cid}',-1)">&#8249;</button><button class="carousel-btn carousel-next" onclick="carouselNav('${cid}',1)">&#8250;</button><span class="carousel-counter">1 / ${images.length}</span>` : ''}
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

  return `<div class="property-card" data-key="${key}">
    ${carouselHtml}
    <div class="card-body">
      ${badgesHtml}
      <div class="card-price">£${p.price.toLocaleString()} ${postedHtml}</div>
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
      ${airportHtml}
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
  const counter = el.querySelector('.carousel-counter');
  let cur = 0;
  imgs.forEach((img, i) => { if (img.classList.contains('active')) cur = i; });
  imgs[cur].classList.remove('active');
  cur = (cur + dir + imgs.length) % imgs.length;
  imgs[cur].classList.add('active');
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
  list.innerHTML = exclusionZones.map((z, i) => `<div class="zone-item"><span><span class="zone-color" style="background:${ZONE_COLORS[i % ZONE_COLORS.length]};"></span>${z.name}</span><div class="zone-item-actions"><button class="btn btn-outline btn-sm" onclick="toggleZoneVis(${i})">${z.hidden ? 'Show' : 'Hide'}</button><button class="btn btn-danger btn-sm" onclick="deleteZone(${i})">Delete</button></div></div>`).join('');
}
window.deleteZone = function(i) { exclusionZones.splice(i, 1); saveZones(); renderZoneList(); drawZonesOnMap(); renderResults(currentResults); };
window.toggleZoneVis = function(i) { exclusionZones[i].hidden = !exclusionZones[i].hidden; saveZones(); renderZoneList(); drawZonesOnMap(); };

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
    const k = field === 'price' ? 'price' : 'minAirportDistanceMiles';
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
  const headers = ['Title', 'Address', 'Price', 'Bedrooms', 'Bathrooms', 'Type', 'Posted', 'Agency', 'Phone', 'Link', 'Airport (mi)', 'Airstrip (mi)', 'Heliport (mi)', 'Note'];
  const rows = props.map(p => {
    const agency = p.sources?.map(s => s.portal).join('; ') || '';
    const link = p.sources?.map(s => s.url).join('; ') || '';
    return [p.title, p.address, p.price, p.bedrooms, p.bathrooms, p.type, p.postedDate || '', p.agent || agency, p.agentPhone || '', link,
      p.nearestAirport ? p.nearestAirport.distanceMiles.toFixed(1) : '', p.nearestAirstrip ? p.nearestAirstrip.distanceMiles.toFixed(1) : '', p.nearestHeliport ? p.nearestHeliport.distanceMiles.toFixed(1) : '',
      propertyNotes[pkey(p)] || propertyNotes[p._key] || ''];
  });
  const csv = [headers, ...rows].map(r => r.map(c => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = `property-list-${activeListTab}-${new Date().toISOString().slice(0, 10)}.csv`; a.click();
}

// --- Init ---
init();
