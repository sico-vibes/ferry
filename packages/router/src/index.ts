import type {
  ModelCandidate,
  ModelInfo,
  Profile,
  Provider,
  StepKind,
  TaskRecord,
  Message,
} from '@ferry/shared';
import type { Catalog } from '@ferry/catalog';

/** Plain, immutable-at-call-time capacity snapshot supplied by the quota engine. */
export interface CapacityView {
  providers: readonly Provider[];
  /** Optional model/provider TPM remaining for the current rate-limit window. */
  tokensPerMinuteRemaining?: Readonly<Record<string, number | null>>;
  /** Optional limit overrides when the quota engine has fresher limits than the catalog. */
  tokensPerMinuteLimit?: Readonly<Record<string, number | null>>;
  /** Snapshot time, used to interpret cooldown timestamps deterministically. */
  now?: string;
}

/** Historical model quality data. Counts make small samples shrink toward the prior. */
export interface ModelStats {
  modelRef: string;
  toolCalls: number;
  toolCallValidationFailures: number;
  averageLatencyMs: number | null;
  cacheAffinity: number;
}

export interface StepEstimate {
  inputTokens: number;
  outputTokens?: number;
  requiresTools?: boolean;
  /** Allow callers to provide a step count estimate for explanations and switching. */
  expectedSteps?: number;
}

export interface ClassifierContext {
  firstStep?: boolean;
  afterPlanUpdate?: boolean;
  pendingEdits?: boolean;
  readCount?: number;
  grepCount?: number;
  compaction?: boolean;
  afterDelegationResult?: boolean;
  estimatedInputTokens?: number;
}

export function classifyStep(ctx: ClassifierContext): StepKind {
  if (ctx.firstStep || ctx.afterPlanUpdate) return 'plan';
  if (ctx.afterDelegationResult) return 'review';
  if (ctx.compaction) return 'summarize';
  if ((ctx.estimatedInputTokens ?? 0) > 100_000) return 'long_context';
  if (ctx.pendingEdits) return 'edit';
  if ((ctx.readCount ?? 0) + (ctx.grepCount ?? 0) > 0) return 'search';
  return 'plan';
}

const optimizerDefaults = {
  terse: 'off',
  toolOutputFilters: false,
  recoveryHandles: false,
  contextHygiene: false,
  rtk: false,
} as const;
const tiers: Record<StepKind, Profile['tierByStep'][StepKind]> = {
  plan: ['T2', 'T3'],
  edit: ['T2', 'T3'],
  search: ['T1', 'T2'],
  summarize: ['T2', 'T3'],
  review: ['T2', 'T3'],
  long_context: ['T2', 'T3'],
};
function builtinProfile(
  id: string,
  name: string,
  description: string,
  paidAllowed: boolean,
  allowedProviders: Profile['allowedProviders'],
  tierByStep: Profile['tierByStep'],
  dailyUsd: number | null,
  monthlyUsd: number | null,
): Profile {
  return {
    id: id as Profile['id'],
    name,
    icon: 'sparkles',
    description,
    builtin: true,
    pinned: false,
    allowedProviders,
    tierByStep,
    paidAllowed,
    caps: { dailyUsd, monthlyUsd },
    delegationMode: 'suggest',
    optimizers: { ...optimizerDefaults },
  };
}

export const BUILTIN_PROFILES: readonly Profile[] = [
  builtinProfile(
    'profile_builtin_auto_free',
    'Auto-Free',
    'Choose the strongest eligible free model.',
    false,
    'all_free',
    tiers,
    null,
    null,
  ),
  builtinProfile(
    'profile_builtin_best_available',
    'Best Available',
    'Use the best eligible model within configured spend caps.',
    true,
    'all',
    tiers,
    5,
    50,
  ),
  builtinProfile(
    'profile_builtin_fast',
    'Fast',
    'Prefer responsive models for each step.',
    false,
    'all_free',
    { ...tiers, plan: ['T1', 'T2'], edit: ['T1', 'T2'], review: ['T1', 'T2'] },
    null,
    null,
  ),
  builtinProfile(
    'profile_builtin_long_context',
    'Long Context',
    'Prefer models with ample context capacity.',
    false,
    'all_free',
    { ...tiers, long_context: ['T2', 'T3'], summarize: ['T2', 'T3'] },
    null,
    null,
  ),
];

