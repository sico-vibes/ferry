import { SidebarPanel, SidebarItem } from './index';
import { Settings } from 'lucide-react';
export default { title: 'Navigation/SidebarPanel' };
export const Default = () => (
  <div className="h-[500px] w-[272px] bg-app p-3">
    <SidebarPanel
      header={<h2 className="text-title font-semibold">Chats</h2>}
      footer={<SidebarItem icon={Settings} label="Settings" showMenu={false} />}
    >
      Panel content
    </SidebarPanel>
  </div>
);
