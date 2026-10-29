import { describe, expect, it } from 'vitest';
import { lint } from './lint.js';

async function expectDiagnostics(
  code: string,
  count: number,
  filePath = 'src/client.cjs',
): Promise<void> {
  const result = await lint(code, filePath);
  expect(result.errorCount).toBe(count);
  expect(result.messages.map((message) => message.ruleId)).toEqual(
    Array.from({ length: count }, () => 'reboop/require-client'),
  );
}

describe('transport origin integration regressions', () => {
  /**
  A complete HTTP namespace can expose native requests through another file,
  while node:module only supplies loader helpers. Checking both exports
  catches missing and overbroad namespace classification, independently of
  which earlier lint call first constructed a model for the module.
  */
  it.each([
    { name: 'native HTTP namespace', module: 'node:http', errors: 1 },
    { name: 'safe loader namespace', module: 'node:module', errors: 0 },
  ])('classifies an exported $name', async ({ module, errors }) => {
    await expectDiagnostics(
      `import * as helpers from '${module}';export default helpers;`,
      errors,
      'src/client.js',
    );
  });

  /**
  The namespace delivered by dynamic import has one default layer. The first
  default exposes the raw HTTP module; its own default is absent. These
  cases catch losing the namespace default or inventing additional layers.
  */
  it.each([
    { property: 'default', errors: 1 },
    { property: 'default.default', errors: 0 },
  ])('preserves dynamic import $property', async ({ property, errors }) => {
    await expectDiagnostics(
      `import('node:http').then(namespace=>{module.exports=namespace.${property};});`,
      errors,
    );
  });

  /**
  A known HTTP import Promise also forwards a future native namespace. Safe
  helper promises stay allowed, and a dedicated HTTP package is reported
  exactly once at acquisition rather than again at its Promise export.
  */
  it.each([
    { name: 'node:http', errors: 1 },
    { name: 'node:module', errors: 0 },
    { name: 'axios', errors: 1 },
  ])('classifies the exported Promise from $name', async ({ name, errors }) => {
    await expectDiagnostics(`module.exports=import('${name}');`, errors);
  });

  /**
  A Promise and a plain value have no agreed representation. The literal
  choice selects the Promise, which has no createRequire method. Retaining
  either plain model would fabricate a loader acquisition through an optional
  call that never runs. Both orders protect left-model merge dispatch.
  */
  it.each(['false?plain:pending', 'true?pending:plain'])(
    'keeps mixed safe Promise/plain origins unknown: %s',
    async (choice) => {
      await expectDiagnostics(
        `const plain=require('node:module'),pending=import('node:module');const selected=${choice};selected.createRequire?.(__filename)?.('axios');`,
        0,
      );
    },
  );

  /**
  Two known HTTP import promises must retain their shared protected module
  role through a conditional export. This catches dropping fulfillment
  metadata or treating all Promise models as ordinary empty objects.
  */
  it('retains the shared namespace of two HTTP promises', async () => {
    await expectDiagnostics(
      "const a=import('node:http'),b=import('node:https');module.exports=flag?a:b;",
      1,
    );
  });

  /**
  Reading request already reports the one native acquisition. A conditional
  with the containing namespace has no agreed whole-value role, so keeping
  empty or undefined model fields must not fabricate a second export error.
  */
  it('does not invent a namespace when combining a module with its request function', async () => {
    await expectDiagnostics(
      "const http=require('node:http');const selected=flag?http:http.request;module.exports=selected;",
      1,
    );
  });

  /**
  Unknown helper provenance on the left must remain unknown when compared
  with a known safe helper module. This protects the missing-origin boundary
  from attempts to iterate undefined during structural model merging.
  */
  it('handles an unknown left helper origin without crashing', async () => {
    await expectDiagnostics(
      "const a=require('node:path'),b=require('node:module');module.exports=flag?a:b;",
      0,
    );
  });

  /**
  A literal safe choice must not become an HTTP namespace merely because
  another branch names one. Only fields agreed by both models survive; an
  overbroad whole-model tag would wrongly forbid this helper-only export.
  */
  it('does not mark a safe conditional choice as a native namespace', async () => {
    await expectDiagnostics(
      "const safe=require('node:module'),http=require('node:http');module.exports=true?safe:http;",
      0,
    );
  });

  /**
  A private field on the exported instance does not publicly forward a native
  namespace. A private property has no ordinary string key; treating it like
  an arbitrary public export member produces a false namespace diagnostic.
  */
  it('keeps a namespace stored in a private export field private', async () => {
    await expectDiagnostics(
      "class Container{#client;constructor(){module.exports=this;module.exports.#client=require('node:http');}}new Container();",
      0,
    );
  });
});
