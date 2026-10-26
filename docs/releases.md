# Repository and release setup

## GitHub

The CI workflow is `.github/workflows/ci.yml`. Its required check names are exactly
`Lint`, `Tests` and `Mutation`. All three must be successful; warnings from ESLint
are errors, and Stryker enforces a 100% mutation score.

The live ruleset is [25890820](https://github.com/mutating/reboop/rules/25890820).
Update it with an account that has repository administration access:

```sh
gh api --method PUT repos/mutating/reboop/rulesets/25890820 \
  --input .github/rulesets/main.json
```

To create this policy in another repository, use `POST repos/OWNER/REPO/rulesets` instead.
Verify the effective policy with:

```sh
gh api repos/mutating/reboop/rules/branches/main
```

The policy applies to administrators as well. PR approval is not required, but the
PR itself and successful checks are required. Direct pushes and force pushes to
`main` are rejected. Keep the workflow/check names in sync with the ruleset.

## First npm publication

1. Create an npm account and verify its email address.
2. Create a granular access token with package **Read and write (publish and stage)**
   permission and **Bypass two-factor authentication** for unattended publication.
   The first publication needs permission to create the two new unscoped packages;
   an account-wide package grant is necessary before the packages exist.
3. Store the token as the repository Actions secret **NPM_TOKEN**. Never commit it.
4. Merge a checked PR into `main`. The `push` workflow publishes `reboop` and
   `reboop-eslint` at `0.1.<run_number>`, then creates the matching GitHub release.

No organization scope is required for the npm names. Packages are public and MIT licensed.
The initial packages are explicitly documented as scaffolds, not a working HTTP client/plugin.

## Switch to Trusted Publishing

Once both packages exist, configure their npm Trusted Publisher separately:

- Provider: GitHub Actions.
- Owner/organization: `mutating`.
- Repository: `reboop`.
- Workflow filename: `ci.yml`.
- Environment: leave empty (the release job does not use a GitHub environment).

The workflow already grants `id-token: write` and uses a supported npm CLI on a
GitHub-hosted runner. After the publishers are configured, remove `NPM_TOKEN` so npm
uses the GitHub OIDC identity. The workflow's provenance flag also attests token-based
bootstrap publications. Follow npm's current publisher setup and expiry requirements:
<https://docs.npmjs.com/trusted-publishers/>.

## Failure and retries

The release job is dependent on all three checks and runs only on a `push` to `main`.
PR workflows have read-only permissions and never receive the publishing token.
Package publication happens before the GitHub release is created.

If one package was published before a later step failed, rerun the same workflow run.
Its version stays unchanged. The publisher compares archive integrity and resumes
without trying to overwrite immutable npm versions. Different contents at an existing
version are an error. Registry errors other than an explicit missing-version response
also fail the job instead of being mistaken for an unpublished version.

Versions are allocated in CI, so routine development does not modify package versions.
The checked-in `0.0.0-development` version is only a local scaffold version.
