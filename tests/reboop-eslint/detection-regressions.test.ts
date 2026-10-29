import { parser } from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
import { lint } from './lint.js';

describe('transport detection regressions', () => {
  /**
  JSX component expressions acquire runtime references just like ordinary
  member access. Check both parsers, nested aliases and uppercase globals;
  closing tags must not duplicate the diagnostic on the opening reference.
  Transport references used as intermediate JSX bases must also be checked:
  an unknown outer component property cannot hide that earlier acquisition.
  */
  it.each(
    [
      'const view = <globalThis.fetch />;',
      'const view = <window.XMLHttpRequest></window.XMLHttpRequest>;',
      'const root = globalThis; const view = <root.fetch />;',
      'const root = globalThis; const view = <root.window.fetch />;',
      'const view = <XMLHttpRequest />;',
      'const view = <window.fetch.Component />;',
      'const view = <XMLHttpRequest.Component></XMLHttpRequest.Component>;',
      'const root = globalThis; const view = <root.XMLHttpRequest.prototype.Render />;',
    ].flatMap((code) => ['jsx', 'tsx'].map((extension) => ({ code, extension }))),
  )(
    'rejects native JSX component acquisition in $extension: $code',
    async ({ code, extension }) => {
      const result = await lint(code, `src/client.${extension}`, [
        {
          files: ['**/*.jsx', '**/*.tsx'],
          languageOptions: {
            ...(extension === 'tsx' && { parser }),
            parserOptions: { ecmaFeatures: { jsx: true } },
          },
        },
      ]);
      expect(result.messages).toEqual([
        expect.objectContaining({ ruleId: 'reboop/require-client' }),
      ]);
    },
  );

  /**
  JSX spelling alone does not acquire a native transport. Intrinsic and
  namespace tags are strings, attribute names are keys, and local component
  parameters or objects must keep their scope rather than match by name.
  */
  it.each(
    [
      'const view = <fetch />;',
      'const view = <window:fetch />;',
      'const view = <Panel XMLHttpRequest="fetch" />;',
      'function render(XMLHttpRequest) { return <XMLHttpRequest />; }',
      'function render(window) { return <window.fetch />; }',
      'const root = { fetch: Panel }; const view = <root.fetch />;',
    ].flatMap((code) => ['jsx', 'tsx'].map((extension) => ({ code, extension }))),
  )(
    'allows JSX without a native transport reference in $extension: $code',
    async ({ code, extension }) => {
      const result = await lint(code, `src/client.${extension}`, [
        {
          files: ['**/*.jsx', '**/*.tsx'],
          languageOptions: {
            ...(extension === 'tsx' && { parser }),
            parserOptions: { ecmaFeatures: { jsx: true } },
          },
        },
      ]);
      expect(result.messages).toEqual([]);
    },
  );

  /**
  Node's known loaders and createRequire factory can return the same objects
  when constructed. Tracking only call syntax loses their transport origin;
  imports, lexical aliases and module.require must retain the shared model.
  */
  it.each([
    "(new require('node:http')).request('/items');",
    "(new module.require('node:https')).get('/items');",
    "new require('axios');",
    "const load = require; (new load('undici')).fetch('/items');",
    "import { createRequire } from 'node:module'; const load = new createRequire(import.meta.url); load('node:http').request('/items');",
    "const { createRequire } = require('node:module'); const factory = createRequire; const load = new factory('/app/client.cjs'); (new load('node:https')).get('/items');",
  ])('rejects transports acquired through constructed loaders: %s', async (code) => {
    const result = await lint(code);
    expect(result.messages).toEqual([expect.objectContaining({ ruleId: 'reboop/require-client' })]);
  });

  /**
  Constructibility is modeled only for the already known Node loaders.
  Unknown constructors, safe Node helpers and calling Agent without new
  cannot acquire a modeled HTTP instance or invent transport methods.
  */
  it.each([
    "const load = makeLoader; (new load('node:http')).request('/items');",
    "(new require('node:url')).URL;",
    "const { Agent } = require('undici'); new Agent();",
    "const { Agent } = require('undici'); const value = Agent(); value.request('/items');",
    "import { createRequire } from 'node:module'; const load = new createRequire(import.meta.url); load('node:url').URL;",
  ])('allows constructed helpers and unknown loaders: %s', async (code) => {
    const result = await lint(code);
    expect(result.messages).toEqual([]);
  });
});
