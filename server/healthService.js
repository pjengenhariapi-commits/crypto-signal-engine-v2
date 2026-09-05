'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const LOG_BUFFER_SIZE = 500;
const METRICS_HISTORY_SIZE = 100;
const METRICS_SNAPSHOT_INTERVAL_MS = 30_000;
const ALERT_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

const LOG_LEVELS = Object.freeze({
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
  CRITICAL: 4,
});

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------
const logBuffer = [];          // ring buffer of structured log entries
const metricsHistory = [];     // last 100 snapshots
let monitoringInterval = null; // handle returned by setInterval
let lastEventLoopCheck = process.hrtime.bigint();
let eventLoopLagMs = 0;

const lastAlertTimes = {};     // key -> Date.now()

// ---------------------------------------------------------------------------
// Helpers – event-loop lag estimation
// ---------------------------------------------------------------------------
function measureEventLoopLag() {
  const now = process.hrtime.bigint();
  const lagNs = Number(now - lastEventLoopCheck) - METRICS_SNAPSHOT_INTERVAL_MS * 1_000_000;
  lastEventLoopCheck = now;
  eventLoopLagMs = Math.max(0, Math.round(lagNs / 1_000_000));
}

// Kick-off background lag estimation
(function initLagMeasurement() {
  lastEventLoopCheck = process.hrtime.bigint();
  setImmediate(function tick() {
    measureEventLoopLag();
    setTimeout(tick, 1000);
  });
})();

// ---------------------------------------------------------------------------
// Helpers – HTTP requests with timeout
// ---------------------------------------------------------------------------
function httpGet(url, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const parsed = new URL(url);
    const mod = parsed.protocol === 'https:' ? https : http;
    const req = mod.get(url, { timeout: timeoutMs }, (res) => {
      // consume response so socket can be released
      res.resume();
      resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, statusCode: res.statusCode });
    });
    req.on('error', () => resolve({ ok: false, error: 'request_failed' }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
  });
}

// ---------------------------------------------------------------------------
// Structured Logging
// ---------------------------------------------------------------------------
function log(level, message, metadata = {}) {
  if (typeof level === 'string') level = level.toUpperCase();
  if (LOG_LEVELS[level] === undefined) level = 'INFO';

  const entry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    metadata,
  };

  logBuffer.push(entry);
  if (logBuffer.length > LOG_BUFFER_SIZE) logBuffer.shift();

  // also write to stdout for operator visibility
  console.log(`[${entry.timestamp}] [${level}] ${message}`, Object.keys(metadata).length ? metadata : '');

  // auto-alert on CRITICAL
  if (level === 'CRITICAL') {
    sendAlert('critical', `CRITICAL: ${message}`, metadata);
  }

  return entry;
}

function getRecentLogs(level, limit = 50) {
  let entries = logBuffer;
  if (level) {
    const minLevel = typeof level === 'string' ? (LOG_LEVELS[level.toUpperCase()] ?? 1) : level;
    entries = entries.filter((e) => (LOG_LEVELS[e.level] ?? 0) >= minLevel);
  }
  return entries.slice(-limit);
}

// ---------------------------------------------------------------------------
// System Metrics
// ---------------------------------------------------------------------------
function getSystemMetrics() {
  const cpu = process.cpuUsage();
  const mem = process.memoryUsage();

  let activeHandles = 0;
  try {
    activeHandles = process._getActiveHandles().length;
  } catch (_) {
    // graceful fallback if unavailable
  }

  return {
    cpu: {
      user: cpu.user,      // microseconds
      system: cpu.system,  // microseconds
    },
    memory: {
      rss: mem.rss,
      heapUsed: mem.heapUsed,
      heapTotal: mem.heapTotal,
      external: mem.external,
      arrayBuffers: mem.arrayBuffers || 0,
      rssMB: Math.round(mem.rss / 1024 / 1024 * 100) / 100,
      heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024 * 100) / 100,
    },
    uptime: process.uptime(),
    activeHandles,
    eventLoopLagMs,
  };
}

// ---------------------------------------------------------------------------
// Service Health Checks
// ---------------------------------------------------------------------------
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, '..', 'trading_brain.db');
const AI_SERVICE_URL = process.env.AI_SERVICE_URL || 'http://localhost:11434/api/tags';

