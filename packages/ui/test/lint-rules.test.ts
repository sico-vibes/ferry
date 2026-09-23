import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import type { Linter } from 'eslint';
import { describe, expect, it } from 'vitest';

const packageDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(packageDirectory, '../../..');
const fixtureDirectory = resolve(repositoryRoot, 'packages/ui/src/__lint_fixture__');

const eslint = new ESLint({ cwd: repositoryRoot, ignore: false });
const tokenRuleMessage = 'Use design tokens (packages/ui/src/styles/tokens.css)';

// typescript-eslint's project service allows at most 8 in-memory files in the
// default project, so each probe file is linted exactly once and cached.
const lintCache = new Map<string, Promise<readonly Linter.LintMessage[]>>();

function lintFile(fileName: string, source: string): Promise<readonly Linter.LintMessage[]> {
  const cached = lintCache.get(fileName);
  if (cached !== undefined) {
    return cached;
  }
  const pending = eslint
    .lintText(source, { filePath: resolve(fixtureDirectory, fileName) })
    .then(([result]) => result?.messages ?? []);
  lintCache.set(fileName, pending);
  return pending;
}

function withRule(
  messages: readonly Linter.LintMessage[],
  ruleId: string,
): readonly Linter.LintMessage[] {
  return messages.filter((message) => message.ruleId === ruleId);
}

function flaggedLines(messages: readonly Linter.LintMessage[]): readonly number[] {
  return messages
    .filter(
      (message) =>
        message.ruleId === 'no-restricted-syntax' && message.message.includes(tokenRuleMessage),
    )
    .map((message) => message.line)
    .sort((a, b) => a - b);
}

const rawColorLines: readonly (readonly [string, number])[] = [
  ['short hex literal', 1],
  ['six-digit hex literal', 2],
  ['eight-digit hex literal', 3],
  ['rgba() literal', 4],
  ['rgb() literal', 5],
  ['hsl() literal', 6],
  ['tailwind arbitrary color class', 7],
  ['template literal color', 8],
];

const rawColorSource = [
  "export const shortHex = '#fff';",
  "export const sixHex = '#1C1D20';",
  "export const eightHex = '#1C1D20AA';",
  "export const rgbaValue = 'rgba(255, 255, 255, 0.5)';",
  "export const rgbValue = 'rgb(1, 2, 3)';",
  "export const hslValue = 'hsl(1, 2%, 3%)';",
  'export const element = <div className="bg-[#fff]" />;',
  'export const templateValue = `color: #abc`;',
].join('\n');

describe('raw color lint rule', () => {
  it('flags every supported raw color form in packages/ui/src', async () => {
    const flagged = flaggedLines(await lintFile('raw-colors.tsx', rawColorSource));
    expect(flagged).toEqual(rawColorLines.map(([, line]) => line));
  });

  it('does not flag raw colors inside test files', async () => {
    const messages = await lintFile('raw-colors.test.tsx', "export const color = '#fff';\n");
    expect(flaggedLines(messages)).toEqual([]);
  });

  it('does not flag non-color hash strings', async () => {
    const messages = await lintFile(
      'non-color-strings.tsx',
      "export const anchor = '#section-anchor';\nexport const issue = 'issue #12';\n",
    );
    expect(flaggedLines(messages)).toEqual([]);
  });

  it('does not flag the design token stylesheet', async () => {
    const [result] = await eslint.lintText('--probe: #fff;\n', {
      filePath: resolve(repositoryRoot, 'packages/ui/src/styles/tokens.css'),
    });
    expect(flaggedLines(result?.messages ?? [])).toEqual([]);
  });
});

const deepImportCases: readonly string[] = [
  '@ferry/shared/src/index.js',
  '@ferry/shared/src',
  '@ferry/shared/src/foo',
  '@ferry/client/src/index.js',
];

describe('package boundary lint rules', () => {
  it('rejects deep imports into other workspace packages', async () => {
    const source = [
      "import { a } from '@ferry/shared/src/index.js';",
      "import { b } from '@ferry/shared/src';",
      "import { c } from '@ferry/shared/src/foo';",
      "import { d } from '@ferry/client/src/index.js';",
      'export const values = [a, b, c, d];',
    ].join('\n');
    const messages = withRule(await lintFile('deep-imports.tsx', source), 'no-restricted-imports');
    for (const specifier of deepImportCases) {
      expect(
        messages.some((message) => message.message.includes(specifier)),
        specifier,
      ).toBe(true);
    }
  });

  it('allows the public entry and declared subpath specifiers', async () => {
    const source = [
      "import { WorkspaceIdSchema } from '@ferry/shared';",
      "import { testing } from '@ferry/shared/testing';",
      'export const values = [WorkspaceIdSchema, testing];',
    ].join('\n');
    const messages = withRule(
      await lintFile('public-imports.tsx', source),
      'no-restricted-imports',
    );
    expect(messages).toEqual([]);
  });

  it('rejects relative imports that cross package boundaries', async () => {
    const source =
      "import { FERRY_PROTOCOL_VERSION } from '../../../shared/src/index.ts';\nexport const value = FERRY_PROTOCOL_VERSION;\n";
    const messages = withRule(
      await lintFile('relative-cross-package.tsx', source),
      'import-x/no-relative-packages',
    );
    expect(messages.length).toBeGreaterThan(0);
  });
});
