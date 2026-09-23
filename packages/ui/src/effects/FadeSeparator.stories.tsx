import { FadeSeparator } from './FadeSeparator';

export default { title: 'Effects/Fade separator' };

export const SidebarSections = () => (
  <div className="w-[272px] rounded-panel border border-border-hair bg-panel p-4">
    <div className="text-meta text-text-3">Pinned Profiles</div>
    <FadeSeparator />
    <div className="text-meta text-text-3">Integrations</div>
  </div>
);

export const BluePanelDivider = () => (
  <div className="relative w-[360px] py-8">
    <FadeSeparator tone="blue" />
  </div>
);
