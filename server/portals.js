function slugify(loc) {
  return loc.toLowerCase().trim().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
}

function buildUrls(portal, criteria, rightmoveLocations) {
  const locations = (criteria.locations || '').split(',').map(l => l.trim()).filter(Boolean);
  const urls = [];

  for (const loc of locations) {
    const url = builders[portal.id]
      ? builders[portal.id](portal, criteria, loc, rightmoveLocations)
      : buildGeneric(portal, criteria, loc);
    if (url) urls.push({ portal: portal.name, url });
  }

  return urls;
}

function addParam(params, key, val) {
  if (val != null && val !== '' && val !== undefined) params.push(`${key}=${encodeURIComponent(val)}`);
}

function joinKeywords(keywords) {
  if (!keywords || !keywords.length) return null;
  return keywords.join(',');
}

function joinPropertyTypes(types) {
  if (!types || !types.length) return null;
  return types.join(',');
}

const builders = {
  zoopla(portal, c, loc) {
    const slug = slugify(loc);
    const params = [];
    addParam(params, 'q', joinKeywords(c.keywords));
    addParam(params, 'price_max', c.maxPrice);
    addParam(params, 'beds_min', c.minBed);
    addParam(params, 'property_type', joinPropertyTypes(c.propertyTypes));
    const qs = params.length ? '?' + params.join('&') : '';
    return `https://www.zoopla.co.uk/for-sale/property/${slug}/${qs}`;
  },

  rightmove(portal, c, loc, rightmoveLocations) {
    const locId = (rightmoveLocations || {})[loc.toLowerCase().trim()];
    if (!locId) return null;
    const params = [`locationIdentifier=${encodeURIComponent(locId)}`];
    addParam(params, 'radius', '40.0');
    addParam(params, 'keywords', joinKeywords(c.keywords));
    addParam(params, 'maxPrice', c.maxPrice);
    addParam(params, 'minBedrooms', c.minBed);
    addParam(params, 'propertyTypes', joinPropertyTypes(c.propertyTypes));
    params.push('includeSSTC=false');
    return `https://www.rightmove.co.uk/property-for-sale/find.html?${params.join('&')}`;
  },

  onthemarket(portal, c, loc) {
    const slug = slugify(loc);
    const params = [];
    addParam(params, 'q', joinKeywords(c.keywords));
    addParam(params, 'min-bedrooms', c.minBed);
    addParam(params, 'property-type', joinPropertyTypes(c.propertyTypes));
    addParam(params, 'max-price', c.maxPrice);
    const qs = params.length ? '?' + params.join('&') : '';
    return `https://www.onthemarket.com/for-sale/property/${slug}/${qs}`;
  },

  durrants(portal, c, loc) {
    const params = [
      'department=residential-sales',
      'view=list',
    ];
    addParam(params, 'address_keyword', loc);
    addParam(params, 'radius', c.radius);
    addParam(params, 'minimum_bedrooms', c.minBed);
    addParam(params, 'maximum_price', c.maxPrice);
    return `https://durrants.com/properties/?${params.join('&')}`;
  },

  winkworth(portal, c, loc) {
    const params = [];
    addParam(params, 'search_location', loc);
    addParam(params, 'min_beds', c.minBed);
    addParam(params, 'keywords', joinKeywords(c.keywords));
    addParam(params, 'property_type', joinPropertyTypes(c.propertyTypes));
    addParam(params, 'max_price', c.maxPrice);
    return `https://www.winkworth.co.uk/properties?${params.join('&')}`;
  },

  davidburr(portal, c, loc) {
    const params = [];
    addParam(params, 'location', loc);
    addParam(params, 'min_beds', c.minBed);
    addParam(params, 'keywords', joinKeywords(c.keywords));
    addParam(params, 'property_type', joinPropertyTypes(c.propertyTypes));
    addParam(params, 'max_price', c.maxPrice);
    return `https://davidburr.co.uk/property-search/?${params.join('&')}`;
  },

  clarkeandsimpson(portal, c, loc) {
    const params = [];
    addParam(params, 'location', loc);
    addParam(params, 'min_beds', c.minBed);
    addParam(params, 'keywords', joinKeywords(c.keywords));
    addParam(params, 'property_type', joinPropertyTypes(c.propertyTypes));
    addParam(params, 'max_price', c.maxPrice);
    return `https://www.clarkeandsimpson.co.uk/property-search/?${params.join('&')}`;
  },

  harrisonedge(portal, c, loc) {
    const params = [];
    addParam(params, 'location', loc);
    addParam(params, 'min_beds', c.minBed);
    addParam(params, 'keywords', joinKeywords(c.keywords));
    addParam(params, 'property_type', joinPropertyTypes(c.propertyTypes));
    addParam(params, 'max_price', c.maxPrice);
    return `https://harrisonedge.com/properties/?${params.join('&')}`;
  },

  savills(portal, c, loc) {
    const params = ['SearchList=Id_5201+Category_SBuy', 'Tenure=GRS_T_B', 'SortOrder=SO_PCDD'];
    addParam(params, 'SearchLocation', loc);
    addParam(params, 'MinBedrooms', c.minBed);
    addParam(params, 'MaxPrice', c.maxPrice);
    return `https://search.savills.com/list?${params.join('&')}`;
  },

  struttandparker(portal, c, loc) {
    const params = [];
    addParam(params, 'search', loc);
    addParam(params, 'minbeds', c.minBed);
    addParam(params, 'maxprice', c.maxPrice);
    return `https://www.struttandparker.com/find-a-property?${params.join('&')}`;
  },

  'jackson-stops'(portal, c, loc) {
    const params = ['channel=sales'];
    addParam(params, 'locations[0]', loc);
    addParam(params, 'minBeds', c.minBed);
    addParam(params, 'maxPrice', c.maxPrice);
    return `https://www.jackson-stops.co.uk/properties/search?${params.join('&')}`;
  },

  bedfords(portal, c, loc) {
    const params = [];
    addParam(params, 'location', loc);
    addParam(params, 'min_beds', c.minBed);
    addParam(params, 'keywords', joinKeywords(c.keywords));
    addParam(params, 'property_type', joinPropertyTypes(c.propertyTypes));
    addParam(params, 'max_price', c.maxPrice);
    return `https://www.bedfords.co.uk/search/?${params.join('&')}`;
  },

  flickandson(portal, c, loc) {
    const params = [];
    addParam(params, 'location', loc);
    addParam(params, 'min_beds', c.minBed);
    addParam(params, 'keywords', joinKeywords(c.keywords));
    addParam(params, 'property_type', joinPropertyTypes(c.propertyTypes));
    addParam(params, 'max_price', c.maxPrice);
    return `https://www.flickandson.co.uk/property-search/?${params.join('&')}`;
  },

  fineandcountry(portal, c, loc) {
    const params = [];
    addParam(params, 'location', loc);
    addParam(params, 'minbeds', c.minBed);
    addParam(params, 'keywords', joinKeywords(c.keywords));
    addParam(params, 'propertytype', joinPropertyTypes(c.propertyTypes));
    addParam(params, 'maxprice', c.maxPrice);
    return `https://www.fineandcountry.com/uk/property-search?${params.join('&')}`;
  },

  ivybridge(portal, c, loc) {
    return 'https://ivybridgecollection.com';
  }
};

function buildGeneric(portal, criteria, loc) {
  if (!portal.urlTemplate) return null;
  return portal.urlTemplate
    .replace(/\{location\}/g, encodeURIComponent(loc))
    .replace(/\{minPrice\}/g, criteria.minPrice || '')
    .replace(/\{maxPrice\}/g, criteria.maxPrice || '')
    .replace(/\{minBed\}/g, criteria.minBed || '')
    .replace(/\{maxBed\}/g, criteria.maxBed || '')
    .replace(/\{minBath\}/g, criteria.minBath || '')
    .replace(/\{maxBath\}/g, criteria.maxBath || '')
    .replace(/\{radius\}/g, criteria.radius || '')
    .replace(/\{keywords\}/g, joinKeywords(criteria.keywords) || '')
    .replace(/\{propertyTypes\}/g, joinPropertyTypes(criteria.propertyTypes) || '');
}

module.exports = { buildUrls };
