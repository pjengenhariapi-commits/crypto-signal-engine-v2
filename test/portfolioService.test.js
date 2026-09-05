const test = require('node:test');
const assert = require('node:assert/strict');
const { calculatePortfolioSnapshot } = require('../server/portfolioService');

test('portfolio calcula PnL, exposição e risco agregado', () => {
  const snapshot = calculatePortfolioSnapshot([{ symbol: 'BTCUSDT', side: 'LONG', entryPrice: 100, stopLoss: 95, takeProfit: 110, quantity: 2, marginRequired: 40, riskAmountUSD: 10, positionValueUSD: 200, walletBalance: 1000 }], { BTCUSDT: 105 }, { feePercent: 0, maxRiskPercent: 3, maxOpenTrades: 3 });
  assert.equal(snapshot.positions[0].unrealizedPnl, 10);
  assert.equal(snapshot.summary.openRiskPercent, 1);
  assert.equal(snapshot.summary.totalExposureUSD, 200);
  assert.equal(snapshot.status, 'SAFE');
});

test('portfolio entra em limite ao atingir risco máximo', () => {
  const snapshot = calculatePortfolioSnapshot([{ symbol: 'ETHUSDT', side: 'SHORT', entryPrice: 100, quantity: 1, marginRequired: 20, riskAmountUSD: 30, positionValueUSD: 100, walletBalance: 1000 }], { ETHUSDT: 90 }, { feePercent: 0, maxRiskPercent: 3 });
  assert.equal(snapshot.status, 'LIMIT');
  assert.equal(snapshot.positions[0].unrealizedPnl, 10);
});
