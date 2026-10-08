export const summary = (items) => ({
  units: items.reduce((n, item) => n + item.quantity, 0),
  value: items.reduce((n, item) => n + item.quantity * item.price, 0),
});
