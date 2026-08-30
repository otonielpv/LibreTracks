import Foundation
import ObjectiveC.runtime
import Tauri
import UIKit
import UniformTypeIdentifiers
import WebKit

// Rust owns the normal application error log. Calling through these tiny C
// hooks avoids a second Swift writer racing its rotation/file lock.
@_silgen_name("libretracks_log_ios_webcontent_terminated")
private func logWebContentTermination()

@_silgen_name("libretracks_log_ios_memory_warning")
private func logIosMemoryWarning()

fileprivate enum FolderPickerEvent {
  case selected(URL)
  case cancelled
}

private struct ExportFileArgs: Decodable {
  let sourcePath: String
}

private final class FolderPickerDelegate: NSObject, UIDocumentPickerDelegate {
  weak var plugin: IosFolderPickerPlugin?

  init(plugin: IosFolderPickerPlugin) {
    self.plugin = plugin
  }

  func documentPicker(
    _ controller: UIDocumentPickerViewController,
    didPickDocumentsAt urls: [URL]
  ) {
    guard let url = urls.first else {
      plugin?.finish(.cancelled)
      return
    }
    plugin?.finish(.selected(url))
  }

  func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
    plugin?.finish(.cancelled)
  }
}

final class IosFolderPickerPlugin: Plugin {
  private let bookmarksKey = "LibreTracksSecurityScopedFolderBookmarks"
  private var activeURLs: [URL] = []
  private var pickerDelegate: FolderPickerDelegate?
  private var onResult: ((FolderPickerEvent) -> Void)?
  private var retainSelectedURL = true
  private var memoryWarningObserver: NSObjectProtocol?
  private var instrumentedNavigationDelegateClasses = Set<ObjectIdentifier>()

  override init() {
    super.init()
    diagnostic("plugin initialized")
    restoreBookmarks()
  }

  override func load(webview: WKWebView) {
    super.load(webview: webview)
    installWebContentTerminationLog(on: webview)
    if memoryWarningObserver == nil {
      memoryWarningObserver = NotificationCenter.default.addObserver(
        forName: UIApplication.didReceiveMemoryWarningNotification,
        object: nil,
        queue: .main
      ) { _ in
        logIosMemoryWarning()
      }
    }
  }

  /// Wry already implements WKNavigationDelegate and receives
  /// webViewWebContentProcessDidTerminate, but Tauri does not expose that hook
  /// to an app. Wrap Wry's implementation in place: log first, then call the
  /// original IMP so framework behaviour remains byte-for-byte intact.
  private func installWebContentTerminationLog(on webview: WKWebView) {
    guard let delegate = webview.navigationDelegate else {
      diagnostic("cannot instrument WebContent termination: no navigation delegate")
      return
    }
    let delegateClass: AnyClass = type(of: delegate)
    let classId = ObjectIdentifier(delegateClass)
    if instrumentedNavigationDelegateClasses.contains(classId) {
      return
    }
    let selector = NSSelectorFromString("webViewWebContentProcessDidTerminate:")
    guard let method = class_getInstanceMethod(delegateClass, selector) else {
      diagnostic("cannot instrument WebContent termination: delegate has no callback")
      return
    }

    let originalImplementation = method_getImplementation(method)
    typealias OriginalCallback = @convention(c) (AnyObject, Selector, WKWebView) -> Void
    let original = unsafeBitCast(originalImplementation, to: OriginalCallback.self)
    let replacement: @convention(block) (AnyObject, WKWebView) -> Void = {
      receiver, terminatedWebview in
      logWebContentTermination()
      original(receiver, selector, terminatedWebview)
    }
    method_setImplementation(method, imp_implementationWithBlock(replacement))
    instrumentedNavigationDelegateClasses.insert(classId)
    diagnostic("installed native WebContent termination logger")
  }

  @objc public func pickFolder(_ invoke: Invoke) throws {
    diagnostic("pickFolder received from Rust; mainThread=\(Thread.isMainThread)")
    retainSelectedURL = true
    onResult = { event in
      switch event {
      case .selected(let url):
        self.diagnostic("resolving selected folder")
        invoke.resolve(["folder": url.path])
      case .cancelled:
        self.diagnostic("resolving cancellation")
        invoke.resolve(["folder": NSNull()])
      }
    }

    DispatchQueue.main.async {
      self.diagnostic("entered main queue; constructing UIDocumentPickerViewController")
      let picker = UIDocumentPickerViewController(
        forOpeningContentTypes: [.folder],
        asCopy: false)
      let delegate = FolderPickerDelegate(plugin: self)
      self.pickerDelegate = delegate
      picker.delegate = delegate
      picker.allowsMultipleSelection = false
      picker.modalPresentationStyle = .fullScreen

      guard let presenter = self.activeViewController() else {
        self.diagnostic("FAILED: no active view controller")
        self.pickerDelegate = nil
        self.onResult = nil
        invoke.reject("No se pudo abrir el explorador de archivos de iOS")
        return
      }

      self.diagnostic(
        "presenting picker from \(type(of: presenter)); " +
        "viewLoaded=\(presenter.isViewLoaded); windowAttached=\(presenter.viewIfLoaded?.window != nil); " +
        "alreadyPresented=\(presenter.presentedViewController != nil)")
      presenter.present(picker, animated: true) {
        self.diagnostic(
          "presentation completion; pickerWindowAttached=\(picker.viewIfLoaded?.window != nil); " +
          "presenterNowShowsPicker=\(presenter.presentedViewController === picker)")
      }
    }
  }

