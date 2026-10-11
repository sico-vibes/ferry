import { useState, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Select, SkeletonTable, UiV2 } from '@ferry/ui';
import type { GatewayHistoryQuery } from '@ferry/shared';
import { useFerryClient } from '../../data/client';
import { formatTokens } from '../modelFacts';
import { costText, durationText, relativeTime } from './gatewayView';

export function GatewayRequests() {
  const client = useFerryClient();
  const [range, setRange] = useState<GatewayHistoryQuery['range']>('24h');
  const [query, setQuery] = useState('');
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const requestTrigger = useRef<HTMLButtonElement | null>(null),
    search = useRef<HTMLInputElement | null>(null);
  const [keyId, setKeyId] = useState('all');
  const [status, setStatus] = useState('all');
  const { data: keys = [] } = useQuery({
    queryKey: ['gateway-keys'],
    queryFn: () => client.gateway.listKeys(),
  });
  const history = useQuery({
    queryKey: ['gateway-history', range, query, offset, keyId, status],
    queryFn: () =>
      client.gateway.history({
        range,
        query,
        offset,
        ...(keyId === 'all' ? {} : { keyId }),
        ...(status === 'all' ? {} : { status: status as 'ok' | 'error' }),
      }),
    refetchInterval: 5000,
  });
  const details = useQuery({
    queryKey: ['gateway-request', selected],
    queryFn: () => (selected ? client.gateway.request(selected) : null),
    enabled: !!selected,
  });
  const record = details.data;
  return (
    <section aria-label="Request history" className="grid gap-4">
      <p className="v2-gateway-help">
        Persistent metadata only. Prompt and response contents are excluded; your retention setting
        applies.
      </p>
      <div className="v2-gateway-filters">
        <UiV2.Input
          ref={search}
          aria-label="Search requests"
          type="search"
          placeholder="Search key, model or request ID"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOffset(0);
          }}
        />
        <Select
          label="History range"
          value={range ?? '24h'}
          options={[
            { value: '24h', label: '24 hours' },
            { value: '7d', label: '7 days' },
            { value: '30d', label: '30 days' },
          ]}
          onValueChange={(value) => {
            setRange(value as typeof range);
            setOffset(0);
          }}
        />
        <Select
          label="Client key"
          value={keyId}
          options={[
            { value: 'all', label: 'All keys' },
            ...keys.map((key) => ({ value: key.id, label: key.name })),
          ]}
          onValueChange={(value) => {
            setKeyId(value);
            setOffset(0);
          }}
        />
        <Select
          label="Request status"
          value={status}
          options={[
            { value: 'all', label: 'All statuses' },
            { value: 'ok', label: 'Completed' },
            { value: 'error', label: 'Stopped or failed' },
          ]}
          onValueChange={(value) => {
            setStatus(value);
            setOffset(0);
          }}
        />
      </div>
      {history.isPending ? (
        <SkeletonTable rows={5} />
      ) : history.isError ? (
        <p role="alert">
          Could not load history.{' '}
          <UiV2.Button variant="secondary" onClick={() => void history.refetch()}>
            Retry
          </UiV2.Button>
        </p>
      ) : !history.data.records.length ? (
        <p className="v2-gateway-empty">
          No matching requests. Connect a client and send a request, or change the filters.
        </p>
      ) : (
        <div className="v2-gateway-table-scroll">
          <table className="v2-gateway-table">
            <thead>
              <tr>
                {[
                  'Time',
                  'Client key',
                  'Provider / model',
                  'Status',
                  'Input / output',
                  'First response',
                  'Duration',
                  'Cost',
                ].map((label) => (
                  <th scope="col" key={label}>
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {history.data.records.map((row) => (
                <tr key={row.id}>
                  <td>{relativeTime(row.at)}</td>
                  <td>
                    <button
                      className="v2-link-button"
                      onClick={(event) => {
                        requestTrigger.current = event.currentTarget;
                        setSelected(row.id);
                      }}
                    >
                      {row.keyName}
                    </button>
                  </td>
                  <td>{row.servedModel ?? row.modelRef ?? row.requestedModel}</td>
                  <td>{row.outcome ?? (row.status === 'ok' ? 'completed' : 'failed')}</td>
                  <td>
                    {row.usageReported === false || row.status === 'error'
                      ? 'Not reported by upstream'
                      : `${formatTokens(row.inputTokens)} / ${formatTokens(row.outputTokens)}`}
                  </td>
                  <td>{durationText(row.firstResponseMs)}</td>
                  <td>{durationText(row.latencyMs)}</td>
                  <td>
                    {costText(row.costUsd)}
                    {row.estimatedCost ? ' est.' : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="button-row">
        <UiV2.Button
          variant="secondary"
          disabled={offset === 0}
          onClick={() => {
            setOffset(Math.max(0, offset - 50));
          }}
        >
          Previous
        </UiV2.Button>
        <span>{history.data?.total ?? 0} requests</span>
        <UiV2.Button
          variant="secondary"
          disabled={history.data?.nextOffset == null}
          onClick={() => {
            setOffset(history.data?.nextOffset ?? 0);
          }}
        >
          Next
        </UiV2.Button>
      </div>
      <UiV2.Sheet
        open={!!selected}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
      >
        <UiV2.SheetContent
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (requestTrigger.current?.isConnected) requestTrigger.current.focus();
            else search.current?.focus();
          }}
          tabIndex={0}
          className="gateway-request-drawer overflow-y-auto"
          overlayClassName="gateway-request-overlay"
        >
          <UiV2.SheetHeader>
            <div className="flex items-center justify-between gap-3">
              <UiV2.SheetTitle>Request details</UiV2.SheetTitle>
              <UiV2.SheetClose asChild>
                <UiV2.Button variant="ghost" size="sm" aria-label="Close request details">
                  Close
                </UiV2.Button>
              </UiV2.SheetClose>
            </div>
            <UiV2.SheetDescription>
              Routing attempts and sanitized diagnostics
            </UiV2.SheetDescription>
          </UiV2.SheetHeader>
          {details.isPending ? (
            <SkeletonTable rows={3} />
          ) : details.isError ? (
            <p role="alert">Could not load request details.</p>
          ) : !record ? (
            <p>This request is no longer retained.</p>
          ) : (
            <div className="grid gap-4 p-4">
              <dl className="grid gap-3">
                {[
                  ['Requested', record.requestedModel],
                  ['Served', record.servedModel ?? record.modelRef ?? 'No serving model'],
                  ['Provider', record.providerId ?? 'No successful provider'],
                  ['Outcome', record.outcome ?? record.status],
                  ['Correlation ID', record.traceId ?? record.id],
                  [
                    'Input / output / cached',
                    record.usageReported === false
                      ? 'Not reported. A conservative token estimate remains enforced for this key.'
                      : `${String(record.inputTokens)} / ${String(record.outputTokens)} / ${String(record.cachedTokens ?? 0)}`,
                  ],
                  ['Queue time', durationText(record.queueWaitMs)],
                  [
                    'Cost',
                    `${costText(record.costUsd)}${record.estimatedCost ? ' (estimated)' : ''}`,
                  ],
                ].map(([label, value]) => (
                  <div key={label}>
                    <dt className="text-muted-foreground">{label}</dt>
                    <dd className="break-words">{value}</dd>
                  </div>
                ))}
              </dl>
              <h3>Attempted routes</h3>
              <ol className="grid gap-3">
                {(record.attempts ?? []).map((attempt, index) => (
                  <li key={index}>
                    <strong>{attempt.model}</strong>
                    <p>
                      {attempt.status} — {durationText(attempt.durationMs)}
                    </p>
                    {attempt.reason && <p>{attempt.reason}</p>}
                  </li>
                ))}
              </ol>
              <h3>Applied constraints</h3>
              <ul className="grid gap-2">
                {(record.constraints ?? ['Legacy request: constraints were not recorded.']).map(
                  (text) => (
                    <li key={text}>{text}</li>
                  ),
                )}
              </ul>
              {record.error && <p role="note">{record.error}</p>}
              <p className="v2-gateway-help">
                Provider failure ledger entries use request ID {record.id}.
              </p>
            </div>
          )}
        </UiV2.SheetContent>
      </UiV2.Sheet>
    </section>
  );
}
