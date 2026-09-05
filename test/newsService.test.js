const test = require('node:test');
const assert = require('node:assert/strict');
const { parseFeed, sentiment, rankArticle } = require('../server/newsService');

test('parser de RSS normaliza título, link e data', () => {
  const items = parseFeed('<?xml version="1.0"?><rss><channel><item><title>Bitcoin rallies</title><link>https://example.com/a</link><pubDate>Thu, 03 Sep 2026 12:00:00 GMT</pubDate></item></channel></rss>', 'example');
  assert.equal(items.length, 1);
  assert.equal(items[0].title, 'Bitcoin rallies');
  assert.equal(items[0].source, 'example');
});

test('notícia específica do ativo recebe prioridade', () => {
  const article = { title: 'Solana upgrade gains adoption', summary: '' };
  assert.equal(rankArticle(article, 'SOLUSDT'), 2);
  assert.equal(sentiment(article.title), 'POSITIVO');
});
