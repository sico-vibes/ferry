export function slug(text) {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}
export function clamp(value, min, max) {
  if (min > max) throw new RangeError('min exceeds max');
  return Math.min(max, Math.max(min, value));
}
