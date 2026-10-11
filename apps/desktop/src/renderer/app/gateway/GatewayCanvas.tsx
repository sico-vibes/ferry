import { SkeletonRows, SkeletonTable, SkeletonStat } from '@ferry/ui';
import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { GatewayRequestRecord } from '@ferry/shared';
import { Check, Copy, KeyRound, Plus, SlidersHorizontal, Trash2 } from 'lucide-react';
import { PageHeader, Select, UiV2 } from '@ferry/ui';
import { useFerryClient } from '../../data/client';
import { useProfiles } from '../../data/queries';
import { useToasts } from '../../state/toasts';
import { useUI } from '../../state/ui';
import { ConfirmDialog } from '../ConfirmDialog';
import { formatTokens } from '../modelFacts';
import { KeyLimitsDialog } from './KeyLimitsDialog';
import { GatewayRequests } from './GatewayRequests';
import { GatewayRouting, GatewayUsage } from './GatewayRoutingUsage';
import { GatewayConnect } from './GatewayConnect';
import { NO_PROFILE } from './modelSelection';

type GatewayKeyRow = Awaited<
  ReturnType<ReturnType<typeof useFerryClient>['gateway']['listKeys']>
>[number];

const count = new Intl.NumberFormat('en');
const builtinProfiles = [
  { value: 'auto-free', label: 'Auto — recommended' },
  { value: 'none', label: 'Choose a model' },
  { value: 'best', label: 'Best quality' },
  { value: 'fast', label: 'Fast' },
  { value: 'long-context', label: 'Long Context' },
];

function relativeTime(iso: string | null, now: number): string {
  if (!iso) return 'Never';
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (seconds < 60) return `${String(seconds)}s ago`;
  if (seconds < 3600) return `${String(Math.floor(seconds / 60))}m ago`;
  if (seconds < 86_400) return `${String(Math.floor(seconds / 3600))}h ago`;
  return `${String(Math.floor(seconds / 86_400))}d ago`;
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <UiV2.Button
      aria-label={copied ? 'Copied' : label}
      onClick={() => {
        void navigator.clipboard.writeText(value).then(() => {
          setCopied(true);
          window.setTimeout(() => {
            setCopied(false);
          }, 1500);
        });
      }}
      size="icon"
      variant="ghost"
    >
      {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
    </UiV2.Button>
  );
}

function EndpointRow({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="v2-gateway-endpoint">
      <div>
        <span className="v2-gateway-endpoint-label">{label}</span>
        <span className="v2-gateway-endpoint-hint">{hint}</span>
      </div>
      <code>{value}</code>
      <CopyButton label={`Copy ${label}`} value={value} />
    </div>
  );
}

