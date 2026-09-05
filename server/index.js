require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const { DEFAULT_SYMBOLS, getKlines, getTicker24h, getMultiTimeframeData, getFundingRate, getAggTrades } = require("./binanceService");
const { calculateCVD, calculateVolumeProfile, analyzeMonthly, analyzeWeekly, analyzeDaily, analyze4H, analyze1H, evaluateMultiTimeframeSignal } = require("./technicalEngine");
const { calculateTradeParameters, calculatePositionSize, evaluateTradeRisk } = require("./riskEngine");
const { generateAIReport } = require("./aiAnalyst");
const { runBacktest, runWalkForward } = require("./backtestEngine");
const { getPublicConfig, saveConfig, testConnection, sendTelegramMessage, dispatchTradeAlertIfQualified, detectChatIdFromUpdates } = require("./telegramService");
const { createBinanceOrder } = require("./tradeService");
const { initDB, logSignal, getSignals, getTrades, updateTrade, getPerformanceStats, saveValidation, getValidations, isSymbolApproved, createPriceAlert, getPriceAlerts, triggerPriceAlert, deletePriceAlert } = require("./dbService");
const { isAlertTriggered } = require("./alertService");
const { initPriceStream, getCachedTicker, getStreamStatus } = require("./websocketService");
const { openPaperTrade, closePaperTrade, updateTradeManagement } = require("./paperTradingService");
const { getMarketLeaders } = require("./marketSelector");
const { calibrateSymbol } = require("./calibrationService");
const { getAIStatus, enhanceAnalysis } = require("./aiService");
const { analyzeInfluence } = require("./influenceService");
const { getNewsContext } = require("./newsService");
const { shouldLogSignal } = require("./automationState");
const { calculatePortfolioSnapshot } = require("./portfolioService");
const { buildJournalAnalytics, tradesToCsv } = require("./journalService");
const { assessSignalReadiness } = require("./signalReadinessService");
const { getGlobalHeatmap } = require("./edgeAnalysisService");

// ─── v2.0 New Services ──────────────────────────────────
const { analyzeMicrostructure, getFundingSpread, estimateLiquidationClusters, detectCVDDivergence, getCrossAssetContext } = require("./microstructureService");
const { optimizeStrategy, runGridSearch, runRandomSearch } = require("./strategyOptimizer");
const { getHealthReport, startMonitoring, stopMonitoring, log: healthLog, checkServices } = require("./healthService");
const { updateReadiness, addAlertRule, removeAlertRule, getAlertRules, getReadinessStates, formatAlert } = require("./readinessAlertService");
const { cacheStats } = require("./cacheService");
const { clearIndicatorCache } = require("./technicalEngine");

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "default_secret";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const LIVE_TRADING_ENABLED = process.env.LIVE_TRADING_ENABLED === "true";
const DEMO_MODE = process.env.DEMO_MODE === "true";
const SIGNAL_MONITOR_ENABLED = process.env.SIGNAL_MONITOR_ENABLED !== "false";
const SIGNAL_SCAN_INTERVAL_MS = Math.max(30, Number(process.env.SIGNAL_SCAN_INTERVAL_SECONDS || 60)) * 1000;

// Initialize SQLite database
initDB();
healthLog('INFO', 'Server starting', { port: PORT });

app.disable("x-powered-by");
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || false }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "../public"), { etag: false, maxAge: 0, setHeaders: response => response.setHeader('Cache-Control', 'no-store') }));

const cookieValue = (req, name) => String(req.headers.cookie || '').split(';').map(item => item.trim()).find(item => item.startsWith(`${name}=`))?.slice(name.length + 1);
const requestTokens = req => {
  const authorization = req.headers["authorization"];
  return [...new Set([authorization?.startsWith("Bearer ") ? authorization.slice(7) : null, cookieValue(req, 'crypto_session')].filter(Boolean))];
};
const setSessionCookie = (res, token) => res.cookie('crypto_session', token, { httpOnly: true, sameSite: 'lax', secure: false, maxAge: 24 * 60 * 60 * 1000, path: '/' });
const verifyToken = (req, res, next) => {
  const tokens = requestTokens(req);
  if (!tokens.length) return res.status(403).json({ success: false, error: "Sessão requerida" });
  for (const token of tokens) {
    try { req.user = jwt.verify(token, JWT_SECRET); return next(); } catch (error) {}
  }
  res.status(401).json({ success: false, error: "Sessão expirada" });
};

const loginAttempts = new Map();
const safeEqual = (left, right) => { const a = Buffer.from(String(left)); const b = Buffer.from(String(right)); return a.length === b.length && crypto.timingSafeEqual(a, b); };
const issueAccessToken = () => jwt.sign({ user: "admin", mode: DEMO_MODE ? "demo" : "protected" }, JWT_SECRET, { expiresIn: "24h" });
let automationRunning = false;
let automationSnapshot = { status: SIGNAL_MONITOR_ENABLED ? 'STARTING' : 'STOPPED', updatedAt: null, nextRunAt: null, scanCount: 0, confirmedSignals: 0, opportunities: [], errors: [] };
const previousAutomatedActions = new Map();

