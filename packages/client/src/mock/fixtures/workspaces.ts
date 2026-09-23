import { sampleWorkspace } from '@ferry/shared/testing';
import type { Workspace, Profile } from '@ferry/shared';

export function createWorkspaces(): Workspace[] {
  const workspaces: Workspace[] = [
    {
      ...sampleWorkspace,
      id: 'workspace_ferry-web' as Workspace['id'],
      name: 'ferry-web',
      path: 'C:\\dev\\ferry-web',
      gitBranch: 'main',
      language: 'ts',
      settings: {
        ...sampleWorkspace.settings,
        gateCommands: ['pnpm test', 'pnpm lint'],
        defaultProfileId: 'profile_best' as Profile['id'],
      },
    },
    {
      ...sampleWorkspace,
      id: 'workspace_api' as Workspace['id'],
      name: 'api',
      path: 'C:\\dev\\api',
      gitBranch: 'feat/auth',
      language: 'py',
      settings: {
        ...sampleWorkspace.settings,
        gateCommands: ['pytest -q'],
        defaultProfileId: 'profile_best' as Profile['id'],
      },
    },
    {
      ...sampleWorkspace,
      id: 'workspace_dashboard' as Workspace['id'],
      name: 'dashboard',
      path: 'C:\\dev\\dashboard',
      gitBranch: 'main',
      language: 'ts',
      settings: {
        ...sampleWorkspace.settings,
        gateCommands: ['pnpm test', 'pnpm lint'],
        defaultProfileId: 'profile_best' as Profile['id'],
      },
    },
  ];

  return workspaces;
}
