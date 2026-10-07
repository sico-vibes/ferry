import type { ModelCandidate, ModelInfo, Provider } from '@ferry/shared';
import { dataUseStatus, ProviderLogo } from '@ferry/ui';
import {
  contextSegments,
  formatMonth,
  formatTokens,
  modalitiesLabel,
  parameterCount,
  priceLabel,
} from './modelFacts';

function Meter({ label, value, tone }: { label: string; value: number; tone: 'good' | 'info' }) {
  return (
    <div className="v2-model-meter">
      <span className="v2-model-meter-label">{label}</span>
      <span aria-hidden="true" className="v2-model-meter-bars" data-tone={tone}>
        {Array.from({ length: 10 }, (_, index) => (
          <span data-on={index < value} key={index} />
        ))}
      </span>
    </div>
  );
}

/** Catalog facts for the highlighted picker row. Shows only what the catalog knows. */
export function ModelDetailsCard({
  model,
  provider,
  candidate,
  auto = false,
}: {
  model: ModelInfo;
  provider: Provider | undefined;
  candidate: ModelCandidate | undefined;
  auto?: boolean;
}) {
  const providerName = provider?.name ?? model.providerId;
  const bareId = model.ref.slice(model.ref.indexOf('/') + 1);
  const params = parameterCount(bareId);
  const released = formatMonth(model.releaseDate);
  const knowledge = formatMonth(model.knowledgeCutoff);
  const modalities = modalitiesLabel(model.inputModalities);
  const vision = model.capability?.vision ?? model.inputModalities?.includes('image') ?? false;
  const reasoning = model.capability?.reasoning ?? model.reasoning;
  const qualityKnown =
    model.quality !== null &&
    model.quality !== undefined &&
    (model.qualitySources?.length ?? 0) > 0;
  const facts: [string, string][] = [
    ['Context', formatTokens(model.contextWindow)],
    ['Max output', formatTokens(model.maxOutput)],
    ...(params ? ([['Parameters', params]] as [string, string][]) : []),
    ...(released ? ([['Released', released]] as [string, string][]) : []),
    ...(knowledge ? ([['Knowledge', knowledge]] as [string, string][]) : []),
    ...(model.openWeights === undefined
      ? []
      : ([['Weights', model.openWeights ? 'Open' : 'Closed']] as [string, string][])),
    ...(modalities ? ([['Input', modalities]] as [string, string][]) : []),
  ];
  const capabilities = [
    model.toolCalling ? 'Tool calling' : null,
    model.capability?.parallelToolCalls ? 'Parallel tools' : null,
    reasoning ? 'Reasoning' : null,
    vision ? 'Vision' : null,
  ].filter((item): item is string => Boolean(item));
  return (
    <aside aria-label={`${model.name} details`} className="v2-model-details">
      <header>
        <strong>{model.name}</strong>
        <span className="v2-model-details-provider">
          <ProviderLogo
            model={`${model.ref} ${model.name}`}
            name={providerName}
            providerId={model.providerId}
            size={14}
          />
          {auto ? `Router's current pick · ${providerName}` : providerName}
        </span>
      </header>
      {model.description && <p className="v2-model-details-description">{model.description}</p>}
      <div className="v2-model-meters">
        {qualityKnown && (
          <Meter label="Coding quality" tone="good" value={Math.round((model.quality ?? 0) * 10)} />
        )}
        <Meter label="Context" tone="info" value={contextSegments(model.contextWindow)} />
      </div>
      <dl className="v2-model-facts">
        {facts.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
        <div>
          <dt>Cost</dt>
          <dd>{priceLabel(model)}</dd>
        </div>
      </dl>
      {capabilities.length > 0 && (
        <div className="v2-model-capabilities">
          {capabilities.map((item) => (
            <span key={item}>{item}</span>
          ))}
        </div>
      )}
      {dataUseStatus(provider?.dataUse) === 'training' && (
        <p className="v2-model-details-warning">This provider may train on your prompts.</p>
      )}
      {candidate?.explanation && <p className="v2-model-details-note">{candidate.explanation}</p>}
    </aside>
  );
}
