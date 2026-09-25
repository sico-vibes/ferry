import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FerryClient } from '@ferry/client';
import type { Profile, Provider } from '@ferry/shared';
import { good, muted, warn } from './format.js';

export function detectGateCommands(cwd: string): string[] {
  const gates: string[] = [];
  try {
    const packageJson = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')) as {
      scripts?: Record<string, unknown>;
    };
    for (const name of ['test', 'lint', 'typecheck'])
      if (typeof packageJson.scripts?.[name] === 'string') gates.push(`pnpm ${name}`);
  } catch {
    /* No package.json in this project. */
  }
  try {
    readFileSync(join(cwd, 'pyproject.toml'));
    gates.push('python -m pytest');
  } catch {
    /* Optional ecosystem. */
  }
  try {
    readFileSync(join(cwd, 'go.mod'));
    gates.push('go test ./...');
  } catch {
    /* Optional ecosystem. */
  }
  try {
    readFileSync(join(cwd, 'Cargo.toml'));
    gates.push('cargo test');
  } catch {
    /* Optional ecosystem. */
  }
  return [...new Set(gates)];
}

export async function initDefaults(client: FerryClient, cwd: string): Promise<void> {
  const [providers, models, profiles] = await Promise.all([
    client.providers.list(),
    client.models.list(),
    client.profiles.list(),
  ]);
  const recommended = providers.filter(
    (provider) =>
      provider.tag === 'legit' &&
      models.some((model) => model.providerId === provider.id && model.free),
  );
  await Promise.all(
    providers.map((provider) =>
      client.providers.setEnabled(
        provider.id,
        recommended.some((item) => item.id === provider.id),
      ),
    ),
  );
  const settings = await client.settings.get();
  const profile = profiles.find((item) => item.id === settings.activeProfileId) ?? profiles[0];
  if (profile) await client.profiles.activate(profile.id);
  writeConfig(cwd, {
    profile: profile?.name ?? 'Default',
    providers: recommended.map((provider) => provider.id),
    gates: detectGateCommands(cwd),
  });
}

function writeConfig(
  cwd: string,
  config: { profile: string; providers: string[]; gates: string[] },
) {
  const directory = join(cwd, '.ferry');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'config.json'), `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

export function InitWizard({
  client,
  cwd,
  onDone,
}: {
  client: FerryClient;
  cwd: string;
  onDone: () => void;
}) {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [stage, setStage] = useState<'loading' | 'providers' | 'keys' | 'profile' | 'saving'>(
    'loading',
  );
  const [cursor, setCursor] = useState(0);
  const [keyValue, setKeyValue] = useState('');
  const [keyIndex, setKeyIndex] = useState(0);
  const [message, setMessage] = useState('');
  React.useEffect(() => {
    void Promise.all([client.providers.list(), client.models.list(), client.profiles.list()]).then(
      ([rows, models, profileRows]) => {
        setProviders(rows);
        setProfiles(profileRows);
        setSelected(
          rows
            .filter(
              (provider) =>
                provider.tag === 'legit' &&
                models.some((model) => model.providerId === provider.id && model.free),
            )
            .map((provider) => provider.id),
        );
        setStage('providers');
      },
    );
  }, [client]);
  useInput((input, key) => {
    if (stage === 'providers') {
      if (key.upArrow) setCursor((value) => Math.max(0, value - 1));
      else if (key.downArrow) setCursor((value) => Math.min(providers.length, value + 1));
      else if (input === ' ' && providers[cursor]) {
        const current = providers[cursor];
        setSelected((value) =>
          value.includes(current.id)
            ? value.filter((id) => id !== current.id)
            : [...value, current.id],
        );
      } else if (key.return) {
        setStage(selected.length ? 'keys' : 'profile');
        setCursor(0);
      }
    } else if (stage === 'keys') {
      if (key.return || input === 'S') {
        const provider = providers.filter((row) => selected.includes(row.id))[keyIndex];
        void (async () => {
          if (key.return && keyValue && provider)
            await client.providers.setKey(provider.id, keyValue);
          setKeyValue('');
          if (keyIndex + 1 >= selected.length) {
            setStage('profile');
            setCursor(0);
          } else setKeyIndex((value) => value + 1);
        })().catch((error: unknown) => {
          setMessage(error instanceof Error ? error.message : String(error));
        });
      } else if (key.backspace || input === '\u007f') setKeyValue((value) => value.slice(0, -1));
      else if (input.length === 1 && input >= ' ') setKeyValue((value) => value + input);
    } else if (stage === 'profile') {
      if (key.upArrow) setCursor((value) => Math.max(0, value - 1));
      else if (key.downArrow) setCursor((value) => Math.min(profiles.length - 1, value + 1));
      else if (key.return) {
        setStage('saving');
        const profile = profiles[cursor];
        void (async () => {
          if (profile) await client.profiles.activate(profile.id);
          await Promise.all(
            providers.map((provider) =>
              client.providers.setEnabled(provider.id, selected.includes(provider.id)),
            ),
          );
          writeConfig(cwd, {
            profile: profile?.name ?? 'Default',
            providers: selected,
            gates: detectGateCommands(cwd),
          });
          setMessage(
            `Saved project config. Detected gates: ${detectGateCommands(cwd).join(', ') || 'none'}`,
          );
          onDone();
        })().catch((error: unknown) => {
          setMessage(error instanceof Error ? error.message : String(error));
          setStage('profile');
        });
      }
    }
  });
  if (stage === 'loading') return <Text>Loading providers and profiles…</Text>;
  if (stage === 'providers')
    return (
      <Box flexDirection="column">
        <Text>
          Select providers (Space toggles, Enter continues). Free providers are preselected.
        </Text>
        {providers.map((provider, index) => (
          <Text key={provider.id}>
            {index === cursor ? '›' : ' '} {selected.includes(provider.id) ? '[x]' : '[ ]'}{' '}
            {provider.name} · {provider.tag}
          </Text>
        ))}
        <Text>{cursor === providers.length ? '›' : ' '} Continue</Text>
      </Box>
    );
  if (stage === 'keys') {
    const provider = providers.filter((row) => selected.includes(row.id))[keyIndex];
    return (
      <Box flexDirection="column">
        <Text>
          {provider?.name ?? 'Provider'} API key ·{' '}
          {provider?.signupUrl ?? provider?.docsUrl ?? 'Get a key from the provider website'}
        </Text>
        <Text>
          Key input hidden. Enter saves; type uppercase S to skip.{' '}
          {muted('•'.repeat(Math.min(20, keyValue.length)))}
        </Text>
      </Box>
    );
  }
  if (stage === 'profile')
    return (
      <Box flexDirection="column">
        <Text>Choose the default profile (Up/Down, Enter).</Text>
        {profiles.map((profile, index) => (
          <Text key={profile.id}>
            {index === cursor ? '›' : ' '} {profile.name} · {profile.description}
          </Text>
        ))}
      </Box>
    );
  return (
    <Text>
      {message || good('Writing .ferry/config.json…')} {warn('')}
    </Text>
  );
}
