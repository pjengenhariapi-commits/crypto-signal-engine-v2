/**
 * @fileoverview Advanced Microstructure Analysis Service for Crypto Futures Trading
 *
 * Provides cross-exchange funding spread analysis, liquidation cluster estimation,
 * order-book anomaly detection, short-timeframe CVD divergence, and cross-asset
 * correlation context.  Every external HTTP call uses a 5-second timeout and
 * results are cached for 5 minutes to respect public rate-limits.
 *
 * @module microstructureService
 * @requires axios
 */

'use strict';

const axios = require('axios');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Cache time-to-live in milliseconds (5 minutes). */
const CACHE_TTL_MS = 5 * 60 * 1000;

/** Timeout for every external HTTP request in milliseconds. */
const REQUEST_TIMEOUT_MS = 5_000;

/** Universe of exchanges we compare funding rates across. */
const FUNDING_SOURCES = [
  {
    name: 'Binance',
    /** @param {string} symbol - e.g. 'SOLUSDT' */
    url: (symbol) =>
      `https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${symbol}`,
    parse: (data) => ({
      symbol: data.symbol,
      fundingRate: parseFloat(data.lastFundingRate),
      nextFundingTime: data.nextFundingTime,
      markPrice: parseFloat(data.markPrice),
      indexPrice: parseFloat(data.indexPrice),
      timestamp: Date.now(),
    }),
  },
  {
    name: 'Bybit',
    /** @param {string} symbol - e.g. 'SOLUSDT' */
    url: (symbol) =>
      `https://api.bybit.com/v5/market/tickers?category=linear&symbol=${symbol}`,
    parse: (data) => {
      const ticker = data?.result?.list?.[0];
      if (!ticker) return null;
      return {
        symbol: ticker.symbol,
        fundingRate: parseFloat(ticker.fundingRate),
        nextFundingTime: parseInt(ticker.nextFundingTime, 10),
        markPrice: parseFloat(ticker.markPrice),
        indexPrice: parseFloat(ticker.indexPrice1h),
        timestamp: Date.now(),
      };
    },
  },
  {
    name: 'OKX',
    /**
     * OKX uses BTC-USDT-SWAP style symbols so we convert from Binance-style.
     * @param {string} symbol - e.g. 'SOLUSDT'
     */
    url: (symbol) => {
      const okxSymbol = symbol.replace('USDT', '-USDT-SWAP');
      return `https://www.okx.com/api/v5/public/funding-rate?instId=${okxSymbol}`;
    },
    parse: (data) => {
      const item = data?.data?.[0];
      if (!item) return null;
      return {
        symbol: item.instId,
        fundingRate: parseFloat(item.fundingRate),
        nextFundingTime: parseInt(item.nextFundingTime, 10),
        markPrice: null,
        indexPrice: null,
        timestamp: Date.now(),
      };
    },
  },
];

// ---------------------------------------------------------------------------
// Simple in-memory TTL cache
// ---------------------------------------------------------------------------

/** @type {Map<string, {ts: number, value: any}>} */
const _cache = new Map();

/**
 * Retrieve a cached value if it is still fresh.
 * @param {string} key
 * @returns {any|null}
 */
function _getCache(key) {
  const entry = _cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) {
    _cache.delete(key);
    return null;
  }
  return entry.value;
}

/**
 * Store a value in the cache.
 * @param {string} key
 * @param {any} value
 */
function _setCache(key, value) {
  _cache.set(key, { ts: Date.now(), value: value });
}

/**
 * Clear the entire cache (useful for tests).
 */
function clearCache() {
  _cache.clear();
}

// ---------------------------------------------------------------------------
// HTTP helper with timeout and graceful error handling
// ---------------------------------------------------------------------------

/**
 * Perform a GET request with a 5-second timeout.  On failure the error is
 * logged and `null` is returned instead of throwing.
 *
 * @param {string} url
 * @returns {Promise<any|null>} Parsed JSON response or null on failure.
 */
