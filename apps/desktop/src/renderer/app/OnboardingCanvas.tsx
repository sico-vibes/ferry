import { useEffect, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FerryMark, Select, SkeletonRows, UiV2 } from '@ferry/ui';
import type { Settings } from '@ferry/shared';
import { useFerryClient } from '../data/client';
import { keys } from '../data/queries';
import { ProviderConnections } from './ProviderConnections';
import { ProviderReadiness } from './ProviderReadiness';
import { GatewayConnect } from './gateway/GatewayConnect';
import { TextPromptDialog } from './TextPromptDialog';

const titles = [
  'What will you use Ferry for?',
  'Connect a provider',
  'Use Auto',
  'Check readiness',
  'Create a named key',
  'Connect and verify',
];
type Journey = Settings['onboarding'];
export function OnboardingCanvas() {
  const client = useFerryClient(),
    cache = useQueryClient(),
    navigate = useNavigate();
  const settings = useQuery({ queryKey: keys.settings, queryFn: () => client.settings.get() });
  const [journey, setJourney] = useState<Journey | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [budget, setBudget] = useState('');
  const [folderOpen, setFolderOpen] = useState(false);
  const readiness = useQuery({
    queryKey: ['gateway-routing', 'onboarding'],
    queryFn: () => client.gateway.routing(),
    refetchInterval: 5000,
  });
  useEffect(() => {
    if (!journey && settings.data) {
      setJourney(settings.data.onboarding);
      setBudget(settings.data.onboarding.budgetUsd?.toString() ?? '');
    }
  }, [settings.data, journey]);
  const persist = async (next: Journey) => {
    const saved = await client.settings.update({ onboarding: next });
    setJourney(saved.onboarding);
    cache.setQueryData(keys.settings, saved);
    localStorage.removeItem('ferry.onboardingStep');
    localStorage.removeItem('ferry.onboardingProviders');
  };
  const action = async (work: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await work();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Setup could not save. Try again.');
    } finally {
      setBusy(false);
    }
  };
  const move = async (step: number) => {
    if (!journey) return;
    if (
      journey.step === 2 &&
      step > journey.step &&
      journey.paidBackup &&
      (!Number.isFinite(Number(budget)) || Number(budget) <= 0)
    )
      throw new Error('Paid backup needs a positive monthly spending limit.');
    await persist({
      ...journey,
      step,
      budgetUsd: journey.paidBackup
        ? Number.isFinite(Number(budget)) && Number(budget) > 0
          ? Number(budget)
          : journey.budgetUsd
        : null,
    });
  };
  const createKey = async () => {
    if (!journey) return;
    const saved = await client.gateway.listKeys();
    const existing = saved.find(
      (key) => !key.revokedAt && (key.id === journey.keyId || key.name === journey.keyName),
    );
    const currentSettings = await client.settings.get();
    const active = (await client.profiles.list()).find(
      (profile) => profile.id === currentSettings.activeProfileId,
    );
    const keyProfile =
      active?.provenance?.kind === 'provider-check' && !journey.paidBackup
        ? active.id
        : 'auto-free';
    const created =
      existing ??
      (await client.gateway.createKey({ name: journey.keyName, profile: keyProfile })).key;
    await client.gateway.updateKey({
      id: created.id,
      patch: {
        client: journey.clientId ?? 'opencode',
        paidBackup: journey.paidBackup,
        budgetUsd: journey.paidBackup ? journey.budgetUsd : null,
      },
    });
    await persist({
      ...journey,
      keyId: created.id,
      step: 5,
      verifiedRequestId: existing?.id === journey.keyId ? journey.verifiedRequestId : null,
    });
    await cache.invalidateQueries({ queryKey: ['gateway-keys'] });
  };
  const finish = async () => {
    if (!journey?.keyId || !journey.verifiedRequestId)
      throw new Error('Send a successful verification request before finishing.');
    await client.gateway.updateKey({
      id: journey.keyId,
      patch: {
        paidBackup: journey.paidBackup,
        budgetUsd: journey.paidBackup ? journey.budgetUsd : null,
      },
    });
    const profiles = await client.profiles.list();
    const active = (await client.settings.get()).activeProfileId;
    const auto = profiles.find((profile) => profile.builtin && profile.name === 'Auto-Free');
    await client.settings.update({
      onboardingComplete: true,
      onboarding: journey,
      ...(profiles.some(
        (profile) => profile.id === active && profile.provenance?.kind === 'provider-check',
      )
        ? { activeProfileId: active }
        : auto
          ? { activeProfileId: auto.id }
          : {}),
    });
    await cache.invalidateQueries({ queryKey: keys.settings });
    await navigate({ to: '/' });
  };
  const openFolder = async () => {
    if (!window.ferryHost) {
      setFolderOpen(true);
      return;
    }
    const path = await window.ferryHost.openFolder();
    if (path) {
      await client.workspaces.open(path);
      await cache.invalidateQueries({ queryKey: keys.workspaces });
    }
  };
  if (settings.isError)
    return (
      <section className="onboarding-page">
        <p role="alert">
          Could not load saved setup.{' '}
          <UiV2.Button onClick={() => void settings.refetch()}>Retry</UiV2.Button>
        </p>
      </section>
    );
  if (!journey)
    return (
      <section className="onboarding-page">
        <SkeletonRows rows={5} />
      </section>
    );
  const connected = (readiness.data?.eligible.length ?? 0) > 0;
  return (
    <section className="onboarding-page page-scroll-canvas" aria-label="Ferry setup">
      <div className="onboarding-card">
        <div className="onboarding-top">
          <div className="onboarding-brand">
            <FerryMark variant="icon" size={30} />
            <span>Ferry</span>
          </div>
          <UiV2.Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() =>
              void action(async () => {
                await persist(journey);
                await navigate({ to: '/gateway' });
              })
            }
          >
            Set up later
          </UiV2.Button>
        </div>
        <div className="onboarding-content">
          <p className="v2-gateway-help">Step {journey.step + 1} of 6</p>
          <h1>{titles[journey.step]}</h1>
          {journey.step === 0 && (
            <div className="grid gap-4">
              <p>
                Connect providers, use Auto, and make your first verified request. Your progress
                stays on this device.
              </p>
              <Select
                label="Use Ferry for"
                value={journey.use}
                options={[
                  { value: 'external', label: 'External apps' },
                  { value: 'agent', label: 'Ferry agent' },
                  { value: 'both', label: 'Both' },
                ]}
                onValueChange={(use) => {
                  setJourney({ ...journey, use: use as Journey['use'] });
                }}
              />
              <p className="v2-gateway-help">
                No account signup or project folder is required. Local storage is active; Cloud
                setup is coming soon.
              </p>
            </div>
          )}
          {journey.step === 1 && (
            <div className="grid gap-4">
              <p>
                Add an API key, sign in to an account, or use a local server with the same
                connection manager as Models.
              </p>
              <ProviderConnections />
            </div>
          )}
          {journey.step === 2 && (
            <div className="grid gap-4">
              <p>
                Auto chooses one suitable model per request, balancing reliability, quota and
                response time. Free first; paid backup only with your authorization and a spending
                limit.
              </p>
              <div className="setting-row">
                <div>
                  <strong>Optional paid backup</strong>
                  <small>
                    A paid-capable verification request needs a separate test cost ceiling.
                  </small>
                </div>
                <UiV2.Switch
                  aria-label="Enable paid backup"
                  checked={journey.paidBackup}
                  onCheckedChange={(paidBackup) => {
                    setJourney({ ...journey, paidBackup });
                  }}
                />
              </div>
              {journey.paidBackup && (
                <label className="v2-gateway-field">
                  <span>Monthly spending limit (USD)</span>
                  <UiV2.Input
                    inputMode="decimal"
                    value={budget}
                    onChange={(event) => {
                      setBudget(event.target.value);
                    }}
                    placeholder="5.00"
                  />
                </label>
              )}
              <p className="v2-gateway-help">
                API requests preserve prompts and tools by default. Ferry’s own free agent profiles
                keep Caveman Lite input and Lite replies. Planner/editor splitting stays in
                Advanced.
              </p>
            </div>
          )}
          {journey.step === 3 && (
            <div className="grid gap-4">
              <Select
                label="Request type"
                value={journey.clientId ?? 'opencode'}
                options={[
                  { value: 'opencode', label: 'OpenCode' },
                  { value: 'openai', label: 'Generic OpenAI chat' },
                  { value: 'codex', label: 'Codex Responses' },
                  { value: 'claude-code', label: 'Claude Messages' },
                ]}
                onValueChange={(value) => {
                  setJourney({ ...journey, clientId: value as NonNullable<Journey['clientId']> });
                }}
              />
              <p role="status">
                {readiness.isPending
                  ? 'Checking eligible routes…'
                  : readiness.isError
                    ? 'Readiness could not load. Retry the check.'
                    : connected
                      ? `${String(readiness.data.eligible.length)} eligible tool-capable routes. The final test verifies ${journey.clientId ?? 'opencode'} through your created key.`
                      : journey.paidBackup
                        ? 'No free route yet. Your paid backup policy needs separate approval of a test cost ceiling before the final request.'
                        : 'No eligible free route yet. Go back and connect a provider.'}
              </p>
              <UiV2.Button variant="secondary" onClick={() => void readiness.refetch()}>
                Refresh readiness
              </UiV2.Button>
              <ProviderReadiness />
            </div>
          )}
          {journey.step === 4 && (
            <div className="grid gap-4">
              <p>
                Use one key per client. Ferry stores its secret in your operating system keyring;
                resuming reuses the named key.
              </p>
              <label className="v2-gateway-field">
                <span>Key name</span>
                <UiV2.Input
                  value={journey.keyName}
                  maxLength={80}
                  onChange={(event) => {
                    setJourney({ ...journey, keyName: event.target.value });
                  }}
                />
              </label>
              <p className="v2-gateway-help">
                The key starts with Auto and your chosen spending policy. You can set restrictions,
                token caps and concurrency from Gateway → Keys.
              </p>
            </div>
          )}
          {journey.step === 5 && (
            <div className="grid gap-4">
              {journey.keyId ? (
                <GatewayConnect
                  keyId={journey.keyId}
                  initialClient={journey.clientId ?? 'opencode'}
                  onClientChange={(value) =>
                    void action(() =>
                      persist({
                        ...journey,
                        clientId: value as NonNullable<Journey['clientId']>,
                        verifiedRequestId: null,
                      }),
                    )
                  }
                  onVerified={(result) => {
                    if (result.requestId)
                      void action(() =>
                        persist({ ...journey, verifiedRequestId: result.requestId }),
                      );
                  }}
                />
              ) : (
                <p>Go back to create your key.</p>
              )}
              {journey.verifiedRequestId && (
                <>
                  <p role="status">Your first request is verified. You can finish setup.</p>
                  {journey.use !== 'external' && (
                    <UiV2.Button variant="secondary" onClick={() => void action(openFolder)}>
                      Open a folder (optional)
                    </UiV2.Button>
                  )}
                </>
              )}
            </div>
          )}
          {error && (
            <p role="alert" className="v2-gateway-error">
              {error}
            </p>
          )}
          <div className="onboarding-actions">
            {journey.step > 0 && (
              <UiV2.Button
                variant="ghost"
                disabled={busy}
                onClick={() => void action(() => move(journey.step - 1))}
              >
                Back
              </UiV2.Button>
            )}
            {journey.step < 4 ? (
              <UiV2.Button
                disabled={busy || (journey.step === 3 && !connected && !journey.paidBackup)}
                onClick={() => void action(() => move(journey.step + 1))}
              >
                Continue
              </UiV2.Button>
            ) : journey.step === 4 ? (
              <UiV2.Button
                disabled={busy || !journey.keyName.trim()}
                onClick={() => void action(createKey)}
              >
                {journey.keyId ? 'Reuse key and continue' : 'Create key and continue'}
              </UiV2.Button>
            ) : (
              journey.verifiedRequestId && (
                <UiV2.Button disabled={busy} onClick={() => void action(finish)}>
                  Finish setup
                </UiV2.Button>
              )
            )}
          </div>
        </div>
        <footer className="onboarding-footer">
          Local setup. Provider credentials stay in your operating system keyring.
        </footer>
      </div>
      <TextPromptDialog
        open={folderOpen}
        onOpenChange={setFolderOpen}
        title="Open a project folder"
        description="A project is optional. Enter the full path if you want Ferry to work in one."
        label="Folder path"
        placeholder="C:/Projects/my-app"
        onSubmit={(path) => {
          setFolderOpen(false);
          void action(async () => {
            await client.workspaces.open(path);
            await cache.invalidateQueries({ queryKey: keys.workspaces });
          });
        }}
      />
    </section>
  );
}
