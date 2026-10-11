import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  configuredContent,
  openAiConfig,
  type GatewayConnectionTest,
  type SupportedTool,
} from '@ferry/shared';
import { Select, SkeletonRows, UiV2 } from '@ferry/ui';
import { useFerryClient } from '../../data/client';
import { usesRealDomain } from '../../data/realDomains';
import { gatewaySnippets } from './snippets';

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
}
/** Shared setup preview and synthetic verification. The key stays out of browser persistence. */
export function GatewayConnect({
  keyId: fixedKeyId,
  onVerified,
  initialClient,
  onClientChange,
  onCreateKey,
}: {
  keyId?: string;
  onCreateKey?: () => void;
  onVerified?: (result: GatewayConnectionTest) => void;
  initialClient?: string;
  onClientChange?: (client: string) => void;
}) {
  const client = useFerryClient();
  const cache = useQueryClient();
  const {
    data: keys = [],
    isPending,
    isError,
    refetch,
  } = useQuery({
    queryKey: ['gateway-keys'],
    queryFn: () => client.gateway.listKeys(),
  });
  const { data: gateway } = useQuery({
    queryKey: ['gateway-settings'],
    queryFn: () => client.gateway.settings(),
  });
  const [selected, setSelected] = useState('');
  const [tool, setTool] = useState(initialClient ?? 'opencode');
  const [secret, setSecret] = useState('');
  const [existing, setExisting] = useState('');
  const [backupName, setBackupName] = useState('');
  const [busy, setBusy] = useState(false);
  const [paidApproved, setPaidApproved] = useState(false);
  const [testCap, setTestCap] = useState('0.01');
  const [error, setError] = useState('');
  const [result, setResult] = useState<GatewayConnectionTest | null>(null);
  const id = fixedKeyId ?? selected;
  const active = keys.filter((key) => !key.revokedAt);
  useEffect(() => {
    if (!selected && active[0]) setSelected(active[0].id);
  }, [active, selected]);
  useEffect(() => {
    setSecret('');
    setExisting('');
    setBackupName('');
    setResult(null);
    setError('');
    setPaidApproved(false);
  }, [id, tool]);
  const key = keys.find((key) => key.id === id);
  const model = key?.profile === 'none' ? (key.allowedModels[0] ?? 'ferry/auto') : 'ferry/auto';
  const url = gateway?.status.url ?? `http://127.0.0.1:${String(gateway?.port ?? 11435)}`;
  const snippet = gatewaySnippets(url, model).find((snippet) => snippet.id === tool);
  const preview = useMemo(() => {
    if (!secret) return { text: snippet?.code ?? '', error: '' };
    try {
      const connection = { url, model, secret };
      return {
        text: ['opencode', 'codex', 'claude-code'].includes(tool)
          ? configuredContent(
              (tool === 'claude-code' ? 'claude' : tool) as SupportedTool,
              connection,
              existing || undefined,
            )
          : JSON.stringify(openAiConfig(connection), null, 2),
        error: '',
      };
    } catch (cause) {
      return {
        text: '',
        error: cause instanceof Error ? cause.message : 'Invalid existing configuration.',
      };
    }
  }, [secret, snippet?.code, tool, url, model, existing]);
  const run = async () => {
    if (!id || busy) return;
    setBusy(true);
    setError('');
    setResult(null);
    try {
      const result = await client.gateway.testConnection({
        id,
        protocol: tool === 'codex' ? 'responses' : tool === 'claude-code' ? 'anthropic' : 'chat',
        ...(key?.paidBackup && paidApproved ? { approvedCostUsd: Number(testCap) } : {}),
      });
      setResult(result);
      if (result.ok) onVerified?.(result);
      await cache.invalidateQueries({ queryKey: ['gateway-settings'] });
      await cache.invalidateQueries({ queryKey: ['gateway-keys'] });
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Request failed. Check provider readiness.',
      );
    } finally {
      setBusy(false);
    }
  };
  if (isPending) return <SkeletonRows rows={5} />;
  if (isError)
    return (
      <section className="grid gap-4" aria-label="Connect a client">
        <p role="alert">Could not load your keys.</p>
        <UiV2.Button variant="secondary" onClick={() => void refetch()}>
          Retry
        </UiV2.Button>
      </section>
    );
  if (!active.length)
    return (
      <section className="grid gap-4" aria-label="Connect a client">
        <h2>Create a key to connect your client</h2>
        <p className="v2-gateway-help">
          Give each client its own key, then preview its configuration and send a verification
          request.
        </p>
        {onCreateKey ? (
          <UiV2.Button className="justify-self-start" onClick={onCreateKey}>
            Create key
          </UiV2.Button>
        ) : (
          <p>Return to Create a named key to continue setup.</p>
        )}
      </section>
    );
  return (
    <section className="grid gap-4" aria-label="Connect a client">
      {!fixedKeyId && (
        <Select
          label="Setup key"
          value={selected}
          options={active.map((key) => ({ value: key.id, label: key.name }))}
          onValueChange={setSelected}
        />
      )}
      <Select
        label="Client"
        value={tool}
        options={[
          { value: 'opencode', label: 'OpenCode' },
          { value: 'codex', label: 'Codex CLI' },
          { value: 'claude-code', label: 'Claude Code' },
          { value: 'openai', label: 'Generic OpenAI HTTP' },
        ]}
        onValueChange={(value) => {
          setTool(value);
          onClientChange?.(value);
        }}
      />
      <p className="v2-gateway-help">
        {snippet?.where}. Install your chosen client, then merge this configuration. Preserve your
        existing file with a backup before replacing it.
      </p>
      <div className="v2-gateway-code">
        <pre aria-label="Configuration preview" tabIndex={0}>
          <code>{preview.text}</code>
        </pre>
      </div>
      {preview.error && (
        <p role="alert" className="v2-gateway-error">
          {preview.error}
        </p>
      )}
      <div className="button-row">
        <UiV2.Button
          variant="secondary"
          disabled={!id || busy}
          onClick={() => {
            setBusy(true);
            void client.gateway
              .keySecret(id)
              .then(setSecret)
              .catch((cause: unknown) => {
                setError(cause instanceof Error ? cause.message : 'Could not retrieve key.');
              })
              .finally(() => {
                setBusy(false);
              });
          }}
        >
          Include selected key
        </UiV2.Button>
        <UiV2.Button
          variant="secondary"
          disabled={!preview.text}
          onClick={() =>
            void navigator.clipboard.writeText(preview.text).catch(() => {
              setError('Clipboard unavailable. Select and copy the preview.');
            })
          }
        >
          Copy configuration
        </UiV2.Button>
      </div>
      <details>
        <summary>Preview a merge and keep a backup</summary>
        <div className="grid gap-3 pt-3">
          <label className="v2-gateway-field">
            <span>Existing configuration file</span>
            <UiV2.Input
              type="file"
              accept=".json,.toml"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) {
                  setBackupName(file.name);
                  void file
                    .text()
                    .then(setExisting)
                    .catch(() => {
                      setError('Could not read the selected file.');
                    });
                }
              }}
            />
          </label>
          <UiV2.Button
            variant="secondary"
            disabled={!existing || !secret || !!preview.error}
            onClick={() => {
              download(`${backupName}.ferry-backup`, existing);
              download(backupName, preview.text);
            }}
          >
            Download backup and merged configuration
          </UiV2.Button>
        </div>
      </details>
      <p className="v2-gateway-help">
        The test starts the local Gateway and sends one small request through this key, free first.
        It verifies the selected protocol; installed-client certification is a separate check.
      </p>
      {key?.paidBackup && (
        <div className="grid gap-3">
          <label className="flex items-center gap-3">
            <UiV2.Checkbox
              checked={paidApproved}
              onCheckedChange={(checked) => {
                setPaidApproved(checked === true);
              }}
            />
            Approve one paid-capable test under a cost ceiling
          </label>
          <label className="v2-gateway-field">
            <span>Test cost ceiling (USD, up to 1)</span>
            <UiV2.Input
              inputMode="decimal"
              value={testCap}
              onChange={(event) => {
                setTestCap(event.target.value);
              }}
            />
          </label>
          <p className="v2-gateway-help">
            This approval applies only to this verification request. Key, preset and global spending
            limits still apply.
          </p>
        </div>
      )}
      {!usesRealDomain('gateway') && (
        <p className="v2-gateway-help">
          Web preview uses fixture data. Desktop verification calls your real Gateway.
        </p>
      )}
      <UiV2.Button
        className="justify-self-start"
        variant={result?.ok ? 'secondary' : 'default'}
        disabled={
          !id ||
          busy ||
          (!!key?.paidBackup &&
            (!paidApproved ||
              !Number.isFinite(Number(testCap)) ||
              Number(testCap) <= 0 ||
              Number(testCap) > 1))
        }
        onClick={() => void run()}
      >
        {busy ? 'Testing request…' : 'Send verification request'}
      </UiV2.Button>
      {error && (
        <p role="alert" className="v2-gateway-error">
          {error}
        </p>
      )}
      {result && (
        <p role="status">
          {result.message}
          {result.model ? ` Serving model: ${result.model}.` : ''}
        </p>
      )}
    </section>
  );
}
