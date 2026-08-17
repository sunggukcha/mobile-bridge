# Security policy

## Reporting a vulnerability

Use GitHub's [private vulnerability report](../../security/advisories/new).
If that form is unavailable, open a public issue containing only a request for
the maintainers to enable private reporting—do not disclose the vulnerability
there. Do not include bot tokens, OAuth credentials, message contents, state
archives, private repository URLs, or personal identifiers in any public post.

Include the affected version or commit, impact, minimal reproduction, and any
suggested mitigation. Maintainers will acknowledge the report and coordinate a
disclosure timeline after reproducing it.

## Supported versions

Security fixes target the latest revision of the default branch. This project
does not currently maintain older release lines.

## Deployment guidance

- Restrict both channel IDs and user IDs. `*_ALLOW_ALL_USERS` is an explicit
  high-trust opt-in.
- Keep `.env` and `.bridge_state` outside version control with owner-only
  permissions.
- Start with `workspace-write`; grant `danger-full-access` only to trusted,
  isolated jobs.
- Keep unattended maintenance and reports disabled until their destinations,
  repository permissions, and spending limits have been reviewed.
- Treat provider CLIs and their authentication stores as privileged software.
