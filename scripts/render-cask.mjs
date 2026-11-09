#!/usr/bin/env node
// Prints the Homebrew cask for a release. The release workflow writes it to Casks/restless.rb in the
// <owner>/homebrew-tap repository, so people can install with:  brew install <owner>/tap/restless
//
//   node scripts/render-cask.mjs <tag> <version> <sha256-arm64-dmg> <sha256-x64-dmg> [owner/repo]
const [tag, version, armSha, intelSha, repo = 'Shivendra-99/restless'] = process.argv.slice(2);
const sha = /^[0-9a-f]{64}$/;
if (!tag || !/^\d+\.\d+\.\d+([-.][\w.]+)?$/.test(version ?? '') || !sha.test(armSha ?? '') || !sha.test(intelSha ?? '')) {
  console.error('usage: render-cask.mjs <tag> <version> <sha256-arm64-dmg> <sha256-x64-dmg> [owner/repo]');
  process.exit(1);
}

process.stdout.write(`cask "restless" do
  arch arm: "arm64", intel: "x64"

  version "${version}"
  sha256 arm:   "${armSha}",
         intel: "${intelSha}"

  url "https://github.com/${repo}/releases/download/${tag}/Restless-#{version}-#{arch}.dmg"
  name "Restless"
  desc "Local-first API and MCP client with network capture"
  homepage "https://github.com/${repo}"

  livecheck do
    url :url
    strategy :github_latest
  end

  depends_on macos: ">= :monterey"

  app "Restless.app"

  # Restless is open source but not notarized by Apple (that needs a paid developer account).
  # Removing the quarantine flag lets macOS open it without the "Apple could not verify" prompt.
  postflight do
    system_command "/usr/bin/xattr",
                   args: ["-dr", "com.apple.quarantine", "#{appdir}/Restless.app"]
  end

  zap trash: [
    "~/Library/Application Support/Restless",
    "~/Library/Logs/Restless",
    "~/Library/Preferences/com.spryotech.restless.plist",
    "~/Library/Saved Application State/com.spryotech.restless.savedState",
  ]

  caveats <<~EOS
    Restless isn't notarized by Apple, so this cask removed macOS's quarantine flag
    from Restless.app to let it open without the "Apple could not verify" prompt.
  EOS
end
`);
