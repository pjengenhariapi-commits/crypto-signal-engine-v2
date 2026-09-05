const test = require('node:test');
const assert = require('node:assert/strict');
const { analyzeInfluence } = require('../server/influenceService');

test('análise de influência mede força relativa e fluxo comprador', () => {
  const result = analyzeInfluence({ symbol: 'TESTUSDT', ticker: { priceChangePercent: 5 }, btcTicker: { priceChangePercent: 2 }, leaders: [{ change24h: 2 }, { change24h: -1 }], cvd: { buyVolume: 70, sellVolume: 30 }, funding: { fundingRate: 0.0001 }, monthly: { bias: 'BULLISH' }, weekly: { structure: 'ALTA' }, daily: { bias: 'BULLISH' }, fourHour: { structure: 'ALTA', volumeRatio: 1.5 }, oneHour: { trigger: 'COMPRA' } });
  assert.equal(result.trend, 'ALTA');
  assert.equal(result.relativeStrength, 3);
  assert.equal(result.cvdImbalancePercent, 40);
  assert.match(result.narrative, /não comprovam/i);
});
