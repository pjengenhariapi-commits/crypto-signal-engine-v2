function finite(value) { const number = Number(value); return Number.isFinite(number) ? number : 0; }

function buildJournalAnalytics(trades = []) {
  const closed = trades.filter(trade => trade.status === 'CLOSED');
  const wins = closed.filter(trade => finite(trade.pnl) > 0); const losses = closed.filter(trade => finite(trade.pnl) < 0);
  const totalPnl = closed.reduce((sum, trade) => sum + finite(trade.pnl), 0);
  const grossProfit = wins.reduce((sum, trade) => sum + finite(trade.pnl), 0);
  const grossLoss = Math.abs(losses.reduce((sum, trade) => sum + finite(trade.pnl), 0));
  const bySetup = {};
  for (const trade of closed) { const key = trade.setup || 'SEM_SETUP'; bySetup[key] ||= { trades: 0, wins: 0, pnl: 0 }; bySetup[key].trades += 1; bySetup[key].wins += finite(trade.pnl) > 0 ? 1 : 0; bySetup[key].pnl += finite(trade.pnl); }
  for (const item of Object.values(bySetup)) { item.pnl = Number(item.pnl.toFixed(2)); item.winRate = Number((item.wins / item.trades * 100).toFixed(1)); }
  return { total: trades.length, closed: closed.length, open: trades.filter(trade => trade.status === 'OPEN').length, wins: wins.length, losses: losses.length, winRate: closed.length ? Number((wins.length / closed.length * 100).toFixed(1)) : 0, totalPnl: Number(totalPnl.toFixed(2)), expectancy: closed.length ? Number((totalPnl / closed.length).toFixed(2)) : 0, profitFactor: grossLoss ? Number((grossProfit / grossLoss).toFixed(2)) : (grossProfit > 0 ? null : 0), reviewed: trades.filter(trade => trade.reviewStatus === 'REVIEWED').length, bySetup };
}

function csvCell(value) { const valueText = Array.isArray(value) ? value.join('|') : String(value ?? ''); return /[",\r\n]/.test(valueText) ? `"${valueText.replace(/"/g, '""')}"` : valueText; }
function tradesToCsv(trades = []) { const fields = ['id', 'symbol', 'side', 'status', 'setup', 'entry_time', 'exit_time', 'entryPrice', 'exitPrice', 'stopLoss', 'takeProfit', 'quantity', 'riskAmountUSD', 'pnl', 'pnlPercent', 'exit_reason', 'reviewStatus', 'tags', 'note']; return [fields.join(','), ...trades.map(trade => fields.map(field => csvCell(trade[field])).join(','))].join('\r\n'); }

module.exports = { buildJournalAnalytics, tradesToCsv };
