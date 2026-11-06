#!/bin/bash
set -euo pipefail
project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$project_root"
derived_data="${UE_DERIVED_DATA:-$HOME/Library/Developer/Xcode/DerivedData/UserscriptsEnhanced}"
args=(-project xcode/Userscripts.xcodeproj -scheme Mac -configuration Debug -derivedDataPath "$derived_data")
for method in testEnhancedNativeRequestCompletion testEnhancedMetadata testEnhancedIdentityAndRevision testEnhancedMenuPathTraversalIsDenied testEnhancedNamespaceAndIntegrity testEnhancedExclusionPrecedence testEnhancedBackupValidation testEnhancedReservedURLCharacters testEnhancedOriginalContainerGuard testStringSanitization testEncodedCheck testMatching; do
  args+=("-only-testing:Mac-Tests/UserscriptsTests/$method")
done
args+=(-only-testing:Mac-Tests/UrlCodecTests/testEncodeURI -only-testing:Mac-Tests/UrlCodecTests/testJsLikeURL)
xcodebuild "${args[@]}" test
