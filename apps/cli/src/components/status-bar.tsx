import React from 'react';
import { Text } from 'ink';
import type { Effort, ProviderHealthSnapshot, ProviderLimits } from '@ferry/shared';
import { good, muted, warn } from '../colors.js';
import { statusLine } from '../format.js';

export function StatusBar({
  project,
  profile,
  model,
  effort,
  contextTokens,
  contextWindow,
  replyTokens,
  health,
  limits,
}: {
  project?: string | undefined;
  profile: string;
  model: string;
  effort: Effort | null;
  contextTokens: number | null;
  contextWindow?: number | undefined;
  replyTokens: number | null;
  health: readonly ProviderHealthSnapshot[];
  limits: readonly ProviderLimits[];
}) {
  const providerId = model.split('/')[0];
  const state = health.find((row) => row.providerId === providerId)?.state ?? 'unknown';
  const dot = state === 'healthy' ? good('●') : state === 'unknown' ? muted('●') : warn('●');
  return (
    <Text>
      {muted(project ?? 'No project')} · {statusLine(profile, model, limits)} ·{' '}
      {effort ?? 'default effort'}
      {contextTokens !== null && contextWindow
        ? ` · context ${String(Math.round((contextTokens / contextWindow) * 100))}%`
        : ''}
      {replyTokens !== null ? ` · last reply ${String(replyTokens)} tokens` : ''} · {dot} {state}
    </Text>
  );
}
