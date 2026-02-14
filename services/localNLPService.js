/**
 * Local NLP Service - Rule-based sentiment analysis for crypto news
 * Zero external API dependencies - pure keyword matching and pattern detection
 * Part of Phase 4: Social Sentiment Integration
 */

// Bullish keywords with intensity weights (0-1 scale)
const BULLISH_KEYWORDS = {
  'surge': 0.8, 'surges': 0.8, 'surging': 0.8,
  'soar': 0.9, 'soars': 0.9, 'soaring': 0.9,
  'rally': 0.7, 'rallies': 0.7, 'rallying': 0.7,
  'breakout': 0.7, 'breaking out': 0.7,
  'bullish': 0.8, 'bull': 0.6, 'bulls': 0.6,
  'moon': 0.6, 'mooning': 0.7, 'to the moon': 0.6,
  'pump': 0.5, 'pumping': 0.6, 'pumped': 0.5,
  'ath': 0.9, 'all-time high': 0.9, 'all time high': 0.9, 'new high': 0.8,
  'record high': 0.9, 'record': 0.5,
  'buy': 0.4, 'buying': 0.4, 'bought': 0.4,
  'accumulate': 0.6, 'accumulating': 0.6, 'accumulation': 0.6,
  'upgrade': 0.6, 'upgraded': 0.6, 'upgrades': 0.6,
  'adoption': 0.7, 'adopting': 0.6, 'adopted': 0.6,
  'partnership': 0.5, 'partner': 0.4, 'partners': 0.4,
  'institutional': 0.6, 'institutions': 0.6,
  'approved': 0.7, 'approval': 0.7, 'approve': 0.6,
  'etf': 0.5, 'exchange-traded': 0.5,
  'recovery': 0.5, 'recovering': 0.5, 'recover': 0.5,
  'bounce': 0.5, 'bouncing': 0.5, 'bounced': 0.5,
  'launch': 0.4, 'launching': 0.4, 'launched': 0.4,
  'integration': 0.4, 'integrating': 0.4, 'integrated': 0.4,
  'outperform': 0.6, 'outperforming': 0.6, 'outperformed': 0.6,
  'gains': 0.5, 'gain': 0.5, 'gaining': 0.5,
  'profit': 0.4, 'profitable': 0.5, 'profits': 0.4,
  'support': 0.3, 'supporting': 0.3, 'supported': 0.3,
  'strong': 0.3, 'stronger': 0.4, 'strength': 0.4,
  'growth': 0.5, 'growing': 0.5, 'grow': 0.4,
  'positive': 0.4, 'positively': 0.4,
  'optimistic': 0.5, 'optimism': 0.5,
  'confidence': 0.4, 'confident': 0.4,
  'momentum': 0.5, 'explosive': 0.7,
  'breakthrough': 0.6, 'innovation': 0.5,
  'skyrocket': 0.9, 'skyrocketing': 0.9,
  'boom': 0.7, 'booming': 0.7,
  'success': 0.5, 'successful': 0.5,
  'victory': 0.6, 'win': 0.5, 'winning': 0.5,
  'golden cross': 0.7, 'golden': 0.3,
  'reversal': 0.4, 'reverse': 0.3,
  'reclaim': 0.5, 'reclaims': 0.5, 'reclaimed': 0.5,
  'breakthrough': 0.6, 'break above': 0.6,
  'rising': 0.4, 'rise': 0.4, 'risen': 0.4,
  'climb': 0.5, 'climbing': 0.5, 'climbed': 0.5,
  'spike': 0.6, 'spiking': 0.6, 'spiked': 0.6,
  'jump': 0.5, 'jumping': 0.5, 'jumped': 0.5,
  'explode': 0.8, 'exploding': 0.8, 'explosion': 0.8
};

