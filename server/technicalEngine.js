const finite = value => Number.isFinite(Number(value));
const { DEFAULT_STRATEGY_CONFIG } = require('./strategyConfig');
const closes = candles => (candles || []).map(c => Number(c.close)).filter(Number.isFinite);
const closedCandles = (candles, cutoff = Date.now()) => (candles || []).filter(candle => !finite(candle.closeTime) || Number(candle.closeTime) <= cutoff);

// ─── Memoization cache for expensive indicator calculations ──
const _indicatorCache = new Map();
const MAX_INDICATOR_CACHE = 200;

function _cacheKey(arr, label) {
  // Use length + first/last values as a fast hash for candle arrays
  if (!arr || !arr.length) return label + ':empty';
  const last = arr[arr.length - 1];
  return label + ':' + arr.length + ':' + (last.time || last.close || last) + ':' + arr[0].close;
}

function _memoized(label, fn, ...args) {
  const key = _cacheKey(args[0], label);
  if (_indicatorCache.has(key)) return _indicatorCache.get(key);
  const result = fn(...args);
  if (_indicatorCache.size >= MAX_INDICATOR_CACHE) {
    // Evict oldest entries
    const iter = _indicatorCache.keys();
    for (let i = 0; i < 50; i++) { const k = iter.next().value; if (k) _indicatorCache.delete(k); }
  }
  _indicatorCache.set(key, result);
  return result;
}

function clearIndicatorCache() { _indicatorCache.clear(); }

function ema(values, period) {
  if (!Array.isArray(values) || values.length < period) return null;
  let value = values.slice(0, period).reduce((sum, item) => sum + item, 0) / period;
  const multiplier = 2 / (period + 1);
  for (let i = period; i < values.length; i += 1) value = ((values[i] - value) * multiplier) + value;
  return value;
}

function emaSeries(values, period) {
  if (!Array.isArray(values) || values.length < period) return [];
  const result = new Array(period - 1).fill(null);
  let value = values.slice(0, period).reduce((sum, item) => sum + item, 0) / period;
  result.push(value);
  const multiplier = 2 / (period + 1);
  for (let i = period; i < values.length; i += 1) { value = ((values[i] - value) * multiplier) + value; result.push(value); }
  return result;
}

function rsi(values, period = 14) {
  if (!Array.isArray(values) || values.length <= period) return null;
  let gains = 0; let losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  let avgGain = gains / period; let avgLoss = losses / period;
  for (let i = period + 1; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    const currentGain = diff >= 0 ? diff : 0;
    const currentLoss = diff < 0 ? -diff : 0;
    avgGain = ((avgGain * (period - 1)) + currentGain) / period;
    avgLoss = ((avgLoss * (period - 1)) + currentLoss) / period;
  }
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  return 100 - (100 / (1 + (avgGain / avgLoss)));
}

function atr(candles, period = 14) {
  if (!Array.isArray(candles) || candles.length <= period) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const high = Number(candles[i].high);
    const low = Number(candles[i].low);
    const prevClose = Number(candles[i - 1].close);
    trs.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
  }
  let sum = 0;
  for (let i = 0; i < period; i++) sum += trs[i];
  let currentAtr = sum / period;
  for (let i = period; i < trs.length; i++) {
    currentAtr = ((currentAtr * (period - 1)) + trs[i]) / period;
  }
  return currentAtr;
}

