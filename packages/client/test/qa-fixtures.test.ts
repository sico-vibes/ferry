import { describe, expect, it } from 'vitest';
import {
  CheckpointSchema,
  MessageSchema,
  ModelInfoSchema,
  ProfileSchema,
  ProviderSchema,
  SessionSchema,
  TaskRecordSchema,
  WorkspaceSchema,
} from '@ferry/shared';
import { createMockFerryClient } from '../src/mock/client.js';
import { createFakeClock } from '../src/mock/clock.js';

const now = new Date('2026-09-23T21:47:00.000Z');

const providerOf = (ref: string): string => ref.split('/')[0] ?? '';

describe('QA fixture integrity', () => {
  it('parses every fixture collection and keeps ids unique', () => {
    const client = createMockFerryClient({ clock: createFakeClock(now).clock });
    const state = client.__state();

    state.workspaces.forEach((x) => WorkspaceSchema.parse(x));
    state.sessions.forEach((x) => SessionSchema.parse(x));
    state.providers.forEach((x) => ProviderSchema.parse(x));
    state.models.forEach((x) => ModelInfoSchema.parse(x));
    state.profiles.forEach((x) => ProfileSchema.parse(x));
    state.checkpoints.forEach((x) => CheckpointSchema.parse(x));
    for (const [, rows] of state.messages) rows.forEach((x) => MessageSchema.parse(x));
    for (const [, task] of state.taskRecords) TaskRecordSchema.parse(task);

    expect(new Set(state.workspaces.map((x) => x.id)).size).toBe(state.workspaces.length);
    expect(new Set(state.sessions.map((x) => x.id)).size).toBe(state.sessions.length);
    expect(new Set(state.providers.map((x) => x.id)).size).toBe(state.providers.length);
    expect(new Set(state.models.map((x) => x.ref)).size).toBe(state.models.length);
    expect(new Set(state.profiles.map((x) => x.id)).size).toBe(state.profiles.length);
    expect(new Set(state.checkpoints.map((x) => x.id)).size).toBe(state.checkpoints.length);

    for (const [sessionId, rows] of state.messages) {
      expect(new Set(rows.map((x) => x.id)).size).toBe(rows.length);
      for (const message of rows) {
        expect(message.sessionId).toBe(sessionId);
        expect(new Set(message.parts.map((part) => part.id)).size).toBe(message.parts.length);
      }
    }
  });

  it('keeps every cross-reference pointing at an existing object', () => {
    const client = createMockFerryClient({ clock: createFakeClock(now).clock });
    const state = client.__state();

    const workspaceIds = new Set<string>(state.workspaces.map((x) => x.id));
    const profileIds = new Set<string>(state.profiles.map((x) => x.id));
    const providerIds = new Set<string>(state.providers.map((x) => x.id));
    const sessionIds = new Set<string>(state.sessions.map((x) => x.id));

    for (const session of state.sessions) {
      expect(workspaceIds.has(session.workspaceId)).toBe(true);
      expect(profileIds.has(session.profileId)).toBe(true);
      if (session.modelRef) expect(providerIds.has(providerOf(session.modelRef))).toBe(true);
    }
    for (const model of state.models) expect(providerIds.has(model.providerId)).toBe(true);
    for (const checkpoint of state.checkpoints) {
      expect(sessionIds.has(checkpoint.sessionId)).toBe(true);
    }
    for (const [sessionId, task] of state.taskRecords) {
      expect(sessionIds.has(sessionId)).toBe(true);
      expect(task.sessionId).toBe(sessionId);
    }
    for (const run of state.delegationRuns) expect(sessionIds.has(run.sessionId)).toBe(true);

    for (const [, rows] of state.messages) {
      for (const message of rows) {
        if (message.modelRef) expect(providerIds.has(providerOf(message.modelRef))).toBe(true);
        for (const part of message.parts) {
          if (part.type === 'handoff_marker') {
            expect(providerIds.has(providerOf(part.from))).toBe(true);
            expect(providerIds.has(providerOf(part.to))).toBe(true);
          }
        }
      }
    }
  });
});
