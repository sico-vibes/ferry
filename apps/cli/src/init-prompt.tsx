import React from 'react';
import { render } from 'ink';
import type { FerryClient } from '@ferry/client';
import { InitWizard } from './init.js';
import { selectTerminalStreams } from './terminal.js';

export async function launchInitWizard(client: FerryClient, cwd: string): Promise<number> {
  const terminal = selectTerminalStreams();
  if (!terminal) {
    process.stderr.write(
      'ferry needs an interactive terminal. Use `ferry run "<prompt>"` for scripts.\n',
    );
    return 2;
  }
  try {
    const app = render(
      <InitWizard
        client={client}
        cwd={cwd}
        onDone={() => {
          app.unmount();
        }}
      />,
      { stdin: terminal.stdin, stdout: terminal.stdout, interactive: true },
    );
    await app.waitUntilExit();
    return 0;
  } finally {
    terminal.dispose();
  }
}
