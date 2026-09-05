'use strict';

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STAGE_ORDER = ['NEUTRO', 'EM_FORMAÇÃO', 'ARMADO', 'CONFIRMADO'];

const PIPELINE_STAGES = {
  monthlyBias: ['BULLISH', 'BEARISH', 'NEUTRO'],
  weeklyStructure: ['ALTA', 'BAIXA', 'LATERAL'],
  dailyRegime: ['BULLISH', 'BEARISH'],
  fourHourSetup: ['TREND_PULLBACK', 'BREAKOUT_VOLUME', 'SQUEEZE_BREAKOUT'],
  oneHourTrigger: ['COMPRA', 'VENDA', 'NEUTRO'],
};

const PERSISTENCE_FILE = path.join(__dirname, 'readiness_alerts.json');

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

/** @type {Map<string, object>} symbol -> readiness state */
let readinessStates = new Map();

/** @type {Map<string, object>} rule.id -> alert rule */
let alertRules = new Map();

let ruleIdCounter = 1;

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------

function loadFromDisk() {
  try {
    if (fs.existsSync(PERSISTENCE_FILE)) {
      const raw = fs.readFileSync(PERSISTENCE_FILE, 'utf-8');
      const data = JSON.parse(raw);

      if (Array.isArray(data.readinessStates)) {
        readinessStates = new Map(data.readinessStates.map((s) => [s.symbol, s]));
      }
      if (Array.isArray(data.alertRules)) {
        alertRules = new Map(data.alertRules.map((r) => [r.id, r]));
      }
      if (typeof data.ruleIdCounter === 'number') {
        ruleIdCounter = data.ruleIdCounter;
      }
    }
  } catch (err) {
    console.error('[readinessAlertService] Failed to load persistence file:', err.message);
  }
}

function saveToDisk() {
  try {
    const data = {
      readinessStates: Array.from(readinessStates.values()),
      alertRules: Array.from(alertRules.values()),
      ruleIdCounter,
      savedAt: new Date().toISOString(),
    };
    fs.writeFileSync(PERSISTENCE_FILE, JSON.stringify(data, null, 2), 'utf-8');
  } catch (err) {
    console.error('[readinessAlertService] Failed to persist state:', err.message);
  }
}

// Load on module initialization so state is available immediately.
loadFromDisk();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stageIndex(status) {
  const idx = STAGE_ORDER.indexOf(status);
  return idx === -1 ? -1 : idx;
}

function isValidDirection(dir) {
  return dir === 'COMPRA' || dir === 'VENDA' || dir === 'ANY';
}

function isValidStatus(status) {
  return STAGE_ORDER.includes(status);
}

/**
 * Compute a numeric readiness score from a readiness data payload.
 * Score is 0-100 based on how many pipeline stages are satisfied.
 */
function computeReadinessScore(readinessData) {
  if (typeof readinessData.score === 'number') {
    return Math.max(0, Math.min(100, readinessData.score));
  }

  let score = 0;
  const weights = { monthlyBias: 10, weeklyStructure: 10, dailyRegime: 20, fourHourSetup: 25, oneHourTrigger: 25 };

  for (const [stage, weight] of Object.entries(weights)) {
    if (readinessData[stage]) {
      score += weight;
    }
  }
  return score;
}

/**
 * Determine the readiness status from pipeline data if not explicitly provided.
 */
function resolveStatus(readinessData) {
  if (readinessData.status && isValidStatus(readinessData.status)) {
    return readinessData.status;
  }

  const hasOneHour = !!readinessData.oneHourTrigger && readinessData.oneHourTrigger !== 'NEUTRO';
  const hasFourHour = !!readinessData.fourHourSetup;
  const hasDaily = !!readinessData.dailyRegime;
  const hasWeekly = !!readinessData.weeklyStructure;
  const hasMonthly = !!readinessData.monthlyBias;

  if (hasOneHour && hasFourHour && hasDaily && hasWeekly && hasMonthly) return 'CONFIRMADO';
  if (hasFourHour && hasDaily) return 'ARMADO';
  if (hasDaily || hasWeekly) return 'EM_FORMAÇÃO';
  return 'NEUTRO';
}

