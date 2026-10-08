import React, { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, cleanup } from 'ink-testing-library';
import { createMockFerryClient } from '@ferry/client';
import { MessagePartSchema, newId, type Session } from '@ferry/shared';
import { Picker, type PickerOption } from '../src/components/picker.js';
import { Composer, commandMatches } from '../src/components/composer.js';
import { StatusBar } from '../src/components/status-bar.js';
import { SettingsPanel } from '../src/components/settings-panel.js';
import { Transcript } from '../src/components/transcript.js';
import {
  effortOptions,
  modelOptions,
  profileOptions,
  projectOptions,
  sessionOptions,
} from '../src/picker-options.js';
import { Chat } from '../src/tui.js';
import { fileMentions } from '../src/attachments.js';

type App = ReturnType<typeof render>;
function fixture<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Missing fixture');
  return value;
}
async function frame(app: App, value: string) {
  await vi.waitFor(
    () => {
      expect(app.lastFrame()).toContain(value);
    },
    { timeout: 3000, interval: 10 },
  );
}
async function key(app: App, value: string) {
  await new Promise((resolve) => setTimeout(resolve, 40));
  app.stdin.write(value);
  await new Promise((resolve) => setTimeout(resolve, 40));
}
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('interactive pickers', () => {
  it('keeps every rapid arrow press before Enter', async () => {
    const selected = vi.fn();
    const app = render(
      <Picker
        title="model"
        options={[
          { value: 'auto', label: 'Auto' },
          { value: 'none', label: 'No profile' },
          { value: 'model', label: 'Verified model' },
        ]}
        onSelect={selected}
        onClose={() => undefined}
      />,
    );
    await frame(app, 'Auto');
    await new Promise((resolve) => setTimeout(resolve, 40));
    app.stdin.write('\x1b[B');
    app.stdin.write('\x1b[B');
    app.stdin.write('\r');
    await vi.waitFor(() => {
      expect(selected).toHaveBeenCalledWith('model');
    });
  });
  it.each(['model', 'profile', 'effort', 'sessions', 'project'])(
    '%s supports arrows, filter, select and Esc',
    async (title) => {
      const client = createMockFerryClient();
      const models = await client.models.list();
      const workspaces = await client.workspaces.list();
      const options =
        title === 'profile'
          ? profileOptions(await client.profiles.list())
          : title === 'project'
            ? projectOptions(workspaces)
            : title === 'sessions'
              ? sessionOptions(await client.sessions.search(), workspaces)
              : title === 'effort'
                ? effortOptions({ ...fixture(models[0]), reasoningEfforts: ['low', 'high'] })
                : await modelOptions(client);
      expect(options.length).toBeGreaterThanOrEqual(2);
      const selected = vi.fn();
      const close = vi.fn();
      const app = render(
        <Picker title={title} options={options} onSelect={selected} onClose={close} />,
      );
      await frame(app, 'type to search');
      await key(app, '\x1b[B');
      await key(app, '\r');
      expect(selected).toHaveBeenLastCalledWith(options[1]?.value);
      await key(app, '\x1b[A');
      await key(app, '\r');
      expect(selected).toHaveBeenLastCalledWith(options[0]?.value);
      await key(app, options[1]?.label ?? '');
      await frame(app, `Filter: ${options[1]?.label ?? ''}`);
      await key(app, '\r');
      expect(selected).toHaveBeenLastCalledWith(options[1]?.value);
      await key(app, '\x1b');
      expect(close).toHaveBeenCalledOnce();
      app.unmount();
    },
  );

  it('model listing includes only verified connected models plus non-revoked Gateway keys', async () => {
    const client = createMockFerryClient();
    const model = fixture((await client.models.list())[0]);
    const providers = await client.providers.list();
    vi.spyOn(client.providers, 'list').mockResolvedValue(
      providers.map((row) => ({ ...row, enabled: true, keyStatus: 'valid' })),
    );
    vi.spyOn(client.models, 'list').mockResolvedValue([
      { ...model, verified: true, free: true },
      { ...model, ref: 'custom/unverified' as typeof model.ref, verified: false },
    ]);
    const gateway = await client.gateway.createKey({ name: 'Local key', profile: 'auto' });
    const options = await modelOptions(client);
    expect(
      options.some(
        (row) =>
          row.value === model.ref &&
          row.description?.includes('free') &&
          row.description.includes('context'),
      ),
    ).toBe(true);
    expect(options.some((row) => row.value === 'custom/unverified')).toBe(false);
    expect(options.some((row) => row.value === `gateway/${gateway.key.id}`)).toBe(true);
    await client.gateway.revokeKey(gateway.key.id);
    expect(
      (await modelOptions(client)).some((row) => row.value === `gateway/${gateway.key.id}`),
    ).toBe(false);
  });

  it('Tab toggles free-only and an empty filter gives an actionable state', async () => {
    const rows: PickerOption[] = [
      { value: 'auto', label: 'Auto' },
      { value: 'paid', label: 'Paid', free: false },
      { value: 'free', label: 'Free', free: true },
    ];
    function ModelPicker() {
      const [freeOnly, setFreeOnly] = useState(false);
      return (
        <Picker
          title="model"
          options={rows}
          onSelect={() => undefined}
          onClose={() => undefined}
          freeOnly={freeOnly}
          onFreeOnly={setFreeOnly}
        />
      );
    }
    const app = render(<ModelPicker />);
    await frame(app, 'Paid');
    await key(app, '\t');
    await frame(app, 'Free-only on');
    expect(app.lastFrame()).not.toContain('Paid');
    await key(app, 'missing');
    await frame(app, 'No matches.');
  });

  it('effort is available only for advertised effort values', () => {
    expect(effortOptions(undefined)).toEqual([]);
  });
});

