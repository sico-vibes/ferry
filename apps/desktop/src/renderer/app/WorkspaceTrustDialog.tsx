import { ConfirmDialog } from './ConfirmDialog';
import { useWorkspaceTrust } from '../state/workspaceTrust';

/** "Trust this folder?" — asked once per folder before Ferry reads or edits anything in it. */
export function WorkspaceTrustDialog() {
  const pending = useWorkspaceTrust((state) => state.pending);
  const answer = useWorkspaceTrust((state) => state.answer);
  return (
    <ConfirmDialog
      open={pending !== null}
      onOpenChange={(open) => {
        if (!open) answer(false);
      }}
      title={`Trust ${pending?.name ?? 'this folder'}?`}
      description="Ferry can read files here, and edit files or run commands when you approve them. It only looks at files when a task needs them."
      confirmLabel="Trust folder"
      onConfirm={() => {
        answer(true);
      }}
    >
      <p className="text-meta text-text-3 break-all">{pending?.path}</p>
      {pending?.riskyRoot ? (
        <p className="profile-locked-note" role="note">
          <span>
            This is a home folder or drive root. Ferry will work here, but opening a specific
            project folder keeps tasks focused and faster.
          </span>
        </p>
      ) : null}
    </ConfirmDialog>
  );
}
