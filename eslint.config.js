import eslint from '@eslint/js';
import importPlugin from 'eslint-plugin-import-x';
import tseslint from 'typescript-eslint';

const tokenMessage = 'Use design tokens (packages/ui/src/styles/tokens.css) instead of raw colors.';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'out/**',
      'coverage/**',
      '.turbo/**',
      'node_modules/**',
      'design/**',
      'scripts/**',
      'packages/ui/src/__lint_fixture__/**',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ['packages/ui/src/__lint_fixture__/*.tsx'],
        },
      },
    },
  },
  {
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: { sourceType: 'module' },
  },
  {
    plugins: { 'import-x': importPlugin },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      'import-x/no-relative-packages': 'error',
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
  {
    files: ['packages/ui/src/**/*.{ts,tsx}', 'apps/**/src/**/*.{ts,tsx}'],
    ignores: ['**/*.test.ts', '**/*.test.tsx'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'Literal[value=/#[0-9a-fA-F]{3,8}\\b|\\brgba?\\(|\\bhsla?\\(/]',
          message: tokenMessage,
        },
        {
          selector: 'TemplateElement[value.raw=/#[0-9a-fA-F]{3,8}\\b|\\brgba?\\(|\\bhsla?\\(/]',
          message: tokenMessage,
        },
      ],
    },
  },
);
