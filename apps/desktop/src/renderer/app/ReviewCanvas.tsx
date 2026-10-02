import { lazy, Suspense, useEffect, useState } from 'react';
import { useNavigate, useParams } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Check, CircleAlert, FileCode2, X } from 'lucide-react';
import type { RunId, SessionId } from '@ferry/shared';
import { AgentTimeline, EmptyState, Skeleton } from '@ferry/ui';
import { useFerryClient } from '../data/client';
import { decideReview } from './reviewActions';
import { FullOutputDialog } from './FullOutputDialog';

const DiffEditor = lazy(async () => {
  const module = await import('@monaco-editor/react');
  const monaco = await import('monaco-editor/esm/vs/editor/editor.api.js');
  module.loader.config({ monaco });
  return { default: module.DiffEditor };
});

export function ReviewCanvas() {
  const { sessionId: rawSession, runId: rawRun } = useParams({
    from: '/s/$sessionId/review/$runId',
  });
  const sessionId = rawSession as SessionId;
  const runId = rawRun as RunId;
  const client = useFerryClient();
  const navigate = useNavigate();
  const cache = useQueryClient();
  const [selected, setSelected] = useState(0);
  const [rework, setRework] = useState(false);
  const [brief, setBrief] = useState('');
  const [fullOutput, setFullOutput] = useState<string | null>(null);
  const {
    data: runs,
    isLoading,
    isError,
    refetch,
  } = useQuery({
    queryKey: ['delegation', sessionId],
    queryFn: () => client.delegation.runs(sessionId),
  });
  const run = runs?.find((item) => item.id === runId);
  const change = run?.touchedFiles[selected];
  const canDecide = Boolean(
    run && run.status !== 'running' && run.touchedFiles.length > 0 && run.gateResults.length > 0,
  );

  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && fullOutput === null) {
        void navigate({ to: '/s/$sessionId', params: { sessionId } });
      }
    };
    window.addEventListener('keydown', escape);
    return () => {
      window.removeEventListener('keydown', escape);
    };
  }, [fullOutput, navigate, sessionId]);

  if (!run && isLoading)
    return (
      <section aria-label="Delegation review" className="canvas review-canvas">
        <header className="review-toolbar">
          <button
            className="review-back"
            onClick={() => {
              void navigate({ to: '/s/$sessionId', params: { sessionId } });
            }}
          >
            <ArrowLeft size={16} /> Back to session
          </button>
          <span>Loading review</span>
        </header>
        <div aria-label="Loading review" className="review-loading-state">
          <Skeleton rows={7} />
        </div>
      </section>
    );
  if (!run && isError)
    return (
      <section aria-label="Delegation review" className="canvas review-canvas">
        <EmptyState
          title="Review could not be loaded"
          action="Try again"
          onAction={() => void refetch()}
        />
      </section>
    );
  if (!run)
    return (
      <section aria-label="Delegation review" className="canvas review-canvas">
        <EmptyState
          title="This review is no longer available"
          action="Back to session"
          onAction={() => void navigate({ to: '/s/$sessionId', params: { sessionId } })}
        />
      </section>
    );

  const decide = async (decision: 'accepted' | 'rejected' | 'rework') => {
    if (!canDecide) return;
    await decideReview(client, run.id, decision, decision === 'rework' ? brief : undefined);
    if (decision === 'accepted')
      window.dispatchEvent(new CustomEvent('ferry:success-pulse', { detail: { sessionId } }));
    await cache.invalidateQueries({ queryKey: ['delegation', sessionId] });
    await navigate({ to: '/s/$sessionId', params: { sessionId } });
  };
  const theme = (monaco: typeof import('monaco-editor')) => {
    const css = getComputedStyle(document.documentElement);
    const value = (name: string) => css.getPropertyValue(name).trim();
    monaco.editor.defineTheme('ferry-review', {
      base: document.documentElement.dataset.theme === 'light' ? 'vs' : 'vs-dark',
      inherit: true,
      rules: [],
      colors: {
        'editor.background': value('--background'),
        'editor.foreground': value('--foreground'),
        'editorLineNumber.foreground': value('--muted-foreground'),
        'editorLineNumber.activeForeground': value('--foreground'),
        'editorGutter.background': value('--background'),
        'diffEditor.insertedTextBackground': `${value('--success')}26`,
        'diffEditor.removedTextBackground': `${value('--destructive')}26`,
        'editorWidget.background': value('--card'),
      },
    });
  };

  return (
    <section aria-label="Delegation review" className="canvas review-canvas">
      <header className="review-toolbar">
        <button
          className="review-back"
          onClick={() => void navigate({ to: '/s/$sessionId', params: { sessionId } })}
        >
          <ArrowLeft size={16} /> Back to session
        </button>
        <div className="review-run-heading">
          <strong>{run.lane}</strong>
          <span>
            {run.implementer} / {run.status}
          </span>
        </div>
        {run.events.length > 0 && (
          <details className="review-activity">
            <summary>Agent activity</summary>
            <AgentTimeline events={run.events} onShowFull={setFullOutput} />
          </details>
        )}
      </header>
      {!canDecide && (
        <p className="review-progress" role="status">
          {run.status === 'running' || run.status === 'queued'
            ? (run.progress.at(-1)?.text ?? 'Waiting for delegated work to finish...')
            : 'Review actions are available when changed files and gate results are ready.'}
        </p>
      )}
      <div className="review-body">
        <nav aria-label="Changed files" className="review-files">
          {run.touchedFiles.length ? (
            run.touchedFiles.map((file, index) => (
              <button
                aria-label={`${file.path}, ${String(file.additions)} additions, ${String(file.deletions)} deletions`}
                aria-current={selected === index ? 'true' : undefined}
                key={file.path}
                onClick={() => {
                  setSelected(index);
                }}
              >
                <FileCode2 size={16} />
                <span>{file.path}</span>
                <small className="review-addition-count">+{file.additions}</small>
                <small className="review-deletion-count">-{file.deletions}</small>
              </button>
            ))
          ) : (
            <p className="review-empty-files">No changed files in this run.</p>
          )}
        </nav>
        <div className="review-editor">
          {change ? (
            <Suspense fallback={<div className="review-loading">Loading diff editor...</div>}>
              <DiffEditor
                height="100%"
                theme="ferry-review"
                beforeMount={theme}
                original={change.before ?? ''}
                modified={change.after ?? ''}
                language={
                  change.path.endsWith('.json')
                    ? 'json'
                    : change.path.endsWith('.md')
                      ? 'markdown'
                      : 'typescript'
                }
                onMount={(editor) => {
                  editor
                    .getOriginalEditor()
                    .getDomNode()
                    ?.querySelector<HTMLElement>('.native-edit-context')
                    ?.setAttribute('aria-label', 'Original file contents');
                  editor
                    .getModifiedEditor()
                    .getDomNode()
                    ?.querySelector<HTMLElement>('.native-edit-context')
                    ?.setAttribute('aria-label', 'Changed file contents');
                }}
                options={{
                  readOnly: true,
                  originalAriaLabel: 'Original file contents',
                  modifiedAriaLabel: 'Changed file contents',
                  minimap: { enabled: false },
                  renderSideBySide: true,
                  scrollBeyondLastLine: false,
                  automaticLayout: true,
                }}
              />
            </Suspense>
          ) : (
            <div className="review-loading">Select a changed file to inspect its diff.</div>
          )}
        </div>
      </div>
      <footer className="review-gates">
        <strong>Gate results</strong>
        {run.gateResults.map((gate) => (
          <span className={gate.ok ? 'gate-ok' : 'gate-failed'} key={gate.command}>
            {gate.ok ? <Check size={14} /> : <CircleAlert size={14} />} {gate.command}
          </span>
        ))}
        {!run.gateResults.length && (
          <span className="review-no-gates">No gate results reported</span>
        )}
      </footer>
      <footer aria-label="Review decisions" className="review-decision-bar">
        {!rework ? (
          <>
            <button
              className="review-decision-secondary destructive"
              disabled={!canDecide}
              onClick={() => {
                void decide('rejected');
              }}
            >
              <X size={16} /> Reject
            </button>
            <button
              className="review-decision-secondary"
              disabled={!canDecide}
              onClick={() => {
                setRework(true);
              }}
            >
              Rework
            </button>
            <button
              className="review-decision-primary"
              disabled={!canDecide}
              onClick={() => {
                void decide('accepted');
              }}
            >
              <Check size={16} /> Accept
            </button>
          </>
        ) : (
          <div className="review-rework-form">
            <label htmlFor="rework-brief">What should change?</label>
            <textarea
              id="rework-brief"
              value={brief}
              onChange={(event) => {
                setBrief(event.target.value);
              }}
              autoFocus
            />
            <button
              className="review-decision-primary"
              disabled={!brief.trim() || !canDecide}
              onClick={() => {
                void decide('rework');
              }}
            >
              Send rework brief
            </button>
            <button
              className="review-decision-secondary"
              onClick={() => {
                setRework(false);
              }}
            >
              Cancel
            </button>
          </div>
        )}
      </footer>
      {fullOutput !== null && (
        <FullOutputDialog
          client={client}
          sessionId={sessionId}
          handle={fullOutput}
          onClose={() => {
            setFullOutput(null);
          }}
        />
      )}
    </section>
  );
}
