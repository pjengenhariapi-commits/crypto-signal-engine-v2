'use strict';

const { runBacktestOnCandles, runWalkForward } = require('./backtestEngine');

// ── Helpers ──────────────────────────────────────────────────────────────────

const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

function linspace(start, end, step) {
  const values = [];
  for (let v = start; v <= end + 1e-9; v += step) {
    values.push(Math.round(v * 1e6) / 1e6);
  }
  return values;
}

function cartesianProduct(arrays) {
  return arrays.reduce(
    (acc, arr) => acc.flatMap((combo) => arr.map((v) => [...combo, v])),
    [[]]
  );
}

function hashParams(params) {
  return Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('|');
}

// ── Search Space ─────────────────────────────────────────────────────────────

const DEFAULT_SEARCH_SPACE = {
  minScore:              linspace(65, 85, 5),
  dailyLongRsiMin:       linspace(35, 55, 5),
  dailyLongRsiMax:       linspace(65, 80, 5),
  trendAdxMin:           linspace(10, 30, 5),
  pullbackAtrDistance:    linspace(1.0, 3.0, 0.25),
  breakoutVolumeRatio:   linspace(0.8, 1.5, 0.1),
  overextension24h:      linspace(15, 25, 5),
  crowdedFunding:        linspace(0.0005, 0.002, 0.00025),
  regimeAdxThreshold:    linspace(20, 30, 5),
};

// ── Fitness Weights ──────────────────────────────────────────────────────────

const FITNESS_WEIGHTS = {
  profitFactor:       0.30,
  avgRMultiple:       0.25,
  winRate:            0.15,
  drawdownPenalty:    0.20,
  tradeCountPenalty:  0.10,
};

// ── Fitness Evaluation ───────────────────────────────────────────────────────

function evaluateFitness(result) {
  const m = result.metrics;

  const profitFactorScore      = clamp(m.profitFactor, 0, 5) / 5;
  const avgRMultipleScore      = clamp((m.avgRMultiple + 2) / 3, 0, 1);
  const winRateScore           = m.winRate / 100;
  const drawdownPenaltyScore   = 1 - clamp(m.maxDrawdownPercent, 0, 30) / 30;
  const tradeCountPenaltyScore = Math.min(m.totalTrades / 30, 1);

  const weighted =
    profitFactorScore      * FITNESS_WEIGHTS.profitFactor +
    avgRMultipleScore      * FITNESS_WEIGHTS.avgRMultiple +
    winRateScore           * FITNESS_WEIGHTS.winRate +
    drawdownPenaltyScore   * FITNESS_WEIGHTS.drawdownPenalty +
    tradeCountPenaltyScore * FITNESS_WEIGHTS.tradeCountPenalty;

  return clamp(weighted, 0, 1);
}

// ── Run a single parameter set against candle data ───────────────────────────

function runSingleBacktest(candles, params, options, candleSets) {
  const strategyConfig = { ...params };
  const context = {
    weeklyCandles:   candleSets.weeklyCandles,
    monthlyCandles:  candleSets.monthlyCandles,
    dailyCandles:    candleSets.dailyCandles,
    hourlyCandles:   candleSets.hourlyCandles,
    strategyConfig,
    strategyProfile: null,
  };

  const backtestOptions = {
    riskPercent:       options.riskPercent       || 1.0,
    feePercent:        options.feePercent         || 0.04,
    slippagePercent:   options.slippagePercent    || 0.01,
    fundingRate:       options.fundingRate        || 0.0001,
    startTradingIndex: options.startTradingIndex  || 0,
  };

  const result = runBacktestOnCandles(candles, backtestOptions, context);
  const fitness = evaluateFitness(result);

  return {
    params,
    fitness,
    metrics:    result.metrics,
    trades:     result.trades,
    equityCurve: result.equityCurve,
  };
}

// ── Grid Search ──────────────────────────────────────────────────────────────

function runGridSearch(candles, options = {}) {
  const searchSpace      = options.searchSpace      || DEFAULT_SEARCH_SPACE;
  const maxCombinations  = options.maxCombinations   || 500;
  const candleSets       = options.candleSets        || {};

  const paramKeys   = Object.keys(searchSpace);
  const paramArrays = paramKeys.map((k) => searchSpace[k]);
  const allCombinations = cartesianProduct(paramArrays);

  const combinations =
    allCombinations.length > maxCombinations
      ? allCombinations.slice(0, maxCombinations)
      : allCombinations;

  const results = [];

  for (const combo of combinations) {
    const params = {};
    paramKeys.forEach((key, i) => {
      params[key] = combo[i];
    });

    try {
      const entry = runSingleBacktest(candles, params, options, candleSets);
      results.push(entry);
    } catch (err) {
      results.push({ params, fitness: 0, error: err.message });
    }
  }

  results.sort((a, b) => b.fitness - a.fitness);

  return {
    method:             'grid',
    totalCombinations:  allCombinations.length,
    testedCombinations: combinations.length,
    results,
  };
}

// ── Random Search ────────────────────────────────────────────────────────────

function runRandomSearch(candles, options = {}, iterations = 50) {
  const searchSpace = options.searchSpace || DEFAULT_SEARCH_SPACE;
  const candleSets  = options.candleSets  || {};

  const paramKeys = Object.keys(searchSpace);
  const results   = [];

  for (let i = 0; i < iterations; i++) {
    const params = {};
    for (const key of paramKeys) {
      const values = searchSpace[key];
      params[key] = values[Math.floor(Math.random() * values.length)];
    }

    try {
      const entry = runSingleBacktest(candles, params, options, candleSets);
      results.push(entry);
    } catch (err) {
      results.push({ params, fitness: 0, error: err.message });
    }
  }

  results.sort((a, b) => b.fitness - a.fitness);

  return {
    method:     'random',
    iterations,
    results,
  };
}

