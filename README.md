# reboop

Two ESM npm packages maintained together:

- `reboop`: HTTP client with consistent retries, deadlines and cancellation.
- `reboop-eslint`: ESLint plugin intended to enforce use of the configured client.

Both packages are currently scaffolds: the source entry points export empty modules,
there are no implemented client functions or lint rules, and the test directories are empty.

## Development

Use Node.js 24 LTS (at least 24.11.0) and npm 11.21 or newer. CI pins npm 11.21.1.
Run `npm ci` once.
Work in `develop`; changes reach `main` through pull requests.

| Command       | Checks                                                                    |
| ------------- | ------------------------------------------------------------------------- |
| `make lint`   | ESLint, strict TypeScript checking, Prettier, builds and package metadata |
| `make test`   | Vitest with V8 coverage                                                   |
| `make mutate` | Coverage guard, then Stryker mutation testing with the Vitest runner      |
| `make check`  | All three commands above, sequentially and stopping on the first failure  |
| `make build`  | JavaScript and TypeScript declarations for both packages                  |

ESLint uses type-aware strict rules plus SonarJS, Unicorn, Regexp, Promise, Security,
and Import X. It checks source, tests, scripts and configuration. Warnings fail CI;
inline suppression comments cannot disable checks. The Unicorn naming-abbreviation
rule is excluded because naming style is not a correctness check.
TypeScript also checks optional properties, indexed access, unused bindings,
exhaustiveness-related control flow and JavaScript configuration files.
The client has a separate Web API type environment; the ESLint plugin, scripts and
configuration run in a Node-only environment. Each package is typechecked independently.
Client tests have their own Web API/Node type project so imports of browser sources
are not rechecked under the Node-only infrastructure project. Plugin tests remain Node-only.
Build, coverage and mutation discovery include JavaScript and TypeScript sources
(`.js`, `.mjs`, `.cjs`, `.ts`, `.mts`, `.cts`); declaration files are not mutated.

### Tests and mutation testing

Put tests in `tests/reboop/` and `tests/reboop-eslint/`. Vitest supports
`*.test.*` and `*.spec.*` using the six JavaScript/TypeScript extensions above.
The empty suite is deliberately allowed during scaffolding; no placeholder assertions
inflate the test count. Coverage thresholds are 100% per source file, and Stryker's
mutation threshold is 100%. Stryker's `allowEmpty` permits the initial empty test run.
Since Stryker can stop early when there are no tests, `make mutate` first runs Vitest
with coverage enforcement. This prevents new source without tests from passing mutation
checks. Once source is covered, surviving mutants independently fail Stryker.

Coverage is written to `coverage/`; mutation reports are written to `reports/mutation/`.
Generated output, caches and archives are ignored by Git.

## CI and protected main

`.github/workflows/ci.yml` runs `Lint`, `Tests` and `Mutation` on every push to every
branch, on pull requests, and on manual dispatch. There are no path filters.
Checks run as separate required jobs; a failed or missing job blocks merging into `main`.
Runs are queued instead of replacing earlier pending pushes, including releases.

The desired repository rules are stored in `.github/rulesets/main.json`:
pull requests are mandatory for `main`, all three checks must succeed on an up-to-date
branch, and deletion and force pushes are prohibited. No actors have a bypass.
These are GitHub repository settings, not restrictions enforced by a local file.
An administrator can apply or update them with the GitHub API; see `docs/releases.md`.

## Releases

Every successful push to `main`, including PR merges and documentation-only changes,
publishes **both** packages and a GitHub release. Release versions are `0.1.N`, where
`N` is the GitHub Actions run number. Gaps are expected because branch and PR checks
also consume run numbers. Commit-message conventions and manual version bumps are
not required. Both packages always share the same version.

The release job runs only after all three checks succeed. It builds and validates
the packages, publishes the exact packed archives, then creates a `v0.1.N` GitHub
release containing those archives. It updates neither `main` nor `develop` with
version commits. Retrying a partially completed run reuses its version and skips
an existing npm version only when its SHA-512 integrity matches the local archive.
Versions are initially published under an individual `release-0.1.N` tag. Only after
both packages exist does the publisher advance their `latest` tags, and it never
moves a tag backwards. A historical retry also leaves GitHub's latest release unchanged.

Initial publishing requires the `NPM_TOKEN` Actions secret. OIDC permissions are
also enabled so publishing can use npm Trusted Publishing after both packages have
been bootstrapped and their publishers configured. See [release setup](docs/releases.md).
