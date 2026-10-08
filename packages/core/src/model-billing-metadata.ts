import { isModelFreeForPlan, type ModelInfo, type Provider } from '@ferry/shared';

interface CatalogFreePlan {
  source_url: string;
  models: string[];
  excluded_models?: string[] | undefined;
}

/** Keep catalog billing facts when a provider cache has incomplete model metadata. */
export function preserveCatalogBillingMetadata(
  models: readonly ModelInfo[],
  catalogModels: readonly ModelInfo[],
  providerForModel?: (providerId: ModelInfo['providerId']) => Provider | undefined,
  freePlanForModel?: (providerId: ModelInfo['providerId']) => CatalogFreePlan | undefined,
): ModelInfo[] {
  const catalogByRef = new Map(catalogModels.map((model) => [model.ref, model]));
  const providers = new Map<ModelInfo['providerId'], Provider | undefined>();
  const plans = new Map<ModelInfo['providerId'], CatalogFreePlan | undefined>();
  return models.map((model) => {
    const catalogModel = catalogByRef.get(model.ref);
    const catalogPrice = (cached: number | null, catalog: number | null | undefined) =>
      catalog ?? cached;
    const priceInPerM = catalogPrice(model.priceInPerM, catalogModel?.priceInPerM);
    const priceOutPerM = catalogPrice(model.priceOutPerM, catalogModel?.priceOutPerM);
    if (!providers.has(model.providerId))
      providers.set(model.providerId, providerForModel?.(model.providerId));
    if (!plans.has(model.providerId))
      plans.set(model.providerId, freePlanForModel?.(model.providerId));
    const provider = providers.get(model.providerId);
    const sourcedPlan = plans.get(model.providerId);
    const freePlan: Provider['freePlan'] = sourcedPlan
      ? {
          sourceUrl: sourcedPlan.source_url,
          models: sourcedPlan.models,
          ...(sourcedPlan.excluded_models === undefined
            ? {}
            : { excludedModels: sourcedPlan.excluded_models }),
        }
      : undefined;
    const plan = {
      ...(provider ?? {
        id: model.providerId,
        tag: model.providerId === 'kilo' ? 'promo' : 'legit',
      }),
      ...(provider?.freePlan === undefined && freePlan ? { freePlan } : {}),
    };
    const free = isModelFreeForPlan(plan, { ...model, priceInPerM, priceOutPerM });
    return {
      ...model,
      contextWindow: catalogModel?.contextWindow ?? model.contextWindow,
      maxOutput: catalogModel?.maxOutput ?? model.maxOutput,
      ...((model.reasoningEfforts ?? catalogModel?.reasoningEfforts)
        ? { reasoningEfforts: model.reasoningEfforts ?? catalogModel?.reasoningEfforts }
        : {}),
      free,
      priceInPerM,
      priceOutPerM,
      priceCachedInPerM: model.priceCachedInPerM ?? catalogModel?.priceCachedInPerM ?? null,
      cachedInputRatio: model.cachedInputRatio ?? catalogModel?.cachedInputRatio ?? 1,
    };
  });
}
