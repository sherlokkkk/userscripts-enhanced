import AppKit
import WebKit

final class PanelRunner: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
    var view: WKWebView!
    var sources: [[String: String]] = []
    var results: [[String: Any]] = []
    var index = 0
    let modes = ["original-modern-no-menus", "legacy-menus", "promise-menus"]
    func start() throws {
        let data = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))
        sources = try JSONSerialization.jsonObject(with: data) as! [[String: String]]
        next()
    }
    func next() {
        if index >= sources.count * modes.count {
            let report: [String: Any] = ["passed": true, "engine": "WKWebView", "scope": "Real WebKit DOM and actual userscript source; GM interfaces and playing-media state modeled, not the original Userscripts application", "results": results]
            let data = try! JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys])
            print(String(decoding: data, as: UTF8.self)); exit(0)
        }
        let configuration = WKWebViewConfiguration()
        configuration.userContentController.add(self, name: "result")
        view = WKWebView(frame: NSRect(x: 0, y: 0, width: 1000, height: 700), configuration: configuration)
        view.navigationDelegate = self
        view.loadHTMLString("<!doctype html><html><head><title>Panel compatibility test</title><style>video{width:640px;height:360px}</style></head><body><video id='video'></video></body></html>", baseURL: URL(string: "https://panel-test.invalid"))
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        let source = sources[index / modes.count]
        let mode = modes[index % modes.count]
        let payload = try! JSONSerialization.data(withJSONObject: ["name": source["name"]!, "source": source["source"]!, "mode": mode])
        let prefix = "const input = " + String(decoding: payload, as: UTF8.self) + ";"
        let code = prefix + #"""
        (async () => {
          const check = (condition, message) => { if (!condition) throw Error(message); };
          const errors = []; window.addEventListener("error", event => errors.push(String(event.error || event.message)));
          const roots = new Map();
          const originalShadow = Element.prototype.attachShadow;
          Element.prototype.attachShadow = function(options) { const root = originalShadow.call(this, options); roots.set(this, root); return root; };
          const menus = new Map(); let sequence = 0;
          const register = (name, callback) => { menus.set(++sequence, {name, callback}); return sequence; };
          const unregister = (id) => menus.delete(id);
          const values = new Map();
          window.GM = { getValue: async (key, fallback) => values.get(key) ?? fallback, setValue: async (key, value) => values.set(key, value) };
          if (input.mode === 'legacy-menus') { window.GM_registerMenuCommand = register; window.GM_unregisterMenuCommand = unregister; }
          if (input.mode === 'promise-menus') { GM.registerMenuCommand = async (...args) => register(...args); GM.unregisterMenuCommand = async (id) => unregister(id); }
          const video = document.querySelector('video');
          for (const [name, value] of Object.entries({paused:false, ended:false, seeking:false, readyState:4})) Object.defineProperty(video, name, {configurable:true, get: () => value});
          (0, eval)(input.source);
          await new Promise(resolve => setTimeout(resolve, 40));
          const noMenu = input.mode === 'original-modern-no-menus';
          const invoke = (name) => { const command = [...menus.values()].find(item => item.name === name); check(command, 'Missing command: ' + name); command.callback(); };
          if (input.name.startsWith('Boss')) {
            if (noMenu) window.dispatchEvent(new KeyboardEvent('keydown', {code:'Backquote', key:'`', bubbles:true}));
            else invoke('显示伪装面板');
            const host = document.querySelector('div[data-bk]'); check(host && host.style.display === 'block', 'Boss panel did not show; ' + JSON.stringify({host:!!host, display:host?.style.display, errors}));
            if (noMenu) window.dispatchEvent(new KeyboardEvent('keydown', {code:'Escape', key:'Escape', bubbles:true}));
            else invoke('隐藏伪装面板');
            // The shortcut debounce intentionally rejects events within 150ms.
            if (noMenu && host.style.display !== 'none') { await new Promise(resolve => setTimeout(resolve, 170)); window.dispatchEvent(new KeyboardEvent('keydown', {code:'Escape', key:'Escape', bubbles:true})); }
            check(host.style.display === 'none', 'Boss panel did not hide');
          } else if (input.name.startsWith('Click')) {
            const host = document.querySelector('[data-clickfx="ui"]');
            check(host, 'Click Fx did not initialize'); const card = roots.get(host).querySelector('.card');
            if (noMenu) window.dispatchEvent(new KeyboardEvent('keydown', {code:'KeyM', altKey:true, shiftKey:true}));
            else invoke('显示点击特效面板');
            check(card.classList.contains('open'), 'Click Fx panel did not show');
            if (noMenu) window.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape'})); else invoke('隐藏点击特效面板');
            check(!card.classList.contains('open'), 'Click Fx panel did not hide');
          } else {
            let host = document.getElementById('speedmaster-host');
            if (noMenu) check(host && host.style.display === 'block', 'Original SpeedMaster fallback did not auto-show');
            else { check(!host, 'Menu-capable SpeedMaster showed without a command'); invoke('显示面板'); host = document.getElementById('speedmaster-host'); }
            check(host && host.style.display === 'block', 'SpeedMaster panel did not show');
            if (noMenu) roots.get(host).querySelector('[data-rate="1.5"]').click(); else invoke('1.5x');
            check(video.playbackRate === 1.5, 'SpeedMaster rate control failed');
            if (!noMenu) { invoke('隐藏面板'); check(host.style.display === 'none', 'SpeedMaster panel did not hide'); }
          }
          window.webkit.messageHandlers.result.postMessage({passed:true, name:input.name, mode:input.mode, commands:menus.size});
        })().catch(error => window.webkit.messageHandlers.result.postMessage({passed:false, name:input.name, mode:input.mode, error:String(error.message || error) + '\n' + String(error.stack || '')}));
        """#
        webView.evaluateJavaScript(code, completionHandler: nil)
    }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        let report = message.body as! [String: Any]
        guard report["passed"] as? Bool == true else { print(report); exit(1) }
        results.append(report)
        view.configuration.userContentController.removeScriptMessageHandler(forName: "result")
        view.stopLoading(); view = nil
        index += 1; next()
    }
}
let application = NSApplication.shared
application.setActivationPolicy(.prohibited)
let runner = PanelRunner()
do { try runner.start() } catch { print(error); exit(1) }
DispatchQueue.main.asyncAfter(deadline: .now() + 30) { print("WebKit test timed out"); exit(1) }
application.run()
