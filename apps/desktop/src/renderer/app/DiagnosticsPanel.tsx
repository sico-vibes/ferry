import { useRef, useState } from 'react';
import { collectDiagnostics } from '@ferry/client';
import { UiV2 } from '@ferry/ui';
import { useFerryClient } from '../data/client';

export function DiagnosticsPanel() {
  const client = useFerryClient();
  const locked = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [report, setReport] = useState<Awaited<ReturnType<typeof collectDiagnostics>> | null>(null);
  async function exportReport() {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError('');
    try {
      const result = await collectDiagnostics(client);
      setReport(result);
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(result, null, 2) + '\n'], { type: 'application/json' }),
      );
      const link = document.createElement('a');
      link.href = url;
      link.download = 'ferry-diagnostics.json';
      link.click();
      setTimeout(() => {
        URL.revokeObjectURL(url);
      }, 1000);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not export diagnostics. Retry.');
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  return (
    <section className="grid gap-3" aria-label="Read-only diagnostics">
      <h3>Diagnostics</h3>
      <p className="muted">
        Export version, Gateway state and provider health for support. Credentials, paths, prompts,
        responses and configuration headers are excluded.
      </p>
      <div>
        <UiV2.Button variant="secondary" disabled={busy} onClick={() => void exportReport()}>
          {busy ? 'Exporting…' : 'Export sanitized diagnostics'}
        </UiV2.Button>
      </div>
      {report && (
        <p role="status">
          Exported Ferry {report.version} diagnostics. Gateway{' '}
          {report.gateway.running ? 'running' : 'stopped'};{' '}
          {report.providers.filter((row) => row.enabled).length} enabled connections.{' '}
          {report.mock ? 'Web preview fixture.' : 'Read from Core.'}
        </p>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
