const { DEFAULT_STRATEGY_CONFIG } = require("./strategyConfig");

function calculateTradeParameters(signal, fourHour, weekly) {
  if (!signal || signal.action === 'AGUARDAR') return { stopPercent: 0, suggestedLeverage: 1 };
  
  const price = fourHour.close;
  const atr = fourHour.atr || (price * 0.01);
  const isLong = signal.action === 'COMPRA';
  
  // Structural Stop
  const structuralStop = isLong ? fourHour.localLow4H : fourHour.localHigh4H;
  let stopLoss = isLong ? Math.min(structuralStop, price - atr * 1.5) : Math.max(structuralStop, price + atr * 1.5);
  
  // Guard against unrealistic stops
  const riskDist = Math.abs(price - stopLoss);
  const stopPercent = (riskDist / price) * 100;
  
  if (stopPercent < 0.5 || stopPercent > 15) {
    stopLoss = isLong ? price * 0.98 : price * 1.02;
  }
  
  const finalStopPercent = (Math.abs(price - stopLoss) / price) * 100;
  const suggestedLeverage = Math.min(20, Math.max(1, Math.floor(100 / (finalStopPercent * 2))));
  
  return {
    stopLoss,
    stopPercent: finalStopPercent,
    suggestedLeverage,
    takeProfit: isLong ? price + riskDist * 3 : price - riskDist * 3
  };
}

function calculatePositionSize(equity, riskPercent, entryPrice, stopLoss) {
// ... rest of the functions

  if (!equity || !riskPercent || !entryPrice || !stopLoss) return null;
  
  const riskAmount = equity * (riskPercent / 100);
  const riskPerUnit = Math.abs(entryPrice - stopLoss);
  
  if (riskPerUnit === 0) return null;
  
  const size = riskAmount / riskPerUnit;
  return {
    size: size,
    riskAmount: riskAmount,
    riskPerUnit: riskPerUnit
  };
}

function validateGlobalRisk(currentPositions, maxPositions = 5) {
  if (currentPositions.length >= maxPositions) {
    return { ok: false, reason: `Limite máximo de posições atingido (${maxPositions}).` };
  }
  return { ok: true };
}

function checkCorrelationRisk(symbol, currentPositions, maxSameCategory = 2) {
  // Simulação simples de categoria por prefixo ou lista
  // Em um sistema real, teríamos um mapeamento de símbolos -> categorias (ex: BTC, ETH -> L1)
  const categoryMap = {
    "BTC": "BLUECHIP", "ETH": "BLUECHIP",
    "SOL": "L1", "AVAX": "L1", "ADA": "L1",
    "LINK": "ORACLE", "PYTH": "ORACLE",
    "FET": "AI", "RNDR": "AI", "AGIX": "AI"
  };

  const symbolCategory = categoryMap[symbol.substring(0, 3)] || "OTHER";
  const sameCategoryCount = currentPositions.filter(pos => {
    const posCategory = categoryMap[pos.symbol?.substring(0, 3)] || "OTHER";
    return posCategory === symbolCategory;
  }).length;

  if (sameCategoryCount >= maxSameCategory) {
    return { ok: false, reason: `Risco de correlação elevado para a categoria ${symbolCategory}.` };
  }
  return { ok: true };
}

function calculateMargin(positionSize, entryPrice, leverage = 10) {
  const notionValue = positionSize * entryPrice;
  const requiredMargin = notionValue / leverage;
  return {
    notionValue,
    requiredMargin,
    leverage
  };
}

function evaluateTradeRisk(tradeRequest, accountState, config = DEFAULT_STRATEGY_CONFIG) {
  const { symbol, entryPrice, stopLoss, riskPercent } = tradeRequest;
  const { equity, currentPositions } = accountState;

  // 1. Validação de Limites Globais
  const globalRisk = validateGlobalRisk(currentPositions, config.maxOpenPositions || 5);
  if (!globalRisk.ok) return { ok: false, reason: globalRisk.reason };

  // 2. Validação de Correlação
  const correlationRisk = checkCorrelationRisk(symbol, currentPositions, config.maxSameCategory || 2);
  if (!correlationRisk.ok) return { ok: false, reason: correlationRisk.reason };

  // 3. Cálculo de Position Sizing
  const sizing = calculatePositionSize(equity, riskPercent || config.riskPerTrade || 1, entryPrice, stopLoss);
  if (!sizing) return { ok: false, reason: "Erro ao calcular tamanho da posição." };

  // 4. Verificação de Margem
  const margin = calculateMargin(sizing.size, entryPrice, config.leverage || 10);
  if (margin.requiredMargin > equity * 0.2) { // Não usar mais de 20% da equity como margem inicial
    return { ok: false, reason: "Margem exigida excede o limite de segurança da conta." };
  }

  return {
    ok: true,
    sizing,
    margin,
    riskAmount: sizing.riskAmount
  };
}

module.exports = {
  calculateTradeParameters,
  calculatePositionSize,
  validateGlobalRisk,
  checkCorrelationRisk,
  calculateMargin,
  evaluateTradeRisk
};
