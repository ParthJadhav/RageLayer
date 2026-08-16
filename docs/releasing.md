# Releasing

Releases use Changesets, GitHub Actions, and npm trusted publishing. A release should be reproducible
from the tagged commit. npm adds provenance automatically when the source repository is public.

## npm trusted publisher

The package publishes exclusively through npm trusted publishing. npm is configured with:

| Field | Value |
| --- | --- |
| Provider | GitHub Actions |
| Repository | `ParthJadhav/RageLayer` |
| Workflow | `release.yml` |
| Permission | Publish |

The workflow grants `id-token: write` and uses a supported Node/npm environment. npm exchanges the
GitHub Actions OIDC identity for a short-lived publishing credential. The repository stores no npm
token, and the package disallows bypass-2FA token publishing.

## Normal release flow

1. Add a changeset with every user-visible pull request: `bun run changeset`.
2. Merge the pull request to `main`.
3. The release workflow opens or updates the **chore: version packages** pull request.
4. Review the version and generated changelog, then merge that pull request.
5. The workflow runs the complete package check, publishes to npm, creates the git tag and GitHub
   Release, downloads the published registry tarball, and attaches that exact `.tgz` artifact.

Publication is gated on `bun run check` only. The tool demo reel is recorded on demand for human
review and never blocks a release — see [the performance guide](./performance.md#tool-demo-reel).

Do not edit `CHANGELOG.md` or the package version manually; Changesets owns both.

## Failed publish checklist

- `npm view ragelayer version` reports whether that exact version already exists.
- The npm trusted publisher repository and workflow filename are case-sensitive.
- The workflow must run on a GitHub-hosted runner with `id-token: write`.
- A first public publish needs `access: public`; this is set in both Changesets and `publishConfig`.
- `bun run check:package` must pass before publishing.

Re-running the workflow is safe: `changeset publish` skips versions already present on npm.

Trusted publishing requires the exact repository and workflow filename configured on npm. Keep
`id-token: write`, use npm 11.5.1 or newer, and do not add `NODE_AUTH_TOKEN` or an `NPM_TOKEN`
repository secret. npm generates provenance automatically when the source repository is public;
private source repositories can use trusted publishing but cannot publish provenance.