async function checkServices() {
  const [binance, aiService, database] = await Promise.all([
    checkBinance(),
    checkAIService(),
    checkDatabase(),
  ]);

  return {
    binance,
    aiService,
    database,
    allHealthy: binance.healthy && aiService.healthy && database.healthy,
    checkedAt: new Date().toISOString(),
  };
}

async function checkBinance() {
  const start = Date.now();
  try {
    const res = await httpGet('https://fapi.binance.com/fapi/v1/ping', 2000);
    const latencyMs = Date.now() - start;
    return {
      name: 'Binance API',
      healthy: res.ok,
      latencyMs,
      detail: res.ok ? 'reachable' : (res.error || `HTTP ${res.statusCode}`),
    };
  } catch (err) {
    return { name: 'Binance API', healthy: false, latencyMs: Date.now() - start, detail: err.message };
  }
}

async function checkAIService() {
  const start = Date.now();
  try {
    const res = await httpGet(AI_SERVICE_URL, 2000);
    const latencyMs = Date.now() - start;
    return {
      name: 'AI Service',
      healthy: res.ok,
      latencyMs,
      detail: res.ok ? 'reachable' : (res.error || `HTTP ${res.statusCode}`),
    };
  } catch (err) {
    return { name: 'AI Service', healthy: false, latencyMs: Date.now() - start, detail: err.message };
  }
}

async function checkDatabase() {
  const start = Date.now();
  try {
    fs.accessSync(DATA_FILE, fs.constants.R | fs.constants.W);
    const stat = fs.statSync(DATA_FILE);
    return {
      name: 'Database File',
      healthy: true,
      latencyMs: Date.now() - start,
      detail: 'accessible',
      sizeBytes: stat.size,
      lastModified: stat.mtime.toISOString(),
    };
  } catch (err) {
    return {
      name: 'Database File',
      healthy: false,
      latencyMs: Date.now() - start,
      detail: err.message,
    };
  }
}

// ---------------------------------------------------------------------------
// Metrics Snapshot & History
// ---------------------------------------------------------------------------
function takeMetricsSnapshot() {
  const snapshot = {
    timestamp: new Date().toISOString(),
    system: getSystemMetrics(),
  };

  metricsHistory.push(snapshot);
  if (metricsHistory.length > METRICS_HISTORY_SIZE) metricsHistory.shift();

  return snapshot;
}

function getMetricsTrend() {
  if (metricsHistory.length < 2) return null;

  const recent = metricsHistory.slice(-10);
  const earlier = metricsHistory.slice(0, 10);
  if (recent.length < 2 || earlier.length < 2) return null;

  const avgRecent = {
    heapUsedMB: recent.reduce((s, m) => s + m.system.memory.heapUsedMB, 0) / recent.length,
    rssMB: recent.reduce((s, m) => s + m.system.memory.rssMB, 0) / recent.length,
    eventLoopLagMs: recent.reduce((s, m) => s + m.system.eventLoopLagMs, 0) / recent.length,
  };
  const avgEarlier = {
    heapUsedMB: earlier.reduce((s, m) => s + m.system.memory.heapUsedMB, 0) / earlier.length,
    rssMB: earlier.reduce((s, m) => s + m.system.memory.rssMB, 0) / earlier.length,
    eventLoopLagMs: earlier.reduce((s, m) => s + m.system.eventLoopLagMs, 0) / earlier.length,
  };

  return {
    memoryGrowing: avgRecent.heapUsedMB > avgEarlier.heapUsedMB * 1.1,
    memoryTrendMB: +(avgRecent.heapUsedMB - avgEarlier.heapUsedMB).toFixed(2),
    rssGrowing: avgRecent.rssMB > avgEarlier.rssMB * 1.1,
    rssTrendMB: +(avgRecent.rssMB - avgEarlier.rssMB).toFixed(2),
    eventLoopLagGrowing: avgRecent.eventLoopLagMs > avgEarlier.eventLoopLagMs * 1.5,
    eventLoopLagTrendMs: +(avgRecent.eventLoopLagMs - avgEarlier.eventLoopLagMs).toFixed(2),
    dataPoints: metricsHistory.length,
  };
}

// ---------------------------------------------------------------------------
// Alert Webhook
// ---------------------------------------------------------------------------
const ALERT_WEBHOOK_URL = process.env.ALERT_WEBHOOK_URL || '';

