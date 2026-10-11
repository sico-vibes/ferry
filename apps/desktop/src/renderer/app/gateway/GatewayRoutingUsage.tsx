import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Select, SkeletonRows, UiV2 } from '@ferry/ui';
import { useFerryClient } from '../../data/client';
import { costText } from './gatewayView';
import { formatTokens } from '../modelFacts';
import { ProviderReadiness } from '../ProviderReadiness';

export function GatewayRouting() {
  const client = useFerryClient();
  const [keyId, setKeyId] = useState('default');
  const { data: keys = [] } = useQuery({
    queryKey: ['gateway-keys'],
    queryFn: () => client.gateway.listKeys(),
  });
  const routing = useQuery({
    queryKey: ['gateway-routing', keyId],
    queryFn: () => client.gateway.routing(keyId === 'default' ? undefined : keyId),
    refetchInterval: 5000,
  });
  return (
    <section className="grid gap-4" aria-label="Routing explanation">
      <Select
        label="Routing policy for key"
        value={keyId}
        options={[
          { value: 'default', label: 'First active key or Auto readiness' },
          ...keys
            .filter((key) => !key.revokedAt)
            .map((key) => ({ value: key.id, label: key.name })),
        ]}
        onValueChange={setKeyId}
      />
      {routing.isPending ? (
        <SkeletonRows rows={5} />
      ) : routing.isError ? (
        <p role="alert">
          Could not load routes.{' '}
          <UiV2.Button variant="secondary" onClick={() => void routing.refetch()}>
            Retry
          </UiV2.Button>
        </p>
      ) : (
        <>
          <div>
            <h2>Active preset: {routing.data.profile}</h2>
            <p className="v2-gateway-help">
              {routing.data.summary} Auto serves one model per request; planner/editor splitting is
              an advanced Ferry agent option.
            </p>
          </div>
          <h3>Eligible models and fallback order</h3>
          {!routing.data.eligible.length ? (
            <p className="v2-gateway-empty">
              No eligible route. Connect a provider or review this key’s restrictions.
            </p>
          ) : (
            <div className="v2-gateway-table-scroll">
              <table className="v2-gateway-table">
                <thead>
                  <tr>
                    <th scope="col">Order</th>
                    <th scope="col">Provider / model</th>
                    <th scope="col">Quota headroom</th>
                  </tr>
                </thead>
                <tbody>
                  {routing.data.eligible.map((model) => (
                    <tr key={model.modelRef}>
                      <td>{model.order}</td>
                      <td>{model.modelRef}</td>
                      <td>
                        {model.quotaHeadroom === null
                          ? 'Not reported by provider'
                          : `${String(model.quotaHeadroom)} requests`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <details>
            <summary>Excluded models and reasons ({routing.data.excluded.length})</summary>
            <ul className="grid gap-3 pt-3">
              {routing.data.excluded.map((model) => (
                <li key={model.modelRef}>
                  <strong>{model.modelRef}</strong>
                  <p className="v2-gateway-help">{model.reason}</p>
                </li>
              ))}
            </ul>
          </details>
          <div>
            <h3>Last decision</h3>
            <p className="v2-gateway-help">
              {routing.data.lastDecision
                ? `${routing.data.lastDecision.requestedModel} served by ${routing.data.lastDecision.modelRef ?? 'no model'}. ${String(routing.data.lastDecision.attempts?.length ?? 0)} attempts; ${routing.data.lastDecision.outcome ?? routing.data.lastDecision.status}. Open Requests for every attempt and constraint.`
                : 'No decision recorded for this key yet. Send a request to see its route.'}
            </p>
          </div>
        </>
      )}
      <ProviderReadiness />
    </section>
  );
}
export function GatewayUsage() {
  const client = useFerryClient();
  const [range, setRange] = useState<'24h' | '7d' | '30d'>('24h');
  const [groupBy, setGroupBy] = useState<'key' | 'provider' | 'model'>('key');
  const { data: keys = [] } = useQuery({
    queryKey: ['gateway-keys'],
    queryFn: () => client.gateway.listKeys(),
  });
  const usage = useQuery({
    queryKey: ['gateway-usage', range, groupBy],
    queryFn: () => client.gateway.usage({ range, groupBy }),
    refetchInterval: 5000,
  });
  return (
    <section className="grid gap-4" aria-label="Usage and costs">
      <div className="v2-gateway-filters">
        <Select
          label="Usage range"
          value={range}
          options={[
            { value: '24h', label: '24 hours' },
            { value: '7d', label: '7 days' },
            { value: '30d', label: '30 days' },
          ]}
          onValueChange={(value) => {
            setRange(value as typeof range);
          }}
        />
        <Select
          label="Group usage by"
          value={groupBy}
          options={[
            { value: 'key', label: 'Client key' },
            { value: 'provider', label: 'Provider' },
            { value: 'model', label: 'Model' },
          ]}
          onValueChange={(value) => {
            setGroupBy(value as typeof groupBy);
          }}
        />
      </div>
      {usage.isPending ? (
        <SkeletonRows rows={5} />
      ) : usage.isError ? (
        <p role="alert">
          Could not load usage.{' '}
          <UiV2.Button variant="secondary" onClick={() => void usage.refetch()}>
            Retry
          </UiV2.Button>
        </p>
      ) : (
        <>
          {!usage.data.groups.length ? (
            <p className="v2-gateway-empty">
              No recorded usage in this range. Send a request to see tokens and costs.
            </p>
          ) : (
            <div className="v2-gateway-table-scroll">
              <table className="v2-gateway-table">
                <thead>
                  <tr>
                    {[
                      'Source',
                      'Requests',
                      'Input',
                      'Output',
                      'Cached input',
                      'Actual USD',
                      'Estimated USD',
                      'Unknown charges',
                    ].map((label) => (
                      <th scope="col" key={label}>
                        {label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {usage.data.groups.map((group) => (
                    <tr key={group.name}>
                      <td>
                        {groupBy === 'key'
                          ? (keys.find((key) => key.id === group.name)?.name ?? group.name)
                          : group.name}
                      </td>
                      <td>{group.requests}</td>
                      <td>{formatTokens(group.inputTokens)}</td>
                      <td>{formatTokens(group.outputTokens)}</td>
                      <td>{formatTokens(group.cachedTokens)}</td>
                      <td>{costText(group.actualUsd)}</td>
                      <td>{costText(group.estimatedUsd)}</td>
                      <td>{group.unknownCosts}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="v2-gateway-help">{usage.data.allowanceNote}</p>
          <p className="v2-gateway-help">
            Interrupted paid attempts retain conservative estimated charges. Historical metadata
            follows retention; budget accounting is retained independently.
          </p>
        </>
      )}
    </section>
  );
}
