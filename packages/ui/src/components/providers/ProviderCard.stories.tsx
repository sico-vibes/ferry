import { ProviderCard } from './ProviderCard';
import type { Provider } from '@ferry/shared';
const provider: Provider = {
  id: 'gemini' as Provider['id'],
  name: 'Gemini API',
  tag: 'legit',
  kind: 'api',
  brand: 'googlegemini',
  keyStatus: 'valid',
  enabled: true,
  health: 'ok',
  cooldownUntil: null,
  dataUse: 'Free tier prompts may be used to improve products.',
  termsNote: null,
  signupUrl: null,
  docsUrl: null,
  verifiedAt: null,
  modelCount: 2,
  windows: [
    {
      id: 'daily',
      scope: 'provider',
      modelRef: null,
      metric: 'requests',
      kind: 'fixed_daily',
      periodLabel: 'per day',
      used: 212,
      limit: 250,
      remaining: 38,
      resetAt: null,
      confidence: 'exact',
    },
  ],
  stepsLeftToday: 38,
};
export default { title: 'Providers/ProviderCard' };
export const Default = () => (
  <div className="w-96 bg-canvas p-4">
    <ProviderCard provider={provider} onTest={() => undefined} onManageKey={() => undefined} />
  </div>
);
