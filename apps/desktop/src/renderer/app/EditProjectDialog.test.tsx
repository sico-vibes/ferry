// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createDemoFerryClient } from '@ferry/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FerryProvider } from '../data/client';
import { useProjectDialogs } from '../state/projectDialogs';
import { EditProjectDialog } from './EditProjectDialog';

async function openFor(client: ReturnType<typeof createDemoFerryClient>) {
  const project = (await client.workspaces.list())[0];
  if (!project) throw new Error('Expected a demo project');
  render(
    <FerryProvider client={client}>
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <EditProjectDialog />
      </QueryClientProvider>
    </FerryProvider>,
  );
  useProjectDialogs.getState().editProject(project.id);
  await screen.findByRole('dialog', { name: 'Edit project' });
  return project;
}

afterEach(() => {
  cleanup();
  useProjectDialogs.getState().close();
});

describe('EditProjectDialog', () => {
  it('renames the project and saves a gate command', async () => {
    const client = createDemoFerryClient({ speed: 0, latencyMs: 0 });
    const project = await openFor(client);
    const user = userEvent.setup({ delay: null });
    const name = screen.getByRole('textbox', { name: 'Project name' });
    await user.clear(name);
    await user.type(name, 'Ferry web');
    await user.type(screen.getByRole('textbox', { name: 'Add gate command' }), 'pnpm check{Enter}');
    expect(screen.getByText('pnpm check')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(async () => {
      const saved = (await client.workspaces.list()).find((item) => item.id === project.id);
      expect(saved?.name).toBe('Ferry web');
      expect(saved?.settings.gateCommands).toContain('pnpm check');
    });
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Edit project' })).toBeNull();
    });
  }, 30_000);

  it('approves project lanes', async () => {
    const client = createDemoFerryClient({ speed: 0, latencyMs: 0 });
    let approved = false;
    const originalLanes = client.delegation.lanes.bind(client.delegation);
    const originalApprove = client.delegation.approveProjectLanes.bind(client.delegation);
    vi.spyOn(client.delegation, 'lanes').mockImplementation(async () =>
      (await originalLanes()).map((lane) =>
        lane.source === 'project' ? { ...lane, trusted: approved } : lane,
      ),
    );
    vi.spyOn(client.delegation, 'approveProjectLanes').mockImplementation(async () => {
      const lanes = await originalApprove();
      approved = true;
      return lanes;
    });
    await openFor(client);
    const user = userEvent.setup({ delay: null });
    await user.click(await screen.findByRole('button', { name: 'Approve project lanes' }));
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Approve project lanes' })).toBeNull();
    });
    expect(screen.getAllByText('Trusted').length).toBeGreaterThan(0);
    expect(screen.queryByText('Needs approval')).toBeNull();
  }, 30_000);
});
