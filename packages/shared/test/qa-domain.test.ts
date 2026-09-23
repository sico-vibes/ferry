import { describe, expect, it } from 'vitest';
import { MessagePartSchema, ModelRefSchema, newId } from '../src/index.js';
import * as samples from '../src/testing/samples.js';

describe('QA domain edge cases', () => {
  it('discriminates MessagePart variants and rejects malformed parts', () => {
    const variants = [
      { type: 'text', id: 'part_1', text: 'hi' },
      { type: 'reasoning', id: 'part_2', text: 'think' },
      { type: 'delegation', id: 'part_3', runId: 'run_1' },
      { type: 'error', id: 'part_4', message: 'boom', kind: 'internal' },
    ];
    for (const part of variants) {
      expect(MessagePartSchema.safeParse(part).success).toBe(true);
    }
    expect(MessagePartSchema.safeParse({ type: 'nope', id: 'part_5' }).success).toBe(false);
    expect(MessagePartSchema.safeParse({ type: 'text', id: 'part_6' }).success).toBe(false);
  });

  it('keeps the testing samples referentially consistent', () => {
    expect(samples.sampleSession.workspaceId).toBe(samples.sampleWorkspace.id);
    expect(samples.sampleSession.profileId).toBe(samples.sampleProfile.id);
    expect(samples.sampleMessage.sessionId).toBe(samples.sampleSession.id);
    expect(samples.sampleCheckpoint.sessionId).toBe(samples.sampleSession.id);
    expect(samples.sampleDelegationRun.sessionId).toBe(samples.sampleSession.id);
    expect(samples.sampleModelInfo.providerId).toBe(samples.sampleProvider.id);
    expect(samples.sampleMessage.modelRef).toBe(samples.sampleModelInfo.ref);
  });

  it('generates unique prefixed ids', () => {
    const ids = new Set(Array.from({ length: 500 }, () => newId('session')));
    expect(ids.size).toBe(500);
    for (const id of ids) expect(id).toMatch(/^session_[0-9a-z]{20}$/);
  });

  it('requires a provider segment in model references', () => {
    expect(ModelRefSchema.safeParse('gemini/gemini-3.8-flash').success).toBe(true);
    expect(ModelRefSchema.safeParse('gemini').success).toBe(false);
    expect(ModelRefSchema.safeParse('/leading').success).toBe(false);
  });
});
