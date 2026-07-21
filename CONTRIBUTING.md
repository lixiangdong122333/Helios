# Contributing to Helios

## Branch model

Helios uses a trunk-based GitHub Flow:

- `main` is the only long-lived branch and must remain releasable.
- Create short-lived branches from the latest `main` using one of these prefixes: `feat/`, `fix/`, `refactor/`, `docs/`, `chore/`, or `ci/`.
- Open a pull request into `main`; do not push application changes directly to `main`.
- Keep branches focused and short-lived. Delete the branch after the pull request is merged.
- Use `hotfix/` from `main` for urgent fixes. Only create a `support/vX.Y` branch when an older release must be maintained in parallel.

## Pull requests

Pull requests must pass `Build and test`, `Build container`, and every `Build SEA (...)` matrix check. Use a squash merge so `main` has a readable, linear history. Pull request titles and squash commits should follow Conventional Commits, for example:

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
git tag --annotate v0.2.0 --message "Release v0.2.0"
git push origin v0.2.0
```

The release workflow reruns the type check, tests, and build before creating the GitHub Release. It marks tags containing a prerelease suffix such as `v1.0.0-rc.1` as prereleases. Every release keeps the npm package archive and adds native-runner SEA archives for Windows x64, glibc Linux x64/arm64, and macOS arm64, plus `SHA256SUMS.txt`.

Do not move or delete release tags. To correct a release, publish a new patch version.

## Local validation

```powershell
npm ci
npm run check
npm test
npm run build
npm run build:sea
npm run smoke:sea -- <path-to-sea-executable>
```

`smoke:sea` points ADC at a deliberately missing file, so it can exercise the bundled Google client and controlled error path without contacting Cloud Logging; it is safe for the default pull request gate. Live Cloud Logging smoke tests require ADC and a project with `logging.logEntries.list` permission and are intentionally not part of that gate.
