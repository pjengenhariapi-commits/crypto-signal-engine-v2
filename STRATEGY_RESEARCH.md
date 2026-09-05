# Strategy Research and Validation

## Status

The engine is in `RESEARCH` mode. Live order execution remains disabled. A strategy is not approved merely because it has a high win rate; it must have enough trades, positive expectancy after costs, controlled drawdown, and stability across walk-forward folds and assets. Signals are evaluated sequentially as `1M → 1W → 1D → 4H → 1H`; failure at any confirmation stage results in `AGUARDAR`.

## Evidence used

- Adaptive trend following in crypto: https://arxiv.org/abs/2602.11708
- Decade-scale trend-following evidence: https://arxiv.org/abs/2009.12155
- State-dependent cross-sectional crypto momentum: https://ssrn.com/abstract=6648082
- Evidence that crypto momentum variance can be extreme: https://ssrn.com/abstract=4633099
- Size-dependent momentum and reversal: https://ssrn.com/abstract=6628860
- Binance kline specification and close-time semantics: https://developers.binance.com/en/docs/derivatives

These sources motivate testing trend pullbacks, volume-confirmed breakouts, volatility squeeze releases, dynamic liquid-asset selection, overextension vetoes, and adaptive ATR exits. They do not establish guaranteed profitability for this implementation.

## Implemented setups

1. `TREND_PULLBACK`: higher-timeframe trend, aligned 4H EMAs, ADX regime filter, RSI range, and proximity to EMA 21 measured in ATR.
2. `BREAKOUT_VOLUME`: higher-timeframe trend, break of a prior 20-candle extreme, relative-volume confirmation, RSI and ADX filters.
3. `SQUEEZE_BREAKOUT`: low Bollinger-width percentile followed by a volume-confirmed break of the previous band.

## Risk and selection controls

- Candles must be closed before entering indicator calculations.
- Entries occur at the next candle open with modeled slippage.
- Backtests include fees and optional funding.
- Stop is favored when stop and target occur in the same candle.
- Half the position exits at 1R; the remainder moves to breakeven and trails by ATR.
- Assets require a USDT perpetual contract, sufficient quote volume, and at least 180 days of listing history.
- Momentum entries are blocked after absolute 24-hour moves above 20%.
- Crowded funding and nearby weekly barriers reduce or block the score.

## Promotion gate

The current automated gate requires at least 20 out-of-sample trades and positive results in at least 75% of sequential folds. Passing this gate is necessary but not sufficient; paper trading and manual review remain mandatory.

## Latest measured result

The five-asset, 1,500-candle walk-forward run did not approve any asset. Adaptive exits improved BTC, ETH, SOL and XRP relative to the fixed-target version, but sample sizes and consistency remain insufficient. The correct system response is to stay in research/paper mode.

After adding sequential 1D regime confirmation and 1H entry triggers, the 5,000-candle validation produced: BTC 13 trades and 0/5 positive folds; ETH 8 and 2/5; SOL 22 and 3/5; BNB 21 and 1/5; XRP 21 and 3/5. No symbol met the 75% fold-consistency gate.
