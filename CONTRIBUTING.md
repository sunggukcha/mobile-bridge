# Contributing

Thanks for helping improve Mobile Codex Bridge.

## Development setup

1. Use Linux or WSL2 with a supported Node.js version (`>=22.13 <23` or
   `>=23.4`).
2. Run `npm ci`.
3. Copy `.env.example` to `.env` only for local runtime testing. Never commit
   `.env`, bridge state, logs, credentials, or chat exports.
4. Run `npm test` before opening a pull request.

Use `npm run release:check` to run the full test suite and inspect the package
manifest. Linux integration tests require `bash`, `procps`, and `util-linux`.

## Pull requests

- Keep each change focused and explain its user-visible effect.
- Add or update regression tests for behavior changes.
- Preserve safe defaults. New external effects, broad filesystem access, and
  unattended maintenance must remain opt-in.
- Use synthetic IDs, names, URLs, timestamps, and task content in fixtures.
  Never copy production Discord/Slack events or personal TODO data into tests.
- Do not embed vendor OAuth clients, API tokens, or host-specific paths.
- Update `.env.example` and the README when configuration changes.

By contributing, you agree that your contribution is licensed under the MIT
License in this repository.
