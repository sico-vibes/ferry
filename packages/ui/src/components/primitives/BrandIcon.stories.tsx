import { BrandIcon } from './index';
export default { title: 'Primitives/BrandIcon' };
export const KnownAndFallback = () => (
  <div className="flex gap-3 bg-app p-4">
    <BrandIcon slug="github" />
    <BrandIcon slug="supabase" />
    <BrandIcon slug="playwright" />
  </div>
);
