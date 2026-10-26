# Code signing policy

Free code signing provided by [SignPath.io](https://about.signpath.io),
certificate by [SignPath Foundation](https://signpath.org).

**Status.** Archyne applied to the SignPath Foundation programme on
2026-10-26. Until the application is accepted and the release workflow
submits its builds for signing, the Windows installer is unsigned, and each
release page says so. The macOS builds are signed separately, with an Apple
Developer ID, which does not exist yet either. Linux packages are not signed.

## What is signed

Only what the release workflow,
[`.github/workflows/release.yml`](.github/workflows/release.yml), builds on
GitHub Actions from a `v*` tag of this repository: the Windows installer
`Archyne-Setup-<version>.exe` and the program files inside it. Nothing built
on a personal machine is signed, and nothing built by another project:
third-party libraries travel inside the installer as their authors published
them.

Every signing request is approved by hand, release by release.

## Team roles

- **Committers and reviewers:** [Dario](https://github.com/dariodd), the
  project's maintainer. A pull request from anyone else is reviewed by him
  before it is merged.
- **Approvers:**
  [owners of the archyne organization](https://github.com/orgs/archyne/people?query=role%3Aowner).

Everyone in these roles uses multi-factor authentication on GitHub and on
SignPath.

## Privacy policy

This program will not transfer any information to other networked systems
unless specifically requested by the user or the person installing or
operating it.

There are two such requests, both made by name:

- **Importing an icon from a link** fetches that link, from the host it
  names.
- **Generate** sends the diagram and the request typed to the AI provider the
  user configured, with the user's own key or account. That provider's
  privacy policy then applies to what it receives; see
  [docs/generate.md](docs/generate.md).

Archyne has no server of its own, no accounts and no telemetry.

## Reporting

A security problem in Archyne: see the [security policy](SECURITY.md). A
file signed with a SignPath Foundation certificate that breaks
[their conditions](https://signpath.org/terms): report it to
support@signpath.io.
