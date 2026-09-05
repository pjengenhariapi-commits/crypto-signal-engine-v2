const { calculatePositionSize } = require('./riskEngine');
const { logTrade, updateTrade, getTrades } = require('./dbService');
const { DEFAULT_STRATEGY_CONFIG } = require('./strategyConfig');

const PAPER_FEE_PERCENT = Number(process.env.PAPER_FEE_PERCENT || 0.04);
const PAPER_MAX_OPEN_TRADES = Number(process.env.PAPER_MAX_OPEN_TRADES || 3);
const PAPER_MAX_TOTAL_RISK_PERCENT = Number(process.env.PAPER_MAX_TOTAL_RISK_PERCENT || 3);

async function openPaperTrade({ symbol, signal, tradeParams, walletBalance, riskPercent }) {
  if (!signal || !['COMPRA', 'VENDA'].includes(signal.action)) throw new Error('O motor não possui sinal operável para este ativo.');
  if (!tradeParams || tradeParams.status !== signal.action) throw new Error('Parâmetros de risco inválidos.');
  const existing = await getTrades({ status: 'OPEN', limit: 500 });
  if (existing.some(trade => trade.symbol === symbol)) throw new Error(`Já existe uma operação paper aberta em ${symbol}.`);
  if (existing.length >= PAPER_MAX_OPEN_TRADES) throw new Error(`Limite de ${PAPER_MAX_OPEN_TRADES} operações paper simultâneas atingido.`);
  const sizing = calculatePositionSize(Number(walletBalance), Number(riskPercent), tradeParams.entryPrice, tradeParams.stopLoss);
  if (!sizing) throw new Error('Saldo, risco ou alavancagem inválidos. Risco máximo permitido: 5%.');
  const riskAmountUSD = sizing.riskAmount;
  const quantity = sizing.size;
  const positionValueUSD = quantity * tradeParams.entryPrice;
  const leverage = tradeParams.leverageValue || 10;
  const marginRequired = positionValueUSD / leverage;
  const totalRisk = existing.reduce((sum, trade) => sum + Number(trade.risk_amount_usd || 0), 0) + riskAmountUSD;
  if (totalRisk > Number(walletBalance) * PAPER_MAX_TOTAL_RISK_PERCENT / 100) throw new Error(`Risco agregado excede ${PAPER_MAX_TOTAL_RISK_PERCENT}% da banca.`);
  return logTrade({ mode: 'PAPER', symbol, side: signal.action === 'COMPRA' ? 'LONG' : 'SHORT', signalScore: signal.score, setup: signal.setup, walletBalance: Number(walletBalance), entryPrice: tradeParams.entryPrice, stopLoss: tradeParams.stopLoss, takeProfit: tradeParams.takeProfit1, quantity, positionValueUSD, marginRequired, riskAmountUSD, leverage });
}

async function closePaperTrade(id, exitPrice, reason = 'MANUAL') {
  const trades = await getTrades({ status: 'OPEN', limit: 500 });
  const trade = trades.find(item => item.id === id);
  const price = Number(exitPrice);
  if (!trade) throw new Error('Operação paper aberta não encontrada.');
  if (!Number.isFinite(price) || price <= 0) throw new Error('Preço de saída inválido.');
  // DB returns snake_case columns, so use trade.entry_price (not trade.entryPrice)
  const entryPrice = Number(trade.entry_price);
  const quantity = Number(trade.quantity);
  const marginRequired = Number(trade.margin_required) || (quantity * entryPrice / 10);
  const grossPnl = trade.side === 'LONG' ? (price - entryPrice) * quantity : (entryPrice - price) * quantity;
  const fees = (entryPrice + price) * quantity * (PAPER_FEE_PERCENT / 100);
  const pnl = grossPnl - fees;
  return updateTrade(id, { status: 'CLOSED', exitPrice: price, exitReason: reason, closeTime: new Date().toISOString(), grossPnl: Number(grossPnl.toFixed(4)), fees: Number(fees.toFixed(4)), pnl: Number(pnl.toFixed(4)), pnlPercent: marginRequired > 0 ? Number((pnl / marginRequired * 100).toFixed(3)) : 0 });
}

async function updateTradeManagement(trade, currentPrice, atr = null) {
  const config = DEFAULT_STRATEGY_CONFIG;
  const price = Number(currentPrice);
  const entry = Number(trade.entry_price);
  const currentStop = Number(trade.stop_loss);
  const isLong = trade.side === 'LONG';
  
  const riskDist = Math.abs(entry - currentStop);
  const currentProfitR = isLong ? (price - entry) / riskDist : (entry - price) / riskDist;
  
  let newStop = currentStop;
  let updated = false;

  // 1. BREAK-EVEN TRIGGER
  if (currentProfitR >= config.breakEvenTriggerR && currentStop !== entry) {
    newStop = entry;
    updated = true;
  }

  // 2. TRAILING STOP
  if (config.trailingStopEnabled && currentProfitR >= config.trailingActivationR) {
    if (atr) {
      const trailingDist = atr * config.trailingAtrMultiplier;
      const trailingStop = isLong ? price - trailingDist : price + trailingDist;
      
      if (isLong && trailingStop > currentStop) {
        newStop = trailingStop;
        updated = true;
      } else if (!isLong && trailingStop < currentStop) {
        newStop = trailingStop;
        updated = true;
      }
    }
  }

  if (updated) {
    return updateTrade(trade.id, { stopLoss: Number(newStop.toFixed(8)) });
  }
  return null;
}

module.exports = { openPaperTrade, closePaperTrade, updateTradeManagement };