function adx(candles, period = 14) {
  if (!Array.isArray(candles) || candles.length < period * 2 + 1) return null;
  const tr = []; const plusDm = []; const minusDm = [];
  for (let i = 1; i < candles.length; i += 1) {
    const up = Number(candles[i].high) - Number(candles[i - 1].high); const down = Number(candles[i - 1].low) - Number(candles[i].low);
    tr.push(Math.max(Number(candles[i].high) - Number(candles[i].low), Math.abs(Number(candles[i].high) - Number(candles[i - 1].close)), Math.abs(Number(candles[i].low) - Number(candles[i - 1].close))));
    plusDm.push(up > down && up > 0 ? up : 0); minusDm.push(down > up && down > 0 ? down : 0);
  }
  const dx = [];
  for (let end = period; end <= tr.length; end += 1) {
    const start = end - period; const trSum = tr.slice(start, end).reduce((a, b) => a + b, 0);
    if (!trSum) continue;
    const plus = plusDm.slice(start, end).reduce((a, b) => a + b, 0) / trSum * 100; const minus = minusDm.slice(start, end).reduce((a, b) => a + b, 0) / trSum * 100;
    if (plus + minus) dx.push(Math.abs(plus - minus) / (plus + minus) * 100);
  }
  return dx.length >= period ? dx.slice(-period).reduce((a, b) => a + b, 0) / period : null;
}

function macd(values) {
  const fast = emaSeries(values, 12); const slow = emaSeries(values, 26);
  const line = values.map((_, index) => finite(fast[index]) && finite(slow[index]) ? fast[index] - slow[index] : null);
  const valid = line.filter(finite).map(Number); const macdValue = valid.length ? valid[valid.length - 1] : null; const signal = ema(valid, 9);
  return { macd: macdValue, signal, histogram: finite(macdValue) && finite(signal) ? macdValue - signal : null };
}

function bollinger(values, period = 20, deviations = 2) {
  if (!Array.isArray(values) || values.length < period) return { middle: null, upper: null, lower: null, widthPercent: null };
  const window = values.slice(-period); const middle = window.reduce((sum, item) => sum + item, 0) / period;
  const standardDeviation = Math.sqrt(window.reduce((sum, item) => sum + ((item - middle) ** 2), 0) / period);
  const upper = middle + standardDeviation * deviations; const lower = middle - standardDeviation * deviations;
  return { middle, upper, lower, widthPercent: middle ? ((upper - lower) / middle) * 100 : null };
}

function findConfirmedPivots(candles, period = 2) {
  if (!Array.isArray(candles) || candles.length < period * 2 + 1) return { highs: [], lows: [] };
  const highs = []; const lows = [];
  for (let i = period; i < candles.length - period; i++) {
    const currentHigh = Number(candles[i].high);
    const currentLow = Number(candles[i].low);
    let isHigh = true; let isLow = true;
    for (let j = 1; j <= period; j++) {
      if (Number(candles[i - j].high) >= currentHigh || Number(candles[i + j].high) >= currentHigh) isHigh = false;
      if (Number(candles[i - j].low) <= currentLow || Number(candles[i + j].low) <= currentLow) isLow = false;
    }
    if (isHigh) highs.push({ price: currentHigh, time: candles[i].time });
    if (isLow) lows.push({ price: currentLow, time: candles[i].time });
  }
  return { highs, lows };
}

function getStructuralZones(candles, period = 2, tolerancePercent = 0.5) {
  const { highs, lows } = findConfirmedPivots(candles, period);
  const cluster = (pivots) => {
    const zones = [];
    pivots.sort((a, b) => a.price - b.price);
    if (!pivots.length) return zones;
    let currentZone = { min: pivots[0].price, max: pivots[0].price, count: 1 };
    for (let i = 1; i < pivots.length; i++) {
      const p = pivots[i].price;
      if (p <= currentZone.max * (1 + tolerancePercent / 100)) {
        currentZone.max = p;
        currentZone.count++;
      } else {
        zones.push(currentZone);
        currentZone = { min: p, max: p, count: 1 };
      }
    }
    zones.push(currentZone);
    return zones.sort((a, b) => b.count - a.count);
  };
  return { resistanceZones: cluster(highs), supportZones: cluster(lows) };
}

