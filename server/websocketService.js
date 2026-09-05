const WebSocket = require('ws');
const { DEFAULT_SYMBOLS } = require('./binanceService');

const WS_URL = 'wss://fstream.binance.com/stream';
const priceCache = {};
let socket = null;
let reconnectTimer = null;
let stopped = false;

function initPriceStream() {
  if (socket && [WebSocket.OPEN, WebSocket.CONNECTING].includes(socket.readyState)) return socket;
  stopped = false;
  const streams = DEFAULT_SYMBOLS.map(symbol => `${symbol.toLowerCase()}@ticker`).join('/');
  socket = new WebSocket(`${WS_URL}?streams=${streams}`);

  socket.on('message', raw => {
    try {
      const payload = JSON.parse(raw.toString());
      const ticker = payload.data || payload;
      if (!ticker.s) return;
      priceCache[ticker.s] = {
        lastPrice: Number(ticker.c), priceChangePercent: Number(ticker.P),
        highPrice: Number(ticker.h), lowPrice: Number(ticker.l), quoteVolume: Number(ticker.q),
        source: 'websocket', updatedAt: Date.now()
      };
    } catch (error) { console.error('Invalid Binance stream message:', error.message); }
  });
  socket.on('error', error => console.error('Binance WebSocket error:', error.message));
  socket.on('close', () => {
    socket = null;
    if (!stopped) reconnectTimer = setTimeout(initPriceStream, 5000);
  });
  return socket;
}

function stopPriceStream() {
  stopped = true;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  if (socket) socket.close();
  socket = null;
}

function getCachedTicker(symbol, maxAgeMs = 30000) {
  const ticker = priceCache[String(symbol).toUpperCase()];
  return ticker && Date.now() - ticker.updatedAt <= maxAgeMs ? ticker : null;
}

function getStreamStatus() {
  return { connected: Boolean(socket && socket.readyState === WebSocket.OPEN), cachedSymbols: Object.keys(priceCache).length };
}

module.exports = { initPriceStream, stopPriceStream, getCachedTicker, getStreamStatus };
