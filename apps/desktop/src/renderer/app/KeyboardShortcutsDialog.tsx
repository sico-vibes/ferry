import { Dialog, Pill } from '@ferry/ui';
import { useKeybindings } from '../state/keybindings';
const labels: Record<string, string> = {
  'chat.new': 'New chat',
  'sidebar.toggle': 'Toggle sidebar',
  'panel.toggle': 'Toggle right panel',
  'terminal.toggle': 'Toggle terminal',
  'palette.open': 'Command palette',
  'shortcuts.open': 'Keyboard shortcuts',
  'search.open': 'Search chats',
  'tab.close': 'Close tab',
  'tab.next': 'Next tab',
};

export function KeyboardShortcutsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const keybindings = useKeybindings();
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Keyboard shortcuts"
      description="Use these shortcuts anywhere in Ferry."
      onOpenAutoFocus={(event) => {
        event.preventDefault();
        if (event.currentTarget instanceof HTMLElement) event.currentTarget.focus();
      }}
    >
      <div className="grid gap-2">
        {keybindings.bindings.map((binding) => (
          <div className="setting-row" key={binding.command}>
            <span>{labels[binding.command] ?? binding.command}</span>
            <kbd>{binding.key}</kbd>
            <small>{keybindings.sources[binding.command] ?? 'Default'}</small>
          </div>
        ))}
        {keybindings.errors.map((error) => (
          <p className="text-meta text-warn" key={error}>
            {error}
          </p>
        ))}
        <div className="button-row dialog-actions">
          <Pill
            onClick={() => {
              onOpenChange(false);
            }}
          >
            Done
          </Pill>
        </div>
      </div>
    </Dialog>
  );
}
