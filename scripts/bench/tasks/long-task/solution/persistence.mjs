import { encode, decode } from './serialization.mjs';
export const save = (adapter, items) => adapter.setItem('todos', encode(items));
export function load(adapter) {
  try {
    return decode(adapter.getItem('todos'));
  } catch {
    return [];
  }
}
