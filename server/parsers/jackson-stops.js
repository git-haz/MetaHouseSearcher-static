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
      const cards = document.querySelectorAll('.property-single__grid');

      for (const card of cards) {
        const text = card.textContent.trim();

        // Price
        const priceMatch = text.match(/£([\d,]+)/);
        if (!priceMatch) continue;
        const price = parseInt(priceMatch[1].replace(/,/g, ''));

        // Skip lettings (PM = per month)
        if (text.includes('PM,') || text.includes('PW)')) continue;

        // Link
        const link = card.querySelector('a[href*="/properties/"]');
        const href = link ? link.href : '';

        // Address — first line of text
        const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 3);
        let address = lines[0] || '';

        // Beds/baths/receptions
        const bedsMatch = text.match(/(\d+)\s*Bedrooms?/i);
        const bathsMatch = text.match(/(\d+)\s*Bathrooms?/i);
        const receptionsMatch = text.match(/(\d+)\s*Receptions?/i);

        // Image
        const img = card.querySelector('img');
        const imgSrc = img?.src || '';
        const images = imgSrc ? [imgSrc] : [];

        // Price qualifier
        const qualMatch = text.match(/(Guide price|Asking Price|Offers over)/i);

        let title = '';
        if (bedsMatch) title += bedsMatch[1] + ' bed ';
        title += 'property for sale';

        results.push({
          title,
          price,
          address: address || 'Address not available',
          bedrooms: bedsMatch ? parseInt(bedsMatch[1]) : null,
          bathrooms: bathsMatch ? parseInt(bathsMatch[1]) : null,
          sqft: null,
          type: 'Property',
          description: '',
          postedDate: qualMatch ? qualMatch[1] : null,
          agent: 'Jackson-Stops',
          agentPhone: null,
          images: images.length > 0 ? images : ['https://placehold.co/400x300/e0e0e0/999?text=No+Image'],
          sources: [{ portal: 'Jackson-Stops', url: href || url }],
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
