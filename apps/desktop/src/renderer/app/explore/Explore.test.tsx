// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FerryClient, ModelListQuery } from '@ferry/client';
import type { ModelInfo, Provider } from '@ferry/shared';
import { FerryProvider } from '../../data/client';
import { ModelsCanvas } from './Explore';

const pushToast = vi.fn();
const navigate = vi.fn();
let client: FerryClient;
let providerListSpy: ReturnType<typeof vi.fn>;
let setKeySpy: ReturnType<typeof vi.fn>;
let removeKeySpy: ReturnType<typeof vi.fn>;
let probeSpy: ReturnType<typeof vi.fn>;
let modelListSpy: ReturnType<typeof vi.fn>;
let oauthLoginSpy: ReturnType<typeof vi.fn>;
vi.mock('../../state/toasts', () => ({
  useToasts: (selector: (state: { push: typeof pushToast }) => unknown) =>
    selector({ push: pushToast }),
}));
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigate,
  useRouterState: ({
    select,
  }: {
    select: (state: { location: { pathname: string } }) => unknown;
  }) => select({ location: { pathname: '/models' } }),
}));

const provider = (overrides: Partial<Provider> = {}): Provider => ({
  id: 'mistral' as Provider['id'],
  name: 'Mistral',
  tag: 'legit',
  kind: 'api',
  brand: null,
  keyStatus: 'unchecked',
  enabled: true,
  health: 'ok',
  cooldownUntil: null,
  dataUse: null,
  termsNote: null,
  signupUrl: 'https://example.com/key',
  docsUrl: null,
  verifiedAt: null,
  modelCount: 1,
  windows: [],
  stepsLeftToday: null,
  ...overrides,
});
const model = (overrides: Partial<ModelInfo> = {}): ModelInfo => ({
  ref: 'mistral/codestral' as ModelInfo['ref'],
  providerId: 'mistral' as Provider['id'],
  name: 'Codestral',
  tier: 'T2',
  contextWindow: 256000,
  maxOutput: 32000,
  toolCalling: true,
  reasoning: true,
  free: true,
  priceInPerM: null,
  priceOutPerM: null,
  ...overrides,
});
function setup() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <FerryProvider client={client}>
      <QueryClientProvider client={queryClient}>
        <ModelsCanvas />
      </QueryClientProvider>
    </FerryProvider>,
  );
}

beforeEach(() => {
  pushToast.mockReset();
  navigate.mockReset();
  providerListSpy = vi.fn().mockResolvedValue([
    provider(),
    provider({
      id: 'openai' as Provider['id'],
      name: 'OpenAI',
      tag: 'paid',
      enabled: false,
      keyStatus: 'missing',
    }),
  ]);
  setKeySpy = vi.fn().mockResolvedValue(provider({ keyStatus: 'unchecked' }));
  removeKeySpy = vi.fn().mockResolvedValue(provider({ keyStatus: 'missing' }));
  probeSpy = vi.fn().mockResolvedValue({
    ok: true,
    keyValid: true,
    latencyMs: 412,
    message: 'Connected',
    windows: [],
    models: [],
    errorKind: null,
  });
  const modelRows = [
    model(),
    model({
      ref: 'mistral/large' as ModelInfo['ref'],
      name: 'Large',
      free: false,
      tier: 'T1',
    }),
  ];
  modelListSpy = vi.fn((query: ModelListQuery = {}) => {
    const needle = query.query?.toLowerCase() ?? '';
    const filtered = modelRows
      .filter((item) => item.name.toLowerCase().includes(needle))
      .filter((item) => !query.filters?.tier || item.tier === query.filters.tier)
      .filter((item) => query.filters?.free === undefined || item.free === query.filters.free)
      .toSorted((left, right) => {
        const key = query.sort?.key ?? 'name';
        const a = left[key];
        const b = right[key];
        const result =
          typeof a === 'string' && typeof b === 'string'
            ? a.localeCompare(b)
            : Number(a ?? -1) - Number(b ?? -1);
        return (query.sort?.ascending === false ? -1 : 1) * result;
      });
    const offset = query.offset ?? 0;
    const limit = query.limit ?? 50;
    return { items: filtered.slice(offset, offset + limit), total: filtered.length };
  });
  oauthLoginSpy = vi.fn().mockResolvedValue(undefined);
  client = {
    providers: {
      list: providerListSpy,
      setKey: setKeySpy,
      removeKey: removeKeySpy,
      probe: probeSpy,
      setEnabled: vi.fn().mockResolvedValue(provider()),
    },
    models: {
      list: vi.fn().mockResolvedValue(modelRows),
      page: modelListSpy,
    },
    oauth: {
      list: vi.fn().mockResolvedValue([
        {
          id: 'anthropic',
          tag: 'subscription_oauth',
          name: 'Anthropic Claude Pro/Max',
          subscriptionRequired: true,
          models: ['Claude Sonnet 5'],
          riskLevel: 'high',
          riskText: 'May suspend account',
          connected: false,
        },
      ]),
      login: oauthLoginSpy,
      logout: vi.fn(),
      status: vi.fn().mockResolvedValue(false),
    },
    settings: {
      get: vi.fn().mockResolvedValue({
        subscriptionOAuthAcknowledged: [],
        allowSubscriptionOAuthRouting: false,
      }),
      update: vi.fn().mockResolvedValue({
        subscriptionOAuthAcknowledged: ['anthropic'],
        allowSubscriptionOAuthRouting: false,
      }),
    },
    on: vi.fn(() => () => undefined),
  } as unknown as FerryClient;
});
afterEach(cleanup);

