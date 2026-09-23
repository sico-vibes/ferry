export interface Clock {
  now(): Date;
  setTimeout(fn: () => void, ms: number): () => void;
}

export const systemClock: Clock = {
  now: () => new Date(),
  setTimeout: (fn, ms) => {
    const id = globalThis.setTimeout(fn, ms);
    return () => {
      globalThis.clearTimeout(id);
    };
  },
};

export function createFakeClock(start: Date) {
  let time = start.getTime();
  let nextId = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const clock: Clock = {
    now: () => new Date(time),
    setTimeout(fn, ms) {
      const id = ++nextId;
      timers.set(id, { at: time + Math.max(0, ms), fn });
      return () => timers.delete(id);
    },
  };
  return {
    clock,
    advance(ms: number) {
      const end = time + ms;
      while (time <= end) {
        const dueEntries = [...timers.entries()]
          .filter(([, timer]) => timer.at <= end)
          .sort((a, b) => a[1].at - b[1].at || a[0] - b[0]);
        let ranTimer = false;
        for (const due of dueEntries) {
          timers.delete(due[0]);
          time = due[1].at;
          due[1].fn();
          ranTimer = true;
          break;
        }
        if (!ranTimer) break;
      }
      time = end;
    },
  };
}
