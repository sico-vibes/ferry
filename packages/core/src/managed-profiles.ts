import { z } from 'zod';
import {
  DIRECT_PROFILE_ID,
  ProfileIdSchema,
  ProfileSchema,
  SettingsSchema,
  newId,
  type Profile,
  type ProfileId,
  type Settings,
} from '@ferry/shared';
import { DEFAULT_SETTINGS } from '@ferry/config';
import { BUILTIN_PROFILES } from '@ferry/router';
import { rpcDomainError } from './host.js';
import type { FerryServices } from './services.js';

/** The single managed slot marker for the device-optimized profile. */
export const MANAGED_SLOT = 'device-optimized';
/** Legacy generated profiles created before managed slots existed. */
export const LEGACY_GENERATED_PREFIX = 'profile_optimized_';
/** Persisted metadata for the opaque one-use Undo token. */
export const OPTIMIZED_UNDO_KEY = 'optimized-profile-undo';

type ParsedProfile = z.infer<typeof ProfileSchema>;

const UndoRecordSchema = z.object({
  undoId: z.string().min(1).max(128),
  createdAt: z.iso.datetime(),
  managedId: ProfileIdSchema,
  created: z.boolean(),
  priorActiveProfileId: ProfileIdSchema,
  priorManaged: ProfileSchema.nullable(),
  priorSiblings: z.array(ProfileSchema),
  postManaged: ProfileSchema,
  postSiblings: z.array(ProfileSchema),
});
type UndoRecord = z.infer<typeof UndoRecordSchema>;

export interface ApplyOptimizedResult {
  profile: Profile;
  undoId: string;
  settings: Settings;
}

/** A generated provider-check profile that is the single managed slot. */
export function isManagedProfile(profile: Pick<ParsedProfile, 'provenance'>): boolean {
  return profile.provenance?.managedSlot === MANAGED_SLOT;
}

/** A generated provider-check profile from before managed slots were introduced. */
export function isLegacyGeneratedProfile(
  profile: Pick<ParsedProfile, 'id' | 'provenance'>,
): boolean {
  return (
    profile.id.startsWith(LEGACY_GENERATED_PREFIX) && profile.provenance?.kind === 'provider-check'
  );
}

/**
 * Only a managed slot or an exact legacy generated ID with provider-check provenance is
 * eligible. A user copy that merely carries the evidence or display name is never adopted.
 */
export function isEligibleGeneratedProfile(profile: Profile): boolean {
  return !profile.builtin && (isManagedProfile(profile) || isLegacyGeneratedProfile(profile));
}

/** Picks the newest legacy generated profile; later entries win an equal timestamp. */
export function newestLegacyGeneratedProfile(profiles: readonly Profile[]): Profile | undefined {
  let newest: Profile | undefined;
  for (const profile of profiles) {
    if (profile.builtin || !isLegacyGeneratedProfile(profile)) continue;
    if (!newest) {
      newest = profile;
      continue;
    }
    const candidate = profile.provenance?.generatedAt ?? '';
    const current = newest.provenance?.generatedAt ?? '';
    if (candidate >= current) newest = profile;
  }
  return newest;
}

function savedProfiles(services: FerryServices): ParsedProfile[] {
  const value = services.settings.get('profiles');
  return Array.isArray(value) ? value.map((profile) => ProfileSchema.parse(profile)) : [];
}

function currentSettings(services: FerryServices): Settings {
  return SettingsSchema.parse(services.settings.get('global') ?? DEFAULT_SETTINGS);
}