function marketStructure(candles, lookback = 5) {
  if (!Array.isArray(candles) || candles.length < lookback * 2) return 'NEUTRA';
  const recent = candles.slice(-lookback); const previous = candles.slice(-(lookback * 2), -lookback);
  const rh = Math.max(...recent.map(c => Number(c.high))); const rl = Math.min(...recent.map(c => Number(c.low)));
  const ph = Math.max(...previous.map(c => Number(c.high))); const pl = Math.min(...previous.map(c => Number(c.low)));
  if (rh > ph && rl > pl) return 'ALTA';
  if (rh < ph && rl < pl) return 'BAIXA';
  return 'LATERAL';
}

function calculateCVD(trades = []) {
  let netDelta = 0; let buyVolume = 0; let sellVolume = 0; const deltaHistory = [];
  trades.forEach(trade => { const quantity = Number(trade.q) || 0; if (trade.m) sellVolume += quantity; else buyVolume += quantity; netDelta += trade.m ? -quantity : quantity; deltaHistory.push(netDelta); });
  return { currentCVD: netDelta, netDelta, buyVolume, sellVolume, deltaHistory };
}

function calculateVolumeProfile(trades = [], binCount = 50) {
  if (!trades.length) return { poc: 0, valueAreaHigh: 0, valueAreaLow: 0, bins: [] };
  const prices = trades.map(t => Number(t.p)).filter(Number.isFinite); const minPrice = Math.min(...prices); const maxPrice = Math.max(...prices); const range = maxPrice - minPrice;
  if (range === 0) return { poc: minPrice, valueAreaHigh: minPrice, valueAreaLow: minPrice, bins: [{ price: minPrice, volume: trades.reduce((sum, t) => sum + Number(t.q || 0), 0) }] };
  const binSize = range / binCount; const bins = Array.from({ length: binCount }, (_, index) => ({ price: minPrice + ((index + 0.5) * binSize), volume: 0 }));
  trades.forEach(trade => { const index = Math.min(Math.max(Math.floor((Number(trade.p) - minPrice) / binSize), 0), binCount - 1); bins[index].volume += Number(trade.q) || 0; });
  const totalVolume = bins.reduce((sum, bin) => sum + bin.volume, 0); const pocIndex = bins.reduce((best, bin, index) => bin.volume > bins[best].volume ? index : best, 0);
  let lowIndex = pocIndex; let highIndex = pocIndex; let areaVolume = bins[pocIndex].volume;
  while (areaVolume < totalVolume * 0.7 && (lowIndex > 0 || highIndex < bins.length - 1)) { const lower = lowIndex > 0 ? bins[lowIndex - 1].volume : -1; const upper = highIndex < bins.length - 1 ? bins[highIndex + 1].volume : -1; if (upper >= lower) { highIndex += 1; areaVolume += bins[highIndex].volume; } else { lowIndex -= 1; areaVolume += bins[lowIndex].volume; } }
  return { poc: bins[pocIndex].price, valueAreaHigh: bins[highIndex].price, valueAreaLow: bins[lowIndex].price, maxVol: bins[pocIndex].volume, binSize, minPrice, maxPrice, bins };
}

function analyzeMonthly(candles, currentPrice) {
  candles = closedCandles(candles);
  const values = closes(candles); if (!values.length) return { bias: 'NEUTRO', rsi: null, ema9: null, ema21: null };
  const ema9 = ema(values, 9); const ema21 = ema(values, 21); const price = Number(currentPrice) || values.at(-1); 
  const zones = getStructuralZones(candles);
  const bias = finite(ema9) && finite(ema21) ? (price > ema21 && ema9 > ema21 ? 'BULLISH' : price < ema21 && ema9 < ema21 ? 'BEARISH' : 'NEUTRO') : 'NEUTRO';
  return { bias, rsi: rsi(values), ema9, ema21, historicalATH: Math.max(...candles.map(c => Number(c.high))), historicalATL: Math.min(...candles.map(c => Number(c.low))), majorResistance: zones.resistanceZones[0]?.max || null, majorSupport: zones.supportZones[0]?.min || null };
}

