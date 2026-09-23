import { UsageChart } from './UsageChart';
import type { UsageHistoryPoint, Provider } from '@ferry/shared';
const data: UsageHistoryPoint[] = Array.from({ length: 14 }, (_, index) => ({
  date: new Date(Date.now() - (13 - index) * 86_400_000).toISOString().slice(0, 10),
  providerId: 'gemini' as Provider['id'],
  requests: index * 8,
  inputTokens: index * 1_000,
  outputTokens: index * 700,
  costUsd: 0,
}));
export default { title: 'Charts/UsageChart' };
export const FourteenDays = () => (
  <div className="w-[640px] rounded-card bg-card p-4">
    <UsageChart data={data} providerNames={{ gemini: 'Gemini API' }} />
  </div>
);
