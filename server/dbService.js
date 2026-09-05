/**
 * dbService.js — SQLite-backed persistence layer for Crypto Signal Engine v2.0
 * 
 * Replaces the file-based JSON persistence with SQLite for:
 * - Atomic writes (no corruption on crash)
 * - Query performance (index-based lookups)
 * - Concurrent access safety
 * - Easy backup (single file copy)
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.resolve(process.env.DATA_FILE || path.join(__dirname, '../trading_brain.db'));

let db;

function getDb() {
  if (db) return db;
  
  // Ensure directory exists
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  
  try {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('foreign_keys = ON');
    db.pragma('cache_size = -64000'); // 64MB cache
    db.pragma('temp_store = MEMORY');
    migrate(db);
    return db;
  } catch (err) {
    console.error('SQLite initialization error:', err.message);
    // Try creating a new database if corruption detected
    if (err.message.includes('disk I/O') || err.message.includes('corrupt')) {
      console.log('Attempting to recover from corrupted database...');
      try {
        const backupPath = DB_PATH + '.backup.' + Date.now();
        if (fs.existsSync(DB_PATH)) {
          fs.copyFileSync(DB_PATH, backupPath);
          fs.unlinkSync(DB_PATH);
          // Also remove WAL and SHM files
          try { fs.unlinkSync(DB_PATH + '-wal'); } catch {}
          try { fs.unlinkSync(DB_PATH + '-shm'); } catch {}
        }
        db = new Database(DB_PATH);
        db.pragma('journal_mode = WAL');
        db.pragma('synchronous = NORMAL');
        db.pragma('foreign_keys = ON');
        migrate(db);
        console.log('Database recovered successfully');
        return db;
      } catch (recoveryErr) {
        console.error('Recovery failed:', recoveryErr.message);
        throw recoveryErr;
      }
    }
    throw err;
  }
}

function migrate(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS signals (
      id TEXT PRIMARY KEY,
      symbol TEXT NOT NULL,
      action TEXT,
      score REAL,
      price REAL,
      conviction TEXT,
      cvd_delta REAL,
      poc REAL,
      funding_rate REAL,
      setup TEXT,
      source TEXT,
      timeframe TEXT,
      evidence TEXT,
      timestamp TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_signals_symbol ON signals(symbol);
    CREATE INDEX IF NOT EXISTS idx_signals_timestamp ON signals(timestamp);

    CREATE TABLE IF NOT EXISTS trades (
      id TEXT PRIMARY KEY,
      status TEXT DEFAULT 'OPEN',
      symbol TEXT,
      side TEXT,
      entry_price REAL,
      stop_loss REAL,
      take_profit REAL,
      quantity REAL,
      wallet_balance REAL,
      risk_percent REAL,
      signal_action TEXT,
      signal_score REAL,
      signal_setup TEXT,
      pnl REAL,
      exit_price REAL,
      exit_reason TEXT,
      fee_percent REAL,
      note TEXT,
      tags TEXT,
      review_status TEXT DEFAULT 'IN_REVIEW',
      reviewed_at TEXT,
      entry_time TEXT NOT NULL,
      updated_at TEXT,
      close_time TEXT,
      slippage_percent REAL,
      break_even_activated INTEGER DEFAULT 0,
      trailing_stop_active INTEGER DEFAULT 0,
      gross_pnl REAL,
      fees REAL,
      position_value_usd REAL,
      margin_required REAL,
      risk_amount_usd REAL,
      leverage INTEGER,
      mode TEXT,
      pnl_percent REAL,
      signal_pnl REAL
    );
    CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(status);
    CREATE INDEX IF NOT EXISTS idx_trades_symbol ON trades(symbol);

    CREATE TABLE IF NOT EXISTS validations (
      id TEXT PRIMARY KEY,
      symbol TEXT,
      methodology TEXT,
      folds TEXT,
      summary TEXT,
      timeframe TEXT,
      tested_candles INTEGER,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_validations_symbol ON validations(symbol);

    CREATE TABLE IF NOT EXISTS alerts (
      id TEXT PRIMARY KEY,
      symbol TEXT NOT NULL,
      condition TEXT NOT NULL,
      price REAL NOT NULL,
      status TEXT DEFAULT 'ACTIVE',
      market_price REAL,
      created_at TEXT NOT NULL,
      triggered_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_alerts_status ON alerts(status);
    CREATE INDEX IF NOT EXISTS idx_alerts_symbol ON alerts(symbol);
  `);
}

function generateId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function initDB() { getDb(); }

// ─── Signals ────────────────────────────────────────────

function logSignal(signalData) {
  const d = getDb();
  const id = generateId('sig');
  const stmt = d.prepare(`
    INSERT INTO signals (id, symbol, action, score, price, conviction, cvd_delta, poc, funding_rate, setup, source, timeframe, evidence, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    id, signalData.symbol, signalData.action, signalData.score,
    signalData.price, signalData.conviction, signalData.cvd_delta,
    signalData.poc, signalData.funding_rate, signalData.setup,
    signalData.source, signalData.timeframe,
    signalData.evidence ? JSON.stringify(signalData.evidence) : null,
    new Date().toISOString()
  );
  // Cap at 10,000 signals
  d.prepare(`DELETE FROM signals WHERE id IN (SELECT id FROM signals ORDER BY timestamp ASC LIMIT MAX(0, (SELECT COUNT(*)-10000 FROM signals)))`).run();
  return { id, ...signalData, timestamp: new Date().toISOString() };
}

function getSignals({ symbol, limit = 100 } = {}) {
  const d = getDb();
  const safeLimit = Math.min(Number(limit) || 100, 500);
  if (symbol) {
    return d.prepare(`SELECT * FROM signals WHERE symbol = ? ORDER BY timestamp DESC LIMIT ?`).all(symbol, safeLimit);
  }
  return d.prepare(`SELECT * FROM signals ORDER BY timestamp DESC LIMIT ?`).all(safeLimit);
}

// ─── Trades ─────────────────────────────────────────────

function logTrade(tradeData) {
  const d = getDb();
  const id = generateId('paper');
  const stmt = d.prepare(`
    INSERT INTO trades (id, status, symbol, side, entry_price, stop_loss, take_profit, quantity, wallet_balance, risk_percent, signal_action, signal_score, signal_setup, entry_time)
    VALUES (?, 'OPEN', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    id, tradeData.symbol, tradeData.side, tradeData.entryPrice,
    tradeData.stopLoss, tradeData.takeProfit, tradeData.quantity,
    tradeData.walletBalance, tradeData.riskPercent,
    tradeData.signalAction, tradeData.signalScore, tradeData.signalSetup,
    new Date().toISOString()
  );
  return { id, status: 'OPEN', ...tradeData, entry_time: new Date().toISOString() };
}

function updateTrade(id, changes) {
  const d = getDb();
  const fields = [];
  const values = [];
  for (const [key, value] of Object.entries(changes)) {
    const column = key.replace(/([A-Z])/g, '_$1').toLowerCase();
    fields.push(`${column} = ?`);
    values.push(typeof value === 'object' ? JSON.stringify(value) : value);
  }
  fields.push('updated_at = ?');
  values.push(new Date().toISOString());
  values.push(id);
  const result = d.prepare(`UPDATE trades SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  if (result.changes === 0) return null;
  return d.prepare(`SELECT * FROM trades WHERE id = ?`).get(id);
}

function getTrades({ status, limit = 100 } = {}) {
  const d = getDb();
  const safeLimit = Math.min(Number(limit) || 100, 500);
  if (status) {
    return d.prepare(`SELECT * FROM trades WHERE status = ? ORDER BY entry_time DESC LIMIT ?`).all(status, safeLimit);
  }
  return d.prepare(`SELECT * FROM trades ORDER BY entry_time DESC LIMIT ?`).all(safeLimit);
}

function getPerformanceStats() {
  const d = getDb();
  const closed = d.prepare(`SELECT * FROM trades WHERE status = 'CLOSED' ORDER BY close_time DESC LIMIT 500`).all();
  const openCount = d.prepare(`SELECT COUNT(*) as cnt FROM trades WHERE status = 'OPEN'`).get().cnt;
  const wins = closed.filter(t => Number(t.pnl) > 0).length;
  const losses = closed.filter(t => Number(t.pnl) < 0).length;
  const totalPnl = closed.reduce((sum, t) => sum + (Number(t.pnl) || 0), 0);
  return {
    total_trades: closed.length, wins, losses,
    win_rate: closed.length ? wins / closed.length * 100 : 0,
    total_pnl: totalPnl,
    avg_pnl: closed.length ? totalPnl / closed.length : 0,
    open_trades: openCount
  };
}

// ─── Validations ────────────────────────────────────────

function saveValidation(validation) {
  const d = getDb();
  const id = generateId('val');
  d.prepare(`
    INSERT INTO validations (id, symbol, methodology, folds, summary, timeframe, tested_candles, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, validation.symbol, validation.methodology,
    JSON.stringify(validation.folds), JSON.stringify(validation.summary),
    validation.timeframe, validation.testedCandles || validation.tested_candles,
    new Date().toISOString()
  );
  // Cap at 200
  d.prepare(`DELETE FROM validations WHERE id IN (SELECT id FROM validations ORDER BY created_at ASC LIMIT MAX(0, (SELECT COUNT(*)-200 FROM validations)))`).run();
  return { id, ...validation, created_at: new Date().toISOString() };
}

function getValidations(symbol) {
  const d = getDb();
  if (symbol) {
    return d.prepare(`SELECT * FROM validations WHERE symbol = ? ORDER BY created_at DESC`).all(symbol)
      .map(v => ({ ...v, folds: JSON.parse(v.folds || '[]'), summary: JSON.parse(v.summary || '{}') }));
  }
  return d.prepare(`SELECT * FROM validations ORDER BY created_at DESC`).all()
    .map(v => ({ ...v, folds: JSON.parse(v.folds || '[]'), summary: JSON.parse(v.summary || '{}') }));
}

function isSymbolApproved(symbol) {
  const validations = getValidations(symbol);
  const latest = validations[0];
  return Boolean(latest && latest.summary && latest.summary.approved);
}

// ─── Price Alerts ───────────────────────────────────────

function createPriceAlert({ symbol, condition, price }) {
  const d = getDb();
  const id = generateId('alert');
  d.prepare(`
    INSERT INTO alerts (id, symbol, condition, price, status, created_at)
    VALUES (?, ?, ?, ?, 'ACTIVE', ?)
  `).run(id, symbol, condition, price, new Date().toISOString());
  return { id, symbol, condition, price, status: 'ACTIVE', created_at: new Date().toISOString() };
}

function getPriceAlerts({ status, symbol } = {}) {
  const d = getDb();
  let query = 'SELECT * FROM alerts WHERE 1=1';
  const params = [];
  if (status) { query += ' AND status = ?'; params.push(status); }
  if (symbol) { query += ' AND symbol = ?'; params.push(symbol); }
  query += ' ORDER BY created_at DESC';
  return d.prepare(query).all(...params);
}

function triggerPriceAlert(id, marketPrice) {
  const d = getDb();
  const now = new Date().toISOString();
  const result = d.prepare(`UPDATE alerts SET status = 'TRIGGERED', market_price = ?, triggered_at = ? WHERE id = ? AND status = 'ACTIVE'`).run(marketPrice, now, id);
  if (result.changes === 0) return null;
  return d.prepare(`SELECT * FROM alerts WHERE id = ?`).get(id);
}

function deletePriceAlert(id) {
  const d = getDb();
  const result = d.prepare(`DELETE FROM alerts WHERE id = ?`).run(id);
  return result.changes > 0;
}

// ─── Lifecycle ──────────────────────────────────────────

function closeDb() {
  if (db) { 
    try { db.close(); } catch (e) { console.error('Error closing DB:', e.message); }
    db = null; 
  }
}

process.on('exit', closeDb);
process.on('SIGINT', () => { closeDb(); process.exit(0); });
process.on('SIGTERM', () => { closeDb(); process.exit(0); });

module.exports = {
  DB_PATH, initDB, closeDb, getDb,
  logSignal, getSignals,
  logTrade, updateTrade, getTrades, getPerformanceStats,
  saveValidation, getValidations, isSymbolApproved,
  createPriceAlert, getPriceAlerts, triggerPriceAlert, deletePriceAlert
};
