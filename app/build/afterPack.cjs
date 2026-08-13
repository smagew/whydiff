// Ad-hoc sign the packaged macOS app (free — no Apple Developer account).
//
// electron-builder skips signing when it finds no matching keychain identity, which
// leaves the Electron binary carrying only the linker's placeholder signature. A
// quarantined download of that shows "whydiff.app is damaged and can't be opened".
// A real ad-hoc signature over the whole bundle (`codesign --deep --force --sign -`)
// gives it a valid, self-signed identity — enough to run, and enough that Gatekeeper
// shows the ordinary "developer cannot be verified / Open Anyway" prompt instead.
// (It does NOT remove that prompt — only a notarised Developer ID does.)
const { execFileSync } = require('node:child_process')
const { join } = require('node:path')

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return
  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  execFileSync('codesign', ['--deep', '--force', '--sign', '-', app], { stdio: 'inherit' })
  console.log(`  • ad-hoc signed ${app}`)
}
