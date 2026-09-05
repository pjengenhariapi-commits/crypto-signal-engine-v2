const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');

const dataFile = path.join(os.tmpdir(), `crypto-paper-${process.pid}.db`);
process.env.DATA_FILE = dataFile;
const { openPaperTrade, closePaperTrade } = require('../server/paperTradingService');
const { getTrades, closeDb } = require('../server/dbService');

test('paper trading abre, impede duplicidade e fecha com taxas', async t => {
  t.after(async () => { closeDb(); const fs = require('fs'); try { fs.unlinkSync(dataFile); } catch {} try { fs.unlinkSync(dataFile + '-wal'); } catch {} try { fs.unlinkSync(dataFile + '-shm'); } catch {} });
  const input = { symbol: 'TESTUSDT', signal: { action: 'COMPRA', score: 80 }, tradeParams: { status: 'COMPRA', entryPrice: 100, stopLoss: 95, takeProfit1: 110, leverageValue: 5 }, walletBalance: 1000, riskPercent: 1 };
  const opened = await openPaperTrade(input);
  assert.equal(opened.status, 'OPEN');
  await assert.rejects(() => openPaperTrade(input), /Já existe/);
  const closed = await closePaperTrade(opened.id, 110, 'TEST');
  assert.equal(closed.status, 'CLOSED');
  assert.ok(closed.pnl > 0);
  assert.equal((await getTrades({ status: 'OPEN' })).length, 0);
});
