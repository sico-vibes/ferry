export const search = (items, query) =>
  items.filter((item) => item.name.toLowerCase().includes(query.toLowerCase()));
