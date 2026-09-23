import { TagBadge } from './TagBadge';
export default { title: 'Providers/TagBadge' };
export const All = () => (
  <div className="flex gap-2 bg-app p-4">
    <TagBadge kind="legit" />
    <TagBadge kind="promo" />
    <TagBadge kind="paid" />
    <TagBadge kind="cli" />
    <TagBadge kind="caution" />
  </div>
);
