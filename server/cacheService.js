/**
 * cacheService.js — LRU-style in-memory cache with TTL
 * Replaces raw API calls with cached results to avoid redundant Binance requests.
 */

class TTLCache {
  constructor(defaultTTL = 30000) {
    this.store = new Map();
    this.defaultTTL = defaultTTL;
    this.hits = 0;
    this.misses = 0;
  }

  get(key) {
    const entry = this.store.get(key);
    if (!entry) { this.misses++; return undefined; }
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      this.misses++;
      return undefined;
    }
    this.hits++;
    return entry.value;
  }

  set(key, value, ttlMs) {
    this.store.set(key, { value, expiresAt: Date.now() + (ttlMs || this.defaultTTL) });
  }

  has(key) {
    const entry = this.store.get(key);
    if (!entry) return false;
    if (Date.now() > entry.expiresAt) { this.store.delete(key); return false; }
    return true;
  }

  clear() { this.store.clear(); }

  stats() {
    return { size: this.store.size, hits: this.hits, misses: this.misses, hitRate: this.hits + this.misses > 0 ? (this.hits / (this.hits + this.misses) * 100).toFixed(1) + '%' : 'N/A' };
  }
}

// Different TTLs for different data types
const klineCache = new TTLCache(30000);    // 30s for klines (price changes fast)
const tickerCache = new TTLCache(10000);    // 10s for ticker (very volatile)
const fundingCache = new TTLCache(60000);   // 60s for funding (updates every 8h)
const aggTradeCache = new TTLCache(15000);  // 15s for aggTrades
const marketCache = new TTLCache(60000);    // 60s for market leaders

function cacheKey(symbol, ...parts) {
  return symbol.toUpperCase() + ':' + parts.join(':');
}

function cachedKlines(getFn) {
  return async function(symbol, interval, limit = 100, endTime) {
    const key = cacheKey(symbol, 'klines', interval, limit, endTime || 'latest');
    const cached = klineCache.get(key);
    if (cached) return cached;
    const result = await getFn(symbol, interval, limit, endTime);
    if (result && result.length > 0) klineCache.set(key, result);
    return result;
  };
}

function cachedTicker(getFn) {
  return async function(symbol) {
    const key = cacheKey(symbol, 'ticker');
    const cached = tickerCache.get(key);
    if (cached) return cached;
    const result = await getFn(symbol);
    if (result && result.lastPrice) tickerCache.set(key, result);
    return result;
  };
}

function cachedFunding(getFn) {
  return async function(symbol) {
    const key = cacheKey(symbol, 'funding');
    const cached = fundingCache.get(key);
    if (cached) return cached;
    const result = await getFn(symbol);
    if (result && result.success) fundingCache.set(key, result);
    return result;
  };
}

function cachedAggTrades(getFn) {
  return async function(symbol, limit) {
    const key = cacheKey(symbol, 'aggTrades', limit || 'default');
    const cached = aggTradeCache.get(key);
    if (cached) return cached;
    const result = await getFn(symbol, limit);
    if (result && result.length > 0) aggTradeCache.set(key, result);
    return result;
  };
}

function getCachedTickerDirect(symbol) {
  return tickerCache.get(cacheKey(symbol, 'ticker')) || null;
}

function preloadTicker(symbol, data) {
  if (data && data.lastPrice) tickerCache.set(cacheKey(symbol, 'ticker'), data, 10000);
}

function cacheStats() {
  return {
    klines: klineCache.stats(),
    ticker: tickerCache.stats(),
    funding: fundingCache.stats(),
    aggTrades: aggTradeCache.stats(),
    market: marketCache.stats()
  };
}

module.exports = {
  TTLCache,
  klineCache,
  tickerCache,
  fundingCache,
  aggTradeCache,
  marketCache,
  cacheKey,
  cachedKlines,
  cachedTicker,
  cachedFunding,
  cachedAggTrades,
  getCachedTickerDirect,
  preloadTicker,
  cacheStats
};
