const STRATEGY_PROFILES = Object.freeze({
  conservative: Object.freeze({ minScore: 78, dailyLongRsiMin: 45, dailyLongRsiMax: 68, dailyShortRsiMin: 32, dailyShortRsiMax: 52, hourlyLongRsiMin: 45, hourlyLongRsiMax: 68, hourlyShortRsiMin: 32, hourlyShortRsiMax: 55, trendAdxMin: 20, pullbackAtrDistance: 1.25, breakoutVolumeRatio: 1.3, breakoutAdxMin: 22, squeezeVolumeRatio: 1.25, overextension24h: 15, crowdedFunding: 0.0008 }),
  balanced: Object.freeze({ minScore: 75, dailyLongRsiMin: 45, dailyLongRsiMax: 72, dailyShortRsiMin: 28, dailyShortRsiMax: 55, hourlyLongRsiMin: 42, hourlyLongRsiMax: 72, hourlyShortRsiMin: 28, hourlyShortRsiMax: 58, trendAdxMin: 15, pullbackAtrDistance: 1.75, breakoutVolumeRatio: 1.1, breakoutAdxMin: 18, squeezeVolumeRatio: 1.15, overextension24h: 20, crowdedFunding: 0.001 }),
  opportunity: Object.freeze({ minScore: 72, dailyLongRsiMin: 40, dailyLongRsiMax: 75, dailyShortRsiMin: 25, dailyShortRsiMax: 60, hourlyLongRsiMin: 38, hourlyLongRsiMax: 75, hourlyShortRsiMin: 25, hourlyShortRsiMax: 62, trendAdxMin: 12, pullbackAtrDistance: 2.25, breakoutVolumeRatio: 1.0, breakoutAdxMin: 15, squeezeVolumeRatio: 1.0, overextension24h: 20, crowdedFunding: 0.001 })
});

const GLOBAL_RISK_CONFIG = Object.freeze({
  riskPerTrade: 1,
  leverage: 10,
  maxOpenPositions: 5,
  maxSameCategory: 2,
  trailingStopEnabled: true,
  breakEvenTriggerR: 1.0,
  trailingAtrMultiplier: 2.0,
  trailingActivationR: 1.5,
  // Regime Switching
  regimeAdxThreshold: 25, // Above 25 = Momentum, Below 25 = Mean Reversion
});

const DEFAULT_STRATEGY_CONFIG = { ...STRATEGY_PROFILES.balanced, ...GLOBAL_RISK_CONFIG };

module.exports = { STRATEGY_PROFILES, GLOBAL_RISK_CONFIG, DEFAULT_STRATEGY_CONFIG };
