import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { FerryClient } from '@ferry/client';
import {
  providerDefinition,
  type CliConnection,
  type CliConnectionKind,
  type CliModelCapabilities,
  type Provider,
} from '@ferry/shared';
import { Picker, type PickerOption } from './picker.js';
import { Composer } from './composer.js';
import { runOAuthLogin } from '../oauth-login.js';
import {
  billingLabel,
  cliBrandName,
  cliConnectionPickerOptions,
  connectionError,
  connectionFacts,
  safeVerificationModel,
  signInHint,
  type ConnectionFact,
} from '../cli-connections.js';
import { bad, good, muted } from '../colors.js';

export function ConnectPanel({ client, onClose }: { client: FerryClient; onClose: () => void }) {
  const [options, setOptions] = useState<PickerOption[]>([]);
  const [connections, setConnections] = useState<CliConnection[]>([]);
  const [detail, setDetail] = useState<CliConnectionKind | null>(null);
  const [verifyModel, setVerifyModel] = useState<CliConnectionKind | null>(null);
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
    const build = (
      providers: Provider[],
      oauth: Awaited<ReturnType<FerryClient['oauth']['list']>>,
      clis: CliConnection[],
    ) => [
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
      ...cliConnectionPickerOptions(clis),
      { value: 'cli-refresh', label: 'Refresh installed CLIs', group: 'Installed CLIs' },
    ];
    void Promise.all([client.providers.list(), client.oauth.list(), client.cliConnections.list()])
      .then(([providers, oauth, clis]) => {
        if (!active) return;
        setConnections(clis);
        setOptions(build(providers, oauth, clis));
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
    const off = client.on('cliConnections.updated', (connection) => {
      if (!active) return;
      setConnections((old) => [...old.filter((row) => row.kind !== connection.kind), connection]);
    });
    return () => {
      active = false;
      mounted.current = false;
      controller.current?.abort();
      off();
    };
  }, [client]);
  useInput((_input, key) => {
    if (key.escape && (provider || busy)) {
      controller.current?.abort();
      onClose();
    }
  });
  async function refreshCli(kind?: CliConnectionKind) {
    if (locked.current || !isMounted()) return;
    locked.current = true;
    setBusy(true);
    setMessage(kind ? `Refreshing ${cliBrandName(kind)}…` : 'Refreshing installed CLIs…');
    try {
      const next = await client.cliConnections.refresh(kind);
      if (!isMounted()) return;
      setConnections(next);
      setOptions((old) => [
        ...old.filter((row) => row.value !== 'cli-refresh' && !row.value.startsWith('cli:')),
        ...cliConnectionPickerOptions(next),
        { value: 'cli-refresh', label: 'Refresh installed CLIs', group: 'Installed CLIs' },
      ]);
      setMessage('Installed CLIs refreshed.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not refresh installed CLIs.');
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  async function chooseVerificationModel(
    kind: CliConnectionKind,
    ref: CliModelCapabilities['ref'],
  ) {
    if (locked.current || !isMounted()) return;
    locked.current = true;
    setBusy(true);
    const name = connections
      .find((row) => row.kind === kind)
      ?.models.find((m) => m.ref === ref)?.name;
    setMessage(`Verifying ${name ?? ref}…`);
    try {
      const result = await client.cliConnections.verify(kind, ref);
      setMessage(result.ok ? result.message : `Verification unavailable: ${result.message}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Verification failed. Retry.');
    } finally {
      locked.current = false;
      setBusy(false);
      setVerifyModel(null);
    }
  }
  async function runCliAction(kind: CliConnectionKind, action: string) {
    const connection = connections.find((row) => row.kind === kind);
    if (action === 'back') {
      setVerifyModel(null);
      setDetail(null);
      return;
    }
    if (action === 'signin') {
      setMessage(connection ? signInHint(connection) : 'Sign in with the CLI, then Detect again.');
      return;
    }
    if (action === 'detect') {
      await refreshCli(kind);
      return;
    }
    if (action === 'verify-model') {
      setVerifyModel(kind);
      return;
    }
    if (locked.current || !isMounted()) return;
    locked.current = true;
    setBusy(true);
    try {
      if (action === 'verify') {
        // Verify a model that cannot silently spend: the already-verified model, else a free or
        // included-subscription one. Never guess a metered model.
        const target = connection ? safeVerificationModel(connection) : undefined;
        if (!target) {
          setMessage(
            'Choose a specific model to verify; no free or included-subscription model is available to verify without spending approval.',
          );
          return;
        }
        setMessage(`Verifying ${target.name}…`);
        const result = await client.cliConnections.verify(kind, target.ref);
        setMessage(result.ok ? result.message : `Verification unavailable: ${result.message}`);
      } else if (action === 'toggle-native') {
        await client.cliConnections.update(kind, {
          surfaces: { native: !(connection?.surfaces.native ?? false) },
        });
        setMessage(
          `Native ${connection?.surfaces.native ? 'disabled' : 'enabled'} for ${cliBrandName(kind)}.`,
        );
      } else if (action === 'toggle-gateway') {
        await client.cliConnections.update(kind, {
          surfaces: { gateway: !(connection?.surfaces.gateway ?? false) },
        });
        setMessage(
          `Gateway ${connection?.surfaces.gateway ? 'disabled' : 'enabled'} for ${cliBrandName(kind)}.`,
        );
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'CLI action failed. Retry.');
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  async function select(id: string) {
    if (id === 'cli-refresh') {
      await refreshCli();
      return;
    }
    if (id.startsWith('cli:')) {
      setDetail(id.slice(4) as CliConnectionKind);
      return;
    }
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
  if (detail) {
    const connection = connections.find((row) => row.kind === detail);
    const problem = connection ? connectionError(connection) : null;
    const actions: PickerOption[] = connection
      ? [
          {
            value: 'detect',
            label: 'Detect again',
            description: 'Fresh install and account check',
          },
          {
            value: 'verify',
            label: 'Verify generation',
            description: 'Confirm a safe model can generate without spending',
          },
          {
            value: 'verify-model',
            label: 'Verify another model…',
            description: 'Choose which discovered model to verify',
          },
          {
            value: 'toggle-native',
            label: `${connection.surfaces.native ? 'Disable' : 'Enable'} Native`,
            description: 'Explicit opt-in to route chat through this CLI',
          },
          {
            value: 'toggle-gateway',
            label: `${connection.surfaces.gateway ? 'Disable' : 'Enable'} Gateway`,
            description: 'Expose this CLI through the local Gateway API',
          },
          { value: 'signin', label: 'Sign-in instructions' },
          { value: 'back', label: 'Back' },
        ]
      : [{ value: 'back', label: 'Back' }];
    return (
      <Box flexDirection="column">
        <Text bold>{connection ? cliBrandName(connection.kind) : 'Installed CLI'}</Text>
        {connection
          ? connectionFacts(connection).map((fact: ConnectionFact) => (
              <Text key={fact.label}>
                {muted(`${fact.label}: `)}
                {fact.state === 'bad' ? bad(fact.value) : fact.value}
              </Text>
            ))
          : null}
        {connection ? (
          <Text>{problem ? bad(problem) : good('No connection problems reported.')}</Text>
        ) : null}
        <Text>{message}</Text>
        {busy ? (
          <Text>{muted('Working…')}</Text>
        ) : verifyModel === detail && connection ? (
          <Picker
            key="verify-model"
            title={`Verify a ${cliBrandName(detail)} model`}
            options={connection.models
              .filter((model) => !model.hidden)
              .map((model) => ({
                value: model.ref,
                label: model.name,
                description: `${billingLabel(model.billing)}${
                  model.ref === connection.verify.modelRef ? ' · verified' : ''
                }`,
              }))}
            onClose={() => {
              setVerifyModel(null);
            }}
            onSelect={(value) => {
              void chooseVerificationModel(detail, value as CliModelCapabilities['ref']);
            }}
          />
        ) : (
          <Picker
            key="cli-actions"
            title="Installed CLI actions"
            options={actions}
            onClose={() => {
              setDetail(null);
            }}
            onSelect={(value) => {
              void runCliAction(detail, value);
            }}
          />
        )}
      </Box>
    );
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
