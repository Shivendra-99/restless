# Code signing policy

Windows builds of Restless are signed for free: code signing is provided by [SignPath.io](https://signpath.io), certificate by [SignPath Foundation](https://signpath.org).

## What gets signed

Only files built from this repository's source code by the release workflow ([`.github/workflows/build.yml`](.github/workflows/build.yml)) on GitHub-hosted runners:

- `Restless.exe` (the application) from `apps/desktop`
- the Windows installer `Restless Setup <version>.exe`

Nothing built on a personal computer is signed. Third-party files shipped inside the app (Electron's own DLLs) are not signed by this project.

Every release is built from a tagged commit on `main`. Each signing request is approved by hand before SignPath signs it.

## Team roles

| Role | Who |
|---|---|
| Committers and reviewers | [Shivendra-99](https://github.com/Shivendra-99) and the collaborators listed on this repository |
| Approvers | [Shivendra-99](https://github.com/Shivendra-99) |

Everyone with access to the repository or to signing uses multi-factor authentication. Changes from people who are not committers are reviewed before they are merged.

## Privacy

Restless does not send data anywhere on its own. It has no account, no telemetry, no analytics and no update check. It only connects to:

- the URLs you send requests to, and the MCP servers you connect to;
- the websites you open in the Restless browser (Capture).

Your workspace stays in the folder you choose. Secrets marked 🔒 are encrypted with your operating system's key store. Captures stay in the app's own data folder on your computer.

## Installing and uninstalling

The Windows installer installs Restless for the current user (or to a folder you choose) and adds an uninstaller under Settings → Apps. It doesn't change system settings.

## Reporting a problem

If you find a signed file that you think was not built from this repository, or anything else wrong with a release, open an issue at https://github.com/Shivendra-99/restless/issues.
