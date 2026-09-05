/**
 * aiAnalyst.js — Deterministic AI report generator for crypto analysis
 * Generates structured reports without external API calls
 */

function formatCurrency(value) {
  if (!Number.isFinite(Number(value))) return 'N/A';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 }).format(value);
}

function formatPercent(value) {
  if (!Number.isFinite(Number(value))) return 'N/A';
  return `${Number(value).toFixed(2)}%`;
}

function generateAIReport({ symbol, ticker, monthly, weekly, daily, fourHour, oneHour, signal, tradeParams }) {
  const price = Number(ticker?.lastPrice) || 0;
  const change24h = Number(ticker?.priceChangePercent) || 0;
  
  // Executive Summary
  const direction = signal?.action === 'COMPRA' ? 'COMPRA' : signal?.action === 'VENDA' ? 'VENDA' : 'AGUARDAR';
  const setup = signal?.setup || 'Nenhum';
  const score = Number(signal?.score) || 0;
  
  let executiveSummary = `**${symbol}** — Preço: ${formatCurrency(price)} | 24h: ${formatPercent(change24h)}\n`;
  executiveSummary += `Sinal: **${direction}** | Setup: ${setup} | Score: ${score}%\n`;
  
  if (direction === 'COMPRA') {
    executiveSummary += `O ativo apresenta configuração favorável para entrada compradora com ${score}% de confirmação.`;
  } else if (direction === 'VENDA') {
    executiveSummary += `O ativo apresenta configuração para entrada vendedora com ${score}% de confirmação.`;
  } else {
    executiveSummary += `Aguardando confirmações adicionais antes de gerar sinal acionável.`;
  }

  // Technical Analysis per timeframe
  const technicalAnalysis = [];
  
  // Monthly
  if (monthly) {
    const bias = monthly.bias || 'NEUTRO';
    const rsi = Number.isFinite(monthly.rsi) ? monthly.rsi.toFixed(1) : 'N/A';
    technicalAnalysis.push(`**Mensal (1M):** Viés ${bias} | RSI ${rsi}`);
  }
  
  // Weekly
  if (weekly) {
    const structure = weekly.structure || 'N/A';
    const rsi = Number.isFinite(weekly.rsi) ? weekly.rsi.toFixed(1) : 'N/A';
    const support = Number.isFinite(weekly.nearestSupport) ? formatCurrency(weekly.nearestSupport) : 'N/A';
    const resistance = Number.isFinite(weekly.nearestResistance) ? formatCurrency(weekly.nearestResistance) : 'N/A';
    const distSupport = Number.isFinite(weekly.distToSupportPercent) ? weekly.distToSupportPercent.toFixed(1) : 'N/A';
    const distResist = Number.isFinite(weekly.distToResistancePercent) ? weekly.distToResistancePercent.toFixed(1) : 'N/A';
    technicalAnalysis.push(`**Semanal (1W):** Estrutura ${structure} | RSI ${rsi}`);
    technicalAnalysis.push(`Suporte: ${support} (${distSupport}% dist.) | Resistência: ${resistance} (${distResist}% dist.)`);
  }
  
  // Daily
  if (daily) {
    const bias = daily.bias || 'N/A';
    const rsi = Number.isFinite(daily.rsi) ? daily.rsi.toFixed(1) : 'N/A';
    const adx = Number.isFinite(daily.adx) ? daily.adx.toFixed(1) : 'N/A';
    const atr = Number.isFinite(daily.atr) ? daily.atr.toFixed(2) : 'N/A';
    technicalAnalysis.push(`**Diário (1D):** Viés ${bias} | RSI ${rsi} | ADX ${adx} | ATR ${atr}`);
  }
  
  // 4H
  if (fourHour) {
    const structure = fourHour.structure || 'N/A';
    const rsi = Number.isFinite(fourHour.rsi) ? fourHour.rsi.toFixed(1) : 'N/A';
    const adx = Number.isFinite(fourHour.adx) ? fourHour.adx.toFixed(1) : 'N/A';
    const volRatio = Number.isFinite(fourHour.volumeRatio) ? fourHour.volumeRatio.toFixed(2) : 'N/A';
    const macd = Number.isFinite(fourHour.macdHist) ? fourHour.macdHist.toFixed(4) : 'N/A';
    technicalAnalysis.push(`**4 Horas (4H):** Estrutura ${structure} | RSI ${rsi} | ADX ${adx} | Vol Ratio ${volRatio} | MACD ${macd}`);
  }
  
  // 1H
  if (oneHour) {
    const trigger = oneHour.trigger || 'N/A';
    const rsi = Number.isFinite(oneHour.rsi) ? oneHour.rsi.toFixed(1) : 'N/A';
    technicalAnalysis.push(`**1 Hora (1H):** Gatilho ${trigger} | RSI ${rsi}`);
  }

  // Trade Parameters
  let tradeAnalysis = '';
  if (tradeParams && direction !== 'AGUARDAR') {
    const stop = Number.isFinite(tradeParams.stopLoss) ? formatCurrency(tradeParams.stopLoss) : 'N/A';
    const target = Number.isFinite(tradeParams.takeProfit) ? formatCurrency(tradeParams.takeProfit) : 'N/A';
    const leverage = Number.isFinite(tradeParams.suggestedLeverage) ? tradeParams.suggestedLeverage : 'N/A';
    const stopPct = Number.isFinite(tradeParams.stopPercent) ? tradeParams.stopPercent.toFixed(2) : 'N/A';
    tradeAnalysis = `\n**Parâmetros de Trade:**\n`;
    tradeAnalysis += `Stop Loss: ${stop} (${stopPct}%)\n`;
    tradeAnalysis += `Take Profit: ${target}\n`;
    tradeAnalysis += `Alavancagem Sugerida: ${leverage}x`;
  }

  // Confluences
  const confluences = [];
  if (monthly?.bias === 'BULLISH' && direction === 'COMPRA') confluences.push('Viés mensal confirmado');
  if (monthly?.bias === 'BEARISH' && direction === 'VENDA') confluences.push('Viés mensal confirmado');
  if (weekly?.structure === 'ALTA' && direction === 'COMPRA') confluences.push('Estrutura semanal de alta');
  if (weekly?.structure === 'BAIXA' && direction === 'VENDA') confluences.push('Estrutura semanal de baixa');
  if (daily?.bias === 'BULLISH' && direction === 'COMPRA') confluences.push('Regime diário favorável');
  if (daily?.bias === 'BEARISH' && direction === 'VENDA') confluences.push('Regime diário favorável');
  if (Number.isFinite(fourHour?.adx) && fourHour.adx > 25) confluences.push('ADX forte (>25)');
  if (Number.isFinite(fourHour?.volumeRatio) && fourHour.volumeRatio > 1.2) confluences.push('Volume acima da média');
  if (score >= 75) confluences.push('Score acima do threshold');

  // Warnings
  const warnings = [];
  if (Math.abs(change24h) > 15) warnings.push(`Sobreextensão de ${change24h.toFixed(1)}% em 24h`);
  if (Number.isFinite(fourHour?.rsi) && fourHour.rsi > 70) warnings.push('RSI 4H sobrecomprado');
  if (Number.isFinite(fourHour?.rsi) && fourHour.rsi < 30) warnings.push('RSI 4H sobrevendido');
  if (score < 60) warnings.push('Score abaixo de 60% — convicção fraca');

  // Telegram Alert
  let telegramAlert = `🚨 *${symbol}* — ${direction}\n`;
  telegramAlert += `💰 Preço: ${formatCurrency(price)}\n`;
  telegramAlert += `📊 Setup: ${setup} | Score: ${score}%\n`;
  if (direction !== 'AGUARDAR' && tradeParams) {
    telegramAlert += `🎯 Entry: ${formatCurrency(price)}\n`;
    telegramAlert += `🛑 Stop: ${formatCurrency(tradeParams.stopLoss)}\n`;
    telegramAlert += `✅ Target: ${formatCurrency(tradeParams.takeProfit)}\n`;
    telegramAlert += `⚡ Leverage: ${tradeParams.suggestedLeverage}x`;
  }

  return {
    executiveSummary,
    technicalAnalysis: technicalAnalysis.join('\n'),
    tradeAnalysis,
    confluences,
    warnings,
    telegramAlert,
    symbol,
    action: direction,
    score,
    setup
  };
}

module.exports = { generateAIReport, formatCurrency, formatPercent };
