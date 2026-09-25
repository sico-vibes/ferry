import React from 'react';
import { render } from 'ink';
import type { FerryClient } from '@ferry/client';
import { InitWizard } from './init.js';

export async function launchInitWizard(client: FerryClient, cwd: string): Promise<void> {
  const app = render(
    <InitWizard
      client={client}
      cwd={cwd}
      onDone={() => {
        app.unmount();
      }}
    />,
  );
  await app.waitUntilExit();
}
