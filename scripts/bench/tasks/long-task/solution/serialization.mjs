export const encode = (items) => JSON.stringify({ version: 1, items });
export function decode(text) {
  const value = JSON.parse(text);
  if (value.version !== 1 || !Array.isArray(value.items)) throw Error('Invalid data');
  return value.items;
}
