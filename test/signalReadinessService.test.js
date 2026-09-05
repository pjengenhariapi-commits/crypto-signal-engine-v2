const test = require('node:test'); const assert = require('node:assert/strict');
const { assessSignalReadiness } = require('../server/signalReadinessService');
const bullish = { signal: { action: 'AGUARDAR', setup: 'TREND_PULLBACK' }, monthly: { bias: 'BULLISH' }, weekly: { ema9: 2, ema21: 1 }, daily: { bias: 'BULLISH' }, fourHour: { ema9: 2, ema21: 1 }, oneHour: { trigger: 'NEUTRO' } };
test('marca setup quase confirmado como armado sem fabricar COMPRA', () => { const r = assessSignalReadiness(bullish); assert.equal(r.status, 'ARMADO'); assert.equal(r.direction, 'COMPRA'); assert.match(r.missing.join(' '), /1H/); });
test('preserva sinal confirmado do motor', () => { const r = assessSignalReadiness({ signal: { action: 'VENDA', score: 82 } }); assert.deepEqual(r, { status: 'CONFIRMADO', direction: 'VENDA', score: 82, missing: [], label: 'VENDA' }); });
test('cenário sem alinhamento permanece neutro', () => { const r = assessSignalReadiness({ signal: { action: 'AGUARDAR' } }); assert.equal(r.status, 'NEUTRO'); assert.equal(r.label, 'AGUARDAR'); });
