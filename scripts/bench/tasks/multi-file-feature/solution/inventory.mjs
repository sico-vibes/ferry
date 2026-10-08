import { validateItem } from './validation.mjs';
export function createInventory() {
  const rows = new Map();
  return {
    add(item) {
      const valid = validateItem(item);
      if (rows.has(valid.id)) throw Error('Duplicate');
      rows.set(valid.id, valid);
    },
    update(id, patch) {
      if (!rows.has(id)) throw Error('Missing');
      rows.set(id, validateItem({ ...rows.get(id), ...patch, id }));
    },
    remove(id) {
      rows.delete(id);
    },
    list() {
      return [...rows.values()].map((item) => ({ ...item }));
    },
  };
}
