import type { ComponentType } from 'react';
import { Toaster } from '@ferry/ui';
import { BottomPanel } from './BottomPanel';
import { SessionPowerControls } from './SessionPowerControls';
import { useToasts } from '../state/toasts';

export interface AppMountContext {
  bottomOpen: boolean;
  fullCanvasPage: boolean;
}
function BottomPanelMount({ bottomOpen, fullCanvasPage }: AppMountContext) {
  return bottomOpen && !fullCanvasPage ? <BottomPanel /> : null;
}
function SessionControlsMount() {
  return <SessionPowerControls />;
}
function ToasterMount() {
  const messages = useToasts((state) => state.items);
  return (
    <Toaster
      messages={messages.map((toast) => ({
        id: String(toast.id),
        kind: toast.kind,
        text: toast.body ? `${toast.title}: ${toast.body}` : toast.title,
      }))}
    />
  );
}
export const appMounts = {
  main: [BottomPanelMount] as ComponentType<AppMountContext>[],
  overlays: [SessionControlsMount, ToasterMount] as ComponentType<AppMountContext>[],
};
