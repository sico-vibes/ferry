// Run from the worktree: .\tools\pnpm.cmd exec tsx packages/optimizer/scripts/caveman-eval.mjs
import { MessageSchema } from '@ferry/shared';
import { compressCavemanMessages, estimateTokens } from '../src/index.ts';

const prose =
  'Hello, could you please review the configuration in order to identify each and every issue? I would like you to actually check the settings due to the fact that the application is currently failing. Furthermore, please make sure to inspect the database as well as the authentication setup for the purpose of finding the problem.';
const fixtures = [
  ['verbose conversation', prose, prose],
  [
    'fenced code',
    `${prose}\n\x60\x60\x60ts\nconst fooBar = 42;\n  return fooBar;\n\x60\x60\x60\n`,
    prose,
  ],
  [
    'paths and identifiers',
    `${prose}\nC:\\Users\\the\\app\\fooBar.ts /var/the/config.json USER_ID process.env.API_KEY 42`,
    prose,
  ],
  [
    'URLs and inline code',
    `${prose}\nhttps://example.org/the?q=actually \x60fooBar(42)\x60`,
    prose,
  ],
  [
    'JSON tool result',
    prose,
    JSON.stringify({ message: prose, nested: { enabled: true } }, null, 2),
  ],
  [
    'stack trace tool result',
    prose,
    `TypeError: the value is actually undefined\n    at fooBar (C:\\app\\a.ts:42:1)\n${prose}`,
  ],
  [
    'diff tool result',
    prose,
    `diff --git a/config.ts b/config.ts\n@@ -1 +1 @@\n-${prose}\n+const fooBar = 42;`,
  ],
  [
    'non-English conversation',
    'Bitte prufe die Datei und erklare den Fehler. '.repeat(8),
    'Necesito revisar el archivo y la configuracion. '.repeat(8),
  ],
  ['malformed fenced text', `${prose}\n\x60\x60\x60ts\nconst fooBar = 42;`, prose],
  ['plain file contents', prose, prose, 'read_file'],
];

const transcripts = fixtures.map(([name, history, output, tool = 'search'], index) => ({
  name,
  messages: [
    MessageSchema.parse({
      id: `message_old_${index}`,
      sessionId: 'session_eval',
      role: 'user',
      createdAt: '2026-10-08T00:00:00.000Z',
      modelRef: null,
      parts: [{ id: `part_old_${index}`, type: 'text', text: history }],
    }),
    MessageSchema.parse({
      id: `message_tool_${index}`,
      sessionId: 'session_eval',
      role: 'assistant',
      createdAt: '2026-10-08T00:00:01.000Z',
      modelRef: null,
      parts: [
        {
          id: `part_tool_${index}`,
          type: 'tool_call',
          tool,
          title: tool,
          args: tool === 'read_file' ? { path: 'README.md' } : { query: 'configuration' },
          status: 'succeeded',
          output: {
            text: output,
            filtered: false,
            originalTokens: null,
            filteredTokens: null,
            recoveryHandle: null,
          },
          changes: [],
          durationMs: null,
        },
      ],
    }),
    MessageSchema.parse({
      id: `message_latest_${index}`,
      sessionId: 'session_eval',
      role: 'user',
      createdAt: '2026-10-08T00:00:02.000Z',
      modelRef: null,
      parts: [
        {
          id: `part_latest_${index}`,
          type: 'text',
          text: `Keep the latest request intact. ${prose}`,
        },
      ],
    }),
  ],
}));

const tokens = (messages) =>
  messages.reduce(
    (total, message) =>
      total +
      message.parts.reduce(
        (sum, part) =>
          sum +
          estimateTokens(
            part.type === 'text'
              ? part.text
              : part.type === 'tool_call'
                ? (part.output?.text ?? '')
                : '',
          ),
        0,
      ),
    0,
  );
for (const level of ['lite', 'standard']) {
  let totalBefore = 0;
  let totalAfter = 0;
  console.log(`\n${level}: whole transcript text (including unchanged latest request)`);
  for (const { name, messages } of transcripts) {
    const result = compressCavemanMessages(messages, level);
    const before = tokens(messages);
    const after = tokens(result.messages);
    totalBefore += before;
    totalAfter += after;
    console.log(
      `${name}: ${before} -> ${after} tokens; saved ${before - after} (${(((before - after) / before) * 100).toFixed(1)}%)`,
    );
  }
  console.log(
    `TOTAL (10 transcripts): ${totalBefore} -> ${totalAfter}; saved ${totalBefore - totalAfter} (${(((totalBefore - totalAfter) / totalBefore) * 100).toFixed(1)}%)`,
  );
}
