import { SidebarSection, SidebarItem } from './index';
import { Settings } from 'lucide-react';
export default { title: 'Navigation/SidebarSection' };
export const Default = () => (
  <div className="w-64 bg-panel p-4">
    <SidebarSection label="Pinned Profiles" action={() => undefined}>
      <SidebarItem icon={Settings} label="Best Available" active />
    </SidebarSection>
  </div>
);
