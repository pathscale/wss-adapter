# Trusted npm publisher for `@pathscale/wss-adapter`

The manual GitHub Actions publisher lives at `.github/workflows/publish.yml`. It publishes only the package version in the exact current `master` commit when the corresponding `vMAJOR.MINOR.PATCH` tag points to that same commit and the version is not already present on npm. It has no tag-push trigger and does not use an npm token.

## One-time publisher setup

1. Register npm Trusted Publishing for package `@pathscale/wss-adapter`, GitHub owner `pathscale`, repository `wss-adapter`, workflow filename exactly `publish.yml`, and GitHub environment exactly `npm-publish`.
2. In GitHub, create the `npm-publish` environment and restrict deployments to the protected `master` branch. The publish job declares this environment; the environment branch rule is what prevents a workflow dispatched from another branch from receiving the registered OIDC identity.
3. Keep the package access public. Do not add an npm automation token or secret to the workflow.

## Release procedure

1. Merge the reviewed source and workflow changes to `master`. Review the package version and the exact resulting commit SHA. Do not dispatch from a feature branch.
2. Create and push the release tag on that exact commit. For example, after setting `RELEASE_SHA` to the full reviewed SHA and `VERSION` to the package version from that commit:

   ```sh
   git fetch origin master
   test "$(git ls-remote origin refs/heads/master | cut -f1)" = "$RELEASE_SHA"
   git tag -a "v$VERSION" "$RELEASE_SHA" -m "Release $VERSION"
   git push origin "refs/tags/v$VERSION"
   ```

   Do not move or reuse an existing release tag. If the package version is already published, prepare a new version and tag on a newly reviewed master commit.
3. In GitHub Actions, select **Publish to npm**, choose the `master` branch, and dispatch with `master_sha` equal to the same full 40-character SHA. The workflow independently checks the selected ref/SHA, current `origin/master`, the tag's peeled commit, package name/version, and npm's version endpoint before checkout, dependency installation, or package scripts.
4. Review the build, lint, package contents and tarball digest jobs. The final job rechecks the exact source and unpublished version, downloads the digest-bound tarball, and publishes that tarball with npm Trusted Publishing and provenance.

If `master` advances, a tag resolves elsewhere, the package/version changes, npm already contains the version, or registry/GitHub validation is unavailable, the workflow fails closed. Start a new release procedure against a newly reviewed exact master revision; do not retarget the tag or retry with a different SHA for the same version.

## Workflow boundaries

The build job installs the frozen Bun lockfile and runs the repository's lint and build scripts only after verifying the guarded commit. It inspects the npm pack report and permits only `package.json`, `README.md`, and `dist/**`, including the JavaScript and declaration entry points. It packs with lifecycle scripts disabled and transfers only the tarball and its SHA-256 digest.

The OIDC-enabled publish job does not install dependencies or execute package code. It checks out the guarded source only to bind npm provenance to that commit, verifies the downloaded tarball's digest and manifest, and publishes with `--ignore-scripts`. The npm Trusted Publisher registration and protected `npm-publish` environment are required for the workflow to publish.