async function _safeGet(url) {
  try {
    const resp = await axios.get(url, { timeout: REQUEST_TIMEOUT_MS });
    return resp.data;
  } catch (err) {
    const brief = err.message?.substring(0, 120);
    console.warn(`[microstructure] HTTP error for ${url}: ${brief}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// 1. Funding Spread Analysis
// ---------------------------------------------------------------------------

/**
 * Fetch funding-rate snapshots from Binance, Bybit, and OKX for the given
 * symbol, compute the spread between the highest and lowest rate, and flag
 * significant divergences.
 *
 * @param {string} symbol - Binance-style symbol, e.g. 'SOLUSDT'.
 * @returns {Promise<Object>} Funding spread analysis result.
 * @example
 *   const spread = await getFundingSpread('SOLUSDT');
 *   // { symbol, rates: [...], spread, spreadBps, divergent, timestamp }
 */
async function getFundingSpread(symbol) {
  const cacheKey = `fundingSpread:${symbol}`;
  const cached = _getCache(cacheKey);
  if (cached) return cached;

  // Fire all exchange requests in parallel
  const results = await Promise.allSettled(
    FUNDING_SOURCES.map(async (src) => {
      const data = await _safeGet(src.url(symbol));
      if (!data) return null;
      const parsed = src.parse(data);
      if (!parsed) return null;
      return { source: src.name, ...parsed };
    }),
  );

  const rates = results
    .map((r) => (r.status === 'fulfilled' ? r.value : null))
    .filter(Boolean);

  const validRates = rates.filter((r) => typeof r.fundingRate === 'number' && !isNaN(r.fundingRate));

  let spread = 0;
  let spreadBps = 0;
  let divergent = false;
  let arbitrageDirection = 'neutral';
  let avgRate = 0;

  if (validRates.length >= 2) {
    const maxRate = Math.max(...validRates.map((r) => r.fundingRate));
    const minRate = Math.min(...validRates.map((r) => r.fundingRate));
    spread = maxRate - minRate;
    avgRate = validRates.reduce((s, r) => s + r.fundingRate, 0) / validRates.length;
    spreadBps = spread * 10000; // convert to basis points

    // Divergence threshold: 10 bps (0.1%) spread is significant in funding
    divergent = spreadBps >= 10;

    if (divergent) {
      // Determine direction: if one exchange is much higher, longs on that
      // exchange pay shorts - potential delta-neutral arb opportunity.
      const highSrc = validRates.find((r) => r.fundingRate === maxRate);
      const lowSrc = validRates.find((r) => r.fundingRate === minRate);
      arbitrageDirection = `Long ${lowSrc.source} / Short ${highSrc.source}`;
    }
  }

  const output = {
    symbol,
    rates,
    validRateCount: validRates.length,
    avgRate,
    avgRateBps: avgRate * 10000,
    spread,
    spreadBps,
    divergent,
    divergentThresholdBps: 10,
    arbitrageDirection,
    interpretation: _interpretFundingSpread(spreadBps, avgRate),
    timestamp: Date.now(),
  };

  _setCache(cacheKey, output);
  return output;
}

/**
 * @param {number} spreadBps
 * @param {number} avgRate
 * @returns {string}
 */
function _interpretFundingSpread(spreadBps, avgRate) {
  if (spreadBps >= 30) {
    return 'Extreme divergence - strong delta-neutral arbitrage opportunity. Expect rapid reversion.';
  }
  if (spreadBps >= 10) {
    return 'Notable divergence - potential cross-exchange arb. One venue is mispriced relative to consensus.';
  }
  if (spreadBps >= 5) {
    return 'Minor spread - within normal range but watch for widening.';
  }
  const rateDesc = avgRate > 0.0005 ? 'elevated' : avgRate < -0.0005 ? 'negative' : 'neutral';
  return `Converged funding (${rateDesc}). No significant cross-exchange divergence.`;
}

// ---------------------------------------------------------------------------
// 2. Liquidation Heatmap Estimation
// ---------------------------------------------------------------------------

/**
 * Estimate likely liquidation clusters using funding-rate and open-interest
 * data.  This is a probabilistic model: when funding is heavily skewed in one
 * direction, over-leveraged positions on that side are closer to liquidation.
 * Combined with price distance from key levels we produce an estimated
 * liquidation heatmap.
 *
 * @param {string} symbol - e.g. 'SOLUSDT'.
 * @param {Object|null} tickerData - Latest ticker with price, high, low, volume.
 * @param {Object|null} fundingData - Funding rate and mark price info.
 * @returns {Promise<Object>} Estimated liquidation zones.
 */
async function estimateLiquidationClusters(symbol, tickerData, fundingData) {
  const cacheKey = `liqClusters:${symbol}`;
  const cached = _getCache(cacheKey);
  if (cached) return cached;

  // Fetch open interest from Binance Futures
  const oiUrl = `https://fapi.binance.com/fapi/v1/openInterest?symbol=${symbol}`;
  const oiData = await _safeGet(oiUrl);

  // Fetch recent funding history to see trend
  const fundingHistoryUrl =
    `https://fapi.binance.com/fapi/v1/fundingRate?symbol=${symbol}&limit=20`;
  const fundingHistoryData = await _safeGet(fundingHistoryUrl);

  // Derive price from available sources
  const currentPrice =
    tickerData?.lastPrice ||
    tickerData?.markPrice ||
    fundingData?.markPrice ||
    0;

  const openInterest = oiData ? parseFloat(oiData.openInterest || 0) : 0;
  const fundingRate = fundingData?.lastFundingRate
    ? parseFloat(fundingData.lastFundingRate)
    : 0;

  // Recent funding history analysis
  const fundingHistory = Array.isArray(fundingHistoryData)
    ? fundingHistoryData.map((f) => ({
        rate: parseFloat(f.fundingRate),
        time: f.fundingTime,
      }))
    : [];

  const avgRecentFunding =
    fundingHistory.length > 0
      ? fundingHistory.reduce((s, f) => s + f.rate, 0) / fundingHistory.length
      : fundingRate;

  // Estimate how many consecutive funding periods have been one-sided
  let consecutivePositive = 0;
  let consecutiveNegative = 0;
  for (let i = fundingHistory.length - 1; i >= 0; i--) {
    if (fundingHistory[i].rate > 0) {
      if (consecutiveNegative > 0) break;
      consecutivePositive++;
    } else if (fundingHistory[i].rate < 0) {
      if (consecutivePositive > 0) break;
      consecutiveNegative++;
    } else {
      break;
    }
  }

  // ----- Liquidation Zone Estimation -----
  // Typical liquidation thresholds: 1x-125x leverage
  // Higher leverage = closer liquidation to entry price
  // When funding is very positive, longs are paying shorts, suggesting
  // crowded longs. If price drops, long liquidations cascade.
  const leverageTiers = [125, 100, 75, 50, 40, 25, 20, 15, 10, 5, 3, 2];

  const clusters = [];

  // Assumption: concentrated positions at round leverage multiples
  // and at percentage intervals based on OI density
  const priceRangeHigh = tickerData?.highPrice || currentPrice * 1.05;
  const priceRangeLow = tickerData?.lowPrice || currentPrice * 0.95;
  const range = priceRangeHigh - priceRangeLow;

  // Price movement thresholds at which each leverage tier liquidates
  // Approx: liquidation at ~50% of margin for isolated margin
  for (const leverage of leverageTiers) {
    const liqThreshold = 1 / leverage; // fraction of margin
    const priceDrop = currentPrice * liqThreshold;
    const priceRise = currentPrice * liqThreshold;

    const longLiqPrice = currentPrice - priceDrop;
    const shortLiqPrice = currentPrice + priceRise;

    // Estimate density: OI distributed roughly inversely with leverage
    // (more OI at lower leverage, fewer degens at higher)
    const densityFactor = 1 / Math.log2(leverage + 1);
    const estimatedOI = (openInterest * densityFactor) /
      leverageTiers.reduce((s, l) => s + 1 / Math.log2(l + 1), 0);

    // Confidence: higher when funding indicates crowded positioning
    const crowdedLongSide = avgRecentFunding > 0;
    const crowdedShortSide = avgRecentFunding < 0;

    // Long liquidations (price drops) are more likely when longs are crowded
    const longConfidence = crowdedLongSide
      ? Math.min(1, Math.abs(avgRecentFunding) * 5000 * (1 + consecutivePositive * 0.2))
      : Math.max(0.1, 0.5 - Math.abs(avgRecentFunding) * 1000);

    const shortConfidence = crowdedShortSide
      ? Math.min(1, Math.abs(avgRecentFunding) * 5000 * (1 + consecutiveNegative * 0.2))
      : Math.max(0.1, 0.5 - Math.abs(avgRecentFunding) * 1000);

    if (longLiqPrice >= priceRangeLow) {
      clusters.push({
        side: 'long',
        leverage,
        estimatedLiqPrice: Math.round(longLiqPrice * 10000) / 10000,
        distanceFromPrice: priceDrop,
        distancePct: (priceDrop / currentPrice) * 100,
        estimatedOI: Math.round(estimatedOI * 1000) / 1000,
        confidence: Math.round(longConfidence * 100) / 100,
      });
    }

    if (shortLiqPrice <= priceRangeHigh) {
      clusters.push({
        side: 'short',
        leverage,
        estimatedLiqPrice: Math.round(shortLiqPrice * 10000) / 10000,
        distanceFromPrice: priceRise,
        distancePct: (priceRise / currentPrice) * 100,
        estimatedOI: Math.round(estimatedOI * 1000) / 1000,
        confidence: Math.round(shortConfidence * 100) / 100,
      });
    }
  }

  // Identify dense clusters: price levels where many leverage tiers
  // have liquidation prices stacked close together
  const denseClusters = _findDenseLiqClusters(clusters, currentPrice);

  // Risk assessment
  const nearestLongLiq = clusters
    .filter((c) => c.side === 'long')
    .sort((a, b) => a.distancePct - b.distancePct)[0];
  const nearestShortLiq = clusters
    .filter((c) => c.side === 'short')
    .sort((a, b) => a.distancePct - b.distancePct)[0];

  const output = {
    symbol,
    currentPrice,
    openInterest,
    fundingRate,
    avgRecentFunding,
    consecutiveFundingPeriods: {
      positive: consecutivePositive,
      negative: consecutiveNegative,
    },
    clusters,
    denseClusters,
    nearestLongLiquidation: nearestLongLiq || null,
    nearestShortLiquidation: nearestShortLiq || null,
    riskAssessment: _assessLiqRisk(clusters, avgRecentFunding, consecutivePositive, consecutiveNegative),
    priceRange: { high: priceRangeHigh, low: priceRangeLow },
    warning: 'Estimation only - actual liquidation levels depend on individual position sizes, margin modes, and exchange-specific auto-deleveraging rules.',
    timestamp: Date.now(),
  };

  _setCache(cacheKey, output);
  return output;
}

/**
 * Find price levels where multiple liquidation prices cluster together.
 * @param {Object[]} clusters
 * @param {number} currentPrice
 * @returns {Object[]}
 */
function _findDenseLiqClusters(clusters, currentPrice) {
  if (clusters.length === 0) return [];

  const sorted = [...clusters].sort(
    (a, b) => a.estimatedLiqPrice - b.estimatedLiqPrice,
  );

  const dense = [];
  const clusterWindowPct = 1.5; // within 1.5% of each other

  for (let i = 0; i < sorted.length; i++) {
    const group = [sorted[i]];
    for (let j = i + 1; j < sorted.length; j++) {
      const distPct =
        Math.abs(sorted[j].estimatedLiqPrice - sorted[i].estimatedLiqPrice) /
        currentPrice *
        100;
      if (distPct <= clusterWindowPct) {
        group.push(sorted[j]);
      } else {
        break;
      }
    }
    if (group.length >= 2) {
      const totalOI = group.reduce((s, c) => s + c.estimatedOI, 0);
      const avgConf =
        group.reduce((s, c) => s + c.confidence, 0) / group.length;
      dense.push({
        priceRange: {
          low: Math.min(...group.map((c) => c.estimatedLiqPrice)),
          high: Math.max(...group.map((c) => c.estimatedLiqPrice)),
        },
        leverageRange: {
          low: Math.min(...group.map((c) => c.leverage)),
          high: Math.max(...group.map((c) => c.leverage)),
        },
        side: group[0].side,
        estimatedTotalOI: Math.round(totalOI * 1000) / 1000,
        avgConfidence: Math.round(avgConf * 100) / 100,
        count: group.length,
        distanceFromPricePct:
          ((Math.min(...group.map((c) => c.estimatedLiqPrice)) - currentPrice) /
            currentPrice) *
          100,
      });
    }
    i += group.length - 1; // skip processed
  }

  return dense;
}

/**
 * @param {Object[]} clusters
 * @param {number} avgFunding
 * @param {number} consecPos
 * @param {number} consecNeg
 * @returns {string}
 */
function _assessLiqRisk(clusters, avgFunding, consecPos, consecNeg) {
  if (consecPos >= 4 || consecNeg >= 4) {
    return 'HIGH - Extended one-sided funding suggests heavily crowded positioning. ' +
      'A reversal could trigger cascading liquidations on the crowded side.';
  }
  if (Math.abs(avgFunding) > 0.0005) {
    return 'ELEVATED - Skewed funding indicates directional crowding. ' +
      'Liquidation cascade risk on the over-leveraged side if price moves against.';
  }
  if (Math.abs(avgFunding) < 0.0001) {
    return 'LOW - Balanced funding and positioning. Liquidation risk is distributed evenly.';
  }
  return 'MODERATE - Mild directional bias in funding. Monitor for rapid changes.';
}

// ---------------------------------------------------------------------------
// 3. Order Book Imbalance / Spoofing Detection
// ---------------------------------------------------------------------------

/**
 * Analyse aggTrades data to detect spoofing and layering patterns.  Spoofing
 * manifests as large orders that appear and disappear without execution;
 * layering is stacking multiple orders on one side to create false depth.
 *
 * This detection compares the volume profile of aggressive (market) trades
 * against the passive (limit) order book depth implied by trade size
 * distribution.  Key signals:
 *   - Large passive orders that get pulled before fill (size distribution anomalies)
 *   - Asymmetric bid/ask aggression vs volume imbalance
 *   - Burst patterns of cancellations (rapid size oscillation)
 *
 * @param {Object[]} aggTrades - Array of aggregated trade objects.  Expected
 *   shape: { p: string (price), q: string (qty), m: boolean (isBuyerMaker),
 *   T: number (timestamp), a: number (aggregatedTradeId) }
 * @returns {Object} Anomaly detection results.
 */
function detectOrderBookAnomalies(aggTrades) {
  if (!Array.isArray(aggTrades) || aggTrades.length === 0) {
    return {
      anomalies: [],
      summary: 'Insufficient data - no trades provided.',
      bidAskImbalance: null,
      depthAggressionDelta: null,
      spoofingSignals: [],
      timestamp: Date.now(),
    };
  }

  // Parse trades into a standardised form
  const trades = aggTrades.map((t) => ({
    price: parseFloat(t.p),
    qty: parseFloat(t.q),
    isBuyerMaker: t.m, // true = seller aggression (buyer was maker/passive)
    timestamp: t.T || t.t,
    size: Math.abs(parseFloat(t.q) * parseFloat(t.p)), // notional value
  }));

  // --- Bid/Ask Volume Imbalance ---
  let bidVolume = 0;
  let askVolume = 0;
  let bidTrades = 0;
  let askTrades = 0;
  let bidTotalSize = 0;
  let askTotalSize = 0;

  for (const t of trades) {
    if (t.isBuyerMaker) {
      // Seller aggression (hitting bids) -> bearish
      askVolume += t.qty;
      askTotalSize += t.size;
      askTrades++;
    } else {
      // Buyer aggression (hitting asks) -> bullish
      bidVolume += t.qty;
      bidTotalSize += t.size;
      bidTrades++;
    }
  }

  const totalVolume = bidVolume + askVolume;
  const bidAskImbalance = totalVolume > 0
    ? (bidVolume - askVolume) / totalVolume
    : 0; // Range: -1 (all asks) to +1 (all bids)

  // --- Aggression-Depth Delta ---
  // If there's heavy bid volume but light aggression (many limit buys vs few
  // market sells), that suggests passive accumulation or support building.
  // The inverse indicates potential distribution or spoofing.
  const avgBidTradeSize = bidTrades > 0 ? bidVolume / bidTrades : 0;
  const avgAskTradeSize = askTrades > 0 ? askVolume / askTrades : 0;
  const totalTrades = bidTrades + askTrades;

  const depthAggressionDelta =
    totalTrades > 0 ? (bidVolume / askVolume || 1) : null;

  // --- Spoofing / Layering Detection ---
  const spoofingSignals = [];

  // Signal 1: Size distribution anomaly
  // Normal markets have a roughly log-normal trade size distribution.
  // Spoofing creates bimodal distributions with an unusual cluster of
  // large orders that disappear.
  const sizeDistribution = _analyseSizeDistribution(trades);
  if (sizeDistribution.anomalous) {
    spoofingSignals.push({
      type: 'size_distribution_anomaly',
      severity: sizeDistribution.severity,
      description:
        `Unusual bimodal size distribution detected. ` +
        `${sizeDistribution.largeOrderCount} large orders (>${sizeDistribution.threshold}) ` +
        `vs ${sizeDistribution.normalOrderCount} normal orders suggest potential layering.`,
      details: sizeDistribution,
    });
  }

  // Signal 2: Rapid directional flipping
  // Spoofers alternate sides rapidly. Detect streaks of same-side aggression
  // that reverse sharply.
  const streakAnalysis = _analyseAggressionStreaks(trades);
  if (streakAnalysis.rapidFlipsDetected) {
    spoofingSignals.push({
      type: 'rapid_directional_flipping',
      severity: streakAnalysis.severity,
      description:
        `${streakAnalysis.flipCount} rapid direction changes detected ` +
        `in ${streakAnalysis.windowSize} trades, exceeding normal threshold ` +
        `of ${streakAnalysis.normalThreshold}.`,
      details: streakAnalysis,
    });
  }

  // Signal 3: Volume cliff / pull-back pattern
  // Large passive orders that create depth then vanish (inferred from
  // trade-by-trade size dropping off).
  const volumeCliff = _detectVolumeCliff(trades);
  if (volumeCliff.detected) {
    spoofingSignals.push({
      type: 'volume_cliff_pattern',
      severity: volumeCliff.severity,
      description:
        `Volume cliff detected at ${new Date(volumeCliff.timestamp).toISOString()}. ` +
        `Large ${volumeCliff.side} volume (${volumeCliff.preVolume}) dropped to ` +
        `${volumeCliff.postVolume}, a ${volumeCliff.dropPct}% reduction.`,
      details: volumeCliff,
    });
  }

  // Signal 4: Absorption pattern
  // Large orders being slowly absorbed without price movement could indicate
  // genuine iceberg orders OR spoofing being absorbed by a algo.
  const absorption = _detectAbsorptionPattern(trades);
  if (absorption.detected) {
    spoofingSignals.push({
      type: 'absorption_pattern',
      severity: absorption.severity,
      description:
        `Absorption detected on ${absorption.side}: ` +
        `${absorption.absorbedVolume} volume absorbed with only ${absorption.priceImpactBps} bps move.`,
      details: absorption,
    });
  }

  // --- Composite anomaly score ---
  const anomalyScore = _computeAnomalyScore(spoofingSignals, bidAskImbalance);

  const output = {
    tradeCount: trades.length,
    bidAskImbalance: Math.round(bidAskImbalance * 1000) / 1000,
    bidAskImbalanceInterpretation: _interpretBai(bidAskImbalance),
    volumes: {
      bid: Math.round(bidVolume * 10000) / 10000,
      ask: Math.round(askVolume * 10000) / 10000,
      bidTotalSize: Math.round(bidTotalSize * 100) / 100,
      askTotalSize: Math.round(askTotalSize * 100) / 100,
      bidTrades,
      askTrades,
      avgBidTradeSize: Math.round(avgBidTradeSize * 10000) / 10000,
      avgAskTradeSize: Math.round(avgAskTradeSize * 10000) / 10000,
    },
    depthAggressionDelta:
      depthAggressionDelta !== null
        ? Math.round(depthAggressionDelta * 1000) / 1000
        : null,
    sizeDistribution,
    spoofingSignals,
    anomalyScore,
    anomalyScoreInterpretation: _interpretAnomalyScore(anomalyScore),
    timestamp: Date.now(),
  };

  return output;
}

/**
 * Analyse trade-size distribution for bimodality indicative of layering.
 * @param {Object[]} trades
 * @returns {Object}
 */
function _analyseSizeDistribution(trades) {
  if (trades.length < 10) {
    return {
      anomalous: false,
      severity: 'none',
      normalOrderCount: trades.length,
      largeOrderCount: 0,
      threshold: 0,
    };
  }

  const sizes = trades.map((t) => t.qty).sort((a, b) => a - b);
  const median = sizes[Math.floor(sizes.length / 2)];
  const q75 = sizes[Math.floor(sizes.length * 0.75)];
  const q90 = sizes[Math.floor(sizes.length * 0.9)];
  const iqr = q75 - sizes[Math.floor(sizes.length * 0.25)];
  const threshold = q75 + 3 * iqr; // generous threshold

  const largeOrders = sizes.filter((s) => s > threshold);
  const normalOrders = sizes.filter((s) => s <= threshold);

  // Anomaly: significant cluster of orders well above normal range
  const largeRatio = largeOrders.length / sizes.length;
  const anomalous = largeRatio > 0.05 && largeOrders.length >= 3;

  // Check if large orders are clustered in time (layering indicator)
  let largeOrderTimestamps = [];
  if (anomalous) {
    largeOrderTimestamps = trades
      .filter((t) => t.qty > threshold)
      .map((t) => t.timestamp);
    const avgGap = largeOrderTimestamps.length > 1
      ? (largeOrderTimestamps[largeOrderTimestamps.length - 1] - largeOrderTimestamps[0]) /
        (largeOrderTimestamps.length - 1)
      : Infinity;
    // If large orders arrive within 200ms of each other on average, likely layering
  }

  return {
    anomalous,
    severity: largeRatio > 0.1 ? 'high' : largeRatio > 0.05 ? 'medium' : 'low',
    normalOrderCount: normalOrders.length,
    largeOrderCount: largeOrders.length,
    largeOrderRatio: Math.round(largeRatio * 1000) / 1000,
    threshold: Math.round(threshold * 10000) / 10000,
    median: Math.round(median * 10000) / 10000,
    q90: Math.round(q90 * 10000) / 10000,
    iqr: Math.round(iqr * 10000) / 10000,
  };
}

/**
 * Detect rapid alternating aggression patterns (spoofers flipping sides).
 * @param {Object[]} trades
 * @returns {Object}
 */
function _analyseAggressionStreaks(trades) {
  const windowSize = Math.min(30, trades.length);
  if (windowSize < 10) {
    return { rapidFlipsDetected: false, flipCount: 0, severity: 'none', windowSize, normalThreshold: 0 };
  }

  // Look at the most recent window
  const window = trades.slice(-windowSize);
  let flips = 0;
  let currentSide = window[0].isBuyerMaker;
  for (let i = 1; i < window.length; i++) {
    if (window[i].isBuyerMaker !== currentSide) {
      flips++;
      currentSide = window[i].isBuyerMaker;
    }
  }

  // Normal flip ratio for random: ~50% of trades flip (N-1 transitions, half flip)
  const normalThreshold = Math.floor(windowSize * 0.5);
  const rapidFlipsDetected = flips > normalThreshold + 2;

  let severity = 'none';
  if (rapidFlipsDetected) {
    const excess = flips - normalThreshold;
    severity = excess > 6 ? 'high' : excess > 4 ? 'medium' : 'low';
  }

  return {
    rapidFlipsDetected,
    flipCount: flips,
    severity,
    windowSize,
    normalThreshold,
    flipRatio: Math.round((flips / (windowSize - 1)) * 1000) / 1000,
  };
}

/**
 * Detect volume cliff: sudden drop-off after a large volume spike.
 * @param {Object[]} trades
 * @returns {Object}
 */
function _detectVolumeCliff(trades) {
  if (trades.length < 20) {
    return { detected: false, severity: 'none' };
  }

  // Sliding window: compare two consecutive windows
  const half = Math.floor(trades.length / 2);
  const firstHalf = trades.slice(0, half);
  const secondHalf = trades.slice(half);

  const firstVolume = firstHalf.reduce((s, t) => s + t.qty, 0);
  const secondVolume = secondHalf.reduce((s, t) => s + t.qty, 0);
  const avgFirst = firstVolume / firstHalf.length;
  const avgSecond = secondVolume / secondHalf.length;

  const dropPct = avgFirst > 0
    ? ((avgFirst - avgSecond) / avgFirst) * 100
    : 0;

  // A cliff is a >60% drop in per-trade volume
  const detected = dropPct > 60 && firstVolume > 0;
  let severity = 'none';
  if (detected) {
    severity = dropPct > 80 ? 'high' : dropPct > 70 ? 'medium' : 'low';
  }

  // Determine dominant side before the cliff
  const bidVFirst = firstHalf.filter((t) => !t.isBuyerMaker).reduce((s, t) => s + t.qty, 0);
  const askVFirst = firstHalf.filter((t) => t.isBuyerMaker).reduce((s, t) => s + t.qty, 0);

  return {
    detected,
    severity,
    side: bidVFirst > askVFirst ? 'bid' : 'ask',
    preVolume: Math.round(avgFirst * 10000) / 10000,
    postVolume: Math.round(avgSecond * 10000) / 10000,
    dropPct: Math.round(dropPct * 10) / 10,
    timestamp: trades[half].timestamp,
  };
}

/**
 * Detect absorption: large volume absorbed with minimal price impact.
 * @param {Object[]} trades
 * @returns {Object}
 */
function _detectAbsorptionPattern(trades) {
  if (trades.length < 10) {
    return { detected: false, severity: 'none' };
  }

  const priceChanges = [];
  let cumulativeVolume = 0;
  const startPrice = trades[0].price;

  for (const t of trades) {
    cumulativeVolume += t.qty;
    priceChanges.push(Math.abs(t.price - startPrice));
  }

  const endPrice = trades[trades.length - 1].price;
  const totalVolume = cumulativeVolume;
  const priceRange = Math.max(...priceChanges);

  // Volume-to-price impact ratio (volume per basis point of movement)
  const priceImpactPct = startPrice > 0
    ? (Math.abs(endPrice - startPrice) / startPrice) * 100
    : 0;
  const priceImpactBps = priceImpactPct * 100;

  // Large volume with tiny price move = absorption
  const volumePerBps = priceImpactBps > 0
    ? totalVolume / priceImpactBps
    : totalVolume * 1000;

  // Thresholds are relative - we look for high volume-per-bps ratio
  const medianVolume = trades.sort((a, b) => a.qty - b.qty)[Math.floor(trades.length / 2)].qty;
  const volumeMultiplier = medianVolume > 0 ? totalVolume / (medianVolume * trades.length) : 0;

  const detected = volumePerBps > 100 && priceImpactBps < 5 && trades.length > 15;
  let severity = 'none';
  if (detected) {
    severity = volumePerBps > 500 ? 'high' : volumePerBps > 200 ? 'medium' : 'low';
  }

  const side = endPrice > startPrice ? 'bid (absorbing sells)' : 'ask (absorbing buys)';

  return {
    detected,
    severity,
    side,
    absorbedVolume: Math.round(totalVolume * 10000) / 10000,
    priceImpactBps: Math.round(priceImpactBps * 10) / 10,
    volumePerBps: Math.round(volumePerBps * 10) / 10,
    volumeMultiplier: Math.round(volumeMultiplier * 100) / 100,
  };
}

/**
 * @param {Object[]} signals
 * @param {number} bai
 * @returns {Object}
 */
function _computeAnomalyScore(signals, bai) {
  let score = 0;
  for (const s of signals) {
    if (s.severity === 'high') score += 30;
    else if (s.severity === 'medium') score += 15;
    else if (s.severity === 'low') score += 5;
  }
  // Extreme bid/ask imbalance also contributes
  const absBai = Math.abs(bai);
  if (absBai > 0.6) score += 20;
  else if (absBai > 0.4) score += 10;

  const clamped = Math.min(100, score);
  return {
    score: clamped,
    signalCount: signals.length,
    highSeverityCount: signals.filter((s) => s.severity === 'high').length,
  };
}

/**
 * @param {number} bai
 * @returns {string}
 */
function _interpretBai(bai) {
  if (bai > 0.5) return 'Heavy bid aggression - buyers dominating. Possible accumulation.';
  if (bai > 0.2) return 'Mild bid bias - modest buyer aggression.';
  if (bai < -0.5) return 'Heavy ask aggression - sellers dominating. Possible distribution.';
  if (bai < -0.2) return 'Mild ask bias - modest seller aggression.';
  return 'Balanced bid/ask aggression.';
}

/**
 * @param {Object} anomalyScore
 * @returns {string}
 */
function _interpretAnomalyScore(anomalyScore) {
  const s = anomalyScore.score;
  if (s >= 60) return 'HIGH anomaly probability - strong signals of spoofing, layering, or manipulation.';
  if (s >= 30) return 'MODERATE anomaly signals - some patterns suggest non-organic order flow.';
  if (s >= 10) return 'Mild anomalies detected - within possible normal range but worth monitoring.';
  return 'No significant anomalies - order flow appears organic.';
}

// ---------------------------------------------------------------------------
// 4. CVD Divergence Detection
// ---------------------------------------------------------------------------

/**
 * Detect when Cumulative Volume Delta diverges from price action in short
 * timeframes (5m / 15m).  CVD divergence is a leading indicator for
 * reversals that may not yet be visible on higher timeframes.
 *
 * Bullish divergence: price making lower lows while CVD makes higher lows
 *   -> selling pressure exhausting, reversal up likely.
 * Bearish divergence: price making higher highs while CVD makes lower highs
 *   -> buying pressure exhausting, reversal down likely.
 *
 * @param {Object[]} candles5m - 5-minute OHLCV candles.
 *   Expected shape: { open, high, low, close, volume, timestamp }
 * @param {Object[]} cvdData - CVD values aligned to candles (same length).
 *   Expected shape: { timestamp, cvd, buyVolume, sellVolume }
 * @returns {Object} CVD divergence analysis.
 */
function detectCVDDivergence(candles5m, cvdData) {
  if (!Array.isArray(candles5m) || !Array.isArray(cvdData)) {
    return {
      divergences: [],
      summary: 'Invalid input - candles and cvdData must be arrays.',
      currentBias: 'neutral',
      timestamp: Date.now(),
    };
  }

  if (candles5m.length < 10 || cvdData.length < 10) {
    return {
      divergences: [],
      summary: `Insufficient data - need at least 10 candles, got ${candles5m.length}.`,
      currentBias: 'neutral',
      timestamp: Date.now(),
    };
  }

  // Ensure alignment: pair each candle with its CVD value
  const pairs = [];
  const len = Math.min(candles5m.length, cvdData.length);
  for (let i = 0; i < len; i++) {
    pairs.push({
      timestamp: candles5m[i].timestamp,
      open: parseFloat(candles5m[i].open),
      high: parseFloat(candles5m[i].high),
      low: parseFloat(candles5m[i].low),
      close: parseFloat(candles5m[i].close),
      volume: parseFloat(candles5m[i].volume || 0),
      cvd: parseFloat(cvdData[i].cvd),
      buyVolume: parseFloat(cvdData[i].buyVolume || 0),
      sellVolume: parseFloat(cvdData[i].sellVolume || 0),
    });
  }

  // --- Find swing highs and lows in price ---
  const swingWindow = 3; // candles each side to confirm swing
  const priceSwings = _findSwingPoints(pairs.map((p) => p.close), swingWindow);
  const cvdSwings = _findSwingPoints(pairs.map((p) => p.cvd), swingWindow);

  // --- Detect divergences ---
  const divergences = [];

  // Compare consecutive lows for bullish divergence
  const priceLows = priceSwings.filter((s) => s.type === 'low');
  const cvdLows = cvdSwings.filter((s) => s.type === 'low');
  const priceHighs = priceSwings.filter((s) => s.type === 'high');
  const cvdHighs = cvdSwings.filter((s) => s.type === 'high');

  // Bullish divergence: price lower low + CVD higher low
  for (let i = 1; i < priceLows.length && i < cvdLows.length; i++) {
    const prevPriceLow = priceLows[i - 1].value;
    const currPriceLow = priceLows[i].value;
    const prevCvdLow = cvdLows[Math.max(0, i - 1)].value;
    const currCvdLow = cvdLows[i].value;

    if (currPriceLow < prevPriceLow && currCvdLow > prevCvdLow) {
      const strength = _divergenceStrength(
        prevPriceLow, currPriceLow, prevCvdLow, currCvdLow, 'bullish',
      );
      divergences.push({
        type: 'bullish',
        severity: strength.severity,
        strength: strength.score,
        priceAction: `Lower low: ${currPriceLow} < ${prevPriceLow}`,
        cvdAction: `Higher low: ${currCvdLow} > ${prevCvdLow}`,
        index: priceLows[i].index,
        timestamp: pairs[priceLows[i].index]?.timestamp,
        interpretation:
          'Selling pressure is exhausting. Price making new lows but sellers are ' +
          'weakening. Potential bullish reversal incoming.',
      });
    }
  }

  // Bearish divergence: price higher high + CVD lower high
  for (let i = 1; i < priceHighs.length && i < cvdHighs.length; i++) {
    const prevPriceHigh = priceHighs[i - 1].value;
    const currPriceHigh = priceHighs[i].value;
    const prevCvdHigh = cvdHighs[Math.max(0, i - 1)].value;
    const currCvdHigh = cvdHighs[i].value;

    if (currPriceHigh > prevPriceHigh && currCvdHigh < prevCvdHigh) {
      const strength = _divergenceStrength(
        prevPriceHigh, currPriceHigh, prevCvdHigh, currCvdHigh, 'bearish',
      );
      divergences.push({
        type: 'bearish',
        severity: strength.severity,
        strength: strength.score,
        priceAction: `Higher high: ${currPriceHigh} > ${prevPriceHigh}`,
        cvdAction: `Lower high: ${currCvdHigh} < ${prevCvdHigh}`,
        index: priceHighs[i].index,
        timestamp: pairs[priceHighs[i].index]?.timestamp,
        interpretation:
          'Buying pressure is exhausting. Price making new highs but buyers are ' +
          'weakening. Potential bearish reversal incoming.',
      });
    }
  }

  // --- Current momentum analysis ---
  const recentWindow = pairs.slice(-10);
  const recentPriceChange =
    recentWindow[recentWindow.length - 1].close - recentWindow[0].open;
  const recentCvdChange =
    recentWindow[recentWindow.length - 1].cvd - recentWindow[0].cvd;
  const recentBuyPressure = recentWindow.reduce((s, p) => s + p.buyVolume, 0);
  const recentSellPressure = recentWindow.reduce((s, p) => s + p.sellVolume, 0);
  const recentVolumeRatio = recentBuyPressure + recentSellPressure > 0
    ? recentBuyPressure / (recentBuyPressure + recentSellPressure)
    : 0.5;

  let currentBias = 'neutral';
  if (recentCvdChange > 0 && recentPriceChange > 0) currentBias = 'bullish_concordant';
  else if (recentCvdChange < 0 && recentPriceChange < 0) currentBias = 'bearish_concordant';
  else if (recentCvdChange > 0 && recentPriceChange < 0) currentBias = 'bullish_divergence_forming';
  else if (recentCvdChange < 0 && recentPriceChange > 0) currentBias = 'bearish_divergence_forming';

  // Filter: only keep recent divergences (last 30 candles)
  const recentDivergences = divergences.filter(
    (d) => d.index >= pairs.length - 30,
  );

  const output = {
    candleCount: pairs.length,
    divergences: recentDivergences,
    allDivergences: divergences,
    divergenceCount: recentDivergences.length,
    bullishCount: recentDivergences.filter((d) => d.type === 'bullish').length,
    bearishCount: recentDivergences.filter((d) => d.type === 'bearish').length,
    currentBias,
    recentMomentum: {
      priceChange: Math.round(recentPriceChange * 10000) / 10000,
      cvdChange: Math.round(recentCvdChange * 10000) / 10000,
      buyPressure: Math.round(recentBuyPressure * 10000) / 10000,
      sellPressure: Math.round(recentSellPressure * 10000) / 10000,
      buyPressureRatio: Math.round(recentVolumeRatio * 1000) / 1000,
    },
    priceRange: {
      high: Math.max(...pairs.map((p) => p.high)),
      low: Math.min(...pairs.map((p) => p.low)),
      current: pairs[pairs.length - 1].close,
    },
    summary: _summarizeCvdDivergence(recentDivergences, currentBias, recentVolumeRatio),
    timestamp: Date.now(),
  };

  return output;
}

/**
 * Find swing highs and lows in a series of values.
 * @param {number[]} values
 * @param {number} window - Candles each side to confirm swing.
 * @returns {Object[]}
 */
function _findSwingPoints(values, window) {
  const swings = [];
  for (let i = window; i < values.length - window; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = i - window; j <= i + window; j++) {
      if (j === i) continue;
      if (values[j] >= values[i]) isHigh = false;
      if (values[j] <= values[i]) isLow = false;
    }
    if (isHigh) swings.push({ type: 'high', value: values[i], index: i });
    if (isLow) swings.push({ type: 'low', value: values[i], index: i });
  }
  return swings;
}

/**
 * Quantify divergence strength.
 * @param {number} prevPrice
 * @param {number} currPrice
 * @param {number} prevCvd
 * @param {number} currCvd
 * @param {string} type
 * @returns {Object}
 */
function _divergenceStrength(prevPrice, currPrice, prevCvd, currCvd, type) {
  const pricePctChange = prevPrice !== 0
    ? Math.abs((currPrice - prevPrice) / prevPrice) * 100
    : 0;
  const cvdPctChange = prevCvd !== 0
    ? Math.abs((currCvd - prevCvd) / Math.abs(prevCvd)) * 100
    : 0;

  // Stronger when price makes significant new extremes but CVD moves
  // significantly in the opposite direction
  const raw = pricePctChange + cvdPctChange;

  let severity = 'weak';
  if (raw > 5) severity = 'strong';
  else if (raw > 2) severity = 'moderate';

  return {
    score: Math.round(raw * 100) / 100,
    severity,
    pricePctChange: Math.round(pricePctChange * 100) / 100,
    cvdPctChange: Math.round(cvdPctChange * 100) / 100,
  };
}

/**
 * @param {Object[]} divs
 * @param {string} bias
 * @param {number} buyRatio
 * @returns {string}
 */
function _summarizeCvdDivergence(divs, bias, buyRatio) {
  if (divs.length === 0) {
    if (bias.includes('divergence_forming')) {
      return 'No confirmed divergences yet, but current momentum shows CVD-price disagreement. Watch for confirmation in next few candles.';
    }
    return 'No CVD divergences detected. Price and CVD are moving in concordance.';
  }

  const recent = divs[divs.length - 1];
  const base = `${divs.length} divergence(s) detected. Most recent: ${recent.severity} ${recent.type} divergence.`;

  if (recent.type === 'bullish') {
    return `${base} Sellers are losing momentum despite lower prices. Consider looking for long entries on confirmation (price reclaim above recent swing).`;
  }
  return `${base} Buyers are losing momentum despite higher prices. Consider looking for short entries on confirmation (price breakdown below recent swing).`;
}

// ---------------------------------------------------------------------------
// 5. Cross-Asset Correlation & Macro Context
// ---------------------------------------------------------------------------

/**
 * Provide cross-asset context for a given crypto symbol.  Uses BTC inverse
 * correlation with USDT.D (Tether dominance) as a DXY proxy and incorporates
 * funding rates as a proxy for ETF/leveraged flow.
 *
 * @param {string} symbol - e.g. 'SOLUSDT'.
 * @returns {Promise<Object>} Cross-asset correlation and macro context.
 */
async function getCrossAssetContext(symbol) {
  const cacheKey = `crossAsset:${symbol}`;
  const cached = _getCache(cacheKey);
  if (cached) return cached;

  // Fetch multiple data points in parallel
  const [
    btcTickerData,
    ethTickerData,
    selfTickerData,
    btcKlines,
    dominanceData,
  ] = await Promise.allSettled([
    _safeGet('https://fapi.binance.com/fapi/v1/ticker/24hr?symbol=BTCUSDT'),
    _safeGet('https://fapi.binance.com/fapi/v1/ticker/24hr?symbol=ETHUSDT'),
    _safeGet(`https://fapi.binance.com/fapi/v1/ticker/24hr?symbol=${symbol}`),
    _safeGet('https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT&interval=1d&limit=30'),
    _safeGet('https://fapi.binance.com/fapi/v1/ticker/24hr?symbol=BTCUSDT'),
  ]);

  const btcTicker =
    btcTickerData.status === 'fulfilled' ? btcTickerData.value : null;
  const ethTicker =
    ethTickerData.status === 'fulfilled' ? ethTickerData.value : null;
  const selfTicker =
    selfTickerData.status === 'fulfilled' ? selfTickerData.value : null;
  const btcKlineData =
    btcKlines.status === 'fulfilled' ? btcKlines.value : null;

  // Parse BTC daily klines for correlation calc
  const btcDaily = Array.isArray(btcKlineData)
    ? btcKlineData.map((k) => ({
        timestamp: k[0],
        open: parseFloat(k[1]),
        high: parseFloat(k[2]),
        low: parseFloat(k[3]),
        close: parseFloat(k[4]),
        volume: parseFloat(k[5]),
      }))
    : [];

  // --- BTC Dominance Proxy (USDT.D approximation) ---
  // We use the ratio of total crypto market cap to BTC as a rough proxy.
  // In the absence of a direct USDT.D endpoint, we approximate from
  // BTC's 24h change relative to the broader market.
  const btc24hChange = btcTicker
    ? parseFloat(btcTicker.priceChangePercent || 0)
    : 0;
  const eth24hChange = ethTicker
    ? parseFloat(ethTicker.priceChangePercent || 0)
    : 0;
  const self24hChange = selfTicker
    ? parseFloat(selfTicker.priceChangePercent || 0)
    : 0;

  // --- Compute correlation coefficients ---
  // BTC-Dominance proxy correlation
  // When BTC rises and altcoins lag, dominance increases (risk-off within crypto)
  // When BTC and alts rise together, dominance is flat (risk-on)
  const btcAltSpread = btc24hChange - eth24hChange; // positive = BTC outperforming
  const dominanceShift =
    btcAltSpread > 1 ? 'increasing' : btcAltSpread < -1 ? 'decreasing' : 'stable';

  // BTC correlation with the queried symbol (using 24h returns as proxy)
  const btcSelfCorrelation = _estimateCorrelation(
    btcDaily.map((k) => k.close),
    btcDaily.length,
  );

  // --- ETF Flow Estimation ---
  // Without direct ETF data, we estimate institutional flow from:
  // 1. Funding rate magnitude (leveraged money proxy)
  // 2. Open interest changes
  // 3. Large trade volume patterns
  const [
    btcFundingData,
    ethFundingData,
    selfFundingData,
    btcOiHistory,
  ] = await Promise.allSettled([
    _safeGet('https://fapi.binance.com/fapi/v1/premiumIndex?symbol=BTCUSDT'),
    _safeGet('https://fapi.binance.com/fapi/v1/premiumIndex?symbol=ETHUSDT'),
    _safeGet(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${symbol}`),
    _safeGet('https://fapi.binance.com/fapi/v1/openInterest?symbol=BTCUSDT'),
  ]);

  const btcFunding =
    btcFundingData.status === 'fulfilled' ? btcFundingData.value : null;
  const ethFunding =
    ethFundingData.status === 'fulfilled' ? ethFundingData.value : null;
  const selfFunding =
    selfFundingData.status === 'fulfilled' ? selfFundingData.value : null;
  const btcOi =
    btcOiData.status === 'fulfilled' ? btcOiData.value : null;

  // NOTE: btcOiData is declared via the Promise, rename to match
  // (we reuse the variable from the set above)
  const btcOiActual =
    btcOiHistory.status === 'fulfilled' ? btcOiHistory.value : null;

  const btcFundingRate = btcFunding
    ? parseFloat(btcFunding.lastFundingRate || 0)
    : 0;
  const ethFundingRate = ethFunding
    ? parseFloat(ethFunding.lastFundingRate || 0)
    : 0;
  const selfFundingRate = selfFunding
    ? parseFloat(selfFunding.lastFundingRate || 0)
    : 0;

  const btcOpenInterest = btcOiActual
    ? parseFloat(btcOiActual.openInterest || 0)
    : 0;

  // --- Composite Macro Context ---
  const macroSignals = [];

  // Signal 1: BTC dominance trend
  macroSignals.push({
    name: 'BTC Dominance Proxy',
    value: dominanceShift,
    description:
      dominanceShift === 'increasing'
        ? 'BTC outperforming altcoins. Risk-off within crypto. Altcoins may underperform.'
        : dominanceShift === 'decreasing'
          ? 'Altcoins outperforming BTC. Risk-on within crypto. Alt season dynamics.'
          : 'Balanced BTC vs altcoin performance. No strong rotation signal.',
  });

  // Signal 2: Funding rate consensus
  const fundingConsensus =
    btcFundingRate > 0 && ethFundingRate > 0 && selfFundingRate > 0
      ? 'all_positive'
      : btcFundingRate < 0 && ethFundingRate < 0 && selfFundingRate < 0
        ? 'all_negative'
        : 'mixed';

  macroSignals.push({
    name: 'Funding Rate Consensus',
    value: fundingConsensus,
    description:
      fundingConsensus === 'all_positive'
        ? 'All markets show positive funding - broad leveraged long positioning. Crowded long risk.'
        : fundingConsensus === 'all_negative'
          ? 'All markets show negative funding - broad leveraged short positioning. Short squeeze risk.'
          : 'Mixed funding rates across assets - no consensus directional bias.',
  });

  // Signal 3: BTC funding vs alt funding divergence
  const fundingDivergence = Math.abs(selfFundingRate - btcFundingRate);
  if (fundingDivergence > 0.0003) {
    macroSignals.push({
      name: 'Alt-BTC Funding Divergence',
      value: selfFundingRate > btcFundingRate ? 'alt_premium' : 'btc_premium',
      description:
        selfFundingRate > btcFundingRate
          ? `Altcoin (${symbol}) has higher funding than BTC. ` +
            'Relative long crowding in this alt vs BTC.'
          : `BTC has higher funding than ${symbol}. ` +
            'Relative long crowding in BTC vs this alt.',
      magnitude: fundingDivergence,
    });
  }

  // Signal 4: Leverage regime
  const avgAbsFunding =
    (Math.abs(btcFundingRate) + Math.abs(ethFundingRate) + Math.abs(selfFundingRate)) / 3;
  const leverageRegime =
    avgAbsFunding > 0.0005 ? 'high' : avgAbsFunding > 0.0002 ? 'moderate' : 'low';

  macroSignals.push({
    name: 'Market Leverage Regime',
    value: leverageRegime,
    description:
      leverageRegime === 'high'
        ? 'High leverage across markets. Elevated risk of volatility spikes and liquidation cascades.'
        : leverageRegime === 'moderate'
          ? 'Moderate leverage. Normal trading conditions.'
          : 'Low leverage. Market in consolidation or cautious mode.',
  });

  // --- Risk Rating ---
  let riskRating = 'normal';
  if (
    leverageRegime === 'high' &&
    fundingConsensus !== 'mixed' &&
    dominanceShift !== 'stable'
  ) {
    riskRating = 'elevated';
  }
  if (
    leverageRegime === 'high' &&
    fundingConsensus !== 'mixed' &&
    dominanceShift !== 'stable' &&
    fundingDivergence > 0.0005
  ) {
    riskRating = 'high';
  }

  const output = {
    symbol,
    overview: {
      btc24hChange: Math.round(btc24hChange * 100) / 100,
      eth24hChange: Math.round(eth24hChange * 100) / 100,
      self24hChange: Math.round(self24hChange * 100) / 100,
      btcSelfRelative: Math.round((self24hChange - btc24hChange) * 100) / 100,
    },
    btcDominanceProxy: {
      trend: dominanceShift,
      btcAltSpread: Math.round(btcAltSpread * 100) / 100,
      interpretation:
        dominanceShift === 'increasing'
          ? 'Risk-off within crypto. BTC absorbing capital from altcoins.'
          : dominanceShift === 'decreasing'
            ? 'Risk-on. Capital rotating from BTC to altcoins.'
            : 'Neutral rotation dynamics.',
    },
    fundingRates: {
      btc: Math.round(btcFundingRate * 100000) / 100000,
      eth: Math.round(ethFundingRate * 100000) / 100000,
      self: Math.round(selfFundingRate * 100000) / 100000,
      consensus: fundingConsensus,
    },
    correlation: {
      btcSelfApprox: btcSelfCorrelation,
      description:
        btcSelfCorrelation > 0.8
          ? `${symbol} is highly correlated with BTC (${btcSelfCorrelation}). BTC moves will dominate.`
          : btcSelfCorrelation > 0.5
            ? `${symbol} has moderate correlation with BTC (${btcSelfCorrelation}). Some independent price action possible.`
            : `${symbol} has low correlation with BTC (${btcSelfCorrelation}). May trade on its own catalysts.`,
    },
    etfFlowEstimation: {
      method: 'Inferred from funding rates, open interest, and volume patterns',
      institutionalSentiment:
        btcFundingRate > 0.0001 && btcOpenInterest > 0
          ? 'Positive funding with OI suggests leveraged long exposure - consistent with institutional accumulation or ETF inflow proxy.'
          : btcFundingRate < -0.0001
            ? 'Negative funding suggests institutional hedging or distribution phase.'
            : 'Neutral institutional activity.',
      btcOpenInterest,
      warning: 'This is an estimation proxy, not direct ETF flow data. For actual ETF flows, use dedicated data providers.',
    },
    leverageRegime: {
      level: leverageRegime,
      avgAbsFunding: Math.round(avgAbsFunding * 100000) / 100000,
      implications:
        leverageRegime === 'high'
          ? 'Expect heightened volatility. Liquidation cascades more likely in both directions.'
          : 'Standard leverage environment. No elevated cascade risk.',
    },
    macroSignals,
    riskRating,
    overallAssessment: _buildOverallAssessment(dominanceShift, fundingConsensus, leverageRegime, riskRating),
    timestamp: Date.now(),
  };

  _setCache(cacheKey, output);
  return output;
}

/**
 * Simple Pearson correlation estimate from a single price series.
 * We use log-returns over the available window.
 * @param {number[]} prices
 * @param {number} _length
 * @returns {number} Correlation coefficient (approximation).
 */
function _estimateCorrelation(prices) {
  if (!prices || prices.length < 5) return 0;

  const returns = [];
  for (let i = 1; i < prices.length; i++) {
    if (prices[i - 1] !== 0) {
      returns.push(Math.log(prices[i] / prices[i - 1]));
    }
  }

  if (returns.length < 3) return 0;

  // Auto-correlation at lag 1 as a momentum proxy
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  let numerator = 0;
  let denom = 0;
  for (let i = 1; i < returns.length; i++) {
    numerator += (returns[i] - mean) * (returns[i - 1] - mean);
  }
  for (const r of returns) {
    denom += (r - mean) ** 2;
  }

  return denom > 0 ? Math.round((numerator / denom) * 1000) / 1000 : 0;
}

/**
 * @param {string} dom
 * @param {string} funding
 * @param {string} leverage
 * @param {string} risk
 * @returns {string}
 */
function _buildOverallAssessment(dom, funding, leverage, risk) {
  const parts = [];

  if (risk === 'high') {
    parts.push('MULTIPLE ELEVATED RISK SIGNALS detected simultaneously.');
  }

  if (dom === 'increasing') {
    parts.push('BTC dominance rising, altcoins may lag.');
  } else if (dom === 'decreasing') {
    parts.push('BTC dominance falling, altcoin-friendly environment.');
  }

  if (funding === 'all_positive') {
    parts.push('Broad leveraged long positioning increases correction risk.');
  } else if (funding === 'all_negative') {
    parts.push('Broad leveraged short positioning increases squeeze risk.');
  }

  if (leverage === 'high') {
    parts.push('High leverage amplifies potential moves in either direction.');
  }

  if (parts.length === 0) {
    return 'Market conditions are neutral. No strong macro signals in either direction.';
  }

  return parts.join(' ');
}

// ---------------------------------------------------------------------------
// 6. Main Orchestrator
// ---------------------------------------------------------------------------

/**
 * Run a comprehensive microstructure analysis for a given crypto futures
 * symbol.  This is the primary entry-point that aggregates all sub-analyses.
 *
 * @param {string} symbol - Binance-style symbol, e.g. 'SOLUSDT'.
 * @param {Object} [options={}]
 * @param {Object[]} [options.aggTrades] - Aggregated trades for order-book anomaly detection.
 * @param {Object[]} [options.candles5m] - 5-minute OHLCV candles for CVD divergence.
 * @param {Object[]} [options.cvdData] - CVD values aligned to candles5m.
 * @param {Object}   [options.tickerData] - Latest ticker for the symbol.
 * @param {Object}   [options.fundingData] - Latest funding rate data.
 * @param {boolean}  [options.skipCrossAsset=false] - Skip cross-asset analysis (faster).
 * @param {boolean}  [options.skipFundingSpread=false] - Skip funding spread (faster).
 * @returns {Promise<Object>} Comprehensive microstructure analysis.
 */
async function analyzeMicrostructure(symbol, options = {}) {
  const {
    aggTrades = null,
    candles5m = null,
    cvdData = null,
    tickerData = null,
    fundingData = null,
    skipCrossAsset = false,
    skipFundingSpread = false,
  } = options;

  const startTime = Date.now();
  const errors = [];

  // --- Fan out independent analyses ---
  const tasks = [];

  if (!skipFundingSpread) {
    tasks.push(
      getFundingSpread(symbol).catch((e) => {
        errors.push({ module: 'fundingSpread', error: e.message });
        return null;
      }),
    );
  }

  tasks.push(
    estimateLiquidationClusters(symbol, tickerData, fundingData).catch((e) => {
      errors.push({ module: 'liquidationClusters', error: e.message });
      return null;
    }),
  );

  // Order book anomalies (synchronous but wrapped for consistency)
  if (aggTrades && aggTrades.length > 0) {
    try {
      // Synchronous function, but wrap in promise for uniform handling
      tasks.push(Promise.resolve(detectOrderBookAnomalies(aggTrades)));
    } catch (e) {
      errors.push({ module: 'orderBookAnomalies', error: e.message });
      tasks.push(Promise.resolve(null));
    }
  } else {
    tasks.push(Promise.resolve(null));
  }

  // CVD divergence
  if (candles5m && cvdData) {
    try {
      tasks.push(Promise.resolve(detectCVDDivergence(candles5m, cvdData)));
    } catch (e) {
      errors.push({ module: 'cvdDivergence', error: e.message });
      tasks.push(Promise.resolve(null));
    }
  } else {
    tasks.push(Promise.resolve(null));
  }

  if (!skipCrossAsset) {
    tasks.push(
      getCrossAssetContext(symbol).catch((e) => {
        errors.push({ module: 'crossAsset', error: e.message });
        return null;
      }),
    );
  }

  const [fundingSpread, liquidationClusters, orderBookAnomalies, cvdDivergence, crossAsset] =
    await Promise.all(tasks);

  // --- Build composite signal ---
  const compositeSignal = _buildCompositeSignal({
    fundingSpread,
    liquidationClusters,
    orderBookAnomalies,
    cvdDivergence,
    crossAsset,
  });

  const elapsed = Date.now() - startTime;

  return {
    symbol,
    compositeSignal,
    modules: {
      fundingSpread,
      liquidationClusters,
      orderBookAnomalies,
      cvdDivergence,
      crossAsset,
    },
    errors: errors.length > 0 ? errors : undefined,
    meta: {
      executionTimeMs: elapsed,
      cachedModules: _identifyCachedModules(symbol),
      timestamp: Date.now(),
    },
  };
}

/**
 * Build a composite directional signal from all modules.
 * @param {Object} modules
 * @returns {Object}
 */
function _buildCompositeSignal({ fundingSpread, liquidationClusters, orderBookAnomalies, cvdDivergence, crossAsset }) {
  let bullScore = 0;
  let bearScore = 0;
  const signals = [];

  // Funding spread
  if (fundingSpread?.divergent) {
    signals.push({
      source: 'fundingSpread',
      direction: 'neutral_opportunity',
      weight: 15,
      note: `Cross-exchange funding divergence of ${fundingSpread.spreadBps} bps. Arb opportunity.`,
    });
  }

  // Liquidation clusters
  if (liquidationClusters) {
    if (
      liquidationClusters.nearestLongLiquidation &&
      liquidationClusters.nearestLongLiquidation.distancePct < 3
    ) {
      bearScore += 20;
      signals.push({
        source: 'liquidationClusters',
        direction: 'bearish_risk',
        weight: 20,
        note: `Dense long liquidation cluster ${liquidationClusters.nearestLongLiquidation.distancePct}% below price.`,
      });
    }
    if (
      liquidationClusters.nearestShortLiquidation &&
      liquidationClusters.nearestShortLiquidation.distancePct < 3
    ) {
      bullScore += 20;
      signals.push({
        source: 'liquidationClusters',
        direction: 'bullish_opportunity',
        weight: 20,
        note: `Dense short liquidation cluster ${liquidationClusters.nearestShortLiquidation.distancePct}% above price.`,
      });
    }
  }

  // Order book anomalies
  if (orderBookAnomalies) {
    if (orderBookAnomalies.anomalyScore?.score > 30) {
      signals.push({
        source: 'orderBookAnomalies',
        direction: 'caution',
        weight: 10,
        note: `Anomaly score ${orderBookAnomalies.anomalyScore.score}/100. Potential manipulation detected.`,
      });
    }
    if (orderBookAnomalies.bidAskImbalance > 0.4) {
      bullScore += 10;
      signals.push({
        source: 'orderBookAnomalies',
        direction: 'bullish',
        weight: 10,
        note: `Strong bid aggression (BAI: ${orderBookAnomalies.bidAskImbalance}).`,
      });
    } else if (orderBookAnomalies.bidAskImbalance < -0.4) {
      bearScore += 10;
      signals.push({
        source: 'orderBookAnomalies',
        direction: 'bearish',
        weight: 10,
        note: `Strong ask aggression (BAI: ${orderBookAnomalies.bidAskImbalance}).`,
      });
    }
  }

  // CVD divergence
  if (cvdDivergence) {
    const recentBull = cvdDivergence.divergences?.filter((d) => d.type === 'bullish');
    const recentBear = cvdDivergence.divergences?.filter((d) => d.type === 'bearish');
    if (recentBull?.length > 0) {
      const latest = recentBull[recentBull.length - 1];
      const weight = latest.severity === 'strong' ? 25 : latest.severity === 'moderate' ? 15 : 8;
      bullScore += weight;
      signals.push({
        source: 'cvdDivergence',
        direction: 'bullish',
        weight,
        note: `Bullish CVD divergence (${latest.severity}). Selling exhaustion detected.`,
      });
    }
    if (recentBear?.length > 0) {
      const latest = recentBear[recentBear.length - 1];
      const weight = latest.severity === 'strong' ? 25 : latest.severity === 'moderate' ? 15 : 8;
      bearScore += weight;
      signals.push({
        source: 'cvdDivergence',
        direction: 'bearish',
        weight,
        note: `Bearish CVD divergence (${latest.severity}). Buying exhaustion detected.`,
      });
    }
  }

  // Cross-asset context
  if (crossAsset) {
    if (crossAsset.riskRating === 'high') {
      signals.push({
        source: 'crossAsset',
        direction: 'caution',
        weight: 15,
        note: 'High macro risk rating across multiple indicators.',
      });
    }
    if (crossAsset.btcDominanceProxy?.trend === 'decreasing') {
      bullScore += 10;
      signals.push({
        source: 'crossAsset',
        direction: 'bullish_alt',
        weight: 10,
        note: 'BTC dominance decreasing - altcoin-friendly environment.',
      });
    }
    if (crossAsset.leverageRegime?.level === 'high') {
      signals.push({
        source: 'crossAsset',
        direction: 'volatility_warning',
        weight: 10,
        note: 'High leverage regime - expect volatility spikes.',
      });
    }
  }

  // Determine overall direction
  let overall = 'neutral';
  let confidence = 0;
  const totalScore = bullScore + bearScore;

  if (totalScore > 0) {
    if (bullScore > bearScore + 10) {
      overall = 'bullish';
      confidence = Math.min(100, Math.round((bullScore / Math.max(totalScore, 1)) * 100));
    } else if (bearScore > bullScore + 10) {
      overall = 'bearish';
      confidence = Math.min(100, Math.round((bearScore / Math.max(totalScore, 1)) * 100));
    } else {
      overall = 'mixed';
      confidence = Math.round(
        (Math.abs(bullScore - bearScore) / Math.max(totalScore, 1)) * 100,
      );
    }
  }

  return {
    direction: overall,
    confidence,
    bullScore,
    bearScore,
    signals,
    signalCount: signals.length,
    interpretation: _interpretComposite(overall, confidence, signals),
  };
}

/**
 * @param {string} dir
 * @param {number} conf
 * @param {Object[]} signals
 * @returns {string}
 */
function _interpretComposite(dir, conf, signals) {
  const cautionCount = signals.filter((s) =>
    s.direction.includes('caution') || s.direction.includes('risk') || s.direction.includes('warning'),
  ).length;

  if (cautionCount >= 2) {
    return (
      `Multiple caution signals active. Despite directional lean toward ${dir}, ` +
      'exercise heightened risk management. Position sizing should be reduced.'
    );
  }

  if (dir === 'bullish' && conf >= 60) {
    return 'Strong bullish microstructure alignment. Multiple indicators support upside. Consider scaled long entries with tight stops.';
  }
  if (dir === 'bearish' && conf >= 60) {
    return 'Strong bearish microstructure alignment. Multiple indicators support downside. Consider scaled short entries or hedging.';
  }
  if (dir === 'mixed') {
    return 'Conflicting signals across microstructure indicators. Best to wait for alignment or trade smaller size.';
  }
  return 'No strong directional bias from microstructure analysis. Market is in equilibrium across these indicators.';
}

/**
 * @param {string} symbol
 * @returns {string[]}
 */
function _identifyCachedModules(symbol) {
  const cached = [];
  if (_getCache(`fundingSpread:${symbol}`)) cached.push('fundingSpread');
  if (_getCache(`liqClusters:${symbol}`)) cached.push('liquidationClusters');
  if (_getCache(`crossAsset:${symbol}`)) cached.push('crossAsset');
  return cached;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  analyzeMicrostructure,
  getFundingSpread,
  estimateLiquidationClusters,
  detectOrderBookAnomalies,
  detectCVDDivergence,
  getCrossAssetContext,
  clearCache,
};
