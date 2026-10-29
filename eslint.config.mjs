import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import { flatConfigs as importConfigs } from 'eslint-plugin-import-x';
import promise from 'eslint-plugin-promise';
import { configs as regexpConfigs } from 'eslint-plugin-regexp';
import security from 'eslint-plugin-security';
import { configs as sonarConfigs } from 'eslint-plugin-sonarjs';
import unicorn from 'eslint-plugin-unicorn';
import globals from 'globals';
import { configs as tsConfigs } from 'typescript-eslint';
import { createTypeScriptImportResolver } from 'eslint-import-resolver-typescript';

export default defineConfig([
  globalIgnores([
    '**/node_modules/**',
    '**/dist/**',
    'coverage/**',
    'reports/**',
    'artifacts/**',
    '.stryker-tmp/**',
  ]),
  {
    files: ['**/*.{js,mjs,cjs,ts,mts,cts}'],
    extends: [
      js.configs.recommended,
      tsConfigs.strictTypeChecked,
      tsConfigs.stylisticTypeChecked,
      importConfigs.recommended,
      importConfigs.typescript,
      promise.configs['flat/recommended'],
      regexpConfigs['flat/recommended'],
      security.configs.recommended,
      sonarConfigs.recommended,
      unicorn.configs.recommended,
    ],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    linterOptions: { noInlineConfig: true, reportUnusedDisableDirectives: 'error' },
    settings: {
      'import-x/resolver-next': [createTypeScriptImportResolver({ project: 'tsconfig.json' })],
    },
    rules: {
      'array-callback-return': ['error', { checkForEach: true }],
      'consistent-return': 'error',
      curly: ['error', 'all'],
      eqeqeq: ['error', 'always'],
      'no-await-in-loop': 'error',
      'no-constructor-return': 'error',
      'no-eval': 'error',
      'no-implicit-coercion': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      'no-param-reassign': ['error', { props: true }],
      'no-promise-executor-return': 'error',
      'no-return-assign': ['error', 'always'],
      'no-self-compare': 'error',
      'no-template-curly-in-string': 'error',
      'no-unmodified-loop-condition': 'error',
      'no-unreachable-loop': 'error',
      'no-unused-private-class-members': 'error',
      'no-useless-assignment': 'error',
      'require-atomic-updates': 'error',
      'import-x/no-cycle': ['error', { ignoreExternal: true }],
      'import-x/no-extraneous-dependencies': 'error',
      'import-x/no-mutable-exports': 'error',
      'import-x/no-self-import': 'error',
      'import-x/no-unassigned-import': 'error',
      '@typescript-eslint/explicit-function-return-type': 'error',
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      '@typescript-eslint/no-floating-promises': [
        'error',
        { ignoreVoid: false, ignoreIIFE: false },
      ],
      '@typescript-eslint/no-import-type-side-effects': 'error',
      '@typescript-eslint/no-unnecessary-condition': [
        'error',
        { allowConstantLoopConditions: true },
      ],
      '@typescript-eslint/strict-boolean-expressions': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      'unicorn/prevent-abbreviations': 'off',
    },
  },
  {
    files: ['**/*.{js,mjs,cjs,ts,mts,cts}'],
    ignores: ['packages/reboop/src/**', 'tests/reboop/**'],
    languageOptions: { globals: globals.node },
    rules: {
      'no-restricted-globals': [
        'error',
        {
          globals: Object.keys(globals.browser).filter(
            (name) => !Object.hasOwn(globals.node, name),
          ),
          checkGlobalObject: true,
        },
      ],
    },
  },
  {
    files: ['packages/reboop/src/**/*.{js,mjs,cjs,ts,mts,cts}'],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ['tests/reboop/**/*.{js,mjs,cjs,ts,mts,cts}'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: {
      // Negative validation tests must distinguish an explicit null from an absent value.
      'unicorn/no-null': 'off',
    },
  },
  {
    files: ['packages/reboop-eslint/src/origin.ts'],
    rules: {
      // Scope membership guarantees ancestors; explicit casts document that invariant.
      '@typescript-eslint/non-nullable-type-assertion-style': 'off',
      // Unsupported AST node kinds deliberately resolve to unknown in the default branch.
      '@typescript-eslint/switch-exhaustiveness-check': [
        'error',
        { considerDefaultExhaustiveForUnions: true },
      ],
    },
  },
  {
    files: ['scripts/publish.ts'],
    rules: {
      // Archive paths use fixed names/a validated version; GITHUB_OUTPUT is a runner-owned file.
      'security/detect-non-literal-fs-filename': 'off',
    },
  },
  {
    files: ['packages/reboop/src/abortable.ts'],
    rules: {
      // The Web AbortSignal contract preserves arbitrary caller-supplied reasons, not only Errors.
      '@typescript-eslint/prefer-promise-reject-errors': ['error', { allowThrowingUnknown: true }],
    },
  },
  {
    files: ['packages/reboop/src/index.ts'],
    rules: {
      // Forward failures from injected fetch unchanged, including errors from another realm.
      '@typescript-eslint/only-throw-error': ['error', { allowThrowingUnknown: true }],
    },
  },
]);
