/** Add or remove one model ref, keeping the existing order and any non-model entries. */
export function toggleModel(value: readonly string[], ref: string, checked: boolean): string[] {
  if (checked) return value.includes(ref) ? [...value] : [...value, ref];
  return value.filter((item) => item !== ref);
}

/** Move one entry up (-1) or down (+1); out-of-range moves leave the list unchanged. */
export function moveItem(value: readonly string[], ref: string, delta: -1 | 1): string[] {
  const index = value.indexOf(ref);
  const target = index + delta;
  const swapped = value[target];
  if (index < 0 || swapped === undefined) return [...value];
  const next = [...value];
  next[index] = swapped;
  next[target] = ref;
  return next;
}

export type GatewayRoutingMode = 'profile' | 'models';

export const NO_PROFILE = 'none';

export function gatewayRoutingMode(profile: string): GatewayRoutingMode {
  return profile === NO_PROFILE ? 'models' : 'profile';
}
