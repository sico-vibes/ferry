export class FakeClock {
  constructor(private nowMs = 0) {}
  now(): number {
    return this.nowMs;
  }
  date(): Date {
    return new Date(this.nowMs);
  }
  advance(ms: number): void {
    if (ms < 0) throw new RangeError('Clock cannot move backwards');
    this.nowMs += ms;
  }
}
