import { describe, expect, it } from 'vitest';
import * as domain from '../src/index.js';
import * as samples from '../src/testing/samples.js';

const cases: [string, { safeParse(value: unknown): { success: boolean } }, unknown][] = [
  ['WorkspaceId', domain.WorkspaceIdSchema, 'workspace_00000000000000000000'],
  ['SessionId', domain.SessionIdSchema, 'session_00000000000000000000'],
  ['MessageId', domain.MessageIdSchema, 'message_00000000000000000000'],
  ['PartId', domain.PartIdSchema, 'part_00000000000000000000'],
  ['ProviderId', domain.ProviderIdSchema, 'provider_00000000000000000000'],
  ['ProfileId', domain.ProfileIdSchema, 'profile_00000000000000000000'],
  ['RunId', domain.RunIdSchema, 'run_00000000000000000000'],
  ['CheckpointId', domain.CheckpointIdSchema, 'checkpoint_00000000000000000000'],
  ['McpServerId', domain.McpServerIdSchema, 'mcp_00000000000000000000'],
  ['SkillId', domain.SkillIdSchema, 'skill_00000000000000000000'],
  ['ModelRef', domain.ModelRefSchema, 'openai/gpt-5'],
  ['PermissionMode', domain.PermissionModeSchema, 'ask'],
  ['DelegationMode', domain.DelegationModeSchema, 'suggest'],
  ['StepKind', domain.StepKindSchema, 'edit'],
  ['Tier', domain.TierSchema, 'T1'],
  ['Theme', domain.ThemeSchema, 'dark'],
  ['SessionStatus', domain.SessionStatusSchema, 'idle'],
  ['ToolName', domain.ToolNameSchema, 'read_file'],
  ['ProviderTag', domain.ProviderTagSchema, 'legit'],
  ['WorkspaceSettings', domain.WorkspaceSettingsSchema, samples.sampleWorkspaceSettings],
  ['Workspace', domain.WorkspaceSchema, samples.sampleWorkspace],
  ['Session', domain.SessionSchema, samples.sampleSession],
  ['FileChange', domain.FileChangeSchema, samples.sampleFileChange],
  ['MessagePart', domain.MessagePartSchema, samples.sampleMessagePart],
  ['Message', domain.MessageSchema, samples.sampleMessage],
  ['PlanItem', domain.PlanItemSchema, samples.samplePlanItem],
  ['TaskRecord', domain.TaskRecordSchema, samples.sampleTaskRecord],
  ['SessionDetail', domain.SessionDetailSchema, samples.sampleSessionDetail],
  ['Checkpoint', domain.CheckpointSchema, samples.sampleCheckpoint],
  ['QuotaWindow', domain.QuotaWindowSchema, samples.sampleQuotaWindow],
  ['Provider', domain.ProviderSchema, samples.sampleProvider],
  ['ProbeResult', domain.ProbeResultSchema, samples.sampleProbeResult],
  ['ModelInfo', domain.ModelInfoSchema, samples.sampleModelInfo],
  ['ModelCandidate', domain.ModelCandidateSchema, samples.sampleModelCandidate],
  ['CapacitySummary', domain.CapacitySummarySchema, samples.sampleCapacitySummary],
  ['UsageHistoryPoint', domain.UsageHistoryPointSchema, samples.sampleUsageHistoryPoint],
  ['HandoffStat', domain.HandoffStatSchema, samples.sampleHandoffStat],
  ['Profile', domain.ProfileSchema, samples.sampleProfile],
  ['OptimizerToggles', domain.OptimizerTogglesSchema, samples.sampleOptimizerToggles],
  ['McpServer', domain.McpServerSchema, samples.sampleMcpServer],
  ['Skill', domain.SkillSchema, samples.sampleSkill],
  ['Lane', domain.LaneSchema, samples.sampleLane],
  ['GateResult', domain.GateResultSchema, samples.sampleGateResult],
  ['DelegationRun', domain.DelegationRunSchema, samples.sampleDelegationRun],
  ['OptimizerStats', domain.OptimizerStatsSchema, samples.sampleOptimizerStats],
  ['Settings', domain.SettingsSchema, samples.sampleSettings],
  ['SystemInfo', domain.SystemInfoSchema, samples.sampleSystemInfo],
];
describe('domain schemas', () => {
  for (const [name, schema, sample] of cases) {
    it(`${name} accepts its sample and rejects invalid input`, () => {
      expect(schema.safeParse(sample).success).toBe(true);
      expect(schema.safeParse(null).success).toBe(false);
    });
  }
  it('rejects a malformed model reference', () => {
    expect(domain.ModelRefSchema.safeParse('invalid').success).toBe(false);
  });
  it('creates prefixed ids with 20 base36 characters', () => {
    expect(domain.newId('session')).toMatch(/^session_[0-9a-z]{20}$/);
  });
});
