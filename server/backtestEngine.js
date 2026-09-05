const { getKlines, getHistoricalKlines } = require('./binanceService');
const { analyzeMonthly, analyzeWeekly, analyzeDaily, analyze4H, analyze1H, evaluateMultiTimeframeSignal } = require('./technicalEngine');

const DEFAULTS = { initialCapital: 1000, riskPercent: 1, feePercent: 0.04, slippagePercent: 0.02, fundingRate: 0 };
const round = (value, digits = 4) => Number(Number(value).toFixed(digits));

function historicalWindow(candles, cutoff, limit) {
  let low = 0; let high = candles.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const timestamp = candles[middle].closeTime || candles[middle].time;
    if (timestamp <= cutoff) low = middle + 1;
    else high = middle;
  }
  return candles.slice(Math.max(0, low - limit), low);
}

function entrySetup(history, context = {}) {
  const analysis = analyze4H(history, history.at(-1).close);
  const price = analysis.currentPrice;
  const ready = [price, analysis.ema9, analysis.ema21, analysis.ema50, analysis.rsi, analysis.macdHist, analysis.atr].every(Number.isFinite);
  if (!ready) return null;
  if (context.monthlyCandles && context.weeklyCandles && context.dailyCandles && context.hourlyCandles) {
    const cutoff = history.at(-1).closeTime || history.at(-1).time;
    const monthly = historicalWindow(context.monthlyCandles, cutoff, 60);
    const weekly = historicalWindow(context.weeklyCandles, cutoff, 60);
    const daily = historicalWindow(context.dailyCandles, cutoff, 250);
    const hourly = historicalWindow(context.hourlyCandles, cutoff, 250);
    const signal = evaluateMultiTimeframeSignal(analyzeMonthly(monthly, price), analyzeWeekly(weekly, price), analyzeDaily(daily, price), analysis, analyze1H(hourly, price), { lastPrice: price }, { strategyConfig: context.strategyConfig, strategyProfile: context.strategyProfile });
    if (!['COMPRA', 'VENDA'].includes(signal.action)) return null;
    return { side: signal.action === 'COMPRA' ? 'LONG' : 'SHORT', analysis, signal };
  }
  if (!analysis.isVolumeAboveAvg) return null;
  const long = price > analysis.ema9 && analysis.ema9 > analysis.ema21 && analysis.ema21 > analysis.ema50 && analysis.macdHist > 0 && analysis.rsi >= 45 && analysis.rsi <= 68;
  const short = price < analysis.ema9 && analysis.ema9 < analysis.ema21 && analysis.ema21 < analysis.ema50 && analysis.macdHist < 0 && analysis.rsi >= 32 && analysis.rsi <= 55;
  if (!long && !short) return null;
  return { side: long ? 'LONG' : 'SHORT', analysis, signal: null };
}

function createPosition(setup, signalIndex, entryCandle, options) {
  const { side, analysis } = setup;
  const volatilityFactor = Number.isFinite(analysis.atr) ? analysis.atr / entryCandle.close : 0.0001;
  const dynamicSlippage = Math.max(options.slippagePercent / 100, volatilityFactor * 0.1);
  const entryPrice = Number(entryCandle.open) * (side === 'LONG' ? 1 + dynamicSlippage : 1 - dynamicSlippage);
  const structuralStop = side === 'LONG' ? analysis.localLow4H : analysis.localHigh4H;
  let stopLoss = side === 'LONG' ? Math.min(structuralStop, entryPrice - analysis.atr * 1.5) : Math.max(structuralStop, entryPrice + analysis.atr * 1.5);
  let riskDistance = Math.abs(entryPrice - stopLoss);
  let stopPercent = riskDistance / entryPrice * 100;
  if (stopPercent < 0.5) { stopLoss = side === 'LONG' ? entryPrice * 0.995 : entryPrice * 1.005; riskDistance = Math.abs(entryPrice - stopLoss); stopPercent = 0.5; }
  if (!Number.isFinite(stopPercent) || stopPercent > 10) return null;
  return { side, setup: setup.signal?.setup || '4H_MOMENTUM', signalIndex, entryIndex: signalIndex + 1, entryPrice, stopLoss, target1: side === 'LONG' ? entryPrice + riskDistance : entryPrice - riskDistance, takeProfit: side === 'LONG' ? entryPrice + riskDistance * 3 : entryPrice - riskDistance * 3, riskDistance, stopPercent, partialTaken: false, remainingFraction: 1, realizedGrossPercent: 0, entryDate: entryCandle.date };
}

