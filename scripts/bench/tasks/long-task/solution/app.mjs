import { createStore } from './store.mjs';
import { createTodo } from './model.mjs';
import { toggle } from './actions.mjs';
import { parseCommand } from './validation.mjs';
import { save, load } from './persistence.mjs';
export function createApp(adapter) {
  const store = createStore(load(adapter));
  return {
    store,
    execute(line) {
      const { command, value } = parseCommand(line);
      if (command === 'list') return store.list();
      if (command === 'add')
        store.add(
          createTodo(
            String(Math.max(0, ...store.list().map((item) => Number(item.id))) + 1),
            value,
          ),
        );
      else if (command === 'done') toggle(store, value);
      else store.remove(value);
      save(adapter, store.list());
      return store.list();
    },
  };
}
