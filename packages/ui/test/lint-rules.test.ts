import { Linter } from 'eslint';
import { describe, expect, it } from 'vitest';

const linter = new Linter();
const tokenRuleMessage = 'Use design tokens (packages/ui/src/styles/tokens.css)';

function tokenLintMessages(source: string): readonly Linter.LintMessage[] {
  return linter.verify(source, [
    {
      languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } },
      rules: {
        'no-restricted-syntax': [
          'error',
          {
            selector: 'Literal[value=/#[0-9a-fA-F]{3,8}\\b|\\brgba?\\(|\\bhsla?\\(/]',
            message: tokenRuleMessage,
          },
          {
            selector: 'TemplateElement[value.raw=/#[0-9a-fA-F]{3,8}\\b|\\brgba?\\(|\\bhsla?\\(/]',
            message: tokenRuleMessage,
          },
        ],
      },
    },
  ]);
}

function lintFile(source: string): readonly Linter.LintMessage[] {
  return linter.verify(source, [
    {
      languageOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        parserOptions: { ecmaFeatures: { jsx: true } },
      },
      rules: {
        'no-restricted-imports': [
          'error',
          {
            patterns: [
              {
                group: ['@ferry/*/src', '@ferry/*/src/**'],
                message: 'Import workspace packages through their public entry point.',
              },
            ],
          },
        ],
      },
    },
  ]);
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
  it('flags every supported raw color form in packages/ui/src', () => {
    const flagged = flaggedLines(tokenLintMessages(rawColorSource));
    expect(flagged).toEqual(rawColorLines.map(([, line]) => line));
  });

  it('does not flag non-color hash strings', () => {
    const messages = tokenLintMessages(
      "export const anchor = '#section-anchor';\nexport const issue = 'issue #12';\n",
    );
    expect(flaggedLines(messages)).toEqual([]);
  });
});

const deepImportCases: readonly string[] = [
  '@ferry/shared/src/index.js',
  '@ferry/shared/src',
  '@ferry/shared/src/foo',
  '@ferry/client/src/index.js',
];

describe('package boundary lint rules', () => {
  it('rejects deep imports into other workspace packages', () => {
    const source = [
      "import { a } from '@ferry/shared/src/index.js';",
      "import { b } from '@ferry/shared/src';",
      "import { c } from '@ferry/shared/src/foo';",
      "import { d } from '@ferry/client/src/index.js';",
      'export const values = [a, b, c, d];',
    ].join('\n');
    const messages = withRule(lintFile(source), 'no-restricted-imports');
    for (const specifier of deepImportCases) {
      expect(
        messages.some((message) => message.message.includes(specifier)),
        specifier,
      ).toBe(true);
    }
  });

  it('allows the public entry and declared subpath specifiers', () => {
    const source = [
      "import { WorkspaceIdSchema } from '@ferry/shared';",
      "import { testing } from '@ferry/shared/testing';",
      'export const values = [WorkspaceIdSchema, testing];',
    ].join('\n');
    const messages = withRule(lintFile(source), 'no-restricted-imports');
    expect(messages).toEqual([]);
  });
});
