# Changesets

This repo versions releases with [Changesets](https://github.com/changesets/changesets).

- Made a user-facing change? Run `bun run changeset` and describe it (patch/minor/major).
- On push to `main`, the release workflow opens/updates a **chore: version packages** PR that
  bumps `package.json` and writes `CHANGELOG.md` from pending changesets.
- Merging that PR publishes to npm, tags `vX.Y.Z`, creates a GitHub Release with the
  changelog, and attaches the published registry tarball.

Publishing uses npm **trusted publishing** (OIDC). There is no `NPM_TOKEN` or
`NODE_AUTH_TOKEN` secret, and adding one would break provenance — see
[docs/releasing.md](../docs/releasing.md).