/** Gateway dashboard: endpoint, setup, keys and the live request log (reference 11). */
export function GatewayCanvas() {
  const client = useFerryClient();
  const cache = useQueryClient();
  const pushToast = useToasts((state) => state.push);
  const { data: profileList = [] } = useProfiles();
  const { data: connectedProviders = [] } = useQuery({
    queryKey: ['providers'],
    queryFn: () => client.providers.list(),
  });
  const { data: gateway } = useQuery({
    queryKey: ['gateway-settings'],
    queryFn: () => client.gateway.settings(),
  });
  const { data: keys = [], isPending: keysPending } = useQuery({
    queryKey: ['gateway-keys'],
    queryFn: () => client.gateway.listKeys(),
  });
  const { data: initialRequests } = useQuery({
    queryKey: ['gateway-requests'],
    queryFn: () => client.gateway.requests(),
  });
  const [requests, setRequests] = useState<GatewayRequestRecord[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const [tab, setTab] = useState('Overview');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [rotating, setRotating] = useState<GatewayKeyRow | null>(null);
  const { data: activity } = useQuery({
    queryKey: ['gateway-activity'],
    queryFn: () => client.gateway.activity(),
    refetchInterval: 2000,
  });
  const { data: routing } = useQuery({
    queryKey: ['gateway-routing', 'default'],
    queryFn: () => client.gateway.routing(),
    refetchInterval: 5000,
  });
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [newProfile, setNewProfile] = useState('auto-free');
  const [secret, setSecret] = useState('');
  const [editing, setEditing] = useState<GatewayKeyRow | null>(null);
  const [revoking, setRevoking] = useState<GatewayKeyRow | null>(null);
  useEffect(() => {
    if (initialRequests) setRequests(initialRequests);
  }, [initialRequests]);
  useEffect(
    () =>
      client.on('gateway.request', (record) => {
        setRequests((current) =>
          [record, ...current.filter((row) => row.id !== record.id)].slice(0, 200),
        );
        void cache.invalidateQueries({ queryKey: ['gateway-keys'] });
        void cache.invalidateQueries({ queryKey: ['gateway-routing'] });
        void cache.invalidateQueries({ queryKey: ['gateway-history'] });
        void cache.invalidateQueries({ queryKey: ['gateway-usage'] });
      }),
    [cache, client],
  );
  useEffect(() => {
    const timer = window.setInterval(() => {
      setNow(Date.now());
    }, 15_000);
    return () => {
      window.clearInterval(timer);
    };
  }, []);
  const profiles = useMemo(
    () => [
      ...builtinProfiles,
      ...profileList
        .filter((profile) => !profile.builtin)
        .map((profile) => ({ value: profile.id, label: profile.name })),
    ],
    [profileList],
  );
  const profileLabel = (value: string) =>
    profiles.find((profile) => profile.value === value)?.label ?? value;
  const running = gateway?.status.running ?? false;
  const port = gateway?.status.port ?? gateway?.port ?? 11435;
  const baseUrl = gateway?.status.url ?? `http://127.0.0.1:${String(port)}`;
  const activeKeys = keys.filter((key) => !key.revokedAt);
  const setEnabled = async (enabled: boolean) => {
    if (!gateway || busy) return;
    setBusy(true);
    try {
      await client.gateway.setSettings({ enabled, port: gateway.port, allowLan: gateway.allowLan });
      await cache.invalidateQueries({ queryKey: ['gateway-settings'] });
    } catch (error) {
      pushToast({
        kind: 'error',
        title: enabled ? 'Gateway could not start' : 'Gateway could not stop',
        body: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(false);
    }
  };
  const createKey = async () => {
    const name = newName.trim();
    if (!name || busy) return;
    setBusy(true);
    setError('');
    try {
      const created = await client.gateway.createKey({ name, profile: newProfile });
      setCreateOpen(false);
      setNewName('');
      setSecret(created.secret);
      await cache.invalidateQueries({ queryKey: ['gateway-keys'] });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not create key.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-label="Gateway" className="v2-gateway-page">
      <div className="v2-gateway-inner">
        <PageHeader
          title="Gateway"
          subtitle="Use your Ferry providers from any OpenAI- or Anthropic-compatible coding tool."
          primaryAction={
            <div className="v2-gateway-header-actions">
              <span className="v2-status-pill" data-tone={running ? 'success' : 'muted'}>
                {!gateway ? (
                  <SkeletonStat />
                ) : running ? (
                  `Running on port ${String(port)}`
                ) : (
                  'Stopped'
                )}
              </span>
              <UiV2.Switch
                aria-label="Enable Gateway"
                checked={running}
                disabled={!gateway || busy}
                onCheckedChange={(enabled) => void setEnabled(enabled)}
              />
            </div>
          }
        />
        {error && (
          <p role="alert" className="v2-gateway-error">
            {error}
          </p>
        )}
        <UiV2.Tabs value={tab} onValueChange={setTab}>
          <UiV2.TabsList className="v2-gateway-tab-list" aria-label="Gateway sections">
            {['Overview', 'Requests', 'Routing', 'Keys', 'Usage & costs', 'Connect'].map(
              (label) => (
                <UiV2.TabsTrigger
                  key={label}
                  value={label === 'Usage & costs' ? 'usage-costs' : label}
                >
                  {label}
                </UiV2.TabsTrigger>
              ),
            )}
          </UiV2.TabsList>
          <UiV2.TabsContent value="Overview" className="grid gap-4 pt-4">
            <div className="v2-gateway-stats">
              {[
                [
                  'Live requests',
                  activity ? String(activity.active) : 'Unavailable',
                  'Actual server state',
                ],
                [
                  'Connected providers',
                  String(
                    connectedProviders.filter(
                      (provider) =>
                        provider.enabled &&
                        ['valid', 'not_applicable'].includes(provider.keyStatus),
                    ).length,
                  ),
                  'Enabled connections',
                ],
                [
                  'Waiting',
                  activity ? String(activity.queued) : 'Unavailable',
                  'Bounded fair queue',
                ],
                [
                  'Active keys',
                  String(activeKeys.length),
                  `${String(keys.length - activeKeys.length)} revoked`,
                ],
              ].map(([label, value, hint]) => (
                <div className="v2-gateway-stat" key={label}>
                  <span>{label}</span>
                  <strong>{keysPending ? <SkeletonStat /> : value}</strong>
                  <small>{keysPending ? <span aria-hidden="true">—</span> : hint}</small>
                </div>
              ))}
            </div>
            <div className="v2-gateway-grid">
              <section aria-label="Endpoint" className="v2-gateway-card">
                <header className="v2-gateway-card-header">
                  <div>
                    <h2>Endpoint</h2>
                    <p>
                      {gateway?.allowLan
                        ? 'Reachable from devices on your local network.'
                        : 'Only this computer can connect.'}{' '}
                      <button
                        className="v2-link-button"
                        onClick={() => {
                          useUI.getState().openSettings('Gateway');
                        }}
                        type="button"
                      >
                        Port and network settings
                      </button>
                    </p>
                  </div>
                </header>
                {!gateway ? (
                  <SkeletonRows rows={3} />
                ) : (
                  <>
                    <EndpointRow
                      hint="OpenAI-compatible tools"
                      label="OpenAI base URL"
                      value={`${baseUrl}/v1`}
                    />
                    <EndpointRow hint="Claude Code" label="Anthropic base URL" value={baseUrl} />
                    <div className="v2-gateway-models">
                      <span>Models</span>
                      {[
                        'ferry/auto',
                        'ferry/auto-free',
                        'ferry/best',
                        'ferry/fast',
                        'ferry/long-context',
                      ].map((id) => (
                        <code key={id}>{id}</code>
                      ))}
                    </div>
                  </>
                )}
              </section>
              <section aria-label="Gateway readiness" className="v2-gateway-card">
                <h2>
                  {running ? (routing?.eligible.length ? 'Ready' : 'Needs setup') : 'Stopped'}
                </h2>
                <p className="v2-gateway-help">
                  {String(routing?.eligible.length ?? 0)} eligible routes. Auto uses one model per
                  request and starts free only. Paid backup needs this key’s positive spending
                  limit.
                </p>
                <UiV2.Button
                  onClick={() => {
                    setTab(activeKeys.length ? 'Connect' : 'Keys');
                  }}
                >
                  {activeKeys.length ? 'Connect a client' : 'Create your first key'}
                </UiV2.Button>
                <p className="v2-gateway-help">
                  {routing?.lastDecision
                    ? `Last request: ${routing.lastDecision.modelRef ?? 'no serving model'}.`
                    : 'No routing decision recorded yet.'}
                </p>
              </section>
            </div>
            <section aria-label="Recent activity" className="grid gap-3">
              <h2>Recent activity</h2>
              {requests.length ? (
                requests.slice(0, 5).map((row) => (
                  <div className="setting-row" key={row.id}>
                    <span>
                      {row.keyName}: {row.modelRef ?? row.requestedModel}
                    </span>
                    <small>
                      {row.outcome ?? row.status} — {relativeTime(row.at, now)}
                    </small>
                  </div>
                ))
              ) : (
                <p className="v2-gateway-help">
                  No recent requests. Connect a client and send a request.
                </p>
              )}
            </section>
          </UiV2.TabsContent>
          <UiV2.TabsContent value="Requests" className="pt-4">
            <GatewayRequests />
          </UiV2.TabsContent>
          <UiV2.TabsContent value="Routing" className="pt-4">
            <GatewayRouting />
          </UiV2.TabsContent>
          <UiV2.TabsContent value="usage-costs" className="pt-4">
            <GatewayUsage />
          </UiV2.TabsContent>
          <UiV2.TabsContent value="Connect" className="pt-4">
            <GatewayConnect
              onCreateKey={() => {
                setTab('Keys');
              }}
            />
          </UiV2.TabsContent>
          <UiV2.TabsContent value="Keys" className="pt-4">
            <section aria-label="Keys" className="v2-gateway-card">
              <header className="v2-gateway-card-header">
                <div>
                  <h2>Keys</h2>
                  <p>
                    One key per tool or device. Free tiers are per person, so do not share keys.
                  </p>
                </div>
                <UiV2.Button
                  onClick={() => {
                    setCreateOpen(true);
                  }}
                  size="sm"
                >
                  <Plus aria-hidden="true" />
                  Create key
                </UiV2.Button>
              </header>
              {keysPending ? (
                <SkeletonTable rows={3} columns={6} />
              ) : keys.length === 0 ? (
                <p className="v2-gateway-empty">
                  No keys yet. Create one, then paste it into your tool's API key field.
                </p>
              ) : (
                <div className="v2-gateway-table-scroll">
                  <table className="v2-gateway-table">
                    <thead>
                      <tr>
                        <th scope="col">Name</th>
                        <th scope="col">Client / preset</th>
                        <th scope="col">Policy / limits</th>
                        <th className="v2-num" scope="col">
                          Requests
                        </th>
                        <th className="v2-num" scope="col">
                          Tokens
                        </th>
                        <th scope="col">Last used</th>
                        <th scope="col">Status</th>
                        <th scope="col">
                          <span className="sr-only">Actions</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {keys.map((key) => (
                        <tr data-revoked={Boolean(key.revokedAt)} key={key.id}>
                          <td>
                            <span className="v2-gateway-key-name">
                              <KeyRound aria-hidden="true" size={14} />
                              {key.name}
                            </span>
                          </td>
                          <td className="v2-muted">
                            {key.profile === NO_PROFILE
                              ? key.allowedModels.length
                                ? `${String(key.allowedModels.length)} picked models`
                                : 'No profile'
                              : profileLabel(key.profile)}
                            <small>{key.client ?? 'Unassigned client'}</small>
                          </td>
                          <td>
                            {key.paidBackup
                              ? `Paid ≤ $${String(key.budgetUsd)}/month`
                              : 'Free only'}
                            {key.paidBackup && (
                              <small>
                                {key.budgetUsedUsd === undefined
                                  ? 'Spend is not available in this preview'
                                  : `$${key.budgetUsedUsd.toFixed(4)} used or reserved this month`}
                              </small>
                            )}
                            <small>
                              {key.allowedModels.length
                                ? `${String(key.allowedModels.length)} models`
                                : 'Preset models'}
                              ;{' '}
                              {key.tokenLimitPerDay
                                ? `${String(key.tokenLimitPerDay)} tokens/day`
                                : 'No daily token cap'}
                              ;{' '}
                              {key.tokenLimitPerMinute
                                ? `${String(key.tokenLimitPerMinute)} tokens/min`
                                : 'No minute token cap'}
                              ;{' '}
                              {key.rateLimit
                                ? `${String(key.rateLimit)} req/min`
                                : 'No request cap'}
                              ; {String(key.concurrencyLimit ?? 4)} concurrent
                            </small>
                          </td>
                          <td className="v2-num">{count.format(key.usage.requests)}</td>
                          <td className="v2-num">
                            {formatTokens(key.usage.inputTokens + key.usage.outputTokens)}
                          </td>
                          <td className="v2-muted">{relativeTime(key.lastUsedAt, now)}</td>
                          <td>
                            <span
                              className="v2-status-pill"
                              data-tone={key.revokedAt ? 'muted' : 'success'}
                            >
                              {key.revokedAt ? 'Revoked' : 'Active'}
                            </span>
                          </td>
                          <td className="v2-gateway-row-actions">
                            {!key.revokedAt && (
                              <>
                                <UiV2.Button
                                  aria-label={`Settings for ${key.name}`}
                                  onClick={() => {
                                    setEditing(key);
                                  }}
                                  size="icon"
                                  variant="ghost"
                                >
                                  <SlidersHorizontal aria-hidden="true" />
                                </UiV2.Button>
                                <UiV2.Button
                                  aria-label={`Rotate ${key.name}`}
                                  size="sm"
                                  variant="ghost"
                                  onClick={() => {
                                    setRotating(key);
                                  }}
                                >
                                  Rotate
                                </UiV2.Button>
                                <UiV2.Button
                                  aria-label={`Revoke ${key.name}`}
                                  onClick={() => {
                                    setRevoking(key);
                                  }}
                                  size="icon"
                                  variant="ghost"
                                >
                                  <Trash2 aria-hidden="true" />
                                </UiV2.Button>
                              </>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </UiV2.TabsContent>
        </UiV2.Tabs>
      </div>
      <UiV2.Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <UiV2.DialogContent className="v2-gateway-dialog">
          <UiV2.DialogHeader>
            <UiV2.DialogTitle>Create a Ferry key</UiV2.DialogTitle>
            <UiV2.DialogDescription>
              Name it after the tool or device that will use it.
            </UiV2.DialogDescription>
          </UiV2.DialogHeader>
          <div className="v2-gateway-form">
            <label className="v2-gateway-field">
              <span>Name</span>
              <UiV2.Input
                autoFocus
                onChange={(event) => {
                  setNewName(event.target.value);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void createKey();
                }}
                placeholder="OpenCode on my laptop"
                value={newName}
              />
            </label>
            <Select
              label="Routing profile"
              onValueChange={setNewProfile}
              options={profiles}
              value={newProfile}
            />
            {newProfile === NO_PROFILE ? (
              <small className="v2-gateway-help">
                Pick the models this key may use from its settings after you create it.
              </small>
            ) : null}
          </div>
          <div className="v2-gateway-dialog-actions">
            <UiV2.Button
              onClick={() => {
                setCreateOpen(false);
              }}
              variant="secondary"
            >
              Cancel
            </UiV2.Button>
            <UiV2.Button disabled={!newName.trim() || busy} onClick={() => void createKey()}>
              Create key
            </UiV2.Button>
          </div>
        </UiV2.DialogContent>
      </UiV2.Dialog>
      <UiV2.Dialog
        open={Boolean(secret)}
        onOpenChange={(open) => {
          if (!open) setSecret('');
        }}
      >
        <UiV2.DialogContent className="v2-gateway-dialog">
          <UiV2.DialogHeader>
            <UiV2.DialogTitle>Copy your key now</UiV2.DialogTitle>
            <UiV2.DialogDescription>
              Ferry stores a verification hash and keeps the key in your operating system keyring
              for client setup.
            </UiV2.DialogDescription>
          </UiV2.DialogHeader>
          <div className="v2-gateway-secret">
            <code>{secret}</code>
            <CopyButton label="Copy key" value={secret} />
          </div>
          <div className="v2-gateway-dialog-actions">
            <UiV2.Button
              onClick={() => {
                setSecret('');
              }}
            >
              Done
            </UiV2.Button>
          </div>
        </UiV2.DialogContent>
      </UiV2.Dialog>
      <ConfirmDialog
        open={!!rotating}
        onOpenChange={(open) => {
          if (!open) setRotating(null);
        }}
        title={`Rotate ${rotating?.name ?? 'key'}?`}
        description="The old secret stops working. Replace this client’s configuration with the new key."
        confirmLabel="Rotate key"
        onConfirm={() => {
          const key = rotating;
          setRotating(null);
          if (key)
            void client.gateway
              .rotateKey(key.id)
              .then((created) => {
                setSecret(created.secret);
              })
              .catch((cause: unknown) => {
                setError(cause instanceof Error ? cause.message : 'Could not rotate key.');
              });
        }}
      />
      <KeyLimitsDialog
        gatewayKey={editing}
        onClose={() => {
          setEditing(null);
        }}
        profiles={profiles}
      />
      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(open) => {
          if (!open) setRevoking(null);
        }}
        title={`Revoke ${revoking?.name ?? 'key'}?`}
        description="Tools using this key stop working immediately. This cannot be undone."
        confirmLabel="Revoke key"
        destructive
        onConfirm={() => {
          const target = revoking;
          setRevoking(null);
          if (target)
            void client.gateway
              .revokeKey(target.id)
              .then(() => cache.invalidateQueries({ queryKey: ['gateway-keys'] }));
        }}
      />
    </section>
  );
}
