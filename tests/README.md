# Tests

Add client tests under `reboop/` and ESLint configuration/rule tests under `reboop-eslint/`.
Vitest discovers `*.test.*` and `*.spec.*` with `.js`, `.mjs`, `.cjs`, `.ts`, `.mts`,
and `.cts` extensions. The same source extensions are included in coverage and mutation testing.

Each directory has its own type project: client tests support Web APIs and Node-based
test utilities, while plugin tests use Node-only types. Both projects include their
package's source so type checking still works before the first test is added.

There are deliberately no example tests or placeholder assertions. An empty suite is allowed
while the package entry points are empty. Coverage requires 100% for every source file;
Stryker requires a 100% mutation score once there are mutants. The mutation command
runs coverage enforcement first so Stryker's empty-suite support cannot allow executable
source without tests to pass silently.
