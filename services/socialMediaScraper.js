/**
 * Social Media Scraper (Backend)
 *
 * Provides connectors for various social platforms to monitor crypto sentiment.
 * Mock implementation that provides the structure for real API integrations.
 *
 * Requirements 46, 47, 48, 49
 */

export const PLATFORMS = {
  TWITTER: 'TWITTER',
  REDDIT: 'REDDIT',
  DISCORD: 'DISCORD',
  YOUTUBE: 'YOUTUBE',
  KICK: 'KICK',
  INSTAGRAM: 'INSTAGRAM',
  FACEBOOK: 'FACEBOOK'
};

/**
 * Mock data generator for platform sentiment
 */
function getMockPlatformData(ticker, platform) {
    const hash = ticker.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
    const platformHash = platform.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
    const seed = (hash + platformHash + Math.floor(Date.now() / 3600000)) % 100;
    
    return {
        platform,
        mentions: Math.floor(seed * (platform === 'TWITTER' ? 10 : 5)),
        sentiment: (seed - 50) / 100, // -0.5 to 0.5
        trending: seed > 80,
        influencerScore: Math.floor(seed / 10)
    };
}

/**
 * Platform Connectors
 */
const connectors = {
  [PLATFORMS.TWITTER]: async (ticker) => {
    // Placeholder for Twitter API v2 integration
    return getMockPlatformData(ticker, PLATFORMS.TWITTER);
  },
  [PLATFORMS.REDDIT]: async (ticker) => {
    // Placeholder for Reddit API integration
    return getMockPlatformData(ticker, PLATFORMS.REDDIT);
  },
  [PLATFORMS.DISCORD]: async (ticker) => {
    // Placeholder for Discord webhook/bot integration
    return getMockPlatformData(ticker, PLATFORMS.DISCORD);
  }
};

/**
 * Scrape all available platforms for a given ticker
 * @param {string} ticker
 */
export async function scrapeSocialPlatforms(ticker) {
  const results = [];
  
  for (const platform of Object.keys(connectors)) {
    try {
      const data = await connectors[platform](ticker);
      results.push(data);
    } catch (e) {
      console.error(`[Scraper] Failed to scrape ${platform} for ${ticker}:`, e.message);
    }
  }

  // Simulate extra platforms occasionally
  if (Math.random() > 0.7) {
      results.push(getMockPlatformData(ticker, PLATFORMS.YOUTUBE));
  }

  return results;
}

/**
 * Calculate weighted aggregate sentiment across platforms
 * @param {Array} platformResults 
 */
export function calculateWeightedSentiment(platformResults) {
  if (!platformResults || platformResults.length === 0) return 0;

  const weights = {
    [PLATFORMS.TWITTER]: 0.4,
    [PLATFORMS.REDDIT]: 0.3,
    [PLATFORMS.DISCORD]: 0.2,
    [PLATFORMS.YOUTUBE]: 0.1
  };

  let totalWeight = 0;
  let weightedScore = 0;

  for (const res of platformResults) {
    const weight = weights[res.platform] || 0.05;
    weightedScore += res.sentiment * weight;
    totalWeight += weight;
  }

  return totalWeight > 0 ? weightedScore / totalWeight : 0;
}

/**
 * Analyze news sources to determine trending platforms
 * @param {Array} newsItems - Items from fetchCryptoNews
 * @returns {Object} platformCounts - { 'twitter.com': 15, 'reddit.com': 5, ... }
 */
export function analyzeNewsSources(newsItems) {
    const platformCounts = {};
    
    if (!newsItems || !Array.isArray(newsItems)) return platformCounts;

    for (const item of newsItems) {
        if (!item.url && !item.source) continue;
        
        let domain = 'unknown';
        
        try {
            if (item.url) {
                const urlObj = new URL(item.url);
                domain = urlObj.hostname.replace('www.', '');
            } else if (item.source) {
                // Fallback to source title if URL missing
                domain = item.source.toLowerCase().replace(/\s+/g, '');
            }
        } catch (e) {
            domain = 'unknown';
        }

        // Map common domains to platforms
        if (domain.includes('twitter') || domain.includes('x.com')) domain = 'Twitter';
        else if (domain.includes('reddit')) domain = 'Reddit';
        else if (domain.includes('youtube')) domain = 'YouTube';
        else if (domain.includes('medium')) domain = 'Medium';
        else if (domain.includes('discord')) domain = 'Discord';
        else if (domain.includes('telegram')) domain = 'Telegram';

        platformCounts[domain] = (platformCounts[domain] || 0) + 1;
    }

    return platformCounts;
}
