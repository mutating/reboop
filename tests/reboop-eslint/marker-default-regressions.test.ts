import { describe, expect, it } from 'vitest';
import { lint } from './lint.js';

describe('defaults for absent CommonJS namespace markers', () => {
  /**
  Built-in ESM namespaces have no module.exports marker. That known absence
  activates a destructuring default instead of losing its transport or loader
  origin. Native Node execution validates the namespace shapes and fallback
  identities; the cases protect nested bindings, Promise callbacks, aliases,
  factory loading and exported HTTP namespaces without making requests.
  */
  it.each([
    "import*as H from'node:http';const{'module.exports':raw=H.default}=H;raw.request;",
    "const H=await import('https');const{'module.exports':raw=H.default}=H;raw.get;",
    "import('http').then((H)=>{const{'module.exports':raw=H.default}=H;raw.request;});",
    "import*as H from'http';const{'module.exports':{request}=H.default}=H;",
    "import*as M from'node:module';const{'module.exports':raw=M.default}=M;raw.createRequire('/tmp/client.cjs')('http').request;",
    "import*as P from'node:process';const{'module.exports':raw=P.default}=P;raw.getBuiltinModule('https').get;",
    "const M=await import('module');const{'module.exports':raw=M.Module}=M;export default raw.createRequire('/tmp/client.cjs')('http');",
    "const H=flag?await import('http'):await import('https');const{'module.exports':raw=H.default}=H;raw.request;",
  ])('activates a built-in namespace marker default: %s', async (code) => {
    const result = await lint(code);
    expect(result.messages).toEqual([expect.objectContaining({ ruleId: 'reboop/require-client' })]);
  });

  /**
  Raw Undici exports do not gain the namespace's marker property. Recording
  that absence must work for require, default imports and raw values obtained
  through a namespace marker. These cases prevent adding the marker directly
  to raw exports or treating an absent marker as an unknown property, either
  of which would suppress the real fallback's native transport acquisition.
  */
  it.each([
    "const U=require('undici');const{'module.exports':raw=U}=U;raw.fetch;",
    "import U from'undici';const{'module.exports':raw=U}=U;raw.request;",
    "import*as U from'undici';const{'module.exports':raw=U.default}=U.default;raw.connect;",
    "import('undici').then(({default:U})=>{const{'module.exports':raw=U}=U;new raw.Agent().request;});",
    "import*as U from'undici';const raw=U['module.exports'];const{'module.exports':again=U.default}=raw;again.fetch;",
  ])('activates a raw Undici marker default: %s', async (code) => {
    const result = await lint(code);
    expect(result.messages).toEqual([expect.objectContaining({ ruleId: 'reboop/require-client' })]);
  });

  /**
  Undici's ESM marker is present, so it suppresses its default. A safe fallback
  cannot hide the marker's real fetch, and a fallback HTTP get must not be
  invented when the actual raw Undici exports have no get. The final control
  also preserves the absent raw default layer after following the marker.
  */
  it('retains the present marker instead of its local fallback', async () => {
    const result = await lint(
      "import*as U from'undici';const{'module.exports':raw={fetch(){}}}=U;raw.fetch;",
    );
    expect(result.messages).toEqual([expect.objectContaining({ ruleId: 'reboop/require-client' })]);
  });

  /**
  Present marker controls must not activate a native fallback or manufacture a
  second namespace layer. They protect both the marker-presence decision and
  the distinction between raw CommonJS exports and an import namespace.
  */
  it.each([
    "import*as U from'undici';const{'module.exports':raw=require('http')}=U;raw.get;",
    "import*as U from'undici';const{'module.exports':raw={fetch(){}}}=U;raw.default?.fetch;",
  ])('keeps a present marker default inactive: %s', async (code) => {
    const result = await lint(code);
    expect(result.messages).toEqual([]);
  });

  /**
  Known marker absence is narrower than treating every unmodeled field as
  absent. Unknown application objects, shadowed loaders and runtime-selected
  keys retain unknown origins. Runtime controls choose local clients or Agent,
  never the native fallback; broad absence or spelling-based fixes would
  falsely promote that fallback to a proven transport.
  */
  it.each([
    "const require=()=>({'module.exports':{request(){}}});const H=require('http');const{'module.exports':raw=process.getBuiltinModule('http')}=H;raw.request;",
    "import*as H from'./client.js';const{'module.exports':raw=process.getBuiltinModule('http')}=H;raw.request;",
    "const H={custom:{request(){}}};const{custom:raw=process.getBuiltinModule('http')}=H;raw.request;",
    "const H=require('http');const key=readKey();const{[key]:raw=process.getBuiltinModule('http')}=H;raw.request;",
  ])('keeps unknown properties distinct from absent markers: %s', async (code) => {
    const result = await lint(code);
    expect(result.messages).toEqual([]);
  });
});