// Bearish keywords with intensity weights (0-1 scale)
const BEARISH_KEYWORDS = {
  'crash': 0.9, 'crashes': 0.9, 'crashing': 0.9, 'crashed': 0.9,
  'plunge': 0.8, 'plunges': 0.8, 'plunging': 0.8, 'plunged': 0.8,
  'dump': 0.7, 'dumping': 0.7, 'dumped': 0.7, 'dumps': 0.7,
  'bearish': 0.8, 'bear': 0.6, 'bears': 0.6,
  'sell-off': 0.7, 'selloff': 0.7, 'sell off': 0.7,
  'collapse': 0.9, 'collapsing': 0.9, 'collapsed': 0.9,
  'plummet': 0.8, 'plummets': 0.8, 'plummeting': 0.8, 'plummeted': 0.8,
  'tank': 0.7, 'tanking': 0.7, 'tanked': 0.7, 'tanks': 0.7,
  'ban': 0.8, 'banned': 0.8, 'banning': 0.8, 'bans': 0.8,
  'crackdown': 0.7, 'crack down': 0.7,
  'regulation': 0.4, 'regulate': 0.4, 'regulatory': 0.4,
  'hack': 0.8, 'hacked': 0.9, 'hacking': 0.8, 'hacks': 0.8,
  'exploit': 0.7, 'exploited': 0.8, 'exploiting': 0.7,
  'vulnerability': 0.6, 'vulnerable': 0.6,
  'breach': 0.7, 'breached': 0.8, 'breaching': 0.7,
  'fraud': 0.8, 'fraudulent': 0.8,
  'scam': 0.7, 'scammer': 0.7, 'scamming': 0.7,
  'ponzi': 0.8, 'pyramid scheme': 0.8,
  'rug pull': 0.9, 'rugpull': 0.9, 'rug': 0.5,
  'bankrupt': 0.9, 'bankruptcy': 0.9, 'bankrupt': 0.9,
  'insolvent': 0.9, 'insolvency': 0.9,
  'liquidation': 0.6, 'liquidate': 0.6, 'liquidated': 0.7,
  'fear': 0.5, 'fearful': 0.5,
  'panic': 0.7, 'panicking': 0.7, 'panicked': 0.7,
  'capitulation': 0.8, 'capitulate': 0.7,
  'bloodbath': 0.8, 'blood': 0.4,
  'downgrade': 0.6, 'downgraded': 0.6, 'downgrades': 0.6,
  'lawsuit': 0.6, 'sue': 0.6, 'sued': 0.6, 'suing': 0.6,
  'sec': 0.4, 'securities': 0.3,
  'resistance': 0.3, 'resist': 0.3,
  'weak': 0.4, 'weaker': 0.5, 'weakness': 0.5,
  'decline': 0.5, 'declining': 0.5, 'declined': 0.5,
  'loss': 0.4, 'losses': 0.5, 'losing': 0.5, 'lost': 0.5,
  'negative': 0.4, 'negatively': 0.4,
  'pessimistic': 0.5, 'pessimism': 0.5,
  'warning': 0.4, 'warn': 0.4, 'warns': 0.4,
  'risk': 0.3, 'risky': 0.4, 'risks': 0.3,
  'bubble': 0.6, 'bubbles': 0.6,
  'overvalued': 0.5, 'overpriced': 0.5,
  'correction': 0.4, 'correcting': 0.4,
  'drop': 0.5, 'drops': 0.5, 'dropping': 0.5, 'dropped': 0.5,
  'fall': 0.5, 'falls': 0.5, 'falling': 0.5, 'fell': 0.5,
  'tumble': 0.6, 'tumbles': 0.6, 'tumbling': 0.6, 'tumbled': 0.6,
  'slump': 0.6, 'slumps': 0.6, 'slumping': 0.6, 'slumped': 0.6,
  'retreat': 0.5, 'retreats': 0.5, 'retreating': 0.5,
  'pullback': 0.4, 'pull back': 0.4,
  'sell': 0.4, 'selling': 0.4, 'sold': 0.4,
  'death cross': 0.7, 'death': 0.3,
  'break below': 0.6, 'below': 0.2,
  'fail': 0.5, 'fails': 0.5, 'failed': 0.5, 'failure': 0.5,
  'concern': 0.4, 'concerns': 0.4, 'concerned': 0.4,
  'doubt': 0.4, 'doubts': 0.4, 'doubtful': 0.4,
  'uncertainty': 0.4, 'uncertain': 0.4
};

