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
    files: ['**/*.{js,mjs,cjs,ts}'],
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
      globals: { ...globals.node, ...globals.browser },
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
    files: ['scripts/publish.ts'],
    rules: {
      // Archive paths contain only fixed package names and the validated numeric version.
      'security/detect-non-literal-fs-filename': 'off',
    },
  },
]);
