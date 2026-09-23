import { useState } from 'react';
import { IconRail } from './index';
export default { title: 'Navigation/IconRail' };
export const Default = () => {
  const [active, setActive] = useState<'chats' | 'library' | 'explore'>('chats');
  return (
    <div className="h-[600px] bg-app">
      <IconRail active={active} onNavigate={setActive} />
    </div>
  );
};
