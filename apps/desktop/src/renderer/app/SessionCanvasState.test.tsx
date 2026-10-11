import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { createMockFerryClient, RpcError } from '@ferry/client';
import { afterAll, expect, it, vi } from 'vitest';
import { FerryProvider } from '../data/client';
import { SessionCanvas } from './Canvas';
import { ProfilesSettings } from './ProfilesSettings';

const route = vi.hoisted(() => {
  // The desktop suite shares its module cache. Keep Canvas and its provider
  // context on this file's router mock, rather than another file's imports.
  vi.resetModules();
  return { sessionId: '' };
});
vi.mock('@tanstack/react-router', () => ({
  useParams: () => route,
  useNavigate: () => vi.fn(),
}));

afterAll(() => {
  vi.resetModules();
});

function mount(component: React.ReactNode, client: ReturnType<typeof createMockFerryClient>) {
  const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <FerryProvider client={client}>
      <QueryClientProvider client={queries}>{component}</QueryClientProvider>
    </FerryProvider>,
  );
}

it('shows chat loading content while the local session request is pending', async () => {
  const client = createMockFerryClient({ behavior: 'test' });
  route.sessionId = client.__state().sessions[0]?.id ?? '';
  vi.spyOn(client.sessions, 'get').mockImplementation(() => new Promise(() => undefined));
  const view = mount(<SessionCanvas />, client);
  await waitFor(() => {
    const transcript = view.container.querySelector<HTMLElement>('.transcript-viewport');
    expect(transcript).toBeTruthy();
    expect(transcript?.style.visibility).toBe('visible');
    expect(transcript?.querySelector('[aria-busy=true]')).toBeTruthy();
  });
});

it('offers retry after a session timeout instead of saying the chat was deleted', async () => {
  const client = createMockFerryClient({ behavior: 'test' });
  route.sessionId = client.__state().sessions[0]?.id ?? '';
  const read = vi
    .spyOn(client.sessions, 'get')
    .mockRejectedValue(new RpcError('RPC request timed out: sessions.get', -32001, 'timeout'));
  mount(<SessionCanvas />, client);
  expect(await screen.findByText('This chat couldn’t load.')).toBeTruthy();
  expect(screen.queryByText('This session is no longer available')).toBeNull();
  const calls = read.mock.calls.length;
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await waitFor(() => {
    expect(read.mock.calls.length).toBeGreaterThan(calls);
  });
});

it('replaces failed profile loading with a recovery action', async () => {
  const client = createMockFerryClient({ behavior: 'test' });
  vi.spyOn(client.profiles, 'list').mockRejectedValue(new Error('Core unavailable'));
  mount(<ProfilesSettings />, client);
  expect((await screen.findByRole('alert')).textContent).toContain('Profiles couldn’t load');
  expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
});
