import { IntegrationItem } from './index';
export default { title: 'Navigation/IntegrationItem' };
export const Statuses = () => (
  <div className="w-64 space-y-1 bg-panel p-4">
    <IntegrationItem label="GitHub" slug="github" status="connected" />
    <IntegrationItem label="Supabase" slug="supabase" status="connected" />
    <IntegrationItem label="Playwright" slug="playwright" status="disconnected" />
    <IntegrationItem label="Local" slug="local" status="error" />
  </div>
);
