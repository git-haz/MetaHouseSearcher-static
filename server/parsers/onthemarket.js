const { getBrowser } = require('../browser');

async function scrape(url) {
  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await new Promise(r => setTimeout(r, 6000));

    // Scroll to load lazy content
    for (let i = 0; i < 15; i++) {
      await page.evaluate(() => window.scrollBy(0, 500));
      await new Promise(r => setTimeout(r, 500));
    }
    await new Promise(r => setTimeout(r, 2000));

    const listings = await page.evaluate(() => {
      const results = [];
      const els = document.querySelectorAll('[id^="result-"]');

      for (const el of els) {
        const links = el.querySelectorAll('a[href*="/details/"]');
        if (!links.length) continue;

        let href = '', titleAttr = '';
        for (const a of links) {
          if (a.title) { href = a.href; titleAttr = a.title; break; }
        }
        if (!href) href = links[0].href;

        const text = el.textContent;

        // Price
        const priceMatch = text.match(/£([\d,]+)/);
        const price = priceMatch ? parseInt(priceMatch[1].replace(/,/g, '')) : null;
        if (!price) continue;

        // Address and type from title: "View the details for ADDRESS - TYPE"
        let address = '', type = '', title = '';
        if (titleAttr) {
          const m = titleAttr.match(/View the details for (.+?) - (.+)/);
          if (m) {
            address = m[1].trim();
            type = m[2].trim();
            title = type;
          }
        }

        // Extract beds/baths from type string: "3 bedroom detached house for sale"
        const bedsMatch = type.match(/(\d+)\s*bed/i);
        const bathsMatch = text.match(/(\d+)\s*bath/i);
        const beds = bedsMatch ? parseInt(bedsMatch[1]) : null;
        const baths = bathsMatch ? parseInt(bathsMatch[1]) : null;

        // Clean type: remove "for sale" and bed count
        let cleanType = type.replace(/for sale/i, '').replace(/\d+\s*bedroom\s*/i, '').trim();
        cleanType = cleanType.charAt(0).toUpperCase() + cleanType.slice(1);

        // Images from swiper slides
        const images = [];
        const seen = new Set();
        const imgEls = el.querySelectorAll('img[src*="media.onthemarket"], img[srcset*="media.onthemarket"]');
        for (const img of imgEls) {
          const srcset = img.srcset || '';
          const src = img.src || '';
          // Extract base URL and use 480x320
          for (const s of [srcset, src]) {
            const match = s.match(/(https:\/\/media\.onthemarket\.com\/properties\/\d+\/\d+\/image-\d+)/);
            if (match) {
              const imgUrl = match[1] + '-480x320.jpg';
              if (!seen.has(imgUrl)) { seen.add(imgUrl); images.push(imgUrl); }
            }
          }
        }

        // Posted date and agent from the agent bar
        let postedDate = null;
        let agent = null;
        let agentPhone = null;
        const agentBar = el.querySelector('[class*="whitespace-nowrap"][class*="flex"]');
        if (agentBar) {
          const span = agentBar.querySelector('span');
          if (span) {
            const spanText = span.textContent.trim();
            if (spanText.match(/Added|Reduced/i)) postedDate = spanText;
          }
        }
        const agentDiv = el.querySelector('[class*="text-xs"][class*="leading-relaxed"]');
        if (agentDiv) {
          const agentText = agentDiv.textContent.trim();
          const agentMatch = agentText.match(/^(.+?)(?:Added|Reduced)/i);
          if (agentMatch) agent = agentMatch[1].trim();
          const phoneMatch = agentText.match(/(\d{5}\s*\d{6})/);
          if (phoneMatch) agentPhone = phoneMatch[1];
        }

        // Description from text (strip price, agent name etc)
        let description = '';
        const descMatch = text.match(/(?:A |This |Set |Built |Situated |An |Enjoying |Offering |Charming |Beautiful |Spacious |Lovely |Located )[\s\S]{20,250}/i);
        if (descMatch) description = descMatch[0].trim();

        results.push({
          title: title || (beds ? `${beds} bed property for sale` : 'Property for sale'),
          price,
          address: address || 'Address not available',
          bedrooms: beds,
          bathrooms: baths,
          sqft: null,
          postedDate: postedDate || null,
          agent: agent || null,
          agentPhone: agentPhone || null,
          type: cleanType || 'Property',
          description,
          images: images.length > 0 ? images.slice(0, 15) : ['https://placehold.co/400x300/e0e0e0/999?text=No+Image'],
          sources: [{ portal: 'OnTheMarket', url: href }],
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
