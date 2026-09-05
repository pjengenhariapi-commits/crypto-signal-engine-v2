const { XMLParser } = require('fast-xml-parser');

const DEFAULT_FEEDS = ['https://www.coindesk.com/arc/outboundfeeds/rss/', 'https://cointelegraph.com/rss'];
const ASSET_TERMS = {
  BTC: ['bitcoin', 'btc'], ETH: ['ethereum', 'ether', 'eth'], SOL: ['solana', 'sol'], BNB: ['bnb', 'binance coin'], XRP: ['xrp', 'ripple'],
  DOGE: ['dogecoin', 'doge'], ADA: ['cardano', 'ada'], AVAX: ['avalanche', 'avax'], LINK: ['chainlink', 'link'], SUI: ['sui']
};
const MARKET_TERMS = ['crypto market', 'cryptocurrency market', 'bitcoin', 'federal reserve', 'interest rate', 'inflation', 'sec ', 'regulation', 'etf'];
let cache = { createdAt: 0, articles: [] };

const cleanText = value => String(value || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const asArray = value => Array.isArray(value) ? value : value ? [value] : [];

function parseFeed(xml, source) {
  const parsed = new XMLParser({ ignoreAttributes: false, processEntities: true }).parse(xml);
  const rawItems = asArray(parsed.rss?.channel?.item || parsed.feed?.entry);
  return rawItems.map(item => {
    const rawLink = typeof item.link === 'object' ? item.link['@_href'] : item.link;
    const publishedAt = item.pubDate || item.published || item.updated || null;
    return { source, title: cleanText(item.title), summary: cleanText(item.description || item.summary).slice(0, 280), link: /^https?:\/\//.test(String(rawLink || '')) ? String(rawLink) : null, publishedAt: publishedAt && Number.isFinite(Date.parse(publishedAt)) ? new Date(publishedAt).toISOString() : null };
  }).filter(item => item.title && item.link);
}

function sentiment(title) {
  const text = title.toLowerCase();
  const positive = (text.match(/\b(surge|rally|gain|rise|approval|adoption|record|breakout|bullish|upgrade|partnership)\b/g) || []).length;
  const negative = (text.match(/\b(drop|fall|crash|hack|exploit|lawsuit|ban|bearish|liquidation|outflow|fraud|probe)\b/g) || []).length;
  return positive > negative ? 'POSITIVO' : negative > positive ? 'NEGATIVO' : 'NEUTRO';
}

async function fetchFeeds() {
  if (Date.now() - cache.createdAt < 5 * 60 * 1000) return cache.articles;
  const configured = String(process.env.CRYPTO_NEWS_FEEDS || '').split(',').map(item => item.trim()).filter(Boolean);
  const feeds = configured.length ? configured : DEFAULT_FEEDS;
  const settled = await Promise.allSettled(feeds.map(async url => {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 7000);
    try { const response = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'AlphaEngine/1.0 RSS Reader' } }); if (!response.ok) throw new Error(`HTTP ${response.status}`); return parseFeed(await response.text(), new URL(url).hostname.replace(/^www\./, '')); }
    finally { clearTimeout(timer); }
  }));
  const articles = settled.filter(item => item.status === 'fulfilled').flatMap(item => item.value).sort((a, b) => Date.parse(b.publishedAt || 0) - Date.parse(a.publishedAt || 0));
  cache = { createdAt: Date.now(), articles };
  return articles;
}

function rankArticle(article, symbol) {
  const base = symbol.replace(/USDT$/, ''); const text = `${article.title} ${article.summary}`.toLowerCase(); const terms = ASSET_TERMS[base] || [base.toLowerCase()];
  if (terms.some(term => new RegExp(`(^|[^a-z0-9])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`, 'i').test(text))) return 2;
  return MARKET_TERMS.some(term => text.includes(term)) ? 1 : 0;
}

async function getNewsContext(symbol, limit = 5) {
  try {
    const articles = await fetchFeeds(); const cutoff = Date.now() - 72 * 60 * 60 * 1000;
    const items = articles.map(article => ({ ...article, relevanceScore: rankArticle(article, symbol), sentiment: sentiment(article.title) })).filter(article => article.relevanceScore > 0 && (!article.publishedAt || Date.parse(article.publishedAt) >= cutoff)).sort((a, b) => b.relevanceScore - a.relevanceScore || Date.parse(b.publishedAt || 0) - Date.parse(a.publishedAt || 0)).slice(0, limit);
    const assetSpecific = items.filter(item => item.relevanceScore === 2).length; const score = items.reduce((sum, item) => sum + (item.sentiment === 'POSITIVO' ? 1 : item.sentiment === 'NEGATIVO' ? -1 : 0) * item.relevanceScore, 0);
    return { available: articles.length > 0, assetSpecific, sentiment: score >= 2 ? 'POSITIVO' : score <= -2 ? 'NEGATIVO' : 'MISTO/NEUTRO', items, sources: [...new Set(items.map(item => item.source))] };
  } catch (error) { return { available: false, assetSpecific: 0, sentiment: 'INDISPONÍVEL', items: [], sources: [], error: error.message }; }
}

module.exports = { parseFeed, sentiment, rankArticle, getNewsContext };
