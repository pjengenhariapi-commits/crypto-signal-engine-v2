const round = (value, digits = 2) => Number(Number(value || 0).toFixed(digits));

function calculatePortfolioSnapshot(trades, prices, options = {}) {
  const feePercent = Number(options.feePercent ?? 0.04); const maxRiskPercent = Number(options.maxRiskPercent ?? 3); const maxOpenTrades = Number(options.maxOpenTrades ?? 3);
  const positions = trades.map(trade => {
    const currentPrice = Number(prices[trade.symbol]); const entryPrice = Number(trade.entryPrice); const quantity = Number(trade.quantity); const margin = Number(trade.marginRequired); const risk = Number(trade.riskAmountUSD);
    if (![currentPrice, entryPrice, quantity, margin, risk].every(Number.isFinite)) return null;
    const grossPnl = (trade.side === 'LONG' ? currentPrice - entryPrice : entryPrice - currentPrice) * quantity;
    const estimatedFees = (entryPrice + currentPrice) * quantity * feePercent / 100; const unrealizedPnl = grossPnl - estimatedFees;
    const stopDistancePercent = Number.isFinite(Number(trade.stopLoss)) ? Math.abs(currentPrice - Number(trade.stopLoss)) / currentPrice * 100 : null;
    const targetDistancePercent = Number.isFinite(Number(trade.takeProfit)) ? Math.abs(Number(trade.takeProfit) - currentPrice) / currentPrice * 100 : null;
    return { ...trade, currentPrice: round(currentPrice, 6), unrealizedPnl: round(unrealizedPnl), pnlOnMarginPercent: margin ? round(unrealizedPnl / margin * 100) : 0, rMultiple: risk ? round(unrealizedPnl / risk, 2) : 0, stopDistancePercent: stopDistancePercent === null ? null : round(stopDistancePercent), targetDistancePercent: targetDistancePercent === null ? null : round(targetDistancePercent) };
  }).filter(Boolean);
  const walletBalance = positions.length ? Math.min(...positions.map(item => Number(item.walletBalance)).filter(Number.isFinite)) : 0;
  const totalExposureUSD = positions.reduce((sum, item) => sum + Number(item.positionValueUSD || 0), 0); const usedMarginUSD = positions.reduce((sum, item) => sum + Number(item.marginRequired || 0), 0);
  const openRiskUSD = positions.reduce((sum, item) => sum + Number(item.riskAmountUSD || 0), 0); const unrealizedPnlUSD = positions.reduce((sum, item) => sum + item.unrealizedPnl, 0);
  const openRiskPercent = walletBalance ? openRiskUSD / walletBalance * 100 : 0; const largest = totalExposureUSD ? Math.max(0, ...positions.map(item => Number(item.positionValueUSD || 0))) / totalExposureUSD * 100 : 0;
  const status = positions.length >= maxOpenTrades || openRiskPercent >= maxRiskPercent ? 'LIMIT' : positions.length ? 'SAFE' : 'EMPTY';
  return { status, positions, summary: { openPositions: positions.length, walletBalance: round(walletBalance), totalExposureUSD: round(totalExposureUSD), usedMarginUSD: round(usedMarginUSD), openRiskUSD: round(openRiskUSD), openRiskPercent: round(openRiskPercent), unrealizedPnlUSD: round(unrealizedPnlUSD), concentrationPercent: round(largest), availableRiskPercent: round(Math.max(0, maxRiskPercent - openRiskPercent)), maxRiskPercent, maxOpenTrades } };
}

module.exports = { calculatePortfolioSnapshot };
