import { useSyncExternalStore } from 'react';
import { DEFAULT_KEYBINDINGS, parseKeybindings, type Keybinding } from '@ferry/config/keybindings';

interface State {
  path: string;
  content: string;
  bindings: Keybinding[];
  errors: string[];
  sources: Record<string, string>;
}
let state: State = {
  path: 'keybindings.json',
  content: '{\n  "bindings": []\n}\n',
  bindings: DEFAULT_KEYBINDINGS,
  errors: [],
  sources: {},
};
const listeners = new Set<() => void>();
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const publish = (next: State) => {
  state = next;
  for (const listener of listeners) listener();
};
const applyFile = (value: { path: string; content: string; error: string | null }) => {
  let parsed: unknown;
  let errors: string[] = [];
  try {
    parsed = JSON.parse(value.content);
  } catch (error) {
    errors = [error instanceof Error ? error.message : 'Invalid JSON'];
  }
  const result = errors.length
    ? { bindings: DEFAULT_KEYBINDINGS, errors }
    : parseKeybindings(parsed);
  const customCommands = new Set<string>();
  if (typeof parsed === 'object' && parsed !== null && 'bindings' in parsed) {
    const rawBindings: unknown = parsed.bindings;
    if (Array.isArray(rawBindings))
      for (const item of rawBindings) {
        if (!isRecord(item)) continue;
        const command = item.command;
        if (typeof command === 'string') customCommands.add(command);
      }
  }
  publish({
    path: value.path,
    content: value.content,
    bindings: result.bindings,
    errors: result.errors,
    sources: Object.fromEntries(
      result.bindings.map((binding) => [
        binding.command,
        customCommands.has(binding.command) ? 'keybindings.json' : 'Default',
      ]),
    ),
  });
};
let initialized = false;
export function initializeKeybindings(onError: (message: string) => void): () => void {
  if (!window.ferryHost) return () => undefined;
  let previous = '';
  const apply = (value: { path: string; content: string; error: string | null }) => {
    applyFile(value);
    const message = state.errors.join('; ');
    if (message && message !== previous) onError(message);
    previous = message;
  };
  const off = window.ferryHost.onKeybindingsChanged(apply);
  if (!initialized) {
    initialized = true;
    void window.ferryHost
      .readKeybindings()
      .then(apply)
      .catch((error: unknown) => {
        onError(error instanceof Error ? error.message : String(error));
      });
  }
  return off;
}
export function saveKeybindings(content: string): Promise<string[]> {
  return (
    window.ferryHost?.writeKeybindings(content).then((value) => {
      applyFile(value);
      return state.errors;
    }) ?? Promise.resolve([])
  );
}
export function useKeybindings(): State {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
    () => state,
  );
}
