import { estimateTokens as sharedEstimateTokens } from '@ferry/shared/tokens';

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

/** Uses the shared provider-calibrated tokenizer for consistent measurements. */
export function estimateTokens(text: string): number {
  return sharedEstimateTokens(text);
}

export function keepOnlyIfSmaller(original: string, candidate: string): string {
  return estimateTokens(candidate) < estimateTokens(original) ? candidate : original;
}

export function measured<T>(
  kind: OptimizationEvent['kind'],
  before: string,
  output: T,
  serialized = typeof output === 'string' ? output : JSON.stringify(output),
): OptimizationResult<T> {
  const selected = typeof output === 'string' ? (keepOnlyIfSmaller(before, output) as T) : output;
  const selectedSerialization = typeof selected === 'string' ? selected : serialized;
  return {
    output: selected,
    event: {
      kind,
      beforeTokens: estimateTokens(before),
      afterTokens: estimateTokens(selectedSerialization),
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
  const candidate = options.benchmarkMode ? input : transform(input);
  const output = keepOnlyIfSmaller(input, candidate);
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
