import AppKit
import WebKit

final class IsolationRunner: NSObject, WKScriptMessageHandler {
    var view: WKWebView!
    func start() throws {
        let source = try String(contentsOfFile: CommandLine.arguments[1], encoding: .utf8)
        let configuration = WKWebViewConfiguration()
        let world = WKContentWorld.world(name: "UserscriptsEnhancedAudit")
        configuration.userContentController.add(self, contentWorld: world, name: "result")
        configuration.userContentController.addUserScript(WKUserScript(source: source, injectionTime: .atDocumentStart, forMainFrameOnly: true, in: world))
        view = WKWebView(frame: NSRect(x: 0, y: 0, width: 800, height: 600), configuration: configuration)
        view.loadHTMLString("<!doctype html><html><head></head><body></body></html>", baseURL: URL(string: "https://isolation-test.invalid"))
    }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let report = message.body as? [String: Any], let passed = report["passed"] as? Bool else { print("Invalid audit report"); exit(1) }
        let data = try! JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys])
        print(String(decoding: data, as: UTF8.self))
        exit(passed ? 0 : 1)
    }
}
let application = NSApplication.shared
application.setActivationPolicy(.prohibited)
let runner = IsolationRunner()
do { try runner.start() } catch { print(error); exit(1) }
DispatchQueue.main.asyncAfter(deadline: .now() + 20) { print("WebKit isolation audit timed out"); exit(1) }
application.run()
