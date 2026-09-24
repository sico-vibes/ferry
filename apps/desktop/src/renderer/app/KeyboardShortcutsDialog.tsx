import { Dialog, Pill } from '@ferry/ui';

const shortcuts = [
  ['New chat', 'Ctrl+N'],
  ['Toggle sidebar', 'Ctrl+B'],
  ['Toggle right panel', 'Ctrl+Shift+B'],
  ['Search chats', 'Ctrl+F'],
  ['Toggle terminal', 'Ctrl+`'],
  ['Command palette', 'Ctrl+K'],
  ['Close tab', 'Ctrl+W'],
  ['Keyboard shortcuts', 'Ctrl+/'],
];

export function KeyboardShortcutsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Keyboard shortcuts"
      description="Use these shortcuts anywhere in Ferry."
    >
      <div className="grid gap-2">
        {shortcuts.map(([label, keys]) => (
          <div className="setting-row" key={label}>
            <span>{label}</span>
            <kbd>{keys}</kbd>
          </div>
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
