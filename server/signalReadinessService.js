function valid(value) { return Number.isFinite(Number(value)); }

function assessSignalReadiness({ signal = {}, monthly = {}, weekly = {}, daily = {}, fourHour = {}, oneHour = {} }) {
  if (['COMPRA', 'VENDA'].includes(signal.action)) return { status: 'CONFIRMADO', direction: signal.action, score: Number(signal.score || 0), missing: [], label: signal.action };
  const longChecks = [
    ['Regime mensal sem viés de baixa', monthly.bias !== 'BEARISH', 15],
    ['Tendência semanal de alta', valid(weekly.ema9) && valid(weekly.ema21) && weekly.ema9 > weekly.ema21, 20],
    ['Regime diário de alta', daily.bias === 'BULLISH', 25],
    ['Estrutura 4H de alta', valid(fourHour.ema9) && valid(fourHour.ema21) && fourHour.ema9 > fourHour.ema21, 20],
    ['Gatilho 1H comprador', oneHour.trigger === 'COMPRA', 20]
  ];
  const shortChecks = [
    ['Regime mensal sem viés de alta', monthly.bias !== 'BULLISH', 15],
    ['Tendência semanal de baixa', valid(weekly.ema9) && valid(weekly.ema21) && weekly.ema9 < weekly.ema21, 20],
    ['Regime diário de baixa', daily.bias === 'BEARISH', 25],
    ['Estrutura 4H de baixa', valid(fourHour.ema9) && valid(fourHour.ema21) && fourHour.ema9 < fourHour.ema21, 20],
    ['Gatilho 1H vendedor', oneHour.trigger === 'VENDA', 20]
  ];
  const total = checks => checks.reduce((sum, [, passed, weight]) => sum + (passed ? weight : 0), 0);
  const longScore = total(longChecks); const shortScore = total(shortChecks);
  if (longScore === shortScore && longScore < 50) return { status: 'NEUTRO', direction: null, score: longScore, missing: [], label: 'AGUARDAR' };
  const direction = longScore >= shortScore ? 'COMPRA' : 'VENDA'; const checks = direction === 'COMPRA' ? longChecks : shortChecks; const score = Math.max(longScore, shortScore);
  const missing = checks.filter(([, passed]) => !passed).map(([label]) => label);
  const status = signal.setup && score >= 60 ? 'ARMADO' : score >= 50 ? 'EM_FORMAÇÃO' : 'NEUTRO';
  return { status, direction, score, missing, label: status === 'NEUTRO' ? 'AGUARDAR' : `OBSERVAR ${direction}` };
}

module.exports = { assessSignalReadiness };
