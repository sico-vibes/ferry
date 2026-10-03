import type { QueryClient, QueryKey } from '@tanstack/react-query';

export interface QueryPolicy {
  staleTime: number;
  gcTime: number;
}

const minute = 60_000;
const defaultPolicy: QueryPolicy = { staleTime: 20_000, gcTime: 5 * minute };
const policies: Readonly<Record<string, QueryPolicy>> = {
  catalog: { staleTime: 30 * minute, gcTime: 2 * 60 * minute },
  profiles: { staleTime: 30 * minute, gcTime: 2 * 60 * minute },
  settings: { staleTime: 30 * minute, gcTime: 2 * 60 * minute },
  providers: { staleTime: 10 * minute, gcTime: 60 * minute },
  models: { staleTime: 10 * minute, gcTime: 60 * minute },
  'model-candidates': { staleTime: 30_000, gcTime: 5 * minute },
  sessions: { staleTime: Number.POSITIVE_INFINITY, gcTime: 10 * minute },
  session: { staleTime: Number.POSITIVE_INFINITY, gcTime: 10 * minute },
  capacity: { staleTime: Number.POSITIVE_INFINITY, gcTime: 5 * minute },
  usage: { staleTime: 60_000, gcTime: 15 * minute },
  default: defaultPolicy,
};

export function queryPolicy(queryKey: QueryKey): QueryPolicy {
  const root = typeof queryKey[0] === 'string' ? queryKey[0] : 'default';
  if (root === 'quota') return policies.capacity ?? defaultPolicy;
  if (root === 'catalog') return policies.catalog ?? defaultPolicy;
  return policies[root] ?? defaultPolicy;
}

export const queryDefaults = {
  ...defaultPolicy,
  refetchOnWindowFocus: false,
} as const;

export function configureQueryPolicies(client: QueryClient): void {
  for (const [domain, policy] of Object.entries(policies)) {
    if (domain === 'default') continue;
    client.setQueryDefaults([domain], policy);
  }
}
