import { test } from 'node:test';
import assert from 'node:assert/strict';
import { userKey } from './user.mjs';
import { label } from './label.mjs';
import { key } from './main.mjs';
test('format consumers', () => {
  assert.equal(userKey(' ADA '), 'ada');
  assert.equal(label(' Ferry '), '[ferry]');
  assert.equal(key, 'demo');
});
