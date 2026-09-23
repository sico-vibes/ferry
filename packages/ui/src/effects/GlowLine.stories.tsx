import { GlowLine } from './GlowLine';

export default { title: 'Effects/Glow line' };

export const SidebarEdge = () => (
  <div className="relative h-[560px] w-[272px] overflow-hidden rounded-panel border border-border-hair bg-panel p-4 shadow-[inset_0_1px_0_var(--highlight-top)]">
    <GlowLine orientation="vertical" from="30%" to="92%" className="right-0" />
    <div className="flex items-center justify-between text-title font-semibold">
      <span>Chats</span>
      <span className="text-text-2">⌕</span>
    </div>
    <button className="relative mt-8 h-10 w-full rounded-pill border border-border-soft bg-pill-dark text-body font-medium">
      + &nbsp; New Chat
      <GlowLine orientation="horizontal" from="15%" to="85%" className="bottom-[-1px]" />
    </button>
    <div className="mt-7 text-meta text-text-3">Pinned Profiles</div>
    <div className="mt-3 rounded-item bg-[var(--grad-signature)] px-3 py-2 text-body font-medium text-text-1">
      Best Available
    </div>
  </div>
);

export const SectionSeparator = () => (
  <div className="relative h-[360px] w-[300px] overflow-hidden rounded-panel border border-border-hair bg-panel p-4">
    <GlowLine orientation="vertical" from="30%" to="92%" className="left-0" />
    <div className="flex items-center justify-between text-label font-medium text-text-2">
      <span>☆ &nbsp; Saved topics</span>
      <span className="text-text-3">⋮</span>
    </div>
    <div className="mt-4 text-body text-text-1">Give me a unique name for this project</div>
    <div className="relative my-7 h-px">
      <GlowLine orientation="horizontal" from="0%" to="100%" className="top-0" />
    </div>
    <div className="flex items-center justify-between text-label font-medium text-text-2">
      <span>◌ &nbsp; Recent chats</span>
      <span className="text-text-3">⋮</span>
    </div>
    <div className="mt-4 text-body text-text-1">New Chat</div>
  </div>
);
