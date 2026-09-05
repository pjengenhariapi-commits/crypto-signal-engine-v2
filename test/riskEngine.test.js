const test = require('node:test'); const assert = require('node:assert/strict');
const { calculateTradeParameters, calculatePositionSize, evaluateTradeRisk } = require('../server/riskEngine');

test('COMPRA produz stop abaixo e takeProfit acima', () => {
  const r = calculateTradeParameters(
    { action: 'COMPRA' },
    { close: 100, atr: 2, localLow4H: 96, localHigh4H: 110 },
    { nearestResistance: 140 }
  );
  assert.ok(r.stopLoss < 100, 'stop should be below entry');
  assert.ok(r.takeProfit > 100, 'take profit should be above entry');
  assert.ok(r.stopPercent > 0, 'stop percent should be positive');
  assert.ok(r.suggestedLeverage >= 1, 'leverage should be at least 1');
});

test('VENDA produz stop acima e takeProfit abaixo', () => {
  const r = calculateTradeParameters(
    { action: 'VENDA' },
    { close: 100, atr: 2, localLow4H: 90, localHigh4H: 104 },
    { nearestSupport: 80 }
  );
  assert.ok(r.stopLoss > 100, 'stop should be above entry');
  assert.ok(r.takeProfit < 100, 'take profit should be below entry');
});

test('AGUARDAR retorna stopPercent zero', () => {
  const r = calculateTradeParameters({ action: 'AGUARDAR' }, { close: 100, atr: 2 }, {});
  assert.equal(r.stopPercent, 0);
  assert.equal(r.suggestedLeverage, 1);
});

test('dados invalidos retornam null no calculo de posicao', () => {
  assert.equal(calculatePositionSize(0, 1, 100, 95), null);
  assert.equal(calculatePositionSize(1000, 0, 100, 95), null);
  assert.equal(calculatePositionSize(1000, 1, 100, 100), null); // risk per unit = 0
});

test('dimensionamento calcula corretamente', () => {
  const r = calculatePositionSize(1000, 1, 100, 95);
  assert.ok(r, 'should return a result');
  assert.equal(r.riskAmount, 10); // 1% of 1000
  assert.equal(r.riskPerUnit, 5); // |100 - 95|
  assert.equal(r.size, 2); // 10 / 5
});

test('evaluateTradeRisk rejeita margem excessiva', () => {
  const result = evaluateTradeRisk(
    { symbol: 'BTCUSDT', entryPrice: 100, stopLoss: 95, riskPercent: 50 },
    { equity: 100, currentPositions: [] }
  );
  assert.equal(result.ok, false, 'should reject due to margin exceeding 20% of equity');
});
