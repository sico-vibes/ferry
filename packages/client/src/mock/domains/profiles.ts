import { MockNotFoundError } from '../errors.js';
import { DIRECT_PROFILE_ID, ProfileSchema, BenchCodingReportSchema } from '@ferry/shared';
import type { Profile } from '@ferry/shared';
import type { FerryClient } from '../../ferry-client.js';
import type { MockDeps } from './deps.js';
import type { MockStore } from '../types.js';

const MANAGED_SLOT = 'device-optimized';
const LEGACY_GENERATED_PREFIX = 'profile_optimized_';

interface OptimizedUndoRecord {
  undoId: string;
  managedId: Profile['id'];
  created: boolean;
  priorActiveProfileId: Profile['id'];
  priorManaged: Profile | null;
  priorSiblings: Profile[];
  postManaged: Profile;
  postSiblings: Profile[];
}

function isManaged(profile: Profile): boolean {
  return profile.provenance?.managedSlot === MANAGED_SLOT;
}

function isLegacyGenerated(profile: Profile): boolean {
  return (
    profile.id.startsWith(LEGACY_GENERATED_PREFIX) && profile.provenance?.kind === 'provider-check'
  );
}

function isEligibleGenerated(profile: Profile): boolean {
  return !profile.builtin && (isManaged(profile) || isLegacyGenerated(profile));
}

function newestLegacy(profiles: readonly Profile[]): Profile | undefined {
  let newest: Profile | undefined;
  for (const profile of profiles) {
    if (profile.builtin || !isLegacyGenerated(profile)) continue;
    if (!newest) {
      newest = profile;
      continue;
    }
    if ((profile.provenance?.generatedAt ?? '') >= (newest.provenance?.generatedAt ?? ''))
      newest = profile;
  }
  return newest;
}

function resolvePriorActive(profiles: readonly Profile[], active: Profile['id']): Profile['id'] {
  if (profiles.some((profile) => profile.id === active)) return active;
  const fallback =
    profiles.find((profile) => profile.builtin && profile.name === 'Auto-Free') ??
    profiles.find((profile) => profile.builtin);
  return fallback?.id ?? active;
}

function withManagedSlot(profile: Profile, id: Profile['id']): Profile {
  const provenance = profile.provenance;
  if (!provenance) throw new Error('An applied profile needs provider-check provenance');
  return ProfileSchema.parse({
    ...profile,
    id,
    builtin: false,
    provenance: {
      kind: 'provider-check',
      generatedAt: provenance.generatedAt,
      sampleCount: provenance.sampleCount,
      note: provenance.note,
      managedSlot: MANAGED_SLOT,
    },
  });
}

function markSuperseded(profile: Profile, managedId: Profile['id']): Profile {
  const provenance = profile.provenance;
  if (!provenance) throw new Error('A generated profile needs provider-check provenance');
  return ProfileSchema.parse({
    ...profile,
    provenance: {
      kind: 'provider-check',
      generatedAt: provenance.generatedAt,
      sampleCount: provenance.sampleCount,
      note: provenance.note,
      supersededBy: managedId,
    },
  });
}

const fingerprint = (profile: Profile): string => JSON.stringify(ProfileSchema.parse(profile));
const conflict = (message: string): never => {
  throw Object.assign(new Error(message), { kind: 'conflict' });
};

export interface ProfilesDomainOptions {
  /** True when an external binding (e.g. a Gateway key, revoked or not) references the id. */
  isGatewayProfileReferenced?: (id: string) => boolean;
}

