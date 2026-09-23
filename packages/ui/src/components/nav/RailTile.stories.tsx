import { MessagesSquare } from 'lucide-react';
import { RailTile } from './index';
export default { title: 'Navigation/RailTile' };
export const States = () => (
  <div className="flex gap-3 bg-app p-4">
    <RailTile active icon={MessagesSquare} label="Chats" />
    <RailTile icon={MessagesSquare} label="Chats" />
  </div>
);