// Negation words that flip sentiment
const NEGATION_WORDS = new Set([
  'not', 'no', 'never', 'neither', "n't", "don't", "doesn't",
  "won't", "can't", "isn't", "aren't", "wasn't", "weren't",
  'without', 'despite', 'unlikely', 'fail', 'failed', 'fails',
  'barely', 'hardly', 'scarcely', 'nobody', 'nothing', 'nowhere'
]);

// Intensifier words that amplify sentiment
const INTENSIFIERS = {
  'very': 1.3,
  'extremely': 1.5,
  'massive': 1.4,
  'massively': 1.4,
  'huge': 1.3,
  'hugely': 1.3,
  'major': 1.2,
  'significant': 1.2,
  'significantly': 1.2,
  'unprecedented': 1.5,
  'incredible': 1.4,
  'incredibly': 1.4,
  'amazing': 1.3,
  'amazingly': 1.3,
  'exceptional': 1.4,
  'exceptionally': 1.4,
  'remarkable': 1.3,
  'remarkably': 1.3,
  'absolutely': 1.3,
  'totally': 1.2,
  'completely': 1.2,
  'utterly': 1.3,
  'seriously': 1.2,
  'insanely': 1.4,
  'wildly': 1.3
};

// Crypto entity mapping (name -> ticker)
const CRYPTO_ENTITIES = {
  'bitcoin': 'BTC', 'btc': 'BTC',
  'ethereum': 'ETH', 'eth': 'ETH', 'ether': 'ETH',
  'ripple': 'XRP', 'xrp': 'XRP',
  'solana': 'SOL', 'sol': 'SOL',
  'cardano': 'ADA', 'ada': 'ADA',
  'dogecoin': 'DOGE', 'doge': 'DOGE',
  'binance coin': 'BNB', 'bnb': 'BNB', 'binance': 'BNB',
  'chainlink': 'LINK', 'link': 'LINK',
  'polkadot': 'DOT', 'dot': 'DOT',
  'avalanche': 'AVAX', 'avax': 'AVAX'
};

/**
 * Tokenize text into words while preserving some multi-word phrases
 * @param {string} text - Input text
 * @returns {string[]} Array of tokens
 */
