# Contributing to Helios

## Branch model

Helios uses a trunk-based GitHub Flow:

- `main` is the only long-lived branch and must remain releasable.
- Create short-lived branches from the latest `main` using one of these prefixes: `feat/`, `fix/`, `refactor/`, `docs/`, `chore/`, or `ci/`.
- Open a pull request into `main`; do not push application changes directly to `main`.
- Keep branches focused and short-lived. Delete the branch after the pull request is merged.
- Use `hotfix/` from `main` for urgent fixes. Only create a `support/vX.Y` branch when an older release must be maintained in parallel.

## Pull requests

Pull requests must pass the `Build and test` and `Build container` checks. Use a squash merge so `main` has a readable, linear history. Pull request titles and squash commits should follow Conventional Commits, for example:

```text
feat(query): add trace-aware resource filtering
fix(http): reject mismatched host headers
docs(readme): clarify ADC setup
```

Use `feat` for a backward-compatible capability, `fix` for a backward-compatible correction, and `type!` or a `BREAKING CHANGE` footer for an incompatible change.

## Releases

Releases use Semantic Versioning and immutable tags in the form `vMAJOR.MINOR.PATCH`. A release is created by pushing a tag that matches the version in `package.json` and points to a commit contained in `main`:

```powershell
git switch main
git pull --ff-only
git tag --annotate v0.1.0 --message "Release v0.1.0"
git push origin v0.1.0
```

The release workflow reruns the type check, tests, and build before creating the GitHub Release. It marks tags containing a prerelease suffix such as `v1.0.0-rc.1` as prereleases and uploads the npm package archive.

Do not move or delete release tags. To correct a release, publish a new patch version.

## Local validation

```powershell
npm ci
npm run check
npm test
npm run build
```

Cloud Logging smoke tests require ADC and a project with `logging.logEntries.list` permission; they are intentionally not part of the default pull request gate.
