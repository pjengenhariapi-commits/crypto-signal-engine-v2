const test = require('node:test');
const assert = require('node:assert/strict');
const { responseText } = require('../server/aiService');

test('extrai output_text direto da Responses API', () => {
  assert.equal(responseText({ output_text: ' análise ' }), 'análise');
});

test('extrai texto da lista de outputs', () => {
  assert.equal(responseText({ output: [{ content: [{ type: 'output_text', text: 'resultado' }] }] }), 'resultado');
});
