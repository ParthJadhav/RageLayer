# Releasing

Releases use Changesets, GitHub Actions, and npm trusted publishing. A release should be reproducible
from the tagged commit. npm adds provenance automatically when the source repository is public.

## One-time npm setup

The package name must exist on npm before its settings can nominate a trusted publisher. For the
first release, either add a granular `NPM_TOKEN` repository secret or publish once from a verified
maintainer machine:

```sh
bun install --frozen-lockfile
bun run check
npm login
npm publish --access public
```

Then configure npm's trusted publisher for:

| Field | Value |
| --- | --- |
| Provider | GitHub Actions |
| Repository | `ParthJadhav/ragelayer` |
| Workflow | `release.yml` |
| Permission | Publish |

The workflow grants `id-token: write` and uses a supported Node/npm environment. After a successful
trusted publish, remove the long-lived `NPM_TOKEN` secret and disallow token publishing in the npm
package settings.

## Normal release flow

1. Add a changeset with every user-visible pull request: `bun run changeset`.
2. Merge the pull request to `main`.
3. The release workflow opens or updates the **chore: version packages** pull request.
4. Review the version and generated changelog, then merge that pull request.
5. The workflow runs the complete package check, publishes to npm, creates the git tag and GitHub
   Release, downloads the published registry tarball, and attaches that exact `.tgz` artifact.

Do not edit `CHANGELOG.md` or the package version manually; Changesets owns both.

## Failed publish checklist

- `npm view ragelayer version` reports whether that exact version already exists.
- The npm trusted publisher repository and workflow filename are case-sensitive.
- The workflow must run on a GitHub-hosted runner with `id-token: write`.
- A first public publish needs `access: public`; this is set in both Changesets and `publishConfig`.
- `bun run check:package` must pass before publishing.

Re-running the workflow is safe: `changeset publish` skips versions already present on npm.

## npm trusted publishing

The release job authenticates with the `NPM_TOKEN` secret today. Moving to trusted publishing
(OIDC) removes that long-lived credential entirely:

1. On npmjs.com, open the package's **Settings → Trusted publishers**.
2. Add a GitHub Actions publisher for `ParthJadhav/ragelayer`, workflow `release.yml`,
   on the `main` branch.
3. Delete the `NPM_TOKEN` repository secret.

The workflow already requests `id-token: write` and installs a recent npm, so nothing else needs
to change: with a trusted publisher configured, npm exchanges the job's OIDC token for a
short-lived credential and ignores `NODE_AUTH_TOKEN`. npm generates provenance automatically when
the source repository is public; private source repositories can use trusted publishing but cannot
publish provenance.