async function buildScanItem(symbol) {
  const data = await getMultiTimeframeData(symbol); const ticker = getCachedTicker(symbol) || data.ticker;
  const monthly = analyzeMonthly(data.candles1M, ticker.lastPrice); const weekly = analyzeWeekly(data.candles1W, ticker.lastPrice); const daily = analyzeDaily(data.candles1D, ticker.lastPrice); const fourHour = analyze4H(data.candles4H, ticker.lastPrice); const oneHour = analyze1H(data.candles1H, ticker.lastPrice);
  const signal = evaluateMultiTimeframeSignal(monthly, weekly, daily, fourHour, oneHour, ticker); const tradeParams = calculateTradeParameters(signal, fourHour, weekly);
  const readiness = assessSignalReadiness({ signal, monthly, weekly, daily, fourHour, oneHour });
  return { symbol, price: ticker.lastPrice, change24h: ticker.priceChangePercent, volume24h: ticker.quoteVolume, action: signal.action, score: signal.score, readiness, setup: signal.setup, bias1M: monthly.bias, structure1W: weekly.structure, bias1D: daily.bias, trigger1H: oneHour.trigger, rsi4H: fourHour.rsi ? Number(fourHour.rsi.toFixed(1)) : 50, stopPercent: tradeParams.stopPercent, blockedLong: signal.blockedLong, blockedShort: signal.blockedShort, suggestedLeverage: tradeParams.suggestedLeverage, evidence: signal.evidence };
}

async function runAutomatedScan() {
  if (automationRunning) return;
  automationRunning = true;
  try {
    const results = await Promise.allSettled(DEFAULT_SYMBOLS.map(buildScanItem));
    const opportunities = results.filter(item => item.status === 'fulfilled').map(item => item.value).sort((a, b) => b.score - a.score);
    const errors = results.map((item, index) => item.status === 'rejected' ? { symbol: DEFAULT_SYMBOLS[index], error: item.reason.message } : null).filter(Boolean);
    automationSnapshot = { status: errors.length === DEFAULT_SYMBOLS.length ? 'DEGRADED' : 'RUNNING', updatedAt: new Date().toISOString(), nextRunAt: new Date(Date.now() + SIGNAL_SCAN_INTERVAL_MS).toISOString(), scanIntervalSeconds: SIGNAL_SCAN_INTERVAL_MS / 1000, scanCount: Number(automationSnapshot.scanCount || 0) + 1, confirmedSignals: opportunities.filter(item => item.action !== 'AGUARDAR').length, opportunities, errors };

    // v2.0: Update readiness alerts for each symbol
    for (const item of opportunities) {
      const readinessAlerts = updateReadiness(item.symbol, item.readiness);
      for (const alert of readinessAlerts) {
        healthLog('INFO', 'Readiness alert fired', { symbol: item.symbol, status: alert.status, direction: alert.direction });
      }
    }

    for (const item of opportunities) {
      const previous = previousAutomatedActions.get(item.symbol);
      if (shouldLogSignal(previous, item.action)) await logSignal({ symbol: item.symbol, action: item.action, score: item.score, price: item.price, setup: item.setup, source: 'AUTOMATION', timeframe: '1M→1W→1D→4H→1H', evidence: item.evidence }).catch(err => { console.error("DB Error:", err); healthLog('ERROR', 'Signal log failed', { error: err.message }); });
      previousAutomatedActions.set(item.symbol, item.action);
    }
    healthLog('INFO', 'Automated scan completed', { count: opportunities.length, confirmed: automationSnapshot.confirmedSignals });
  } finally { automationRunning = false; }
}

// ─── Auth Routes ────────────────────────────────────────

app.post("/api/auth/login", (req, res) => {
  const key = req.ip; const attempt = loginAttempts.get(key) || { count: 0, resetAt: Date.now() + 5 * 60 * 1000 };
  if (Date.now() > attempt.resetAt) { attempt.count = 0; attempt.resetAt = Date.now() + 5 * 60 * 1000; }
  const { password } = req.body;
  if (!ADMIN_PASSWORD) return res.status(503).json({ success: false, error: "ADMIN_PASSWORD não configurada" });
  if (safeEqual(password, ADMIN_PASSWORD)) {
    loginAttempts.delete(key);
    const token = issueAccessToken();
    setSessionCookie(res, token);
    return res.json({ success: true, token });
  }
  if (attempt.count >= 10) return res.status(429).json({ success: false, error: "Muitas tentativas incorretas. Aguarde 5 minutos ou use a senha correta." });
  attempt.count += 1; loginAttempts.set(key, attempt); res.status(401).json({ success: false, error: "Senha incorreta" });
});

app.post("/api/auth/demo", (req, res) => {
  if (!DEMO_MODE) return res.status(404).json({ success: false, error: "Modo demonstrativo desativado." });
  loginAttempts.delete(req.ip);
  const token = issueAccessToken(); setSessionCookie(res, token);
  res.json({ success: true, token, mode: 'DEMO' });
});

app.get("/api/auth/demo-access", (req, res) => {
  if (!DEMO_MODE) return res.redirect('/?login=disabled');
  const token = issueAccessToken(); setSessionCookie(res, token); loginAttempts.delete(req.ip);
  res.redirect('/?session=demo');
});

