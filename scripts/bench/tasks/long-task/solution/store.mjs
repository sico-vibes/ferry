export function createStore(initial = []) {
  const rows = new Map(initial.map((item) => [item.id, structuredClone(item)]));
  return {
    add(item) {
      if (rows.has(item.id)) throw Error('Duplicate');
      rows.set(item.id, structuredClone(item));
    },
    list() {
      return structuredClone([...rows.values()]);
    },
    update(id, patch) {
      if (!rows.has(id)) throw Error('Missing');
      rows.set(id, { ...rows.get(id), ...structuredClone(patch), id });
    },
    remove(id) {
      rows.delete(id);
    },
  };
}
