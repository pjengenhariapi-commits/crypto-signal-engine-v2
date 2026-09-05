const { getPerformanceStats, getTrades } = require('./dbService');

function evaluateCircuitBreaker(stats = {}, recentTrades = [], options = {}) {
  const minSample = Number(options.minSample || process.env.CIRCUIT_MIN_SAMPLE || 10);
  const minWinRate = Number(options.minWinRate || process.env.CIRCUIT_MIN_WIN_RATE || 25);
  const maxLossStreak = Number(options.maxLossStreak || process.env.CIRCUIT_MAX_LOSS_STREAK || 3);
  const closed = recentTrades.filter(trade => trade.status === 'CLOSED' || trade.pnl !== undefined);
  let lossStreak = 0;
  for (const trade of closed) { if (Number(trade.pnl) < 0) lossStreak += 1; else break; }
  if (lossStreak >= maxLossStreak) return { blocked: true, code: 'LOSS_STREAK', reason: `${lossStreak} perdas consecutivas: novas entradas suspensas.`, lossStreak };
  const total = Number(stats.total_trades || 0);
  const winRate = Number.isFinite(Number(stats.win_rate)) ? Number(stats.win_rate) : (total ? Number(stats.wins || 0) / total * 100 : 0);
  if (total >= minSample && winRate < minWinRate) return { blocked: true, code: 'LOW_WIN_RATE', reason: `Win rate de ${winRate.toFixed(1)}% abaixo do piso de ${minWinRate}%.`, lossStreak };
  return { blocked: false, code: 'OK', lossStreak };
}

async function checkCircuitBreaker() {
  const [stats, recentTrades] = await Promise.all([getPerformanceStats(), getTrades({ status: 'CLOSED', limit: 20 })]);
  return evaluateCircuitBreaker(stats, recentTrades);
}

module.exports = { checkCircuitBreaker, evaluateCircuitBreaker };