/**
 * Resolve the directional signal from the readiness data.
 */
function resolveDirection(readinessData) {
  if (readinessData.direction && isValidDirection(readinessData.direction)) {
    return readinessData.direction;
  }
  if (readinessData.oneHourTrigger === 'COMPRA') return 'COMPRA';
  if (readinessData.oneHourTrigger === 'VENDA') return 'VENDA';
  return 'NEUTRO';
}

/**
 * Check whether a rule matches a given symbol+direction+status+score.
 */
function ruleMatches(rule, symbol, status, direction, score) {
  if (!rule.enabled) return false;

  // Symbol filter (wildcard = any)
  if (rule.symbol !== '*' && rule.symbol !== symbol) return false;

  // Direction filter
  if (rule.direction !== 'ANY' && rule.direction !== direction) return false;

  // Minimum status threshold
  if (rule.minStatus && stageIndex(status) < stageIndex(rule.minStatus)) return false;

  // Minimum score threshold
  if (typeof rule.minScore === 'number' && score < rule.minScore) return false;

  return true;
}

/**
 * Check cooldown: returns true if an alert is still in cooldown (should NOT fire).
 */
function isInCooldown(symbol, direction, cooldownMinutes) {
  const state = readinessStates.get(symbol);
  if (!state) return false;
  if (!state.alertedAt) return false;

  // Only consider cooldown for the same direction
  if (direction !== 'ANY' && state.lastDirection && state.lastDirection !== direction) {
    return false;
  }

  const elapsed = Date.now() - new Date(state.alertedAt).getTime();
  const cooldownMs = (cooldownMinutes || 240) * 60 * 1000;
  return elapsed < cooldownMs;
}

/**
 * Build the missing pipeline fields list for a readiness data payload.
 */
function missingFields(readinessData) {
  const missing = [];
  if (!readinessData.monthlyBias) missing.push('monthlyBias');
  if (!readinessData.weeklyStructure) missing.push('weeklyStructure');
  if (!readinessData.dailyRegime) missing.push('dailyRegime');
  if (!readinessData.fourHourSetup) missing.push('fourHourSetup');
  if (!readinessData.oneHourTrigger) missing.push('oneHourTrigger');
  return missing;
}

// ---------------------------------------------------------------------------
// Exported API
// ---------------------------------------------------------------------------

/**
 * Update readiness state for a symbol and check whether any alert rule fires.
 *
 * @param {string} symbol - Trading pair, e.g. 'SOLUSDT'
 * @param {object} readinessData - Pipeline stage data or pre-computed readiness
 * @returns {Array<object>} Array of fired alerts (may be empty)
 */
function updateReadiness(symbol, readinessData) {
  const now = new Date().toISOString();
  const status = resolveStatus(readinessData);
  const direction = resolveDirection(readinessData);
  const score = computeReadinessScore(readinessData);
  const missing = missingFields(readinessData);

  const previous = readinessStates.get(symbol);
  const previousStatus = previous ? previous.currentStatus : 'NEUTRO';

  const state = {
    symbol,
    lastUpdate: now,
    currentStatus: status,
    direction,
    score,
    missing,
    alertedAt: previous ? previous.alertedAt : null,
    alertCount: previous ? previous.alertCount : 0,
    lastDirection: previous ? previous.lastDirection : null,
    pipelineData: {
      monthlyBias: readinessData.monthlyBias || null,
      weeklyStructure: readinessData.weeklyStructure || null,
      dailyRegime: readinessData.dailyRegime || null,
      fourHourSetup: readinessData.fourHourSetup || null,
      oneHourTrigger: readinessData.oneHourTrigger || null,
    },
  };

  readinessStates.set(symbol, state);

  // Check which rules fire
  const firedAlerts = [];
  const stageAdvanced = stageIndex(status) > stageIndex(previousStatus);

  for (const rule of alertRules.values()) {
    if (!ruleMatches(rule, symbol, status, direction, score)) continue;

    // Cooldown check
    if (isInCooldown(symbol, direction, rule.cooldownMinutes)) continue;

    // Only fire on stage advancement or first time reaching threshold
    if (!stageAdvanced && state.alertedAt) continue;

    const alert = {
      id: `alert_${symbol}_${Date.now()}`,
      symbol,
      status,
      direction,
      score,
      missing,
      previousStatus,
      ruleId: rule.id,
      firedAt: now,
    };

    firedAlerts.push(alert);

    // Update cooldown tracking
    state.alertedAt = now;
    state.alertCount += 1;
    state.lastDirection = direction;
  }

  if (firedAlerts.length > 0) {
    saveToDisk();
  }

  return firedAlerts;
}

