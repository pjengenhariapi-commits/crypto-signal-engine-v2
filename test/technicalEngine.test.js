const test = require('node:test');
const assert = require('node:assert/strict');
const { ema, rsi, atr, adx, macd, bollinger, closedCandles, calculateCVD, calculateVolumeProfile, analyzeDaily, analyze4H, analyze1H, evaluateMultiTimeframeSignal } = require('../server/technicalEngine');
const { calculatePositionSize } = require('../server/riskEngine');

const rising = Array.from({ length: 220 }, (_, index) => index + 1);
const candles = rising.map((close, index) => ({ time: index, open: close - 0.5, high: close + 1, low: close - 1, close, volume: 100 + index }));

// Candles with realistic zig-zag pattern for structural analysis (has pivots)
const zigzagCandles = Array.from({ length: 220 }, (_, i) => {
  const base = 100 + Math.sin(i / 8) * 15 + (i * 0.3);
  return { time: i, closeTime: i + 1, open: base - 0.5, high: base + 2, low: base - 2, close: base, volume: 500 + Math.random() * 200 };
});

test('EMA e RSI refletem uma tendência crescente', () => {
  assert.ok(ema(rising, 9) > ema(rising, 21));
  assert.equal(rsi(rising), 100);
});

test('ATR, MACD e Bollinger retornam métricas finitas', () => {
  assert.ok(atr(candles) > 0);
  assert.ok(Number.isFinite(adx(candles)));
  assert.ok(Number.isFinite(macd(rising).histogram));
  assert.ok(bollinger(rising).widthPercent > 0);
});

test('análise 4H fornece os campos exigidos pelo motor de risco', () => {
  const result = analyze4H(zigzagCandles, 115);
  for (const field of ['currentPrice', 'rsi', 'ema9', 'ema21', 'ema50', 'ema200', 'atr', 'localHigh4H', 'localLow4H']) assert.ok(Number.isFinite(result[field]), field);
});

test('CVD separa agressão compradora e vendedora', () => {
  const result = calculateCVD([{ q: 5, m: false }, { q: 2, m: true }]);
  assert.equal(result.netDelta, 3); assert.equal(result.buyVolume, 5); assert.equal(result.sellVolume, 2);
});

test('Volume Profile calcula POC e área de valor', () => {
  const result = calculateVolumeProfile([{ p: 100, q: 10 }, { p: 101, q: 2 }, { p: 102, q: 1 }], 3);
  assert.ok(result.poc >= result.valueAreaLow && result.poc <= result.valueAreaHigh);
});

test('calculadora recusa entradas inseguras', () => {
  assert.equal(calculatePositionSize(0, 1, 100, 95), null);
  assert.ok(calculatePositionSize(1000, 1, 100, 95));
});

test('candles ainda abertos são excluídos dos indicadores', () => {
  const now = Date.now();
  const sample = [{ close: 10, closeTime: now - 1 }, { close: 999, closeTime: now + 60000 }];
  assert.deepEqual(closedCandles(sample, now).map(item => item.close), [10]);
});

test('análises 1D e 1H calculam regime e gatilho', () => {
  const daily = analyzeDaily(candles, 220);
  const hourly = analyze1H(candles, 220);
  assert.equal(daily.bias, 'BULLISH');
  assert.ok(Number.isFinite(daily.ema200));
  assert.ok(['COMPRA', 'VENDA', 'NEUTRO'].includes(hourly.trigger));
});

test('sequência exige confirmação de 1D e gatilho de 1H', () => {
  const monthly = { bias: 'BULLISH' };
  const weekly = { structure: 'ALTA', ema9: 105, ema21: 100, distToResistancePercent: 10, distToSupportPercent: 5 };
  const daily = { bias: 'BULLISH', rsi: 55 };
  // Price near EMA21 for TREND_PULLBACK: |101.5 - 101| = 0.5 <= 3 * 3 (pullbackAtrDistance * atr)
  const fourHour = { close: 101.5, ema9: 102.5, ema21: 101, ema50: 98, ema200: 90, rsi: 55, adx: 28, atr: 3, volumeRatio: 1.5, localHigh4H: 110, localLow4H: 90, squeezePercentile: 50, previousBollinger: { upper: 110, lower: 90 } };
  const confirmed = evaluateMultiTimeframeSignal(monthly, weekly, daily, fourHour, { trigger: 'COMPRA', ema9: 102, ema21: 100.5, macdHist: 1, rsi: 55 }, { lastPrice: 101.5 }, {});
  const unconfirmed = evaluateMultiTimeframeSignal(monthly, weekly, daily, fourHour, { trigger: 'NEUTRO', ema9: 99, ema21: 101, macdHist: -1, rsi: 55 }, { lastPrice: 101.5 }, {});
  assert.equal(confirmed.action, 'COMPRA');
  assert.equal(unconfirmed.action, 'AGUARDAR');
  assert.match(unconfirmed.warnings.join(' '), /Hourly|1H/);
});
