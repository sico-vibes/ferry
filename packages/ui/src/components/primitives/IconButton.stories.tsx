import { Search } from 'lucide-react';
import { IconButton } from './index';
export default { title: 'Primitives/IconButton' };
export const Variants = () => (
  <div className="flex gap-3 bg-app p-4">
    <IconButton label="Search">
      <Search size={18} />
    </IconButton>
    <IconButton label="Rail" variant="tile">
      <Search size={18} />
    </IconButton>
    <IconButton label="Circle" variant="circle">
      <Search size={18} />
    </IconButton>
  </div>
);
