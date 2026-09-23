import { createProviders } from './providers.js';
import { createModels } from './models.js';
import { createWorkspaces } from './workspaces.js';
import { createSessions } from './sessions.js';
import { createProfiles } from './profiles.js';
import { createIntegrations } from './integrations.js';
import { createTranscripts } from './transcripts.js';
import { createSettings } from './settings.js';
import { delegationRuns } from './delegation.js';
import { handoffStats } from './usage.js';
import { sampleCheckpoint, sampleSkill, sampleTaskRecord } from '@ferry/shared/testing';
import type { Checkpoint, TaskRecord } from '@ferry/shared';

export function createFixtures(now: Date) {
  const providers = createProviders(now),
    models = createModels(),
    workspaces = createWorkspaces(),
    sessions = createSessions(now, workspaces),
    profiles = createProfiles(),
    { lanes, mcps } = createIntegrations(),
    messages = createTranscripts(sessions),
    { settings, optimizerStats } = createSettings();
  const taskRecords = new Map<string, TaskRecord>(
    sessions.map((s) => [s.id, { ...sampleTaskRecord, sessionId: s.id, goal: s.title }]),
  );
  const checkpointSession = sessions[2]?.id ?? sessions[0]?.id;
  if (!checkpointSession) throw new Error('Session fixtures are empty');
  const checkpoints: Checkpoint[] = [
    {
      ...sampleCheckpoint,
      id: 'checkpoint_1' as Checkpoint['id'],
      sessionId: checkpointSession,
      label: 'Before flaky test fixes',
      createdAt: now.toISOString(),
    },
    {
      ...sampleCheckpoint,
      id: 'checkpoint_2' as Checkpoint['id'],
      sessionId: checkpointSession,
      label: 'Stable test run',
      createdAt: now.toISOString(),
    },
  ];
  return {
    providers,
    models,
    workspaces,
    sessions,
    profiles,
    messages,
    taskRecords,
    checkpoints,
    settings,
    lanes,
    skills: [
      { ...sampleSkill, id: 'skill_terse' as typeof sampleSkill.id, name: 'terse', enabled: false },
      { ...sampleSkill, id: 'skill_delegate' as typeof sampleSkill.id, name: 'delegate' },
      { ...sampleSkill, id: 'skill_handoff' as typeof sampleSkill.id, name: 'handoff' },
      { ...sampleSkill, id: 'skill_review' as typeof sampleSkill.id, name: 'review' },
    ],
    mcps,
    optimizerStats,
    delegationRuns,
    handoffStats,
  };
}
