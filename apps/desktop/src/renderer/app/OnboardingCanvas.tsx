import { useEffect, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, FolderOpen } from 'lucide-react';
import { FerryMark, Pill, RadioCards, TextField } from '@ferry/ui';
import type { ProviderId } from '@ferry/shared';
import { useFerryClient } from '../data/client';
import { keys } from '../data/queries';
import { useToasts } from '../state/toasts';

const recommended = [
  'gemini',
  'openrouter',
  'nvidia',
  'cerebras',
  'groq',
  'mistral',
  'opencode-zen',
  'sambanova',
];
const moreFreeProviders = [
  'llm7',
  'cloudflare-workers-ai',
  'kilo',
  'vercel-ai-gateway',
  'huggingface',
  'ovhcloud',
  'tokenrouter',
  'anyapi',
  'zai-glm',
];
const creditsProviders = [
  'fireworks',
  'nebius',
  'scaleway',
  'hyperbolic',
  'deepinfra',
  'novita',
  'together',
  'stepfun',
];
const unavailableProviders = [
  ['Kiro', 'Its terms prohibit using the service through third-party proxies or harnesses.'],
  ['GitHub Models', 'The free API was retired on July 30, 2026.'],
  ['Chutes free', 'Free access ended in March 2026.'],
  ['Qwen Code OAuth', 'The OAuth free tier was discontinued on April 15, 2026.'],
  ['ZenMux free', 'The free plan is web chat only and has no API access.'],
] as const;
const providerDetails: Record<string, { limit: string; tag: string }> = {
  gemini: { limit: '250 requests/day on the free tier', tag: 'Reliable' },
  openrouter: { limit: 'Access to rotating free models', tag: 'Flexible' },
  nvidia: { limit: 'Free NIM endpoints, limits vary', tag: 'Broad' },
  cerebras: { limit: 'Fast inference, low daily capacity', tag: 'Fast' },
  groq: { limit: 'Generous requests, shorter context', tag: 'Fast' },
  mistral: { limit: 'Experimental free access', tag: 'Experimental' },
  'opencode-zen': { limit: 'Promotional free models', tag: 'Free' },
  sambanova: { limit: '20 requests/model/day and 200K tokens/day', tag: 'Default' },
  llm7: { limit: 'Anonymous access; email token increases limits', tag: 'Caution' },
  'cloudflare-workers-ai': { limit: '10,000 Neurons/day', tag: 'Optional' },
  kilo: { limit: '200 free-model requests/hour/IP', tag: 'Caution' },
  'vercel-ai-gateway': { limit: '$5 monthly credits', tag: 'Credits' },
  huggingface: { limit: '$0.10 monthly credits', tag: 'Credits' },
  ovhcloud: { limit: '2 anonymous requests/minute/IP/model', tag: 'No key' },
  tokenrouter: { limit: '50K routed tokens/month', tag: 'Caution' },
  anyapi: { limit: '100K anyTokens/day; conversion unknown', tag: 'Caution' },
  'zai-glm': { limit: 'Free Flash models; account limits vary', tag: 'Free' },
  fireworks: { limit: '$1 starter credits', tag: 'Credits' },
  nebius: { limit: 'One-time builder credits', tag: 'Credits' },
  scaleway: { limit: 'One-time 1M-token allowance', tag: 'Credits' },
  hyperbolic: { limit: 'Free basic tier; promo credits', tag: 'Credits' },
  deepinfra: { limit: 'Paid balance required', tag: 'Credits' },
  novita: { limit: 'Tier-gated trial credits', tag: 'Credits' },
  together: { limit: 'Dynamic limits; no fixed free pool', tag: 'Credits' },
  stepfun: { limit: 'No free API tier', tag: 'Credits' },
};
function openFolder() {
  return window.ferryHost
    ? window.ferryHost.openFolder()
    : window.prompt('Enter a folder path to add');
}

