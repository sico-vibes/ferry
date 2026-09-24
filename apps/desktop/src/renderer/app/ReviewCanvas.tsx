import { lazy, Suspense, useEffect, useState } from 'react';
import { useNavigate, useParams } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Check, FileCode2, X } from 'lucide-react';
import type { RunId, SessionId } from '@ferry/shared';
import { EmptyState, Pill } from '@ferry/ui';
import { useFerryClient } from '../data/client';
import { decideReview } from './reviewActions';

const DiffEditor = lazy(async () => {
  const module = await import('@monaco-editor/react');
  const monaco = await import('monaco-editor');
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
  const { data: runs, isLoading } = useQuery({
    queryKey: ['delegation', sessionId],
    queryFn: () => client.delegation.runs(sessionId),
  });
  const run = runs?.find((item) => item.id === runId);
  const change = run?.touchedFiles[selected];
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        void navigate({ to: '/s/$sessionId', params: { sessionId } });
      }
    };
    window.addEventListener('keydown', escape);
    return () => {
      window.removeEventListener('keydown', escape);
    };
  }, [navigate, sessionId]);
  if (!run && isLoading)
    return (
      <section className="canvas review-canvas">
        <p>Loading review…</p>
      </section>
    );
  if (!run)
    return (
      <section className="canvas review-canvas">
        <EmptyState
          title="This review is no longer available"
          action="Back to session"
          onAction={() => void navigate({ to: '/s/$sessionId', params: { sessionId } })}
        />
      </section>
    );
  const decide = async (decision: 'accepted' | 'rejected' | 'rework') => {
    await decideReview(client, run.id, decision, decision === 'rework' ? brief : undefined);
    await cache.invalidateQueries({ queryKey: ['delegation', sessionId] });
    await navigate({ to: '/s/$sessionId', params: { sessionId } });
  };
  const theme = (monaco: typeof import('monaco-editor')) => {
    const css = getComputedStyle(document.documentElement);
    const value = (name: string) => css.getPropertyValue(name).trim();
    monaco.editor.defineTheme('ferry-review', {
      base: 'vs-dark',
      inherit: true,
      rules: [],
      colors: {
        'editor.background': value('--bg-canvas'),
        'editor.foreground': value('--text-1'),
        'editorLineNumber.foreground': value('--text-3'),
        'editorLineNumber.activeForeground': value('--text-2'),
        'editorGutter.background': value('--bg-canvas'),
        'diffEditor.insertedTextBackground': `${value('--success')}26`,
        'diffEditor.removedTextBackground': `${value('--danger')}26`,
        'editorWidget.background': value('--bg-panel'),
      },
    });
  };
  return (
    <section aria-label="Delegation review" className="canvas review-canvas">
      <header className="review-toolbar">
        <button
          className="review-back"
          onClick={() => {
            void navigate({ to: '/s/$sessionId', params: { sessionId } });
          }}
        >
          <ArrowLeft size={15} />
          Back to session
        </button>
        <div>
          <strong>{run.lane}</strong>
          <span>
            {run.implementer} · {run.status}
          </span>
        </div>
        <div className="review-actions">
          <Pill
            size="sm"
            variant="warm-outline"
            onClick={() => {
              void decide('rejected');
            }}
          >
            <X size={13} />
            Reject
          </Pill>
          <Pill
            size="sm"
            onClick={() => {
              setRework(true);
            }}
          >
            Rework
          </Pill>
          <Pill
            size="sm"
            variant="blue-tint"
            onClick={() => {
              void decide('accepted');
            }}
          >
            <Check size={13} />
            Accept
          </Pill>
        </div>
      </header>
      <div className="review-body">
        <nav aria-label="Changed files" className="review-files">
          {run.touchedFiles.map((file, index) => (
            <button
              aria-current={selected === index ? 'true' : undefined}
              key={file.path}
              onClick={() => {
                setSelected(index);
              }}
            >
              <FileCode2 size={14} />
              <span>{file.path}</span>
              <small className="text-success">+{file.additions}</small>
              <small className="text-danger">−{file.deletions}</small>
            </button>
          ))}
        </nav>
        <div className="review-editor">
          {change ? (
            <Suspense fallback={<div className="review-loading">Loading diff editor…</div>}>
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
                options={{
                  readOnly: true,
                  minimap: { enabled: false },
                  renderSideBySide: true,
                  scrollBeyondLastLine: false,
                  automaticLayout: true,
                }}
              />
            </Suspense>
          ) : (
            <div className="review-loading">No changed files in this run.</div>
          )}
        </div>
      </div>
      <footer className="review-gates">
        <strong>Gate results</strong>
        {run.gateResults.map((gate) => (
          <span className={gate.ok ? 'gate-ok' : 'gate-failed'} key={gate.command}>
            {gate.ok ? '✓' : '✗'} {gate.command}
          </span>
        ))}
      </footer>
      {rework && (
        <div className="review-rework">
          <label htmlFor="rework-brief">What should change?</label>
          <textarea
            id="rework-brief"
            value={brief}
            onChange={(event) => {
              setBrief(event.target.value);
            }}
            autoFocus
          />
          <Pill
            size="sm"
            variant="blue-tint"
            disabled={!brief.trim()}
            onClick={() => {
              void decide('rework');
            }}
          >
            Send rework brief
          </Pill>
          <button
            onClick={() => {
              setRework(false);
            }}
          >
            Cancel
          </button>
        </div>
      )}
    </section>
  );
}