app.get("/api/auth/session", verifyToken, (req, res) => {
  const token = issueAccessToken(); setSessionCookie(res, token);
  res.json({ success: true, token, mode: req.user.mode || 'protected' });
});

app.post("/api/auth/logout", (req, res) => {
  res.clearCookie('crypto_session', { path: '/' });
  res.json({ success: true });
});

// ─── Trading ────────────────────────────────────────────

app.post("/api/trade/execute", verifyToken, async (req, res) => {
  if (!LIVE_TRADING_ENABLED) return res.status(423).json({ success: false, error: "Execução real bloqueada. Use paper trading durante a validação." });
  try { const { tradeParams } = req.body; const apiKey = process.env.BINANCE_API_KEY; const apiSecret = process.env.BINANCE_API_SECRET; if (!apiKey || !apiSecret) return res.status(503).json({ success: false, error: "Credenciais da Binance não configuradas no servidor." }); const result = await createBinanceOrder(apiKey, apiSecret, tradeParams); res.json(result); }
  catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ─── Health & System ────────────────────────────────────

app.get("/api/health", async (req, res) => {
  try {
    const report = await getHealthReport();
    res.json({ success: true, ...report });
  } catch (err) {
    res.json({ success: true, engineStatus: 'RESEARCH', uptimeSeconds: Math.round(process.uptime()), stream: getStreamStatus(), ai: getAIStatus(), liveTradingEnabled: LIVE_TRADING_ENABLED, demoMode: DEMO_MODE, signalMonitorEnabled: SIGNAL_MONITOR_ENABLED, scanIntervalSeconds: SIGNAL_SCAN_INTERVAL_MS / 1000 });
  }
});

app.get("/api/health/services", verifyToken, async (req, res) => {
  try { const services = await checkServices(); res.json({ success: true, data: services }); }
  catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get("/api/health/logs", verifyToken, (req, res) => {
  try { const { getRecentLogs } = require("./healthService"); const logs = getRecentLogs(req.query.level, Number(req.query.limit) || 50); res.json({ success: true, data: logs }); }
  catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get("/api/health/cache", verifyToken, (req, res) => {
  try { res.json({ success: true, data: cacheStats() }); }
  catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ─── Market Data ────────────────────────────────────────

app.get("/api/market/leaders", async (req, res) => {
  try { res.json({ success: true, data: await getMarketLeaders({ minQuoteVolume: Number(req.query.minVolume) || 50000000, limit: Math.min(Number(req.query.limit) || 20, 50) }) }); }
  catch (err) { res.status(502).json({ success: false, error: err.message }); }
});

app.get("/api/funding/:symbol", async (req, res) => {
  try { const symbol = req.params.symbol.toUpperCase(); const data = await getFundingRate(symbol); res.json({ success: data.success, data }); }
  catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get("/api/ticker/:symbol", async (req, res) => {
  try { const symbol = req.params.symbol.toUpperCase(); if (!/^[A-Z0-9]{5,15}$/.test(symbol)) return res.status(400).json({ success: false, error: 'Símbolo inválido.' }); const data = getCachedTicker(symbol) || await getTicker24h(symbol); if (!Number.isFinite(data.lastPrice)) throw new Error('Preço indisponível.'); res.json({ success: true, symbol, data }); }
  catch (err) { res.status(502).json({ success: false, error: err.message }); }
});

// ─── v2.0 Microstructure Endpoint ───────────────────────

app.get("/api/microstructure/:symbol", verifyToken, async (req, res) => {
  try {
    const symbol = req.params.symbol.toUpperCase();
    const ticker = getCachedTicker(symbol) || await getTicker24h(symbol);
    const fundingData = await getFundingRate(symbol);
    const [fundingSpread, liquidationClusters, crossAsset] = await Promise.allSettled([
      getFundingSpread(symbol),
      estimateLiquidationClusters(symbol, ticker, fundingData),
      getCrossAssetContext(symbol)
    ]);
    res.json({
      success: true,
      symbol,
      fundingSpread: fundingSpread.status === 'fulfilled' ? fundingSpread.value : null,
      liquidationClusters: liquidationClusters.status === 'fulfilled' ? liquidationClusters.value : null,
      crossAsset: crossAsset.status === 'fulfilled' ? crossAsset.value : null
    });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ─── v2.0 Strategy Optimizer ────────────────────────────

app.post("/api/optimizer/run", verifyToken, async (req, res) => {
  try {
    const symbol = String(req.body.symbol || 'SOLUSDT').toUpperCase();
    const iterations = Math.min(Number(req.body.iterations) || 50, 200);
    const fetchCandles = async (sym) => {
      const [candles4H, weeklyCandles, monthlyCandles, dailyCandles, hourlyCandles] = await Promise.all([
        require('./binanceService').getHistoricalKlines(sym, '4h', 15000),
        require('./binanceService').getKlines(sym, '1w', 260),
        require('./binanceService').getKlines(sym, '1M', 60),
        require('./binanceService').getHistoricalKlines(sym, '1d', 2500),
        require('./binanceService').getHistoricalKlines(sym, '1h', 25000)
      ]);
      return { candles4H, weeklyCandles, monthlyCandles, dailyCandles, hourlyCandles };
    };
    const result = await optimizeStrategy(symbol, fetchCandles, { iterations, walkForwardFolds: Number(req.body.folds) || 5 });
    res.json({ success: true, data: result });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ─── Analysis ───────────────────────────────────────────

app.get("/api/analysis/:symbol", async (req, res) => {
  try {
    const symbol = req.params.symbol.toUpperCase();
    const [data, trades, fundingData, leaders, btcTicker, news] = await Promise.all([getMultiTimeframeData(symbol), getAggTrades(symbol), getFundingRate(symbol), getMarketLeaders({ limit: 50 }), getTicker24h('BTCUSDT'), getNewsContext(symbol)]);
    if (!data.ticker || !Number.isFinite(data.ticker.lastPrice) || data.candles4H.length < 30) throw new Error("Dados insuficientes recebidos da Binance");
    const ticker = getCachedTicker(symbol) || data.ticker;
    const cvd = calculateCVD(trades);
    const vp = calculateVolumeProfile(trades);
    const marketPosition = leaders.find(item => item.symbol === symbol);
    const extraData = { cvd, volumeProfile: vp, fundingRate: fundingData, marketRank: marketPosition?.rank };
    const monthly = analyzeMonthly(data.candles1M, ticker.lastPrice);
    const weekly = analyzeWeekly(data.candles1W, ticker.lastPrice);
    const daily = analyzeDaily(data.candles1D, ticker.lastPrice);
    const fourHour = analyze4H(data.candles4H, ticker.lastPrice);
    const oneHour = analyze1H(data.candles1H, ticker.lastPrice);
    const signal = evaluateMultiTimeframeSignal(monthly, weekly, daily, fourHour, oneHour, ticker, extraData);
    signal.readiness = assessSignalReadiness({ signal, monthly, weekly, daily, fourHour, oneHour });
    const tradeParams = calculateTradeParameters(signal, fourHour, weekly);
    const influence = analyzeInfluence({ symbol, ticker, btcTicker, leaders, cvd, funding: fundingData, news, monthly, weekly, daily, fourHour, oneHour });

    if (signal.action !== "AGUARDAR") await logSignal({ symbol, action: signal.action, score: signal.score, price: ticker.lastPrice, conviction: signal.conviction, cvd_delta: cvd.netDelta, poc: vp.poc, funding_rate: fundingData.fundingRate || 0, evidence: signal.evidence }).catch(err => { console.error("DB Error:", err); healthLog('ERROR', 'Signal log failed', { symbol, error: err.message }); });
    const aiReport = generateAIReport({ symbol, ticker, monthly, weekly, daily, fourHour, oneHour, signal, tradeParams });
    const aiEnhancement = await enhanceAnalysis({ symbol, price: ticker.lastPrice, change24h: ticker.priceChangePercent, influence, monthly: { bias: monthly.bias, rsi: monthly.rsi }, weekly: { structure: weekly.structure, rsi: weekly.rsi }, daily: { bias: daily.bias, rsi: daily.rsi, adx: daily.adx }, fourHour: { structure: fourHour.structure, rsi: fourHour.rsi, adx: fourHour.adx, volumeRatio: fourHour.volumeRatio, macdHist: fourHour.macdHist }, oneHour: { trigger: oneHour.trigger, rsi: oneHour.rsi, volumeRatio: oneHour.volumeRatio }, signal: { action: signal.action, score: signal.score, setup: signal.setup, warnings: signal.warnings, confluences: signal.confluences }, risk: tradeParams }, aiReport.technicalAnalysis);
    aiReport.technicalAnalysis = aiEnhancement.text; aiReport.provider = aiEnhancement.provider; aiReport.model = aiEnhancement.model; aiReport.providerError = aiEnhancement.error;

    // v2.0: Update readiness alerts
    updateReadiness(symbol, signal.readiness);

    res.json({ success: true, symbol, ticker, marketPosition: marketPosition || null, monthly, weekly, daily, fourHour, oneHour, signal, tradeParams, influence, aiReport, readiness: signal.readiness, timeframeCandles: { "1h": data.candles1H.slice(-180), "4h": data.candles4H.slice(-180), "1d": data.candles1D.slice(-180), "1w": data.candles1W.slice(-120) }, recentCandles4H: data.candles4H.slice(-60), orderFlow: { cvd, vp, fundingRate: fundingData.fundingRate || 0 } });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get("/api/candles/:symbol/:interval", async (req, res) => {
  try { const symbol = req.params.symbol.toUpperCase(); const interval = req.params.interval; const limit = parseInt(req.query.limit) || 75; const candles = await getKlines(symbol, interval, limit); res.json({ success: true, symbol, interval, data: candles }); }
  catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get("/api/scan", async (req, res) => {
  try { const symbolsParam = req.query.symbols; const symbols = symbolsParam ? symbolsParam.split(",").map(s => s.trim().toUpperCase()).filter(s => /^[A-Z0-9]{5,15}$/.test(s)).slice(0, 15) : DEFAULT_SYMBOLS; const results = await Promise.allSettled(symbols.map(buildScanItem)); const scanList = results.filter(r => r.status === "fulfilled").map(r => r.value).sort((a, b) => b.score - a.score); res.json({ success: true, count: scanList.length, data: scanList }); }
  catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get("/api/automation/status", (req, res) => res.json({ success: true, data: automationSnapshot }));

app.post("/api/automation/run", verifyToken, async (req, res) => {
  if (!SIGNAL_MONITOR_ENABLED) return res.status(409).json({ success: false, error: 'Monitor de sinais desativado.' });
  if (automationRunning) return res.status(202).json({ success: true, message: 'Varredura já está em andamento.', data: automationSnapshot });
  try { await runAutomatedScan(); res.json({ success: true, message: 'Varredura concluída.', data: automationSnapshot }); }
  catch (error) { res.status(502).json({ success: false, error: error.message }); }
});

app.post("/api/calculator", (req, res) => {
  try { const { walletBalance, riskPercent, entryPrice, stopLoss, leverage } = req.body; const result = calculatePositionSize({ walletBalance, riskPercent, entryPrice, stopLoss, leverage }); if (!result) return res.status(400).json({ success: false, error: "Parâmetros inválidos." }); res.json({ success: true, data: result }); }
  catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ─── Backtest & Validation ──────────────────────────────

app.get("/api/backtest/:symbol", async (req, res) => {
  try { const symbol = req.params.symbol.toUpperCase(); const candleCount = parseInt(req.query.candles) || 500; const backtestResult = await runBacktest(symbol, candleCount, { riskPercent: Number(req.query.risk) || 1, feePercent: Number(req.query.fee) || 0.04, slippagePercent: Number(req.query.slippage) || 0.02, fundingRate: Number(req.query.funding) || 0 }); res.json({ success: true, data: backtestResult }); }
  catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get("/api/validation/walk-forward/:symbol", verifyToken, async (req, res) => {
  try { const data = await runWalkForward(req.params.symbol, req.query.candles, req.query.folds, { riskPercent: Number(req.query.risk) || 1, feePercent: Number(req.query.fee) || 0.04, slippagePercent: Number(req.query.slippage) || 0.02 }); await saveValidation(data); res.json({ success: true, data }); }
  catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get("/api/validation/portfolio", verifyToken, async (req, res) => {
  try {
    const requested = String(req.query.symbols || 'BTCUSDT,ETHUSDT,SOLUSDT').split(',').map(item => item.trim().toUpperCase()).filter(item => /^[A-Z0-9]{5,15}$/.test(item)).slice(0, 5);
    const settled = await Promise.allSettled(requested.map(symbol => runWalkForward(symbol, req.query.candles || 750, req.query.folds || 3)));
    const data = settled.map((result, index) => result.status === 'fulfilled' ? result.value : { symbol: requested[index], error: result.reason.message }).sort((a, b) => Number(b.summary?.averageReturnPercent || -Infinity) - Number(a.summary?.averageReturnPercent || -Infinity));
    for (const result of data.filter(item => item.summary)) await saveValidation(result);
    res.json({ success: true, data });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post("/api/validation/calibrate/:symbol", verifyToken, async (req, res) => {
  try { const data = await calibrateSymbol(req.params.symbol, req.body.candles || 5000, { riskPercent: Number(req.body.risk) || 1, feePercent: Number(req.body.fee) || 0.04, slippagePercent: Number(req.body.slippage) || 0.02 }); await saveValidation(data); res.json({ success: true, data }); }
  catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get("/api/model/status", verifyToken, async (req, res) => {
  try { const validations = await getValidations(req.query.symbol ? String(req.query.symbol).toUpperCase() : undefined); const latest = Object.values(validations.reduce((items, item) => { items[item.symbol] ||= item; return items; }, {})); res.json({ success: true, engineStatus: latest.some(item => item.summary?.approved) ? 'PAPER_APPROVED_SYMBOLS' : 'RESEARCH', liveTradingEnabled: LIVE_TRADING_ENABLED, latest }); }
  catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ─── Paper Trading ──────────────────────────────────────

app.get("/api/paper/trades", verifyToken, async (req, res) => {
  try { res.json({ success: true, data: await getTrades({ status: req.query.status, limit: req.query.limit }) }); }
  catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get("/api/paper/portfolio", verifyToken, async (req, res) => {
  try {
    const trades = await getTrades({ status: 'OPEN', limit: 500 }); const prices = {};
    await Promise.all(trades.map(async trade => { const ticker = getCachedTicker(trade.symbol) || await getTicker24h(trade.symbol); prices[trade.symbol] = ticker.lastPrice; }));
    res.json({ success: true, data: calculatePortfolioSnapshot(trades, prices, { feePercent: Number(process.env.PAPER_FEE_PERCENT || 0.04), maxRiskPercent: Number(process.env.PAPER_MAX_TOTAL_RISK_PERCENT || 3), maxOpenTrades: Number(process.env.PAPER_MAX_OPEN_TRADES || 3) }) });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post("/api/paper/open", verifyToken, async (req, res) => {
  try {
    const symbol = String(req.body.symbol || '').toUpperCase();
    if (!/^[A-Z0-9]{5,15}$/.test(symbol)) return res.status(400).json({ success: false, error: 'Símbolo inválido.' });
    const [data, trades, fundingData] = await Promise.all([getMultiTimeframeData(symbol), getAggTrades(symbol), getFundingRate(symbol)]);
    if (!Number.isFinite(data.ticker.lastPrice)) throw new Error('Preço indisponível.');
    const ticker = getCachedTicker(symbol) || data.ticker; const cvd = calculateCVD(trades); const vp = calculateVolumeProfile(trades);
    const monthly = analyzeMonthly(data.candles1M, ticker.lastPrice); const weekly = analyzeWeekly(data.candles1W, ticker.lastPrice); const daily = analyzeDaily(data.candles1D, ticker.lastPrice); const fourHour = analyze4H(data.candles4H, ticker.lastPrice); const oneHour = analyze1H(data.candles1H, ticker.lastPrice);
    const signal = evaluateMultiTimeframeSignal(monthly, weekly, daily, fourHour, oneHour, ticker, { cvd, volumeProfile: vp, fundingRate: fundingData }); const tradeParams = calculateTradeParameters(signal, fourHour, weekly);
    const openTrades = await getTrades({ status: 'OPEN', limit: 500 });
    const riskCheck = evaluateTradeRisk({ symbol, entryPrice: ticker.lastPrice, stopLoss: tradeParams.stopLoss, riskPercent: Number(req.body.riskPercent) || 1 }, { equity: Number(req.body.walletBalance) || 1000, currentPositions: openTrades });
    if (!riskCheck.ok) return res.status(403).json({ success: false, error: `Risco Inválido: ${riskCheck.reason}` });
    const paperTrade = await openPaperTrade({ symbol, signal, tradeParams, walletBalance: req.body.walletBalance, riskPercent: req.body.riskPercent });
    res.status(201).json({ success: true, data: paperTrade });
  } catch (err) { res.status(400).json({ success: false, error: err.message }); }
});

app.post("/api/paper/close/:id", verifyToken, async (req, res) => {
  try {
    const openTrades = await getTrades({ status: 'OPEN', limit: 500 }); const trade = openTrades.find(item => item.id === req.params.id);
    if (!trade) return res.status(404).json({ success: false, error: 'Operação paper não encontrada.' });
    const ticker = getCachedTicker(trade.symbol) || await getTicker24h(trade.symbol);
    const closed = await closePaperTrade(trade.id, ticker.lastPrice, req.body.reason || 'MANUAL'); res.json({ success: true, data: closed });
  } catch (err) { res.status(400).json({ success: false, error: err.message }); }
});

// ─── Journal ────────────────────────────────────────────

app.get("/api/journal", verifyToken, async (req, res) => {
  try {
    const trades = await getTrades({ status: req.query.status, limit: req.query.limit || 100 });
    res.json({ success: true, data: trades, analytics: buildJournalAnalytics(trades) });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.patch("/api/journal/:id", verifyToken, async (req, res) => {
  try {
    const trades = await getTrades({ limit: 500 });
    if (!trades.some(trade => trade.id === req.params.id)) return res.status(404).json({ success: false, error: 'Operação não encontrada.' });
    const note = String(req.body.note || '').trim().slice(0, 1000);
    const tags = Array.isArray(req.body.tags) ? [...new Set(req.body.tags.map(tag => String(tag).trim().toLowerCase()).filter(Boolean))].slice(0, 10).map(tag => tag.slice(0, 30)) : [];
    const reviewStatus = req.body.reviewStatus === 'REVIEWED' ? 'REVIEWED' : 'IN_REVIEW';
    const trade = await updateTrade(req.params.id, { note, tags, reviewStatus, reviewed_at: reviewStatus === 'REVIEWED' ? new Date().toISOString() : null });
    res.json({ success: true, data: trade });
  } catch (err) { res.status(400).json({ success: false, error: err.message }); }
});

app.get("/api/journal/export.csv", verifyToken, async (req, res) => {
  try {
    const trades = await getTrades({ limit: 500 });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="crypto-trade-journal-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(`﻿${tradesToCsv(trades)}`);
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ─── Telegram ───────────────────────────────────────────

app.get("/api/telegram/config", verifyToken, (req, res) => { res.json({ success: true, data: getPublicConfig() }); });
app.post("/api/telegram/config", verifyToken, (req, res) => {
  try { const { botToken, chatId, autoAlertsEnabled, minScore } = req.body; const updateObj = {}; if (botToken) updateObj.botToken = botToken.trim(); if (chatId) updateObj.chatId = chatId.trim(); if (autoAlertsEnabled !== undefined) updateObj.autoAlertsEnabled = Boolean(autoAlertsEnabled); if (minScore) updateObj.minScore = parseInt(minScore) || 70; saveConfig(updateObj); res.json({ success: true, data: getPublicConfig() }); }
  catch (err) { res.status(500).json({ success: false, error: err.message }); }
});
app.post("/api/telegram/test", verifyToken, async (req, res) => {
  try { const { botToken, chatId } = req.body; const result = await testConnection(botToken, chatId); res.json({ success: true, message: "Enviado!", result }); }
  catch (err) { res.status(400).json({ success: false, error: err.message }); }
});
app.post("/api/telegram/send-alert", verifyToken, async (req, res) => {
  try { const { text } = req.body; const result = await sendTelegramMessage(text); res.json({ success: true, message: "Enviado!", result }); }
  catch (err) { res.status(400).json({ success: false, error: err.message }); }
});
app.get("/api/telegram/detect-chat", verifyToken, async (req, res) => {
  try { const result = await detectChatIdFromUpdates(); res.json({ success: true, data: result }); }
  catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ─── Performance & Signals ──────────────────────────────

app.get("/api/performance", async (req, res) => {
  try { const stats = await getPerformanceStats(); res.json({ success: true, data: stats }); }
  catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get("/api/analysis/heatmap", verifyToken, async (req, res) => {
  try { const heatmap = await getGlobalHeatmap(DEFAULT_SYMBOLS); res.json({ success: true, data: heatmap }); }
  catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get("/api/signals", verifyToken, async (req, res) => {
  try { res.json({ success: true, data: await getSignals({ symbol: req.query.symbol?.toUpperCase(), limit: req.query.limit }) }); }
  catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ─── v2.0 Readiness Alerts ──────────────────────────────

app.get("/api/readiness/states", verifyToken, (req, res) => {
  try { res.json({ success: true, data: getReadinessStates(req.query.symbol) }); }
  catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get("/api/readiness/rules", verifyToken, (req, res) => {
  try { res.json({ success: true, data: getAlertRules() }); }
  catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post("/api/readiness/rules", verifyToken, (req, res) => {
  try {
    const rule = addAlertRule({
      symbol: String(req.body.symbol || '*').toUpperCase(),
      minScore: Number(req.body.minScore) || 60,
      minStatus: String(req.body.minStatus || 'ARMADO'),
      direction: String(req.body.direction || 'ANY').toUpperCase(),
      cooldownMinutes: Number(req.body.cooldownMinutes) || 240,
      enabled: req.body.enabled !== false
    });
    res.status(201).json({ success: true, data: rule });
  } catch (err) { res.status(400).json({ success: false, error: err.message }); }
});

app.delete("/api/readiness/rules/:id", verifyToken, (req, res) => {
  try { const removed = removeAlertRule(req.params.id); res.json({ success: removed }); }
  catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ─── Price Alerts ───────────────────────────────────────

app.get("/api/alerts", verifyToken, async (req, res) => {
  try { res.json({ success: true, data: await getPriceAlerts({ status: req.query.status, symbol: req.query.symbol?.toUpperCase() }) }); }
  catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post("/api/alerts", verifyToken, async (req, res) => {
  try {
    const symbol = String(req.body.symbol || '').toUpperCase().trim(); const condition = String(req.body.condition || '').toUpperCase(); const price = Number(req.body.price);
    if (!/^[A-Z0-9]{5,15}$/.test(symbol)) return res.status(400).json({ success: false, error: 'Símbolo inválido.' });
    if (!['ABOVE', 'BELOW'].includes(condition)) return res.status(400).json({ success: false, error: 'Condição deve ser ABOVE ou BELOW.' });
    if (!Number.isFinite(price) || price <= 0) return res.status(400).json({ success: false, error: 'Preço do alerta inválido.' });
    const active = await getPriceAlerts({ status: 'ACTIVE', symbol });
    if (active.length >= 10) return res.status(409).json({ success: false, error: 'Limite de 10 alertas ativos por ativo.' });
    res.status(201).json({ success: true, data: await createPriceAlert({ symbol, condition, price }) });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.delete("/api/alerts/:id", verifyToken, async (req, res) => {
  try { const removed = await deletePriceAlert(req.params.id); res.status(removed ? 200 : 404).json({ success: removed, error: removed ? undefined : 'Alerta não encontrado.' }); }
  catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ─── Background Monitors ────────────────────────────────

const { checkCircuitBreaker } = require("./circuitBreaker");

setInterval(async () => {
  try { const cfg = getPublicConfig();
    const cb = await checkCircuitBreaker();
    if (cb.blocked) { healthLog('WARN', 'Circuit breaker active', { reason: cb.reason }); return; } if (!cfg.autoAlertsEnabled || !cfg.isConfigured) return; for (const sym of DEFAULT_SYMBOLS) { try { if (!(await isSymbolApproved(sym))) continue; const [data, trades, fundingData] = await Promise.all([ getMultiTimeframeData(sym), getAggTrades(sym), getFundingRate(sym) ]); const cvd = calculateCVD(trades); const vp = calculateVolumeProfile(trades); const extraData = { cvd, volumeProfile: vp, fundingRate: fundingData }; const ticker = getCachedTicker(sym) || data.ticker; const monthly = analyzeMonthly(data.candles1M, ticker.lastPrice); const weekly = analyzeWeekly(data.candles1W, ticker.lastPrice); const daily = analyzeDaily(data.candles1D, ticker.lastPrice); const fourHour = analyze4H(data.candles4H, ticker.lastPrice); const oneHour = analyze1H(data.candles1H, ticker.lastPrice);
    const signal = evaluateMultiTimeframeSignal(monthly, weekly, daily, fourHour, oneHour, ticker, extraData); if (signal.action !== "AGUARDAR" && signal.score >= cfg.minScore) { await logSignal({ symbol: sym, action: signal.action, score: signal.score, price: ticker.lastPrice, conviction: signal.conviction, cvd_delta: cvd.netDelta, poc: vp.poc, funding_rate: fundingData.fundingRate || 0 }).catch(err => console.error("DB Error:", err)); const tradeParams = calculateTradeParameters(signal, fourHour, weekly); const aiReport = generateAIReport({ symbol: sym, ticker, monthly, weekly, daily, fourHour, oneHour, signal, tradeParams }); let finalAlertText = aiReport.telegramAlert; if (signal.conviction === "ALTA") finalAlertText = "ALERTA DE ALPHA - ALTA CONVICÇÃO\n\n" + finalAlertText; await dispatchTradeAlertIfQualified(sym, signal.action, signal.score, finalAlertText); } } catch (e) { healthLog('ERROR', `Monitor error for ${sym}`, { error: e.message }); } }
  } catch (e) { healthLog('ERROR', 'Alert monitor error', { error: e.message }); }
}, 15 * 60 * 1000);

setInterval(async () => {
  try {
    const openTrades = await getTrades({ status: 'OPEN', limit: 500 });
    if (!openTrades.length) return;

    // Batch: fetch unique symbols' klines and tickers in parallel
    const uniqueSymbols = [...new Set(openTrades.map(t => t.symbol))];
    const [klinesResults, tickerResults] = await Promise.all([
      Promise.all(uniqueSymbols.map(sym => getKlines(sym, '4h', 100).then(c => [sym, c]))),
      Promise.all(uniqueSymbols.map(sym => (getCachedTicker(sym) || getTicker24h(sym)).then(t => [sym, t])))
    ]);
    const klinesMap = Object.fromEntries(klinesResults);
    const tickerMap = Object.fromEntries(tickerResults);

    for (const trade of openTrades) {
      const ticker = tickerMap[trade.symbol];
      const price = Number(ticker && ticker.lastPrice);
      if (!Number.isFinite(price)) continue;
      try {
        const candles = klinesMap[trade.symbol] || [];
        const analysis = analyze4H(candles, price);
        await updateTradeManagement(trade, price, analysis.atr);
      } catch (mgmtError) { console.warn(`Trade management failed for ${trade.symbol}:`, mgmtError.message); }
      const updatedTrade = (await getTrades({ status: 'OPEN', limit: 500 })).find(t => t.id === trade.id);
      const currentStop = updatedTrade ? updatedTrade.stopLoss : trade.stopLoss;
      const stopHit = trade.side === 'LONG' ? price <= currentStop : price >= currentStop;
      const targetHit = trade.side === 'LONG' ? price >= trade.takeProfit : price <= trade.takeProfit;
      if (stopHit || targetHit) await closePaperTrade(trade.id, price, stopHit ? 'STOP' : 'TARGET');
    }
  } catch (error) { healthLog('ERROR', 'Paper monitor error', { error: error.message }); }
}, 60 * 1000);

setInterval(async () => {
  try {
    const alerts = await getPriceAlerts({ status: 'ACTIVE' });
    const tickers = new Map();
    for (const alert of alerts) {
      if (!tickers.has(alert.symbol)) tickers.set(alert.symbol, getCachedTicker(alert.symbol) || await getTicker24h(alert.symbol));
      const marketPrice = Number(tickers.get(alert.symbol).lastPrice);
      if (isAlertTriggered(alert, marketPrice)) await triggerPriceAlert(alert.id, marketPrice);
    }
  } catch (error) { healthLog('ERROR', 'Price alert monitor error', { error: error.message }); }
}, 15 * 1000);

// ─── Startup ────────────────────────────────────────────

if (SIGNAL_MONITOR_ENABLED) {
  setTimeout(runAutomatedScan, 1500);
  setInterval(runAutomatedScan, SIGNAL_SCAN_INTERVAL_MS);
}

// v2.0: Start health monitoring
startMonitoring(30000);

app.use((req, res) => {
  if (req.method !== 'GET' || req.path.startsWith('/api/') || !req.accepts('html')) return res.status(404).json({ success: false, error: 'Rota não encontrada.' });
  res.sendFile(path.join(__dirname, '../public/index.html'), error => { if (error && !res.headersSent) res.status(404).end(); });
});

app.listen(PORT, "0.0.0.0", () => {
  if (JWT_SECRET === 'default_secret' || JWT_SECRET.length < 32) console.warn('SECURITY WARNING: configure a JWT_SECRET with at least 32 characters.');
  if (ADMIN_PASSWORD === 'admin123') console.warn('SECURITY WARNING: replace the default ADMIN_PASSWORD before exposing the service.');
  initPriceStream();
  healthLog('INFO', 'Server started successfully', { port: PORT, liveTrading: LIVE_TRADING_ENABLED, demoMode: DEMO_MODE });
  console.log("Server running on " + PORT);
});

process.on('uncaughtException', error => {
  healthLog('CRITICAL', 'Uncaught Exception', { error: error.message, stack: error.stack });
  console.error('CRITICAL: Uncaught Exception detected.', error);
});

process.on('unhandledRejection', error => {
  healthLog('ERROR', 'Unhandled Promise Rejection', { error: String(error) });
  console.error('WARNING: Unhandled Promise Rejection.', error);
});