/**
 * Add a new alert rule.
 *
 * @param {object} rule
 * @param {string} [rule.symbol='*'] - Symbol or wildcard
 * @param {number} [rule.minScore] - Minimum readiness score (0-100)
 * @param {string} [rule.minStatus] - Minimum readiness status
 * @param {string} [rule.direction='ANY'] - COMPRA / VENDA / ANY
 * @param {number} [rule.cooldownMinutes=240] - Cooldown in minutes
 * @param {boolean} [rule.enabled=true]
 * @returns {object} The created rule with its generated id
 */
function addAlertRule(rule) {
  if (!rule) throw new Error('Rule object is required');

  const id = rule.id || `rule_${ruleIdCounter++}`;
  const fullRule = {
    id,
    symbol: rule.symbol || '*',
    minScore: typeof rule.minScore === 'number' ? rule.minScore : null,
    minStatus: rule.minStatus || null,
    direction: rule.direction || 'ANY',
    cooldownMinutes: typeof rule.cooldownMinutes === 'number' ? rule.cooldownMinutes : 240,
    enabled: rule.enabled !== false,
    createdAt: new Date().toISOString(),
  };

  if (fullRule.minStatus && !isValidStatus(fullRule.minStatus)) {
    throw new Error(`Invalid minStatus: ${fullRule.minStatus}. Must be one of: ${STAGE_ORDER.join(', ')}`);
  }
  if (!isValidDirection(fullRule.direction)) {
    throw new Error(`Invalid direction: ${fullRule.direction}. Must be COMPRA, VENDA, or ANY`);
  }

  alertRules.set(id, fullRule);
  saveToDisk();
  return fullRule;
}

/**
 * Remove an alert rule by id.
 *
 * @param {string} id
 * @returns {boolean} true if removed, false if not found
 */
function removeAlertRule(id) {
  const existed = alertRules.delete(id);
  if (existed) saveToDisk();
  return existed;
}

/**
 * Get all alert rules.
 *
 * @returns {Array<object>}
 */
function getAlertRules() {
  return Array.from(alertRules.values());
}

/**
 * Get all current readiness states.
 *
 * @param {string} [filterSymbol] - Optional symbol filter
 * @returns {Array<object>}
 */
function getReadinessStates(filterSymbol) {
  const all = Array.from(readinessStates.values());
  if (filterSymbol) {
    return all.filter((s) => s.symbol === filterSymbol);
  }
  return all;
}

/**
 * Check whether an alert for a given symbol/direction is still in cooldown.
 *
 * @param {string} symbol
 * @param {string} direction - COMPRA, VENDA, or ANY
 * @param {number} [cooldownMinutes] - Override cooldown; if omitted, uses the
 *   shortest cooldown from matching rules (default 240).
 * @returns {{ inCooldown: boolean, remainingMinutes: number, lastAlertedAt: string|null }}
 */
