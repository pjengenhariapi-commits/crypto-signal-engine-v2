const test = require('node:test');
const assert = require('node:assert/strict');
const { rankTraining } = require('../server/calibrationService');

test('calibração penaliza amostras pequenas', () => {
  assert.ok(rankTraining({ totalTrades: 4, avgRMultiple: 2, profitFactor: 5, maxDrawdownPercent: 1 }) < rankTraining({ totalTrades: 20, avgRMultiple: 0.2, profitFactor: 1.4, maxDrawdownPercent: 3 }));
});

test('calibração favorece expectativa e penaliza drawdown', () => {
  const stable = rankTraining({ totalTrades: 20, avgRMultiple: 0.3, profitFactor: 1.5, maxDrawdownPercent: 3 });
  const unstable = rankTraining({ totalTrades: 20, avgRMultiple: 0.1, profitFactor: 1.1, maxDrawdownPercent: 12 });
  assert.ok(stable > unstable);
});
