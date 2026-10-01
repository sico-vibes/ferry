# Keyboard shortcuts

Ferry reads `keybindings.json` from the desktop application's config directory (the directory returned by Electron's `app.getPath('userData')`). The file is created automatically when Ferry first opens it. Changes made in Settings or by another editor are reloaded while Ferry is running.

```json
{
  "$schema": "https://ferry.dev/schemas/keybindings.json",
  "bindings": [
    { "command": "palette.open", "key": "Ctrl+P", "when": [] },
    { "command": "terminal.toggle", "key": "Ctrl+`", "when": ["isDesktop"] }
  ]
}
```

Bindings override defaults by `command`; unspecified commands keep their defaults. Keys use `Ctrl`, `Cmd`, `Shift`, and `Alt` modifiers joined with `+`. Supported `when` clauses are `editableFocus`, `terminalFocus`, `paletteOpen`, and `isDesktop`. All listed clauses must be true for a binding to run. Duplicate commands and key conflicts are reported in Settings and as a toast. Invalid JSON or a schema error leaves the defaults active.

Current default commands include `palette.open` (`Ctrl+K`), `chat.new` (`Ctrl+N`), `sidebar.toggle` (`Ctrl+B`), `panel.toggle` (`Ctrl+Shift+B`), `terminal.toggle` (`Ctrl+``), and `shortcuts.open` (`Ctrl+/`).
