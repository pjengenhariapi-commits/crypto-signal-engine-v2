const test = require('node:test');
const assert = require('node:assert/strict');
const { entrySetup, runBacktestOnCandles } = require('../server/backtestEngine');

function market(length = 320) {
  return Array.from({ length }, (_, index) => {
    const close = 100 + index * 0.08 + Math.sin(index / 2) * 2;
    return { time: index * 14400000, date: new Date(index * 14400000).toISOString(), open: close - 0.1, high: close + 1, low: close - 1, close, volume: 100 + (index % 20 === 19 ? 120 : 0) };
  });
}

test('setup usa apenas o histórico fornecido e indicadores fechados', () => {
  const candles = market(220); candles.at(-1).volume = 300;
  const setup = entrySetup(candles);
  assert.equal(setup.side, 'LONG');
  assert.ok(setup.analysis.rsi >= 45 && setup.analysis.rsi <= 68);
});

test('backtest registra premissas, custos e curva de capital', () => {
  const result = runBacktestOnCandles(market(), { feePercent: 0.04, slippagePercent: 0.02, riskPercent: 1 });
  assert.equal(result.assumptions.entry, 'Abertura do candle seguinte ao sinal');
  assert.equal(result.assumptions.sameCandleConflict, 'Stop priorizado');
  assert.equal(result.equityCurve.length, result.metrics.totalTrades + 1);
  assert.ok(Number.isFinite(result.metrics.totalCostsPercent));
  assert.equal(typeof result.metrics.bySetup, 'object');
});

test('backtest rejeita amostra sem aquecimento suficiente', () => {
  assert.throws(() => runBacktestOnCandles(market(100)), /220 candles/);
});

test('backtest rejeita risco e custos fora dos limites', () => {
  assert.throws(() => runBacktestOnCandles(market(), { riskPercent: 10 }), /Risco/);
  assert.throws(() => runBacktestOnCandles(market(), { slippagePercent: 2 }), /slippage/);
});
