#!/bin/bash
set -euo pipefail
project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$project_root"
configuration="${1:-Debug}"
case "$configuration" in Debug|Release) ;; *) echo 'Usage: build-enhanced.sh [Debug|Release]' >&2; exit 64;; esac
derived_data="${UE_DERIVED_DATA:-$HOME/Library/Developer/Xcode/DerivedData/UserscriptsEnhanced}"
if pgrep -x Safari >/dev/null; then
  echo 'Quit Safari with Command-Q before building Enhanced. Xcode registers its product during build; the wrapper removes that registration before Safari may reopen.' >&2; exit 1
fi
if [ "$configuration" = Debug ]; then product='Userscripts Enhanced Debug.app'; expected_id='local.userscripts-enhanced.mac'; else product='Userscripts Enhanced.app'; expected_id='local.userscripts-enhanced.mac.release'; fi
built_app="$derived_data/Build/Products/$configuration/$product"
# Xcode registers products even if later validation fails. Always clean up that
# exact verified Enhanced identity; never unregister the installed app by ID.
cleanup_build_registration() {
  build_status=$?
  if [ -f "$built_app/Contents/Info.plist" ]; then
    cleanup_id="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$built_app/Contents/Info.plist")"
    if [ "$cleanup_id" != "$expected_id" ]; then echo 'Refusing registration cleanup for an unexpected app identity.' >&2; exit 1; fi
    /usr/bin/pluginkit -r "$built_app/Contents/PlugIns/Userscripts Enhanced Extension.appex"
    /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -u "$built_app"
  fi
  exit "$build_status"
}
trap cleanup_build_registration EXIT
npm run build:mac-safari-16.4
xcodebuild -project xcode/Userscripts.xcodeproj -scheme Mac -configuration "$configuration" -derivedDataPath "$derived_data" build
node scripts/verify-artifact.js "$built_app"
