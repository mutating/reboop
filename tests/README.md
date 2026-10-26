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
placeholder assertions for the ESLint plugin scaffold.

`typecheck/consumer.ts` imports the built package through its public exports. The package
lint command compiles this fixture twice, with Node-only and browser-only globals, to check
the declarations consumers receive. It is a compile-only check and performs no HTTP requests.
