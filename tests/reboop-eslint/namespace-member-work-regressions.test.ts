import { parser } from 'typescript-eslint';
import { describe, expect, it, vi } from 'vitest';
import * as origins from '../../packages/reboop-eslint/src/transports.js';
import { lint } from './lint.js';

/**
Namespace construction appends a default entry to a materialized entry array.
Observe that allocation shape through the actual Map constructor, then compare
only its count so a failed budget never formats cyclic scope or origin graphs.
*/
async function measuredLint(code: string): Promise<{
  messages: Awaited<ReturnType<typeof lint>>['messages'];
  namespaceAllocations: number;
}> {
  const maps = vi.spyOn(globalThis, 'Map');
  try {
    const result = await lint(code);
    const namespaceAllocations = maps.mock.calls.filter(([entries]) => {
      if (!Array.isArray(entries)) {
        return false;
      }
      const last: unknown = entries.at(-1);
      return Array.isArray(last) && last[0] === 'default';
    }).length;
    return { messages: result.messages, namespaceAllocations };
  } finally {
    maps.mockRestore();
  }
}

const count = 64;
const diagnostic = (line: number, column = 1): unknown =>
  expect.objectContaining({ ruleId: 'reboop/require-client', line, column });

describe('direct namespace member selection', () => {
  /**
  Unused named imports still acquire a proven transport at their specifier.
  Reading that member needs no namespace allocation. Restoring the old visitor
  member(namespace(...)) expression allocates once per import and fails the
  zero budget; bypassing the visitor loses the exact import diagnostics.
  */
  it('reads named import specifiers without constructing namespaces', async () => {
    const imports = Array.from(
      { length: count },
      (_, index) => `import{request as native${String(index)}}from'http';`,
    );
    const { messages, namespaceAllocations } = await measuredLint(imports.join('\n'));
    expect(messages).toEqual(imports.map((_, index) => diagnostic(index + 1, 8)));
    expect(namespaceAllocations).toBe(0);
  });

  /**
  Agent itself is safe, but its reconstructed instance exposes a transport.
  Resolving each imported binding must preserve that distinction without
  rebuilding a namespace. Restoring only definitionOrigin's namespace call
  exceeds the budget; skipping binding analysis loses every request report.
  */
  it('resolves named import bindings without constructing namespaces', async () => {
    const declarations = Array.from(
      { length: count },
      (_, index) =>
        `import{Agent as Native${String(index)}}from'undici';\nnew Native${String(index)}().request;`,
    );
    const { messages, namespaceAllocations } = await measuredLint(declarations.join('\n'));
    expect(messages).toEqual(declarations.map((_, index) => diagnostic(index * 2 + 2)));
    expect(namespaceAllocations).toBe(0);
  });

  /**
  Named source re-exports inspect their namespace member before exposing a
  transport. They need no temporary namespace map. Restoring that callsite's
  old namespace construction exceeds the budget, while skipping the export
  inspection removes the required declaration diagnostics.
  */
  it('reads named source re-exports without constructing namespaces', async () => {
    const exports = Array.from(
      { length: count },
      (_, index) => `export{request as native${String(index)}}from'http';`,
    );
    const { messages, namespaceAllocations } = await measuredLint(exports.join('\n'));
    expect(messages).toEqual(exports.map((_, index) => diagnostic(index + 1)));
    expect(namespaceAllocations).toBe(0);
  });

  /**
  A named default import returns the raw module, even though its raw default
  field is marked absent. Returning only origin.get(key) drops the later
  request acquisition. This checks the binding path independently of a direct
  transport import, which would already report at its specifier.
  */
  it('retains the raw module behind a named default import', async () => {
    const code = "import{default as client}from'http';client.request;";
    const result = await lint(code);
    expect(result.messages).toEqual([diagnostic(1, code.indexOf('client.request') + 1)]);
  });

  /**
  String-literal import names select the same member as identifiers. Replacing
  symbolName with an identifier-only spelling loses the import diagnostic;
  treating every namespace member as a module also loses this transport.
  */
  it('retains string-literal import members', async () => {
    const code = "import{'request' as read}from'http';read('/api');";
    const result = await lint(code);
    expect(result.messages).toEqual([diagnostic(1, 8)]);
  });

  /**
  String-literal named default re-exports expose the raw network module.
  Removing default selection or reading an identifier-only .name loses this
  declaration diagnostic at the source re-export callsite.
  */
  it('retains string-literal default source re-exports', async () => {
    const result = await lint("export{'default' as native}from'http';");
    expect(result.messages).toEqual([diagnostic(1)]);
  });

  /**
  Undici's ESM module.exports marker points to its raw exports, while the raw
  marker is absent. Omitting the namespace override loses both the imported
  member acquisition and the source re-export diagnostic.
  */
  it('applies the module.exports namespace override', async () => {
    const code =
      "import{'module.exports' as client}from'undici';\nclient.request;\nexport{'module.exports' as native}from'undici';";
    const result = await lint(code);
    expect(result.messages).toEqual([diagnostic(2), diagnostic(3)]);
  });

  /**
  A named Module.prototype export is absent; a named default still reaches
  the raw constructor's real prototype. Ignoring the namespace override adds
  a false report for the first access, and stripping raw prototype tracking
  loses the independent default-path report.
  */
  it('keeps named and raw constructor prototypes distinct', async () => {
    const code =
      "import{prototype as namespacePrototype,default as Module}from'module';\nnamespacePrototype?.require('http').request;\nModule.prototype.require('http').request;";
    const result = await lint(code);
    expect(result.messages).toEqual([diagnostic(3)]);
  });

  /**
  Transport packages retain their direct-import diagnostic, but a named
  default must not invent a namespace wrapper around that transport. Letting
  transport reach the helper's default branch adds a specifier report.
  */
  it('does not invent a default member for a transport package', async () => {
    const result = await lint("import{default as client}from'axios';client('/api');");
    expect(result.messages).toEqual([diagnostic(1)]);
  });

  /**
  Unknown local imports have no namespace members. Dropping the undefined
  guard throws before the independent runtime Fetch can be reported; guessing
  a transport for the local import instead adds a false report.
  */
  it('keeps unknown named imports local', async () => {
    const result = await lint(
      "import{default as client,request as local}from'./client.js';client.request;local('/api');\nfetch('/api');",
    );
    expect(result.messages).toEqual([diagnostic(2)]);
  });

  /**
  An unrecognized named export of a known module stays unknown. Returning the
  module itself when origin.get(key) misses would manufacture a later request
  acquisition. The independent Fetch proves analysis still reaches runtime.
  */
  it('keeps missing names on known modules unknown', async () => {
    const result = await lint(
      "import{missing as client}from'http';client.request;\nfetch('/api');",
    );
    expect(result.messages).toEqual([diagnostic(2)]);
  });

  /**
  Type-only import and source-export selectors remain erased. Removing their
  erasure gates adds transport acquisition diagnostics, while the ordinary
  Fetch must still report through the same real TypeScript parser.
  */
  it('keeps type-only namespace selectors erased', async () => {
    const code =
      "import type{request as Request}from'http';\ntype Native=typeof Request;\nexport type{request}from'http';\nfetch('/api');";
    const result = await lint(code, 'src/client.ts', [
      { files: ['**/*.ts'], languageOptions: { parser } },
    ]);
    expect(result.messages).toEqual([diagnostic(4)]);
  });

  /**
  A namespace wraps the exports-object marker before member lookup. Reusing
  member(origin,key) for the non-default fallback propagates that marker
  through arbitrary keys instead of keeping the wrapped field unknown.
  Compare scalar identity results only, never a cyclic origin graph.
  */
  it('does not propagate a wrapped exports marker through missing members', () => {
    expect(origins.namespaceMember(origins.exportsObject, 'missing')).toBeUndefined();
    expect(origins.namespaceMember(origins.exportsObject, 'default')).toBe(origins.exportsObject);
  });
});
