import CoreAudioKit
import Foundation
import ObjectiveC.runtime
import PhotosUI
import Security
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

private struct PickVideoArgs: Decodable {
  /// "library" (Photos) or "files" (the Files app).
  let source: String
}

/// Where picked videos wait, as plain local files, until Rust copies them
/// into the session and deletes them (plan video-mobile, paso 08 §3).
private func pickedVideosDirectory() -> URL {
  let dir = FileManager.default.temporaryDirectory
    .appendingPathComponent("lt-picked-videos", isDirectory: true)
  try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
  return dir
}

/// Copy a file the system only lends us (the Photos picker deletes it when
/// the callback returns) next to the others, under `name`.
private func keepPickedVideo(_ url: URL, name: String) -> URL? {
  let target = pickedVideosDirectory().appendingPathComponent(name)
  try? FileManager.default.removeItem(at: target)
  do {
    try FileManager.default.copyItem(at: url, to: target)
    return target
  } catch {
    return nil
  }
}

/// The Photos picker, videos only. Needs no photo-library permission: the
/// system hands over just what the user picked.
private final class VideoLibraryDelegate: NSObject, PHPickerViewControllerDelegate {
  let done: (URL?) -> Void

  init(done: @escaping (URL?) -> Void) {
    self.done = done
  }

  func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
    picker.dismiss(animated: true)
    guard let provider = results.first?.itemProvider,
      provider.hasItemConformingToTypeIdentifier(UTType.movie.identifier)
    else {
      done(nil)
      return
    }
    let suggested = provider.suggestedName
    provider.loadFileRepresentation(forTypeIdentifier: UTType.movie.identifier) { url, _ in
      guard let url = url else {
        self.done(nil)
        return
      }
      let ext = url.pathExtension.isEmpty ? "mov" : url.pathExtension
      let name = suggested.map { "\($0).\(ext)" } ?? url.lastPathComponent
      self.done(keepPickedVideo(url, name: name))
    }
  }
}

/// The Files picker, videos only, as a copy: a plain local file that Rust
/// can read without security-scoped access.
private final class VideoFileDelegate: NSObject, UIDocumentPickerDelegate {
  let done: (URL?) -> Void

  init(done: @escaping (URL?) -> Void) {
    self.done = done
  }

  func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
    guard let url = urls.first else {
      done(nil)
      return
    }
    done(keepPickedVideo(url, name: url.lastPathComponent))
  }

  func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
    done(nil)
  }
}

private struct PickDocumentsArgs: Decodable {
  /// "audio" or "video".
  let kind: String
  /// Use the originals where they are (security-scoped, bookmarked like the
  /// session folders) instead of copies the system makes under tmp.
  let reference: Bool
}

/// The Files picker for documents to import, several at once.
private final class ImportDocumentsDelegate: NSObject, UIDocumentPickerDelegate {
  let done: ([URL]) -> Void

  init(done: @escaping ([URL]) -> Void) {
    self.done = done
  }

  func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
    done(urls)
  }

  func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
    done([])
  }
}

private struct SecureStoreSetArgs: Decodable {
  let name: String
  let value: String
}

