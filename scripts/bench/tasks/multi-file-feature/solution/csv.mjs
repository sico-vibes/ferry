const cell = (value) => {
  const s = String(value);
  return /[",\n]/.test(s) ? '"' + s.replaceAll('"', '""') + '"' : s;
};
export const exportCsv = (items) =>
  'id,name,quantity,price\n' +
  items
    .map((item) => [item.id, item.name, item.quantity, item.price].map(cell).join(','))
    .join('\n') +
  (items.length ? '\n' : '');