export interface ProfileOverrides {
  allowedProviders?: Profile['allowedProviders'];
  tierByStep?: Partial<Profile['tierByStep']>;
  paidAllowed?: boolean;
  caps?: Partial<Profile['caps']>;
}

/** Apply runtime/session choices over a built-in or saved profile without mutating either input. */
export function resolveProfile(profile: Profile, overrides: ProfileOverrides = {}): Profile {
  return {
    ...profile,
    allowedProviders: overrides.allowedProviders ?? profile.allowedProviders,
    tierByStep: { ...profile.tierByStep, ...overrides.tierByStep },
    paidAllowed: overrides.paidAllowed ?? profile.paidAllowed,
    caps: { ...profile.caps, ...overrides.caps },
  };
}

export interface SpendUsage {
  inputTokens: number;
  outputTokens: number;
}
export interface SpendState {
  sessionUsd: number;
  dayUsd: number;
  monthUsd: number;
  paidCallsThisSession: number;
}
export interface SpendCaps {
  sessionUsd: number | null;
  dayUsd: number | null;
  monthUsd: number | null;
}

export function calculateSpend(
  usage: SpendUsage,
  model: Pick<ModelInfo, 'priceInPerM' | 'priceOutPerM'>,
): number {
  return (
    (usage.inputTokens * (model.priceInPerM ?? 0)) / 1_000_000 +
    (usage.outputTokens * (model.priceOutPerM ?? 0)) / 1_000_000
  );
}

export function canSpend(
  profile: Profile,
  state: SpendState,
  caps: SpendCaps,
  amountUsd: number,
): boolean {
  if (amountUsd < 0 || !Number.isFinite(amountUsd)) return false;
  if (!profile.paidAllowed) return amountUsd === 0;
  const profileDaily = profile.caps.dailyUsd;
  const profileMonthly = profile.caps.monthlyUsd;
  return (
    within(state.sessionUsd, amountUsd, caps.sessionUsd) &&
    within(state.dayUsd, amountUsd, minCap(caps.dayUsd, profileDaily)) &&
    within(state.monthUsd, amountUsd, minCap(caps.monthUsd, profileMonthly))
  );
}
function within(used: number, amount: number, cap: number | null): boolean {
  return cap === null || used + amount <= cap;
}
function minCap(a: number | null, b: number | null): number | null {
  return a === null ? b : b === null ? a : Math.min(a, b);
}
export function requiresConfirmation(
  profile: Profile,
  state: SpendState,
  amountUsd: number,
): boolean {
  return profile.paidAllowed && amountUsd > 0 && state.paidCallsThisSession === 0;
}

export interface ScoreInput {
  models: readonly ModelInfo[];
  providers?: readonly Provider[];
  capacity: CapacityView;
  profile: Profile;
  step: StepKind;
  estimate: StepEstimate;
  stats?: readonly ModelStats[];
  previousModelRef?: string | null;
  spend?: SpendState;
  spendCaps?: SpendCaps;
  /** Extra context for cache / capability preferences. */
  preferReasoning?: boolean;
}

