import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, FolderOpen, Sparkles } from 'lucide-react';
import { FerryMark, GradientText, Pill, RadioCards, SegmentedControl, TextField } from '@ferry/ui';
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
];
const providerDetails: Record<string, { limit: string; tag: string }> = {
  gemini: { limit: '250 requests/day on the free tier', tag: 'Reliable' },
  openrouter: { limit: 'Access to rotating free models', tag: 'Flexible' },
  nvidia: { limit: 'Free NIM endpoints, limits vary', tag: 'Broad' },
  cerebras: { limit: 'Fast inference, low daily capacity', tag: 'Fast' },
  groq: { limit: 'Generous requests, shorter context', tag: 'Fast' },
  mistral: { limit: 'Experimental free access', tag: 'Experimental' },
  'opencode-zen': { limit: 'Promotional free models', tag: 'Free' },
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
  const [step, setStep] = useState(0);
  const [selected, setSelected] = useState<string[]>([]);
  const [keysByProvider, setKeysByProvider] = useState<Record<string, string>>({});
  const [tested, setTested] = useState<Record<string, string>>({});
  const [profile, setProfile] = useState('profile_free');
  const [delegation, setDelegation] = useState('suggest');
  const [terse, setTerse] = useState('lite');
  const { data: providers = [] } = useQuery({
    queryKey: ['providers'],
    queryFn: () => client.providers.list(),
  });
  const { data: profiles = [] } = useQuery({
    queryKey: keys.profiles,
    queryFn: () => client.profiles.list(),
  });
  const finish = async () => {
    await client.settings.update({
      onboardingComplete: true,
      activeProfileId: profile as NonNullable<
        Awaited<ReturnType<typeof client.settings.get>>
      >['activeProfileId'],
      delegationMode: delegation as 'off' | 'suggest' | 'auto',
      optimizers: {
        terse: terse as 'off' | 'lite' | 'full' | 'ultra',
        toolOutputFilters: true,
        recoveryHandles: true,
        contextHygiene: true,
        rtk: false,
      },
    });
    await cache.invalidateQueries({ queryKey: keys.settings });
    await navigate({ to: '/' });
  };
  const saveKey = async (id: string) => {
    const value = keysByProvider[id]?.trim();
    if (!value) return;
    await client.providers.setKey(id as ProviderId, value);
    await cache.invalidateQueries({ queryKey: ['providers'] });
    toast({ kind: 'success', title: 'Key saved', body: 'Run a test to verify this provider.' });
  };
  const testProvider = async (id: string) => {
    const provider = providers.find((item) => item.id === id);
    if (provider?.keyStatus === 'missing' && keysByProvider[id])
      await client.providers.setKey(id as ProviderId, keysByProvider[id] ?? '');
    const result = await client.providers.probe(id as ProviderId);
    setTested((old) => ({ ...old, [id]: result.message }));
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
    <section className="canvas onboarding-page">
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
        <div className="step-dots" role="group" aria-label={`Step ${String(step + 1)} of 4`}>
          {[0, 1, 2, 3].map((item) => (
            <span key={item} className={item <= step ? 'active' : ''} />
          ))}
        </div>
        {step === 0 && (
          <div className="welcome-step">
            <div className="onboarding-logo">
              <FerryMark variant="brand" size={40} />
            </div>
            <h1>
              <GradientText>Code on every free model.</GradientText>
            </h1>
            <p>
              Ferry routes each step to a model with capacity, then keeps the work moving when
              limits change.
            </p>
            <Pill
              variant="blue-tint"
              onClick={() => {
                setStep(1);
              }}
            >
              Get started <span aria-hidden="true">→</span>
            </Pill>
          </div>
        )}
        {step === 1 && (
          <div className="onboarding-step">
            <span className="eyebrow">STEP 2 OF 4</span>
            <h1>Choose providers</h1>
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
            {selected.map((id) => {
              const provider = providers.find((item) => item.id === id);
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
                  <TextField
                    label={`${provider?.name ?? id} API key`}
                    masked
                    value={keysByProvider[id] ?? ''}
                    onChange={(value) => {
                      setKeysByProvider((old) => ({ ...old, [id]: value }));
                    }}
                    placeholder="Paste API key"
                  />
                  <div className="button-row">
                    <Pill size="sm" onClick={() => void saveKey(id)}>
                      Save key
                    </Pill>
                    <Pill
                      size="sm"
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
          <div className="onboarding-step">
            <span className="eyebrow">STEP 3 OF 4</span>
            <h1>Set your defaults</h1>
            <p>You can change these choices any time in Settings.</p>
            <h3>Default profile</h3>
            <RadioCards
              value={profile}
              onValueChange={(value) => {
                setProfile(value as string);
              }}
              options={profiles
                .filter((item) => ['Auto-Free', 'Best Available', 'Fast'].includes(item.name))
                .map((item) => ({
                  value: item.id,
                  title: item.name,
                  description: item.description,
                  ...(item.name === 'Auto-Free' ? { badge: 'Free first' } : {}),
                }))}
            />
            <div className="form-grid">
              <label>
                <span>Delegation</span>
                <SegmentedControl
                  label="Delegation"
                  value={delegation}
                  onValueChange={setDelegation}
                  options={[
                    { value: 'off', label: 'Off' },
                    { value: 'suggest', label: 'Suggest' },
                    { value: 'auto', label: 'Auto' },
                  ]}
                />
              </label>
              <label>
                <span>Answer detail</span>
                <SegmentedControl
                  label="Answer detail"
                  value={terse}
                  onValueChange={setTerse}
                  options={[
                    { value: 'off', label: 'Full' },
                    { value: 'lite', label: 'Lite' },
                    { value: 'full', label: 'Short' },
                  ]}
                />
              </label>
            </div>
            <div className="onboarding-actions">
              <Pill
                onClick={() => {
                  setStep(1);
                }}
              >
                Back
              </Pill>
              <Pill
                variant="blue-tint"
                onClick={() => {
                  setStep(3);
                }}
              >
                Continue
              </Pill>
            </div>
          </div>
        )}
        {step === 3 && (
          <div className="welcome-step final-step">
            <div className="onboarding-logo">
              <FolderOpen size={24} />
            </div>
            <span className="eyebrow">STEP 4 OF 4</span>
            <h1>Open a folder</h1>
            <p>
              Choose a repo to start your first Ferry session. You can add more workspaces from
              Library.
            </p>
            <Pill
              variant="blue-tint"
              onClick={() => void chooseFolder()}
              leadingIcon={<FolderOpen size={15} />}
            >
              Open folder
            </Pill>
            <button className="text-button" onClick={() => void finish()}>
              Skip for now
            </button>
            <div className="onboarding-actions">
              <Pill
                onClick={() => {
                  setStep(2);
                }}
              >
                Back
              </Pill>
              <Pill
                variant="blue-tint"
                onClick={() => void finish()}
                leadingIcon={<Sparkles size={14} />}
              >
                Finish setup
              </Pill>
            </div>
          </div>
        )}
      </div>
      <footer className="onboarding-footer">
        Your provider keys stay in the local Ferry client.
      </footer>
    </section>
  );
}
