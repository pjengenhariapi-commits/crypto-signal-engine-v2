const test = require('node:test');
const assert = require('node:assert/strict');
const { shouldLogSignal } = require('../server/automationState');

test('registra somente transição nova para compra ou venda', () => {
  assert.equal(shouldLogSignal(undefined, 'COMPRA'), false);
  assert.equal(shouldLogSignal('AGUARDAR', 'COMPRA'), true);
  assert.equal(shouldLogSignal('COMPRA', 'COMPRA'), false);
  assert.equal(shouldLogSignal('COMPRA', 'AGUARDAR'), false);
  assert.equal(shouldLogSignal('COMPRA', 'VENDA'), true);
});