function analyzeWeekly(candles, currentPrice) {
  candles = closedCandles(candles);
  const values = closes(candles); if (!values.length) return { structure: 'NEUTRA', rsi: null, nearestResistance: null, nearestSupport: null };
  const price = Number(currentPrice) || values.at(-1); 
  const zones = getStructuralZones(candles);
  const res = zones.resistanceZones[0]?.min || null;
  const sup = zones.supportZones[0]?.max || null;
  return { structure: marketStructure(candles), rsi: rsi(values), ema9: ema(values, 9), ema21: ema(values, 21), nearestResistance: res, nearestSupport: sup, distToResistancePercent: res ? ((res - price) / price) * 100 : null, distToSupportPercent: sup ? ((price - sup) / price) * 100 : null };
}

function analyzeDaily(candles, currentPrice) {
  candles = closedCandles(candles); const values = closes(candles);
  if (!values.length) return { bias: 'NEUTRO', structure: 'NEUTRA', rsi: null, ema20: null, ema50: null, ema200: null };
  const price = Number(currentPrice) || values.at(-1); const ema20 = ema(values, 20); const ema50 = ema(values, 50); const ema200 = ema(values, 200); 
  const zones = getStructuralZones(candles);
  const bias = finite(ema20) && finite(ema50) ? (price > ema20 && ema20 > ema50 ? 'BULLISH' : price < ema20 && ema20 < ema50 ? 'BEARISH' : 'NEUTRO') : 'NEUTRO';
  return { bias, structure: marketStructure(candles, 7), currentPrice: price, rsi: rsi(values), ema20, ema50, ema200, atr: atr(candles), adx: adx(candles), nearestResistance: zones.resistanceZones[0]?.min || null, nearestSupport: zones.supportZones[0]?.max || null };
}

function analyze4H(candles, currentPrice) {
  return _memoized('analyze4H', _analyze4HInner, candles, currentPrice);
}

function _analyze4HInner(candles, currentPrice) {
  candles = closedCandles(candles);
  const values = closes(candles); if (!values.length) return { currentPrice: Number(currentPrice) || null, isBullishCandle: null, rsi: null };
  const last = candles.at(-1); 
  const zones = getStructuralZones(candles);
  const macdData = macd(values); const bands = bollinger(values); const previousBands = bollinger(values.slice(0, -1));
  // O(n) running bollinger width calculation instead of O(n²) per-position recomputation
  const widths = [];
  if (values.length >= 20) {
    let runSum = 0, runSumSq = 0;
    for (let i = 0; i < 20; i++) { runSum += values[i]; runSumSq += values[i] * values[i]; }
    let m = runSum / 20, v = runSumSq / 20 - m * m, w = m ? (Math.sqrt(Math.max(v, 0)) * 4 / m) * 100 : null;
    if (finite(w)) widths.push(w);
    for (let i = 20; i < values.length; i++) {
      runSum += values[i] - values[i - 20];
      runSumSq += values[i] * values[i] - values[i - 20] * values[i - 20];
      m = runSum / 20; v = runSumSq / 20 - m * m; w = m ? (Math.sqrt(Math.max(v, 0)) * 4 / m) * 100 : null;
      if (finite(w)) widths.push(w);
    }
  }
  const squeezePercentile = finite(previousBands.widthPercent) && widths.length ? widths.filter(width => width <= previousBands.widthPercent).length / widths.length * 100 : null;
  const volumes = candles.slice(-21, -1).map(c => Number(c.volume)).filter(Number.isFinite); const averageVolume20 = volumes.length ? volumes.reduce((a, b) => a + b, 0) / volumes.length : null; const currentVolume = Number(last.volume);
  return { currentPrice: Number(currentPrice) || Number(last.close), close: Number(last.close), isBullishCandle: Number(last.close) >= Number(last.open), structure: marketStructure(candles), rsi: rsi(values), ema9: ema(values, 9), ema21: ema(values, 21), ema50: ema(values, 50), ema200: ema(values, 200), atr: atr(candles), adx: adx(candles), macd: macdData.macd, macdSignal: macdData.signal, macdHist: macdData.histogram, isMacdBullish: finite(macdData.histogram) ? macdData.histogram >= 0 : null, averageVolume20, currentVolume, volumeRatio: finite(averageVolume20) && averageVolume20 > 0 ? currentVolume / averageVolume20 : null, isVolumeAboveAvg: finite(averageVolume20) ? currentVolume > averageVolume20 : null, bollinger: bands, previousBollinger: previousBands, squeezePercentile, isSqueeze: finite(squeezePercentile) && squeezePercentile <= 20, localHigh4H: zones.resistanceZones[0]?.min || null, localLow4H: zones.supportZones[0]?.max || null };
}

