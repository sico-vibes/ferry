import {
  contentMarker,
  contentMarkerText,
  metadataOnly,
  stripParts,
  flattenTextParts,
} from './redaction.js';

/** Converts a local Ferry entity to the row contract in the applied Ferry schema. */
export function mapCloudRow(
  table: string,
  id: string,
  value: Record<string, unknown>,
  capture: boolean,
): Record<string, unknown> {
  if (table === 'sessions')
    return {
      id,
      title: value.title ?? '',
      preview: capture ? (value.preview ?? '') : '',
      workspace_id: value.workspaceId ?? null,
      selected_model: value.pinnedModelRef ?? 'auto',
      pinned_model: value.pinnedModelRef ?? null,
      starred: value.starred ?? false,
      pinned: value.pinned ?? false,
      status: value.status ?? 'idle',
      in_flight: value.inFlight ?? false,
      agent_events: capture ? (value.agentEvents ?? []) : [],
      created_at: value.createdAt ?? null,
      updated_at: value.updatedAt ?? null,
      agent_profile_id: value.profileId ?? null,
      metadata: capture
        ? { data: value, lastModelRef: value.modelRef ?? null }
        : {
            workspaceId: value.workspaceId ?? null,
            createdAt: value.createdAt ?? null,
            starred: value.starred ?? false,
            archived: value.archived ?? false,
            lastModelRef: value.modelRef ?? null,
          },
    };
  if (table === 'messages') {
    const parts = value.parts ?? [];
    const agentRole =
      value.agentRole === 'planner' || value.agentRole === 'editor' ? value.agentRole : null;
    return {
      id,
      session_id: value.sessionId,
      role: value.role,
      agent_role: agentRole,
      created_at: value.createdAt ?? null,
      model_ref: value.modelRef ?? null,
      turn_id: value.turnId ?? null,
      parts: capture ? parts : stripParts(parts),
      model_attempts: value.modelAttempts ?? null,
      content_text: capture ? flattenTextParts(parts) : null,
    };
  }
  if (table === 'workspaces')
    return {
      id,
      name: value.name ?? '',
      path: value.path ?? null,
      git_branch: value.gitBranch ?? null,
      language: value.language ?? null,
      settings: value.settings ?? {},
      last_opened_at: value.lastOpenedAt ?? null,
      updated_at: value.updatedAt,
    };
  if (table === 'tasks')
    return {
      session_id: value.sessionId ?? id,
      goal: capture ? (value.goal ?? '') : contentMarkerText(value.goal),
      plan: capture ? (value.plan ?? []) : contentMarker(value.plan),
      decisions: capture ? (value.decisions ?? []) : contentMarker(value.decisions),
      touched_files: capture ? (value.touchedFiles ?? []) : contentMarker(value.touchedFiles),
      next_step: value.nextStep ?? null,
    };
  if (table === 'quota_windows') {
    return {
      id,
      provider_id: id.split(':')[0] ?? id,
      scope: value.scope,
      model_ref: value.modelRef,
      metric: value.metric,
      kind: value.kind,
      period_label: value.periodLabel,
      used: value.used,
      limit_value: value.limit,
      remaining: value.remaining,
      reset_at: value.resetAt,
      confidence: value.confidence,
      data: value,
    };
  }
  if (table === 'cooldowns') {
    return {
      id,
      provider_id: id.split(':')[0] ?? id,
      model_ref: value.modelRef ?? null,
      until: value.until,
      reason: value.reason ?? null,
      provenance: value.provenance ?? null,
      data: value,
    };
  }
  if (table === 'provider_key_entries') {
    return {
      id,
      label: value.label ?? '',
      position: value.position ?? 0,
      enabled: value.enabled ?? true,
      status: value.status ?? 'ok',
      last_error: value.lastError ?? null,
      cooldown_until: value.cooldownUntil ?? null,
    };
  }
  if (table === 'settings_kv') return { key: value.key ?? id, value: value.value ?? null };
  const kinds: Record<string, string> = {
    providers: 'provider',
    models_cache: 'model_cache',
    checkpoints: 'checkpoint',
    delegations: 'delegation',
    optimizer_events: 'optimizer_event',
    optimizer_blobs: 'optimizer_blob',
    task_steps: 'task_step',
    decisions: 'decision',
    touched_files: 'touched_file',
    handoffs: 'handoff',
    quota_observations: 'other',
  };
  const kind = kinds[table] ?? 'other';
  return {
    id,
    kind,
    session_id: value.sessionId ?? null,
    data: capture ? value : metadataOnly(value),
    updated_at: value.updatedAt ?? new Date().toISOString(),
  };
}
