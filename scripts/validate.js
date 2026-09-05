require('dotenv').config();
const { DEFAULT_SYMBOLS } = require('../server/binanceService');
const { runWalkForward } = require('../server/backtestEngine');
const { saveValidation } = require('../server/dbService');

async function main() {
  const symbols = process.argv.slice(2).length ? process.argv.slice(2).map(item => item.toUpperCase()) : DEFAULT_SYMBOLS.slice(0, 5);
  console.log(`Validando ${symbols.join(', ')} com 5.000 candles e 5 folds...`);
  const settled = await Promise.allSettled(symbols.map(symbol => runWalkForward(symbol, 5000, 5)));
  for (let index = 0; index < settled.length; index += 1) {
    const result = settled[index];
    if (result.status === 'rejected') { console.error(`${symbols[index]}: ${result.reason.message}`); continue; }
    await saveValidation(result.value);
    const summary = result.value.summary;
    console.log(`${result.value.symbol}: ${summary.totalTrades} trades | ${summary.profitableFolds}/${summary.totalFolds} folds positivos | retorno médio ${summary.averageReturnPercent}% | ${summary.approved ? 'APROVADO PARA PAPER' : 'REPROVADO'}`);
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
