export function isExpectedCorePortOrigin(
  protocol: string,
  eventOrigin: string,
  locationOrigin: string,
): boolean {
  if (protocol === 'file:') return eventOrigin === 'null' || eventOrigin === 'file://';
  return eventOrigin === locationOrigin;
}
