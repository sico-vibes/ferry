import { Lightbulb } from 'lucide-react';
import { DropdownMenu } from '../forms';
import { SidebarItem } from './index';
export default { title: 'Navigation/SidebarItem' };
export const States = () => (
  <div className="w-64 space-y-2 bg-panel p-4">
    <SidebarItem
      active
      icon={Lightbulb}
      label="Best Available"
      shimmer
      menu={
        <DropdownMenu
          trigger={
            <button aria-label="More actions" className="rounded-full p-1 text-white">
              ⋯
            </button>
          }
          items={[
            { label: 'Edit profile', onSelect: () => undefined },
            { label: 'Duplicate', onSelect: () => undefined },
          ]}
        />
      }
    />
    <SidebarItem icon={Lightbulb} label="Auto-Free" />
  </div>
);
