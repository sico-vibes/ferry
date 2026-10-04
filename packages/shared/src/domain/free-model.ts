import type { ModelInfo, Provider } from './provider.js';

type FreeModelFacts = Pick<
  ModelInfo,
  'ref' | 'providerId' | 'free' | 'priceInPerM' | 'priceOutPerM'
>;
type FreeProviderPlan = Pick<Provider, 'id' | 'tag'> &
  Partial<Pick<Provider, 'billingEnabled' | 'freePlan' | 'freeTierUnsupported'>>;

function matchesPattern(pattern: string, modelId: string): boolean {
  let escaped = '';
  for (const char of pattern) {
    escaped +=
      char === '*' ? '.*' : char === '?' ? '.' : char.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
  }
  return new RegExp(`^${escaped}$`, 'i').test(modelId);
}

function isCoveredByFreePlan(provider: FreeProviderPlan, model: FreeModelFacts): boolean {
  const plan = provider.freePlan;
  if (!plan) return false;
  const modelId = model.ref.slice(provider.id.length + 1);
  const included = plan.models.some((pattern) => matchesPattern(pattern, modelId));
  const excluded =
    plan.excludedModels?.some((pattern) => matchesPattern(pattern, modelId)) ?? false;
  return included && !excluded;
}

/**
 * The shared free-tier rule. Known zero pricing is sufficient, as is a
 * sourced free-plan model coverage rule on the user's free billing setting.
 * Billing accounts are billable except for explicitly zero-priced OpenRouter
 * free variants, which do not consume account credits.
 */
export function isModelFreeForPlan(
  provider: FreeProviderPlan,
  model: FreeModelFacts,
  trialOptInProviders: readonly string[] = [],
): boolean {
  if (model.providerId !== provider.id) return false;
  const zeroPriced = model.priceInPerM === 0 && model.priceOutPerM === 0;
  const individuallyPriced =
    (model.priceInPerM !== null && model.priceInPerM !== 0) ||
    (model.priceOutPerM !== null && model.priceOutPerM !== 0);

  if (provider.freeTierUnsupported || provider.id === 'opencode') return false;
  if (provider.id === 'openrouter') return /:free(?:$|:)/i.test(model.ref) || zeroPriced;
  if (provider.billingEnabled) return false;
  if (['paid', 'credits'].includes(provider.tag)) return false;
  if (provider.tag === 'trial' && !trialOptInProviders.includes(provider.id)) return false;
  if (isCoveredByFreePlan(provider, model)) return true;
  if (individuallyPriced) return false;
  return zeroPriced;
}
