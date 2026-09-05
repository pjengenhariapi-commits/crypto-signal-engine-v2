#!/usr/bin/env node
/**
 * Strategy Optimizer CLI
 * Usage: node scripts/optimize.js [SYMBOL] [ITERATIONS]
 * Example: node scripts/optimize.js SOLUSDT 100
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { optimizeStrategy } = require('../server/strategyOptimizer');
const { getHistoricalKlines, getKlines } = require('../server/binanceService');

const symbol = (process.argv[2] || 'SOLUSDT').toUpperCase();
const iterations = Math.min(Number(process.argv[3]) || 50, 200);

async function main() {
  console.log(`\n🔬 Strategy Optimizer — ${symbol}`);
  console.log(`   Iterations: ${iterations}`);
  console.log(`   Data: 15,000 candles (4H) with full multi-timeframe context\n`);

  const fetchCandles = async (sym) => {
    console.log(`   Fetching data for ${sym}...`);
    const [candles4H, weeklyCandles, monthlyCandles, dailyCandles, hourlyCandles] = await Promise.all([
      getHistoricalKlines(sym, '4h', 15000),
      getKlines(sym, '1w', 260),
      getKlines(sym, '1M', 60),
      getHistoricalKlines(sym, '1d', 2500),
      getHistoricalKlines(sym, '1h', 25000)
    ]);
    console.log(`   Loaded: ${candles4H.length} 4H candles, ${dailyCandles.length} 1D, ${hourlyCandles.length} 1H`);
    return { candles4H, weeklyCandles, monthlyCandles, dailyCandles, hourlyCandles };
  };

  try {
    const result = await optimizeStrategy(symbol, fetchCandles, { iterations, walkForwardFolds: 5 });
    
    console.log('\n═══════════════════════════════════════════════════');
    console.log(`📊 OPTIMIZATION RESULTS — ${result.symbol}`);
    console.log('═══════════════════════════════════════════════════\n');
    
    if (result.bestParams) {
      console.log('🏆 Best Parameters:');
      console.log(JSON.stringify(result.bestParams, null, 2));
      console.log(`\n   Training Fitness:  ${result.trainingFitness?.toFixed(4) || 'N/A'}`);
      console.log(`   Validation Fitness: ${result.validationFitness?.toFixed(4) || 'N/A'}`);
    }
    
    if (result.walkForwardResult) {
      const wf = result.walkForwardResult;
      console.log(`\n📈 Walk-Forward (${wf.summary?.totalFolds || '?'} folds):`);
      console.log(`   Profitable Folds: ${wf.summary?.profitableFolds || 0}/${wf.summary?.totalFolds || 0}`);
      console.log(`   Avg Return: ${wf.summary?.averageReturnPercent || 0}%`);
      console.log(`   Max Drawdown: ${wf.summary?.worstDrawdownPercent || 0}%`);
      console.log(`   Total Trades: ${wf.summary?.totalTrades || 0}`);
      console.log(`   Approved: ${wf.summary?.approved ? '✅ YES' : '❌ NO'}`);
    }
    
    console.log('\n═══════════════════════════════════════════════════\n');
  } catch (err) {
    console.error('❌ Optimization failed:', err.message);
    process.exit(1);
  }
}

main();
