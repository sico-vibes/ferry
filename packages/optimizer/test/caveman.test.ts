import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { MessageSchema, OptimizerTogglesSchema, ProfileSchema } from '@ferry/shared';
import { sampleProfile } from '@ferry/shared/testing';
import {
  cavemanCompress,
  cavemanOutputInstruction,
  compressCavemanMessages,
  estimateTokens,
  isCodeLike,
  preservedSpans,
  terseSystemText,
  type CavemanInputCache,
} from '../src/index.js';

const verbose =
  'Hello, could you please review the configuration in order to identify each and every issue? I would like you to actually check the settings due to the fact that the application is currently failing. Furthermore, please make sure to inspect the database as well as the authentication setup for the purpose of finding the problem.';

describe('Caveman prose compression', () => {
  it('shrinks verbose prose by at least 25 percent with real token estimates', () => {
    const result = cavemanCompress(verbose, { intensity: 'standard' });
    expect(result.applied).toBe(true);
    expect(result.afterTokens).toBe(estimateTokens(result.text));
    expect(result.beforeTokens).toBe(estimateTokens(verbose));
    expect(result.afterTokens).toBeLessThanOrEqual(result.beforeTokens * 0.75);
  });

  it.each(['lite', 'standard', 'aggressive'] as const)(
    '%s is deterministic and idempotent',
    (intensity) => {
      const first = cavemanCompress(verbose, { intensity });
      expect(cavemanCompress(verbose, { intensity })).toEqual(first);
      expect(cavemanCompress(first.text, { intensity }).text).toBe(first.text);
      fc.assert(
        fc.property(fc.string(), (text) => {
          const result = cavemanCompress(text, { intensity });
          expect(cavemanCompress(result.text, { intensity }).text).toBe(result.text);
          expect(result.afterTokens).toBeLessThanOrEqual(result.beforeTokens);
        }),
      );
      fc.assert(
        fc.property(
          fc.array(
            fc.constantFrom(
              'Please actually ',
              'the configuration ',
              'in order to ',
              'make sure to ',
              'and also ',
              'fooBar ',
              '`theConfig` ',
              'not ready. ',
              'it might fail. ',
            ),
            { minLength: 10, maxLength: 60 },
          ),
          (chunks) => {
            const result = cavemanCompress(chunks.join(''), { intensity });
            expect(cavemanCompress(result.text, { intensity }).text).toBe(result.text);
          },
        ),
      );
    },
  );

  it.each([
    '```ts\nconst theValue = "please actually the";\n  return theValue;\n```\n',
    '~~~~js\nconst fooBar = 42;\n```\n~~~~\n',
    '`theValue(42)`',
    'https://example.org/the/please?q=actually&count=42',
    '[the docs](https://example.org/the "please actually")',
    'C:\\Users\\the\\please\\fooBar.ts',
    'D:/the/please/fooBar.ts',
    '/var/the/please/config.json',
    './packages/the/file.ts',
    'packages/the/file.ts',
    '{\n  "the": "please actually",\n  "config": { "a": [1, 2, 42] }\n}',
    'TypeError: the value is actually undefined\n    at fooBar (C:\\app\\a.ts:42:1)',
    '42 3.14 50% 2026-10-08 1.2.3',
    'fooBar USER_ID process.env.API_KEY FooBar build_config',
    'git diff --stat\n',
    'echo the file is actually ready\n',
    'Get-Content C:\\Users\\the folder\\actually file.txt\n',
    '<instructions>please do not remove the constraints</instructions>',
  ])('preserves technical spans byte for byte: %s', (protectedText) => {
    const text = `${verbose}\n${protectedText}\n${verbose}`;
    const result = cavemanCompress(text, { intensity: 'standard' });
    expect(result.applied).toBe(true);
    expect(result.text).toContain(protectedText);
    for (const span of preservedSpans(text))
      expect(result.text).toContain(text.slice(span.start, span.end));
  });

  it('retains uncertainty, negations, and explicitly requested detail', () => {
    const text = `${verbose} Do not delete anything. It might possibly fail. Explain in detail.`;
    const result = cavemanCompress(text, { intensity: 'lite' });
    expect(result.text).toContain('Do not delete anything.');
    expect(result.text).toContain('It might possibly fail. Explain in detail.');
  });

  it.each([
    'Bitte aktualisiere die Datei und erklare den Fehler.',
    'Necesito que revises el archivo y la configuracion, por favor.',
    'Preciso que voce revise o arquivo e a configuracao.',
    'Je veux une explication de la configuration du fichier.',
    'Vorrei che controllassi il codice, grazie.',
    'Saya perlu bantuan untuk konfigurasi ini.',
    '请检查配置并保留所有内容。',
    'この設定を確認してください。',
    'Пожалуйста, проверьте настройки.',
    `${verbose} Bitte lass die Datei unverandert.`,
  ])('leaves non-English or mixed prose unchanged', (text) => {
    expect(cavemanCompress(text, { intensity: 'standard' }).text).toBe(text);
  });

  it.each([
    `${verbose}\n\x00invalid`,
    `${verbose}\n\x60\x60\x60ts\nconst foo = 1`,
    `${verbose}\n~~~~js\nfoo`,
    `${verbose}\n{"unclosed": [1,2]`,
  ])('fails open on malformed input', (text) => {
    expect(cavemanCompress(text, { intensity: 'standard' })).toMatchObject({
      text,
      applied: false,
    });
  });

  it('fails open on excessive shrink of short input', () => {
    const text = 'Please actually basically essentially simply currently please check it.';
    expect(cavemanCompress(text, { intensity: 'standard' })).toMatchObject({
      text,
      applied: false,
      skippedReason: 'excessive-short-text-shrink',
    });
  });
});

