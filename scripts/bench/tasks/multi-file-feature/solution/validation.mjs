export function validateItem(item) {
  if (
    !item ||
    typeof item.id !== 'string' ||
    !item.id.trim() ||
    typeof item.name !== 'string' ||
    !item.name.trim() ||
    !Number.isInteger(item.quantity) ||
    item.quantity < 0 ||
    !Number.isFinite(item.price) ||
    item.price < 0
  )
    throw new Error('Invalid item');
  return { ...item };
}
