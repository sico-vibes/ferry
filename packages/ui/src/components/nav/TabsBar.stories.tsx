import { useState } from 'react';
import { FileText, FolderGit2 } from 'lucide-react';
import { TabsBar } from './index';
export default { title: 'Navigation/TabsBar' };
export const Default = () => {
  const [activeId, setActiveId] = useState('chat');
  return (
    <div className="w-[700px] bg-app p-4">
      <TabsBar
        activeId={activeId}
        onSelect={setActiveId}
        tabs={[
          { id: 'chat', label: 'New Chat', icon: FileText },
          { id: 'repo', label: 'ferry-web', icon: FolderGit2 },
        ]}
      />
    </div>
  );
};