/** Remove models that cannot safely execute this step, then rank the remaining models. */
export function scoreModels(input: ScoreInput): ModelCandidate[] {
  const providers = input.providers ?? input.capacity.providers;
  const parsedNow = Date.parse(input.capacity.now ?? new Date(0).toISOString());
  const nowMs = Number.isFinite(parsedNow) ? parsedNow : 0;
  const providerById = new Map(providers.map((provider) => [provider.id as string, provider]));
  const statByRef = new Map((input.stats ?? []).map((stats) => [stats.modelRef, stats]));
  const scored: (ModelCandidate & { refKey: string })[] = [];
  for (const model of input.models) {
    const provider = providerById.get(model.providerId);
    if (
      !provider ||
      !provider.enabled ||
      provider.health === 'down' ||
      provider.keyStatus === 'missing' ||
      provider.keyStatus === 'invalid'
    )
      continue;
    const cooldown = provider.cooldownUntil ? Date.parse(provider.cooldownUntil) : 0;
    if (provider.health === 'cooldown' && (!Number.isFinite(cooldown) || cooldown > nowMs))
      continue;
    if (model.contextWindow < input.estimate.inputTokens * 1.2) continue;
    if ((input.estimate.requiresTools ?? true) && !model.toolCalling) continue;
    if (!providerAllowed(input.profile, provider, model)) continue;
    if (!input.profile.tierByStep[input.step].includes(model.tier)) continue;
    const cost = calculateSpend(
      { inputTokens: input.estimate.inputTokens, outputTokens: input.estimate.outputTokens ?? 0 },
      model,
    );
    if (
      cost > 0 &&
      (!input.spend ||
        !input.spendCaps ||
        !canSpend(input.profile, input.spend, input.spendCaps, cost))
    )
      continue;
    const remaining = capacityRemaining(input.capacity, provider);
    if (remaining !== null && remaining < (input.estimate.expectedSteps ?? 1)) continue;
    const tpm = tpmRemaining(input.capacity, model, provider);
    if (tpm !== null && tpm < input.estimate.inputTokens + (input.estimate.outputTokens ?? 0))
      continue;
    const prior = statByRef.get(model.ref);
    const success =
      prior && prior.toolCalls > 0
        ? (prior.toolCalls - prior.toolCallValidationFailures + 2 * 0.8) / (prior.toolCalls + 2)
        : 0.8;
    const tierFit = tierFitScore(input.step, model.tier);
    const headroom =
      remaining === null
        ? 0.5
        : Math.min(1, remaining / Math.max(5, (input.estimate.expectedSteps ?? 1) * 5));
    const latency = prior?.averageLatencyMs ?? 2_000;
    const latencyScore = 1 / (1 + latency / 2_000);
    const costScore = cost === 0 ? 1 : 1 / (1 + cost * 100);
    const affinity =
      (prior?.cacheAffinity ?? 0) * 0.6 + (input.previousModelRef === model.ref ? 0.4 : 0);
    const score =
      40 * tierFit +
      20 * headroom +
      20 * success +
      10 * latencyScore +
      6 * costScore +
      4 * affinity +
      (input.preferReasoning && model.reasoning ? 2 : 0);
    const stepsText =
      remaining === null ? 'capacity unknown' : `${Math.floor(remaining).toString()} steps left`;
    const costText = model.free ? 'free' : `paid · $${cost.toFixed(4)} est.`;
    scored.push({
      ref: model.ref,
      score,
      stepsLeft: remaining,
      explanation: `${model.tier} ${stepLabel(input.step)} · ${stepsText} · ${formatContext(model.contextWindow)} context · ${costText}`,
      selected: false,
      refKey: model.ref,
    });
  }
  scored.sort((a, b) => b.score - a.score || a.refKey.localeCompare(b.refKey));
  return scored.map(({ refKey: _refKey, ...candidate }, index) => ({
    ...candidate,
    selected: index === 0,
  }));
}

function providerAllowed(profile: Profile, provider: Provider, model: ModelInfo): boolean {
  if (!profile.paidAllowed && provider.tag === 'caution') return false;
  if (!profile.paidAllowed && !model.free) return false;
  if (profile.allowedProviders === 'all') return true;
  if (profile.allowedProviders === 'all_free') return model.free;
  return profile.allowedProviders.includes(provider.id);
}
function capacityRemaining(capacity: CapacityView, provider: Provider): number | null {
  const entry = capacity.providers.find((item) => item.id === provider.id);
  return entry?.stepsLeftToday ?? null;
}
function tpmRemaining(capacity: CapacityView, model: ModelInfo, provider: Provider): number | null {
  const keys = [model.ref as string, provider.id as string];
  for (const key of keys) {
    const remaining = capacity.tokensPerMinuteRemaining?.[key];
    if (remaining !== undefined && remaining !== null) return remaining;
  }
  return null;
}
function tierFitScore(step: StepKind, tier: string): number {
  const preferred: Record<StepKind, string> = {
    plan: 'T2',
    edit: 'T2',
    search: 'T1',
    summarize: 'T2',
    review: 'T2',
    long_context: 'T3',
  };
  return tier === preferred[step]
    ? 1
    : tier === 'T3' &&
        (step === 'plan' || step === 'edit' || step === 'review' || step === 'summarize')
      ? 0.82
      : tier === 'T2'
        ? 0.75
        : 0.65;
}
function stepLabel(step: StepKind): string {
  return step.replace('_', ' ');
}
function formatContext(tokens: number): string {
  return tokens >= 1_000_000
    ? `${(tokens / 1_000_000).toString()}M`
    : tokens >= 1_000
      ? `${Math.round(tokens / 1_000).toString()}K`
      : tokens.toString();
}

