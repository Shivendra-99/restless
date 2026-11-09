# Releasing Restless

Everything here is free. Restless is open source (MIT), so Windows signing comes from SignPath Foundation and the Microsoft Store signs its own package. macOS builds are ad-hoc signed; notarizing would need a paid Apple Developer account.

## Cut a release

1. Bump the version in `package.json`, `apps/desktop/package.json`, `apps/extension/package.json` and `apps/extension/manifest.json`, commit and push.
2. On GitHub: Releases → Draft a new release → type a new tag (`0.5.0` or `v0.5.0`), target `main` → Publish. (From a terminal, `git tag v0.5.0 && git push origin v0.5.0` does the same.)
3. The "Build and release" workflow builds everything and attaches the `.dmg`s, the Windows installer, the AppImage, the extension zip, `SHA256SUMS.txt` and the install notes to that release. It takes about 15–20 minutes. If Windows signing is set up, it waits until you approve the two signing requests in SignPath (restless.exe, then the installer).

To add the files to a release that has none (for example one published before this workflow existed): Actions → Build and release → Run workflow → enter the release's tag.

Run the workflow by hand with no tag to only build; the files are under the run's artifacts.

## One-time setup: Windows signing with SignPath Foundation (free)

SignPath signs open-source projects for free. The certificate is issued to SignPath Foundation, so Windows shows "SignPath Foundation" as the publisher. Like any new certificate, SmartScreen can still warn on the first releases until the downloads build up reputation; after that the warning goes away.

Their conditions, and where this repository meets them:

| Condition | Here |
|---|---|
| OSI license, no proprietary parts | MIT, [LICENSE](../LICENSE) |
| Already released, functionality described on the download page | GitHub Releases + README |
| Built from source on CI | [.github/workflows/build.yml](../.github/workflows/build.yml) |
| Code signing policy with roles, privacy and the SignPath attribution, linked from the home page and releases | [CODE_SIGNING_POLICY.md](../CODE_SIGNING_POLICY.md), linked from README and every release |
| Multi-factor authentication for everyone with access | Turn on 2FA on GitHub (Settings → Password and authentication) |

Steps:

1. Make sure 2FA is on for your GitHub account.
2. Apply at https://signpath.org/apply with the repository URL `https://github.com/Shivendra-99/restless`. Approval is manual and can take a while.
3. Once accepted, in SignPath:
   - Connect GitHub as a trusted build system for the project.
   - Create two artifact configurations, slugs `app` and `installer`:

     `app` (signs restless.exe):
     ```xml
     <?xml version="1.0" encoding="utf-8"?>
     <artifact-configuration xmlns="http://signpath.io/artifact-configuration/v1">
       <zip-file>
         <pe-file path="restless.exe">
           <authenticode-sign/>
         </pe-file>
       </zip-file>
     </artifact-configuration>
     ```

     `installer` (signs Restless-Setup-<version>.exe):
     ```xml
     <?xml version="1.0" encoding="utf-8"?>
     <artifact-configuration xmlns="http://signpath.io/artifact-configuration/v1">
       <zip-file>
         <pe-file path="Restless-Setup-*.exe">
           <authenticode-sign/>
         </pe-file>
       </zip-file>
     </artifact-configuration>
     ```

     SignPath may ask you to pin the product name (`Restless`) and version in these; follow their review.
   - Note the organization ID, the project slug and the signing policy slug (usually `release-signing`), and create an API token for a CI user that can submit signing requests.
4. In this GitHub repository, Settings → Secrets and variables → Actions:
   - Secret `SIGNPATH_API_TOKEN`: the API token.
   - Variable `SIGNPATH_ORGANIZATION_ID`: the organization ID. Setting it turns signing on.
   - Variables `SIGNPATH_PROJECT_SLUG` and `SIGNPATH_POLICY_SLUG`, only if they aren't `restless` and `release-signing`.
5. Push the next tag. Approve the two signing requests in SignPath when the run asks.

## One-time setup: Microsoft Store (free)

Apps installed from the Store never show a SmartScreen warning, because Microsoft signs them.

1. Sign up as an individual developer at https://storedeveloper.microsoft.com with a personal Microsoft account. It's free; you verify with a government ID and a selfie.
2. In Partner Center, create a new MSIX app and reserve its name. "Restless" may be taken; something like "Restless API Client" works too.
3. Open the app → Product identity, and copy three values into this repository's Actions variables:
   - `MSSTORE_IDENTITY_NAME` ← Package/Identity/Name
   - `MSSTORE_PUBLISHER` ← Package/Identity/Publisher (starts with `CN=`)
   - `MSSTORE_PUBLISHER_DISPLAY_NAME` ← Package/Properties/PublisherDisplayName
4. Push a tag. The release then also has `Restless-<version>.appx`. Upload it in Partner Center (Packages), fill in the listing (description, screenshots, privacy policy: link [CODE_SIGNING_POLICY.md](../CODE_SIGNING_POLICY.md#privacy)) and submit for certification.

The Store tile images are in `apps/desktop/build/appx` (made by `scripts/make-icons.py`).

## macOS

Builds are ad-hoc signed, which is free but not notarized. People install with Homebrew:

```
brew install shivendra-99/tap/restless
```

or without it:

```
curl -fsSL https://raw.githubusercontent.com/Shivendra-99/restless/main/scripts/install-mac.sh | bash
```

### One-time setup: Homebrew tap (free)

The official Homebrew cask list no longer takes apps that aren't notarized, so Restless has its own tap: the repository `Shivendra-99/homebrew-tap` with `Casks/restless.rb`. `brew install shivendra-99/tap/restless` adds the tap and installs in one step. The cask removes the quarantine flag after installing, so macOS opens the app without the "Apple could not verify" prompt, and says so in its install message.

Every release updates the cask automatically (version and checksums, made by `scripts/render-cask.mjs`). For that:

1. GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token.
   - Repository access: Only select repositories → `homebrew-tap`.
   - Permissions: Contents → Read and write.
   - Pick an expiry you'll remember to renew (GitHub emails you before it expires).
2. In the `restless` repository: Settings → Secrets and variables → Actions → New repository secret `HOMEBREW_TAP_TOKEN` with that token.

Files downloaded with `curl` aren't marked as coming from the internet, so macOS opens the app without asking. A `.dmg` downloaded in a browser needs System Settings → Privacy & Security → Open Anyway the first time.

If you ever join the Apple Developer Program ($99/year), set `mac.identity` back to automatic, `hardenedRuntime: true` and `notarize: true` in `apps/desktop/package.json`, and add `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_API_KEY`, `APPLE_API_KEY_ID` and `APPLE_API_ISSUER` as secrets.
