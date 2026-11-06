import SafariServices
import CryptoKit

// Persistent UUIDs belong to the Enhanced extension container, never App Store data.
private let scriptIdentityLock = NSLock()
func stableScriptId(_ filename: String) -> String {
    scriptIdentityLock.lock()
    defer { scriptIdentityLock.unlock() }
    let key = "UE.ScriptId." + filename
    if let value = UserDefaults.standard.string(forKey: key) { return value }
    let value = UUID().uuidString
    UserDefaults.standard.set(value, forKey: key)
    return value
}

func scriptRevision(_ content: String) -> String {
    SHA256.hash(data: Data(content.utf8)).map { String(format: "%02x", $0) }.joined()
}

func validateMenuScripts(_ scripts: [[String: Any]]) -> [String] {
    guard scripts.count <= 500, let location = getSaveLocation() else { return [] }
    let started = location.startAccessingSecurityScopedResource()
    defer { if started { location.stopAccessingSecurityScopedResource() } }
    let manifest = getManifest()
    guard manifest.settings["active"] == "true" else { return [] }
    var allowed = Set<String>()
    for script in scripts {
        guard let filename = script["filename"] as? String,
              filename == (filename as NSString).lastPathComponent,
              !filename.contains("\\"), !filename.hasPrefix("."),
              filename.hasSuffix(".js"),
              !manifest.disabled.contains(filename),
              let id = script["scriptId"] as? String,
              let revision = script["revision"] as? String,
              id == stableScriptId(filename),
              let content = try? String(contentsOf: location.appendingPathComponent(filename), encoding: .utf8),
              scriptRevision(content) == revision,
              let parsed = parse(content),
              let metadata = parsed["metadata"] as? [String: [String]],
              let grants = metadata["grant"], !grants.contains("none"),
              grants.contains("GM_registerMenuCommand") || grants.contains("GM.registerMenuCommand") || grants.contains("UE.registerPanel")
        else { continue }
        allowed.insert(id)
    }
    return Array(allowed)
}

func authorizeXHR(_ identity: [String: Any]) -> [String: Any] {
    guard let filename = identity["filename"] as? String,
          filename == (filename as NSString).lastPathComponent,
          !filename.contains("\\"), !filename.hasPrefix("."), filename.hasSuffix(".js"),
          let id = identity["scriptId"] as? String, id == stableScriptId(filename),
          let revision = identity["revision"] as? String,
          let location = getSaveLocation() else { return ["allowed": false] }
    let started = location.startAccessingSecurityScopedResource()
    defer { if started { location.stopAccessingSecurityScopedResource() } }
    let manifest = getManifest()
    guard manifest.settings["active"] == "true", !manifest.disabled.contains(filename),
          let content = try? String(contentsOf: location.appendingPathComponent(filename), encoding: .utf8),
          scriptRevision(content) == revision, let parsed = parse(content),
          let metadata = parsed["metadata"] as? [String: [String]],
          let grants = metadata["grant"], !grants.contains("none"),
          grants.contains("GM_xmlhttpRequest") || grants.contains("GM.xmlHttpRequest")
    else { return ["allowed": false] }
    return ["allowed": true, "connect": metadata["connect"] ?? []]
}

func authorizeGrantedAPI(_ identity: [String: Any], _ method: String) -> Bool {
    let methods = ["openInTab", "getTab", "saveTab", "getTabs", "setClipboard"]
    guard methods.contains(method), let filename = identity["filename"] as? String,
          let id = identity["scriptId"] as? String, let revision = identity["revision"] as? String,
          id == stableScriptId(filename), let file = try? enhancedScriptURL(filename),
          let location = getSaveLocation() else { return false }
    let started = location.startAccessingSecurityScopedResource()
    defer { if started { location.stopAccessingSecurityScopedResource() } }
    let manifest = getManifest()
    guard manifest.settings["active"] == "true", !manifest.disabled.contains(filename),
          let content = try? String(contentsOf: file, encoding: .utf8), scriptRevision(content) == revision,
          let metadata = parse(content)?["metadata"] as? [String: [String]],
          let grants = metadata["grant"], !grants.contains("none") else { return false }
    return grants.contains("GM." + method) || grants.contains("GM_" + method)
}

