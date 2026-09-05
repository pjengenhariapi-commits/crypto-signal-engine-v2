const axios = require("axios");
const { cachedKlines, cachedTicker, cachedFunding, cachedAggTrades } = require("./cacheService");

const FUTURES_API = "https://fapi.binance.com/fapi/v1";
const SPOT_API = "https://api.binance.com/api/v3";

const DEFAULT_SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "DOGEUSDT", "AVAXUSDT", "LINKUSDT", "SUIUSDT"];

// Axios shared instance with connection pooling for better performance
const httpClient = axios.create({
  timeout: 10000,
  httpAgent: new (require('http').Agent)({ keepAlive: true, maxSockets: 10 }),
  httpsAgent: new (require('https').Agent)({ keepAlive: true, maxSockets: 10 })
});

async function getKlinesUncached(symbol, interval, limit = 100, endTime) {
  try {
    const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 1500);
    const url = FUTURES_API + "/klines?symbol=" + symbol.toUpperCase() + "&interval=" + interval + "&limit=" + safeLimit + (endTime ? "&endTime=" + Number(endTime) : "");
    const res = await httpClient.get(url);
    return res.data.map(c => ({
      time: c[0],
      closeTime: c[6],
      date: new Date(c[0]).toISOString(),
      open: parseFloat(c[1]),
      high: parseFloat(c[2]),
      low: parseFloat(c[3]),
      close: parseFloat(c[4]),
      volume: parseFloat(c[5])
    }));
  } catch (err) {
    return [];
  }
}

const getKlines = cachedKlines(getKlinesUncached);

async function getHistoricalKlines(symbol, interval, total = 1500) {
  const requested = Math.min(Math.max(Number(total) || 1500, 1), 25000);
  let endTime; let candles = [];
  while (candles.length < requested) {
    const batch = await getKlines(symbol, interval, Math.min(1500, requested - candles.length), endTime);
    if (!batch.length) break;
    candles = [...batch, ...candles];
    const nextEndTime = Number(batch[0].time) - 1;
    if (!Number.isFinite(nextEndTime) || nextEndTime === endTime) break;
    endTime = nextEndTime;
    if (batch.length < Math.min(1500, requested - candles.length + batch.length)) break;
  }
  return [...new Map(candles.map(candle => [candle.time, candle])).values()].sort((a, b) => a.time - b.time).slice(-requested);
}

async function getTicker24hUncached(symbol) {
  try {
    const url = FUTURES_API + "/ticker/24hr?symbol=" + symbol.toUpperCase();
    const res = await httpClient.get(url);
    return {
      lastPrice: parseFloat(res.data.lastPrice),
      priceChangePercent: parseFloat(res.data.priceChangePercent),
      highPrice: parseFloat(res.data.highPrice),
      lowPrice: parseFloat(res.data.lowPrice),
      quoteVolume: parseFloat(res.data.quoteVolume)
    };
  } catch (err) {
    return {};
  }
}

const getTicker24h = cachedTicker(getTicker24hUncached);

async function getMultiTimeframeData(symbol) {
  try {
    const [candles1M, candles1W, candles4H, candles1D, candles1H, ticker] = await Promise.all([
      getKlines(symbol, "1M", 60),
      getKlines(symbol, "1w", 60),
      getKlines(symbol, "4h", 250),
      getKlines(symbol, "1d", 250),
      getKlines(symbol, "1h", 250),
      getTicker24h(symbol)
    ]);

    if (!candles1H.length || !candles4H.length || !candles1D.length || !candles1W.length || !candles1M.length) {
      throw new Error(`Dados incompletos para o ativo ${symbol}. Algum timeframe retornou vazio.`);
    }

    // Sincronização Temporal: Definimos o ponto de corte no último candle FECHADO do menor timeframe (1H)
    const lastClosed1H = candles1H[candles1H.length - 1];
    const cutoffTime = lastClosed1H.closeTime;

    // Filtramos todos os outros timeframes para garantir que não usemos dados "do futuro" 
    // relativos ao fechamento do candle de 1H.
    const sync = (candles) => candles.filter(c => c.closeTime <= cutoffTime);

    return { 
      candles1M: sync(candles1M), 
      candles1W: sync(candles1W), 
      candles4H: sync(candles4H), 
      candles1D: sync(candles1D), 
      candles1H: sync(candles1H), 
      ticker 
    };
  } catch (err) {
    console.error(`[Data Sync Error] ${symbol}: ${err.message}`);
    throw err;
  }
}

async function getFundingRateUncached(symbol) {
  try {
    const url = "https://fapi.binance.com/fapi/v1/premiumIndex?symbol=" + symbol.toUpperCase();
    const res = await httpClient.get(url);
    return {
      success: true,
      fundingRate: parseFloat(res.data.lastFundingRate),
      nextFundingTime: res.data.nextFundingTime
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

const getFundingRate = cachedFunding(getFundingRateUncached);

async function getAggTradesUncached(symbol, limit = 1000) {
  try {
    const url = FUTURES_API + "/aggTrades?symbol=" + symbol.toUpperCase() + "&limit=" + limit;
    const res = await httpClient.get(url);
    return res.data.map(t => ({
      p: parseFloat(t.p), // Price
      q: parseFloat(t.q), // Quantity
      m: t.m,             // Is buyer maker? (True = Sell, False = Buy)
      T: t.T              // Timestamp
    }));
  } catch (err) {
    return [];
  }
}

const getAggTrades = cachedAggTrades(getAggTradesUncached);

module.exports = {
  DEFAULT_SYMBOLS,
  getKlines,
  getHistoricalKlines,
  getTicker24h,
  getMultiTimeframeData,
  getFundingRate,
  getAggTrades
};
