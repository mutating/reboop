# Tests

Add client tests under `reboop/` and ESLint configuration/rule tests under `reboop-eslint/`.
Vitest discovers `*.test.*` and `*.spec.*` with `.js`, `.mjs`, `.cjs`, `.ts`, `.mts`,
and `.cts` extensions. The same source extensions are included in coverage and mutation testing.

Each directory has its own type project: client tests support Web APIs and Node-based
test utilities, while plugin tests use Node-only types. Both projects include their
package's source so type checking still works before the first test is added.

Client tests cover retry/error policy, deadlines through body consumption, headers and URL
handling, all response readers, and caller cancellation. Fake timers make backoff tests
deterministic; listener and timer cleanup are asserted. Native fetch integration tests use
an ephemeral loopback HTTP server to simulate dropped connections, truncated bodies, and
stalled headers/bodies. Tests do not access production hosts or depend on public DNS.
Browser-specific Fetch error messages are fixtures, not real browser engine tests.

Empty suites fail. Coverage requires 100% for every source file; Stryker requires a 100%
mutation score. The mutation command runs coverage enforcement first. There are no
placeholder assertions. Plugin RuleTester cases pin diagnostics and locations;
integration tests load the exported recommended config through the real ESLint API.
They cover global and imported transports, aliases, CommonJS, dynamic imports,
TypeScript erasure, scope, JSX component acquisition, constructed Node loaders,
script-level global var bindings, exports, false positives and explicit adapter overrides.
Platform path scenarios mock only the plugin's `node:path` backend to check Windows
and POSIX classification through ESLint while keeping the test host's filesystem intact.
Source snippets are parsed and linted, never executed or sent over the network.

Plugin performance regressions count parser-reference queries, ancestor reads, range reads,
and virtual-scope allocations instead of asserting wall-clock timings. The probes preserve
metadata values and run through ESLint; required diagnostics prevent skipped analysis from
passing a work budget. Cases include repeated aliases, deep shared ancestry, erased namespaces,
computed keys, out-of-order references from nested scopes, and small-file allocation overhead.
Mutation challenges check that removing caches or restoring repeated scans fails these tests.
The overlap predicate documents an equivalent boundary mutation: grouping touching half-open
ranges with `>=` instead of `>` preserves the selected binding at every position. Stryker's
`EqualityOperator` directive covers the predicate, including its reversed `<=` variant; that
non-equivalent variant is separately challenged against annotation work and priority tests.
Ordering, overlap bounds, fallback behavior and work budgets remain tested.

`typecheck/consumer.ts` imports the built package through its public exports. The package
lint command compiles this fixture twice, with Node-only and browser-only globals, to check
the declarations consumers receive. It is a compile-only check and performs no HTTP requests.