func enhancedFilename(_ metadata: [String: [String]], _ type: String) -> String {
    let name = sanitize(metadata["name"]?.first ?? "Untitled")
    let namespace = metadata["namespace"]?.first ?? ""
    let suffix = namespace.isEmpty ? "" : " [" + String(scriptRevision(namespace).prefix(10)) + "]"
    return name + suffix + ".user." + type
}


private final class EnhancedSourceLoader: NSObject, URLSessionDataDelegate {
    let completed = DispatchSemaphore(value: 0)
    var data = Data()
    var failure: Error?
    var status = 0
    var mime = "application/octet-stream"
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        failure = enhancedError("Source redirected; use its final HTTPS URL and review it explicitly")
        completionHandler(nil)
    }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse, completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        status = (response as? HTTPURLResponse)?.statusCode ?? 0
        mime = response.mimeType ?? "application/octet-stream"
        if response.expectedContentLength > 10_000_000 {
            failure = enhancedError("Remote script exceeds 10 MB")
            completionHandler(.cancel)
        } else { completionHandler(.allow) }
    }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive chunk: Data) {
        if data.count + chunk.count > 10_000_000 {
            failure = enhancedError("Remote script exceeds 10 MB")
            dataTask.cancel()
        } else { data.append(chunk) }
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        failure = failure ?? error
        completed.signal()
    }
}

func enhancedRemoteData(_ source: String) throws -> (Data, String) {
    guard let url = URL(string: source), url.scheme == "https", url.host != nil, url.user == nil, url.password == nil else {
        throw enhancedError("Update source must be an HTTPS URL without embedded credentials")
    }
    let loader = EnhancedSourceLoader()
    let configuration = URLSessionConfiguration.ephemeral
    configuration.timeoutIntervalForRequest = 15
    configuration.timeoutIntervalForResource = 30
    configuration.httpCookieStorage = nil
    configuration.httpShouldSetCookies = false
    let session = URLSession(configuration: configuration, delegate: loader, delegateQueue: nil)
    let task = session.dataTask(with: url)
    task.resume()
    defer { session.invalidateAndCancel() }
    guard loader.completed.wait(timeout: .now() + 31) == .success else { throw enhancedError("Update download timed out") }
    if let error = loader.failure { throw error }
    guard loader.status == 200 else { throw enhancedError("Remote source was not an HTTP 200 response") }
    return (loader.data, loader.mime)
}

func enhancedRemoteSource(_ source: String) throws -> String {
    let (data, _) = try enhancedRemoteData(source)
    try enhancedIntegrity(data, source)
    guard let text = String(data: data, encoding: .utf8), !text.isEmpty else { throw enhancedError("Remote source is not valid UTF-8") }
    return text
}

private struct EnhancedResourceRecord: Codable {
    let data: Data
    let mime: String
    let digest: String
}

func enhancedIntegrity(_ data: Data, _ source: String) throws {
    guard let fragment = URLComponents(string: source)?.fragment, !fragment.isEmpty else { return }
    let normalized = fragment.replacingOccurrences(of: "-", with: "=", options: [], range: fragment.range(of: "-"))
    let pieces = normalized.split(separator: "=", maxSplits: 1).map(String.init)
    guard pieces.count == 2 else { throw enhancedError("Unsupported resource integrity syntax") }
    let digest: Data
    switch pieces[0].lowercased() {
    case "sha256": digest = Data(SHA256.hash(data: data))
    case "sha384": digest = Data(SHA384.hash(data: data))
    case "sha512": digest = Data(SHA512.hash(data: data))
    default: throw enhancedError("Unsupported resource integrity algorithm")
    }
    guard let expected = Data(base64Encoded: pieces[1]), expected == digest else { throw enhancedError("Resource integrity check failed") }
}

