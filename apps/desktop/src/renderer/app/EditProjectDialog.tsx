import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, X } from 'lucide-react';
import type { Workspace, WorkspaceSettings } from '@ferry/shared';
import { Select, UiV2 } from '@ferry/ui';
import { useFerryClient } from '../data/client';
import { keys, useProfiles, useWorkspaces } from '../data/queries';
import { useProjectDialogs } from '../state/projectDialogs';
import { useToasts } from '../state/toasts';

/** Edit project: name and the project settings that used to live on the Library page. */
export function EditProjectDialog() {
  const editing = useProjectDialogs((state) => state.editing);
  const close = useProjectDialogs((state) => state.close);
  const { data: workspaces = [] } = useWorkspaces();
  const project = editing ? workspaces.find((workspace) => workspace.id === editing) : undefined;
  return (
    <UiV2.Dialog
      open={Boolean(project)}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <UiV2.DialogContent className="v2-edit-project-dialog">
        {project ? <EditProjectForm key={project.id} project={project} onDone={close} /> : null}
      </UiV2.DialogContent>
    </UiV2.Dialog>
  );
}

function EditProjectForm({ project, onDone }: { project: Workspace; onDone: () => void }) {
  const client = useFerryClient();
  const cache = useQueryClient();
  const pushToast = useToasts((state) => state.push);
  const { data: profiles = [] } = useProfiles();
  const { data: lanes = [] } = useQuery({
    queryKey: ['lanes', project.id],
    queryFn: () => client.delegation.lanes(),
  });
  const [name, setName] = useState(project.name);
  const [settings, setSettings] = useState<WorkspaceSettings>(project.settings);
  const [gate, setGate] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    setName(project.name);
    setSettings(project.settings);
  }, [project]);
  const projectLanes = lanes.filter((lane) => lane.source === 'project');
  const update = <K extends keyof WorkspaceSettings>(key: K, value: WorkspaceSettings[K]) => {
    setSettings((current) => ({ ...current, [key]: value }));
  };
  const save = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setSaving(true);
    try {
      await client.workspaces.update(project.id, { name: trimmed, settings });
      await cache.invalidateQueries({ queryKey: keys.workspaces });
      await cache.invalidateQueries({ queryKey: keys.sessions });
      onDone();
    } catch (error) {
      pushToast({
        kind: 'error',
        title: 'Project could not be saved',
        body: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setSaving(false);
    }
  };
  return (
    <form
      className="grid gap-5"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <UiV2.DialogHeader>
        <UiV2.DialogTitle>Edit project</UiV2.DialogTitle>
        <UiV2.DialogDescription className="truncate" title={project.path}>
          {project.path}
        </UiV2.DialogDescription>
      </UiV2.DialogHeader>
      <label className="v2-project-form-row">
        <span>Name</span>
        <UiV2.Input
          aria-label="Project name"
          value={name}
          onChange={(event) => {
            setName(event.currentTarget.value);
          }}
        />
      </label>
      <div className="v2-project-form-row">
        <span>Instructions file</span>
        <Select
          label="Instructions file"
          value={settings.instructionsFile ?? 'none'}
          onValueChange={(value) => {
            update('instructionsFile', value === 'none' ? null : value);
          }}
          options={[
            { value: 'none', label: 'None' },
            ...['AGENTS.md', 'FERRY.md', 'CLAUDE.md'].map((file) => ({ value: file, label: file })),
          ]}
        />
      </div>
      <div className="v2-project-form-row">
        <span>Default profile</span>
        <Select
          label="Default profile"
          value={settings.defaultProfileId ?? 'default'}
          onValueChange={(value) => {
            update(
              'defaultProfileId',
              value === 'default' ? null : (value as WorkspaceSettings['defaultProfileId']),
            );
          }}
          options={[
            { value: 'default', label: 'Use app default' },
            ...profiles.map((profile) => ({ value: profile.id, label: profile.name })),
          ]}
        />
      </div>
      <div className="v2-project-form-row">
        <span>Permissions</span>
        <Select
          label="Permission mode"
          value={settings.permissionMode}
          onValueChange={(value) => {
            update('permissionMode', value as WorkspaceSettings['permissionMode']);
          }}
          options={[
            { value: 'ask', label: 'Ask before each action' },
            { value: 'auto_edit', label: 'Edit files, ask before commands' },
            { value: 'full_auto', label: 'Run automatically' },
          ]}
        />
      </div>
      <section className="v2-project-subsection">
        <div>
          <h3>Gate commands</h3>
          <p>Commands Ferry runs before a change is ready.</p>
        </div>
        {settings.gateCommands.length > 0 && (
          <ul className="v2-gate-list">
            {settings.gateCommands.map((command) => (
              <li key={command}>
                <code>{command}</code>
                <button
                  type="button"
                  aria-label={`Remove ${command}`}
                  onClick={() => {
                    update(
                      'gateCommands',
                      settings.gateCommands.filter((item) => item !== command),
                    );
                  }}
                >
                  <X aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="v2-gate-add">
          <UiV2.Input
            aria-label="Add gate command"
            placeholder="Add a command, e.g. pnpm test"
            value={gate}
            onChange={(event) => {
              setGate(event.currentTarget.value);
            }}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return;
              event.preventDefault();
              const value = gate.trim();
              if (value && !settings.gateCommands.includes(value))
                update('gateCommands', [...settings.gateCommands, value]);
              setGate('');
            }}
          />
          <UiV2.Button
            type="button"
            variant="secondary"
            size="icon"
            aria-label="Add gate command"
            onClick={() => {
              const value = gate.trim();
              if (value && !settings.gateCommands.includes(value))
                update('gateCommands', [...settings.gateCommands, value]);
              setGate('');
            }}
          >
            <Plus aria-hidden="true" />
          </UiV2.Button>
        </div>
      </section>
      {projectLanes.length > 0 && (
        <section className="v2-project-subsection">
          <div>
            <h3>Project lanes</h3>
            <p>Delegation lanes this project provides. Approve them before Ferry uses them.</p>
          </div>
          <ul className="v2-lane-list">
            {projectLanes.map((lane) => (
              <li key={lane.name}>
                <span>
                  <strong>{lane.name}</strong>
                  <small>
                    {lane.implementer}
                    {lane.model ? ` / ${lane.model}` : ''}
                  </small>
                </span>
                <span className={lane.trusted ? 'v2-lane-trusted' : 'v2-lane-pending'}>
                  {lane.trusted ? 'Trusted' : 'Needs approval'}
                </span>
              </li>
            ))}
          </ul>
          {!projectLanes.every((lane) => lane.trusted) && (
            <UiV2.Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() =>
                void client.delegation
                  .approveProjectLanes()
                  .then(() => cache.invalidateQueries({ queryKey: ['lanes'] }))
              }
            >
              Approve project lanes
            </UiV2.Button>
          )}
        </section>
      )}
      <section className="v2-project-subsection">
        <div>
          <h3>Project config</h3>
          <p>Approve .ferry/config.json so its permission rules and gates apply.</p>
        </div>
        <UiV2.Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() =>
            void client.delegation.approveProjectConfig().then((result) => {
              pushToast(
                result.approved
                  ? { kind: 'success', title: 'Project config approved', body: null }
                  : { kind: 'error', title: 'No project config found', body: null },
              );
            })
          }
        >
          Approve project config
        </UiV2.Button>
      </section>
      <div className="v2-library-dialog-actions">
        <UiV2.Button type="button" variant="secondary" onClick={onDone}>
          Cancel
        </UiV2.Button>
        <UiV2.Button type="submit" disabled={saving || !name.trim()}>
          {saving ? 'Saving…' : 'Save'}
        </UiV2.Button>
      </div>
    </form>
  );
}
