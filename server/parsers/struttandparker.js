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
      const cards = document.querySelectorAll('.card--property');

      for (const card of cards) {
        // Skip under offer / sold
        if (card.classList.contains('card--under-offer') || card.classList.contains('card--sold')) continue;

        const text = card.textContent.trim();

        // Price
        const priceMatch = text.match(/£([\d,]+)/);
        if (!priceMatch) continue;
        const price = parseInt(priceMatch[1].replace(/,/g, ''));

        // Link
        const href = card.tagName === 'A' ? card.href : (card.querySelector('a')?.href || '');

        // Address — first text content typically
        const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 3);
        let address = lines[0] || '';

        // Beds/baths/receptions — look for numbers before price
        const nums = text.match(/(\d+)\s+(\d+)\s+(\d+)/);
        let beds = null, baths = null;
        if (nums) {
          beds = parseInt(nums[1]);
          baths = parseInt(nums[2]);
        }

        // Image
        const img = card.querySelector('img');
        const imgSrc = img?.src || '';
        const images = imgSrc ? [imgSrc] : [];

        // Description
        const descMatch = text.match(/(?:A |This |An |Set |Built |Situated )[\s\S]{20,200}/i);
        const description = descMatch ? descMatch[0].trim() : '';

        let title = '';
        if (beds) title += `${beds} bed `;
        title += 'property for sale';

        results.push({
          title,
          price,
          address: address || 'Address not available',
          bedrooms: beds,
          bathrooms: baths,
          sqft: null,
          type: 'Property',
          description,
          postedDate: null,
          agent: 'Strutt & Parker',
          agentPhone: null,
          images: images.length > 0 ? images : ['https://placehold.co/400x300/e0e0e0/999?text=No+Image'],
          sources: [{ portal: 'Strutt & Parker', url: href || url }],
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