describe('Caveman provider context', () => {
  const message = (id: string, role: 'user' | 'assistant', parts: unknown[]) =>
    MessageSchema.parse({
      id,
      sessionId: 'session_caveman',
      role,
      createdAt: '2026-10-08T00:00:00.000Z',
      modelRef: null,
      parts,
    });
  const tool = (id: string, name: string, text: string, args = {}) => ({
    id,
    type: 'tool_call',
    tool: name,
    title: name,
    args,
    status: 'succeeded',
    output: {
      text,
      filtered: false,
      originalTokens: null,
      filteredTokens: null,
      recoveryHandle: null,
    },
    changes: [],
    durationMs: null,
  });

  it('compresses only old text and eligible tool prose, without mutating stored history', () => {
    const args = { query: verbose };
    const original = [
      message('message_old', 'user', [{ id: 'part_old', type: 'text', text: verbose }]),
      message('message_answer', 'assistant', [
        { id: 'part_answer', type: 'text', text: verbose },
        { id: 'part_reasoning', type: 'reasoning', text: verbose },
        tool('part_search', 'search', verbose, args),
        tool('part_read', 'read_file', verbose, { path: 'README.md' }),
        tool('part_remote_file', 'mcp_get_document', verbose, { filePath: 'README.md' }),
        tool('part_json', 'search', JSON.stringify({ message: verbose })),
        tool('part_logs', 'run', `INFO ${verbose}`),
        tool('part_diff', 'run', `diff --git a/test b/test\n-${verbose}`),
        tool('part_shell_file', 'run_command', verbose, { command: 'Get-Content README.md' }),
      ]),
      message('message_latest', 'user', [{ id: 'part_latest', type: 'text', text: verbose }]),
      message('message_current', 'assistant', [
        { id: 'part_current', type: 'text', text: verbose },
        tool('part_current_tool', 'search', verbose),
      ]),
    ];
    const snapshot = structuredClone(original);
    const result = compressCavemanMessages(original, 'standard');
    expect(original).toEqual(snapshot);
    expect(result.messages[0]?.parts[0]).not.toEqual(original[0]?.parts[0]);
    expect(result.messages[1]?.parts[0]).not.toEqual(original[1]?.parts[0]);
    expect(result.messages[1]?.parts[1]).toEqual(original[1]?.parts[1]);
    expect(result.messages[1]?.parts[2]).toMatchObject({
      args,
      output: { text: cavemanCompress(verbose, { intensity: 'standard' }).text },
    });
    expect(result.messages[1]?.parts.slice(3)).toEqual(original[1]?.parts.slice(3));
    expect(result.messages[2]).toEqual(original[2]);
    expect(result.messages[3]?.parts[0]).toEqual(original[3]?.parts[0]);
    expect(result.messages[3]?.parts[1]).not.toEqual(original[3]?.parts[1]);
    const measured = cavemanCompress(verbose, { intensity: 'standard' });
    expect(result.event).toEqual({
      kind: 'caveman-input',
      beforeTokens: measured.beforeTokens * 4,
      afterTokens: measured.afterTokens * 4,
      recoveryHandle: null,
    });
  });

  it('uses part ids with source and level validation in the session cache', () => {
    const cache: CavemanInputCache = new Map();
    const messages = [
      message('message_old', 'user', [{ id: 'part_old', type: 'text', text: verbose }]),
      message('message_latest', 'user', [
        { id: 'part_latest', type: 'text', text: 'Keep this exact.' },
      ]),
    ];
    const result = compressCavemanMessages(messages, 'lite', cache);
    const entry = cache.values().next().value;
    expect(compressCavemanMessages(messages, 'lite', cache)).toEqual(result);
    expect(cache.values().next().value).toBe(entry);
    compressCavemanMessages(messages, 'standard', cache);
    expect(cache.values().next().value).not.toBe(entry);
    const changed = structuredClone(messages);
    const part = changed[0]?.parts[0];
    if (part?.type === 'text') part.text += ' Please review it.';
    compressCavemanMessages(changed, 'standard', cache);
    expect(cache.values().next().value?.source).toBe(verbose + ' Please review it.');
    expect(compressCavemanMessages(messages, 'off', cache)).toEqual({ messages });
  });

  it('leaves short text and transcripts without a user boundary unchanged', () => {
    const messages = [
      message('message_short', 'assistant', [
        { id: 'part_short', type: 'text', text: 'Please check it.' },
      ]),
    ];
    expect(compressCavemanMessages(messages, 'standard')).toEqual({
      messages,
      event: { kind: 'caveman-input', beforeTokens: 0, afterTokens: 0, recoveryHandle: null },
    });
    expect(isCodeLike('const fooBar = 42;\nreturn fooBar;')).toBe(true);
  });

  it('measures assembled context and fails open if downstream trimming removes the savings', () => {
    const messages = [
      message('message_old', 'user', [{ id: 'part_old', type: 'text', text: verbose }]),
      message('message_latest', 'user', [
        { id: 'part_latest', type: 'text', text: 'Keep this exact.' },
      ]),
    ];
    const measure = (context: readonly (typeof messages)[number][]) =>
      estimateTokens(JSON.stringify(context));
    const result = compressCavemanMessages(messages, 'lite', new Map(), measure);
    expect(result.event).toMatchObject({
      beforeTokens: measure(messages),
      afterTokens: measure(result.messages),
    });
    let calls = 0;
    const noSavings = compressCavemanMessages(messages, 'lite', new Map(), () =>
      ++calls === 1 ? 100 : 101,
    );
    expect(noSavings).toEqual({
      messages,
      event: { kind: 'caveman-input', beforeTokens: 100, afterTokens: 100, recoveryHandle: null },
    });
  });
});

