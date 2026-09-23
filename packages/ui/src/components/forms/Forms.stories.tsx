import { useState } from 'react';
import { Check, MoreHorizontal } from 'lucide-react';
import {
  Dialog,
  DropdownMenu,
  Kbd,
  RadioCards,
  SegmentedControl,
  Select,
  Sheet,
  Slider,
  Switch,
  Tabs,
  TextField,
  Tooltip,
} from './index';

export default { title: 'Forms and overlays/Controls' };
export const Gallery = () => {
  const [enabled, setEnabled] = useState(true);
  const [mode, setMode] = useState('ask');
  const [choice, setChoice] = useState('fast');
  const [range, setRange] = useState(0.65);
  const [tab, setTab] = useState('general');
  const [provider, setProvider] = useState('gemini');
  const [open, setOpen] = useState(false);
  const [sheet, setSheet] = useState(false);
  return (
    <div className="grid max-w-2xl gap-4 rounded-panel border border-border-hair bg-panel p-6">
      <TextField
        label="API key"
        value="ferry-demo-key"
        onChange={() => undefined}
        masked
        helper="Stored by the local client."
      />
      <Select
        label="Provider"
        value={provider}
        onValueChange={setProvider}
        options={[
          { value: 'gemini', label: 'Gemini' },
          { value: 'openrouter', label: 'OpenRouter' },
        ]}
      />
      <SegmentedControl
        label="Mode"
        value={mode}
        onValueChange={setMode}
        options={[
          { value: 'ask', label: 'Ask' },
          { value: 'edit', label: 'Auto-edit' },
          { value: 'full', label: 'Full auto' },
        ]}
      />
      <Switch label="Enabled" checked={enabled} onCheckedChange={setEnabled} />
      <Slider label="Scale" min={0} max={1} step={0.05} value={range} onValueChange={setRange} />
      <Tabs
        value={tab}
        onValueChange={setTab}
        tabs={[
          { value: 'general', label: 'General' },
          { value: 'advanced', label: 'Advanced' },
        ]}
      />
      <RadioCards
        value={choice}
        onValueChange={(value) => {
          setChoice(value as string);
        }}
        options={[
          { value: 'fast', title: 'Fast', description: 'Quick free models', badge: 'Free' },
          { value: 'best', title: 'Best available', description: 'Balance capacity and quality' },
        ]}
      />
      <div className="flex items-center gap-3">
        <Kbd>Ctrl</Kbd>
        <Kbd>K</Kbd>
        <Tooltip content="Keyboard shortcut">
          <button className="ferry-close">?</button>
        </Tooltip>
        <DropdownMenu
          trigger={
            <button className="ferry-close" aria-label="More menu">
              <MoreHorizontal size={16} />
            </button>
          }
          items={[
            { label: 'Open', onSelect: () => undefined },
            { separator: true },
            { label: 'Settings', onSelect: () => undefined, shortcut: 'Ctrl ,' },
          ]}
        />
      </div>
      <div className="flex gap-2">
        <button
          className="ferry-select-trigger"
          onClick={() => {
            setOpen(true);
          }}
        >
          Open dialog
        </button>
        <button
          className="ferry-select-trigger"
          onClick={() => {
            setSheet(true);
          }}
        >
          Open sheet
        </button>
      </div>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Dialog example"
        description="Accessible focus managed dialog."
      >
        <button
          className="ferry-select-trigger"
          onClick={() => {
            setOpen(false);
          }}
        >
          <Check size={14} />
          Done
        </button>
      </Dialog>
      <Sheet
        open={sheet}
        onOpenChange={setSheet}
        title="Sheet example"
        description="Right side panel variant."
      >
        <p className="muted">Panel content</p>
      </Sheet>
    </div>
  );
};

export const DialogPrimitive = () => {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        className="ferry-select-trigger"
        onClick={() => {
          setOpen(true);
        }}
      >
        Open dialog
      </button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Dialog"
        description="A focus-managed modal."
      >
        <p>Dialog content</p>
      </Dialog>
    </>
  );
};
export const SheetPrimitive = () => {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        className="ferry-select-trigger"
        onClick={() => {
          setOpen(true);
        }}
      >
        Open sheet
      </button>
      <Sheet open={open} onOpenChange={setOpen} title="Workspace details">
        <p>Sheet content</p>
      </Sheet>
    </>
  );
};
export const TooltipPrimitive = () => (
  <Tooltip content="A delayed hint">
    <button className="ferry-select-trigger">Hover for help</button>
  </Tooltip>
);
export const DropdownMenuPrimitive = () => (
  <DropdownMenu
    trigger={
      <button className="ferry-close" aria-label="More actions">
        <MoreHorizontal size={16} />
      </button>
    }
    items={[
      { label: 'Open', onSelect: () => undefined },
      { separator: true },
      { label: 'Settings', onSelect: () => undefined, shortcut: 'Ctrl ,' },
    ]}
  />
);
export const SwitchPrimitive = () => {
  const [checked, setChecked] = useState(false);
  return <Switch label="Enable optimizers" checked={checked} onCheckedChange={setChecked} />;
};
export const SelectPrimitive = () => {
  const [value, setValue] = useState('ask');
  return (
    <Select
      label="Permission mode"
      value={value}
      onValueChange={setValue}
      options={[
        { value: 'ask', label: 'Ask' },
        { value: 'auto', label: 'Auto-edit' },
      ]}
    />
  );
};
export const SegmentedControlPrimitive = () => {
  const [value, setValue] = useState('ask');
  return (
    <SegmentedControl
      label="Permission mode"
      value={value}
      onValueChange={setValue}
      options={[
        { value: 'ask', label: 'Ask' },
        { value: 'auto', label: 'Auto-edit' },
        { value: 'full', label: 'Full auto' },
      ]}
    />
  );
};
export const TabsPrimitive = () => {
  const [value, setValue] = useState('general');
  return (
    <Tabs
      value={value}
      onValueChange={setValue}
      tabs={[
        { value: 'general', label: 'General' },
        { value: 'advanced', label: 'Advanced' },
      ]}
    />
  );
};
export const TextFieldPrimitive = () => {
  const [value, setValue] = useState('demo-key');
  return (
    <TextField
      label="API key"
      value={value}
      onChange={setValue}
      masked
      helper="Stored by the local client."
    />
  );
};
export const SliderPrimitive = () => {
  const [value, setValue] = useState(1);
  return (
    <div className="w-64">
      <Slider
        label="Font scale"
        value={value}
        min={0.85}
        max={1.3}
        step={0.05}
        onValueChange={setValue}
      />
    </div>
  );
};
export const RadioCardsPrimitive = () => {
  const [value, setValue] = useState('fast');
  return (
    <div className="w-80">
      <RadioCards
        value={value}
        onValueChange={(next) => {
          setValue(next as string);
        }}
        options={[
          { value: 'fast', title: 'Fast', description: 'Quick free models' },
          { value: 'best', title: 'Best available', description: 'Balance quality and capacity' },
        ]}
      />
    </div>
  );
};
export const KbdPrimitive = () => (
  <div className="flex items-center gap-2">
    <Kbd>Ctrl</Kbd>
    <Kbd>K</Kbd>
  </div>
);
