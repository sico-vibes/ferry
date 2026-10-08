import { z } from 'zod';

export const KeybindingContextSchema = z.enum([
  'editableFocus',
  'terminalFocus',
  'paletteOpen',
  'isDesktop',
]);
export const KeybindingSchema = z.object({
  command: z.string().min(1),
  key: z.string().min(1),
  when: z.array(KeybindingContextSchema).default([]),
});
export const KeybindingsFileSchema = z.object({
  $schema: z.string().optional(),
  bindings: z.array(KeybindingSchema),
});
export type Keybinding = z.infer<typeof KeybindingSchema>;
export type KeybindingContext = z.infer<typeof KeybindingContextSchema>;
export interface KeybindingsValidation {
  bindings: Keybinding[];
  errors: string[];
}

export const DEFAULT_KEYBINDINGS: Keybinding[] = [
  { command: 'palette.open', key: 'Ctrl+K', when: [] },
  { command: 'chat.new', key: 'Ctrl+N', when: ['isDesktop'] },
  { command: 'sidebar.toggle', key: 'Ctrl+B', when: [] },
  { command: 'panel.toggle', key: 'Ctrl+.', when: [] },
  { command: 'terminal.toggle', key: 'Ctrl+`', when: ['isDesktop'] },
  { command: 'shortcuts.open', key: 'Ctrl+/', when: [] },
  { command: 'search.open', key: 'Ctrl+F', when: [] },
  { command: 'tab.close', key: 'Ctrl+W', when: [] },
  { command: 'tab.next', key: 'Ctrl+Tab', when: [] },
  { command: 'settings.open', key: 'Ctrl+,', when: [] },
  { command: 'folder.open', key: 'Ctrl+O', when: ['isDesktop'] },
  { command: 'files.search', key: 'Ctrl+P', when: [] },
];

export function parseKeybindings(raw: unknown): KeybindingsValidation {
  const result = KeybindingsFileSchema.safeParse(raw);
  if (!result.success)
    return {
      bindings: DEFAULT_KEYBINDINGS,
      errors: result.error.issues.map((issue) => issue.message),
    };
  const errors: string[] = [];
  const overrides = result.data.bindings;
  const commands = new Set<string>();
  for (const binding of overrides) {
    if (commands.has(binding.command)) errors.push(`Duplicate command: ${binding.command}`);
    commands.add(binding.command);
  }
  const merged = DEFAULT_KEYBINDINGS.map((binding) => {
    const override = overrides.find((candidate) => candidate.command === binding.command);
    return override ?? binding;
  });
  for (const binding of overrides)
    if (!DEFAULT_KEYBINDINGS.some((candidate) => candidate.command === binding.command))
      merged.push(binding);
  const keys = new Map<string, string>();
  for (const binding of merged) {
    const normalized = binding.key.toLowerCase().replaceAll(' ', '');
    const other = keys.get(normalized);
    if (other && other !== binding.command)
      errors.push(`Key conflict: ${binding.key} is assigned to ${other} and ${binding.command}`);
    keys.set(normalized, binding.command);
  }
  return { bindings: merged, errors };
}

export function matchesKeybinding(
  binding: Keybinding,
  event: {
    key: string;
    ctrlKey?: boolean;
    metaKey?: boolean;
    shiftKey?: boolean;
    altKey?: boolean;
  },
  context: Partial<Record<KeybindingContext, boolean>>,
): boolean {
  if (binding.when.some((key) => !context[key])) return false;
  const parts = binding.key.toLowerCase().split('+');
  const key = parts.at(-1);
  if (!key || event.key.toLowerCase() !== key) return false;
  const modifier = (name: string, pressed: boolean | undefined) =>
    parts.includes(name) === Boolean(pressed);
  return (
    modifier('ctrl', event.ctrlKey) &&
    modifier('cmd', event.metaKey) &&
    modifier('shift', event.shiftKey) &&
    modifier('alt', event.altKey)
  );
}
