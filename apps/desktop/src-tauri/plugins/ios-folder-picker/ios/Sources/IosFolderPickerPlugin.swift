import Foundation
import Tauri
import UIKit
import UniformTypeIdentifiers

fileprivate enum FolderPickerEvent {
  case selected(URL)
  case cancelled
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

  override init() {
    super.init()
    restoreBookmarks()
  }

  @objc public func pickFolder(_ invoke: Invoke) throws {
    onResult = { event in
      switch event {
      case .selected(let url):
        invoke.resolve(["folder": url.path])
      case .cancelled:
        invoke.resolve(["folder": NSNull()])
      }
    }

    DispatchQueue.main.async {
      let picker = UIDocumentPickerViewController(
        forOpeningContentTypes: [.folder],
        asCopy: false)
      let delegate = FolderPickerDelegate(plugin: self)
      self.pickerDelegate = delegate
      picker.delegate = delegate
      picker.allowsMultipleSelection = false
      picker.modalPresentationStyle = .fullScreen

      guard let presenter = self.activeViewController() else {
        self.pickerDelegate = nil
        self.onResult = nil
        invoke.reject("No se pudo abrir el explorador de archivos de iOS")
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
    let sceneRoot = UIApplication.shared.connectedScenes
      .compactMap { $0 as? UIWindowScene }
      .flatMap { $0.windows }
      .first(where: { $0.isKeyWindow })?
      .rootViewController

    var current = managed?.viewIfLoaded?.window == nil ? sceneRoot : managed
    while let presented = current?.presentedViewController {
      current = presented
    }
    if let navigation = current as? UINavigationController {
      return navigation.visibleViewController ?? navigation
    }
    if let tabs = current as? UITabBarController {
      return tabs.selectedViewController ?? tabs
    }
    return current
  }

  fileprivate func finish(_ event: FolderPickerEvent) {
    if case .selected(let url) = event {
      retainAccess(to: url)
    }
    onResult?(event)
    onResult = nil
    pickerDelegate = nil
  }

  private func retainAccess(to url: URL) {
    _ = url.startAccessingSecurityScopedResource()
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
    }
  }

  private func restoreBookmarks() {
    let bookmarks = UserDefaults.standard.array(forKey: bookmarksKey) as? [Data] ?? []
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
      }
    }

    UserDefaults.standard.set(refreshed, forKey: bookmarksKey)
  }
}

@_cdecl("init_plugin_libretracks_ios_folder_picker")
func initPlugin() -> Plugin {
  IosFolderPickerPlugin()
}
