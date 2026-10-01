import { useEffect, useRef, useState } from 'react';
import type { FerryClient } from '@ferry/client';
import type { SessionId } from '@ferry/shared';

type OutputClient = Pick<FerryClient, 'sessions'>;

export function FullOutputDialog({
  client,
  sessionId,
  handle,
  onClose,
}: {
  client: OutputClient;
  sessionId: SessionId;
  handle: string;
  onClose: () => void;
}) {
  const [starts, setStarts] = useState([0]);
  const start = starts.at(-1) ?? 0;
  const [page, setPage] = useState<Awaited<ReturnType<typeof client.sessions.readOutput>> | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const dialogRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusable = () =>
      Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]),a[href],input:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])',
        ) ?? [],
      );
    focusable()[0]?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      } else if (event.key === 'Tab') {
        const items = focusable();
        const first = items[0];
        const last = items.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      previousFocus?.focus();
    };
  }, [onClose]);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    void client.sessions
      .readOutput({ sessionId, handle, range: { start } })
      .then((result) => {
        if (active) setPage(result);
      })
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : 'Could not load output.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [client, handle, sessionId, start]);
  return (
    <div
      className="output-dialog-backdrop"
      onClick={() => {
        onClose();
      }}
      role="presentation"
    >
      <section
        aria-label="Full tool output"
        aria-modal="true"
        className="output-dialog"
        ref={dialogRef}
        onClick={(event) => {
          event.stopPropagation();
        }}
        role="dialog"
      >
        <header>
          <strong>Full output</strong>
          <button autoFocus onClick={onClose} type="button">
            Close
          </button>
        </header>
        {loading ? (
          <p aria-live="polite">Loading output…</p>
        ) : error ? (
          <p aria-live="assertive">{error}</p>
        ) : page ? (
          <>
            <pre aria-label="Output page">{page.text}</pre>
            <footer className="flex items-center justify-between gap-3 pt-2 text-meta text-text-3">
              <span>
                Characters {String(page.start + 1)}–{String(page.end)} of {String(page.totalLength)}
              </span>
              <span className="flex gap-2">
                <button
                  disabled={starts.length < 2 || loading}
                  onClick={() => {
                    setStarts((current) => current.slice(0, -1));
                  }}
                  type="button"
                >
                  Previous page
                </button>
                <button
                  disabled={!page.hasMore || loading}
                  onClick={() => {
                    setStarts((current) => [...current, page.end]);
                  }}
                  type="button"
                >
                  Next page
                </button>
              </span>
            </footer>
          </>
        ) : null}
      </section>
    </div>
  );
}