private struct SecureStoreNameArgs: Decodable {
  let name: String
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
  private var videoPickerDelegate: NSObject?
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
      ) { [weak webview] _ in
        logIosMemoryWarning()
        webview?.evaluateJavaScript(
          "window.dispatchEvent(new Event('libretracks:ios-memory-warning'))",
          completionHandler: nil
        )
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

  /// Pick one video from Photos ("library") or Files ("files") for the
  /// session (plan video-mobile, paso 08 §3). Resolves `file` with a local
  /// copy under tmp/lt-picked-videos, which Rust moves into the session.
  @objc public func pickVideo(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(PickVideoArgs.self)
    let finish: (URL?) -> Void = { url in
      DispatchQueue.main.async {
        self.videoPickerDelegate = nil
        if let url = url {
          invoke.resolve(["file": url.path])
        } else {
          invoke.resolve(["file": NSNull()])
        }
      }
    }
    DispatchQueue.main.async {
      guard let presenter = self.activeViewController() else {
        invoke.reject("No se pudo abrir el selector de vídeos de iOS")
        return
      }
      if args.source == "library" {
        var configuration = PHPickerConfiguration()
        configuration.filter = .videos
        configuration.selectionLimit = 1
        configuration.preferredAssetRepresentationMode = .current
        let picker = PHPickerViewController(configuration: configuration)
        let delegate = VideoLibraryDelegate(done: finish)
        self.videoPickerDelegate = delegate
        picker.delegate = delegate
        presenter.present(picker, animated: true)
      } else {
        let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.movie], asCopy: true)
        let delegate = VideoFileDelegate(done: finish)
        self.videoPickerDelegate = delegate
        picker.delegate = delegate
        picker.allowsMultipleSelection = false
        presenter.present(picker, animated: true)
      }
    }
  }

  /// Pick audio or video documents to import. Referencing, each one keeps
  /// security-scoped access for good (a bookmark restored at launch, like the
  /// session folders), so the session can read the original where it is, as
  /// on Android and the desktop. Otherwise the system hands over copies under
  /// tmp, which Rust moves into the session. Resolves `files: [{path, name}]`,
  /// empty when cancelled.
  @objc public func pickDocuments(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(PickDocumentsArgs.self)
    DispatchQueue.main.async {
      guard let presenter = self.activeViewController() else {
        invoke.reject("No se pudo abrir el explorador de archivos de iOS")
        return
      }
      // Audio from Files often comes typed as generic data, which `.audio`
      // alone would grey out; Rust validates what is picked.
      let types: [UTType] = args.kind == "video" ? [.movie] : [.audio, .data]
      let picker = UIDocumentPickerViewController(
        forOpeningContentTypes: types,
        asCopy: !args.reference)
      let delegate = ImportDocumentsDelegate { urls in
        self.videoPickerDelegate = nil
        var files: [[String: String]] = []
        for url in urls {
          if args.reference {
            self.retainAccess(to: url)
          }
          files.append(["path": url.path, "name": url.lastPathComponent])
        }
        self.diagnostic("pickDocuments \(args.kind): \(files.count) file(s), reference=\(args.reference)")
        invoke.resolve(["files": files])
      }
      self.videoPickerDelegate = delegate
      picker.delegate = delegate
      picker.allowsMultipleSelection = true
      picker.modalPresentationStyle = .fullScreen
      presenter.present(picker, animated: true)
    }
  }

  /// Present iOS' native export document picker with an already-populated
  /// source file. Unlike a desktop save dialog, iOS chooses the destination
  /// while copying this source into Files/iCloud/another provider.
  // MARK: - Keychain
  //
  // The Google refresh token, which is standing authorisation to reach part of
  // the user's Drive until they revoke it. The desktop builds keep it in the OS
  // credential store through the `keyring` crate, which has no iOS backend, so
  // it goes into the iOS keychain here instead of anywhere in the sandbox.

  private func keychainQuery(_ name: String) -> [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: "LibreTracks",
      kSecAttrAccount as String: name,
    ]
  }

  @objc public func secureStoreSet(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(SecureStoreSetArgs.self)

    // Deleted first: SecItemAdd fails with errSecDuplicateItem rather than
    // replacing, and an update path would be a second code path for no gain.
    SecItemDelete(keychainQuery(args.name) as CFDictionary)

    var query = keychainQuery(args.name)
    query[kSecValueData as String] = Data(args.value.utf8)
    // AfterFirstUnlock, not WhenUnlocked: a set can still be uploading with the
    // screen locked, and the token has to be refreshable while that happens.
    // It stays unreadable until the first unlock after a reboot.
    query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock

    let status = SecItemAdd(query as CFDictionary, nil)
    guard status == errSecSuccess else {
      invoke.reject("No se pudo guardar en el llavero (\(status))")
      return
    }
    invoke.resolve()
  }

  @objc public func secureStoreGet(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(SecureStoreNameArgs.self)

    var query = keychainQuery(args.name)
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne

    var item: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &item)

    // Anything other than a hit reads as "nothing stored", including a keychain
    // entry that survived a restore onto a device that cannot decrypt it. The
    // caller then asks the user to sign in again, which always works; surfacing
    // an error would leave them stuck with no way out from inside the app.
    guard status == errSecSuccess,
          let data = item as? Data,
          let text = String(data: data, encoding: .utf8)
    else {
      invoke.resolve(["value": nil as String?])
      return
    }
    invoke.resolve(["value": text])
  }

  @objc public func secureStoreDelete(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(SecureStoreNameArgs.self)
    let status = SecItemDelete(keychainQuery(args.name) as CFDictionary)
    // Already gone is the desired end state, not a failure: disconnecting must
    // succeed when called twice.
    guard status == errSecSuccess || status == errSecItemNotFound else {
      invoke.reject("No se pudo borrar del llavero (\(status))")
      return
    }
    invoke.resolve()
  }

  @objc public func exportFile(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(ExportFileArgs.self)
    let sourceURL = URL(fileURLWithPath: args.sourcePath)
    diagnostic(
      "exportFile received from Rust; mainThread=\(Thread.isMainThread); " +
      "source=\(sourceURL.lastPathComponent)")

    guard FileManager.default.fileExists(atPath: sourceURL.path) else {
      invoke.reject("El archivo a exportar ya no existe")
      return
    }

    retainSelectedURL = false
    onResult = { event in
      switch event {
      case .selected:
        self.diagnostic("file export completed")
        invoke.resolve(["exported": true])
      case .cancelled:
        self.diagnostic("file export cancelled")
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

  // MARK: - Bluetooth LE MIDI (plan mobile-midi, paso 06)
  //
  // iOS ships the pairing UI: CABTMIDICentralViewController lists BLE MIDI
  // devices and connects the one the user taps. Once connected, CoreMIDI
  // publishes it as one more endpoint, so midir lists it with no further
  // work. Resolves when the user closes the panel (Done or swipe down), so
  // Rust can re-list ports right then.

  private var bluetoothMidiInvoke: Invoke?
  private var bluetoothMidiNavigation: UINavigationController?

  @objc public func presentBluetoothMidi(_ invoke: Invoke) throws {
    DispatchQueue.main.async {
      if self.bluetoothMidiNavigation != nil {
        invoke.resolve()
        return
      }
      let central = CABTMIDICentralViewController()
      central.navigationItem.rightBarButtonItem = UIBarButtonItem(
        barButtonSystemItem: .done,
        target: self,
        action: #selector(self.closeBluetoothMidi))
      let navigation = UINavigationController(rootViewController: central)
      navigation.modalPresentationStyle = .formSheet
      navigation.presentationController?.delegate = self

      guard let presenter = self.activeViewController() else {
        invoke.reject("No se pudo abrir el panel de Bluetooth MIDI")
        return
      }
      self.bluetoothMidiInvoke = invoke
      self.bluetoothMidiNavigation = navigation
      presenter.present(navigation, animated: true)
    }
  }

  @objc private func closeBluetoothMidi() {
    let navigation = bluetoothMidiNavigation
    navigation?.dismiss(animated: true) {
      self.finishBluetoothMidi()
    }
  }

  fileprivate func finishBluetoothMidi() {
    bluetoothMidiInvoke?.resolve()
    bluetoothMidiInvoke = nil
    bluetoothMidiNavigation = nil
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

// Swipe-down dismissal of the Bluetooth MIDI panel: resolve like Done.
extension IosFolderPickerPlugin: UIAdaptivePresentationControllerDelegate {
  func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
    finishBluetoothMidi()
  }
}

@_cdecl("init_plugin_libretracks_ios_folder_picker")
func initPlugin() -> Plugin {
  IosFolderPickerPlugin()
}
