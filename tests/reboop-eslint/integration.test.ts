import type { Linter } from 'eslint';
import { parser } from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
import { lint } from './lint.js';

const message =
  'Use the shared reboop client for HTTP requests. Consistent retries and timeouts protect API calls when DNS addresses have uneven geographic availability; retries cannot guarantee a different IP. Exclude only dedicated transport adapter files in your ESLint config.';

describe('public ESLint configuration', () => {
  /**
  Loading the real recommended config must enable the rule without browser
  globals. Exact text, severity and positions catch missing registration,
  shortened rationale, disabled rules and reports attached to the wrong node.
  */
  it('reports a useful diagnostic through the recommended config', async () => {
    const result = await lint("fetch('/items');");
    expect(result.errorCount).toBe(1);
    expect(result.messages).toEqual([
      {
        ruleId: 'reboop/require-client',
        severity: 2,
        message,
        messageId: 'useReboop',
        line: 1,
        column: 1,
        endLine: 1,
        endColumn: 6,
      },
    ]);
  });

  /**
  Runtime transport acquisition is rejected before aliases can hide it. Each
  snippet isolates one entry point, catching lost globals, worker/Node roots,
  optional/computed access, destructuring and indirect-call bypasses.
  */
  it.each([
    "globalThis.fetch('/items');",
    "window.fetch('/items');",
    "self.fetch('/items');",
    "global.fetch('/items');",
    "window['fetch']('/items');",
    'window[`fetch`]("/items");',
    "globalThis?.fetch?.('/items');",
    "const send = fetch; send('/items');",
    "const send = window.fetch; send('/items');",
    "const { fetch: send } = globalThis; send('/items');",
    "const { ['fetch']: send } = window; send('/items');",
    "(0, fetch)('/items');",
    "fetch.call(globalThis, '/items');",
    'fetch.bind(globalThis);',
    'const transport = { fetch };',
    'consume(fetch);',
    'new XMLHttpRequest();',
    'new window.XMLHttpRequest();',
    'const Constructor = XMLHttpRequest; new Constructor();',
    'const { XMLHttpRequest: Constructor } = window; new Constructor();',
    "const browser = window; browser.fetch('/items');",
    "const root = globalThis; const { fetch: send } = root; send('/items');",
    "globalThis.globalThis.fetch('/items');",
    "window.self.fetch('/items');",
    "const { globalThis: root } = globalThis; root.fetch('/items');",
    "const key = 'fetch'; window[key]('/items');",
    "(0, window).fetch('/items');",
    "const root = (0, globalThis); root.fetch('/items');",
    "const root = flag ? window : self; root.fetch('/items');",
    "const root = window || self; root.fetch('/items');",
    "const native = globalThis; const root = flag ? native : native; root.fetch('/items');",
    "const { window: { fetch: send } } = globalThis; send('/items');",
    "const { location, window: root } = globalThis; root.fetch('/items');",
    "let send; ({ fetch: send } = window); send('/items');",
    "function use({ fetch: send } = window) { send('/items'); }",
  ])('rejects global transport access: %s', async (code) => {
    const result = await lint(code);
    expect(result.errorCount).toBe(1);
    expect(result.messages).toEqual([
      expect.objectContaining({ ruleId: 'reboop/require-client', messageId: 'useReboop', message }),
    ]);
  });

  /**
  A shared client and similarly named local symbols remain legal. These cases
  guard scope resolution rather than spelling, so normal imports, properties,
  function parameters and harmless text cannot produce false positives.
  */
  it.each([
    "import { createClient } from 'reboop'; const api = createClient(); api.json('https://api.test/items');",
    "function use(fetch) { return fetch('/items'); }",
    "function use(window) { return window.fetch('/items'); }",
    "function use(globalThis) { return globalThis.fetch('/items'); }",
    "function use(self) { return self.fetch('/items'); }",
    "function use(global) { return global.fetch('/items'); }",
    "const fetch = api.request; fetch('/items');",
    "import { fetch } from './client.js'; fetch('/items');",
    "const { fetch } = api; fetch('/items');",
    "const service = { fetch() {} }; service.fetch('/items');",
    'const object = { fetch: 1, XMLHttpRequest: 2 };',
    'const text = "fetch(\'/items\')";',
    "function use(require) { return require('node-fetch'); }",
    "import { Headers, Agent } from 'undici';",
    "import { createServer } from 'node:http';",
    "const { createServer } = require('http');",
    "import unrelated from 'axios-like';",
    "let root = window; root = { fetch() {} }; root.fetch('/items');",
    'let root = window; root = {}; const other = root; other.fetch();',
    'const a = b; const b = a; a.fetch();',
    'require();',
    'require(...names);',
    'function load(name) { require(name); }',
    'export const value = 1;',
    'let xhr: XMLHttpRequest;',
    "export { createRequire } from 'node:module';",
    "export * from 'node:module';",
    "import('undici').then(undefined, ({ fetch }) => fetch('/items'));",
    "const root = flag ? window : {}; root.fetch('/items');",
    "function use({ fetch }) { return fetch('/items'); }",
    "for (const { fetch } of values) { fetch('/items'); }",
    "let root; root.fetch('/items');",
    "const { ...root } = window; root.fetch('/items');",
    "const { unknown: root } = window; root.fetch('/items');",
    "const local = function root() { root.fetch('/items'); };",
    "const local = function root(input) { root.fetch('/items'); };",
    "var root = window; var root = {}; root.fetch('/items');",
    "function use(key) { return window[key]('/items'); }",
    'export default 1;',
    'const value = {}; export = value;',
    "type Browser = object; const Browser = {}; Browser.fetch('/items');",
    'function use(module) { module.exports = http; }',
    'const exports = {}; exports.http = http;',
    "const { createServer } = require('node:http'); module.exports = createServer;",
    'const local = {}; export const value = local;',
    'const fetch = decorateClient; @decorate(fetch) class Example {}',
    "namespace globalThis { export const marker = 1; } globalThis.fetch('/items'); export {};",
    "namespace fetch { export const marker = 1; } fetch('/items'); export {};",
    "import { Agent } from 'undici'; const agent = new Agent(); agent.close();",
    "import http from 'node:http'; export const { createServer } = http;",
    "export const { createServer } = require('node:http');",
    "import * as undici from 'undici'; export const { Agent } = undici;",
    "function use(root) { root.fetch('/items'); }",
    "function use(root = window) { root = {}; root.fetch('/items'); }",
  ])('allows local symbols and safe client code: %s', async (code) => {
    const result = await lint(code, 'src/client.ts', [
      { files: ['**/*.ts'], languageOptions: { parser } },
    ]);
    expect(result.errorCount).toBe(0);
    expect(result.messages).toEqual([]);
  });

  /**
  Dedicated HTTP packages, including subpaths, may not introduce another
  transport. Static imports, CommonJS, dynamic imports and reexports all
  acquire the same bypass; each package is exercised independently.
  */
  it.each(['node-fetch', 'cross-fetch', 'isomorphic-fetch', 'axios', 'ky', 'got'])(
    'rejects every acquisition form for %s',
    async (name) => {
      await Promise.all(
        [
          `import transport from '${name}';`,
          `import { default as transport } from '${name}';`,
          `import '${name}/polyfill';`,
          `const transport = require('${name}');`,
          `const transport = require('${name}').default;`,
          `const { default: transport } = await import('${name}');`,
          `export const transport = require('${name}');`,
          `const transport = await import('${name}');`,
          `export { default as transport } from '${name}';`,
          `export * from '${name}';`,
        ].map(async (code) => {
          const result = await lint(code);
          expect(result.errorCount, code).toBe(1);
          expect(result.messages[0]?.message).toBe(message);
        }),
      );
    },
  );

  /**
  Node's HTTP and HTTPS modules also expose server utilities, so only request
  entry points are forbidden. Aliased named/default/namespace imports,
  require, destructuring and reexports must retain transport identity.
  */
  it.each(['http', 'https', 'node:http', 'node:https'])(
    'rejects client entry points in %s',
    async (name) => {
      await Promise.all(
        [
          `import { request as send } from '${name}';`,
          `import http from '${name}'; http.get('/items');`,
          `import * as http from '${name}'; http.request('/items');`,
          `const { get: send } = require('${name}');`,
          `const http = require('${name}'); http.request('/items');`,
          `export { request as send } from '${name}';`,
          `export * from '${name}';`,
        ].map(async (code) => {
          const result = await lint(code);
          expect(result.errorCount, code).toBe(1);
          expect(result.messages[0]?.message).toBe(message);
        }),
      );
    },
  );

  /**
  Undici can provide harmless Headers/Agent helpers as well as transports.
  Every supported network entry must be rejected without banning the whole
  module; this catches omitted trace-map members and import aliases.
  */
  it.each(['fetch', 'request', 'stream', 'pipeline', 'connect', 'Client', 'Pool', 'BalancedPool'])(
    'rejects undici.%s',
    async (name) => {
      const result = await lint(`import { ${name} as transport } from 'undici';`);
      expect(result.errorCount).toBe(1);
      expect(result.messages[0]?.message).toBe(message);
    },
  );

  /**
  ESLint must process CommonJS using the recommended config alone. Otherwise
  .cjs files can silently bypass module detection despite green JS tests.
  */
  it('checks CommonJS files through the same public config', async () => {
    const result = await lint("const { request } = require('node:https');", 'src/client.cjs');
    expect(result.errorCount).toBe(1);
    expect(result.messages[0]?.message).toBe(message);
  });

  /**
  Consumers own parser selection: the plugin must work with real TypeScript
  parsing and an explicit file matcher. Exact diagnostics rule out ignored
  .ts warnings or parser failures masquerading as successful enforcement.
  */
  it('checks TypeScript runtime references', async () => {
    const result = await lint(
      'const send = (globalThis as typeof globalThis).fetch;',
      'src/client.ts',
      [{ files: ['**/*.ts'], languageOptions: { parser } }],
    );
    expect(result.errorCount).toBe(1);
    expect(result.messages[0]?.message).toBe(message);
  });

  /**
  Type queries and type-only module imports cannot perform HTTP requests.
  This prevents regressions where TypeScript scope references are mistaken
  for runtime transport acquisitions, including named type specifiers.
  */
  it.each([
    'type Native = typeof fetch;',
    'type Native = typeof globalThis.fetch;',
    "import type { RequestInit } from 'undici';",
    "export type { Dispatcher } from 'undici';",
    "import type { AxiosResponse } from 'axios';",
    "export type { AxiosResponse } from 'axios';",
    "import { type AxiosResponse } from 'axios';",
    "export { type AxiosResponse } from 'axios';",
  ])('allows TypeScript type references: %s', async (code) => {
    const result = await lint(code, 'src/client.ts', [
      { files: ['**/*.ts'], languageOptions: { parser } },
    ]);
    expect(result.errorCount).toBe(0);
    expect(result.messages).toEqual([]);
  });

  /**
  Explicit adapter-file overrides are the supported escape hatch. The same
  source remains rejected in ordinary application files, preventing a broad
  exception from silently disabling enforcement throughout the project.
  */
  it('limits transport exceptions to configured adapter files', async () => {
    const config: Linter.Config[] = [
      { files: ['src/transport.js'], rules: { 'reboop/require-client': 'off' } },
    ];
    const adapter = await lint("fetch('/items');", 'src/transport.js', config);
    const appResult = await lint("fetch('/items');", 'src/client.js', config);
    expect(adapter.messages).toEqual([]);
    expect(appResult.errorCount).toBe(1);
  });

  /**
  Loader syntax and CJS namespace defaults must not hide known HTTP exports.
  These cases reproduce missed TS import-equals, module.require, default
  reexports and dynamic namespace access while retaining one useful report.
  */
  it.each([
    "import transport = require('axios');",
    "import http = require('node:http'); http.request('/items');",
    "module.require('node-fetch');",
    "module.require('node:http').request('/items');",
    "export { default as http } from 'node:http';",
    "export { default as transport } from 'undici';",
    "const { default: http } = await import('node:http'); http.request('/items');",
    "(await import('undici')).default.fetch('/items');",
    "import('undici').then(({ fetch }) => fetch('/items'));",
    "import('node:http').then(http => http.get('/items'));",
    "const promise = import('undici'); const http = await promise; http.request('/items');",
    "import { ClientRequest } from 'node:http'; new ClientRequest('http://api.test');",
    "(0, require)('axios');",
    "import * as http from 'node:http'; export { http };",
    "import http from 'node:http'; export default http;",
    "import http = require('node:http'); export = http;",
    "import http = require('node:http'); import Client = http.ClientRequest; new Client('http://api.test');",
    "type window = string; window.fetch('/items');",
    "interface globalThis {} globalThis.fetch('/items');",
    "import('undici').then(({ fetch } = {}) => fetch('/items'));",
    "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url); require('node-fetch');",
    "import { createRequire } from 'module'; const require = createRequire(import.meta.url); require('node-fetch');",
    "import { 'fetch' as send } from 'undici'; send('/items');",
    "export { 'request' as send } from 'node:http';",
    "const load = require; load('axios');",
    "(window satisfies typeof window).fetch('/items');",
    "(<typeof window>window).fetch('/items');",
    "window!.fetch('/items');",
    "const load = (require as <T>(name: string) => T)<unknown>; load('axios');",
    "const http = require('node:http'); type http = string; http.request('/items');",
    "import * as http from 'node:http'; type http = string; http.request('/items');",
    "type Browser = typeof globalThis; const Browser = globalThis; Browser.fetch('/items');",
    "import http from 'node:http'; export const native = http;",
    "const http = require('node:http'); module.exports = http;",
    "module.exports = require('node:http');",
    "const http = require('node:http'); exports.http = http;",
    "const http = require('node:http'); module.exports.default = http;",
    '@decorate(fetch) class Example {}',
    "@fetch('/items') class Example {}",
    '@decorate(XMLHttpRequest) class Example {}',
    "namespace globalThis { export type X = string; } globalThis.fetch('/items'); export {};",
    "namespace fetch { export type X = string; } fetch('/items'); export {};",
    'namespace XMLHttpRequest { export type X = string; } new XMLHttpRequest(); export {};',
    "import { Agent } from 'undici'; new Agent().request({ origin: 'https://api.test', path: '/', method: 'GET' });",
    "import { Agent } from 'undici'; const agent = new Agent(); agent.dispatch(options, handler);",
    "export import http = require('node:http');",
    "import http = require('node:http'); export import native = http;",
    "import { Agent } from 'undici'; Agent.prototype.request.call(agent, options);",
    "function use(root = window) { root.fetch('/items'); }",
    "const use = (unused, root = window) => root.fetch('/items');",
    "function use(unused, { window: root } = globalThis) { root.fetch('/items'); }",
    "const key = 'fetch'; type key = string; window[key]('/items');",
    "const name = 'node:http'; type name = string; require(name).request('/items');",
    "const key = 'fetch'; function use() { type key = string; window[key]('/items'); }",
    "const name = 'node:http'; function use() { type name = string; require(name).request('/items'); }",
    "(0, 42, window).fetch('/items');",
  ])('rejects alternate loader forms: %s', async (code) => {
    const result = await lint(code, 'src/client.ts', [
      { files: ['**/*.ts'], languageOptions: { parser } },
    ]);
    expect(result.errorCount).toBe(1);
    expect(result.messages[0]?.message).toBe(message);
  });

  /**
  Real applications usually configure environment globals. Detection must
  also work when ESLint resolves the reference to a predefined variable,
  rather than its unresolved-reference fallback.
  */
  it('detects transports with configured environment globals', async () => {
    const result = await lint("fetch('/items'); window.fetch('/items');", 'src/client.js', [
      { languageOptions: { globals: { fetch: 'readonly', window: 'readonly' } } },
    ]);
    expect(result.errorCount).toBe(2);
    expect(result.messages.map((diagnostic) => diagnostic.message)).toEqual([message, message]);
  });

  /**
  Forwarding an already acquired native function must keep one diagnostic at
  acquisition. This protects useful error counts while namespace forwarding
  is still rejected even when its individual request members are not read.
  */
  it.each([
    'export default fetch;',
    'export const send = fetch;',
    'module.exports = fetch;',
    'const send = fetch; export { send };',
  ])('reports raw transport export once: %s', async (code) => {
    const result = await lint(code);
    expect(result.errorCount).toBe(1);
    expect(result.messages[0]?.message).toBe(message);
  });

  /**
  Script-mode TS has no outer module scope to fall back to when a type-only
  declaration occupies a global name. Erasing that definition must retain
  detection rather than treating it as a local runtime object.
  */
  it('ignores type-only globals in TypeScript scripts', async () => {
    const result = await lint("type window = string; window.fetch('/items');", 'src/client.ts', [
      { files: ['**/*.ts'], languageOptions: { parser, sourceType: 'script' } },
    ]);
    expect(result.errorCount).toBe(1);
    expect(result.messages[0]?.message).toBe(message);
  });
});
