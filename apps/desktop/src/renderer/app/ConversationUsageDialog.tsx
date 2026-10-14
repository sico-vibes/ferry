import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ModelInfo, Provider, Session } from '@ferry/shared';
import { Dialog, ProviderLogo, UiV2 } from '@ferry/ui';
import { useFerryClient } from '../data/client';

const usageNumber = new Intl.NumberFormat();
const usageDate = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const tokenCount = (value: number | null | undefined) =>
  value == null ? 'Not reported' : usageNumber.format(value);

export function ConversationUsageDialog({
  session,
  projectName,
  models,
  providers,
  onClose,
  onRestoreFocus,
}: {
  session: Session;
  projectName: string | null;
  models: ReadonlyMap<string, ModelInfo>;
  providers: ReadonlyMap<string, Provider>;
  onClose: () => void;
  onRestoreFocus?: () => boolean;
}) {
  const client = useFerryClient();
  const cache = useQueryClient();
  useEffect(() => {
    const changed = (updated: Session) => {
      if (updated.id === session.id)
        void cache.invalidateQueries({ queryKey: ['session-model-usage', session.id] });
    };
    const offUpdated = client.on('session.updated', changed);
    const offStatus = client.on('session.status', changed);
    return () => {
      offUpdated();
      offStatus();
    };
  }, [client, cache, session.id]);
  const usage = useQuery({
    queryKey: ['session-model-usage', session.id],
    queryFn: () => client.sessions.modelUsage(session.id),
    retry: false,
    staleTime: 10_000,
  });
  const last = session.lastReplyModelRef ? models.get(session.lastReplyModelRef) : undefined;
  const hasCached =
    usage.data?.totals.cachedTokens != null ||
    usage.data?.models.some((row) => row.cachedTokens !== null);
  const hasReasoning =
    usage.data?.totals.reasoningTokens != null ||
    usage.data?.models.some((row) => row.reasoningTokens !== null);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Conversation usage"
      contentClassName="conversation-usage-dialog"
      onCloseAutoFocus={(event) => {
        if (onRestoreFocus?.()) event.preventDefault();
      }}
    >
      <div className="conversation-usage-summary">
        <strong>{session.title}</strong>
        <span>{projectName ?? 'No project'}</span>
        <span>Last reply: {last?.name ?? session.lastReplyModelRef ?? 'No model has replied'}</span>
      </div>
      {usage.isPending ? (
        <p role="status">Loading conversation usage…</p>
      ) : usage.isError ? (
        <p role="alert">
          Conversation usage could not load.{' '}
          <UiV2.Button variant="secondary" onClick={() => void usage.refetch()}>
            Retry
          </UiV2.Button>
        </p>
      ) : (
        <>
          <div className="conversation-usage-totals">
            <div>
              <span>Requests</span>
              <strong>{usageNumber.format(usage.data.totals.requests)}</strong>
            </div>
            <div>
              <span>Input tokens</span>
              <strong>{tokenCount(usage.data.totals.inputTokens)}</strong>
            </div>
            <div>
              <span>Output tokens</span>
              <strong>{tokenCount(usage.data.totals.outputTokens)}</strong>
            </div>
            {hasCached && (
              <div>
                <span>Cached tokens</span>
                <strong>{tokenCount(usage.data.totals.cachedTokens)}</strong>
              </div>
            )}
            {hasReasoning && (
              <div>
                <span>Reasoning tokens</span>
                <strong>{tokenCount(usage.data.totals.reasoningTokens)}</strong>
              </div>
            )}
          </div>
          {usage.data.models.length === 0 ? (
            <p>No model usage has been recorded for this conversation.</p>
          ) : (
            <div
              className="conversation-usage-table-scroll"
              role="region"
              aria-label="Model contributions"
              tabIndex={0}
            >
              <table className="conversation-usage-table">
                <thead>
                  <tr>
                    <th>Model</th>
                    <th>Connection</th>
                    <th>Requests</th>
                    <th>Input</th>
                    <th>Output</th>
                    {hasCached && <th>Cached</th>}
                    {hasReasoning && <th>Reasoning</th>}
                  </tr>
                </thead>
                <tbody>
                  {usage.data.models.map((row) => {
                    const model = models.get(row.modelRef);
                    const provider = row.providerId ? providers.get(row.providerId) : undefined;
                    return (
                      <tr
                        key={JSON.stringify([
                          row.modelRef,
                          row.providerId,
                          row.connectionId,
                          row.accountKey,
                        ])}
                      >
                        <td>
                          <span className="conversation-usage-model">
                            <ProviderLogo
                              name={model?.name ?? row.modelRef}
                              model={`${row.modelRef} ${model?.name ?? ''}`}
                              {...(row.providerId ? { providerId: row.providerId } : {})}
                              size={16}
                            />
                            <strong>{model?.name ?? row.modelRef}</strong>
                          </span>
                          {row.lastUsedAt && (
                            <small>Last used {usageDate.format(new Date(row.lastUsedAt))}</small>
                          )}
                        </td>
                        <td>
                          {provider?.name ?? row.connectionId ?? row.providerId ?? 'Not reported'}
                        </td>
                        <td>{usageNumber.format(row.requests)}</td>
                        <td>{tokenCount(row.inputTokens)}</td>
                        <td>{tokenCount(row.outputTokens)}</td>
                        {hasCached && <td>{tokenCount(row.cachedTokens)}</td>}
                        {hasReasoning && <td>{tokenCount(row.reasoningTokens)}</td>}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {(usage.data.incomplete || usage.data.coverage.missing) && (
            <p className="conversation-usage-note">
              Some earlier usage was not reported or is no longer available. Totals include recorded
              usage only.
            </p>
          )}
          <p className="conversation-usage-note">
            Tokens used through Ferry are shown here. Account limits are available in Installed CLIs
            when the client reports them.
          </p>
        </>
      )}
      <div className="conversation-usage-footer">
        <UiV2.Button variant="secondary" onClick={onClose}>
          Done
        </UiV2.Button>
      </div>
    </Dialog>
  );
}
