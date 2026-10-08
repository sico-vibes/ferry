export function toggle(store, id) {
  const item = store.list().find((item) => item.id === id);
  if (!item) throw Error('Missing');
  store.update(id, { done: !item.done });
}
export function rename(store, id, title) {
  if (typeof title !== 'string' || !title.trim()) throw Error('Blank title');
  store.update(id, { title });
}
export const archive = (store, id) => store.update(id, { archived: true });