function analyze1H(candles, currentPrice) {
  return _memoized('analyze1H', _analyze1HInner, candles, currentPrice);
}

function _analyze1HInner(candles, currentPrice) {
  const base = _analyze4HInner(candles, currentPrice);
  if (!finite(base.currentPrice)) return { ...base, trigger: 'NEUTRO' };
  const longTrigger = base.ema9 > base.ema21 && base.macdHist > 0 && base.rsi >= 42 && base.rsi <= 72;
  const shortTrigger = base.ema9 < base.ema21 && base.macdHist < 0 && base.rsi >= 28 && base.rsi <= 58;
  return { ...base, localHigh1H: base.localHigh4H, localLow1H: base.localLow4H, trigger: longTrigger ? 'COMPRA' : shortTrigger ? 'VENDA' : 'NEUTRO' };
}

function detectAlphaOpportunity(monthly, weekly, fourHour, ticker, extraData = {}) {
  let alphaScore = 0; const insights = []; const price = Number(ticker && ticker.lastPrice); if (!finite(price)) return { alphaScore, isHighConviction: false, insights };
  const { cvd, volumeProfile, fundingRate } = extraData; const funding = Number(fundingRate && fundingRate.fundingRate);
  if (finite(weekly.nearestSupport) && fourHour.localLow4H < weekly.nearestSupport && fourHour.close > weekly.nearestSupport) { alphaScore += 20; insights.push('Sweep de suporte semanal com recuperacao no fechamento.'); }
  if (finite(weekly.nearestResistance) && fourHour.localHigh4H > weekly.nearestResistance && fourHour.close < weekly.nearestResistance) { alphaScore += 20; insights.push('Sweep de resistencia semanal com rejeicao no fechamento.'); }
  if (fourHour.isSqueeze) { alphaScore += 15; insights.push('Compressao das Bandas de Bollinger detectada.'); }
  if (volumeProfile && finite(volumeProfile.poc) && Math.abs((price - volumeProfile.poc) / price) <= 0.003) { alphaScore += 10; insights.push('Preco negociando proximo ao POC.'); }
  if (cvd && finite(cvd.netDelta) && !fourHour.isBullishCandle && cvd.netDelta > 0) { alphaScore += 15; insights.push('Possivel absorcao compradora no fluxo recente.'); }
  if (cvd && finite(cvd.netDelta) && fourHour.isBullishCandle && cvd.netDelta < 0) { alphaScore += 15; insights.push('Possivel absorcao vendedora no fluxo recente.'); }
  if (finite(funding) && Math.abs(funding) >= 0.0005) { alphaScore += 10; insights.push("Funding elevado: " + (funding * 100).toFixed(4) + "%"); }
  return { alphaScore, isHighConviction: alphaScore >= 40, insights };
}

function validateDataIntegrity(monthly, weekly, daily, fourHour, oneHour) {
  const requirements = [
    { name: 'Monthly', value: monthly.bias, min: 1 },
    { name: 'Weekly', value: weekly.structure, min: 1 },
    { name: 'Daily', value: daily.bias, min: 1 },
    { name: '4H-RSI', value: fourHour.rsi, min: 1 },
    { name: '4H-EMA', value: fourHour.ema200, min: 1 },
    { name: '1H-Trigger', value: oneHour.trigger, min: 1 }
  ];
  const failures = requirements.filter(r => r.value === null || r.value === undefined).map(r => r.name);
  return { ok: failures.length === 0, failures };
}