export function createProfilesDomain(
  _store: MockStore,
  deps: MockDeps,
  options: ProfilesDomainOptions = {},
): FerryClient['profiles'] {
  const { state, before, persist, syncStore, session, updateSession } = deps;
  let undoRecord: OptimizedUndoRecord | null = null;
  return {
    importCodingResults: (value) => {
      const report = BenchCodingReportSchema.parse(value);
      const imported = report.dryRun
        ? 0
        : report.runs.filter((run) => run.status !== 'skipped').length;
      return Promise.resolve({ imported, total: imported });
    },
    async list() {
      await before();
      return structuredClone(state.profiles);
    },
    async save(profile) {
      await before();
      const p = ProfileSchema.parse(profile);
      if (p.id === DIRECT_PROFILE_ID) throw new Error('The No profile built-in cannot be edited');
      const index = state.profiles.findIndex((x) => x.id === p.id);
      if (index < 0) state.profiles.push(p);
      else state.profiles[index] = p;
      persist();
      syncStore();
      return structuredClone(p);
    },
    async remove(id) {
      await before();
      const p = state.profiles.find((x) => x.id === id);
      if (!p) throw new MockNotFoundError('Profile', id);
      if (p.builtin) throw new Error('Builtin profiles cannot be removed');
      state.profiles = state.profiles.filter((x) => x.id !== id);
      persist();
      syncStore();
    },
    async activate(id, sessionId) {
      await before();
      if (!state.profiles.some((p) => p.id === id)) throw new MockNotFoundError('Profile', id);
      if (sessionId) {
        session(sessionId).profileId = id;
        updateSession(session(sessionId));
      } else state.settings.activeProfileId = id;
      persist();
      syncStore();
    },
    async applyOptimized(profile) {
      await before();
      const incoming = ProfileSchema.parse(profile);
      if (incoming.builtin)
        throw new Error('A built-in profile cannot be applied as an optimized profile');
      if (incoming.provenance?.kind !== 'provider-check')
        throw new Error('Only a provider-check generated profile can be applied');

      const managed = state.profiles.filter(isManaged);
      if (managed.length > 1)
        return conflict('Multiple managed profiles exist; reconcile them before applying');
      const existing = managed[0] ?? newestLegacy(state.profiles) ?? null;
      const created = existing === null;
      const managedId = existing ? existing.id : incoming.id;

      if (created) {
        const reserved =
          managedId === DIRECT_PROFILE_ID ||
          state.profiles.some((p) => p.builtin && p.id === managedId);
        if (reserved)
          throw new Error(`The profile id ${managedId} is reserved by a built-in profile`);
        if (state.profiles.some((p) => !p.builtin && p.id === managedId))
          return conflict(`A custom profile already uses the id ${managedId}`);
      }

      const managedProfile = withManagedSlot(incoming, managedId);
      const priorSiblings: Profile[] = [];
      const siblings: Profile[] = [];
      for (const p of state.profiles) {
        if (p.id === managedId || !isEligibleGenerated(p)) continue;
        priorSiblings.push(structuredClone(p));
        siblings.push(markSuperseded(p, managedId));
      }
      const siblingById = new Map(siblings.map((p) => [p.id, p]));
      const nextProfiles = state.profiles.map((p) =>
        p.id === managedId ? managedProfile : (siblingById.get(p.id) ?? p),
      );
      if (created) nextProfiles.push(managedProfile);
      state.profiles = nextProfiles;

      const undoId = `optimized_undo_${Math.random().toString(36).slice(2)}`;
      undoRecord = {
        undoId,
        managedId,
        created,
        priorActiveProfileId: resolvePriorActive(nextProfiles, state.settings.activeProfileId),
        priorManaged: existing ? structuredClone(existing) : null,
        priorSiblings,
        postManaged: structuredClone(managedProfile),
        postSiblings: siblings.map((p) => structuredClone(p)),
      };
      state.settings = { ...state.settings, activeProfileId: managedId };
      persist();
      syncStore();
      deps.emit('settings.updated', structuredClone(state.settings));
      return { profile: structuredClone(managedProfile), undoId };
    },
    async undoOptimized(undoId) {
      await before();
      if (undoRecord?.undoId !== undoId)
        return conflict(
          'This optimization can no longer be undone (the token is stale or already used)',
        );
      const record = undoRecord;
      const byId = new Map(state.profiles.map((p) => [p.id, p]));
      const currentManaged = byId.get(record.managedId);
      if (!currentManaged || fingerprint(currentManaged) !== fingerprint(record.postManaged))
        return conflict(
          'The optimized profile changed after it was applied; undo was not performed',
        );
      if (state.settings.activeProfileId !== record.managedId)
        return conflict(
          'The active profile changed after this optimization; undo was not performed',
        );
      for (const post of record.postSiblings) {
        const current = byId.get(post.id);
        if (!current || fingerprint(current) !== fingerprint(post))
          return conflict(
            'A generated profile changed after this optimization; undo was not performed',
          );
      }

      const referenced =
        state.sessions.some((s) => s.profileId === record.managedId) ||
        state.workspaces.some((w) => w.settings.defaultProfileId === record.managedId) ||
        (options.isGatewayProfileReferenced?.(record.managedId) ?? false);
      const removeManaged = record.created && !referenced;

      let nextProfiles: Profile[];
      if (removeManaged) nextProfiles = state.profiles.filter((p) => p.id !== record.managedId);
      else if (record.created) nextProfiles = [...state.profiles];
      else if (record.priorManaged)
        nextProfiles = state.profiles.map((p) =>
          p.id === record.managedId ? (record.priorManaged ?? p) : p,
        );
      else return conflict('Undo metadata is incomplete for this optimization');

      const priorSiblingById = new Map(record.priorSiblings.map((p) => [p.id, p]));
      nextProfiles = nextProfiles.map((p) => priorSiblingById.get(p.id) ?? p);
      if (!nextProfiles.some((p) => p.id === record.priorActiveProfileId))
        return conflict('The previously active profile no longer exists; undo was not performed');
      state.profiles = nextProfiles;
      state.settings = { ...state.settings, activeProfileId: record.priorActiveProfileId };
      undoRecord = null;
      persist();
      syncStore();
      deps.emit('settings.updated', structuredClone(state.settings));
    },
  };
}
