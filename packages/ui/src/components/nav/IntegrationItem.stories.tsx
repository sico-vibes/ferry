import { IntegrationItem } from './index';
import { DropdownMenu } from '../forms';
import { MoreHorizontal } from 'lucide-react';
export default { title: 'Navigation/IntegrationItem' };
export const Statuses = () => (
  <div className="w-64 space-y-1 bg-panel p-4">
    <IntegrationItem label="GitHub" slug="github" status="connected" />
    <IntegrationItem label="Supabase" slug="supabase" status="connected" />
    <IntegrationItem label="Playwright" slug="playwright" status="disconnected" />
    <IntegrationItem label="Local" slug="local" status="error" />
    <div className="flex items-center justify-between">
      <IntegrationItem label="GitHub actions" slug="github" status="connected" />
      <DropdownMenu
        trigger={
          <button aria-label="More GitHub actions">
            <MoreHorizontal size={16} />
          </button>
        }
        items={[
          { label: 'Manage', onSelect: () => undefined },
          { separator: true },
          { label: 'Disconnect', onSelect: () => undefined },
        ]}
      />
    </div>
  </div>
);
