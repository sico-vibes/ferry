import type { HandoffStat, Session } from '@ferry/shared';
import type { MockSessionUsageContribution } from '../types.js';
export const handoffStats: HandoffStat[] = [
  { reason: 'quota', count: 9 },
  { reason: 'rate_limit', count: 4 },
  { reason: 'error', count: 1 },
  { reason: 'context', count: 2 },
  { reason: 'capability', count: 1 },
  { reason: 'manual', count: 0 },
];

/**
 * Retained usage for a couple of fixture conversations. Real numbers cover the reported case, an
 * explicit `0` covers a reported zero, and a `null`-token row keeps the honest "Not reported"
 * distinction so coverage is labelled incomplete instead of fabricated.
 */
export function createSessionUsage(sessions: Session[]): MockSessionUsageContribution[] {
  const usageSession = sessions[1];
  const mixedSession = sessions[2];
  const contributions: MockSessionUsageContribution[] = [];
  if (usageSession) {
    contributions.push({
      eventId: 'usage_fixture_auth',
      sessionId: usageSession.id,
      modelRef: 'openrouter/gpt-4.1-mini',
      providerId: 'openrouter',
      connectionId: null,
      accountKey: null,
      inputTokens: 1840,
      outputTokens: 420,
      cachedTokens: 0,
      reasoningTokens: null,
      occurredAt: usageSession.updatedAt,
    });
  }
  if (mixedSession) {
    contributions.push({
      eventId: 'usage_fixture_flaky_a',
      sessionId: mixedSession.id,
      modelRef: 'cerebras/gpt-oss-120b',
      providerId: 'cerebras',
      connectionId: null,
      accountKey: null,
      inputTokens: 3100,
      outputTokens: 640,
      cachedTokens: null,
      reasoningTokens: 128,
      occurredAt: mixedSession.updatedAt,
    });
    // A second provider served the same conversation but never reported token counts.
    contributions.push({
      eventId: 'usage_fixture_flaky_b',
      sessionId: mixedSession.id,
      modelRef: 'nvidia/nemotron-3-ultra',
      providerId: 'nvidia',
      connectionId: null,
      accountKey: null,
      inputTokens: null,
      outputTokens: null,
      cachedTokens: null,
      reasoningTokens: null,
      occurredAt: mixedSession.updatedAt,
    });
  }
  return contributions;
}
