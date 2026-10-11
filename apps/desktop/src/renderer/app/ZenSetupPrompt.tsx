import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ProviderLogo, UiV2 } from '@ferry/ui';
import { useFerryClient } from '../data/client';
import { ProviderKeyDialog } from './ProviderKeyDialog';

export function ZenSetupPrompt({ compact = false }: { compact?: boolean }) {
  const client = useFerryClient();
  const { data: providers = [] } = useQuery({
    queryKey: ['providers'],
    queryFn: () => client.providers.list(),
  });
  const zen = providers.find((provider) => ['opencode', 'opencode-zen'].includes(provider.id));
  const [open, setOpen] = useState(false);
  if (
    !zen ||
    (zen.enabled && zen.keyStatus === 'valid' && zen.health !== 'down' && !zen.freeTierUnsupported)
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
            Connect your own key for the standard Zen API. OpenCode-only free models are available
            in the OpenCode app.
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
