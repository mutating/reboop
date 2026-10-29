# reboop-eslint

ESLint plugin that keeps application HTTP requests on the shared `reboop` client.
Requires ESLint 10.4 or newer; the package is ESM.

```js
// eslint.config.js
import reboop from 'reboop-eslint';

export default [reboop.configs.recommended];
```

The recommended flat config enables `reboop/require-client` as an error. It does
not select a parser, declare environment globals or change unrelated lint rules.
For TypeScript, add your usual TypeScript parser/config and file patterns.

```js
import { createClient } from 'reboop';

const api = createClient({ baseUrl: 'https://api.example.test/' });
api.json('items'); // Allowed.
fetch('https://api.example.test/items'); // reboop/require-client
```

The diagnostic explains why consistent retries and timeouts matter when DNS
addresses have uneven geographic availability. Retries cannot guarantee selection
of a different IP: the Fetch runtime still owns connection selection.

## Detection

The rule rejects acquiring a runtime transport reference, so saving it under
another name, binding it or passing it to a callback does not bypass the check.
It reports the original acquisition rather than every later invocation.

- Global `fetch` and `XMLHttpRequest`, including static properties on
  `globalThis`, `window`, `self` and `global`, optional chains, destructuring
  and unchanged local aliases of those global objects. Literal and JavaScript constant
  computed names, sequence expressions and branches with the same known origin
  are supported. JSX/TSX component references are checked; intrinsic tags and
  attribute names remain ordinary strings/keys.
- Imports of `node-fetch`, `cross-fetch`, `isomorphic-fetch`, `axios`, `ky` and
  `got`, including package subpaths and side-effect loads through empty runtime
  reexports (`export {} from 'axios'`). These packages are dedicated HTTP clients.
  Paths crossing package boundaries are checked conservatively: both the
  original and normalized package must be known transports, since `exports`
  can intercept a subpath before filesystem normalization. CommonJS path
  separators follow Node's host platform, including backslashes on Windows.
- `request`/`get` from `http`, `https`, `node:http` and `node:https`, and
  `ClientRequest` from `http`/`node:http`.
- `fetch`, `request`, `stream`, `pipeline`, `connect`, `Client`, `Pool` and
  `BalancedPool` from `undici`. Helpers such as `Headers` and constructing an
  `Agent` remain allowed; calling an Agent's HTTP methods is rejected.
- Static ESM imports/reexports (including forwarding a known HTTP namespace),
  CommonJS `require`, `module.require`, `createRequire`, TypeScript import-equals
  and dynamic `import()` with `await` or an inline `.then()` callback. Known Node
  loaders and `createRequire` are also followed when invoked with `new` or
  reached through their `prototype.constructor` self-aliases.
  The native `Module` self-alias, instances, prototype loaders and constructor
  references retain the same loader origins; an instance's private `exports`
  object is separate from the active CommonJS wrapper's public exports.
  ESM namespaces preserve their named-export shapes: `Module.prototype` remains
  available through `default` or `Module`, while Undici's CommonJS namespace
  marker `module.exports` points to its raw exports.
  Node's `process.getBuiltinModule` is followed through globals, process-module
  imports and unchanged aliases, including construction with `new`. It loads
  only Node built-ins; npm packages such as `undici` remain absent through this
  loader. Global `process` properties assume the Node built-in, while locally
  shadowed process objects retain their own bindings.
  Public CommonJS namespace forwarding includes destructuring assignments and
  statically resolved defaults.

Explicit `import type`/`export type` syntax is recognized without relying on
compiler-dependent elision of ordinary value imports.

Local functions/variables/imports named `fetch`, local objects with a `fetch`
method and TypeScript type-only references are allowed, including ambient and
declaration files, function overload signatures, interface heritage, implements
clauses and erased type exports.
Type declarations do not hide a same-name runtime binding or its writes;
decorators and default parameters are checked. Legacy decorators on `declare`
fields of runtime classes are checked too; ambient containing declarations still
erase those expressions. Script-level `var` declarations
without initializers preserve existing native globals; function, module and
CommonJS locals still shadow them. Redundant uninitialized `var` declarations and same-binding `var x = x`
initializers preserve known local values and CommonJS wrapper parameters. TypeScript constructor
parameter properties retain their default origins. Namespaces containing only
private internal import aliases are recognized as erased contexts. Unknown property values are not assumed to be absent when
resolving destructuring defaults.
Runtime capability checks and modifications of native transport references are also access and
are intentionally rejected in application files.

The rule performs local static analysis, without executing code or making network
requests. It cannot prove the behavior of arbitrary wrappers or unknown libraries,
runtime-computed module/property names, TypeScript enum-derived names, reassigned aliases, mutations of object
properties, aggregate copies
through arrays/object rest or spread, dynamic `with` lookups, reflection, or code outside
linted files. CommonJS loader/export bindings are lexical and are not treated as
standard properties of `globalThis`.
Import Promise origins are followed directly; returned values of Promise helper
calls and handler bodies require additional analysis. Emitter-dependent changes
to strict-mode directives retain the parser's existing strictness rather than
assuming identical behavior across TypeScript compilers.
It does not restrict WebSocket, EventSource or other protocols the client does not
implement. It does not validate that a permitted local wrapper actually uses reboop.

## Transport adapters and tests

A dedicated adapter may need raw Fetch access, including when injecting a custom
transport into `createClient`. Exclude only that file with an explicit override:

```js
import reboop from 'reboop-eslint';

export default [
  reboop.configs.recommended,
  { files: ['src/transport.js'], rules: { 'reboop/require-client': 'off' } },
];
```

There is no automatic fix: replacing native calls with a configured client requires
application context. For CI, run ESLint with `--max-warnings 0 --no-inline-config`
and ensure your file patterns include all application sources.
