import { parser } from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
import { lint } from './lint.js';

describe('export and declaration integration regressions', () => {
  /**
  Declaration-file detection must match the final extension, not a fragment
  in a runtime filename or directory. Removing the regex end anchor would
  silently disable all transport checks for these ordinary JavaScript files.
  */
  it.each([
    'src/client.d.ts.js',
    'src/client.d.mts.mjs',
    'src/client.d.cts.cjs',
    'src/declarations.d.ts/client.js',
  ])('checks runtime source named %s', async (filePath) => {
    const result = await lint("fetch('/items');", filePath);
    expect(result.errorCount).toBe(1);
    expect(result.messages).toEqual([
      expect.objectContaining({ ruleId: 'reboop/require-client', line: 1, column: 1 }),
    ]);
  });

  /**
  The default object in a Promise callback is an ordinary expression, not a
  destructuring acquisition. The imported namespace supplies a safe helper,
  so its unused local default must not inherit native request/fetch members.
  This catches treating every Property node as part of an ObjectPattern.
  */
  it.each([
    "import('node:http').then(({createServer:serve}={request:localClient})=>serve());",
    "import('undici').then(({Headers:Local}={fetch:localClient})=>new Local());",
  ])('allows a safe helper with a local default object: %s', async (code) => {
    const result = await lint(code);
    expect(result.messages).toEqual([]);
  });

  /**
  Type assertions on an assignment target are erased by TypeScript. The
  resulting CommonJS assignment still forwards the HTTP namespace; checking
  only the unwrapped AST node kind misses this real export. Both immediate
  loads and saved namespaces must be detected through the public config.
  */
  it.each([
    "(module.exports as unknown)=require('node:http');",
    "const http=require('node:http');(module.exports as unknown)=http;",
  ])('detects a type-asserted CommonJS export target: %s', async (code) => {
    const result = await lint(code, 'src/client.cts', [
      { files: ['**/*.cts'], languageOptions: { parser, sourceType: 'commonjs' } },
    ]);
    expect(result.errorCount).toBe(1);
    expect(result.messages[0]?.ruleId).toBe('reboop/require-client');
  });

  /**
  Rebinding exports or an alias does not write module.exports. Removing an
  AST shape check is safe only while origin resolution still distinguishes
  these local assignments from real CommonJS export targets.
  */
  it.each([
    "const http=require('node:http');exports=http;",
    "let target=module.exports;const http=require('node:http');target=http;",
    "let target=exports;const http=require('node:http');target||=http;",
    "const target={};const http=require('node:http');target.value=http;",
  ])('allows assignment to a local replacement: %s', async (code) => {
    const result = await lint(code, 'src/client.cjs');
    expect(result.messages).toEqual([]);
  });

  /**
  A type/value merge can give one variable multiple declaration identifiers.
  Their shared binding must resolve to the same HTTP namespace even when a
  type or interface is declared first. A mixed declaration also protects the
  outer any-variable check from becoming an all-variable check.
  */
  it.each([
    "import * as http from 'node:http';type Native={};export const Native=http;",
    "import * as http from 'node:http';interface Native{}export const Native=http;",
    "import * as http from 'node:http';export const Native=http;type Native={};",
    "import * as http from 'node:http';export const serve=http.createServer,Native=http;",
  ])('detects the shared exported binding: %s', async (code) => {
    const result = await lint(code, 'src/client.ts', [
      { files: ['**/*.ts'], languageOptions: { parser } },
    ]);
    expect(result.errorCount).toBe(1);
    expect(result.messages[0]?.ruleId).toBe('reboop/require-client');
  });

  /**
  Selecting one declaration identifier must not invent a native value for a
  merged local helper or a same-name fetch type. An explicitly type-only
  import-equals export must remain erased at its parent export declaration.
  Empty binding patterns export no variables and must not trigger a report.
  */
  it.each([
    "import * as http from 'node:http';type Serve={};export const Serve=http.createServer;",
    'type fetch=string;export const fetch=localClient;',
    "export import type HTTP=require('node:http');",
    "export {createRequire} from 'node:module';",
    "import * as http from 'node:http';export const {}=http;",
    'export const []=[];',
  ])('allows safe exported declarations: %s', async (code) => {
    const result = await lint(code, 'src/client.ts', [
      { files: ['**/*.ts'], languageOptions: { parser } },
    ]);
    expect(result.messages).toEqual([]);
  });

  /**
  A named runtime reexport has no declaration node. Passing that missing
  declaration through the type-only predicate must retain ordinary export
  checking rather than skipping the source or throwing on null.
  */
  it('detects a named runtime reexport without a declaration node', async () => {
    const result = await lint("export {request} from 'node:http';");
    expect(result.errorCount).toBe(1);
    expect(result.messages[0]?.ruleId).toBe('reboop/require-client');
  });
});
