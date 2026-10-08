import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sum } from './sum.mjs';
test('sum handles signed numbers', () => {
  assert.equal(sum(2, 3), 5);
  assert.equal(sum(-3, 2), -1);
  assert.equal(sum(0, 0), 0);
});
