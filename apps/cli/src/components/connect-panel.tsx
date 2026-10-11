import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { FerryClient } from '@ferry/client';
import { providerDefinition, type Provider } from '@ferry/shared';
import { Picker, type PickerOption } from './picker.js';
import { Composer } from './composer.js';
import { runOAuthLogin } from '../oauth-login.js';

export function ConnectPanel({ client, onClose }: { client: FerryClient; onClose: () => void }) {
  const [options, setOptions] = useState<PickerOption[]>([]);
  const [provider, setProvider] = useState<Provider | null>(null);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('Loading shared provider connections…');
  const [prompt, setPrompt] = useState<{ message: string; secret: boolean } | null>(null);
  const [risk, setRisk] = useState<{ id: string; text: string } | null>(null);
  const acknowledged = useRef(new Set<string>());
  const controller = useRef<AbortController | null>(null);
  const answer = useRef<((value: string) => void) | null>(null);
  const locked = useRef(false);
  const mounted = useRef(true);
  const isMounted = () => mounted.current;
  useEffect(() => {
    mounted.current = true;
    let active = true;
    void Promise.all([client.providers.list(), client.oauth.list()])
      .then(([providers, oauth]) => {
        if (!active) return;
        setOptions([
          ...providers
            .filter(
              (row) =>
                row.kind === 'api' &&
                !row.id.startsWith('oauth-') &&
                providerDefinition(row.id)?.releaseState !== 'Coming soon',
            )
            .map((row) => ({
              value: row.id,
              label: row.name,
              description: `${row.keyStatus} · ${providerDefinition(row.id)?.releaseState ?? 'Beta'}`,
            })),
          ...oauth
            .filter((row) => row.actionAvailable !== false && row.status !== 'unavailable')
            .map((row) => ({
              value: `oauth:${row.id}`,
              label: `${row.name} account`,
              description: row.connected
                ? 'Signed in; choose to refresh sign-in'
                : 'Supported account sign-in',
            })),
        ]);
        setMessage(
          'Saved access and routing enablement are separate. Beta providers require explicit Auto opt-in.',
        );
      })
      .catch((error: unknown) => {
        if (active)
          setMessage(
            error instanceof Error ? error.message : 'Could not load connections. Close and retry.',
          );
      });
    return () => {
      active = false;
      mounted.current = false;
      controller.current?.abort();
    };
  }, [client]);
  useInput((_input, key) => {
    if (key.escape && (provider || busy)) {
      controller.current?.abort();
      onClose();
    }
  });
  async function select(id: string) {
    if (locked.current || !isMounted()) return;
    locked.current = true;
    setBusy(true);
    try {
      if (id.startsWith('oauth:')) {
        const oauthId = id.slice(6);
        const connection = (await client.oauth.list()).find((row) => row.id === oauthId);
        if (!isMounted()) return;
        if (connection?.riskLevel === 'high' && !acknowledged.current.has(oauthId)) {
          setRisk({ id, text: connection.riskText });
          return;
        }
        controller.current = new AbortController();
        await runOAuthLogin(client, id.slice(6), {
          signal: controller.current.signal,
          write: setMessage,
          read: (request, signal) =>
            new Promise<string>((resolve, reject) => {
              setInput('');
              setPrompt({ message: request.message, secret: request.kind === 'secret' });
              answer.current = resolve;
              signal.addEventListener(
                'abort',
                () => {
                  reject(new Error('Sign-in cancelled.'));
                },
                {
                  once: true,
                },
              );
            }),
        });
        setPrompt(null);
        setMessage('Signed in. Account allowances and Gateway spending policies still apply.');
      } else {
        const row = (await client.providers.list()).find((row) => row.id === id);
        if (!row) throw new Error('Connection no longer available. Reopen /connect.');
        setProvider(row);
        setMessage(
          row.keyRequired === false
            ? 'Enter an optional API key, or /keyless to discover the server without one.'
            : 'Enter your API key. It is stored by Core in the credential store.',
        );
      }
    } catch (error) {
      setPrompt(null);
      setMessage(error instanceof Error ? error.message : 'Connection failed. Retry.');
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  async function save(value: string) {
    if (!provider || locked.current) return;
    locked.current = true;
    setBusy(true);
    setInput('');
    try {
      if (value !== '/keyless') await client.providers.setKey(provider.id, value);
      else if (provider.keyRequired !== false) throw new Error('This provider requires a key.');
      await client.providers.setEnabled(provider.id, true);
      const result = await client.providers.probe(provider.id);
      setMessage(
        result.ok
          ? `Connected: ${result.message}. Default Auto still excludes Beta providers until enabled.`
          : result.message,
      );
      if (result.ok) setProvider(null);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not save connection. Retry.');
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  return (
    <Box flexDirection="column">
      <Text>{message}</Text>
      {risk ? (
        <>
          <Text>{risk.text}</Text>
          <Picker
            title="Subscription sign-in"
            options={[
              { value: 'cancel', label: 'Cancel' },
              { value: 'continue', label: 'I understand the account risk; continue' },
            ]}
            onClose={onClose}
            onSelect={(value) => {
              const next = risk;
              setRisk(null);
              if (value === 'continue') {
                setBusy(true);
                void client.settings
                  .get()
                  .then((settings) =>
                    client.settings.update({
                      subscriptionOAuthAcknowledged: [
                        ...new Set([...settings.subscriptionOAuthAcknowledged, next.id.slice(6)]),
                      ],
                    }),
                  )
                  .then(() => {
                    acknowledged.current.add(next.id.slice(6));
                    return select(next.id);
                  })
                  .catch((cause: unknown) => {
                    setMessage(
                      cause instanceof Error ? cause.message : 'Could not record approval. Retry.',
                    );
                  });
              }
            }}
          />
        </>
      ) : prompt ? (
        <>
          <Text>{prompt.message}</Text>
          <Composer
            value={input}
            onChange={setInput}
            secret={prompt.secret}
            onSubmit={(value) => {
              answer.current?.(value);
              answer.current = null;
              setPrompt(null);
              setInput('');
            }}
          />
        </>
      ) : provider ? (
        <Composer
          value={input}
          onChange={setInput}
          secret
          disabled={busy}
          onSubmit={(value) => {
            void save(value);
          }}
        />
      ) : busy ? (
        <Text>Waiting for sign-in. Esc cancels.</Text>
      ) : (
        <Picker
          title="Connect a provider"
          options={options}
          onClose={onClose}
          onSelect={(value) => {
            void select(value);
          }}
        />
      )}
    </Box>
  );
}
