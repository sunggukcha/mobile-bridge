# Releasing

This project is distributed as a Git source repository, not as an npm package.

## One-time public repository setup

1. Create a new empty repository and push only this sanitized history. Do not
   graft or import the private development history.
2. Once the final public URL exists, add `repository`, `homepage`, and `bugs`
   fields to `package.json` and regenerate `package-lock.json`.
3. Enable GitHub private vulnerability reporting so the links in
   `SECURITY.md` and `CODE_OF_CONDUCT.md` are active.
4. Enable secret scanning and push protection. Protect `main` and require pull
   requests before merge.
5. Run the release checks locally on the minimum supported Node 22 release and
   current Node 24. This repository does not ship a GitHub Actions workflow.

## Release checklist

1. Start from a clean working tree on `main`.
2. Run `npm ci` and `npm run release:check`.
3. Review `git ls-files` for `.env`, state, logs, databases, archives, provider
   homes, credentials, or generated dependencies. None should be tracked.
4. Run the repository's secret scanner and inspect any synthetic fixture hit.
5. Inspect `git archive --format=tar HEAD` rather than copying the working
   directory; the working directory may contain ignored `node_modules` or
   local state.
6. Tag the verified commit and publish the GitHub-generated source archive.

If a container or executable bundle is added later, update
`THIRD_PARTY_NOTICES.md` and include all applicable upstream license texts in
that artifact.
