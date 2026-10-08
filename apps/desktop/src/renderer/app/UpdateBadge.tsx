import { useEffect, useState } from 'react';
import { AlertTriangle, ArrowDownCircle, Loader2, RotateCw } from 'lucide-react';
import type { UpdateSnapshot } from '../../main/update-state.js';
import { useUI } from '../state/ui';

/**
 * Title-bar update pill, next to the window buttons. Hidden unless an update is on its way:
 * "Update available" downloads it, then "Restart to update" installs it.
 */
/** Live updater state from the main process, plus a "user clicked" busy flag. */
export function useUpdateState() {
  const [state, setState] = useState<UpdateSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const host = window.ferryHost;
    if (!host) return;
    let active = true;
    void host.getUpdateState().then((next) => {
      if (active) setState(next);
    });
    const off = host.onUpdateState((next) => {
      setState(next);
      setBusy(false);
    });
    return () => {
      active = false;
      off();
    };
  }, []);
  return { state, busy, setBusy };
}

/**
 * Sidebar footer line, like Claude's: "Downloading update…" while it downloads, then a
 * "Restart to update" action. Hidden when there is nothing to do.
 */
export function SidebarUpdateRow() {
  const { state, busy, setBusy } = useUpdateState();
  if (!state?.version || (state.status !== 'available' && state.status !== 'downloaded'))
    return null;
  const downloaded = state.status === 'downloaded';
  const downloading = !downloaded && (state.autoDownload || busy);
  if (downloading)
    return (
      <div className="v2-sidebar-update" role="status">
        <Loader2 aria-hidden="true" className="animate-spin motion-reduce:animate-none" />
        <span>Downloading update…</span>
      </div>
    );
  return (
    <button
      className="v2-sidebar-update is-action"
      onClick={() => {
        setBusy(true);
        if (downloaded) void window.ferryHost?.installUpdate();
        else void window.ferryHost?.downloadUpdate();
      }}
      title={`Ferry ${state.version}`}
      type="button"
    >
      {downloaded ? <RotateCw aria-hidden="true" /> : <ArrowDownCircle aria-hidden="true" />}
      <span>{downloaded ? 'Restart to update' : `Update to ${state.version}`}</span>
    </button>
  );
}

export function UpdateBadge() {
  const { state, busy, setBusy } = useUpdateState();
  if (state?.status === 'error' && state.version)
    return (
      <button
        type="button"
        className="v2-update-badge"
        data-state="failed"
        title={state.error ?? 'The update could not be installed.'}
        onClick={() => {
          useUI.getState().openSettings('About');
        }}
      >
        <AlertTriangle aria-hidden="true" />
        Update failed
      </button>
    );
  if (!state?.version || (state.status !== 'available' && state.status !== 'downloaded'))
    return null;
  const downloaded = state.status === 'downloaded';
  const downloading = !downloaded && (state.autoDownload || busy);
  const label = downloaded
    ? 'Restart to update'
    : downloading
      ? 'Downloading update'
      : 'Update available';
  return (
    <button
      type="button"
      className="v2-update-badge"
      data-state={downloaded ? 'ready' : downloading ? 'downloading' : 'available'}
      disabled={downloading}
      title={`Ferry ${state.version}`}
      onClick={() => {
        setBusy(true);
        if (downloaded) void window.ferryHost?.installUpdate();
        else void window.ferryHost?.downloadUpdate();
      }}
    >
      {downloaded ? (
        <RotateCw aria-hidden="true" />
      ) : downloading ? (
        <Loader2 aria-hidden="true" className="animate-spin" />
      ) : (
        <ArrowDownCircle aria-hidden="true" />
      )}
      {label}
    </button>
  );
}
