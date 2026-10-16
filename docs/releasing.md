# Releasing

Publishing is automated in [`.github/workflows/publish.yml`](../.github/workflows/publish.yml)
with npm **Trusted Publishing**: GitHub mints a short-lived OIDC token and npm
validates it against the package's configured publisher. There is **no `NPM_TOKEN`
secret and no 2FA prompt**, and the published tarball carries provenance.

## One-time setup (npm)

Add a Trusted Publisher on the package's npm settings page:
<https://www.npmjs.com/package/@sfgartland/better-pi-voice/access>

| Field                 | Value                  |
| --------------------- | ---------------------- |
| Publisher             | GitHub Actions         |
| Organization or user  | `sfgartland`           |
| Repository            | `better-pi-voice`      |
| Workflow filename     | `publish.yml`          |
| Environment name      | *(leave empty)*        |
| Allowed actions       | `npm publish`          |

The workflow filename must match exactly. If you ever rename the workflow, update
the trusted publisher to match, or npm will reject the OIDC token.

## Cutting a release

1. Update `CHANGELOG.md` (move the entries out of **Unreleased**).
2. From a clean `main`:

   ```bash
   npm version patch        # or minor / major — bumps package.json, commits, tags
   git push --follow-tags   # the v* tag triggers the Publish workflow
   ```

The workflow runs `bun run check` (typecheck, lint, test) before publishing, and
refuses to publish when the pushed tag does not match `package.json`.

## Re-running a publish

For a version that is committed but not yet on npm (e.g. the current `0.1.1`), run
the workflow by hand: **Actions → Publish → Run workflow**, on `main`.

`workflow_dispatch` skips the tag/version guard, so confirm `package.json` holds the
version you intend to ship first.

## Without GitHub Actions

`npm publish --access public` from a checkout still works; the account's 2FA applies.
