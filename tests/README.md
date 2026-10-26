# Tests

Add client tests under `reboop/` and ESLint configuration/rule tests under `reboop-eslint/`.
Vitest discovers `*.test.ts`, `*.spec.ts`, `*.test.js` and `*.spec.js`.

There are deliberately no example tests or placeholder assertions. An empty suite is allowed
while the package entry points are empty. Coverage requires 100% for every source file;
Stryker requires a 100% mutation score once there are mutants. The mutation command
runs coverage enforcement first so Stryker's empty-suite support cannot allow executable
source without tests to pass silently.
