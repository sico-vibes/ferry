export const search = (items, query) =>
  items.filter((item) => item.title.toLowerCase().includes(query.toLowerCase()));
