import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTodo } from './model.mjs';
import { createStore } from './store.mjs';
import { toggle, rename, archive } from './actions.mjs';
import { filter } from './filters.mjs';
import { search } from './search.mjs';
import { sortTodos } from './sort.mjs';
import { parseCommand } from './validation.mjs';
import { encode, decode } from './serialization.mjs';
import { save, load } from './persistence.mjs';
import { stats } from './stats.mjs';
import { createHistory } from './history.mjs';
import { render } from './render.mjs';
import { createApp } from './app.mjs';
import { spawnSync } from 'node:child_process';
const adapter = () => {
  const m = new Map();
  return { getItem: (k) => m.get(k), setItem: (k, v) => m.set(k, v) };
};
test('model/store/actions', () => {
  assert.throws(() => createTodo('', 'x'));
  assert.throws(() => createTodo('1', ' '));
  assert.throws(() => createTodo('1', 'x', 'tomorrow'));
  const store = createStore();
  store.add(createTodo('1', 'Milk'));
  assert.throws(() => store.add(createTodo('1', 'Duplicate')));
  assert.throws(() => store.update('missing', {}));
  const copy = store.list();
  copy[0].title = 'oops';
  assert.equal(store.list()[0].title, 'Milk');
  toggle(store, '1');
  assert.equal(store.list()[0].done, true);
  rename(store, '1', 'Bread');
  assert.equal(store.list()[0].title, 'Bread');
  assert.throws(() => rename(store, '1', ''));
  archive(store, '1');
  assert.equal(store.list()[0].archived, true);
  store.remove('1');
  assert.equal(store.list().length, 0);
});
test('filter search sort stats', () => {
  const rows = [
    createTodo('1', 'Milk'),
    { ...createTodo('2', 'Bread', '2026-01-01'), done: true },
    { ...createTodo('3', 'Tea'), archived: true },
  ];
  assert.equal(filter(rows, 'active').length, 1);
  assert.equal(filter(rows, 'completed')[0].id, '2');
  assert.equal(filter(rows, 'all').length, 2);
  assert.equal(filter(rows, 'archived')[0].id, '3');
  assert.equal(search(rows, 'MIL')[0].id, '1');
  assert.equal(sortTodos(rows)[0].id, '2');
  assert.equal(rows[0].id, '1');
  assert.deepEqual(stats(rows), { total: 3, active: 1, completed: 1, archived: 1 });
});
test('command serialization persistence history', () => {
  assert.deepEqual(parseCommand('add Buy milk'), { command: 'add', value: 'Buy milk' });
  assert.deepEqual(parseCommand('list'), { command: 'list', value: '' });
  assert.throws(() => parseCommand('add'));
  assert.throws(() => parseCommand('wat'));
  const rows = [createTodo('1', 'Milk')];
  assert.deepEqual(decode(encode(rows)), rows);
  assert.throws(() => decode('{'));
  assert.throws(() => decode('{"version":2,"items":[]}'));
  const memory = adapter();
  save(memory, rows);
  assert.deepEqual(load(memory), rows);
  assert.deepEqual(load(adapter()), []);
  assert.deepEqual(load({ getItem: () => '{' }), []);
  const history = createHistory();
  history.push(rows);
  rows[0].title = 'changed';
  assert.equal(history.undo()[0].title, 'Milk');
  assert.equal(history.undo(), null);
});
test('safe render and app persistence', () => {
  const html = render([{ ...createTodo('1', '<script>'), done: true }]);
  assert(html.includes('&lt;script&gt;'));
  assert(!html.includes('<script>'));
  assert(/checkbox/.test(html));
  assert(/checked/.test(html));
  const memory = adapter();
  const app = createApp(memory);
  app.execute('add Buy milk');
  app.execute('done 1');
  assert.equal(app.store.list()[0].done, true);
  assert.equal(createApp(memory).store.list()[0].title, 'Buy milk');
  app.execute('delete 1');
  assert.deepEqual(app.execute('list'), []);
});
test('CLI', { timeout: 30000 }, () => {
  const invoke = (...args) =>
    spawnSync(process.execPath, ['cli.mjs', ...args], { encoding: 'utf8', timeout: 5000 });
  const result = invoke('add', 'Buy', 'milk');
  assert.equal(result.status, 0);
  assert.equal(JSON.parse(result.stdout)[0].title, 'Buy milk');
  assert.equal(invoke('wat').status, 2);
  assert.deepEqual(JSON.parse(invoke('list').stdout), []);
});
