#!/bin/bash
set -euo pipefail
project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
source_app="${1:-$HOME/Library/Developer/Xcode/DerivedData/UserscriptsEnhanced/Build/Products/Debug/Userscripts Enhanced Debug.app}"
node "$project_root/scripts/verify-artifact.js" "$source_app"
source_id="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$source_app/Contents/Info.plist")"
if [ "$source_id" != local.userscripts-enhanced.mac ]; then echo 'This installer accepts only the Enhanced Debug product.' >&2; exit 1; fi
destination="$HOME/Applications/Userscripts Enhanced Debug.app"
if pgrep -f '/Userscripts Enhanced Debug.app/Contents/MacOS/Userscripts Enhanced Debug' >/dev/null; then
  echo 'Quit Userscripts Enhanced Debug before replacing its application bundle.' >&2; exit 1
fi
if pgrep -x Safari >/dev/null; then
  echo 'Quit Safari with Command-Q before installing Enhanced. Live replacement can leave PlugInKit using two native-extension versions.' >&2; exit 1
fi
mkdir -p "$HOME/Applications"
if [ -e "$destination" ]; then
  existing_id="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$destination/Contents/Info.plist")"
  if [ "$existing_id" != "$source_id" ]; then echo 'Refusing to replace an application with a different identifier.' >&2; exit 1; fi
fi
staging="$(mktemp -d "$HOME/Applications/.ue-install.XXXXXX")"
trap 'if [ -d "$staging" ]; then rm -rf "$staging"; fi' EXIT
ditto --norsrc --noextattr "$source_app" "$staging/Userscripts Enhanced Debug.app"
node "$project_root/scripts/verify-artifact.js" "$staging/Userscripts Enhanced Debug.app"
if [ -e "$destination" ]; then mv "$destination" "$HOME/Applications/Userscripts Enhanced Debug.previous.$(date +%Y%m%d%H%M%S).app.backup"; fi
mv "$staging/Userscripts Enhanced Debug.app" "$destination"
# Remove the verified build product registration before registering the installed copy.
# Never unregister by bundle ID: only this exact Enhanced source path is removed.
if [ "$source_app" != "$destination" ]; then
  source_plugin="$source_app/Contents/PlugIns/Userscripts Enhanced Extension.appex"
  registrations="$(/usr/bin/pluginkit -m -A -D -v -i "${source_id}.extension")"
  if [[ "$registrations" == *"$source_plugin"* ]]; then
    /usr/bin/pluginkit -r "$source_plugin"
  fi
  /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -u "$source_app"
fi
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$destination"
/usr/bin/pluginkit -a "$destination/Contents/PlugIns/Userscripts Enhanced Extension.appex"
printf '%s\n' "$destination"
