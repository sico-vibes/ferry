export function createRng(seed = 1) {
  let state = seed >>> 0;
  return {
    next(): number {
      state += 0x6d2b79f5;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
    int(min: number, max: number): number {
      return Math.floor(this.next() * (max - min + 1)) + min;
    },
    pick<T>(arr: readonly T[]): T {
      const value = arr[Math.floor(this.next() * arr.length)];
      if (value === undefined) throw new Error('Cannot pick from an empty array');
      return value;
    },
  };
}
