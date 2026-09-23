import { useState } from 'react';
import { FileText, FolderGit2 } from 'lucide-react';
import { TabsBar, TopRightCluster } from '../components/nav';

export default { title: 'Layout/Tabs bar' };
export const Reference = () => {
  const [activeId, setActiveId] = useState('new-chat');
  const [tabs, setTabs] = useState([
    { id: 'new-chat', label: 'New Chat', icon: FileText },
    { id: 'ferry-web', label: 'ferry-web', icon: FolderGit2 },
  ]);
  return (
    <div className="fixed inset-0 h-[900px] w-[1440px] bg-app p-3 pt-9 text-text-1">
      <TabsBar
        activeId={activeId}
        onAdd={() => {
          setTabs((items) => [
            ...items,
            { id: `tab-${String(items.length)}`, label: 'New tab', icon: FileText },
          ]);
        }}
        onClose={(id) => {
          setTabs((items) => items.filter((tab) => tab.id !== id));
        }}
        onSelect={setActiveId}
        rightCluster={<TopRightCluster />}
        tabs={tabs}
      />
    </div>
  );
};
