const test = require('node:test');
const assert = require('node:assert/strict');
const { isAlertTriggered } = require('../server/alertService');

test('alerta ABOVE dispara ao alcançar ou superar o preço', () => {
  assert.equal(isAlertTriggered({ condition: 'ABOVE', price: 100 }, 100), true);
  assert.equal(isAlertTriggered({ condition: 'ABOVE', price: 100 }, 99.99), false);
});

test('alerta BELOW dispara ao alcançar ou cruzar abaixo do preço', () => {
  assert.equal(isAlertTriggered({ condition: 'BELOW', price: 100 }, 99), true);
  assert.equal(isAlertTriggered({ condition: 'BELOW', price: 100 }, 101), false);
});
