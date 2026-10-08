import { SkeletonRows } from '@ferry/ui';
import { useQueryClient } from '@tanstack/react-query';
import { Check, SlidersHorizontal } from 'lucide-react';
import { Pill, Select, Sheet, Switch } from '@ferry/ui';
import type { DelegationMode, PermissionMode, SessionId, Settings } from '@ferry/shared';
import { useFerryClient } from '../data/client';
import { keys, useProfiles, useSessionDetail, useSettings } from '../data/queries';
import { useToasts } from '../state/toasts';
import { useUI } from '../state/ui';

const permissionOptions: { value: PermissionMode; label: string }[] = [
  { value: 'ask', label: 'Ask before changes' },
  { value: 'auto_edit', label: 'Auto edit' },
  { value: 'full_auto', label: 'Full auto' },
];
const delegationOptions: { value: DelegationMode; label: string }[] = [
  { value: 'off', label: 'Off' },
  { value: 'suggest', label: 'Suggest' },
  { value: 'auto', label: 'Automatic' },
];
const terseOptions = [
  { value: 'off', label: 'Off' },
  { value: 'lite', label: 'Lite' },
  { value: 'full', label: 'Full' },
  { value: 'ultra', label: 'Ultra' },
];

export function ConfigurationSheet({
  open,
  onOpenChange,
  sessionId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessionId?: SessionId | undefined;
}) {
  const client = useFerryClient();
  const cache = useQueryClient();
  const pushToast = useToasts((state) => state.push);
  const activeId = useUI((state) => state.activeId);
  const activeSessionId = sessionId ?? activeId ?? undefined;
  const { data: settings } = useSettings();
  const { data: profiles = [] } = useProfiles();
  const { data: activeSession } = useSessionDetail(activeSessionId ?? ('' as never));
  const profileId = activeSession?.session.profileId ?? settings?.activeProfileId ?? '';
  const profileOptions = profiles.map((profile) => ({ value: profile.id, label: profile.name }));

  const updateSettings = async (patch: Partial<Settings>) => {
    try {
      const updated = await client.settings.update(patch);
      cache.setQueryData(keys.settings, updated);
      await cache.invalidateQueries({ queryKey: keys.settings });
    } catch (error) {
      pushToast({
        kind: 'error',
        title: 'Configuration could not be saved',
        body: error instanceof Error ? error.message : 'Try the change again.',
      });
    }
  };

  const updateOptimizer = (key: keyof Settings['optimizers'], value: boolean | string) => {
    if (!settings) return;
    void updateSettings({
      optimizers: { ...settings.optimizers, [key]: value },
    });
  };

  const selectProfile = async (id: string) => {
    const profile = profiles.find((item) => item.id === id);
    if (!profile) return;
    try {
      await client.profiles.activate(profile.id, activeSessionId);
      await Promise.all([
        cache.invalidateQueries({ queryKey: keys.profiles }),
        cache.invalidateQueries({ queryKey: keys.settings }),
        cache.invalidateQueries({ queryKey: keys.sessions }),
        ...(activeSessionId
          ? [cache.invalidateQueries({ queryKey: keys.session(activeSessionId) })]
          : []),
      ]);
    } catch (error) {
      pushToast({
        kind: 'error',
        title: 'Session profile could not be changed',
        body: error instanceof Error ? error.message : 'Try selecting the profile again.',
      });
    }
  };

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title="Configuration"
      description="Set the profile and safeguards Ferry uses for this session."
      contentClassName="configuration-sheet"
    >
      {!settings ? (
        <SkeletonRows rows={5} />
      ) : (
        <div className="configuration-content">
          <section className="configuration-section">
            <header>
              <span className="configuration-icon">
                <SlidersHorizontal size={15} />
              </span>
              <div>
                <h2>Session</h2>
                <p>Choose how Ferry approaches this task.</p>
              </div>
            </header>
            <label className="configuration-field">
              <span>Session profile</span>
              <Select
                value={profileId}
                onValueChange={(value) => void selectProfile(value)}
                options={profileOptions}
                label="Session profile"
              />
            </label>
            <label className="configuration-field">
              <span>Permission mode</span>
              <Select
                value={settings.permissionMode}
                onValueChange={(value) =>
                  void updateSettings({ permissionMode: value as PermissionMode })
                }
                options={permissionOptions}
                label="Permission mode"
              />
            </label>
            <label className="configuration-field">
              <span>Delegation mode</span>
              <Select
                value={settings.delegationMode}
                onValueChange={(value) =>
                  void updateSettings({ delegationMode: value as DelegationMode })
                }
                options={delegationOptions}
                label="Delegation mode"
              />
            </label>
          </section>

          <section className="configuration-section">
            <header>
              <span className="configuration-icon">
                <Check size={15} />
              </span>
              <div>
                <h2>Optimizers</h2>
                <p>Reduce noise while keeping useful context.</p>
              </div>
            </header>
            <label className="configuration-field">
              <span>Terse output</span>
              <Select
                value={settings.optimizers.terse}
                onValueChange={(value) => {
                  updateOptimizer('terse', value);
                }}
                options={terseOptions}
                label="Terse output level"
              />
            </label>
            <OptimizerToggle
              label="Tool output filters"
              checked={settings.optimizers.toolOutputFilters}
              onChange={(value) => {
                updateOptimizer('toolOutputFilters', value);
              }}
            />
            <OptimizerToggle
              label="Recovery handles"
              checked={settings.optimizers.recoveryHandles}
              onChange={(value) => {
                updateOptimizer('recoveryHandles', value);
              }}
            />
            <OptimizerToggle
              label="Context hygiene"
              checked={settings.optimizers.contextHygiene}
              onChange={(value) => {
                updateOptimizer('contextHygiene', value);
              }}
            />
            <OptimizerToggle
              label="RTK compression"
              checked={settings.optimizers.rtk}
              onChange={(value) => {
                updateOptimizer('rtk', value);
              }}
            />
          </section>

          <div className="configuration-footer">
            <Pill
              onClick={() => {
                onOpenChange(false);
              }}
            >
              Done
            </Pill>
          </div>
        </div>
      )}
    </Sheet>
  );
}

function OptimizerToggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="configuration-field">
      <span>{label}</span>
      <Switch label={label} checked={checked} onCheckedChange={onChange} />
    </div>
  );
}
