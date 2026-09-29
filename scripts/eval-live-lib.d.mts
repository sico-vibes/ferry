export interface EvalProvider {
  id: string;
  tag: string;
  enabled: boolean;
  keyPresent: boolean;
  keyRequired: boolean;
  keyStatus?: string;
  freeTierUnsupported?: boolean;
  billingEnabled?: boolean;
  excludedModelRefs?: readonly string[];
}

export interface EvalModel {
  ref: string;
  providerId: string;
  free: boolean;
}

export interface EvalMeasurement {
  sessionId?: string;
  session_id?: string;
  model?: string | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
  error_kind?: string | null;
}

export interface EvalUsageEntry {
  date: string;
  providerId: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface EvalScenarioOutcome {
  passed: boolean;
  steps?: number;
  models?: string[];
  tokensIn?: number;
  tokensOut?: number;
  providerErrors?: Record<string, number>;
  handoffs?: string[];
  toolCallRepairs?: number;
  editsRefused?: number;
  editsRetried?: number;
  detail?: string;
}

export interface EvalScenarioResult extends EvalScenarioOutcome {
  id: string;
  repetition: number;
  wallTimeMs: number;
  passed: boolean;
  models: string[];
  providerErrors: Record<string, number>;
  handoffs: string[];
}

export function parseEvalArgs(args: string[]): {
  profile: 'auto-free' | 'best-available';
  roles?: 'on' | 'off';
  only: string[];
  include: string[];
  exclude: string[];
  repeat: number;
  model?: string;
  json: boolean;
  verbose: boolean;
  allowPaid: boolean;
  yes: boolean;
  dataDir?: string;
  maxSteps: number;
  timeoutMs: number;
  help?: boolean;
};
export function parseDotEnv(text: string): Record<string, string>;
export function redactText(value: unknown, secrets: readonly string[]): string;
export function budgetGuard(
  providers: readonly Pick<EvalProvider, 'id' | 'tag' | 'billingEnabled'>[],
  options?: { allowPaid?: boolean },
): { allowed: boolean; paid: string[] };
export function selectEvalProviders(input: {
  providers: readonly EvalProvider[];
  models: readonly EvalModel[];
  profile?: string;
  include?: readonly string[];
  exclude?: readonly string[];
  model?: string;
}): { providers: EvalProvider[]; models: EvalModel[] };
export function estimateProviderRequests(
  providers: readonly Pick<EvalProvider, 'id'>[],
  taskCount: number,
  maxSteps: number,
): { provider: string; estimatedRequests: number }[];
export function accountRun(input: {
  result: { sessionId: string; steps?: number };
  measurements?: readonly EvalMeasurement[];
}): {
  steps: number;
  models: string[];
  tokensIn: number;
  tokensOut: number;
  providerErrors: Record<string, number>;
};
export function diffUsageHistory(
  before: readonly EvalUsageEntry[],
  after: readonly EvalUsageEntry[],
): { inputTokens: number; outputTokens: number };
export function runHarness(input: {
  scenarios: readonly { id: string }[];
  repeat?: number;
  runScenario(scenario: { id: string }): Promise<EvalScenarioOutcome>;
}): Promise<{ results: EvalScenarioResult[]; passed: number; total: number }>;
export function fileDigest(entries: unknown): string;
export function formatMarkdown(report: {
  passed: number;
  total: number;
  results: readonly EvalScenarioResult[];
}): string;
export function verifyScenario(
  id: string,
  root: string,
  before: readonly [string, string][],
  after: readonly [string, string][],
  explanation: string,
): Promise<boolean>;