function closePosition(position, candle, exitIndex, rawExit, reason, options) {
  const exitSlippage = options.slippagePercent / 100;
  const exitPrice = rawExit * (position.side === 'LONG' ? 1 - exitSlippage : 1 + exitSlippage);
  const remainingMovePercent = position.side === 'LONG' ? (exitPrice - position.entryPrice) / position.entryPrice * 100 : (position.entryPrice - exitPrice) / position.entryPrice * 100;
  const grossPercent = position.realizedGrossPercent + remainingMovePercent * position.remainingFraction;
  const tradingFees = options.feePercent * 2;
  const fundingPeriods = Math.floor((exitIndex - position.entryIndex) / 2);
  const fundingPercent = fundingPeriods * options.fundingRate * 100 * (position.side === 'LONG' ? -1 : 1);
  const netPercent = grossPercent - tradingFees + fundingPercent;
  return { type: position.side, setup: position.setup, entryDate: position.entryDate, exitDate: candle.date, entryPrice: round(position.entryPrice), exitPrice: round(exitPrice), stopLoss: round(position.stopLoss), takeProfit: round(position.takeProfit), result: reason, grossPercent: round(grossPercent, 3), costsPercent: round(tradingFees - fundingPercent, 3), pnlPercent: round(netPercent, 3), rMultiple: round(netPercent / position.stopPercent, 2), durationCandles: exitIndex - position.entryIndex };
}

function buildMetrics(trades, options) {
  let equity = options.initialCapital; let peak = equity; let maxDrawdown = 0; let grossProfit = 0; let grossLoss = 0;
  const equityCurve = [{ trade: 0, equity: round(equity, 2) }];
  trades.forEach((trade, index) => {
    const pnl = equity * (options.riskPercent / 100) * trade.rMultiple;
    equity += pnl; peak = Math.max(peak, equity); maxDrawdown = Math.max(maxDrawdown, (peak - equity) / peak * 100);
    if (pnl >= 0) grossProfit += pnl; else grossLoss += Math.abs(pnl);
    equityCurve.push({ trade: index + 1, equity: round(equity, 2), pnl: round(pnl, 2) });
  });
  const wins = trades.filter(t => t.pnlPercent > 0).length; const losses = trades.length - wins;
  const bySetup = Object.fromEntries([...new Set(trades.map(trade => trade.setup))].map(name => { const sample = trades.filter(trade => trade.setup === name); const setupWins = sample.filter(trade => trade.pnlPercent > 0).length; return [name, { trades: sample.length, winRate: round(setupWins / sample.length * 100, 1), avgRMultiple: round(sample.reduce((sum, trade) => sum + trade.rMultiple, 0) / sample.length, 2), expectancyPercent: round(sample.reduce((sum, trade) => sum + trade.pnlPercent, 0) / sample.length, 3) }]; }));
  return { metrics: { totalTrades: trades.length, wins, losses, winRate: trades.length ? round(wins / trades.length * 100, 1) : 0, profitFactor: grossLoss ? round(grossProfit / grossLoss, 2) : grossProfit ? 99 : 0, totalReturnPercent: round((equity - options.initialCapital) / options.initialCapital * 100, 2), maxDrawdownPercent: round(maxDrawdown, 2), avgRMultiple: trades.length ? round(trades.reduce((sum, trade) => sum + trade.rMultiple, 0) / trades.length, 2) : 0, expectancyPercent: trades.length ? round(trades.reduce((sum, trade) => sum + trade.pnlPercent, 0) / trades.length, 3) : 0, totalCostsPercent: round(trades.reduce((sum, trade) => sum + trade.costsPercent, 0), 3), bySetup }, equityCurve };
}

