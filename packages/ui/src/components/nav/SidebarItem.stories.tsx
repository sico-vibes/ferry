import { Lightbulb } from 'lucide-react';
import { SidebarItem } from './index';
export default { title: 'Navigation/SidebarItem' };
export const States = () => (
  <div className="w-64 space-y-2 bg-panel p-4">
    <SidebarItem active icon={Lightbulb} label="Best Available" shimmer />
    <SidebarItem icon={Lightbulb} label="Auto-Free" />
  </div>
);
