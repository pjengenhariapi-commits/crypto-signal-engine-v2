const axios = require('axios');

const API = 'https://fapi.binance.com/fapi/v1';
let cache = null;

async function getMarketLeaders({ minQuoteVolume = 50000000, limit = 20 } = {}) {
  if (cache && Date.now() - cache.createdAt < 5 * 60 * 1000) return cache.items.slice(0, limit);
  const [tickerResponse, exchangeResponse] = await Promise.all([axios.get(`${API}/ticker/24hr`, { timeout: 10000 }), axios.get(`${API}/exchangeInfo`, { timeout: 10000 })]);
  const eligible = new Map(exchangeResponse.data.symbols.filter(item => item.status === 'TRADING' && item.contractType === 'PERPETUAL' && item.quoteAsset === 'USDT' && (!item.underlyingType || item.underlyingType === 'COIN')).map(item => [item.symbol, item]));
  const items = tickerResponse.data.filter(item => eligible.has(item.symbol) && Number(item.quoteVolume) >= minQuoteVolume).map(item => { const metadata = eligible.get(item.symbol); return { symbol: item.symbol, lastPrice: Number(item.lastPrice), change24h: Number(item.priceChangePercent), quoteVolume: Number(item.quoteVolume), high24h: Number(item.highPrice), low24h: Number(item.lowPrice), ageDays: metadata.onboardDate ? Math.floor((Date.now() - metadata.onboardDate) / 86400000) : null }; }).sort((a, b) => b.change24h - a.change24h).map((item, index) => ({ rank: index + 1, ...item, overextended: Math.abs(item.change24h) > 20, eligibleForMomentumEntry: item.change24h > 0 && item.change24h <= 20 && item.ageDays >= 180 }));
  cache = { createdAt: Date.now(), items };
  return items.slice(0, limit);
}

module.exports = { getMarketLeaders };