function runBacktestOnCandles(candles, rawOptions = {}, context = {}) {
  const options = { ...DEFAULTS, ...rawOptions }; const trades = []; let position = null;
  if (!Number.isFinite(options.riskPercent) || options.riskPercent <= 0 || options.riskPercent > 5) throw new Error('Risco do backtest deve estar entre 0 e 5%.');
  if (!Number.isFinite(options.feePercent) || options.feePercent < 0 || options.feePercent > 1 || !Number.isFinite(options.slippagePercent) || options.slippagePercent < 0 || options.slippagePercent > 1) throw new Error('Taxas e slippage devem estar entre 0 e 1%.');
  if (!Array.isArray(candles) || candles.length < 220) throw new Error('Histórico insuficiente: são necessários pelo menos 220 candles de 4H.');
  const startTradingIndex = Math.max(200, Number(options.startTradingIndex) || 200);
  for (let index = startTradingIndex; index < candles.length; index += 1) {
    const candle = candles[index];
    if (position) {
      const stopHit = position.side === 'LONG' ? candle.low <= position.stopLoss : candle.high >= position.stopLoss;
      const targetHit = position.side === 'LONG' ? candle.high >= position.takeProfit : candle.low <= position.takeProfit;
      if (stopHit || targetHit) {
        const reason = stopHit ? (targetHit ? 'LOSS_AMBIGUOUS_CANDLE' : 'LOSS_STOP') : 'WIN_TARGET';
        trades.push(closePosition(position, candle, index, stopHit ? position.stopLoss : position.takeProfit, reason, options)); position = null;
      } else {
        const firstTargetHit = !position.partialTaken && (position.side === 'LONG' ? candle.high >= position.target1 : candle.low <= position.target1);
        if (firstTargetHit) { position.realizedGrossPercent = position.stopPercent * 0.5; position.remainingFraction = 0.5; position.partialTaken = true; position.stopLoss = position.entryPrice; }
        if (position.partialTaken) {
          const currentAtr = analyze4H(candles.slice(0, index + 1), candle.close).atr;
          if (Number.isFinite(currentAtr)) position.stopLoss = position.side === 'LONG' ? Math.max(position.stopLoss, candle.close - currentAtr * 2) : Math.min(position.stopLoss, candle.close + currentAtr * 2);
        }
      }
      continue;
    }
    if (index >= candles.length - 1) continue;
    const setup = entrySetup(candles.slice(0, index + 1), context);
    if (setup) position = createPosition(setup, index, candles[index + 1], options);
  }
  if (position) trades.push(closePosition(position, candles.at(-1), candles.length - 1, candles.at(-1).close, 'CLOSED_END_OF_DATA', options));
  const results = buildMetrics(trades, options);
  return { timeframe: context.monthlyCandles ? '1M → 1W → 1D → 4H → 1H' : '4H', testedCandles: candles.length, assumptions: { entry: 'Abertura do candle seguinte ao sinal', sameCandleConflict: 'Stop priorizado', usesClosedCandlesOnly: true, sequentialTimeframes: Boolean(context.monthlyCandles), ...options }, metrics: results.metrics, trades: trades.slice(-50).reverse().map((trade, index) => ({ id: trades.length - index, ...trade })), equityCurve: results.equityCurve };
}

async function runBacktest(symbol, candleCount = 500, options = {}) {
  const cleanSymbol = symbol.toUpperCase().replace('/', '').trim();
  const requested = Math.min(Math.max(Number(candleCount) || 500, 220), 25000);
  const [candles, weeklyCandles, monthlyCandles, dailyCandles, hourlyCandles] = await Promise.all([getHistoricalKlines(cleanSymbol, '4h', requested), getKlines(cleanSymbol, '1w', 260), getKlines(cleanSymbol, '1M', 60), getHistoricalKlines(cleanSymbol, '1d', Math.min(Math.ceil(requested / 6) + 250, 5000)), getHistoricalKlines(cleanSymbol, '1h', Math.min(requested * 4, 25000))]);
  const result = runBacktestOnCandles(candles, options, { weeklyCandles, monthlyCandles, dailyCandles, hourlyCandles, strategyConfig: options.strategyConfig, strategyProfile: options.strategyProfile });
  return { symbol: cleanSymbol, dateRange: { from: candles[0].date, to: candles.at(-1).date }, ...result };
}

