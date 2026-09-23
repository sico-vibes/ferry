// @vitest-environment jsdom
import { useState } from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
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

afterEach(() => {
  cleanup();
  document.body.style.pointerEvents = '';
  document.body.removeAttribute('data-scroll-locked');
});

describe('form and overlay controls', () => {
  it('closes a dialog with Escape and restores focus', async () => {
    const user = userEvent.setup();
    function Example() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button
            onClick={() => {
              setOpen(true);
            }}
          >
            Launch
          </button>
          <Dialog open={open} onOpenChange={setOpen} title="Settings">
            <button>Inside</button>
          </Dialog>
        </>
      );
    }
    render(<Example />);
    await user.click(screen.getByRole('button', { name: 'Launch' }));
    expect(screen.getByRole('dialog')).toBeTruthy();
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });
  it('supports typeahead and arrow-key selection in Select', async () => {
    const user = userEvent.setup();
    function Example() {
      const [value, setValue] = useState('one');
      return (
        <Select
          label="Choice"
          value={value}
          onValueChange={setValue}
          options={[
            { value: 'one', label: 'One' },
            { value: 'two', label: 'Two' },
          ]}
        />
      );
    }
    render(<Example />);
    await user.click(screen.getByRole('combobox', { name: 'Choice' }));
    await user.keyboard('{ArrowDown}{Enter}');
    await waitFor(() => {
      expect(screen.getByRole('combobox', { name: 'Choice' }).textContent).toContain('Two');
    });
  });
  it('moves through segmented choices with arrow keys', async () => {
    const user = userEvent.setup();
    function Example() {
      const [value, setValue] = useState('one');
      return (
        <SegmentedControl
          label="Mode"
          value={value}
          onValueChange={setValue}
          options={[
            { value: 'one', label: 'One' },
            { value: 'two', label: 'Two' },
          ]}
        />
      );
    }
    render(<Example />);
    const one = screen.getByRole('radio', { name: 'One' });
    one.focus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('radio', { name: 'Two' }).getAttribute('aria-checked')).toBe('true');
  });
  it('toggles a switch from the keyboard', async () => {
    const user = userEvent.setup();
    function Example() {
      const [value, setValue] = useState(false);
      return <Switch label="Enabled" checked={value} onCheckedChange={setValue} />;
    }
    render(<Example />);
    const toggle = screen.getByRole('switch', { name: 'Enabled' });
    toggle.focus();
    await user.keyboard(' ');
    expect(toggle.getAttribute('data-state')).toBe('checked');
  });
  it('opens a Sheet as a dialog panel', async () => {
    const user = userEvent.setup();
    function Example() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button
            onClick={() => {
              setOpen(true);
            }}
          >
            Open sheet
          </button>
          <Sheet open={open} onOpenChange={setOpen} title="Details">
            <p>Panel content</p>
          </Sheet>
        </>
      );
    }
    render(<Example />);
    await user.click(screen.getByRole('button', { name: 'Open sheet' }));
    expect(screen.getByRole('dialog').textContent).toContain('Panel content');
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });
  it('opens DropdownMenu items from its trigger', async () => {
    const user = userEvent.setup();
    render(
      <DropdownMenu
        trigger={<button>Actions</button>}
        items={[{ label: 'Open folder', onSelect: () => undefined }]}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Actions' }));
    expect(screen.getByRole('menuitem', { name: 'Open folder' })).toBeTruthy();
  });
  it('reveals and masks TextField values', async () => {
    const user = userEvent.setup();
    render(<TextField label="Key" value="demo-key" onChange={() => undefined} masked />);
    expect(screen.getByLabelText('Key').getAttribute('type')).toBe('password');
    await user.click(screen.getByRole('button', { name: 'Show value' }));
    expect(screen.getByLabelText('Key').getAttribute('type')).toBe('text');
  });
  it('moves a Slider with the keyboard', async () => {
    const user = userEvent.setup();
    function Example() {
      const [value, setValue] = useState(0.5);
      return (
        <Slider label="Scale" min={0} max={1} step={0.1} value={value} onValueChange={setValue} />
      );
    }
    render(<Example />);
    const slider = screen.getByRole('slider', { name: 'Scale' });
    slider.focus();
    await user.keyboard('{ArrowRight}');
    expect(slider.getAttribute('aria-valuenow')).toBe('0.6');
  });
  it('selects a RadioCard', async () => {
    const user = userEvent.setup();
    function Example() {
      const [value, setValue] = useState('fast');
      return (
        <RadioCards
          value={value}
          onValueChange={(next) => {
            setValue(next as string);
          }}
          options={[
            { value: 'fast', title: 'Fast' },
            { value: 'best', title: 'Best available' },
          ]}
        />
      );
    }
    render(<Example />);
    await user.click(screen.getByRole('button', { name: 'Best available' }));
    expect(
      screen.getByRole('button', { name: 'Best available' }).getAttribute('aria-pressed'),
    ).toBe('true');
  });
  it('changes Tabs with arrow keys', async () => {
    const user = userEvent.setup();
    function Example() {
      const [value, setValue] = useState('one');
      return (
        <Tabs
          value={value}
          onValueChange={setValue}
          tabs={[
            { value: 'one', label: 'One' },
            { value: 'two', label: 'Two' },
          ]}
        />
      );
    }
    render(<Example />);
    screen.getByRole('tab', { name: 'One' }).focus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Two' }).getAttribute('aria-selected')).toBe('true');
  });
  it('shows delayed Tooltip content on hover', async () => {
    const user = userEvent.setup();
    render(
      <Tooltip content="Context help">
        <button>Help</button>
      </Tooltip>,
    );
    await user.hover(screen.getByRole('button', { name: 'Help' }));
    await waitFor(
      () => {
        expect(screen.getByRole('tooltip').textContent).toContain('Context help');
      },
      { timeout: 1200 },
    );
  });
  it('renders Kbd shortcut keys', () => {
    render(
      <>
        <Kbd>Ctrl</Kbd>
        <Kbd>K</Kbd>
      </>,
    );
    expect(screen.getByText('Ctrl').tagName).toBe('KBD');
    expect(screen.getByText('K').tagName).toBe('KBD');
  });
  it('renders the remaining controls with accessible labels', () => {
    render(
      <>
        <TextField label="Name" value="Ferry" onChange={() => undefined} />
        <Slider label="Scale" min={0} max={1} value={0.5} onValueChange={() => undefined} />
        <Tabs value="one" onValueChange={() => undefined} tabs={[{ value: 'one', label: 'One' }]} />
        <RadioCards
          value="one"
          onValueChange={() => undefined}
          options={[{ value: 'one', title: 'One' }]}
        />
        <DropdownMenu
          trigger={<button>Menu</button>}
          items={[
            { label: 'Open', onSelect: () => undefined },
            { separator: true },
            { label: 'Close', onSelect: () => undefined },
          ]}
        />
        <Tooltip content="Details">
          <button>Help</button>
        </Tooltip>
      </>,
    );
    expect(screen.getByLabelText('Name')).toBeTruthy();
    expect(screen.getByRole('slider', { name: 'Scale' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'One' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'One' })).toBeTruthy();
  });
});