export interface SwitchEstimate extends StepEstimate {
  expectedSteps?: number;
}
export function shouldSwitchBeforeStep(
  current: ModelInfo,
  capacity: CapacityView,
  estimate: SwitchEstimate,
): boolean {
  const provider = capacity.providers.find((item) => item.id === current.providerId);
  if (!provider || !provider.enabled || provider.health === 'down') return true;
  if (
    provider.health === 'cooldown' &&
    provider.cooldownUntil &&
    Date.parse(provider.cooldownUntil) > Date.parse(capacity.now ?? new Date(0).toISOString())
  )
    return true;
  const remainingSteps = provider.stepsLeftToday;
  if (remainingSteps !== null && remainingSteps < 1.5) return true;
  const tpm =
    capacity.tokensPerMinuteRemaining?.[current.ref as string] ??
    capacity.tokensPerMinuteRemaining?.[current.providerId as string];
  return tpm != null && tpm < estimate.inputTokens + (estimate.outputTokens ?? 0);
}

export interface StepError {
  kind: 'rate_limit' | 'provider' | 'tool' | 'internal';
  retryAfterSeconds?: number | null;
}
export type ErrorPolicy =
  { action: 'retry_same'; attempts: 1 } | { action: 'reselect'; attempts: 0 };
/** One fast retry is safe only when the provider has given a short explicit retry delay. */
export function onStepError(error: StepError): ErrorPolicy {
  return error.kind === 'rate_limit' &&
    error.retryAfterSeconds != null &&
    error.retryAfterSeconds <= 10 &&
    error.retryAfterSeconds >= 0
    ? { action: 'retry_same', attempts: 1 }
    : { action: 'reselect', attempts: 0 };
}

export interface BriefingSection {
  title: string;
  content: string;
}
export interface HandoffBriefing {
  sections: BriefingSection[];
  text: string;
  tokens: number;
  limitTokens: number;
}
export interface HandoffMarker {
  type: 'handoff_marker';
  from: string;
  to: string;
  reason: 'quota' | 'rate_limit' | 'error' | 'context' | 'capability' | 'manual';
  briefingTokens: number;
  explanation: string;
}
export type TokenEstimator = (text: string) => number;
/** Conservative portable estimator; injectable so the core can pass its canonical shared estimator. */
export const estimateTextTokens: TokenEstimator = (text) => Math.ceil(text.length / 4);