function sendAlert(alertKey, text, metadata = {}) {
  const now = Date.now();
  if (lastAlertTimes[alertKey] && now - lastAlertTimes[alertKey] < ALERT_COOLDOWN_MS) {
    return; // cooldown active – skip
  }
  lastAlertTimes[alertKey] = now;

  log('WARN', `Alert triggered: ${text}`, metadata);

  if (!ALERT_WEBHOOK_URL) return;

  const payload = JSON.stringify({
    alertKey,
    text,
    metadata,
    timestamp: new Date().toISOString(),
  });
  const parsed = new URL(ALERT_WEBHOOK_URL);
  const mod = parsed.protocol === 'https:' ? https : http;

  const req = mod.request(
    ALERT_WEBHOOK_URL,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
      timeout: 5000,
    },
    (res) => { res.resume(); },
  );
  req.on('error', () => log('ERROR', 'Failed to send alert webhook'));
  req.on('timeout', () => { req.destroy(); log('ERROR', 'Alert webhook timed out'); });
  req.write(payload);
  req.end();
}

function evaluateHealthAndAlert(metrics, services) {
  // Memory > 500 MB
  if (metrics.memory.rssMB > 500) {
    sendAlert('high_memory', `Memory usage is ${metrics.memory.rssMB} MB (threshold 500 MB)`, {
      rssMB: metrics.memory.rssMB,
    });
  }

  // Event loop lag > 1 s
  if (metrics.eventLoopLagMs > 1000) {
    sendAlert('event_loop_lag', `Event loop lag is ${metrics.eventLoopLagMs} ms (threshold 1000 ms)`, {
      eventLoopLagMs: metrics.eventLoopLagMs,
    });
  }

  // Services down
  if (!services.binance.healthy) {
    sendAlert('binance_down', 'Binance API is unreachable', services.binance);
  }
  if (!services.aiService.healthy) {
    sendAlert('ai_service_down', 'AI Service is unreachable', services.aiService);
  }
  if (!services.database.healthy) {
    sendAlert('database_down', 'Database file is inaccessible', services.database);
  }
}

// ---------------------------------------------------------------------------
// Full Health Report
// ---------------------------------------------------------------------------
async function getHealthReport() {
  const metrics = getSystemMetrics();
  let services;
  try {
    services = await checkServices();
  } catch (err) {
    services = {
      binance: { healthy: false },
      aiService: { healthy: false },
      database: { healthy: false },
      allHealthy: false,
      error: err.message,
    };
  }

  evaluateHealthAndAlert(metrics, services);

  const trend = getMetricsTrend();

  return {
    status: services.allHealthy && metrics.eventLoopLagMs < 1000 ? 'healthy' : 'degraded',
    timestamp: new Date().toISOString(),
    system: metrics,
    services,
    trend,
    metricsSnapshots: metricsHistory.length,
    logBuffer: {
      size: logBuffer.length,
      maxSize: LOG_BUFFER_SIZE,
    },
    recentCriticalLogs: getRecentLogs('CRITICAL', 5),
  };
}

// ---------------------------------------------------------------------------
// Monitoring loop
// ---------------------------------------------------------------------------
function startMonitoring(intervalMs = 30_000) {
  if (monitoringInterval) {
    log('WARN', 'Monitoring is already running. Call stopMonitoring first.');
    return;
  }

  log('INFO', `Starting health monitoring every ${intervalMs} ms`);

  // Take an immediate snapshot
  const snap = takeMetricsSnapshot();
  log('INFO', `Health snapshot: RSS=${snap.system.memory.rssMB} MB, heap=${snap.system.memory.heapUsedMB} MB, lag=${snap.system.eventLoopLagMs} ms`);

  monitoringInterval = setInterval(async () => {
    try {
      const metrics = getSystemMetrics();
      const services = await checkServices();
      takeMetricsSnapshot();
      evaluateHealthAndAlert(metrics, services);

      log('DEBUG', `Health check: allHealthy=${services.allHealthy}, RSS=${metrics.memory.rssMB} MB, lag=${metrics.eventLoopLagMs} ms`);
    } catch (err) {
      log('ERROR', `Health monitoring iteration failed: ${err.message}`);
    }
  }, intervalMs);
}

function stopMonitoring() {
  if (monitoringInterval) {
    clearInterval(monitoringInterval);
    monitoringInterval = null;
    log('INFO', 'Health monitoring stopped');
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = {
  getHealthReport,
  getRecentLogs,
  log,
  startMonitoring,
  stopMonitoring,
  checkServices,
  // exposed for advanced usage / testing
  LOG_LEVELS,
  takeMetricsSnapshot,
  getMetricsTrend,
};