function checkAlertCooldown(symbol, direction, cooldownMinutes) {
  const state = readinessStates.get(symbol);
  if (!state || !state.alertedAt) {
    return { inCooldown: false, remainingMinutes: 0, lastAlertedAt: null };
  }

  // Determine the effective cooldown from matching rules
  let effectiveCooldown = cooldownMinutes || null;
  if (!effectiveCooldown) {
    const matchingRules = Array.from(alertRules.values()).filter(
      (r) =>
        r.enabled &&
        (r.symbol === '*' || r.symbol === symbol) &&
        (r.direction === 'ANY' || r.direction === direction),
    );
    effectiveCooldown = matchingRules.length > 0
      ? Math.min(...matchingRules.map((r) => r.cooldownMinutes))
      : 240;
  }

  const elapsed = Date.now() - new Date(state.alertedAt).getTime();
  const cooldownMs = effectiveCooldown * 60 * 1000;

  if (elapsed >= cooldownMs) {
    return { inCooldown: false, remainingMinutes: 0, lastAlertedAt: state.alertedAt };
  }

  const remainingMs = cooldownMs - elapsed;
  return {
    inCooldown: true,
    remainingMinutes: Math.ceil(remainingMs / 60000),
    lastAlertedAt: state.alertedAt,
  };
}

/**
 * Format an alert message for a given channel.
 *
 * @param {string} symbol - Trading pair
 * @param {object} readiness - Readiness state object (from getReadinessStates)
 * @param {object} rule - The alert rule that triggered
 * @param {string} [channel='console'] - 'console' | 'telegram' | 'webhook'
 * @returns {string} Formatted message
 */
function formatAlert(symbol, readiness, rule, channel = 'console') {
  const status = readiness.currentStatus || readiness.status || 'UNKNOWN';
  const direction = readiness.direction || 'UNKNOWN';
  const score = readiness.score || 0;
  const missing = readiness.missing || [];
  const previousStatus = readiness.previousStatus || readiness.currentStatus || 'UNKNOWN';

  const dirEmoji = direction === 'COMPRA' ? '(LONG)' : direction === 'VENDA' ? '(SHORT)' : '';
  const statusEmoji = {
    NEUTRO: '[--]',
    'EM_FORMAÇÃO': '[~]',
    ARMADO: '[!]',
    CONFIRMADO: '[!!]',
  }[status] || '[?]';

  switch (channel) {
    case 'telegram': {
      const lines = [
        `⚡ *SIGNAL READINESS ALERT*`,
        ``,
        `*Symbol:* ${symbol}`,
        `*Direction:* ${direction} ${dirEmoji}`,
        `*Status:* ${statusEmoji} ${status}`,
        `*Score:* ${score}/100`,
        ``,
      ];

      if (previousStatus && previousStatus !== status) {
        lines.push(`*Transition:* ${previousStatus} → ${status}`);
        lines.push(``);
      }

      if (missing.length > 0) {
        lines.push(`*Pending:* ${missing.join(', ')}`);
        lines.push(``);
      }

      if (rule) {
        lines.push(`*Triggered by:* Rule ${rule.id}`);
      }

      lines.push(`_${new Date().toISOString()}_`);
      return lines.join('\n');
    }

    case 'webhook': {
      return JSON.stringify({
        event: 'readiness_alert',
        symbol,
        direction,
        status,
        score,
        missing,
        previousStatus,
        ruleId: rule ? rule.id : null,
        timestamp: new Date().toISOString(),
      });
    }

    case 'console':
    default: {
      const lines = [
        `\n========================================`,
        `  SIGNAL READINESS ALERT`,
        `========================================`,
        `  Symbol:     ${symbol}`,
        `  Direction:  ${direction} ${dirEmoji}`,
        `  Status:     ${statusEmoji} ${status}`,
        `  Score:      ${score}/100`,
      ];

      if (previousStatus && previousStatus !== status) {
        lines.push(`  Transition: ${previousStatus} -> ${status}`);
      }

      if (missing.length > 0) {
        lines.push(`  Pending:    ${missing.join(', ')}`);
      }

      if (rule) {
        lines.push(`  Rule:       ${rule.id}`);
      }

      lines.push(`  Time:       ${new Date().toISOString()}`);
      lines.push(`========================================\n`);
      return lines.join('\n');
    }
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  updateReadiness,
  addAlertRule,
  removeAlertRule,
  getAlertRules,
  getReadinessStates,
  formatAlert,
  checkAlertCooldown,

  // Expose constants for testing / external use
  STAGE_ORDER,
  PIPELINE_STAGES,
};
