import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ProviderLogo, UiV2 } from '@ferry/ui';
import { isCliModelVerified } from '@ferry/shared';
import { useFerryClient } from '../data/client';
import { ProviderKeyDialog } from './ProviderKeyDialog';

export function ZenSetupPrompt({ compact = false }: { compact?: boolean }) {
  const client = useFerryClient();
  const { data: providers = [] } = useQuery({
    queryKey: ['providers'],
    queryFn: () => client.providers.list(),
  });
  const zen = providers.find((provider) => ['opencode', 'opencode-zen'].includes(provider.id));
  const { data: connections = [] } = useQuery({
    queryKey: ['cli-connections'],
    queryFn: () => client.cliConnections.list(),
    staleTime: 60_000,
  });
  const cliReady = connections.some(
    (connection) =>
      connection.kind === 'opencode-cli' &&
      connection.surfaces.native &&
      connection.models.some(
        (model) =>
          model.upstreamProvider === 'opencode' &&
          model.billing === 'free' &&
          isCliModelVerified(connection, model.ref),
      ),
  );
  const [open, setOpen] = useState(false);
  if (
    !zen ||
    (!open &&
      (cliReady ||
        (zen.enabled &&
          ['valid', 'not_applicable'].includes(zen.keyStatus) &&
          zen.health !== 'down' &&
          !zen.freeTierUnsupported)))
  )
    return null;
  return (
    <>
      <section
        className={
          compact
            ? 'grid gap-2 px-3 py-3'
            : 'flex flex-wrap items-center gap-4 rounded-card bg-muted p-4'
        }
        aria-label="Set up OpenCode Zen"
      >
        <ProviderLogo providerId="opencode" name="OpenCode Zen" size={compact ? 20 : 24} />
        <div className="min-w-0 flex-1">
          <h3 className="text-ui-label">Try OpenCode Zen</h3>
          <p className="text-ui-meta text-muted-foreground">
            Use the installed OpenCode CLI for free models in Ferry, or connect your own key for the
            standard Zen API.
          </p>
        </div>
        <UiV2.Button
          variant="secondary"
          size="sm"
          onClick={() => {
            setOpen(true);
          }}
        >
          Set up Zen
        </UiV2.Button>
      </section>
      {open && <ProviderKeyDialog provider={zen} open={open} onOpenChange={setOpen} />}
    </>
  );
}