  /// Pick one document for reading while retaining its security-scoped URL.
  /// Used for portable LibreTracks packages; the Rust side validates the
  /// extension/archive after selection because document providers frequently
  /// expose custom files as generic public.data.
  @objc public func pickFile(_ invoke: Invoke) throws {
    diagnostic("pickFile received from Rust; mainThread=\(Thread.isMainThread)")
    retainSelectedURL = true
    onResult = { event in
      switch event {
      case .selected(let url):
        self.diagnostic("resolving selected file \(url.lastPathComponent)")
        invoke.resolve(["file": url.path])
      case .cancelled:
        self.diagnostic("resolving file cancellation")
        invoke.resolve(["file": NSNull()])
      }
    }

    DispatchQueue.main.async {
      let picker = UIDocumentPickerViewController(
        forOpeningContentTypes: [.data],
        asCopy: false)
      let delegate = FolderPickerDelegate(plugin: self)
      self.pickerDelegate = delegate
      picker.delegate = delegate
      picker.allowsMultipleSelection = false
      picker.modalPresentationStyle = .fullScreen

      guard let presenter = self.activeViewController() else {
        self.diagnostic("FAILED file pick: no active view controller")
        self.pickerDelegate = nil
        self.onResult = nil
        invoke.reject("No se pudo abrir el explorador de archivos de iOS")
        return
      }
      presenter.present(picker, animated: true)
    }
  }

  /// Present iOS' native export document picker with an already-populated
  /// source file. Unlike a desktop save dialog, iOS chooses the destination
  /// while copying this source into Files/iCloud/another provider.
  @objc public func exportFile(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(ExportFileArgs.self)
    let sourceURL = URL(fileURLWithPath: args.sourcePath)
    diagnostic(
      "exportFile received from Rust; mainThread=\(Thread.isMainThread); " +
      "source=\(sourceURL.lastPathComponent)")

    guard FileManager.default.fileExists(atPath: sourceURL.path) else {
      invoke.reject("El registro de diagnostico ya no existe")
      return
    }

    retainSelectedURL = false
    onResult = { event in
      switch event {
      case .selected:
        self.diagnostic("diagnostics export completed")
        invoke.resolve(["exported": true])
      case .cancelled:
        self.diagnostic("diagnostics export cancelled")
        invoke.resolve(["exported": false])
      }
    }

    DispatchQueue.main.async {
      self.diagnostic("entered main queue; constructing export document picker")
      let picker = UIDocumentPickerViewController(url: sourceURL, in: .exportToService)
      let delegate = FolderPickerDelegate(plugin: self)
      self.pickerDelegate = delegate
      picker.delegate = delegate
      picker.modalPresentationStyle = .fullScreen

      guard let presenter = self.activeViewController() else {
        self.diagnostic("FAILED export: no active view controller")
        self.pickerDelegate = nil
        self.onResult = nil
        self.retainSelectedURL = true
        invoke.reject("No se pudo abrir el destino de exportacion de iOS")
        return
      }
      presenter.present(picker, animated: true)
    }
  }

  /// Tauri normally exposes the webview controller through the plugin manager,
  /// but it can still be detached while iOS is completing an orientation or
  /// keyboard transition. Resolve the active scene as a fallback instead of
  /// silently leaving the Rust/JavaScript invocation pending forever.
  private func activeViewController() -> UIViewController? {
    let managed = manager.viewController
    let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
    let windows = scenes.flatMap { $0.windows }
    let keyWindow = windows.first(where: { $0.isKeyWindow })
    let sceneRoot = keyWindow?.rootViewController

    diagnostic(
      "resolving presenter; scenes=\(scenes.count); windows=\(windows.count); " +
      "keyWindow=\(keyWindow != nil); sceneRoot=\(describe(sceneRoot)); " +
      "managed=\(describe(managed)); managedAttached=\(managed?.viewIfLoaded?.window != nil)")

    // The controller exposed by Tauri's plugin manager can be a child whose
    // view is attached but cannot present a full-screen controller on a real
    // device. Always start at the key window's root hierarchy when available.
    return topViewController(from: sceneRoot ?? managed)
  }

