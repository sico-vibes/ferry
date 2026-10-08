import type { FerryClient } from '@ferry/client';
import type { ModelInfo, Profile, Session, Workspace } from '@ferry/shared';
import type { PickerOption } from './components/picker.js';

export function profileOptions(profiles: readonly Profile[]): PickerOption[] {
  return profiles.map((row) => ({ value: row.id, label: row.name, description: row.description }));
}

export function projectOptions(workspaces: readonly Workspace[]): PickerOption[] {
  return [
    { value: '', label: 'No project', description: 'Start a Recent' },
    ...workspaces.map((row) => ({ value: row.id, label: row.name, description: row.path })),
  ];
}

export function sessionOptions(
  sessions: readonly (Session & { match?: string })[],
  workspaces: readonly Workspace[],
): PickerOption[] {
  return [...sessions]
    .sort(
      (a, b) =>
        (a.workspaceId ?? '').localeCompare(b.workspaceId ?? '') ||
        b.updatedAt.localeCompare(a.updatedAt),
    )
    .map((row) => {
      // A new chat's preview is often its title; don't print the same text twice.
      const detail = row.match ?? row.preview;
      return {
        value: row.id,
        label: row.title,
        ...(detail && detail.trim() !== row.title.trim() ? { description: detail } : {}),
        group: workspaces.find((item) => item.id === row.workspaceId)?.name ?? 'Recents',
      };
    });
}

const effortLabels: Record<string, string> = {
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
};

export function effortOptions(model: ModelInfo | undefined): PickerOption[] {
  if (!model?.reasoningEfforts?.length) return [];
  return [
    { value: '', label: 'Default effort' },
    ...model.reasoningEfforts.map((value) => ({ value, label: effortLabels[value] ?? value })),
  ];
}

export async function modelOptions(client: FerryClient): Promise<PickerOption[]> {
  const [providers, models, keys] = await Promise.all([
    client.providers.list(),
    client.models.list(),
    client.gateway.listKeys(),
  ]);
  const connected = new Set(
    providers
      .filter((row) => row.enabled && (row.keyStatus === 'valid' || row.keyRequired === false))
      .map((row) => row.id),
  );
  return [
    { value: 'auto', label: 'Auto', description: 'Route with the active profile' },
    { value: 'no-profile', label: 'No profile', description: 'Direct model selection' },
    ...models
      .filter((row) => row.verified === true && connected.has(row.providerId))
      .sort((a, b) => a.providerId.localeCompare(b.providerId) || a.name.localeCompare(b.name))
      .map((row) => ({
        value: row.ref,
        label: row.name,
        group: providers.find((item) => item.id === row.providerId)?.name ?? row.providerId,
        description: `${row.ref}${row.free ? ' · free' : ''} · ${row.contextWindow.toLocaleString()} context`,
        free: row.free,
      })),
    ...keys
      .filter((row) => row.revokedAt === null)
      .map((row) => ({
        value: `gateway/${row.id}`,
        label: row.name,
        group: 'Gateway keys',
        description: `Gateway · ${row.profile}`,
        free: false,
      })),
  ];
}
