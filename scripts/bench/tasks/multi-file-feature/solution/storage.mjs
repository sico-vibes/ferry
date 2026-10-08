export function save(adapter, items) {
  adapter.setItem('inventory', JSON.stringify(items));
}
export function load(adapter) {
  try {
    const rows = JSON.parse(adapter.getItem('inventory') || '[]');
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}
