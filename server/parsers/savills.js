const { getBrowser } = require('../browser');

async function scrape(url) {
  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await new Promise(r => setTimeout(r, 10000));

    for (let i = 0; i < 10; i++) {
      await page.evaluate(() => window.scrollBy(0, 500));
      await new Promise(r => setTimeout(r, 400));
    }
    await new Promise(r => setTimeout(r, 2000));

    const listings = await page.evaluate(() => {
      const results = [];
      const cards = document.querySelectorAll('article.sv-property-card');

      for (const card of cards) {
        const text = card.textContent.trim();

        // Skip under offer / sold
        if (text.match(/Under offer|Sold STC|Sold/i) && !text.match(/Guide price|Asking/i)) continue;

        // Price
        const priceMatch = text.match(/£([\d,]+)/);
        if (!priceMatch) continue;
        const price = parseInt(priceMatch[1].replace(/,/g, ''));

        // Link
        const link = card.querySelector('a[href*="/property-detail/"]');
        const href = link ? link.href : '';

        // Address — first text block, usually "Street…Town, County, Postcode"
        let address = '';
        const addrEl = card.querySelector('[class*="address"], [class*="location"]');
        if (addrEl) {
          address = addrEl.textContent.trim().replace(/…/g, ', ');
        } else {
          const textParts = text.split(/£[\d,]+/)[0];
          const addrMatch = textParts.match(/(?:Save|New|Under offer)?([\w\s,.']+?)(?:\d+\s*sq\s*ft|Guide|Asking|\d+\s*bed)/i);
          if (addrMatch) address = addrMatch[1].trim();
        }
        // Clean up "loading" text and image counter
        address = address.replace(/^(loading)+/i, '').replace(/^\d+\/\d+/, '').replace(/^(Save|New)\s*/i, '').trim();

        // Sq ft
        const sqftMatch = text.match(/([\d,]+)\s*sq\s*ft/i);
        const sqft = sqftMatch ? parseInt(sqftMatch[1].replace(',', '')) : null;

        // Beds/baths from text
        const bedsMatch = text.match(/(\d+)\s*(?:bed|double bed)/i);
        const bathsMatch = text.match(/(\d+)\s*bath/i);

        // Image
        const img = card.querySelector('img[src*="savills.com"]');
        const imgSrc = img?.src || '';
        const images = imgSrc ? [imgSrc] : [];

        // Description
        const descMatch = text.match(/(?:A |This |An |Set |Built |Situated |Charming |Beautiful |Spacious |Two |Three |Four )[\s\S]{20,200}/i);
        const description = descMatch ? descMatch[0].trim() : '';

        let title = '';
        if (bedsMatch) title += bedsMatch[1] + ' bed ';
        title += 'property for sale';

        results.push({
          title,
          price,
          address: address || 'Address not available',
          bedrooms: bedsMatch ? parseInt(bedsMatch[1]) : null,
          bathrooms: bathsMatch ? parseInt(bathsMatch[1]) : null,
          sqft,
          type: 'Property',
          description,
          postedDate: null,
          agent: 'Savills',
          agentPhone: null,
          images: images.length > 0 ? images : ['https://placehold.co/400x300/e0e0e0/999?text=No+Image'],
          sources: [{ portal: 'Savills', url: href || url }],
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