func enhancedResourceBundle(_ identity: [String: Any]) throws -> [String: Any] {
    guard let filename = identity["filename"] as? String,
          let file = try? enhancedScriptURL(filename), let location = getSaveLocation() else { throw enhancedError("Invalid script resource request") }
    let started = location.startAccessingSecurityScopedResource()
    defer { if started { location.stopAccessingSecurityScopedResource() } }
    guard identity["scriptId"] as? String == stableScriptId(filename),
          let content = try? String(contentsOf: file, encoding: .utf8), scriptRevision(content) == identity["revision"] as? String,
          let metadata = parse(content)?["metadata"] as? [String: [String]],
          let grants = metadata["grant"], !grants.contains("none"),
          grants.contains(where: { ["GM_getResourceText", "GM_getResourceURL", "GM.getResourceText", "GM.getResourceUrl", "GM.getResourceURL"].contains($0) }),
          getManifest().settings["active"] == "true", !getManifest().disabled.contains(filename) else { throw enhancedError("Script lacks resource permission") }
    let directory = getDocumentsDirectory().appendingPathComponent("UEResources").appendingPathComponent(stableScriptId(filename))
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    var bundle = [String: Any]()
    let declarations = metadata["resource"] ?? []
    guard declarations.count <= 32 else { throw enhancedError("Too many script resources (limit 32)") }
    var totalBytes = 0
    for declaration in declarations {
        let parts = declaration.split(maxSplits: 1, whereSeparator: { $0.isWhitespace }).map(String.init)
        guard parts.count == 2, bundle[parts[0]] == nil else { throw enhancedError("Invalid or duplicate @resource name") }
        let source = parts[1]
        let cache = directory.appendingPathComponent(scriptRevision(source) + ".json")
        let record: EnhancedResourceRecord
        if FileManager.default.fileExists(atPath: cache.path) {
            record = try JSONDecoder().decode(EnhancedResourceRecord.self, from: Data(contentsOf: cache))
            guard record.digest == SHA256.hash(data: record.data).map({ String(format: "%02x", $0) }).joined() else { throw enhancedError("Cached resource is corrupted") }
        } else {
            let (data, mime) = try enhancedRemoteData(source)
            try enhancedIntegrity(data, source)
            record = EnhancedResourceRecord(data: data, mime: mime, digest: SHA256.hash(data: data).map({ String(format: "%02x", $0) }).joined())
            try JSONEncoder().encode(record).write(to: cache, options: .atomic)
        }
        try enhancedIntegrity(record.data, source)
        totalBytes += record.data.count
        guard totalBytes <= 8_000_000 else { throw enhancedError("Script resources exceed the 8 MB bundle limit") }
        var resource: [String: String] = ["url": "data:" + record.mime + ";base64," + record.data.base64EncodedString()]
        if let text = String(data: record.data, encoding: .utf8) { resource["text"] = text }
        bundle[parts[0]] = resource
    }
    return bundle
}

