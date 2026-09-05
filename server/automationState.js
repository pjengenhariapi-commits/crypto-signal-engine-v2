function shouldLogSignal(previousAction, currentAction) {
  if (!previousAction) return false;
  return ['COMPRA', 'VENDA'].includes(currentAction) && previousAction !== currentAction;
}

module.exports = { shouldLogSignal };