export function OnboardingCanvas() {
  const client = useFerryClient();
  const cache = useQueryClient();
  const navigate = useNavigate();
  const toast = useToasts((state) => state.push);
  const [step, setStep] = useState(() =>
    Math.min(2, Math.max(0, Number(localStorage.getItem('ferry.onboardingStep') ?? 0))),
  );
  const [selected, setSelected] = useState<string[]>(() => {
    try {
      const value: unknown = JSON.parse(localStorage.getItem('ferry.onboardingProviders') ?? '[]');
      return Array.isArray(value)
        ? value.filter((item): item is string => typeof item === 'string')
        : [];
    } catch {
      return [];
    }
  });
  const [keysByProvider, setKeysByProvider] = useState<Record<string, string>>({});
  const [cloudflareAccountId, setCloudflareAccountId] = useState('');
  const [tested, setTested] = useState<Record<string, string>>({});
  useEffect(() => {
    localStorage.setItem('ferry.onboardingStep', String(step));
    localStorage.setItem('ferry.onboardingProviders', JSON.stringify(selected));
  }, [step, selected]);
  const { data: providers = [] } = useQuery({
    queryKey: ['providers'],
    queryFn: () => client.providers.list(),
  });
  const { data: profiles = [] } = useQuery({
    queryKey: keys.profiles,
    queryFn: () => client.profiles.list(),
  });
  const defaultProfile =
    profiles.find((item) => item.builtin && item.name === 'Auto-Free') ??
    profiles.find((item) => item.builtin) ??
    profiles[0];
  const finish = async () => {
    await client.settings.update({
      onboardingComplete: true,
      ...(defaultProfile ? { activeProfileId: defaultProfile.id } : {}),
    });
    await cache.invalidateQueries({ queryKey: keys.settings });
    await navigate({ to: '/' });
  };
  const saveKey = async (id: string) => {
    const value = keysByProvider[id]?.trim();
    if (id === 'cloudflare-workers-ai' && !cloudflareAccountId.trim()) return;
    if (!value) return;
    const secret =
      id === 'cloudflare-workers-ai'
        ? JSON.stringify({ accountId: cloudflareAccountId.trim(), apiKey: value })
        : value;
    await client.providers.setKey(id as ProviderId, secret);
    await cache.invalidateQueries({ queryKey: ['providers'] });
    toast({ kind: 'success', title: 'Key saved', body: 'Run a test to verify this provider.' });
  };
  const testProvider = async (id: string) => {
    const provider = providers.find((item) => item.id === id);
    if (provider?.keyStatus === 'missing' && keysByProvider[id])
      await client.providers.setKey(id as ProviderId, keysByProvider[id] ?? '');
    const result = await client.providers.probe(id as ProviderId);
    setTested((old) => ({
      ...old,
      [id]: `${result.message}; ${result.latencyMs === null ? 'CLI' : `${String(result.latencyMs)} ms`}; next, open a folder to start coding.`,
    }));
    await cache.invalidateQueries({ queryKey: ['providers'] });
  };
  const chooseFolder = async () => {
    const path = await openFolder();
    if (path) {
      await client.workspaces.open(path);
      await cache.invalidateQueries({ queryKey: keys.workspaces });
    }
  };
  return (
    <section
      className="onboarding-page page-scroll-canvas"
      data-audit-spacing="intentional"
      onKeyDown={(event) => {
        if (event.key !== 'Enter' || event.defaultPrevented) return;
        const target = event.target;
        if (target instanceof HTMLElement && target.closest('button, input, textarea, select, a'))
          return;
        event.preventDefault();
        setStep((current) => Math.min(2, current + 1));
      }}
    >
      <div className="onboarding-card">
        <div className="onboarding-top">
          <div className="onboarding-brand">
            <FerryMark variant="icon" size={30} />
            <span>Ferry</span>
          </div>
          <button className="text-button" onClick={() => void finish()}>
            Skip setup
          </button>
        </div>
        <div className="onboarding-content">
          <div className="step-dots" role="group" aria-label={`Step ${String(step + 1)} of 3`}>
            {[0, 1, 2].map((item) => (
              <span key={item} className={item <= step ? 'active' : ''} />
            ))}
          </div>
          {step === 0 && (
            <div className="welcome-step">
              <div className="onboarding-logo">
                <FerryMark variant="brand" size={40} />
              </div>
              <h1>Code with Ferry.</h1>
              <p>Connect a provider, choose a project, and start your first session.</p>
              <Pill
                variant="blue-tint"
                onClick={() => {
                  setStep(1);
                }}
              >
                Continue
              </Pill>
            </div>
          )}
          {step === 1 && (
            <div className="onboarding-step">
              <h1>Add a free provider</h1>
              <p>Pick the free providers Ferry can use. Add keys now or come back later.</p>
              <RadioCards
                multi
                value={selected}
                onValueChange={(value) => {
                  setSelected(value as string[]);
                }}
                options={recommended.map((id) => {
                  const provider = providers.find((item) => item.id === id);
                  const info = providerDetails[id];
                  return {
                    value: id,
                    title: provider?.name ?? id,
                    ...(info?.limit ? { description: info.limit } : {}),
                    ...(info?.tag ? { badge: info.tag } : {}),
                  };
                })}
              />
              <details className="grid gap-3">
                <summary className="text-label cursor-pointer">More free providers</summary>
                <RadioCards
                  multi
                  value={selected}
                  onValueChange={(value) => {
                    setSelected(value as string[]);
                  }}
                  options={moreFreeProviders.map((id) => {
                    const provider = providers.find((item) => item.id === id);
                    const info = providerDetails[id];
                    return {
                      value: id,
                      title: provider?.name ?? id,
                      ...(info?.limit ? { description: info.limit } : {}),
                      ...(info?.tag ? { badge: info.tag } : {}),
                    };
                  })}
                />
              </details>
              <details className="grid gap-3">
                <summary className="text-label cursor-pointer">Credits &amp; trials</summary>
                <RadioCards
                  multi
                  value={selected}
                  onValueChange={(value) => {
                    setSelected(value as string[]);
                  }}
                  options={creditsProviders.map((id) => {
                    const provider = providers.find((item) => item.id === id);
                    const info = providerDetails[id];
                    return {
                      value: id,
                      title: provider?.name ?? id,
                      ...(info?.limit ? { description: info.limit } : {}),
                      ...(info?.tag ? { badge: info.tag } : {}),
                    };
                  })}
                />
              </details>
              <details className="grid gap-3">
                <summary className="text-label cursor-pointer">Unavailable</summary>
                <ul className="grid gap-2">
                  {unavailableProviders.map(([name, reason]) => (
                    <li className="onboarding-key" key={name}>
                      <strong>{name}</strong>
                      <small className="muted">{reason}</small>
                    </li>
                  ))}
                </ul>
              </details>
              {selected.map((id) => {
                const provider = providers.find((item) => item.id === id);
                const keyless = provider?.keyStatus === 'not_applicable';
                return (
                  <div className="onboarding-key" key={id}>
                    <div>
                      <strong>{provider?.name ?? id}</strong>
                      <a
                        href={provider?.signupUrl ?? '#'}
                        onClick={(event) => {
                          if (!provider?.signupUrl) event.preventDefault();
                        }}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Get key ↗
                      </a>
                    </div>
                    {id === 'cloudflare-workers-ai' && (
                      <TextField
                        label="Cloudflare account ID"
                        value={cloudflareAccountId}
                        onChange={(value) => {
                          setCloudflareAccountId(value);
                        }}
                        placeholder="Account ID"
                      />
                    )}
                    {!keyless && (
                      <TextField
                        label={`${provider?.name ?? id} API key${id === 'llm7' ? ' (optional)' : ''}`}
                        masked
                        value={keysByProvider[id] ?? ''}
                        onChange={(value) => {
                          setKeysByProvider((old) => ({ ...old, [id]: value }));
                        }}
                        placeholder="Paste API key"
                      />
                    )}
                    {keyless && (
                      <small className="muted">No key required for anonymous access.</small>
                    )}
                    {id === 'llm7' && (
                      <small className="muted">
                        Anonymous access works without a key; an email token raises the free limits.
                      </small>
                    )}
                    <div className="button-row">
                      {!keyless && (
                        <Pill size="sm" onClick={() => void saveKey(id)}>
                          Save key
                        </Pill>
                      )}
                      <Pill
                        size="sm"
                        aria-label={`Test ${provider?.name ?? id}`}
                        onClick={() => void testProvider(id)}
                        leadingIcon={<Check size={13} />}
                      >
                        Test
                      </Pill>
                      {tested[id] && <small className="muted">{tested[id]}</small>}
                    </div>
                  </div>
                );
              })}
              <div className="onboarding-actions">
                <Pill
                  onClick={() => {
                    setStep(0);
                  }}
                >
                  Back
                </Pill>
                <Pill
                  variant="blue-tint"
                  onClick={() => {
                    setStep(2);
                  }}
                >
                  Continue
                </Pill>
              </div>
            </div>
          )}
          {step === 2 && (
            <div className="welcome-step final-step">
              <div className="onboarding-logo">
                <FolderOpen size={24} />
              </div>
              <h1>Open a folder</h1>
              <p>
                Choose a project to start your first Ferry session. You can add more folders from
                Library.
              </p>
              <div className="onboarding-actions">
                <Pill
                  onClick={() => {
                    setStep(1);
                  }}
                >
                  Back
                </Pill>
                <Pill variant="blue-tint" onClick={() => void finish()}>
                  Continue
                </Pill>
              </div>
              <button className="text-button" onClick={() => void chooseFolder()}>
                Open folder
              </button>
            </div>
          )}
        </div>
        <footer className="onboarding-footer">
          Your provider keys stay in the local Ferry client.
        </footer>
      </div>
    </section>
  );
}