/**
 * v2.0: Enhanced walk-forward with true out-of-sample testing
 * - Default 15,000 candles (≈2 years of 4H data)
 * - 50% warmup + sequential OOS folds
 * - Approval: ≥75% profitable folds, ≥20 trades, positive avg return, max DD ≤15%
 * - True OOS: training period strictly separated from test period
 */
async function runWalkForward(symbol, candleCount = 15000, folds = 5, options = {}) {
  const cleanSymbol = symbol.toUpperCase().replace('/', '').trim();
  const count = Math.min(Math.max(Number(candleCount) || 15000, 1000), 25000);
  const foldCount = Math.min(Math.max(Number(folds) || 5, 2), 10);
  const [candles, weeklyCandles, monthlyCandles, dailyCandles, hourlyCandles] = await Promise.all([
    getHistoricalKlines(cleanSymbol, '4h', count),
    getKlines(cleanSymbol, '1w', 260),
    getKlines(cleanSymbol, '1M', 60),
    getHistoricalKlines(cleanSymbol, '1d', Math.min(Math.ceil(count / 6) + 250, 5000)),
    getHistoricalKlines(cleanSymbol, '1h', Math.min(count * 4, 25000))
  ]);
  if (candles.length < 1000) throw new Error('Histórico insuficiente para walk-forward expandido. São necessários pelo menos 1000 candles de 4H.');

  // v2.0: 50% warmup (training), 50% OOS (testing in folds)
  const trainingEnd = Math.floor(candles.length * 0.5);
  const oosSize = candles.length - trainingEnd;
  const foldSize = Math.floor(oosSize / foldCount);
  const results = [];

  for (let fold = 0; fold < foldCount; fold += 1) {
    const start = trainingEnd + fold * foldSize;
    const end = fold === foldCount - 1 ? candles.length : start + foldSize;
    // Each fold runs on ALL data up to its end (respects temporal ordering)
    // but only trades within the fold's OOS window are counted
    const result = runBacktestOnCandles(candles.slice(0, end), {
      ...options,
      startTradingIndex: start
    }, { weeklyCandles, monthlyCandles, dailyCandles, hourlyCandles, strategyConfig: options.strategyConfig, strategyProfile: options.strategyProfile });
    results.push({
      fold: fold + 1,
      from: candles[start]?.date || 'N/A',
      to: candles[end - 1]?.date || 'N/A',
      candlesInFold: end - start,
      metrics: result.metrics
    });
  }

  const profitableFolds = results.filter(item => item.metrics.totalReturnPercent > 0).length;
  const averageReturnPercent = round(results.reduce((sum, item) => sum + item.metrics.totalReturnPercent, 0) / foldCount, 2);
  const worstDrawdownPercent = round(Math.max(...results.map(item => item.metrics.maxDrawdownPercent)), 2);
  const totalTrades = results.reduce((sum, item) => sum + item.metrics.totalTrades, 0);
  const avgWinRate = round(results.reduce((sum, item) => sum + item.metrics.winRate, 0) / foldCount, 1);

  return {
    symbol: cleanSymbol,
    methodology: '50% warmup + validação sequencial fora da amostra (v2.0 expandido)',
    totalCandles: candles.length,
    trainingCandles: trainingEnd,
    oosCandles: oosSize,
    folds: results,
    summary: {
      profitableFolds,
      totalFolds: foldCount,
      averageReturnPercent,
      worstDrawdownPercent,
      totalTrades,
      avgWinRate,
      approved: profitableFolds / foldCount >= 0.75 && totalTrades >= 20 && averageReturnPercent > 0 && worstDrawdownPercent <= 15
    }
  };
}

module.exports = { runBacktest, runWalkForward, runBacktestOnCandles, entrySetup };