export function buildBriefing(
  taskRecord: TaskRecord,
  recentTurns: readonly Message[],
  targetModel: ModelInfo,
  budgetTokens: number,
  estimateTokens: TokenEstimator = estimateTextTokens,
): HandoffBriefing {
  const limitTokens = Math.max(
    0,
    Math.floor(Math.min(budgetTokens, targetModel.contextWindow * 0.5)),
  );
  const turns = recentTurns
    .slice(-8)
    .map((message) =>
      message.parts
        .map((part) =>
          part.type === 'text'
            ? part.text
            : part.type === 'tool_call'
              ? `[tool ${part.tool}: ${part.status}]`
              : '',
        )
        .filter(Boolean)
        .join('\n'),
    )
    .filter(Boolean);
  const sections: BriefingSection[] = [
    { title: 'Goal', content: taskRecord.goal },
    {
      title: 'Plan',
      content:
        taskRecord.plan.map((item) => `- [${item.status}] ${item.text}`).join('\n') ||
        'No plan recorded.',
    },
    {
      title: 'Done so far',
      content:
        taskRecord.plan
          .filter((item) => item.status === 'done')
          .map((item) => item.text)
          .join('\n') || 'No completed plan items recorded.',
    },
    {
      title: 'Files touched',
      content:
        taskRecord.touchedFiles.map((file) => `- ${file.path}: ${file.purpose}`).join('\n') ||
        'No files recorded.',
    },
    {
      title: 'Decisions & constraints',
      content:
        taskRecord.decisions.map((decision) => `- ${decision.text} (${decision.why})`).join('\n') ||
        'None recorded.',
    },
    { title: 'Next step', content: taskRecord.nextStep ?? 'Continue from the current plan.' },
    { title: 'Recent turns (verbatim)', content: turns.join('\n\n') || 'No recent text turns.' },
    { title: 'Relevant excerpts', content: '' },
  ];
  const render = () => sections.map(({ title, content }) => `## ${title}\n${content}`).join('\n\n');
  let text = render();
  while (estimateTokens(text) > limitTokens && sections.length) {
    const last = sections[sections.length - 1];
    if (!last) break;
    if (last.content.length > 0) {
      const excess = estimateTokens(text) - limitTokens;
      last.content =
        last.content.slice(0, Math.max(0, last.content.length - Math.max(4, excess * 4))) +
        (last.content.length > 4 ? '…' : '');
    } else if (sections.length > 1) sections.pop();
    else break;
    text = render();
  }
  if (estimateTokens(text) > limitTokens) {
    text = text.slice(0, Math.max(0, limitTokens * 4));
    while (estimateTokens(text) > limitTokens && text.length) text = text.slice(0, -1);
  }
  return { sections, text, tokens: estimateTokens(text), limitTokens };
}

export function createHandoffMarker(
  from: string,
  to: string,
  reason: HandoffMarker['reason'],
  briefing: HandoffBriefing,
  explanation: string,
): HandoffMarker {
  return { type: 'handoff_marker', from, to, reason, briefingTokens: briefing.tokens, explanation };
}

export interface NormalizedMessagePart {
  type: 'text' | 'reasoning' | 'tool_call' | 'tool_result';
  text?: string;
  id?: string;
  name?: string;
  arguments?: unknown;
  callId?: string;
}
export function normalizeToolCallIds(
  parts: readonly NormalizedMessagePart[],
  target: 'openai' | 'anthropic' | 'gemini',
): NormalizedMessagePart[] {
  return parts.map((part, index) => {
    if (part.type !== 'tool_call' && part.type !== 'tool_result') return { ...part };
    const sourceId = part.callId ?? part.id ?? `call_${index.toString()}`;
    const callId = target === 'gemini' ? sourceId.replace(/[^a-zA-Z0-9_-]/g, '_') : sourceId;
    if (target === 'anthropic') {
      const { id: _id, ...withoutGenericId } = part;
      return { ...withoutGenericId, callId };
    }
    return { ...part, id: callId, callId };
  });
}
export function dropReasoningParts(
  parts: readonly NormalizedMessagePart[],
  supportsReasoning: boolean,
): NormalizedMessagePart[] {
  return supportsReasoning
    ? parts.map((part) => ({ ...part }))
    : parts.filter((part) => part.type !== 'reasoning').map((part) => ({ ...part }));
}

export interface ScenarioResult {
  name: string;
  switches: string[];
  outcome: string;
}
/** Small deterministic fixtures documenting expected quota fallback behavior. */
export function runSimulationScenarios(): ScenarioResult[] {
  return [
    {
      name: 'Gemini RPD exhausted',
      switches: ['gemini/gemini-free', 'groq/llama-free'],
      outcome: 'switch after daily request limit',
    },
    {
      name: 'OpenRouter daily exhaustion',
      switches: ['openrouter/free-a', 'openrouter/free-b', 'wait'],
      outcome: 'switch within provider then wait until reset',
    },
    {
      name: 'Groq TPM overflow',
      switches: ['groq/llama', 'gemini/gemini-free'],
      outcome: 'switch after per-minute token overflow',
    },
    {
      name: 'all free exhausted',
      switches: ['free-models-exhausted', 'paid-confirmation-or-wait'],
      outcome: 'ask before paid model or suggest next reset',
    },
  ];
}

export type { Catalog };