function evaluateMomentumSignal(monthly, weekly, daily, fourHour, oneHour, ticker = {}, extraData = {}, config = {}) {
  const alpha = detectAlphaOpportunity(monthly, weekly, fourHour, ticker, extraData); 
  const setups = []; const warnings = [];
  const trendStrength = Number(fourHour.adx); const price = Number(fourHour.close); const atrValue = Number(fourHour.atr); const volumeRatio = Number(fourHour.volumeRatio);
  const macroLong = monthly.bias !== 'BEARISH' && weekly.ema9 > weekly.ema21; const macroShort = monthly.bias !== 'BULLISH' && weekly.ema9 < weekly.ema21;
  const dailyLong = daily.bias === 'BULLISH' && daily.rsi >= config.dailyLongRsiMin && daily.rsi <= config.dailyLongRsiMax; const dailyShort = daily.bias === 'BEARISH' && daily.rsi >= config.dailyShortRsiMin && daily.rsi <= config.dailyShortRsiMax;
  const hourlyLong = oneHour.ema9 > oneHour.ema21 && oneHour.macdHist > 0 && oneHour.rsi >= config.hourlyLongRsiMin && oneHour.rsi <= config.hourlyLongRsiMax; const hourlyShort = oneHour.ema9 < oneHour.ema21 && oneHour.macdHist < 0 && oneHour.rsi >= config.hourlyShortRsiMin && oneHour.rsi <= config.hourlyShortRsiMax;
  const longTrend = macroLong && price > fourHour.ema50 && fourHour.ema9 > fourHour.ema21 && fourHour.ema21 > fourHour.ema50;
  const shortTrend = macroShort && price < fourHour.ema50 && fourHour.ema9 < fourHour.ema21 && fourHour.ema21 < fourHour.ema50;
  if (longTrend && Math.abs(price - fourHour.ema21) <= atrValue * config.pullbackAtrDistance && fourHour.rsi >= 40 && fourHour.rsi <= 68 && trendStrength >= config.trendAdxMin) setups.push({ name: 'TREND_PULLBACK', direction: 'COMPRA', baseScore: 55 });
  if (shortTrend && Math.abs(price - fourHour.ema21) <= atrValue * config.pullbackAtrDistance && fourHour.rsi >= 32 && fourHour.rsi <= 60 && trendStrength >= config.trendAdxMin) setups.push({ name: 'TREND_PULLBACK', direction: 'VENDA', baseScore: 57 });
  if (macroLong && price > fourHour.localHigh4H && volumeRatio >= config.breakoutVolumeRatio && fourHour.rsi <= 75 && trendStrength >= config.breakoutAdxMin) setups.push({ name: 'BREAKOUT_VOLUME', direction: 'COMPRA', baseScore: 60 });
  if (macroShort && price < fourHour.localLow4H && volumeRatio >= config.breakoutVolumeRatio && fourHour.rsi >= 25 && trendStrength >= config.breakoutAdxMin) setups.push({ name: 'BREAKOUT_VOLUME', direction: 'VENDA', baseScore: 62 });
  if (macroLong && fourHour.squeezePercentile <= 20 && price > fourHour.previousBollinger.upper && volumeRatio >= config.squeezeVolumeRatio) setups.push({ name: 'SQUEEZE_BREAKOUT', direction: 'COMPRA', baseScore: 63 });
  if (macroShort && fourHour.squeezePercentile <= 20 && price < fourHour.previousBollinger.lower && volumeRatio >= config.squeezeVolumeRatio) setups.push({ name: 'SQUEEZE_BREAKOUT', direction: 'VENDA', baseScore: 65 });
  const selected = setups.sort((a, b) => b.baseScore - a.baseScore)[0] || null; 
  const funding = Number(extraData.fundingRate && extraData.fundingRate.fundingRate); const change24h = Number(ticker.priceChangePercent);
  const dailyConfirmed = selected && (selected.direction === 'COMPRA' ? dailyLong : dailyShort); const hourlyConfirmed = selected && (selected.direction === 'COMPRA' ? hourlyLong : hourlyShort);
  let score = selected ? selected.baseScore + (dailyConfirmed ? 10 : 0) + (hourlyConfirmed ? 10 : 0) + Math.min(alpha.alphaScore, 15) : 0;
  if (selected && extraData.marketRank && extraData.marketRank <= 10) score += 5;
  if (selected?.direction === 'COMPRA' && change24h > config.overextension24h) { warnings.push("Overextension 24h > " + config.overextension24h + "%"); score -= 30; }
  if (selected?.direction === 'VENDA' && change24h < -config.overextension24h) { warnings.push("Overextension 24h < -" + config.overextension24h + "%"); score -= 30; }
  if (selected?.direction === 'COMPRA' && funding > config.crowdedFunding) { warnings.push('Crowded Longs'); score -= 20; }
  if (selected?.direction === 'VENDA' && funding < -config.crowdedFunding) { warnings.push('Crowded Shorts'); score -= 20; }
  if (selected?.direction === 'COMPRA' && finite(weekly.distToResistancePercent) && weekly.distToResistancePercent < 1.5) { warnings.push('Weekly Resistance Close'); score -= 15; }
  if (selected?.direction === 'VENDA' && finite(weekly.distToSupportPercent) && weekly.distToSupportPercent < 1.5) { warnings.push('Weekly Support Close'); score -= 15; }
  if (selected && !dailyConfirmed) warnings.push('Daily bias mismatch');
  if (selected && !hourlyConfirmed) warnings.push('Hourly trigger pending');
  score = Math.max(0, Math.min(100, score)); const action = selected && dailyConfirmed && hourlyConfirmed && score >= config.minScore ? selected.direction : 'AGUARDAR';
  const evidence = { timestamp: new Date().toISOString(), price, metrics: { adx4h: trendStrength, rsi4h: fourHour.rsi, volRatio4h: volumeRatio, funding: funding, change24h: change24h }, confluences: { macroLong, macroShort, dailyLong, dailyShort, hourlyLong, hourlyShort, longTrend, shortTrend }, alphaScore: alpha.alphaScore, selectedSetup: selected?.name || null };
  const components = { setup4H: selected ? selected.baseScore : 0, confirmation1D: dailyConfirmed ? 10 : 0, trigger1H: hourlyConfirmed ? 10 : 0, flow: selected ? Math.min(alpha.alphaScore, 15) : 0, crossSectionalMomentum: selected && extraData.marketRank <= 10 ? 5 : 0, penalties: 0 };
  components.penalties = score - Object.entries(components).filter(([name]) => name !== 'penalties').reduce((sum, [, points]) => sum + points, 0);
  const confluences = selected ? ["Setup 4H: " + selected.name, "Regime 1D: " + daily.bias, "Gatilho 1H: " + oneHour.trigger, "ADX 4H: " + trendStrength.toFixed(1), "Volume 4H: " + volumeRatio.toFixed(2) + "x a média", ...alpha.insights] : [];
  return { action, score, setup: selected?.name || null, strategyProfile: extraData.strategyProfile || 'balanced', candidates: setups, components, alpha, warnings, confluences, blockedLong: selected?.direction === 'COMPRA' && action === 'AGUARDAR', blockedShort: selected?.direction === 'VENDA' && action === 'AGUARDAR', conviction: score >= 85 ? 'ALTA' : score >= 70 ? 'MÉDIA' : 'BAIXA', evidence };
}