describe('composer', () => {
  function mount(secret = false, files: { name: string; path: string }[] = []) {
    const submit = vi.fn();
    const attach = vi.fn();
    function Input() {
      const [value, change] = useState('');
      return (
        <Composer
          value={value}
          onChange={change}
          onSubmit={(text) => {
            submit(text);
            change('');
          }}
          secret={secret}
          files={files}
          onFile={attach}
        />
      );
    }
    return { app: render(<Input />), submit, attach };
  }
  it('autocomplete shows descriptions, filters and completes with arrows and Tab', async () => {
    const { app, submit } = mount();
    await key(app, '/');
    await frame(app, 'Choose a verified model');
    await key(app, '\x1b[B');
    await key(app, '\t');
    await frame(app, '› /profile');
    await key(app, '\r');
    expect(submit).toHaveBeenCalledWith('/profile');
    expect(commandMatches('/mod').map((row) => row.name)).toEqual(['/model']);
    expect(commandMatches('/model ref')).toEqual([]);
  });
  it('history restores the draft with Up/Down', async () => {
    const { app, submit } = mount();
    await key(app, 'first\r');
    await key(app, 'second\r');
    await key(app, 'draft');
    await key(app, '\x1b[A');
    await frame(app, '› second');
    await key(app, '\x1b[A');
    await frame(app, '› first');
    await key(app, '\x1b[B');
    await key(app, '\x1b[B');
    await frame(app, '› draft');
    expect(submit).toHaveBeenCalledTimes(2);
  });
  it('keeps browsing history when recalled entries are slash commands', async () => {
    const { app } = mount();
    await key(app, '/help\r');
    await key(app, '/status\r');
    await key(app, '\x1b[A');
    await frame(app, '› /status');
    await key(app, '\x1b[A');
    await frame(app, '› /help');
  });
  it('Alt+Enter adds a newline and Enter sends the complete multiline value', async () => {
    const { app, submit } = mount();
    await key(app, 'first');
    await key(app, '\x1b\r');
    await key(app, 'second');
    expect(submit).not.toHaveBeenCalled();
    await key(app, '\r');
    expect(submit).toHaveBeenCalledWith('first\nsecond');
  });
  it('Shift+Enter in a terminal with extended key reporting inserts a newline', async () => {
    const { app, submit } = mount();
    await key(app, 'first');
    await key(app, '\x1b[13;2u');
    await key(app, 'second');
    expect(submit).not.toHaveBeenCalled();
    await key(app, '\r');
    expect(submit).toHaveBeenCalledWith('first\nsecond');
  });
  it('multiline and bracketed paste never send without Enter', async () => {
    const { app, submit } = mount();
    await key(app, 'first\nsecond\n');
    expect(submit).not.toHaveBeenCalled();
    await key(app, '\x1b[200~third\n');
    await key(app, 'fourth\n\x1b[201~');
    expect(submit).not.toHaveBeenCalled();
    await key(app, '\r');
    expect(submit).toHaveBeenCalledWith('first\nsecond\nthird\nfourth\n');
  });
  it('file completion attaches the selected file', async () => {
    const { app, attach } = mount(false, [{ name: 'main.ts', path: 'src/main.ts' }]);
    await key(app, '@ma');
    await frame(app, '@src/main.ts');
    await key(app, '\t');
    expect(attach).toHaveBeenCalledWith('src/main.ts');
    await frame(app, '› @src/main.ts');
    expect(fileMentions('read @src/main.ts and @"with space.ts" @src/main.ts')).toEqual([
      'src/main.ts',
      'with space.ts',
    ]);
  });
  it('scrolls file completion to keep later selections visible', async () => {
    const files = Array.from({ length: 20 }, (_, index) => ({
      name: `file-${String(index)}.ts`,
      path: `file-${String(index)}.ts`,
    }));
    const { app, attach } = mount(false, files);
    await key(app, '@');
    for (let index = 0; index < 12; index++) await key(app, '\x1b[B');
    await frame(app, '› @file-12.ts');
    await key(app, '\t');
    expect(attach).toHaveBeenCalledWith('file-12.ts');
  });
  it('secrets are masked and excluded from history', async () => {
    const { app, submit } = mount(true);
    await key(app, 'password');
    expect(app.lastFrame()).not.toContain('password');
    await key(app, '\r');
    await key(app, '\x1b[A');
    expect(submit).toHaveBeenCalledWith('password');
    expect(app.lastFrame()).not.toContain('••••');
  });
});