// Enhanced import/update transactions live only in this extension's container.
private func enhancedError(_ message: String) -> NSError {
    NSError(domain: "UserscriptsEnhanced", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
}

func enhancedScriptURL(_ filename: String) throws -> URL {
    guard !filename.isEmpty, filename.utf8.count <= 250,
          filename == (filename as NSString).lastPathComponent,
          !filename.hasPrefix("."), !filename.contains("\\"),
          filename.hasSuffix(".js") || filename.hasSuffix(".css"),
          let location = getSaveLocation() else { throw enhancedError("Invalid script path") }
    let result = location.appendingPathComponent(filename)
    guard result.resolvingSymlinksInPath().deletingLastPathComponent() == location.resolvingSymlinksInPath() else {
        throw enhancedError("Script symlinks outside the selected directory are not permitted")
    }
    return result
}

func enhancedExport() throws -> [String: Any] {
    guard let files = getAllFiles() else { throw enhancedError("Could not read script directory") }
    let scripts: [[String: Any]] = files.sorted { ($0["filename"] as? String ?? "") < ($1["filename"] as? String ?? "") }.map {
        ["filename": $0["filename"]!, "scriptId": $0["scriptId"]!, "content": $0["content"]!, "disabled": $0["disabled"]!]
    }
    let manifest = getManifest()
    return ["format": "userscripts-enhanced", "version": 1, "scripts": scripts,
            "nativeSettings": manifest.settings, "blacklist": manifest.blacklist]
}

func enhancedStateRevision() throws -> String {
    let data = try JSONSerialization.data(withJSONObject: enhancedExport(), options: [.sortedKeys])
    return scriptRevision(String(decoding: data, as: UTF8.self))
}

func enhancedValidateImport(_ backup: [String: Any]) throws -> [[String: Any]] {
    guard backup["format"] as? String == "userscripts-enhanced", backup["version"] as? Int == 1,
          let scripts = backup["scripts"] as? [[String: Any]], !scripts.isEmpty, scripts.count <= 500 else {
        throw enhancedError("Unsupported backup format/version or script count")
    }
    if let list = backup["blacklist"] {
        guard let strings = list as? [String], strings.count <= 1000 else { throw enhancedError("Invalid website exclusions in backup") }
    }
    if let settings = backup["nativeSettings"] {
        guard settings is [String: String] else { throw enhancedError("Invalid native settings in backup") }
    }
    var filenames = Set<String>()
    var identities = Set<String>()
    var bytes = 0
    for script in scripts {
        guard let filename = script["filename"] as? String,
              let content = script["content"] as? String, content.utf8.count <= 10_000_000,
              let id = script["scriptId"] as? String, UUID(uuidString: id) != nil,
              script["disabled"] is Bool, parse(content) != nil,
              filenames.insert(filename.lowercased()).inserted, identities.insert(id).inserted else {
            throw enhancedError("Invalid or duplicate script in backup")
        }
        _ = try enhancedScriptURL(filename)
        bytes += content.utf8.count
        guard bytes <= 50_000_000 else { throw enhancedError("Backup exceeds 50 MB script limit") }
    }
    guard let installed = getAllFiles() else { throw enhancedError("Could not read existing script identities") }
    for file in installed {
        guard let existingId = file["scriptId"] as? String, let filename = file["filename"] as? String else { continue }
        if identities.contains(existingId) && !filenames.contains(filename.lowercased()) {
            throw enhancedError("A backup identity belongs to a different installed filename")
        }
    }
    return scripts
}

private struct EnhancedImportTransaction: Codable {
    let directory: String
    let beforeFiles: [String: String]
    let addedFiles: [String]
    let beforeManifest: Manifest
    let beforeIdentities: [String: String]
    let afterRevisions: [String: String]
    let afterSettings: [String: String]
    let afterBlacklist: [String]
}

private func enhancedTransactionURL(_ id: String) throws -> URL {
    guard UUID(uuidString: id) != nil else { throw enhancedError("Invalid transaction ID") }
    let dir = getDocumentsDirectory().appendingPathComponent("UEImportTransactions")
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir.appendingPathComponent(id + ".json")
}

func enhancedPreviewImport(_ backup: [String: Any]) throws -> [String: Any] {
    let scripts = try enhancedValidateImport(backup)
    var entries = [[String: Any]]()
    for script in scripts {
        let filename = script["filename"] as! String
        let parsed = parse(script["content"] as! String)!
        entries.append(["filename": filename, "metadata": parsed["metadata"]!,
                        "overwrite": FileManager.default.fileExists(atPath: try enhancedScriptURL(filename).path),
                        "disabled": script["disabled"]!])
    }
    return ["entries": entries, "revision": try enhancedStateRevision()]
}

func enhancedRollbackImport(_ id: String, force: Bool = false) throws {
    let url = try enhancedTransactionURL(id)
    let record = try JSONDecoder().decode(EnhancedImportTransaction.self, from: Data(contentsOf: url))
    guard let location = getSaveLocation(), location.standardizedFileURL.path == record.directory else {
        throw enhancedError("Script directory changed; rollback has been retained for manual recovery")
    }
    let started = location.startAccessingSecurityScopedResource()
    defer { if started { location.stopAccessingSecurityScopedResource() } }
    if !force {
        let current = getManifest()
        guard current.settings == record.afterSettings, current.blacklist == record.afterBlacklist else {
            throw enhancedError("Native settings changed after import; automatic rollback would overwrite newer settings")
        }
        for (filename, revision) in record.afterRevisions {
            let content = try String(contentsOf: enhancedScriptURL(filename), encoding: .utf8)
            guard scriptRevision(content) == revision else { throw enhancedError("A script changed after import; automatic rollback would overwrite it") }
        }
    }
    for (filename, content) in record.beforeFiles {
        try content.write(to: enhancedScriptURL(filename), atomically: true, encoding: .utf8)
    }
    for filename in record.addedFiles {
        let file = try enhancedScriptURL(filename)
        if FileManager.default.fileExists(atPath: file.path) { try FileManager.default.removeItem(at: file) }
    }
    for filename in record.afterRevisions.keys {
        let key = "UE.ScriptId." + filename
        if let value = record.beforeIdentities[filename] { UserDefaults.standard.set(value, forKey: key) }
        else { UserDefaults.standard.removeObject(forKey: key) }
    }
    guard let files = getAllFiles(), updateManifestMatches(files), updateManifestDeclarativeNetRequests(files), purgeManifest(files) else {
        throw enhancedError("Could not rebuild indexes during rollback; transaction retained")
    }
    var restored = getManifest()
    for filename in record.afterRevisions.keys {
        restored.disabled.removeAll { $0 == filename }
        if record.beforeManifest.disabled.contains(filename) { restored.disabled.append(filename) }
    }
    restored.settings = record.beforeManifest.settings
    restored.blacklist = record.beforeManifest.blacklist
    guard updateManifest(with: restored) else { throw enhancedError("Could not restore native settings; transaction retained") }
}

func enhancedImport(_ backup: [String: Any], expectedRevision: String) throws -> String {
    let scripts = try enhancedValidateImport(backup)
    guard try enhancedStateRevision() == expectedRevision, let location = getSaveLocation() else {
        throw enhancedError("Scripts changed since preview; preview the import again")
    }
    let started = location.startAccessingSecurityScopedResource()
    defer { if started { location.stopAccessingSecurityScopedResource() } }
    var originals = [String: String](), added = [String](), identities = [String: String](), after = [String: String]()
    for script in scripts {
        let filename = script["filename"] as! String
        let file = try enhancedScriptURL(filename)
        if FileManager.default.fileExists(atPath: file.path) { originals[filename] = try String(contentsOf: file, encoding: .utf8) }
        else { added.append(filename) }
        identities[filename] = UserDefaults.standard.string(forKey: "UE.ScriptId." + filename)
        after[filename] = scriptRevision(script["content"] as! String)
    }
    let id = UUID().uuidString
    let beforeManifest = getManifest()
    var afterSettings = beforeManifest.settings
    if backup["sourceOnly"] as? Bool != true, let incoming = backup["nativeSettings"] as? [String: String] {
        for (key, value) in incoming where defaultSettings[key] != nil { afterSettings[key] = value }
    }
    let afterBlacklist = backup["sourceOnly"] as? Bool == true ? beforeManifest.blacklist : (backup["blacklist"] as? [String] ?? beforeManifest.blacklist)
    let record = EnhancedImportTransaction(directory: location.standardizedFileURL.path, beforeFiles: originals, addedFiles: added,
        beforeManifest: beforeManifest, beforeIdentities: identities, afterRevisions: after, afterSettings: afterSettings, afterBlacklist: afterBlacklist)
    try JSONEncoder().encode(record).write(to: enhancedTransactionURL(id), options: .atomic)
    do {
        for script in scripts {
            let filename = script["filename"] as! String
            try (script["content"] as! String).write(to: enhancedScriptURL(filename), atomically: true, encoding: .utf8)
            UserDefaults.standard.set(script["scriptId"] as! String, forKey: "UE.ScriptId." + filename)
        }
        guard let files = getAllFiles(), updateManifestMatches(files), updateManifestRequired(files), updateManifestDeclarativeNetRequests(files), purgeManifest(files) else {
            throw enhancedError("Could not prepare dependencies or rebuild the script index")
        }
        var manifest = getManifest()
        for script in scripts {
            let filename = script["filename"] as! String
            manifest.disabled.removeAll { $0 == filename }
            if script["disabled"] as? Bool == true { manifest.disabled.append(filename) }
        }
        if backup["sourceOnly"] as? Bool != true, let settings = backup["nativeSettings"] as? [String: String] {
            for (key, value) in settings where defaultSettings[key] != nil { manifest.settings[key] = value }
        }
        if backup["sourceOnly"] as? Bool != true, let blacklist = backup["blacklist"] as? [String], blacklist.count <= 1000 { manifest.blacklist = blacklist }
        guard updateManifest(with: manifest) else { throw enhancedError("Could not restore native settings") }
        // Remote declarations were shown in the user-approved import preview.
        return id
    } catch {
        do { try enhancedRollbackImport(id, force: true) }
        catch let rollbackError { throw enhancedError("Import failed and automatic rollback failed: \(rollbackError.localizedDescription). Recovery transaction: \(id)") }
        throw error
    }
}

private struct EnhancedUpdateCandidate: Codable {
    let filename: String
    let baseRevision: String
    let content: String
    let revision: String
    let url: String
}

func enhancedPrepareUpdate(_ filename: String) throws -> [String: Any] {
    let file = try enhancedScriptURL(filename)
    guard let location = getSaveLocation() else { throw enhancedError("No script directory") }
    let started = location.startAccessingSecurityScopedResource()
    defer { if started { location.stopAccessingSecurityScopedResource() } }
    let current = try String(contentsOf: file, encoding: .utf8)
    guard let original = parse(current)?["metadata"] as? [String: [String]],
          let source = original["downloadURL"]?.first ?? original["updateURL"]?.first else {
        throw enhancedError("Script has no download/update URL")
    }
    let content = try enhancedRemoteSource(source)
    guard let proposed = parse(content)?["metadata"] as? [String: [String]],
          let version = proposed["version"]?.first,
          isVersionNewer(original["version"]?.first ?? "0", version) else {
        throw enhancedError("Downloaded source is invalid or has no newer version")
    }
    guard original["name"] == proposed["name"], original["namespace"] == proposed["namespace"] else {
        throw enhancedError("Update changed script identity; import it as a separate script")
    }
    let id = UUID().uuidString
    let candidate = EnhancedUpdateCandidate(filename: filename, baseRevision: scriptRevision(current), content: content, revision: scriptRevision(content), url: source)
    let dir = getDocumentsDirectory().appendingPathComponent("UEPendingUpdates")
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    try JSONEncoder().encode(candidate).write(to: dir.appendingPathComponent(id + ".json"), options: .atomic)
    let permissionKeys = ["grant", "connect", "match", "include", "exclude", "exclude-match", "require", "resource", "downloadURL", "updateURL", "inject-into", "sandbox", "run-at", "noframes"]
    var changes = [[String: Any]]()
    for key in permissionKeys where original[key] != proposed[key] {
        changes.append(["key": key, "before": original[key] ?? [], "after": proposed[key] ?? []])
    }
    return ["id": id, "revision": candidate.revision, "filename": filename, "url": source,
            "fromVersion": original["version"]?.first ?? "", "toVersion": version, "changes": changes]
}

func enhancedApplyUpdate(_ id: String, revision: String) throws -> String {
    guard UUID(uuidString: id) != nil else { throw enhancedError("Invalid update ID") }
    let url = getDocumentsDirectory().appendingPathComponent("UEPendingUpdates").appendingPathComponent(id + ".json")
    let candidate = try JSONDecoder().decode(EnhancedUpdateCandidate.self, from: Data(contentsOf: url))
    let file = try enhancedScriptURL(candidate.filename)
    guard let location = getSaveLocation() else { throw enhancedError("No script directory") }
    let started = location.startAccessingSecurityScopedResource()
    defer { if started { location.stopAccessingSecurityScopedResource() } }
    let content = try String(contentsOf: file, encoding: .utf8)
    guard candidate.revision == revision, scriptRevision(candidate.content) == revision,
          scriptRevision(content) == candidate.baseRevision else { throw enhancedError("Installed script or candidate changed; review the update again") }
    var snapshot = try enhancedExport()
    snapshot["scripts"] = [["filename": candidate.filename, "scriptId": stableScriptId(candidate.filename), "content": candidate.content,
                            "disabled": getManifest().disabled.contains(candidate.filename)]]
    let transaction = try enhancedImport(snapshot, expectedRevision: enhancedStateRevision())
    // Each applied update has an independently recoverable previous version.
    // Retain the reviewed candidate alongside the recovery transaction.
    return transaction
}

func enhancedCheckUpdate(_ filename: String) throws -> [String: Any] {
    let file = try enhancedScriptURL(filename)
    guard let location = getSaveLocation() else { throw enhancedError("No script directory") }
    let started = location.startAccessingSecurityScopedResource()
    defer { if started { location.stopAccessingSecurityScopedResource() } }
    let current = try String(contentsOf: file, encoding: .utf8)
    guard let metadata = parse(current)?["metadata"] as? [String: [String]],
          let source = metadata["updateURL"]?.first ?? metadata["downloadURL"]?.first,
          let localVersion = metadata["version"]?.first else { throw enhancedError("Missing version or update URL") }
    let remote = try enhancedRemoteSource(source)
    guard let proposed = parse(remote)?["metadata"] as? [String: [String]],
          let remoteVersion = proposed["version"]?.first else { throw enhancedError("Update metadata has no version") }
    return ["filename": filename, "currentVersion": localVersion, "remoteVersion": remoteVersion,
            "available": isVersionNewer(localVersion, remoteVersion), "url": source]
}