function tokenize(text) {
  const lower = text.toLowerCase();

  // First, extract multi-word phrases
  const phrases = [];
  const phrasePatterns = [
    /all[- ]time high/g,
    /new high/g,
    /record high/g,
    /sell[- ]off/g,
    /rug pull/g,
    /golden cross/g,
    /death cross/g,
    /break above/g,
    /break below/g,
    /pull back/g,
    /crack down/g,
    /pyramid scheme/g,
    /exchange[- ]traded/g,
    /to the moon/g,
    /breaking out/g
  ];

  let workingText = lower;
  phrasePatterns.forEach(pattern => {
    const matches = lower.match(pattern);
    if (matches) {
      matches.forEach(match => {
        const normalized = match.replace(/[- ]/g, ' ');
        phrases.push(normalized);
        workingText = workingText.replace(match, ''); // Remove from working text
      });
    }
  });

  // Tokenize remaining text
  const words = workingText
    .split(/[\s,;.!?()[\]{}'"]+/)
    .filter(w => w.length > 0);

  // Combine phrases and words
  return [...phrases, ...words];
}

/**
 * Check if a word is negated by looking at previous words
 * @param {string[]} tokens - All tokens
 * @param {number} index - Current token index
 * @param {number} lookback - How many words to look back (default 3)
 * @returns {boolean} True if negated
 */
function isNegated(tokens, index, lookback = 3) {
  const start = Math.max(0, index - lookback);
  for (let i = start; i < index; i++) {
    if (NEGATION_WORDS.has(tokens[i])) {
      return true;
    }
  }
  return false;
}

/**
 * Check for intensifier before a word
 * @param {string[]} tokens - All tokens
 * @param {number} index - Current token index
 * @returns {number} Intensity multiplier (1.0 if none)
 */
function getIntensifier(tokens, index) {
  if (index === 0) return 1.0;

  const prev = tokens[index - 1];
  return INTENSIFIERS[prev] || 1.0;
}

/**
 * Extract percentage from headline patterns like "BTC surges 10%"
 * @param {string} text - Input text
 * @returns {number|null} Percentage or null
 */
function extractPercentage(text) {
  const match = text.match(/(\d+(?:\.\d+)?)\s*%/);
  return match ? parseFloat(match[1]) : null;
}

/**
 * Analyze sentiment patterns in headline
 * @param {string} text - Input text
 * @returns {Object[]} Array of pattern matches
 */
function analyzePatterns(text) {
  const patterns = [];
  const lower = text.toLowerCase();

  // Pattern: "X surges/rallies/soars N%"
  let match = lower.match(/(\w+)\s+(?:surges?|rallies?|soars?|jumps?|spikes?)\s+(\d+(?:\.\d+)?)\s*%/);
  if (match) {
    const pct = parseFloat(match[2]);
    const weight = Math.min(pct / 10, 2.0); // Cap at 2x
    patterns.push({ type: 'surge_with_pct', weight, entity: match[1] });
  }

  // Pattern: "X plunges/crashes/drops/falls N%"
  match = lower.match(/(\w+)\s+(?:plunges?|crashes?|drops?|falls?|tumbles?|tanks?)\s+(\d+(?:\.\d+)?)\s*%/);
  if (match) {
    const pct = parseFloat(match[2]);
    const weight = -Math.min(pct / 10, 2.0); // Negative, cap at -2x
    patterns.push({ type: 'crash_with_pct', weight, entity: match[1] });
  }

  // Pattern: "X hits/reaches/breaks ATH/all-time high/record"
  match = lower.match(/(\w+)\s+(?:hits?|reaches?|breaks?|achieves?)\s+(?:new\s+)?(?:ath|all[- ]time high|record(?:\s+high)?)/);
  if (match) {
    patterns.push({ type: 'ath', weight: 1.5, entity: match[1] });
  }

  // Pattern: "X breaks below/loses $PRICE support"
  match = lower.match(/(\w+)\s+(?:breaks?\s+below|loses?)\s+\$?[\d,]+\s*(?:support)?/);
  if (match) {
    patterns.push({ type: 'break_support', weight: -0.8, entity: match[1] });
  }

  // Pattern: "X breaks above/reclaims $PRICE"
  match = lower.match(/(\w+)\s+(?:breaks?\s+(?:above|through)|reclaims?)\s+\$?[\d,]+/);
  if (match) {
    patterns.push({ type: 'break_resistance', weight: 0.8, entity: match[1] });
  }

  // Pattern: "X ETF approved"
  match = lower.match(/(\w+)\s+etf\s+(?:approved|approval|launches?)/);
  if (match) {
    patterns.push({ type: 'etf_approval', weight: 1.2, entity: match[1] });
  }

  // Pattern: "X hack/exploit"
  match = lower.match(/(\w+)\s+(?:hacked?|exploit(?:ed)?|breach(?:ed)?)/);
  if (match) {
    patterns.push({ type: 'security_breach', weight: -1.3, entity: match[1] });
  }

  return patterns;
}

/**
 * Main sentiment analysis function
 * @param {string} text - Headline or short text to analyze
 * @returns {Object} Sentiment analysis result
 */
export function analyzeSentiment(text) {
  if (!text || typeof text !== 'string') {
    return { score: 0, magnitude: 0, label: 'NEUTRAL', keywords: [] };
  }

  const tokens = tokenize(text);
  const keywords = [];
  let totalScore = 0;
  let totalMagnitude = 0;

  // Analyze keywords
  tokens.forEach((token, index) => {
    let weight = 0;
    let isBullish = false;

    if (token in BULLISH_KEYWORDS) {
      weight = BULLISH_KEYWORDS[token];
      isBullish = true;
    } else if (token in BEARISH_KEYWORDS) {
      weight = -BEARISH_KEYWORDS[token];
      isBullish = false;
    } else {
      return; // Not a sentiment keyword
    }

    // Check for negation
    const negated = isNegated(tokens, index);
    if (negated) {
      weight = -weight; // Flip sentiment
    }

    // Check for intensifier
    const intensifier = getIntensifier(tokens, index);
    weight *= intensifier;

    keywords.push({
      word: token,
      baseWeight: isBullish ? BULLISH_KEYWORDS[token] : BEARISH_KEYWORDS[token],
      finalWeight: weight,
      negated,
      intensifier: intensifier > 1 ? tokens[index - 1] : null
    });

    totalScore += weight;
    totalMagnitude += Math.abs(weight);
  });

  // Analyze patterns
  const patterns = analyzePatterns(text);
  patterns.forEach(pattern => {
    totalScore += pattern.weight;
    totalMagnitude += Math.abs(pattern.weight);

    keywords.push({
      word: pattern.type,
      baseWeight: pattern.weight,
      finalWeight: pattern.weight,
      negated: false,
      pattern: true,
      entity: pattern.entity
    });
  });

  // Normalize score to -1 to 1 range
  // Use soft normalization to avoid extreme compression
  const normalizedScore = totalScore === 0 ? 0 :
    totalScore / (Math.abs(totalScore) + 2); // Soft sigmoid-like

  // Calculate magnitude (0-1 scale)
  const magnitude = Math.min(totalMagnitude / 5, 1.0); // Cap at 1.0

  // Determine label
  let label;
  if (normalizedScore > 0.5) {
    label = 'VERY_BULLISH';
  } else if (normalizedScore > 0.2) {
    label = 'BULLISH';
  } else if (normalizedScore < -0.5) {
    label = 'VERY_BEARISH';
  } else if (normalizedScore < -0.2) {
    label = 'BEARISH';
  } else {
    label = 'NEUTRAL';
  }

  return {
    score: normalizedScore,
    magnitude,
    label,
    keywords: keywords.sort((a, b) => Math.abs(b.finalWeight) - Math.abs(a.finalWeight))
  };
}

/**
 * Analyze multiple headlines and get aggregate sentiment
 * @param {string[]} texts - Array of headlines
 * @returns {Object} Aggregate sentiment analysis
 */
export function analyzeMultiple(texts) {
  if (!Array.isArray(texts) || texts.length === 0) {
    return {
      avgScore: 0,
      medianScore: 0,
      label: 'NEUTRAL',
      distribution: { veryBullish: 0, bullish: 0, neutral: 0, bearish: 0, veryBearish: 0 },
      topBullish: [],
      topBearish: []
    };
  }

  const results = texts.map(text => ({
    text,
    ...analyzeSentiment(text)
  }));

  // Calculate average score
  const avgScore = results.reduce((sum, r) => sum + r.score, 0) / results.length;

  // Calculate median score
  const scores = results.map(r => r.score).sort((a, b) => a - b);
  const medianScore = scores.length % 2 === 0
    ? (scores[scores.length / 2 - 1] + scores[scores.length / 2]) / 2
    : scores[Math.floor(scores.length / 2)];

  // Calculate distribution
  const distribution = {
    veryBullish: results.filter(r => r.label === 'VERY_BULLISH').length,
    bullish: results.filter(r => r.label === 'BULLISH').length,
    neutral: results.filter(r => r.label === 'NEUTRAL').length,
    bearish: results.filter(r => r.label === 'BEARISH').length,
    veryBearish: results.filter(r => r.label === 'VERY_BEARISH').length
  };

  // Get top bullish and bearish
  const sortedByScore = [...results].sort((a, b) => b.score - a.score);
  const topBullish = sortedByScore.slice(0, 5).filter(r => r.score > 0).map(r => ({
    text: r.text,
    score: r.score,
    label: r.label
  }));
  const topBearish = sortedByScore.slice(-5).reverse().filter(r => r.score < 0).map(r => ({
    text: r.text,
    score: r.score,
    label: r.label
  }));

  // Overall label based on average
  let label;
  if (avgScore > 0.5) {
    label = 'VERY_BULLISH';
  } else if (avgScore > 0.2) {
    label = 'BULLISH';
  } else if (avgScore < -0.5) {
    label = 'VERY_BEARISH';
  } else if (avgScore < -0.2) {
    label = 'BEARISH';
  } else {
    label = 'NEUTRAL';
  }

  return {
    avgScore,
    medianScore,
    label,
    distribution,
    totalCount: texts.length,
    topBullish,
    topBearish
  };
}

/**
 * Extract crypto entities (coins mentioned) from text
 * @param {string} text - Input text
 * @returns {string[]} Array of ticker codes (e.g., ['BTC', 'ETH'])
 */
export function extractEntities(text) {
  if (!text || typeof text !== 'string') {
    return [];
  }

  const lower = text.toLowerCase();
  const entities = new Set();

  // Check for full names
  Object.entries(CRYPTO_ENTITIES).forEach(([name, ticker]) => {
    // Word boundary check for full names
    const regex = new RegExp(`\\b${name}\\b`, 'i');
    if (regex.test(lower)) {
      entities.add(ticker);
    }
  });

  // Check for uppercase tickers (only if they appear as standalone uppercase words)
  const words = text.split(/\s+/);
  words.forEach(word => {
    // Remove punctuation
    const clean = word.replace(/[.,;:!?()[\]{}'"]/g, '');
    // Only match if it's all uppercase and 2-5 characters
    if (clean === clean.toUpperCase() && clean.length >= 2 && clean.length <= 5) {
      const ticker = clean.toUpperCase();
      // Check if it's a known ticker
      if (Object.values(CRYPTO_ENTITIES).includes(ticker)) {
        entities.add(ticker);
      }
    }
  });

  return Array.from(entities);
}

/**
 * Score headlines specifically for a ticker
 * @param {string[]} headlines - Array of headlines
 * @param {string} ticker - Ticker code (e.g., 'BTC')
 * @returns {Object} Ticker-specific sentiment analysis
 */
export function scoreHeadlinesForTicker(headlines, ticker) {
  if (!Array.isArray(headlines) || !ticker) {
    return {
      score: 0,
      count: 0,
      relevantHeadlines: []
    };
  }

  // Filter headlines that mention the ticker
  const relevantHeadlines = headlines
    .map(text => {
      const entities = extractEntities(text);
      const sentiment = analyzeSentiment(text);
      return {
        text,
        entities,
        ...sentiment,
        relevant: entities.includes(ticker.toUpperCase())
      };
    })
    .filter(h => h.relevant);

  if (relevantHeadlines.length === 0) {
    return {
      score: 0,
      count: 0,
      relevantHeadlines: []
    };
  }

  // Calculate aggregate score
  const totalScore = relevantHeadlines.reduce((sum, h) => sum + h.score, 0);
  const avgScore = totalScore / relevantHeadlines.length;

  return {
    score: avgScore,
    count: relevantHeadlines.length,
    relevantHeadlines: relevantHeadlines
      .sort((a, b) => Math.abs(b.score) - Math.abs(a.score))
      .slice(0, 10) // Top 10 most impactful
      .map(h => ({
        text: h.text,
        score: h.score,
        label: h.label,
        magnitude: h.magnitude
      }))
  };
}

/**
 * Get service status and dictionary info
 * @returns {Object} Service status
 */
export function getStatus() {
  return {
    version: '1.0',
    dictionarySize: {
      bullish: Object.keys(BULLISH_KEYWORDS).length,
      bearish: Object.keys(BEARISH_KEYWORDS).length,
      negation: NEGATION_WORDS.size,
      intensifiers: Object.keys(INTENSIFIERS).length,
      cryptoEntities: Object.keys(CRYPTO_ENTITIES).length
    },
    patternsCount: 7,
    memoryUsage: process.memoryUsage().heapUsed / 1024 / 1024 // MB
  };
}

// Export all functions
export default {
  analyzeSentiment,
  analyzeMultiple,
  extractEntities,
  scoreHeadlinesForTicker,
  getStatus
};
