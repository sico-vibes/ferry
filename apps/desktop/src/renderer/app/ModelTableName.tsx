import type { ModelInfo, Provider } from '@ferry/shared';
import { DataUseBadge, dataUseStatus, ProviderLogo, TagBadge, UiV2 } from '@ferry/ui';
import { Popover } from 'radix-ui';
import { ModelDetailsCard } from './ModelDetailsCard';

export function ModelTableName({
  model,
  provider,
  oauthRisk,
}: {
  model: ModelInfo;
  provider: Provider | undefined;
  oauthRisk: boolean;
}) {
  const warning =
    model.failing === true ||
    provider?.tag === 'promo' ||
    provider?.tag === 'trial' ||
    dataUseStatus(provider?.dataUse) === 'training' ||
    oauthRisk;
  return (
    <td className="model-table-name text-foreground">
      <div className="model-table-name-header">
        <ProviderLogo
          model={`${model.ref} ${model.name}`}
          name={model.name}
          providerId={model.providerId}
          size={16}
        />
        <Popover.Root>
          <Popover.Trigger asChild>
            <button
              type="button"
              className="model-table-name-button"
              title={model.name}
              aria-label={`${model.name} details`}
            >
              {model.name}
            </button>
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Content
              className="ferry-ui model-table-details"
              side="right"
              align="start"
              sideOffset={8}
              collisionPadding={16}
            >
              <ModelDetailsCard model={model} provider={provider} candidate={undefined} />
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>
      </div>
      <small className="model-table-access text-ui-meta">
        {model.cliAccessVerified && (model.cliConnectionId || model.transport === 'opencode_cli')
          ? 'Generation verified through CLI'
          : model.apiAccessVerified
            ? 'Generation verified on this account'
            : model.verified
              ? 'Discovered · generation not checked'
              : 'Catalogued · access not checked'}
      </small>
      {warning && (
        <div className="model-table-warnings">
          {model.failing && <UiV2.Badge variant="destructive">Failing</UiV2.Badge>}
          {provider?.tag === 'promo' && <TagBadge kind="promo" />}
          {provider?.tag === 'trial' && <TagBadge kind="trial" />}
          {dataUseStatus(provider?.dataUse) === 'training' && (
            <DataUseBadge dataUse={provider?.dataUse} />
          )}
          {oauthRisk && (
            <span
              className="model-risk-pill"
              title="Unofficial subscription access may lead to account suspension"
            >
              Subscription OAuth · risk
            </span>
          )}
        </div>
      )}
    </td>
  );
}