// ── Optimize Strategy (Full Pipeline) ────────────────────────────────────────

function optimizeStrategy(symbol, fetchCandlesFn, options = {}) {
  const {
    searchSpace,
    riskPercent,
    feePercent,
    slippagePercent,
    fundingRate,
    startTradingIndex,
    gridCombinations    = 500,
    randomIterations    = 50,
    trainSplit          = 0.6,
    topFromGrid         = 5,
    topFromRandom       = 5,
    validateTop         = 10,
    runWalkForwardAfter = true,
    walkForwardFolds    = 5,
  } = options;

  // 1. Fetch all candle data
  const candleSets = fetchCandlesFn(symbol);

  const allCandles = candleSets.hourlyCandles || candleSets.dailyCandles;
  if (!allCandles || allCandles.length === 0) {
    throw new Error(`No candles returned for ${symbol}`);
  }

  // 2. Split into training (60%) and validation (40%)
  const splitIndex     = Math.floor(allCandles.length * trainSplit);
  const trainingCandles  = allCandles.slice(0, splitIndex);
  const validationCandles = allCandles.slice(splitIndex);

  const sliceCandleSets = (candles, upToIndex) => {
    const scale = (arr) => {
      if (!arr) return [];
      const ratio = upToIndex / allCandles.length;
      return arr.slice(0, Math.ceil(ratio * arr.length));
    };
    return {
      weeklyCandles:  scale(candleSets.weeklyCandles),
      monthlyCandles: scale(candleSets.monthlyCandles),
      dailyCandles:   scale(candleSets.dailyCandles),
      hourlyCandles:  candles,
    };
  };

  const trainingCandleSets   = sliceCandleSets(trainingCandles, splitIndex);
  const validationCandleSets = sliceCandleSets(validationCandles, allCandles.length);

  // 3. Run grid search on training data
  const gridResult = runGridSearch(trainingCandles, {
    searchSpace,
    riskPercent,
    feePercent,
    slippagePercent,
    fundingRate,
    startTradingIndex,
    maxCombinations: gridCombinations,
    candleSets:      trainingCandleSets,
  });

  // 4. Run random search on training data
  const randomResult = runRandomSearch(
    trainingCandles,
    {
      searchSpace,
      riskPercent,
      feePercent,
      slippagePercent,
      fundingRate,
      startTradingIndex,
      candleSets: trainingCandleSets,
    },
    randomIterations
  );

  // 5. Merge top results from each method, deduplicate
  const topGrid   = gridResult.results.slice(0, topFromGrid);
  const topRandom = randomResult.results.slice(0, topFromRandom);

  const seen       = new Set();
  const candidates = [];

  for (const entry of [...topGrid, ...topRandom]) {
    const key = hashParams(entry.params);
    if (!seen.has(key)) {
      seen.add(key);
      candidates.push(entry);
    }
  }

  // 6. Validate top candidates on held-out validation data
  const toValidate          = candidates.slice(0, validateTop);
  const validatedCandidates = toValidate.map((entry) => {
    try {
      const valResult = runSingleBacktest(
        validationCandles,
        entry.params,
        { riskPercent, feePercent, slippagePercent, fundingRate, startTradingIndex },
        validationCandleSets
      );
      return {
        params:            entry.params,
        trainingFitness:   entry.fitness,
        trainingMetrics:   entry.metrics,
        validationFitness: valResult.fitness,
        validationMetrics: valResult.metrics,
        combinedFitness:   (entry.fitness + valResult.fitness) / 2,
      };
    } catch (err) {
      return {
        params:            entry.params,
        trainingFitness:   entry.fitness,
        trainingMetrics:   entry.metrics,
        validationFitness: 0,
        validationMetrics: null,
        combinedFitness:   0,
        error:             err.message,
      };
    }
  });

  validatedCandidates.sort((a, b) => b.combinedFitness - a.combinedFitness);

  const bestCandidate = validatedCandidates[0];

  // 7. Optionally run walk-forward validation on the best params
  let walkForwardResult = null;
  if (runWalkForwardAfter && bestCandidate) {
    try {
      walkForwardResult = runWalkForward(symbol, allCandles.length, walkForwardFolds, {
        riskPercent,
        feePercent,
        slippagePercent,
        fundingRate,
        startTradingIndex,
        strategyConfig: bestCandidate.params,
      });
    } catch (err) {
      walkForwardResult = { error: err.message };
    }
  }

  return {
    symbol,
    bestParams:         bestCandidate ? bestCandidate.params : null,
    trainingFitness:    bestCandidate ? bestCandidate.trainingFitness : null,
    validationFitness:  bestCandidate ? bestCandidate.validationFitness : null,
    allCandidates:      validatedCandidates,
    gridResult: {
      totalCombinations:  gridResult.totalCombinations,
      testedCombinations: gridResult.testedCombinations,
    },
    randomResult: {
      iterations: randomResult.iterations,
    },
    walkForwardResult,
  };
}

// ── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  DEFAULT_SEARCH_SPACE,
  FITNESS_WEIGHTS,
  evaluateFitness,
  runGridSearch,
  runRandomSearch,
  optimizeStrategy,
};