describe('Caveman configuration and output', () => {
  it('parses old stored profiles with input compression off', () => {
    const { cavemanInput: _input, ...old } = sampleProfile.optimizers;
    expect(OptimizerTogglesSchema.parse(old).cavemanInput).toBe('off');
    expect(ProfileSchema.parse({ ...sampleProfile, optimizers: old }).optimizers.cavemanInput).toBe(
      'off',
    );
  });

  it.each(['lite', 'full', 'ultra'] as const)(
    'exports the %s output contract with tool/file boundaries',
    (level) => {
      const instruction = cavemanOutputInstruction(level);
      expect(instruction).toContain(
        'Tool arguments, file contents, code, commands, and diffs: write normally and completely.',
      );
      expect(instruction).toContain(
        'Security warnings, irreversible action confirmations, multi-step ordered sequences: write normal.',
      );
      const capitalized = level === 'lite' ? 'Lite' : level === 'full' ? 'Full' : 'Ultra';
      expect(terseSystemText(capitalized)).toContain(instruction);
    },
  );

  it('distinguishes normal, sentences, fragments, and telegraphic modes', () => {
    expect(cavemanOutputInstruction('off')).toBe('');
    expect(cavemanOutputInstruction('lite')).toContain('Keep full sentences');
    expect(cavemanOutputInstruction('full')).toContain('Fragments OK');
    expect(cavemanOutputInstruction('ultra')).toContain('Telegraphic');
  });
});
