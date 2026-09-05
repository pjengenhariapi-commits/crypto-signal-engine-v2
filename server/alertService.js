function isAlertTriggered(alert, marketPrice) {
  const target = Number(alert.price); const current = Number(marketPrice);
  if (!Number.isFinite(target) || !Number.isFinite(current)) return false;
  if (alert.condition === 'ABOVE') return current >= target;
  if (alert.condition === 'BELOW') return current <= target;
  return false;
}

module.exports = { isAlertTriggered };
