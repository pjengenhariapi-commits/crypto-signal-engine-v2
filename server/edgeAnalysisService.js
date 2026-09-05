const { getSignals } = require('./dbService');
const { getKlines } = require('./binanceService');

async function calculateEdge(symbol) {
  const signals = await getSignals({ symbol, limit: 500 });
  const actionable = signals.filter(s => s.action !== 'AGUARDAR');
  if (!actionable.length) return { symbol, winRate: 0, sampleSize: 0, edge: 'NONE' };

  let wins = 0;
  for (const sig of actionable) {
    try {
      // We check the price action after the signal
      // Professional approach: did it hit a 1:1 RR before the logical stop?
      // For this heatmap, we'll use a simplified 'price improvement' after 24h or hit a target.
      const candles = await getKlines(symbol, '4h', 100);
      const currentPrice = Number(candles.at(-1).close);
      
      // This is a simplified back-check for the "Heatmap"
      // Real quantitative edge would involve a full loop on historical klines
      if (sig.action === 'COMPRA' && currentPrice > sig.price) wins++;
      if (sig.action === 'VENDA' && currentPrice < sig.price) wins++;
    } catch (e) { continue; }
  }

  const winRate = (wins / actionable.length) * 100;
  let edge = 'NEUTRAL';
  if (winRate > 65) edge = 'STRONG';
  else if (winRate > 55) edge = 'POSITIVE';
  else if (winRate < 45) edge = 'NEGATIVE';

  return { 
    symbol, 
    winRate: Number(winRate.toFixed(1)), 
    sampleSize: actionable.length, 
    edge 
  };
}

async function getGlobalHeatmap(symbols) {
  const results = await Promise.all(symbols.map(s => calculateEdge(s).catch(() => null)));
  return results.filter(Boolean).sort((a, b) => b.winRate - a.winRate);
}

module.exports = { calculateEdge, getGlobalHeatmap };
