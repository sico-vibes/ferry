import type { ModelInfo } from '@ferry/shared';

/** Keep catalog billing facts when a provider cache has incomplete model metadata. */
export function preserveCatalogBillingMetadata(
  models: readonly ModelInfo[],
  catalogModels: readonly ModelInfo[],
): ModelInfo[] {
  const catalogByRef = new Map(catalogModels.map((model) => [model.ref, model]));
  return models.map((model) => {
    const catalogModel = catalogByRef.get(model.ref);
    const openRouterFree = model.providerId === 'openrouter' && /:free(?:$|:)/i.test(model.ref);
    const catalogPrice = (cached: number | null, catalog: number | null | undefined) =>
      cached === null ||
      (model.providerId === 'openrouter' && !openRouterFree && cached === 0 && (catalog ?? 0) > 0)
        ? (catalog ?? cached)
        : cached;
    return {
      ...model,
      free: openRouterFree || (model.providerId === 'openrouter' ? false : model.free),
      priceInPerM: catalogPrice(model.priceInPerM, catalogModel?.priceInPerM),
      priceOutPerM: catalogPrice(model.priceOutPerM, catalogModel?.priceOutPerM),
      priceCachedInPerM: model.priceCachedInPerM ?? catalogModel?.priceCachedInPerM ?? null,
      cachedInputRatio: model.cachedInputRatio ?? catalogModel?.cachedInputRatio ?? 1,
    };
  });
}
