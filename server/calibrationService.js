const { getKlines, getHistoricalKlines } = require('./binanceService');
const { runBacktestOnCandles } = require('./backtestEngine');
const { STRATEGY_PROFILES } = require('./strategyConfig');

function rankTraining(metrics) {
  if (metrics.totalTrades < 10) return -1000 + metrics.totalTrades;
  return metrics.avgRMultiple * Math.sqrt(metrics.totalTrades) + Math.min(metrics.profitFactor, 5) * 0.15 - metrics.maxDrawdownPercent * 0.05;
}

async function calibrateSymbol(symbol, candleCount = 5000, options = {}) {
  const cleanSymbol = String(symbol).toUpperCase().replace('/', '').trim(); const count = Math.min(Math.max(Number(candleCount) || 5000, 1000), 10000);
  const [candles, weeklyCandles, monthlyCandles, dailyCandles, hourlyCandles] = await Promise.all([getHistoricalKlines(cleanSymbol, '4h', count), getKlines(cleanSymbol, '1w', 260), getKlines(cleanSymbol, '1M', 60), getHistoricalKlines(cleanSymbol, '1d', Math.min(Math.ceil(count / 6) + 250, 2000)), getHistoricalKlines(cleanSymbol, '1h', Math.min(count * 4, 25000))]);
  if (candles.length < 1000) throw new Error('Histórico insuficiente para calibração holdout.');
  const splitIndex = Math.floor(candles.length * 0.6); const training = [];
  for (const [name, config] of Object.entries(STRATEGY_PROFILES)) {
    const context = { weeklyCandles, monthlyCandles, dailyCandles, hourlyCandles, strategyConfig: config, strategyProfile: name };
    const result = runBacktestOnCandles(candles.slice(0, splitIndex), { ...options, strategyConfig: config, strategyProfile: name }, context);
    training.push({ profile: name, score: rankTraining(result.metrics), metrics: result.metrics });
  }
  training.sort((a, b) => b.score - a.score); const selectedProfile = training[0].profile; const selectedConfig = STRATEGY_PROFILES[selectedProfile];
  const context = { weeklyCandles, monthlyCandles, dailyCandles, hourlyCandles, strategyConfig: selectedConfig, strategyProfile: selectedProfile };
  const validation = runBacktestOnCandles(candles, { ...options, startTradingIndex: splitIndex, strategyConfig: selectedConfig, strategyProfile: selectedProfile }, context);
  const metrics = validation.metrics; const trainingQualified = training[0].metrics.totalTrades >= 10; const approved = trainingQualified && metrics.totalTrades >= 20 && metrics.profitFactor >= 1.2 && metrics.avgRMultiple > 0.1 && metrics.maxDrawdownPercent <= 10 && metrics.totalReturnPercent > 0;
  return { type: 'TRAIN_HOLDOUT_CALIBRATION', symbol: cleanSymbol, split: { trainingPercent: 60, validationPercent: 40, splitDate: candles[splitIndex].date }, selectedProfile, selectedConfig, trainingQualified, trainingCandidates: training, validation: metrics, summary: { totalTrades: metrics.totalTrades, profitableFolds: approved ? 1 : 0, totalFolds: 1, averageReturnPercent: metrics.totalReturnPercent, worstDrawdownPercent: metrics.maxDrawdownPercent, approved } };
}

module.exports = { calibrateSymbol, rankTraining };
