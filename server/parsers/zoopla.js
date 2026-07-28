const { getBrowser } = require('../browser');

async function scrape(url) {
  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await new Promise(r => setTimeout(r, 5000));

    // Scroll each listing into view to trigger lazy-load of images
    const listingCount = await page.$$eval('[id^="listing_"]', els => els.length);
    for (let i = 0; i < listingCount; i++) {
      await page.evaluate(idx => {
        const els = document.querySelectorAll('[id^="listing_"]');
        if (els[idx]) els[idx].scrollIntoView({ behavior: 'instant', block: 'center' });
      }, i);
      await new Promise(r => setTimeout(r, 800));
    }
    // Quick second pass
    for (let i = 0; i < listingCount; i++) {
      await page.evaluate(idx => {
        const els = document.querySelectorAll('[id^="listing_"]');
        if (els[idx]) els[idx].scrollIntoView({ behavior: 'instant', block: 'center' });
      }, i);
      await new Promise(r => setTimeout(r, 400));
    }
    await new Promise(r => setTimeout(r, 2000));

    const listings = await page.evaluate(() => {
      const results = [];
      const listingEls = document.querySelectorAll('[id^="listing_"]');

      for (const el of listingEls) {
        const detailLinks = el.querySelectorAll('a[href*="/for-sale/details/"]');
        if (!detailLinks.length) continue;

        const infoLink = detailLinks.length > 1 ? detailLinks[1] : detailLinks[0];
        let href = infoLink.href;
        if (href.includes('/contact/')) {
          href = href.replace('/contact/', '/');
        }

        const fullText = el.textContent;
        const infoText = infoLink.textContent;

        // Price
        const priceMatch = fullText.match(/£([\d,]+)/);
        const price = priceMatch ? parseInt(priceMatch[1].replace(/,/g, '')) : null;

        // Specs
        const bedsMatch = fullText.match(/(\d+)\s*beds?/i);
        const bathsMatch = fullText.match(/(\d+)\s*baths?/i);
        const sqftMatch = fullText.match(/([\d,]+)\s*sq\s*ft/i);

        // Address extraction — find text after specs that looks like an address
        let address = null;
        const textToSearch = infoText || fullText;

        // Pattern: text after "sq ft" or after "receptions?" up to description start
        let afterSpecs = textToSearch;
        // Strip everything up to and including the last spec
        afterSpecs = afterSpecs.replace(/^.*\d+\s*sq\s*ft\s*/i, '');
        if (afterSpecs === textToSearch) {
          afterSpecs = afterSpecs.replace(/^.*\d+\s*receptions?\s*/i, '');
        }
        if (afterSpecs === textToSearch) {
          afterSpecs = afterSpecs.replace(/^.*\d+\s*baths?\s*/i, '');
        }
        if (afterSpecs === textToSearch) {
          afterSpecs = afterSpecs.replace(/^.*\d+\s*beds?\s*/i, '');
        }
        if (afterSpecs === textToSearch) {
          afterSpecs = afterSpecs.replace(/^.*See monthly cost\s*/i, '');
        }
        // Always strip leading price text if still present
        afterSpecs = afterSpecs.replace(/^£[\d,]+\s*/i, '');
        afterSpecs = afterSpecs.replace(/^(Guide price|Offers over)\s*/i, '');
        afterSpecs = afterSpecs.replace(/^See monthly cost\s*/i, '');
        // Strip any remaining specs
        afterSpecs = afterSpecs.replace(/^\d+\s*beds?\s*/i, '');
        afterSpecs = afterSpecs.replace(/^\d+\s*baths?\s*/i, '');
        afterSpecs = afterSpecs.replace(/^\d+\s*receptions?\s*/i, '');
        afterSpecs = afterSpecs.replace(/^[\d,]+\s*sq\s*ft\s*/i, '');

        // Address typically ends with a postcode like "IP19" or "IP19 9XX"
        // The postcode may be followed immediately by description text with no space
        const postcodeMatch = afterSpecs.match(/^(.*?[A-Z]{1,2}\d{1,2}\s+\d[A-Z]{2})/);
        const postcodeShort = !postcodeMatch && afterSpecs.match(/^(.*?[A-Z]{1,2}\d{1,2})/);
        const addrFromPostcode = postcodeMatch || postcodeShort;
        if (addrFromPostcode) {
          address = addrFromPostcode[1].trim();
        } else {
          // Take text up to the first sentence-like description
          const descStart = afterSpecs.search(/[.!]|This |A |An |Set |Built |With |Explore |Welcome |Step |Situated |Guide price/);
          if (descStart > 5) {
            address = afterSpecs.substring(0, descStart).trim();
          } else if (afterSpecs.length > 5 && afterSpecs.length < 120) {
            address = afterSpecs.trim();
          }
        }

        // Clean up address
        if (address) {
          address = address
            .replace(/^(Guide price|Offers over)\s*/i, '')
            .replace(/See monthly cost/i, '')
            .replace(/\d+\s*beds?\s*/i, '')
            .replace(/\d+\s*baths?\s*/i, '')
            .replace(/\d+\s*receptions?\s*/i, '')
            .replace(/([\d,]+)\s*sq\s*ft/i, '')
            .replace(/^£[\d,]+\s*/i, '')
            .replace(/^\s*,\s*/, '')
            .trim();
          // Remove trailing badges
          address = address.replace(/(Chain free|Freehold|Leasehold|Reduced|Hidden Gem|Be one of the first.*|New home).*$/i, '').trim();
          // Remove trailing description
          const descCut = address.search(/\b(Attik|This|A rare|A unique|Step|Welcome|Explore|Built|With views|Situated|\*{2,}|Leisure)\b/i);
          if (descCut > 10) address = address.substring(0, descCut).trim();
        }

        // Description
        let description = '';
        const descMatch = fullText.match(/((?:Attik|This|A |An |Set |Built |With |Explore |Welcome |Step |Situated |Guide price \£)[\s\S]{20,300}?)(?:Chain free|Freehold|Leasehold|Reduced|Hidden|Email|Phone|$)/i);
        if (descMatch) description = descMatch[1].trim();

        // Images — get from picture source srcset and img src
        const images = [];
        const seen = new Set();

        // Try srcset from picture > source (jpeg type preferred)
        const sources = el.querySelectorAll('picture source[type="image/jpeg"], picture source[type="image/webp"]');
        for (const src of sources) {
          const srcset = src.srcset;
          if (!srcset) continue;
          // Extract 645-wide image URLs
          const matches = srcset.match(/https:\/\/lid\.zoocdn\.com\/645\/430\/[a-f0-9]+\.jpg/g);
          if (matches) {
            for (const m of matches) {
              if (!seen.has(m)) { seen.add(m); images.push(m); }
            }
          }
        }

        // Also check img elements directly (src and currentSrc)
        const imgEls = el.querySelectorAll('img');
        for (const img of imgEls) {
          for (const src of [img.currentSrc, img.src]) {
            if (src && src.includes('lid.zoocdn.com')) {
              // Normalize to 645/430 size
              const normalized = src.replace(/\/\d+\/\d+\//, '/645/430/').replace(/:p$/, '');
              if (!seen.has(normalized)) { seen.add(normalized); images.push(normalized); }
            }
          }
        }

        // Property type
        const typeMatch = fullText.match(/\b(Detached house|Semi-detached house|Terraced house|Flat|Bungalow|Cottage|End of terrace house|Maisonette|Town house|Penthouse|Detached|Semi-detached|End of terrace)\b/i);
        const type = typeMatch ? typeMatch[1] : null;

        // Build title
        let title = '';
        if (bedsMatch) title += bedsMatch[1] + ' bed ';
        if (type) title += type.toLowerCase();
        else title += 'property';
        title += ' for sale';

        if (price === null) continue;

        // Posted date from badges
        let postedDate = null;
        const badges = fullText.match(/(Hidden Gem|Be one of the first|Chain free|Freehold|Leasehold|Reduced|New home|Just added)/gi) || [];
        if (badges.some(b => /reduced/i.test(b))) postedDate = 'Reduced';
        else if (badges.some(b => /just added|new home/i.test(b))) postedDate = 'Just added';
        else if (badges.some(b => /hidden gem|be one of the first/i.test(b))) postedDate = 'New listing';

        // Agent from image alt: "Property X of Y. ImageName | AgentName"
        let agent = null;
        const imgAlts = el.querySelectorAll('img[alt]');
        for (const img of imgAlts) {
          const alt = img.alt;
          const agentMatch = alt.match(/\|\s*(.+)/);
          if (agentMatch) { agent = agentMatch[1].trim(); break; }
        }

        results.push({
          title,
          price,
          address: address || 'Address not available',
          bedrooms: bedsMatch ? parseInt(bedsMatch[1]) : null,
          bathrooms: bathsMatch ? parseInt(bathsMatch[1]) : null,
          sqft: sqftMatch ? parseInt(sqftMatch[1].replace(',', '')) : null,
          type: type || 'Property',
          description,
          postedDate: postedDate || null,
          agent: agent || null,
          agentPhone: null,
          images: images.length > 0 ? images.slice(0, 15) : ['https://placehold.co/400x300/e0e0e0/999?text=No+Image'],
          sources: [{ portal: 'Zoopla', url: href }],
          lat: null,
          lon: null,
        });
      }

      return results;
    });

    return listings;
  } finally {
    await page.close();
  }
}

module.exports = { scrape };
