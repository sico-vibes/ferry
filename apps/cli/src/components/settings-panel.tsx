import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import type { FerryClient } from '@ferry/client';
import type { Profile, Settings } from '@ferry/shared';
import { Picker } from './picker.js';
import { profileOptions } from '../picker-options.js';
import { bad, muted } from '../colors.js';

export function SettingsPanel({ client, onClose }: { client: FerryClient; onClose: () => void }) {
  const [settings, setSettings] = useState<Settings>();
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [field, setField] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let active = true;
    void Promise.all([client.settings.get(), client.profiles.list()])
      .then(([next, rows]) => {
        if (active) {
          setSettings(next);
          setProfiles(rows);
        }
      })
      .catch((reason: unknown) => {
        if (active) setError(String(reason));
      });
    return () => {
      active = false;
    };
  }, [client]);
  const save = (patch: Partial<Settings>) => {
    if (saving) return;
    setSaving(true);
    setError('');
    void client.settings
      .update(patch)
      .then((next) => {
        setSettings(next);
        setField('');
      })
      .catch((reason: unknown) => {
        setError(String(reason));
      })
      .finally(() => {
        setSaving(false);
      });
  };
  const options =
    field === 'theme'
      ? ['system', 'dark', 'light'].map((value) => ({ value, label: value }))
      : field === 'profile'
        ? profileOptions(profiles)
        : field === 'permission'
          ? ['ask', 'auto_edit', 'full_auto'].map((value) => ({ value, label: value }))
          : field === 'notifications'
            ? [
                { value: 'on', label: 'On' },
                { value: 'off', label: 'Off' },
              ]
            : [
                { value: 'theme', label: `Theme: ${settings?.theme ?? 'loading'}` },
                {
                  value: 'profile',
                  label: `Default profile: ${profiles.find((row) => row.id === settings?.activeProfileId)?.name ?? 'loading'}`,
                },
                {
                  value: 'permission',
                  label: `Permission mode: ${settings?.permissionMode ?? 'loading'}`,
                },
                {
                  value: 'notifications',
                  label: `Notifications: ${settings?.notifications !== false ? 'on' : 'off'}`,
                },
              ];
  return (
    <Box flexDirection="column">
      {error ? <Text>{bad(error)}</Text> : null}
      {saving ? (
        <Text>{muted('Saving settings…')}</Text>
      ) : (
        <Picker
          key={field}
          title={field ? `Settings / ${field}` : 'Settings'}
          options={options}
          onClose={
            field
              ? () => {
                  setField('');
                }
              : onClose
          }
          onSelect={(value) => {
            if (!settings) return;
            if (!field) {
              setField(value);
              return;
            }
            if (field === 'theme') save({ theme: value as Settings['theme'] });
            if (field === 'profile')
              save({ activeProfileId: value as Settings['activeProfileId'] });
            if (field === 'permission')
              save({ permissionMode: value as Settings['permissionMode'] });
            if (field === 'notifications') save({ notifications: value === 'on' });
          }}
        />
      )}
    </Box>
  );
}
