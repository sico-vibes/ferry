import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { GatewayRequestRecord } from '@ferry/shared';
import { Check, Copy, KeyRound, Plus, SlidersHorizontal, Trash2 } from 'lucide-react';
import { FerryMark, PageHeader, ProviderLogo, Select, UiV2 } from '@ferry/ui';
import { useFerryClient } from '../../data/client';
import { useProfiles } from '../../data/queries';
import { useToasts } from '../../state/toasts';
import { useUI } from '../../state/ui';
import { ConfirmDialog } from '../ConfirmDialog';
import { formatTokens } from '../modelFacts';
import { gatewaySnippets } from './snippets';

type GatewayKeyRow = Awaited<
  ReturnType<ReturnType<typeof useFerryClient>['gateway']['listKeys']>
>[number];

const count = new Intl.NumberFormat('en');
const builtinProfiles = [
  { value: 'auto-free', label: 'Auto-Free' },
  { value: 'best', label: 'Best Available' },
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

function KeyLimitsDialog({
  gatewayKey,
  profiles,
  onClose,
}: {
  gatewayKey: GatewayKeyRow | null;
  profiles: { value: string; label: string }[];
  onClose: () => void;
}) {
  const client = useFerryClient();
  const cache = useQueryClient();
  const [draft, setDraft] = useState({
    profile: 'auto-free',
    allowedModels: '',
    rateLimit: '',
    tokenLimitPerMinute: '',
    tokenLimitPerDay: '',
    concurrencyLimit: '',
    compressToolResults: true,
    terseSystemPrompt: false,
  });
  const [error, setError] = useState('');
  useEffect(() => {
    if (!gatewayKey) return;
    const text = (value: number | null) => (value === null ? '' : String(value));
    setDraft({
      profile: gatewayKey.profile,
      allowedModels: gatewayKey.allowedModels.join(', '),
      rateLimit: text(gatewayKey.rateLimit),
      tokenLimitPerMinute: text(gatewayKey.tokenLimitPerMinute),
      tokenLimitPerDay: text(gatewayKey.tokenLimitPerDay),
      concurrencyLimit: text(gatewayKey.concurrencyLimit),
      compressToolResults: gatewayKey.compressToolResults,
      terseSystemPrompt: gatewayKey.terseSystemPrompt,
    });
    setError('');
  }, [gatewayKey]);
  const limit = (
    field: 'rateLimit' | 'tokenLimitPerMinute' | 'tokenLimitPerDay' | 'concurrencyLimit',
    label: string,
  ) => (
    <label className="v2-gateway-field">
      <span>{label}</span>
      <UiV2.Input
        inputMode="numeric"
        onChange={(event) => {
          setDraft((current) => ({ ...current, [field]: event.target.value }));
        }}
        placeholder="Unlimited"
        value={draft[field]}
      />
    </label>
  );
  const save = async () => {
    if (!gatewayKey) return;
    const numberOrNull = (value: string) => (value.trim() ? Number(value) : null);
    const limits = {
      rateLimit: numberOrNull(draft.rateLimit),
      tokenLimitPerMinute: numberOrNull(draft.tokenLimitPerMinute),
      tokenLimitPerDay: numberOrNull(draft.tokenLimitPerDay),
      concurrencyLimit: numberOrNull(draft.concurrencyLimit),
    };
    if (
      Object.values(limits).some(
        (value) => value !== null && (!Number.isInteger(value) || value < 1),
      )
    ) {
      setError('Limits must be whole numbers of at least 1, or empty for unlimited.');
      return;
    }
    await client.gateway.updateKey({
      id: gatewayKey.id,
      patch: {
        ...limits,
        profile: draft.profile,
        allowedModels: draft.allowedModels
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean),
        compressToolResults: draft.compressToolResults,
        terseSystemPrompt: draft.terseSystemPrompt,
      },
    });
    await cache.invalidateQueries({ queryKey: ['gateway-keys'] });
    onClose();
  };
  return (
    <UiV2.Dialog
      open={gatewayKey !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <UiV2.DialogContent className="v2-gateway-dialog">
        <UiV2.DialogHeader>
          <UiV2.DialogTitle>{gatewayKey?.name} settings</UiV2.DialogTitle>
          <UiV2.DialogDescription>
            Routing and limits for requests made with this key.
          </UiV2.DialogDescription>
        </UiV2.DialogHeader>
        <div className="v2-gateway-form">
          <Select
            label="Routing profile"
            onValueChange={(profile) => {
              setDraft((current) => ({ ...current, profile }));
            }}
            options={profiles}
            value={draft.profile}
          />
          <label className="v2-gateway-field">
            <span>Allowed models</span>
            <UiV2.Input
              onChange={(event) => {
                setDraft((current) => ({ ...current, allowedModels: event.target.value }));
              }}
              placeholder="All enabled models"
              value={draft.allowedModels}
            />
          </label>
          <div className="v2-gateway-form-grid">
            {limit('rateLimit', 'Requests per minute')}
            {limit('concurrencyLimit', 'Concurrent requests')}
            {limit('tokenLimitPerMinute', 'Tokens per minute')}
            {limit('tokenLimitPerDay', 'Tokens per day')}
          </div>
          <label className="v2-gateway-toggle">
            <span>
              <strong>Compress tool results</strong>
              <small>Shorten long tool output before it reaches the model.</small>
            </span>
            <UiV2.Switch
              aria-label="Compress tool results"
              checked={draft.compressToolResults}
              onCheckedChange={(compressToolResults) => {
                setDraft((current) => ({ ...current, compressToolResults }));
              }}
            />
          </label>
          <label className="v2-gateway-toggle">
            <span>
              <strong>Terse system prompt</strong>
              <small>Ask the model for shorter answers to save tokens.</small>
            </span>
            <UiV2.Switch
              aria-label="Terse system prompt"
              checked={draft.terseSystemPrompt}
              onCheckedChange={(terseSystemPrompt) => {
                setDraft((current) => ({ ...current, terseSystemPrompt }));
              }}
            />
          </label>
          {error && (
            <p className="v2-gateway-error" role="alert">
              {error}
            </p>
          )}
        </div>
        <div className="v2-gateway-dialog-actions">
          <UiV2.Button onClick={onClose} variant="secondary">
            Cancel
          </UiV2.Button>
          <UiV2.Button onClick={() => void save()}>Save key settings</UiV2.Button>
        </div>
      </UiV2.DialogContent>
    </UiV2.Dialog>
  );
}

function RequestLog({
  requests,
  keyNames,
  now,
}: {
  requests: GatewayRequestRecord[];
  keyNames: string[];
  now: number;
}) {
  const [keyFilter, setKeyFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState<'all' | 'ok' | 'error'>('all');
  const rows = requests.filter(
    (row) =>
      (keyFilter === 'all' || row.keyName === keyFilter) &&
      (statusFilter === 'all' || row.status === statusFilter),
  );
  return (
    <section aria-label="Live requests" className="v2-gateway-card v2-gateway-log">
      <header className="v2-gateway-card-header">
        <div>
          <h2>
            <span aria-hidden="true" className="v2-live-dot" />
            Live requests
          </h2>
          <p>Every request routed through Ferry. Metadata only; prompts are never stored.</p>
        </div>
        <div className="v2-gateway-filters">
          <Select
            label="Filter by key"
            onValueChange={setKeyFilter}
            options={[
              { value: 'all', label: 'All keys' },
              ...keyNames.map((name) => ({ value: name, label: name })),
            ]}
            value={keyFilter}
          />
          <Select
            label="Filter by status"
            onValueChange={(value) => {
              setStatusFilter(value as typeof statusFilter);
            }}
            options={[
              { value: 'all', label: 'All statuses' },
              { value: 'ok', label: 'Succeeded' },
              { value: 'error', label: 'Failed' },
            ]}
            value={statusFilter}
          />
        </div>
      </header>
      {rows.length === 0 ? (
        <p className="v2-gateway-empty">
          {requests.length === 0
            ? 'No requests yet. Point a tool at the endpoint above and they will appear here live.'
            : 'No requests match these filters.'}
        </p>
      ) : (
        <div className="v2-gateway-table-scroll">
          <table className="v2-gateway-table">
            <thead>
              <tr>
                <th scope="col">Time</th>
                <th scope="col">Key</th>
                <th scope="col">Model</th>
                <th scope="col">Status</th>
                <th className="v2-num" scope="col">
                  Tokens
                </th>
                <th className="v2-num" scope="col">
                  Latency
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 50).map((row) => (
                <tr key={row.id}>
                  <td className="v2-muted" title={new Date(row.at).toLocaleString()}>
                    {relativeTime(row.at, now)}
                  </td>
                  <td>{row.keyName}</td>
                  <td>
                    <span className="v2-gateway-model">
                      {row.modelRef ? (
                        <ProviderLogo
                          model={row.modelRef}
                          name={row.modelRef}
                          {...(row.providerId ? { providerId: row.providerId } : {})}
                          size={14}
                        />
                      ) : (
                        <FerryMark decorative size={14} variant="mono" />
                      )}
                      <span className="v2-gateway-model-name">
                        {row.modelRef ?? row.requestedModel}
                      </span>
                      {row.modelRef && row.requestedModel.startsWith('ferry/') && (
                        <span className="v2-gateway-via">via {row.requestedModel}</span>
                      )}
                    </span>
                  </td>
                  <td>
                    <span
                      className="v2-status-pill"
                      data-tone={row.status === 'ok' ? 'success' : 'destructive'}
                      title={row.error ?? undefined}
                    >
                      {row.status === 'ok' ? 'OK' : 'Failed'}
                    </span>
                  </td>
                  <td className="v2-num">
                    {row.status === 'ok'
                      ? `${formatTokens(row.inputTokens)} / ${formatTokens(row.outputTokens)}`
                      : '—'}
                  </td>
                  <td className="v2-num v2-muted">
                    {row.latencyMs >= 1000
                      ? `${(row.latencyMs / 1000).toFixed(1)}s`
                      : `${String(row.latencyMs)}ms`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** Gateway dashboard: endpoint, setup, keys and the live request log (reference 11). */
export function GatewayCanvas() {
  const client = useFerryClient();
  const cache = useQueryClient();
  const pushToast = useToasts((state) => state.push);
  const { data: profileList = [] } = useProfiles();
  const { data: gateway } = useQuery({
    queryKey: ['gateway-settings'],
    queryFn: () => client.gateway.settings(),
  });
  const { data: keys = [] } = useQuery({
    queryKey: ['gateway-keys'],
    queryFn: () => client.gateway.listKeys(),
  });
  const { data: initialRequests = [] } = useQuery({
    queryKey: ['gateway-requests'],
    queryFn: () => client.gateway.requests(),
  });
  const [requests, setRequests] = useState<GatewayRequestRecord[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const [snippetId, setSnippetId] = useState('opencode');
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [newProfile, setNewProfile] = useState('auto-free');
  const [secret, setSecret] = useState('');
  const [editing, setEditing] = useState<GatewayKeyRow | null>(null);
  const [revoking, setRevoking] = useState<GatewayKeyRow | null>(null);
  useEffect(() => {
    setRequests(initialRequests);
  }, [initialRequests]);
  useEffect(
    () =>
      client.on('gateway.request', (record) => {
        setRequests((current) =>
          [record, ...current.filter((row) => row.id !== record.id)].slice(0, 200),
        );
        void cache.invalidateQueries({ queryKey: ['gateway-keys'] });
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
  const snippets = gatewaySnippets(baseUrl);
  const snippet = snippets.find((item) => item.id === snippetId) ?? snippets[0];
  const activeKeys = keys.filter((key) => !key.revokedAt);
  const totals = keys.reduce(
    (sum, key) => ({
      requests: sum.requests + key.usage.requests,
      successful: sum.successful + key.usage.successfulRequests,
      tokens: sum.tokens + key.usage.inputTokens + key.usage.outputTokens,
    }),
    { requests: 0, successful: 0, tokens: 0 },
  );
  const setEnabled = async (enabled: boolean) => {
    if (!gateway) return;
    try {
      await client.gateway.setSettings({ enabled, port: gateway.port, allowLan: gateway.allowLan });
      await cache.invalidateQueries({ queryKey: ['gateway-settings'] });
    } catch (error) {
      pushToast({
        kind: 'error',
        title: enabled ? 'Gateway could not start' : 'Gateway could not stop',
        body: error instanceof Error ? error.message : String(error),
      });
    }
  };
  const createKey = async () => {
    const name = newName.trim();
    if (!name) return;
    const created = await client.gateway.createKey({ name, profile: newProfile });
    setCreateOpen(false);
    setNewName('');
    setSecret(created.secret);
    await cache.invalidateQueries({ queryKey: ['gateway-keys'] });
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
                {running ? `Running on port ${String(port)}` : 'Stopped'}
              </span>
              <UiV2.Switch
                aria-label="Enable Gateway"
                checked={gateway?.enabled ?? false}
                disabled={!gateway}
                onCheckedChange={(enabled) => void setEnabled(enabled)}
              />
            </div>
          }
        />
        <div className="v2-gateway-stats">
          {[
            ['Requests', count.format(totals.requests), 'All keys, all time'],
            [
              'Success rate',
              totals.requests
                ? `${String(Math.round((totals.successful / totals.requests) * 100))}%`
                : '—',
              `${count.format(totals.successful)} succeeded`,
            ],
            ['Tokens', formatTokens(totals.tokens), 'Input and output'],
            [
              'Active keys',
              String(activeKeys.length),
              `${String(keys.length - activeKeys.length)} revoked`,
            ],
          ].map(([label, value, hint]) => (
            <div className="v2-gateway-stat" key={label}>
              <span>{label}</span>
              <strong>{value}</strong>
              <small>{hint}</small>
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
            <EndpointRow
              hint="OpenAI-compatible tools"
              label="OpenAI base URL"
              value={`${baseUrl}/v1`}
            />
            <EndpointRow hint="Claude Code" label="Anthropic base URL" value={baseUrl} />
            <div className="v2-gateway-models">
              <span>Models</span>
              {['ferry/auto-free', 'ferry/best', 'ferry/fast', 'ferry/long-context'].map((id) => (
                <code key={id}>{id}</code>
              ))}
            </div>
          </section>
          <section aria-label="Connect a tool" className="v2-gateway-card">
            <header className="v2-gateway-card-header">
              <div>
                <h2>Connect a tool</h2>
                <p>{snippet?.where}</p>
              </div>
            </header>
            <div aria-label="Tools" className="v2-gateway-tool-tabs" role="tablist">
              {snippets.map((item) => (
                <button
                  aria-selected={item.id === snippetId}
                  key={item.id}
                  onClick={() => {
                    setSnippetId(item.id);
                  }}
                  role="tab"
                  type="button"
                >
                  {item.label}
                </button>
              ))}
            </div>
            {snippet && (
              <div className="v2-gateway-code" role="tabpanel">
                <pre>
                  <code>{snippet.code}</code>
                </pre>
                <CopyButton label={`Copy ${snippet.label} setup`} value={snippet.code} />
              </div>
            )}
          </section>
        </div>
        <section aria-label="Keys" className="v2-gateway-card">
          <header className="v2-gateway-card-header">
            <div>
              <h2>Keys</h2>
              <p>One key per tool or device. Free tiers are per person, so do not share keys.</p>
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
          {keys.length === 0 ? (
            <p className="v2-gateway-empty">
              No keys yet. Create one, then paste it into your tool's API key field.
            </p>
          ) : (
            <div className="v2-gateway-table-scroll">
              <table className="v2-gateway-table">
                <thead>
                  <tr>
                    <th scope="col">Name</th>
                    <th scope="col">Profile</th>
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
                      <td className="v2-muted">{profileLabel(key.profile)}</td>
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
        <RequestLog keyNames={keys.map((key) => key.name)} now={now} requests={requests} />
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
            <UiV2.Button disabled={!newName.trim()} onClick={() => void createKey()}>
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
              Ferry shows this key once and keeps only its hash.
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
