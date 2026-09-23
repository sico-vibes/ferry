import { QuotaWindowBar } from './QuotaWindowBar';
export default { title: 'Providers/QuotaWindowBar' };
export const Examples = () => (
  <div className="grid w-80 gap-4 rounded-card bg-card p-4">
    <QuotaWindowBar
      window={{
        id: 'day',
        scope: 'provider',
        modelRef: null,
        metric: 'requests',
        kind: 'fixed_daily',
        periodLabel: 'per day',
        used: 820,
        limit: 1000,
        remaining: 180,
        resetAt: new Date(Date.now() + 2 * 60 * 60_000).toISOString(),
        confidence: 'exact',
      }}
    />
    <QuotaWindowBar
      window={{
        id: 'open',
        scope: 'provider',
        modelRef: null,
        metric: 'tokens',
        kind: 'monthly',
        periodLabel: 'per month',
        used: 820_000,
        limit: null,
        remaining: null,
        resetAt: null,
        confidence: 'unknown',
      }}
    />
  </div>
);