  private func topViewController(from controller: UIViewController?) -> UIViewController? {
    if let presented = controller?.presentedViewController {
      return topViewController(from: presented)
    }
    if let navigation = controller as? UINavigationController {
      return topViewController(from: navigation.visibleViewController ?? navigation)
    }
    if let tabs = controller as? UITabBarController {
      return topViewController(from: tabs.selectedViewController ?? tabs)
    }
    return controller
  }

  fileprivate func finish(_ event: FolderPickerEvent) {
    switch event {
    case .selected(let url) where retainSelectedURL:
      diagnostic("delegate selected one document; starting security-scoped access")
      retainAccess(to: url)
    case .selected:
      diagnostic("delegate completed file export")
    case .cancelled:
      diagnostic("delegate reported picker cancellation")
    }
    onResult?(event)
    onResult = nil
    pickerDelegate = nil
    retainSelectedURL = true
  }

  private func retainAccess(to url: URL) {
    let accessStarted = url.startAccessingSecurityScopedResource()
    diagnostic("security-scoped access started=\(accessStarted)")
    activeURLs.append(url)

    do {
      let bookmark = try url.bookmarkData(
        options: .minimalBookmark,
        includingResourceValuesForKeys: nil,
        relativeTo: nil)
      var bookmarks = UserDefaults.standard.array(forKey: bookmarksKey) as? [Data] ?? []
      if !bookmarks.contains(bookmark) {
        bookmarks.append(bookmark)
        UserDefaults.standard.set(bookmarks, forKey: bookmarksKey)
      }
    } catch {
      // Access remains valid for this process. The user can select the folder
      // again after relaunch if its provider refuses bookmark creation.
      NSLog("[LibreTracks] Could not persist folder bookmark: %@", error.localizedDescription)
      diagnostic("bookmark persistence failed: \(error.localizedDescription)")
    }
  }

  private func restoreBookmarks() {
    let bookmarks = UserDefaults.standard.array(forKey: bookmarksKey) as? [Data] ?? []
    diagnostic("restoring \(bookmarks.count) persisted folder bookmark(s)")
    var refreshed: [Data] = []

    for bookmark in bookmarks {
      do {
        var stale = false
        let url = try URL(
          resolvingBookmarkData: bookmark,
          options: [],
          relativeTo: nil,
          bookmarkDataIsStale: &stale)
        _ = url.startAccessingSecurityScopedResource()
        activeURLs.append(url)
        if stale {
          refreshed.append(try url.bookmarkData(
            options: .minimalBookmark,
            includingResourceValuesForKeys: nil,
            relativeTo: nil))
        } else {
          refreshed.append(bookmark)
        }
      } catch {
        NSLog("[LibreTracks] Could not restore folder bookmark: %@", error.localizedDescription)
        diagnostic("bookmark restoration failed: \(error.localizedDescription)")
      }
    }

    UserDefaults.standard.set(refreshed, forKey: bookmarksKey)
  }

  private func describe(_ controller: UIViewController?) -> String {
    guard let controller = controller else { return "nil" }
    return String(describing: type(of: controller))
  }

  /// Mirror native-only steps into the same user-accessible file written by
  /// Rust. This remains useful even if the mobile-plugin invocation never
  /// returns to Rust/JavaScript.
  private func diagnostic(_ message: String) {
    let timestamp = ISO8601DateFormatter().string(from: Date())
    let line = "[\(timestamp)] [swift] \(message)\n"
    guard let data = line.data(using: .utf8),
          let documents = FileManager.default.urls(
            for: .documentDirectory,
            in: .userDomainMask).first else {
      NSLog("[LibreTracks picker] %@", message)
      return
    }
    let url = documents.appendingPathComponent("LibreTracks-picker.log")
    if !FileManager.default.fileExists(atPath: url.path) {
      FileManager.default.createFile(atPath: url.path, contents: nil)
    }
    do {
      let handle = try FileHandle(forWritingTo: url)
      handle.seekToEndOfFile()
      handle.write(data)
      handle.closeFile()
    } catch {
      NSLog("[LibreTracks picker] log write failed: %@", error.localizedDescription)
    }
    NSLog("[LibreTracks picker] %@", message)
  }
}

@_cdecl("init_plugin_libretracks_ios_folder_picker")
func initPlugin() -> Plugin {
  IosFolderPickerPlugin()
}
