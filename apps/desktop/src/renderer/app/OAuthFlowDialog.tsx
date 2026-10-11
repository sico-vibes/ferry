import { useEffect, useState } from 'react';
import type { OAuthLoginProgress } from '@ferry/shared';
import { UiV2 } from '@ferry/ui';
import { useFerryClient } from '../data/client';

type Prompt = Extract<OAuthLoginProgress, { type: 'prompt' }>;
export function OAuthFlowDialog() {
  const client = useFerryClient();
  const [flow, setFlow] = useState<{
    id: string;
    message: string;
    url?: string;
    code?: string;
    prompt?: Prompt;
    failed?: boolean;
  } | null>(null);
  const [value, setValue] = useState('');
  const [submitting, setSubmitting] = useState(false);
  useEffect(
    () =>
      client.on('oauth.progress', (event) => {
        if (event.type === 'success') {
          setFlow(null);
          setValue('');
          setSubmitting(false);
          return;
        }
        if (event.type === 'error') {
          if (/cancel/i.test(event.message)) {
            setFlow(null);
            return;
          }
          setFlow({ id: event.id, message: event.message, failed: true });
          return;
        }
        setFlow((current) => ({
          ...(current?.id === event.id ? current : {}),
          id: event.id,
          message:
            event.type === 'open_url'
              ? (event.instructions ?? 'Waiting for you to authorize in your browser…')
              : event.type === 'device_code'
                ? 'Enter this code in the provider’s sign-in page, then finish authorization.'
                : event.message,
          ...(event.type === 'open_url' ? { url: event.url } : {}),
          ...(event.type === 'device_code'
            ? { url: event.verificationUri, code: event.userCode }
            : {}),
          ...(event.type === 'prompt' ? { prompt: event } : {}),
        }));
        if (event.type === 'prompt') {
          setValue('');
          setSubmitting(false);
        }
      }),
    [client],
  );
  const cancel = () => {
    if (flow && !flow.failed)
      void client.oauth.cancel(flow.id).catch((error: unknown) => {
        setFlow({
          id: flow.id,
          message: error instanceof Error ? error.message : 'Could not cancel sign-in',
          failed: true,
        });
      });
    setFlow(null);
    setValue('');
  };
  return (
    <UiV2.Dialog
      open={flow !== null}
      onOpenChange={(open) => {
        if (!open) cancel();
      }}
    >
      <UiV2.DialogContent>
        <UiV2.DialogHeader>
          <UiV2.DialogTitle>
            {flow?.failed ? 'Sign-in needs attention' : `Sign in to ${flow?.id ?? 'provider'}`}
          </UiV2.DialogTitle>
          <UiV2.DialogDescription>{flow?.message}</UiV2.DialogDescription>
        </UiV2.DialogHeader>
        {!flow?.failed && (
          <p role="status" className="text-ui-secondary text-muted-foreground">
            Waiting for authorization. Keep this window open while you finish signing in.
          </p>
        )}
        {flow?.url && (
          <a href={flow.url} target="_blank" rel="noreferrer" className="text-link underline">
            Open sign-in page
          </a>
        )}
        {flow?.code && (
          <div className="rounded-card bg-muted p-4 text-ui-section tabular-nums">{flow.code}</div>
        )}
        {flow?.prompt && (
          <form
            className="grid gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              const prompt = flow.prompt;
              if (!prompt || submitting) return;
              setSubmitting(true);
              void client.oauth
                .respond(flow.id, prompt.promptId, value)
                .then(() => {
                  setValue('');
                  setFlow((current) => {
                    if (current?.id !== flow.id || current.prompt?.promptId !== prompt.promptId)
                      return current;
                    const { prompt: _prompt, ...rest } = current;
                    return { ...rest, message: 'Waiting for authorization to finish…' };
                  });
                })
                .catch((error: unknown) => {
                  setFlow((current) =>
                    current
                      ? {
                          ...current,
                          message:
                            error instanceof Error
                              ? error.message
                              : 'Could not submit authorization',
                        }
                      : null,
                  );
                })
                .finally(() => {
                  setSubmitting(false);
                });
            }}
          >
            <label className="grid gap-2 text-ui-label">
              {flow.prompt.kind === 'manual_code'
                ? 'Authorization code or redirect URL (optional for browser callback)'
                : flow.prompt.message}
              <UiV2.Input
                value={value}
                onChange={(event) => {
                  setValue(event.target.value);
                }}
                type={flow.prompt.kind === 'secret' ? 'password' : 'text'}
                autoComplete="off"
                placeholder={flow.prompt.placeholder}
              />
            </label>
            <UiV2.Button
              type="submit"
              disabled={submitting || (flow.prompt.kind !== 'text' && !value.trim())}
            >
              {submitting ? 'Submitting…' : 'Continue'}
            </UiV2.Button>
          </form>
        )}
        <div className="flex justify-end">
          <UiV2.Button variant="secondary" onClick={cancel}>
            {flow?.failed ? 'Close' : 'Cancel sign-in'}
          </UiV2.Button>
        </div>
      </UiV2.DialogContent>
    </UiV2.Dialog>
  );
}
