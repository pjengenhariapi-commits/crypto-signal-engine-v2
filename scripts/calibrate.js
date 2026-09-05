const { calibrateSymbol } = require('../server/calibrationService');
const { saveValidation } = require('../server/dbService');

async function main() {
  const symbol = String(process.argv[2] || 'SOLUSDT').toUpperCase();
  const candles = Number(process.argv[3]) || 5000;
  console.log(`Calibrando ${symbol} em ${candles} candles de 4H...`);
  const result = await calibrateSymbol(symbol, candles);
  await saveValidation(result);
  console.log(JSON.stringify({
    symbol: result.symbol,
    selectedProfile: result.selectedProfile,
    trainingQualified: result.trainingQualified,
    validation: result.validation,
    approved: result.summary.approved
  }, null, 2));
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
