import type {
  Checkpoint,
  CapacitySummary,
  DelegationRun,
  FileChange,
  GateResult,
  HandoffStat,
  Lane,
  McpServer,
  Message,
  MessagePart,
  ModelCandidate,
  ModelInfo,
  OptimizerStats,
  OptimizerToggles,
  PlanItem,
  ProbeResult,
  Profile,
  Provider,
  QuotaObservation,
  QuotaWindow,
  RawCallObservation,
  Session,
  SessionDetail,
  Skill,
  SystemInfo,
  TaskRecord,
  UsageHistoryPoint,
  UsageRecord,
  Workspace,
  WorkspaceSettings,
  Settings,
} from '../index.js';

const workspaceId = 'workspace_00000000000000000000' as Workspace['id'];
const sessionId = 'session_00000000000000000000' as Session['id'];
const profileId = 'profile_00000000000000000000' as Profile['id'];
const providerId = 'provider_00000000000000000000' as Provider['id'];
const modelRef = 'openai/gpt-5' as ModelInfo['ref'];
const baseSettings: WorkspaceSettings = {
  gateCommands: ['pnpm check'],
  instructionsFile: null,
  defaultProfileId: profileId,
  permissionMode: 'ask',
};
export const sampleWorkspaceSettings = baseSettings;
export const sampleWorkspace: Workspace = {
  id: workspaceId,
  name: 'Ferry',
  path: 'C:/dev/ferry',
  gitBranch: 'main',
  language: 'ts',
  lastOpenedAt: '2026-09-23T10:00:00.000Z',
  settings: baseSettings,
};
export const sampleSession: Session = {
  id: sessionId,
  workspaceId,
  title: 'Contract',
  preview: 'Define contracts',
  profileId,
  modelRef,
  starred: false,
  pinned: false,
  status: 'idle',
  createdAt: '2026-09-23T10:00:00.000Z',
  updatedAt: '2026-09-23T10:00:00.000Z',
};
export const sampleFileChange: FileChange = {
  path: 'src/index.ts',
  status: 'modified',
  additions: 2,
  deletions: 1,
  before: 'a',
  after: 'b',
};
export const sampleMessagePart: MessagePart = {
  type: 'text',
  id: 'part_00000000000000000000' as MessagePart['id'],
  text: 'Hello',
};
export const sampleMessage: Message = {
  id: 'message_00000000000000000000' as Message['id'],
  sessionId,
  role: 'assistant',
  createdAt: '2026-09-23T10:00:00.000Z',
  modelRef,
  parts: [sampleMessagePart],
};
export const samplePlanItem: PlanItem = { id: 'plan-1', text: 'Implement', status: 'doing' };
export const sampleTaskRecord: TaskRecord = {
  sessionId,
  goal: 'Contract',
  plan: [samplePlanItem],
  decisions: [{ text: 'Use zod', why: 'Runtime validation', at: '2026-09-23T10:00:00.000Z' }],
  touchedFiles: [{ path: 'src/index.ts', purpose: 'Exports' }],
  nextStep: null,
};
export const sampleSessionDetail: SessionDetail = {
  session: sampleSession,
  messages: [sampleMessage],
  taskRecord: sampleTaskRecord,
};
export const sampleCheckpoint: Checkpoint = {
  id: 'checkpoint_00000000000000000000' as Checkpoint['id'],
  sessionId,
  label: 'Before edits',
  createdAt: '2026-09-23T10:00:00.000Z',
  fileCount: 1,
};
export const sampleQuotaWindow: QuotaWindow = {
  id: 'window-1',
  scope: 'provider',
  modelRef: null,
  metric: 'requests',
  kind: 'rolling',
  periodLabel: 'Today',
  used: 2,
  limit: 10,
  remaining: 8,
  resetAt: null,
  confidence: 'exact',
};
export const sampleProvider: Provider = {
  id: providerId,
  name: 'OpenAI',
  tag: 'legit',
  kind: 'api',
  brand: 'openai',
  keyStatus: 'valid',
  enabled: true,
  health: 'ok',
  cooldownUntil: null,
  dataUse: null,
  termsNote: null,
  signupUrl: null,
  docsUrl: null,
  verifiedAt: '2026-09-23',
  modelCount: 1,
  windows: [sampleQuotaWindow],
  stepsLeftToday: 8,
};
export const sampleProbeResult: ProbeResult = {
  ok: true,
  keyValid: true,
  latencyMs: 42,
  message: 'OK',
  windows: [sampleQuotaWindow],
  models: ['gpt-5'],
  errorKind: null,
};
export const sampleRawCallObservation: RawCallObservation = {
  providerId,
  modelRef,
  startedAt: 1790251200000,
  latencyMs: 42,
  statusCode: 200,
  requestBytes: 128,
  rateLimitHeaders: { 'x-ratelimit-remaining-requests': '8' },
  errorKind: null,
};
export const sampleUsageRecord: UsageRecord = {
  id: 'usage-1',
  providerId,
  modelRef,
  occurredAt: '2026-09-24T12:00:00.000Z',
  status: 'success',
  inputTokens: 12,
  outputTokens: 4,
  latencyMs: 42,
};
export const sampleQuotaObservation: QuotaObservation = {
  id: 'observation-1',
  providerId,
  modelRef,
  windowId: 'requests-day',
  metric: 'requests',
  value: 2,
  limit: 10,
  remaining: 8,
  resetAt: null,
  source: 'header',
  observedAt: '2026-09-24T12:00:00.000Z',
};
export const sampleModelInfo: ModelInfo = {
  ref: modelRef,
  providerId,
  name: 'GPT-5',
  tier: 'T1',
  contextWindow: 128000,
  maxOutput: 8192,
  toolCalling: true,
  reasoning: true,
  free: false,
  priceInPerM: 1,
  priceOutPerM: 2,
};
export const sampleModelCandidate: ModelCandidate = {
  ref: modelRef,
  score: 0.9,
  stepsLeft: 8,
  explanation: 'Good fit',
  selected: true,
};
export const sampleCapacitySummary: CapacitySummary = {
  stepsLeftToday: 8,
  percentRemaining: 80,
  lowCapacity: false,
  perProvider: [{ providerId, stepsLeft: 8, percent: 80, nextResetAt: null }],
  nextResets: [],
  banner: null,
  updatedAt: '2026-09-23T10:00:00.000Z',
};
export const sampleUsageHistoryPoint: UsageHistoryPoint = {
  date: '2026-09-23',
  providerId,
  requests: 2,
  inputTokens: 100,
  outputTokens: 50,
  costUsd: 0.01,
};
export const sampleHandoffStat: HandoffStat = { reason: 'quota', count: 1 };
export const sampleOptimizerToggles: OptimizerToggles = {
  terse: 'lite',
  toolOutputFilters: true,
  recoveryHandles: true,
  contextHygiene: true,
  rtk: false,
};
export const sampleProfile: Profile = {
  id: profileId,
  name: 'Balanced',
  icon: 'Layers',
  description: 'Balanced profile',
  builtin: true,
  pinned: false,
  allowedProviders: 'all_free',
  tierByStep: {
    plan: ['T1'],
    edit: ['T1'],
    search: ['T1'],
    summarize: ['T1'],
    review: ['T1'],
    long_context: ['T2'],
  },
  paidAllowed: false,
  caps: { dailyUsd: null, monthlyUsd: null },
  delegationMode: 'suggest',
  optimizers: sampleOptimizerToggles,
};
export const sampleMcpServer: McpServer = {
  id: 'mcp_00000000000000000000' as McpServer['id'],
  name: 'Docs',
  brand: null,
  transport: 'stdio',
  status: 'connected',
  verified: true,
  toolCount: 2,
};
export const sampleSkill: Skill = {
  id: 'skill_00000000000000000000' as Skill['id'],
  name: 'Review',
  description: 'Review changes',
  source: 'bundled',
  enabled: true,
};
export const sampleLane: Lane = {
  name: 'Codex',
  implementer: 'codex',
  profile: null,
  model: null,
  effort: null,
  variant: null,
  permission: null,
  paths: [],
  source: 'global',
  trusted: true,
};
export const sampleGateResult: GateResult = { command: 'pnpm check', ok: true, outputTail: 'ok' };
export const sampleDelegationRun: DelegationRun = {
  id: 'run_00000000000000000000' as DelegationRun['id'],
  sessionId,
  lane: 'Codex',
  implementer: 'codex',
  brief: 'Review',
  status: 'completed',
  startedAt: '2026-09-23T10:00:00.000Z',
  finishedAt: '2026-09-23T10:01:00.000Z',
  progress: [{ at: '2026-09-23T10:00:30.000Z', text: 'Working' }],
  finalMessage: 'Done',
  touchedFiles: [sampleFileChange],
  gateResults: [sampleGateResult],
  usage: { inputTokens: 100, outputTokens: 50, costUsd: null, provider: 'subscription_cli' },
  decision: 'accepted',
};
export const sampleOptimizerStats: OptimizerStats = {
  demo: true,
  today: { savedTokens: 100, percent: 5 },
  byOptimizer: [{ id: 'terse', name: 'Terse', enabled: true, savedTokens: 100, percent: 5 }],
};
export const sampleSettings: Settings = {
  theme: 'dark',
  homeStyle: 'auto',
  fontScale: 1,
  restoreTabs: true,
  delegationMode: 'suggest',
  permissionMode: 'ask',
  activeProfileId: profileId,
  onboardingComplete: true,
  optimizers: sampleOptimizerToggles,
  developer: {
    showReferenceOverlay: false,
    mockLatency: false,
    injectErrors: false,
    realDomains: [],
  },
};
export const sampleSystemInfo: SystemInfo = { version: '0.0.0', mock: true, platform: 'web' };
