import { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, Search, X } from 'lucide-react';
import type { ModelInfo, Provider } from '@ferry/shared';
import { ProviderLogo, UiV2 } from '@ferry/ui';
import { moveItem, toggleModel } from './modelSelection';

/**
 * Choose an ordered set of models from connected providers. The order is the failover order:
 * the gateway tries the first model, then the next on rate limits or errors.
 */
export function ModelMultiPicker({
  value,
  onChange,
  models,
  providers,
  emptyLabel,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  models: ModelInfo[];
  providers: Provider[];
  emptyLabel: string;
}) {
  const [query, setQuery] = useState('');
  const providerById = useMemo(
    () => new Map<string, Provider>(providers.map((provider) => [provider.id, provider])),
    [providers],
  );
  const connected = useMemo(
    () =>
      new Set(
        providers
          .filter(
            (provider) =>
              provider.enabled &&
              ['valid', 'unchecked', 'not_applicable'].includes(provider.keyStatus),
          )
          .map((provider) => provider.id),
      ),
    [providers],
  );
  const modelByRef = useMemo(
    () => new Map<string, ModelInfo>(models.map((model) => [model.ref, model])),
    [models],
  );
  const needle = query.trim().toLocaleLowerCase();
  const available = models.filter(
    (model) =>
      connected.has(model.providerId) &&
      (!needle ||
        `${model.name} ${model.ref} ${providerById.get(model.providerId)?.name ?? ''}`
          .toLocaleLowerCase()
          .includes(needle)),
  );
  const groups = [...new Set(available.map((model) => model.providerId))];
  const selected = value.filter((ref) => ref.includes('/') && !ref.startsWith('ferry/'));
  return (
    <div className="v2-model-multi">
      {selected.length ? (
        <ol className="v2-model-multi-selected" aria-label="Selected models, in failover order">
          {selected.map((ref, index) => {
            const model = modelByRef.get(ref);
            return (
              <li key={ref}>
                <span className="v2-model-multi-order">{index + 1}</span>
                {model ? (
                  <ProviderLogo name={model.name} providerId={model.providerId} size={14} />
                ) : null}
                <span className="v2-model-multi-name">
                  {model?.name ?? ref}
                  <small>{providerById.get(model?.providerId ?? '')?.name ?? ref}</small>
                </span>
                {model && !connected.has(model.providerId) ? (
                  <small className="v2-model-multi-warning">Not connected</small>
                ) : null}
                <UiV2.Button
                  aria-label={`Move ${model?.name ?? ref} up`}
                  disabled={index === 0}
                  size="icon"
                  variant="ghost"
                  onClick={() => {
                    onChange(moveItem(value, ref, -1));
                  }}
                >
                  <ArrowUp aria-hidden="true" size={14} />
                </UiV2.Button>
                <UiV2.Button
                  aria-label={`Move ${model?.name ?? ref} down`}
                  disabled={index === selected.length - 1}
                  size="icon"
                  variant="ghost"
                  onClick={() => {
                    onChange(moveItem(value, ref, 1));
                  }}
                >
                  <ArrowDown aria-hidden="true" size={14} />
                </UiV2.Button>
                <UiV2.Button
                  aria-label={`Remove ${model?.name ?? ref}`}
                  size="icon"
                  variant="ghost"
                  onClick={() => {
                    onChange(toggleModel(value, ref, false));
                  }}
                >
                  <X aria-hidden="true" size={14} />
                </UiV2.Button>
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="v2-model-multi-empty">{emptyLabel}</p>
      )}
      <div className="v2-model-multi-search">
        <Search aria-hidden="true" size={14} />
        <input
          aria-label="Search connected models"
          placeholder="Search connected models…"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
          }}
        />
      </div>
      <div className="v2-model-multi-list" role="group" aria-label="Connected models">
        {groups.length === 0 ? (
          <p className="v2-model-multi-empty">
            {needle ? 'No connected models match.' : 'Connect a provider to choose its models.'}
          </p>
        ) : null}
        {groups.map((providerId) => {
          const provider = providerById.get(providerId);
          return (
            <div className="v2-model-multi-group" key={providerId}>
              <div className="v2-model-multi-heading">
                <ProviderLogo
                  name={provider?.name ?? providerId}
                  providerId={providerId}
                  size={14}
                />
                {provider?.name ?? providerId}
              </div>
              {available
                .filter((model) => model.providerId === providerId)
                .map((model) => {
                  const id = `gateway-model-${model.ref}`;
                  return (
                    <label className="v2-model-multi-option" htmlFor={id} key={model.ref}>
                      <UiV2.Checkbox
                        id={id}
                        aria-label={`${model.name} (${provider?.name ?? providerId})`}
                        checked={value.includes(model.ref)}
                        onCheckedChange={(checked) => {
                          onChange(toggleModel(value, model.ref, checked === true));
                        }}
                      />
                      <span>{model.name}</span>
                      <small className={model.free ? 'is-free' : ''}>
                        {model.free ? 'Free' : 'Paid'}
                      </small>
                    </label>
                  );
                })}
            </div>
          );
        })}
      </div>
    </div>
  );
}
