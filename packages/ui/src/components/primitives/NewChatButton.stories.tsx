import { NewChatButton } from './index';
export default { title: 'Primitives/NewChatButton' };
export const Sizes = () => (
  <div className="w-56 space-y-3 bg-app p-4">
    <NewChatButton size="lg" />
    <NewChatButton size="sm" />
  </div>
);
