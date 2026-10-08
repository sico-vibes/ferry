import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
const invoke = (...args) =>
  spawnSync(process.execPath, ['greet.mjs', ...args], { encoding: 'utf8', timeout: 5000 });
test('greet flags in either order', { timeout: 30000 }, () => {
  assert.equal(invoke().stdout.trim(), 'Hello, world!');
  assert.equal(invoke('--name', 'Ada').stdout.trim(), 'Hello, Ada!');
  assert.equal(invoke('--uppercase', '--name', 'Ada').stdout.trim(), 'HELLO, ADA!');
  assert.equal(invoke('--name', 'Ada', '--uppercase').stdout.trim(), 'HELLO, ADA!');
  assert.equal(invoke('--wat').status, 2);
  assert.equal(invoke('--name').status, 2);
});
