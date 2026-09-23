import { useState } from 'react';
import {
  BookOpen,
  Headset,
  Lightbulb,
  PanelLeft,
  Search,
  Settings,
  Sparkles,
  Zap,
} from 'lucide-react';
import { FadeSeparator } from '../effects/FadeSeparator';
import { CapacityCard } from '../components/data';
import { IconButton, NewChatButton } from '../components/primitives';
import {
  IconRail,
  IntegrationItem,
  SidebarItem,
  SidebarPanel,
  SidebarSection,
} from '../components/nav';

export default { title: 'Layout/Left column' };

export const Reference = () => {
  const [active, setActive] = useState('Best Available');
  const [activePage, setActivePage] = useState<'chats' | 'library' | 'explore'>('chats');
  return (
    <div className="fixed inset-0 h-[900px] w-[1440px] overflow-hidden bg-app p-3 text-text-1">
      <div aria-hidden="true" className="h-9" />
      <div className="flex h-[840px] gap-3">
        <IconRail active={activePage} onNavigate={setActivePage} />
        <div className="flex w-[272px] shrink-0 flex-col gap-2.5">
          <SidebarPanel
            className="min-h-0"
            header={
              <>
                <IconButton label="Collapse sidebar" variant="circle" size="sm" className="mr-3">
                  <PanelLeft size={16} />
                </IconButton>
                <h1 className="flex-1 text-title font-semibold">Chats</h1>
                <IconButton label="Search chats" size="sm">
                  <Search size={18} />
                </IconButton>
              </>
            }
            footer={
              <div className="space-y-1">
                <SidebarItem icon={Settings} label="Settings" showMenu={false} />
                <SidebarItem icon={Headset} label="Help & Support" showMenu={false} />
              </div>
            }
          >
            <NewChatButton />
            <FadeSeparator />
            <SidebarSection
              action={() => {
                setActive('Best Available');
              }}
              label="Pinned Profiles"
            >
              <SidebarItem
                active={active === 'Best Available'}
                icon={Lightbulb}
                label="Best Available"
                onClick={() => {
                  setActive('Best Available');
                }}
              />
              <SidebarItem
                active={active === 'Auto-Free'}
                icon={Sparkles}
                label="Auto-Free"
                onClick={() => {
                  setActive('Auto-Free');
                }}
              />
              <SidebarItem
                active={active === 'Fast'}
                icon={Zap}
                label="Fast"
                onClick={() => {
                  setActive('Fast');
                }}
              />
              <SidebarItem
                active={active === 'Long Context'}
                icon={BookOpen}
                label="Long Context"
                onClick={() => {
                  setActive('Long Context');
                }}
              />
            </SidebarSection>
            <FadeSeparator className="my-4" />
            <SidebarSection
              action={() => {
                setActive('Fast');
              }}
              label="Integrations"
            >
              <IntegrationItem label="GitHub" slug="github" status="connected" />
              <IntegrationItem label="Supabase" slug="supabase" status="connected" />
              <IntegrationItem label="Playwright" slug="playwright" status="disconnected" />
            </SidebarSection>
          </SidebarPanel>
          <CapacityCard
            stepsLeft={420}
            percent={64}
            onAddProvider={() => undefined}
            onOpenBreakdown={() => undefined}
          />
        </div>
        <div aria-hidden="true" className="flex-1" />
      </div>
    </div>
  );
};