describe('settings and transcript status', () => {
  it('expands collapsed tool output with Ctrl+T', async () => {
    const part = MessagePartSchema.parse({
      type: 'tool_call',
      id: newId('part'),
      title: 'Read file',
      tool: 'read',
      args: { path: 'main.ts' },
      status: 'succeeded',
      output: {
        text: 'full tool output',
        filtered: false,
        originalTokens: null,
        filteredTokens: null,
        recoveryHandle: null,
      },
      changes: [],
      durationMs: 1,
    });
    const app = render(<Transcript entries={[{ id: part.id, part }]} offset={0} enabled />);
    expect(app.lastFrame()).toContain('Read file');
    expect(app.lastFrame()).not.toContain('full tool output');
    await key(app, '\x14');
    await frame(app, 'full tool output');
    await key(app, '\x14');
    expect(app.lastFrame()).not.toContain('full tool output');
  });
  it('handles inline y/n/a approvals and Esc cancels the current run', async () => {
    const client = createMockFerryClient();
    const subscriptions = vi.spyOn(client, 'on');
    vi.spyOn(client.sessions, 'send').mockResolvedValue();
    const cancel = vi.spyOn(client.sessions, 'cancel').mockResolvedValue();
    const respond = vi.spyOn(client.approvals, 'respond').mockResolvedValue();
    const profile = (await client.profiles.list())[0];
    const app = render(<Chat client={client} workspace={null} profile={profile} />);
    await key(app, 'hello\r');
    await frame(app, 'you: hello');
    const session = fixture((await client.sessions.list({ workspaceId: null }))[0]);
    const update = subscriptions.mock.calls.find(([event]) => event === 'session.updated')?.[1] as
      ((value: Session) => void) | undefined;
    const partEvent = subscriptions.mock.calls.find(([event]) => event === 'session.part')?.[1] as
      | ((value: {
          sessionId: Session['id'];
          messageId: string;
          part: ReturnType<typeof MessagePartSchema.parse>;
        }) => void)
      | undefined;
    if (!update || !partEvent) throw new Error('Missing subscriptions');
    for (const [input, decision] of [
      ['y', 'allow_once'],
      ['n', 'deny'],
      ['a', 'allow_always'],
    ]) {
      update({ ...session, status: 'awaiting_approval' });
      const part = MessagePartSchema.parse({
        type: 'approval_request',
        id: newId('part'),
        kind: 'command',
        summary: 'Run command',
        detail: 'Command details',
        risk: 'low',
        state: 'pending',
      });
      partEvent({ sessionId: session.id, messageId: 'message', part });
      await frame(app, '[y] allow');
      await key(app, input ?? '');
      expect(respond).toHaveBeenLastCalledWith(session.id, part.id, decision);
    }
    update({ ...session, status: 'running' });
    await key(app, '\x1b');
    expect(cancel).toHaveBeenCalledWith(session.id);
  });
  it('saves notifications and theme through settings.update and Esc returns then closes', async () => {
    const client = createMockFerryClient();
    const close = vi.fn();
    const app = render(<SettingsPanel client={client} onClose={close} />);
    await frame(app, 'Theme: dark');
    await key(app, 'notifications');
    await key(app, '\r');
    await frame(app, 'Settings / notifications');
    await key(app, '\x1b[B');
    await key(app, '\r');
    await frame(app, 'Notifications: off');
    expect((await client.settings.get()).notifications).toBe(false);
    await key(app, '\r');
    await frame(app, 'Settings / theme');
    await key(app, '\r');
    await frame(app, 'Theme: system');
    expect((await client.settings.get()).theme).toBe('system');
    await key(app, '\r');
    await key(app, '\x1b');
    await frame(app, 'Default profile:');
    await key(app, '\x1b');
    expect(close).toHaveBeenCalledOnce();
  });
  it('status uses active-provider limits, usage and health, with No project fallback', async () => {
    const client = createMockFerryClient();
    const limits = await client.quota.limits();
    const health = await client.providers.health();
    const app = render(
      <StatusBar
        profile="Auto-Free"
        model="groq/fixture"
        effort="high"
        contextTokens={2500}
        contextWindow={10000}
        replyTokens={125}
        health={health}
        limits={limits}
      />,
    );
    const output = app.lastFrame()?.replace(/\s+/g, ' ');
    expect(output).toContain('No project');
    expect(output).toContain('Auto-Free');
    expect(output).toContain('groq/fixture');
    expect(output).toContain('high');
    expect(output).toContain('context 25%');
    expect(output).toContain('last reply 125 tokens');
    expect(output).toContain('●');
    expect(output).not.toContain('saved 38%');
    expect(output).not.toContain('steps');
  });
  it('keeps more than 18 entries and renders code blocks and via attribution', () => {
    const app = render(
      <Transcript
        entries={[
          ...Array.from({ length: 30 }, (_, index) => ({
            id: String(index),
            text: `entry ${String(index)}`,
          })),
          {
            id: 'reply',
            role: 'assistant',
            text: '```ts\nconst answer = 42;\n```',
            via: 'groq/model',
          },
        ]}
        offset={0}
        enabled={false}
      />,
    );
    expect(app.lastFrame()).toContain('entry 0');
    expect(app.lastFrame()).toContain('entry 29');
    expect(app.lastFrame()).toContain('const answer');
    expect(app.lastFrame()).toContain('via groq/model');
  });
  it('/new asks for a project, starts a Recent and /clear preserves No project', async () => {
    const client = createMockFerryClient();
    const workspace = fixture((await client.workspaces.list())[0]);
    const profile = (await client.profiles.list())[0];
    const create = vi.spyOn(client.sessions, 'create');
    const app = render(<Chat client={client} workspace={workspace} profile={profile} />);
    await key(app, '/new\r');
    await frame(app, 'New chat / choose project');
    await key(app, '\r');
    await frame(app, 'Started a fresh chat.');
    expect(create).toHaveBeenLastCalledWith(expect.objectContaining({ workspaceId: null }));
    await key(app, '/clear\r');
    await vi.waitFor(() => {
      expect(create).toHaveBeenCalledTimes(2);
    });
    expect(create).toHaveBeenLastCalledWith(expect.objectContaining({ workspaceId: null }));
  });
});
