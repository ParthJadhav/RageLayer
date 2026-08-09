# Changesets

This repo versions releases with [Changesets](https://github.com/changesets/changesets).

- Made a user-facing change? Run `bun run changeset` and describe it (patch/minor/major).
- On push to `main`, the release workflow opens/updates a **Version Packages** PR that
  bumps `package.json` and writes `CHANGELOG.md` from pending changesets.
- Merging that PR tags `vX.Y.Z`, creates a GitHub Release with the changelog, and
  attaches an installable npm tarball. If an `NPM_TOKEN` secret is configured, the
  package is also published to npm.