function evaluateMeanReversionSignal(monthly, weekly, daily, fourHour, oneHour, ticker = {}, extraData = {}, config = {}) {
  const alpha = detectAlphaOpportunity(monthly, weekly, fourHour, ticker, extraData); 
  const setups = []; const warnings = [];
  const price = Number(fourHour.close);
  const rsi4h = fourHour.rsi;
  
  const isOverbought = rsi4h > 70; const isOversold = rsi4h < 30;
  const farFromEMA = Math.abs(price - fourHour.ema200) / fourHour.ema200 > 0.05;
  const bollingerEdge = (price >= fourHour.bollinger.upper) || (price <= fourHour.bollinger.lower);
  
  if (isOversold && bollingerEdge && price < fourHour.bollinger.lower) setups.push({ name: 'MEAN_REVERSION_LONG', direction: 'COMPRA', baseScore: 60 });
  if (isOverbought && bollingerEdge && price > fourHour.bollinger.upper) setups.push({ name: 'MEAN_REVERSION_SHORT', direction: 'VENDA', baseScore: 60 });
  
  const selected = setups.sort((a, b) => b.baseScore - a.baseScore)[0] || null;
  if (!selected) return { action: 'AGUARDAR', score: 0, setup: 'MR_NO_SETUP', warnings: ['Ativo não apresenta condições de reversão à média.'], conviction: 'BAIXA', evidence: null };
  
  const hourlyConfirmed = selected.direction === 'COMPRA' ? (oneHour.rsi < 40 && oneHour.macdHist > -0.1) : (oneHour.rsi > 60 && oneHour.macdHist < 0.1);
  let score = selected.baseScore + (hourlyConfirmed ? 15 : 0) + Math.min(alpha.alphaScore, 10);
  
  const action = hourlyConfirmed && score >= config.minScore ? selected.direction : 'AGUARDAR';
  const evidence = { timestamp: new Date().toISOString(), price, metrics: { rsi4h, distEma200: (price - fourHour.ema200) / fourHour.ema200, bollingerEdge }, alphaScore: alpha.alphaScore, selectedSetup: selected.name };
  
  return { action, score, setup: selected.name, strategyProfile: extraData.strategyProfile || 'balanced', candidates: setups, components: { setup4H: selected.baseScore, trigger1H: hourlyConfirmed ? 15 : 0, flow: Math.min(alpha.alphaScore, 10) }, alpha, warnings, confluences: ["Regime: Mean Reversion", "RSI 4H: " + rsi4h.toFixed(1), ...alpha.insights], conviction: score >= 75 ? 'ALTA' : 'MÉDIA', evidence };
}

