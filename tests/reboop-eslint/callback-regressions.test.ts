import { parser } from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
import { lint } from './lint.js';

describe('Promise callback argument regressions', () => {
  /**
  Parenthesized optional access and erased TypeScript expressions around then
  preserve its receiver and callback argument. The imported namespace prevents
  the callback's globalThis default from acquiring a native fetch reference.
  */
  it.each([
    "(import('node:http')?.then)((root=globalThis)=>console.log(typeof root.fetch));",
    "const pending=import('node:http');(pending?.then)?.((root=globalThis)=>console.log(typeof root.fetch));",
    "import('node:http').then!((root:unknown=globalThis)=>console.log(typeof (root as {fetch?:unknown}).fetch));",
    "(import('node:http').then as typeof Promise.prototype.then)((root:unknown=globalThis)=>console.log(typeof (root as {fetch?:unknown}).fetch));",
    "(import('node:http').then satisfies typeof Promise.prototype.then)((root:unknown=globalThis)=>console.log(typeof (root as {fetch?:unknown}).fetch));",
    "(<typeof Promise.prototype.then>import('node:http').then)((root:unknown=globalThis)=>console.log(typeof (root as {fetch?:unknown}).fetch));",
    "(import('node:http').then<void>)((root:unknown=globalThis)=>console.log(typeof (root as {fetch?:unknown}).fetch));",
    "const pending=import('node:http');((pending?.then!) as typeof Promise.prototype.then)(((root:unknown=globalThis)=>console.log(typeof (root as {fetch?:unknown}).fetch)) satisfies ((value:unknown)=>void));",
    "import('node:http').then!(function(this:void,root:unknown=globalThis){console.log(typeof (root as {fetch?:unknown}).fetch);});",
  ])('preserves callback arguments through wrapped then callees: %s', async (code) => {
    const result = await lint(code, 'src/client.ts', [
      { files: ['**/*.ts'], languageOptions: { parser } },
    ]);
    expect(result.messages).toEqual([]);
  });

  /**
  Unwrapping a then callee must also retain real HTTP acquisitions. These
  callbacks receive the namespace even when its member access is parenthesized
  or erased assertions surround both the callee and the callback value.
  */
  it.each([
    "(import('node:http')?.then)(http=>http.request('/items'));",
    "import('node:http').then!((http:typeof import('node:http'))=>http.request('/items'));",
    "(import('node:http').then as typeof Promise.prototype.then)((http:typeof import('node:http'))=>http.request('/items'));",
    "(import('node:http').then satisfies typeof Promise.prototype.then)((http:typeof import('node:http'))=>http.request('/items'));",
    "(<typeof Promise.prototype.then>import('node:http').then)((http:typeof import('node:http'))=>http.request('/items'));",
    "(import('node:http').then<unknown>)((http:typeof import('node:http'))=>http.request('/items'));",
    "const pending=import('node:http');((pending?.then!) as typeof Promise.prototype.then)(((http:typeof import('node:http'))=>http.request('/items')) satisfies ((value:typeof import('node:http'))=>unknown));",
  ])('retains HTTP access through wrapped then callees: %s', async (code) => {
    const result = await lint(code, 'src/client.ts', [
      { files: ['**/*.ts'], languageOptions: { parser } },
    ]);
    expect(result.errorCount).toBe(1);
    expect(result.messages[0]?.ruleId).toBe('reboop/require-client');
  });

  /**
  A callee wrapper supplies no independent module provenance. Safe helpers,
  local promises, unknown then methods and later local parameter defaults must
  remain harmless after the same transparent expressions are removed.
  */
  it.each([
    "import('node:http').then!(({createServer})=>console.log(typeof createServer));",
    "(import('node:http')?.then)((unused,root={fetch(){}})=>root.fetch('/items'));",
    "const pending=Promise.resolve({request(){}});pending.then!(({request})=>request('/items'));",
    "const local=unknownClient;(local?.then)?.(http=>http.request('/items'));",
    '(unknownClient.then as typeof Promise.prototype.then)((http:unknown)=>console.log(typeof (http as {request?:unknown}).request));',
  ])('keeps wrapped local and safe callbacks independent: %s', async (code) => {
    const result = await lint(code, 'src/client.ts', [
      { files: ['**/*.ts'], languageOptions: { parser } },
    ]);
    expect(result.messages).toEqual([]);
  });

  /**
  TypeScript assertions and instantiation expressions preserve the callback
  function passed to then. Its first argument is the imported namespace, so
  a globalThis parameter default never supplies a native fetch reference.
  */
  it.each([
    "import('node:http').then(((root:unknown=globalThis)=>console.log(typeof (root as {fetch?:unknown}).fetch)) as (value:unknown)=>void);",
    "import('node:http').then(((root:unknown=globalThis)=>console.log(typeof (root as {fetch?:unknown}).fetch)) satisfies ((value:unknown)=>void));",
    "import('node:http').then(((root:unknown=globalThis)=>console.log(typeof (root as {fetch?:unknown}).fetch))!);",
    "import('node:http').then(<((value:unknown)=>void)>((root:unknown=globalThis)=>console.log(typeof (root as {fetch?:unknown}).fetch)));",
    "import('node:http').then((function<T>(root:unknown=globalThis){console.log(typeof (root as {fetch?:unknown}).fetch);})<string>);",
    "import('node:http').then((Object.is(0,0),(((root:unknown=globalThis)=>console.log(typeof (root as {fetch?:unknown}).fetch))!) satisfies ((value:unknown)=>void)));",
  ])('preserves callback arguments through erased expressions: %s', async (code) => {
    const result = await lint(code, 'src/client.ts', [
      { files: ['**/*.ts'], languageOptions: { parser } },
    ]);
    expect(result.messages).toEqual([]);
  });

  /**
  A callback selected by a sequence, branch, logical expression or await is
  still passed directly to then. Every selected callback receives a module
  object; these expressions cannot activate its globalThis default.
  */
  it.each([
    "import('node:http').then((Object.is(0,0),(root=globalThis)=>console.log(typeof root.fetch)));",
    "import('node:http').then(flag?((root=globalThis)=>console.log(typeof root.fetch)):((root=globalThis)=>console.log(typeof root.fetch)));",
    "import('node:http').then(flag&&((root=globalThis)=>console.log(typeof root.fetch)));",
    "import('node:http').then(((root=globalThis)=>console.log(typeof root.fetch))||localCallback);",
    "import('node:http').then(((root=globalThis)=>console.log(typeof root.fetch))??localCallback);",
    "import('node:http').then(await ((root=globalThis)=>console.log(typeof root.fetch)));",
  ])('preserves selected inline callbacks: %s', async (code) => {
    const result = await lint(code);
    expect(result.messages).toEqual([]);
  });

  /**
  The same transparent expressions must keep real HTTP namespace arguments
  detectable. Erasing a wrapper must not turn a known request into unknown
  provenance merely because the callback has an intervening AST node.
  */
  it.each([
    "import('node:http').then(((http:typeof import('node:http'))=>http.request('/items')) as (value:typeof import('node:http'))=>unknown);",
    "import('node:http').then(((http:typeof import('node:http'))=>http.request('/items')) satisfies ((value:typeof import('node:http'))=>unknown));",
    "import('node:http').then(((http:typeof import('node:http'))=>http.request('/items'))!);",
    "import('node:http').then(<((value:typeof import('node:http'))=>unknown)>((http:typeof import('node:http'))=>http.request('/items')));",
    "import('node:http').then((function<T>(http:typeof import('node:http')){return http.request('/items');})<string>);",
    "import('node:http').then((Object.is(0,0),(((http:typeof import('node:http'))=>http.request('/items'))!) satisfies ((value:typeof import('node:http'))=>unknown)));",
    "import('node:http').then((Object.is(0,0),http=>http.request('/items')));",
    "import('node:http').then(flag?(http=>http.request('/items')):localCallback);",
    "import('node:http').then(flag&&(http=>http.request('/items')));",
    "import('node:http').then(flag||(http=>http.request('/items')));",
    "import('node:http').then(flag??(http=>http.request('/items')));",
    "import('node:http').then((http=>http.request('/items'))||localCallback);",
    "import('node:http').then((http=>http.request('/items'))??localCallback);",
    "import('node:http').then(await (http=>http.request('/items')));",
  ])('retains wrapped native HTTP requests: %s', async (code) => {
    const result = await lint(code, 'src/client.ts', [
      { files: ['**/*.ts'], languageOptions: { parser } },
    ]);
    expect(result.errorCount).toBe(1);
    expect(result.messages[0]?.ruleId).toBe('reboop/require-client');
  });

  /**
  Earlier sequence operands, conditional tests and the first operand of &&
  are discarded rather than passed as callbacks. Function expressions in
  those positions must retain unknown parameters.
  */
  it.each([
    "import('node:http').then((http=>http.request('/items'),()=>{}));",
    "import('node:http').then((http=>http.request('/items'),http=>console.log(typeof http.createServer)));",
    "import('node:http').then((http=>http.request('/items'))?(()=>{}):(()=>{}));",
    "import('node:http').then((http=>http.request('/items'))&&(()=>{}));",
  ])('does not supply module arguments to discarded callbacks: %s', async (code) => {
    const result = await lint(code);
    expect(result.messages).toEqual([]);
  });

  /**
  A TypeScript this parameter is erased and does not occupy an argument
  position. The following parameter receives the namespace; later runtime
  parameters still receive undefined and may use their own local defaults.
  */
  it.each([
    "import('node:http').then(function(this:void,http:unknown=globalThis){console.log(typeof (http as {fetch?:unknown}).fetch);});",
    "import('node:http').then(function(this:void,{fetch}:{fetch?:unknown,createServer?:unknown}=globalThis){console.log(typeof fetch);});",
    "import('node:http').then(function(this:void,http:unknown,{fetch}={fetch(){}}){fetch();});",
  ])('skips an erased this parameter: %s', async (code) => {
    const result = await lint(code, 'src/client.ts', [
      { files: ['**/*.ts'], languageOptions: { parser } },
    ]);
    expect(result.messages).toEqual([]);
  });

  /**
  Skipping this must preserve both the first namespace argument and default
  values on subsequent runtime parameters. These are distinct native access
  paths and each should still produce exactly one acquisition diagnostic.
  */
  it.each([
    "import('node:http').then(function(this:void,http:typeof import('node:http')){http.request('/items');});",
    "import('node:http').then(function(this:void,http:unknown,root:unknown=globalThis){console.log(typeof (root as {fetch?:unknown}).fetch);});",
  ])('retains native access beside an erased this parameter: %s', async (code) => {
    const result = await lint(code, 'src/client.ts', [
      { files: ['**/*.ts'], languageOptions: { parser } },
    ]);
    expect(result.errorCount).toBe(1);
    expect(result.messages[0]?.ruleId).toBe('reboop/require-client');
  });

  /**
  Direct and logical assignments return their selected right-hand value.
  An inline callback selected this way still receives the imported namespace,
  so its globalThis default cannot supply a native fetch reference.
  */
  it.each(['=', '&&=', '||=', '??='])(
    'preserves callback arguments through %s assignments',
    async (operator) => {
      const initial = operator === '&&=' ? '=()=>{}' : '';
      const result = await lint(
        `let callback${initial};import('node:http').then(callback${operator}((root=globalThis)=>console.log(typeof root.fetch)));`,
      );
      expect(result.messages).toEqual([]);
    },
  );

  /**
  Assignment results keep the same callback argument through nested value
  expressions and erased TypeScript wrappers. An erased this parameter also
  remains separate from the namespace's first runtime argument.
  */
  it.each([
    "let callback:((root:unknown)=>void)|undefined;import('node:http').then((callback=((root:unknown=globalThis)=>console.log(typeof (root as {fetch?:unknown}).fetch))) satisfies ((root:unknown)=>void));",
    "let callback:((root:unknown)=>void)|undefined,other:((root:unknown)=>void)|undefined;const pending=import('node:http');(pending?.then!)((callback=(other=function(this:void,root:unknown=globalThis){console.log(typeof (root as {fetch?:unknown}).fetch);}))!);",
    "let callback:((root:unknown)=>void)|undefined;import('node:http').then(await (false?(()=>{}):(Object.is(0,0),(callback=((root:unknown=globalThis)=>console.log(typeof (root as {fetch?:unknown}).fetch))))));",
  ])('preserves composed callback assignments: %s', async (code) => {
    const result = await lint(code, 'src/client.ts', [
      { files: ['**/*.ts'], languageOptions: { parser } },
    ]);
    expect(result.messages).toEqual([]);
  });

  /**
  Assignment wrappers must retain actual HTTP acquisitions as well as safe
  defaults. Each initializer ensures the inline right-hand callback is selected
  at runtime, including the otherwise short-circuiting logical operators.
  */
  it.each(['=', '&&=', '||=', '??='])(
    'retains native HTTP access through %s callback assignments',
    async (operator) => {
      const initial = operator === '&&=' ? '=()=>{}' : '';
      const result = await lint(
        `let callback${initial};import('node:http').then(callback${operator}(http=>http.request('/items')));`,
      );
      expect(result.errorCount).toBe(1);
      expect(result.messages[0]?.ruleId).toBe('reboop/require-client');
    },
  );

  /**
  Only a value-preserving assignment used by a known import Promise supplies
  a namespace argument. Unknown consumers and coercing assignments must not
  invent that provenance for functions merely occurring in their operands.
  */
  it.each([
    "let callback;consume(callback=(http=>http.request('/items')));",
    "let callback;consume(callback=((root={fetch(){}})=>root.fetch('/items')));",
    "let callback=0;import('node:http').then(callback+=(http=>http.request('/items')));",
    "let callback=1;import('node:http').then(callback*=(http=>http.request('/items')));",
    "let callback=0;import('node:http').then(callback|=(http=>http.request('/items')));",
  ])('keeps independent assignment operands unknown: %s', async (code) => {
    const result = await lint(code);
    expect(result.messages).toEqual([]);
  });

  /**
  Every dynamic import fulfills with a namespace object, even when the
  selected modules have no common known exports. Combining their Promises
  must preserve the supplied first argument so its globalThis default stays
  inactive, through aliases, destructuring and logical selections as well.
  */
  it.each([
    "const pending=flag?import('node:http'):import('./local.js');pending.then((root=globalThis)=>console.log(typeof root.fetch));",
    "const pending=flag?import('./local.js'):import('node:http');pending.then((root=globalThis)=>console.log(typeof root.fetch));",
    "const pending=flag?import('node:module'):import('./local.js');pending.then(({fetch:send}=globalThis)=>console.log(typeof send));",
    "const first=import('node:http'),second=import('./local.js');const pending=flag?first:second;pending.then(function(root=globalThis){const alias=root;console.log(typeof alias.fetch);});",
    "const pending=import('node:http')||import('./local.js');pending.then((root=globalThis)=>console.log(typeof root.fetch));",
    "const pending=import('./local.js')&&import('node:http');pending.then(({fetch:send}=globalThis)=>console.log(typeof send));",
    "const pending=import('node:http')??import('./local.js');pending.then((root=globalThis)=>console.log(typeof root.fetch));",
    "let callback;const pending=flag?import('node:http'):import('./local.js');(pending?.then)(await (callback=((root=globalThis)=>console.log(typeof root.fetch))));",
  ])('preserves first arguments from mixed import Promises: %s', async (code) => {
    const result = await lint(code);
    expect(result.messages).toEqual([]);
  });

  /**
  Erased assertions and this parameters do not change the namespace argument
  supplied by either Promise. The callback's native-root default remains
  unused when a known builtin module is combined with a local import.
  */
  it.each([
    "const pending=flag?import('node:http'):import('./local.js');(pending.then as typeof pending.then)(((root:unknown=globalThis)=>console.log(typeof (root as {fetch?:unknown}).fetch)) satisfies ((value:unknown)=>void));",
    "const pending=flag?import('./local.js'):import('node:module');pending.then(function(this:void,root:unknown=globalThis){const alias=root as {fetch?:unknown};console.log(typeof alias.fetch);});",
  ])('preserves mixed Promise arguments through TypeScript wrappers: %s', async (code) => {
    const result = await lint(code, 'src/client.ts', [
      { files: ['**/*.ts'], languageOptions: { parser } },
    ]);
    expect(result.messages).toEqual([]);
  });

  /**
  A common HTTP member remains a transport after selecting two known import
  Promises. Later callback parameters still receive undefined, and a local
  then method may supply no argument, so those native defaults stay checked.
  */
  it.each([
    "const pending=flag?import('node:http'):import('node:https');pending.then(http=>console.log(typeof http.request));",
    "const pending=flag?import('node:http'):import('./local.js');pending.then((http,root=globalThis)=>console.log(typeof root.fetch));",
    "const local={then(callback){callback();}};const pending=flag?import('node:http'):local;pending.then((root=globalThis)=>console.log(typeof root.fetch));",
    "const local={then(callback){callback();}};const pending=flag?local:import('./local.js');pending.then((root=globalThis)=>console.log(typeof root.fetch));",
    "import * as local from './local.js';const pending=flag?import('node:http'):local;pending.then((root=globalThis)=>console.log(typeof root.fetch));",
    "import * as local from './local.js';const pending=flag?local:import('node:http');pending.then((root=globalThis)=>console.log(typeof root.fetch));",
  ])('retains native access beside mixed Promise argument inference: %s', async (code) => {
    const result = await lint(code);
    expect(result.messages).toEqual([expect.objectContaining({ ruleId: 'reboop/require-client' })]);
  });

  /**
  A direct assignment returns its right-hand value, independently of the
  assigned binding or property. The resulting import Promise supplies a
  namespace to its callback, so native-root defaults remain unused even
  through destructuring targets, immutable aliases and mixed branches.
  */
  it.each([
    "let slot;(slot=import('node:http')).then((root=globalThis)=>console.log(typeof root.fetch));",
    "let slot;const pending=(slot=import('node:http'));pending.then((root=globalThis)=>{const alias=root;console.log(typeof alias.fetch);});",
    "const holder={};(holder.pending=import('node:http')).then((root=globalThis)=>console.log(typeof root.fetch));",
    "let then;({then}=import('node:http')).then((root=globalThis)=>console.log(typeof root.fetch));",
    "let slot,other;const pending=(slot=(other=import('node:http')));pending.then(function(root=globalThis){console.log(typeof root.fetch);});",
    "let slot;const pending=flag?(slot=import('node:http')):(slot=import('./local.js'));pending.then((root=globalThis)=>console.log(typeof root.fetch));",
    "let slot;const pending=(slot=import('./local.js'));pending.then(({fetch:send}=globalThis)=>console.log(typeof send));",
    "let slot;const pending=(Object.is(0,0),(slot=import('node:module')));pending.then(function(root=globalThis){const alias=root;console.log(typeof alias.fetch);});",
  ])('preserves import Promise values returned by direct assignments: %s', async (code) => {
    const result = await lint(code);
    expect(result.messages).toEqual([]);
  });

  /**
  Erased wrappers and this parameters preserve an assignment's Promise
  result. Type annotations on assignment targets do not require following
  the target's later mutable value to identify the callback argument.
  */
  it.each([
    "let slot:Promise<unknown>|undefined;const pending=(slot=import('node:http'));(pending?.then!)(((root:unknown=globalThis)=>console.log(typeof (root as {fetch?:unknown}).fetch)) satisfies ((value:unknown)=>void));",
    "const holder:{pending?:Promise<unknown>}={};const pending=(holder.pending=import('node:http'));pending.then(function(this:void,root:unknown=globalThis){const alias=root as {fetch?:unknown};console.log(typeof alias.fetch);});",
    "let then:unknown;const pending=({then}=import('node:http'));pending.then(({fetch:send}:Record<string,unknown>=globalThis as unknown as Record<string,unknown>)=>console.log(typeof send));",
    "let slot:Promise<unknown>|undefined;const pending=flag?(slot=import('./local.js')):(slot=import('node:module'));(pending.then as typeof pending.then)(function(this:void,root:unknown=globalThis){console.log(typeof (root as {fetch?:unknown}).fetch);});",
  ])('preserves assigned Promise values through TypeScript expressions: %s', async (code) => {
    const result = await lint(code, 'src/client.ts', [
      { files: ['**/*.ts'], languageOptions: { parser } },
    ]);
    expect(result.messages).toEqual([]);
  });

  /**
  Assignment results must retain actual HTTP members as well as callback
  providedness. The original target may be a variable, a property or an
  object pattern; each returned Promise still supplies its namespace.
  */
  it.each([
    "let slot;(slot=import('node:http')).then(http=>console.log(typeof http.request));",
    "let slot;const pending=(slot=import('node:http'));pending.then(({request})=>console.log(typeof request));",
    "const holder={};(holder.pending=import('node:https')).then(http=>console.log(typeof http.get));",
    "let then;({then}=import('node:http')).then(http=>console.log(typeof http.request));",
    "let slot,other;const pending=(slot=(other=import('node:http')));pending.then(http=>console.log(typeof http.request));",
    "let slot;const pending=flag?(slot=import('node:http')):(slot=import('node:https'));pending.then(http=>console.log(typeof http.request));",
  ])('retains HTTP acquisition from assigned Promise values: %s', async (code) => {
    const result = await lint(code);
    expect(result.messages).toEqual([expect.objectContaining({ ruleId: 'reboop/require-client' })]);
  });

  /**
  A logical assignment may retain its previous local value. A then method
  on that value may invoke its callback without an argument, activating the
  native default. Direct assignment of a local then object has the same
  behavior and must not acquire import provenance from its target.
  */
  it.each([
    "const local={then(callback){callback();}};let slot=local;const pending=(slot||=import('node:http'));pending.then((root=globalThis)=>console.log(typeof root.fetch));",
    "const local={then(callback){callback();}};let slot=local;const pending=(slot??=import('node:http'));pending.then((root=globalThis)=>console.log(typeof root.fetch));",
    "const local={then(callback){callback();}};let slot=import('node:http');const pending=(slot&&=local);pending.then((root=globalThis)=>console.log(typeof root.fetch));",
    "const local={then(callback){callback();}};let slot=import('node:http');const pending=(slot=local);pending.then((root=globalThis)=>console.log(typeof root.fetch));",
  ])('retains possible native defaults on local assignment results: %s', async (code) => {
    const result = await lint(code);
    expect(result.messages).toEqual([expect.objectContaining({ ruleId: 'reboop/require-client' })]);
  });
});