describe('Models providers and catalog', () => {
  it('requires explicit suspension risk acknowledgement before login', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(
      await screen.findByRole('button', { name: 'Log in to Anthropic Claude Pro/Max' }),
    );
    const proceed = screen.getByRole('button', { name: 'Log in anyway' });
    expect(proceed.hasAttribute('disabled')).toBe(true);
    await user.click(screen.getByLabelText('I understand my account may be suspended'));
    expect(proceed.hasAttribute('disabled')).toBe(false);
    expect(oauthLoginSpy).not.toHaveBeenCalled();
    await user.click(proceed);
    await waitFor(() => {
      expect(oauthLoginSpy).toHaveBeenCalledWith('anthropic');
    });
  });
  it('filters providers and probes with feedback', async () => {
    const user = userEvent.setup();
    setup();
    await screen.findByRole('button', { name: 'Test Mistral' }, { timeout: 10_000 });
    await user.click(
      within(screen.getByRole('navigation', { name: 'Provider filters' })).getByRole('button', {
        name: 'Free',
      }),
    );
    expect(screen.getByRole('button', { name: 'Test Mistral' })).toBeTruthy();
    expect(screen.queryByText('OpenAI')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Test Mistral' }));
    await waitFor(() => {
      expect(probeSpy).toHaveBeenCalledWith('mistral');
    });
    expect(pushToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Connected · 412 ms' }),
    );
  }, 20_000);

  it('keeps providers needing attention visible above the collapsed group', async () => {
    sessionStorage.removeItem('ferry:list:explore:providers');
    providerListSpy.mockResolvedValue([
      ...Array.from({ length: 7 }, (_, index) =>
        provider({
          id: `provider-${String(index + 1)}` as Provider['id'],
          name: `Provider ${String(index + 1)}`,
        }),
      ),
      provider({
        id: 'provider-attention' as Provider['id'],
        name: 'Provider needing attention',
        health: 'down',
      }),
    ]);
    setup();
    expect(
      await screen.findByRole('button', { name: 'Test Provider needing attention' }),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Show more providers (2)' })).toBeTruthy();
  });

  it('saves and removes a provider key with validation', async () => {
    const user = userEvent.setup();
    providerListSpy.mockResolvedValue([provider()]);
    setup();
    const manageButton = (await screen.findAllByRole('button', { name: 'Manage key' })).at(0);
    if (!manageButton) throw new Error('The provider key action is missing.');
    await user.click(manageButton);
    await user.click(screen.getByRole('button', { name: 'Save key' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Enter an API key');
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'demo-mistral-key' } });
    await user.click(screen.getByRole('button', { name: 'Save key' }));
    await waitFor(() => {
      expect(setKeySpy).toHaveBeenCalledWith('mistral', 'demo-mistral-key');
    });
    await user.click(screen.getByRole('button', { name: 'Remove key' }));
    await user.click(screen.getByRole('button', { name: 'Remove key' }));
    await waitFor(() => {
      expect(removeKeySpy).toHaveBeenCalledWith('mistral');
    });
  }, 20_000);

  it('sorts models by name and changes sort direction', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(await screen.findByRole('tab', { name: 'Models' }));
    await waitFor(() => {
      expect(modelListSpy).toHaveBeenCalled();
    });
    expect(await screen.findByText('Codestral')).toBeTruthy();
    const modelHeader = within(screen.getByRole('columnheader', { name: /Model/ }));
    const rowTexts = () =>
      screen
        .getAllByRole('row')
        .slice(1)
        .map((row) => row.textContent);
    await user.click(modelHeader.getByRole('button'));
    await waitFor(() => {
      expect(rowTexts()[0]).toContain('Large');
      expect(rowTexts()[1]).toContain('Codestral');
    });
    await user.click(modelHeader.getByRole('button'));
    await waitFor(() => {
      expect(rowTexts()[0]).toContain('Codestral');
      expect(rowTexts()[1]).toContain('Large');
    });
  }, 20_000);

  it('paginates models and resets to the first page when searching', async () => {
    const user = userEvent.setup();
    const allModels = Array.from({ length: 60 }, (_, index) =>
      model({
        ref: `mistral/model-${String(index + 1).padStart(2, '0')}` as ModelInfo['ref'],
        name: `Model ${String(index + 1).padStart(2, '0')}`,
      }),
    );
    modelListSpy.mockImplementation((query: ModelListQuery = {}) => {
      const limit = query.limit ?? 50;
      const offset = query.offset ?? 0;
      const filtered = allModels.filter((item) =>
        item.name.toLowerCase().includes(query.query?.toLowerCase() ?? ''),
      );
      return { items: filtered.slice(offset, offset + limit), total: filtered.length };
    });
    setup();
    await user.click(await screen.findByRole('tab', { name: 'Models' }));
    await screen.findByText('Model 01');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Models per page' }), '25');
    expect(await screen.findByText('1–25 of 60')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('26–50 of 60')).toBeTruthy();
    expect(screen.getByText('Model 26')).toBeTruthy();
    await user.type(screen.getByRole('searchbox', { name: 'Search models' }), 'Model 5');
    await waitFor(() => {
      expect(modelListSpy).toHaveBeenLastCalledWith(
        expect.objectContaining({ offset: 0, query: 'Model 5' }),
      );
    });
    expect(await screen.findByText('1–10 of 10')).toBeTruthy();
  }, 20_000);
});