function evaluateMultiTimeframeSignal(monthly, weekly, daily, fourHour, oneHour, ticker = {}, extraData = {}) {
  const integrity = validateDataIntegrity(monthly, weekly, daily, fourHour, oneHour);
  if (!integrity.ok) {
    return { action: 'BLOQUEADO_DADOS', score: 0, setup: null, warnings: ["Dados insuficientes: " + integrity.failures.join(", ")], conviction: 'N/A', evidence: null, state: 'DATA_ERROR' };
  }

  const config = { ...DEFAULT_STRATEGY_CONFIG, ...(extraData.strategyConfig || {}) };
  const trendStrength = Number(fourHour.adx);
  
  const isMomentumRegime = trendStrength >= config.regimeAdxThreshold;
  const regime = isMomentumRegime ? 'MOMENTUM' : 'MEAN_REVERSION';
  
  const result = isMomentumRegime 
    ? evaluateMomentumSignal(monthly, weekly, daily, fourHour, oneHour, ticker, extraData, config)
    : evaluateMeanReversionSignal(monthly, weekly, daily, fourHour, oneHour, ticker, extraData, config);
  
  return { ...result, regime };
}

module.exports = { ema, rsi, atr, adx, macd, bollinger, closedCandles, calculateCVD, calculateVolumeProfile, analyzeMonthly, analyzeWeekly, analyzeDaily, analyze4H, analyze1H, evaluateMultiTimeframeSignal, clearIndicatorCache };