export type OptimizerKind =
  | 'generic'
  | 'git-status'
  | 'git-diff'
  | 'git-log'
  | 'test'
  | 'build'
  | 'package-install'
  | 'filesystem'
  | 'context-hygiene';
export type MeasuredOptimizerKind = OptimizerKind | 'benchmark-bypass';
export interface OptimizationEvent {
  kind: MeasuredOptimizerKind;
  beforeTokens: number;
  afterTokens: number;
  sessionId?: string;
  timestamp?: string;
}
export interface EventSink {
  emit(event: OptimizationEvent): void | Promise<void>;
}
export interface OptimizationResult<T> {
  output: T;
  event: OptimizationEvent;
}

/** Shared deterministic estimate used by every optimizer in this package. */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.ceil(text.length / 4);
}

export function measured<T>(
  kind: OptimizationEvent['kind'],
  before: string,
  output: T,
  serialized = typeof output === 'string' ? output : JSON.stringify(output),
): OptimizationResult<T> {
  return {
    output,
    event: {
      kind,
      beforeTokens: estimateTokens(before),
      afterTokens: estimateTokens(typeof serialized === 'string' ? serialized : ''),
    },
  };
}

export interface OptimizerOptions {
  benchmarkMode?: boolean;
}
export function runOptimizer(
  input: string,
  kind: OptimizerEventKind,
  transform: (input: string) => string,
  options: OptimizerOptions = {},
): OptimizationResult<string> {
  const output = options.benchmarkMode ? input : transform(input);
  return measured(options.benchmarkMode ? 'benchmark-bypass' : kind, input, output);
}
export type OptimizerEventKind =
  | 'generic'
  | 'git-status'
  | 'git-diff'
  | 'git-log'
  | 'test'
  | 'build'
  | 'package-install'
  | 'filesystem';

export interface Rollup {
  beforeTokens: number;
  afterTokens: number;
  savedTokens: number;
  percentSaved: number;
  events: number;
}
export function rollupEvents(events: readonly OptimizationEvent[]): Rollup {
  const beforeTokens = events.reduce((sum, event) => sum + event.beforeTokens, 0);
  const afterTokens = events.reduce((sum, event) => sum + event.afterTokens, 0);
  return {
    beforeTokens,
    afterTokens,
    savedTokens: Math.max(0, beforeTokens - afterTokens),
    percentSaved:
      beforeTokens === 0 ? 0 : Math.max(0, ((beforeTokens - afterTokens) / beforeTokens) * 100),
    events: events.length,
  };
}
function rollupBy<T extends string>(
  events: readonly OptimizationEvent[],
  key: (event: OptimizationEvent) => T,
): Map<T, Rollup> {
  const grouped = new Map<T, OptimizationEvent[]>();
  for (const event of events) {
    const group = grouped.get(key(event)) ?? [];
    group.push(event);
    grouped.set(key(event), group);
  }
  return new Map([...grouped].map(([name, group]) => [name, rollupEvents(group)]));
}
export function rollupByDay(events: readonly OptimizationEvent[]): Map<string, Rollup> {
  return rollupBy(events, (e) => (e.timestamp ?? '').slice(0, 10));
}
export function rollupBySession(events: readonly OptimizationEvent[]): Map<string, Rollup> {
  return rollupBy(events, (e) => e.sessionId ?? '');
}
export function rollupByOptimizer(events: readonly OptimizationEvent[]): Map<string, Rollup> {
  return rollupBy(events, (e) => e.kind);
}