function withManagedSlot(profile: ParsedProfile, id: ProfileId): ParsedProfile {
  const provenance = profile.provenance;
  if (!provenance)
    throw rpcDomainError(
      -32010,
      'validation',
      'An applied profile needs provider-check provenance',
    );
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

function markSuperseded(profile: ParsedProfile, managedId: ProfileId): ParsedProfile {
  const provenance = profile.provenance;
  if (!provenance)
    throw rpcDomainError(
      -32010,
      'validation',
      'A generated profile needs provider-check provenance',
    );
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

function fingerprint(profile: ParsedProfile): string {
  return JSON.stringify(ProfileSchema.parse(profile));
}

function isProfileReferenced(services: FerryServices, id: ProfileId): boolean {
  if (services.sessions.list().some((session) => session.profileId === id)) return true;
  if (services.workspaces.list().some((workspace) => workspace.settings.defaultProfileId === id))
    return true;
  const keys = services.settings.get('gateway-keys');
  if (Array.isArray(keys))
    for (const key of keys) {
      if (
        typeof key === 'object' &&
        key !== null &&
        'profile' in key &&
        (key as { profile?: unknown }).profile === id
      )
        return true;
    }
  return false;
}

const conflict = (message: string) => rpcDomainError(-32049, 'conflict', message);

/**
 * Adopts the single managed slot (or the newest legacy generated profile) and writes the
 * measured recommendation into it, superseding older generated versions. When none exists
 * a valid incoming ID is used. The profile write, active selection and Undo metadata commit
 * in one SQLite transaction so a rollback never leaves a partial active profile.
 */
export function applyOptimizedProfile(
  services: FerryServices,
  rawProfile: unknown,
): ApplyOptimizedResult {
  const incoming = ProfileSchema.parse(rawProfile);
  if (incoming.builtin)
    throw rpcDomainError(
      -32010,
      'validation',
      'A built-in profile cannot be applied as an optimized profile',
    );
  if (incoming.provenance?.kind !== 'provider-check')
    throw rpcDomainError(
      -32010,
      'validation',
      'Only a provider-check generated profile can be applied',
    );

  const global = currentSettings(services);
  const profiles = savedProfiles(services);

  const managed = profiles.filter((profile) => isManagedProfile(profile));
  if (managed.length > 1)
    throw conflict('Multiple managed profiles exist; reconcile them before applying');
  const existing = managed[0] ?? newestLegacyGeneratedProfile(profiles) ?? null;
  const created = existing === null;
  const managedId = existing ? existing.id : incoming.id;

  if (created) {
    if (
      managedId === DIRECT_PROFILE_ID ||
      BUILTIN_PROFILES.some((builtin) => builtin.id === managedId)
    )
      throw rpcDomainError(
        -32010,
        'validation',
        `The profile id ${managedId} is reserved by a built-in profile`,
      );
    if (profiles.some((profile) => profile.id === managedId))
      throw conflict(`A custom profile already uses the id ${managedId}`);
  }

  const managedProfile = withManagedSlot(incoming, managedId);
  const priorSiblings: ParsedProfile[] = [];
  const siblings: ParsedProfile[] = [];
  for (const profile of profiles) {
    if (profile.id === managedId || !isEligibleGeneratedProfile(profile)) continue;
    priorSiblings.push(profile);
    siblings.push(markSuperseded(profile, managedId));
  }
  const siblingById = new Map(siblings.map((profile) => [profile.id, profile]));

  const nextProfiles: ParsedProfile[] = profiles.map((profile) => {
    if (profile.id === managedId) return managedProfile;
    return siblingById.get(profile.id) ?? profile;
  });
  if (created) nextProfiles.push(managedProfile);

  const nextGlobal = SettingsSchema.parse({ ...global, activeProfileId: managedId });
  const undoId = newId('optimized_undo');
  // A never-configured active selection ("default") is not a real profile; record the same
  // fallback the settings domain would repair to so Undo can restore a resolvable selection.
  const knownProfileIds = new Set<string>([
    ...BUILTIN_PROFILES.map((profile) => profile.id),
    ...profiles.map((profile) => profile.id),
  ]);
  const priorActiveProfileId = knownProfileIds.has(global.activeProfileId)
    ? global.activeProfileId
    : ((BUILTIN_PROFILES.find((profile) => profile.name === 'Auto-Free') ?? BUILTIN_PROFILES[0])
        ?.id ?? global.activeProfileId);
  const record: UndoRecord = UndoRecordSchema.parse({
    undoId,
    createdAt: services.clock.now().toISOString(),
    managedId,
    created,
    priorActiveProfileId,
    priorManaged: existing,
    priorSiblings,
    postManaged: managedProfile,
    postSiblings: siblings,
  });

  const commit = services.db.client.transaction(() => {
    services.settings.put('profiles', nextProfiles);
    services.settings.put('global', nextGlobal);
    services.settings.put(OPTIMIZED_UNDO_KEY, record);
  });
  commit();

  return { profile: managedProfile, undoId, settings: nextGlobal };
}

/**
 * Restores the prior managed contents, older generated lineage and active selection recorded
 * by the matching one-use token. It edits only the profiles and settings it wrote, so
 * unrelated settings changes survive. A stale/consumed token or an intervening edit to a
 * touched profile or the active selection returns an explicit conflict and changes nothing.
 */
export function undoOptimizedProfile(
  services: FerryServices,
  rawUndoId: unknown,
): { settings: Settings } {
  const undoId = z.string().min(1).max(128).parse(rawUndoId);
  const stored = UndoRecordSchema.safeParse(services.settings.get(OPTIMIZED_UNDO_KEY));
  if (!stored.success || stored.data.undoId !== undoId)
    throw conflict(
      'This optimization can no longer be undone (the token is stale or already used)',
    );
  const record = stored.data;

  const global = currentSettings(services);
  const profiles = savedProfiles(services);
  const byId = new Map(profiles.map((profile) => [profile.id, profile]));

  const currentManaged = byId.get(record.managedId);
  if (!currentManaged || fingerprint(currentManaged) !== fingerprint(record.postManaged))
    throw conflict('The optimized profile changed after it was applied; undo was not performed');
  if (global.activeProfileId !== record.managedId)
    throw conflict('The active profile changed after this optimization; undo was not performed');
  for (const post of record.postSiblings) {
    const current = byId.get(post.id);
    if (!current || fingerprint(current) !== fingerprint(post))
      throw conflict('A generated profile changed after this optimization; undo was not performed');
  }

  const removeManaged = record.created && !isProfileReferenced(services, record.managedId);

  let nextProfiles: ParsedProfile[];
  if (removeManaged) {
    nextProfiles = profiles.filter((profile) => profile.id !== record.managedId);
  } else if (record.created) {
    nextProfiles = [...profiles];
  } else {
    if (!record.priorManaged) throw conflict('Undo metadata is incomplete for this optimization');
    const priorManaged = record.priorManaged;
    nextProfiles = profiles.map((profile) =>
      profile.id === record.managedId ? priorManaged : profile,
    );
  }

  const priorSiblingById = new Map(record.priorSiblings.map((profile) => [profile.id, profile]));
  nextProfiles = nextProfiles.map((profile) => priorSiblingById.get(profile.id) ?? profile);

  const priorActive = record.priorActiveProfileId;
  const priorActiveExists =
    BUILTIN_PROFILES.some((profile) => profile.id === priorActive) ||
    nextProfiles.some((profile) => profile.id === priorActive);
  if (!priorActiveExists)
    throw conflict('The previously active profile no longer exists; undo was not performed');

  const nextGlobal = SettingsSchema.parse({
    ...global,
    activeProfileId: record.priorActiveProfileId,
  });

  const commit = services.db.client.transaction(() => {
    services.settings.put('profiles', nextProfiles);
    services.settings.put('global', nextGlobal);
    services.settings.delete(OPTIMIZED_UNDO_KEY);
  });
  commit();

  return { settings: nextGlobal };
}
