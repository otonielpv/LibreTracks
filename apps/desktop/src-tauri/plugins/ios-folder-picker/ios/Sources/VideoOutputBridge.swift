import AVFoundation
import Foundation
import QuartzCore
import UIKit

// Video output for iOS (plan video-mobile, pasos 04 and 06), driven from Rust
// over C: src/platform/ios_video.rs declares the `lt_video_swift_*` functions
// below and receives the events through the `lt_video_ios_*` ones.
//
// What it draws: a window on the external screen (cable or AirPlay "Screen
// Mirroring", which iOS presents as an external screen) with, bottom to top,
// player A, player B, one still-image layer per slot (idle picture, test
// pattern) and a black layer whose opacity is the brightness. Black is the
// background, always: nothing of the phone's UI ever reaches the projector.
//
// Why `UIScreen` + a `UIWindow` and not the scene API (iOS 16+): the app is
// tao's, which starts without `UIApplicationSceneManifest`. Adopting scenes
// for one external window would risk the main window, the notch handling and
// the Drive deep link (paso 01 §2). The old API still works in apps without
// scenes; if a future iOS stops drawing it, the switch is to a scene with
// `UIWindowSceneSessionRoleExternalDisplayNonInteractive`.
//
// Threading: every entry point copies its arguments and `async`s onto the
// main queue, which is where UIKit and AVPlayer want to be touched. None of
// them waits (README regla 3). Event kinds must match
// `video/native_events.rs::kind` in the Rust app.

@_silgen_name("lt_video_ios_time")
private func ltVideoTime(_ slot: Int32, _ seconds: Double)

@_silgen_name("lt_video_ios_event")
private func ltVideoEvent(_ kind: Int32, _ slot: Int32, _ text: UnsafePointer<CChar>?)

@_silgen_name("lt_video_ios_displays")
private func ltVideoDisplays(_ lines: UnsafePointer<CChar>?)

private enum EventKind: Int32 {
  case fileLoaded = 0
  case playbackRestart = 1
  case loadFailed = 2
  case frameDrops = 3
  case closed = 4
  case secondPlayer = 5
  case suspended = 6
  case resumed = 7
  case surfaceFailed = 8
}

private func emit(_ kind: EventKind, slot: Int = 0, text: String? = nil) {
  if let text = text {
    text.withCString { ltVideoEvent(kind.rawValue, Int32(slot), $0) }
  } else {
    ltVideoEvent(kind.rawValue, Int32(slot), nil)
  }
}

private func onMain(_ work: @escaping () -> Void) {
  DispatchQueue.main.async(execute: work)
}

/// One of the two players and what its slot shows.
private final class VideoSlot {
  let index: Int
  let player = AVPlayer()
  let layer: AVPlayerLayer
  let imageLayer = CALayer()
  var item: AVPlayerItem?
  var statusObserver: NSKeyValueObservation?
  var failObserver: NSObjectProtocol?
  var scopedURL: URL?
  var paused = true
  var speed = 1.0
  var loadGeneration = 0
  var firstFramePending = false

  init(index: Int) {
    self.index = index
    // The audio of a video plays through the engine (paso 11 of
    // video-output). AVPlayer stays muted so it never touches the
    // AVAudioSession RemoteIO runs on (paso 04 §4).
    player.isMuted = true
    player.automaticallyWaitsToMinimizeStalling = false
    player.actionAtItemEnd = .pause
    player.preventsDisplaySleepDuringVideoPlayback = false
    if #available(iOS 15.0, *) {
      player.audiovisualBackgroundPlaybackPolicy = .pauses
    }
    layer = AVPlayerLayer(player: player)
    layer.backgroundColor = UIColor.black.cgColor
    layer.videoGravity = .resizeAspect
    imageLayer.contentsGravity = .resizeAspect
    imageLayer.isHidden = true
    imageLayer.backgroundColor = UIColor.black.cgColor
  }

  func release() {
    statusObserver?.invalidate()
    statusObserver = nil
    if let failObserver = failObserver {
      NotificationCenter.default.removeObserver(failObserver)
    }
    failObserver = nil
    player.replaceCurrentItem(with: nil)
    item = nil
    scopedURL?.stopAccessingSecurityScopedResource()
    scopedURL = nil
    paused = true
  }

  func applyRate() {
    player.rate = paused ? 0 : Float(speed)
  }
}

private final class DisplayTicker: NSObject {
  weak var owner: VideoOutputController?

  @objc func tick(_ link: CADisplayLink) {
    owner?.tick()
  }
}

/// The output: window, layers, players. Main thread only.
final class VideoOutputController {
  static let shared = VideoOutputController()

  private var window: UIWindow?
  private var screen: UIScreen?
  private let slots = [VideoSlot(index: 0), VideoSlot(index: 1)]
  private let blackLayer = CALayer()
  private var visibleSlot = 0
  private var gravity: AVLayerVideoGravity = .resizeAspect
  private var displayLink: CADisplayLink?
  private let ticker = DisplayTicker()
  private var started = false
  private var suspended = false
  private var keepAwake = false
  private var idleTimerBefore = false

  private init() {
    blackLayer.backgroundColor = UIColor.black.cgColor
    blackLayer.opacity = 0
    ticker.owner = self
  }

  // MARK: Displays

  /// External screens, by the name Rust pins them with. The phone's own
  /// screen is never listed (paso 06 §1).
  private func externalScreens() -> [(String, UIScreen)] {
    let screens = UIScreen.screens.filter { $0 !== UIScreen.main }
    let airPlay = AVAudioSession.sharedInstance().currentRoute.outputs
      .first { $0.portType == .airPlay }?.portName
    var seen = [String: Int]()
    return screens.map { screen in
      var name = airPlay.map { "AirPlay: \($0)" } ?? "Pantalla externa"
      let count = (seen[name] ?? 0) + 1
      seen[name] = count
      if count > 1 {
        name += " \(count)"
      }
      return (name, screen)
    }
  }

  private func reportDisplays() {
    let lines = externalScreens().map { name, screen -> String in
      let mode = screen.currentMode?.size ?? screen.nativeBounds.size
      let clean = name.replacingOccurrences(of: "\t", with: " ")
        .replacingOccurrences(of: "\n", with: " ")
      return "\(clean)\t\(Int(mode.width))\t\(Int(mode.height))"
    }.joined(separator: "\n")
    lines.withCString { ltVideoDisplays($0) }
  }

  func start() {
    guard !started else {
      reportDisplays()
      return
    }
    started = true
    let center = NotificationCenter.default
    center.addObserver(
      forName: UIScreen.didConnectNotification, object: nil, queue: .main
    ) { [weak self] _ in self?.reportDisplays() }
    center.addObserver(
      forName: UIScreen.didDisconnectNotification, object: nil, queue: .main
    ) { [weak self] notification in
      guard let self = self else { return }
      if let gone = notification.object as? UIScreen, gone === self.screen {
        // The cable is out: drop the window now; Rust reads "display lost"
        // from the list below and reopens when it is back (paso 06 §3).
        self.tearDownWindow()
      }
      self.reportDisplays()
    }
    center.addObserver(
      forName: UIScreen.modeDidChangeNotification, object: nil, queue: .main
    ) { [weak self] _ in
      guard let self = self else { return }
      self.layoutLayers()
      self.reportDisplays()
    }
    center.addObserver(
      forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main
    ) { [weak self] _ in self?.reportDisplays() }
    // Paso 06 §4: the system stops composing an app's external window while
    // the phone is locked or the app is in the background. Say so; Rust
    // resyncs when it comes back.
    center.addObserver(
      forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main
    ) { [weak self] _ in self?.setSuspended(true) }
    center.addObserver(
      forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main
    ) { [weak self] _ in self?.setSuspended(false) }
    reportDisplays()
  }

  private func setSuspended(_ value: Bool) {
    guard suspended != value else { return }
    suspended = value
    guard window != nil else { return }
    emit(value ? .suspended : .resumed)
  }

  // MARK: Surface

  func open(display: String) {
    guard let target = externalScreens().first(where: { $0.0 == display })?.1 else {
      emit(.surfaceFailed, text: "la pantalla \(display) ya no está conectada")
      return
    }
    if window != nil, screen === target {
      return
    }
    tearDownWindow()
    target.overscanCompensation = UIScreen.OverscanCompensation.none
    let newWindow = UIWindow(frame: target.bounds)
    newWindow.screen = target
    newWindow.backgroundColor = .black
    let root = UIViewController()
    root.view.backgroundColor = .black
    newWindow.rootViewController = root
    let host = root.view.layer
    for slot in slots {
      host.addSublayer(slot.layer)
    }
    for slot in slots {
      host.addSublayer(slot.imageLayer)
    }
    host.addSublayer(blackLayer)
    newWindow.isHidden = false
    window = newWindow
    screen = target
    layoutLayers()
    showSlot(visibleSlot)
    setGravity(gravity)
    if suspended {
      emit(.suspended)
    }
  }

  private func tearDownWindow() {
    stopTicking()
    for slot in slots {
      slot.release()
      slot.layer.removeFromSuperlayer()
      slot.imageLayer.removeFromSuperlayer()
      slot.imageLayer.contents = nil
      slot.imageLayer.isHidden = true
    }
    blackLayer.removeFromSuperlayer()
    window?.isHidden = true
    window?.rootViewController = nil
    window = nil
    screen = nil
  }

  func close() {
    tearDownWindow()
  }

  private func layoutLayers() {
    guard let bounds = window?.rootViewController?.view.bounds else { return }
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    for slot in slots {
      slot.layer.frame = bounds
      slot.imageLayer.frame = bounds
    }
    blackLayer.frame = bounds
    CATransaction.commit()
  }

  func showSlot(_ index: Int) {
    visibleSlot = index
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    for slot in slots {
      let visible = slot.index == index
      slot.layer.isHidden = !visible
      slot.imageLayer.isHidden = !visible || slot.imageLayer.contents == nil
    }
    CATransaction.commit()
  }

  /// −100 → black, 0 → picture. On the next frame, never animated.
  func setBrightness(_ value: Double) {
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    blackLayer.opacity = Float(min(max(-value / 100.0, 0), 1))
    CATransaction.commit()
  }

  func setGravity(_ value: AVLayerVideoGravity) {
    gravity = value
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    for slot in slots {
      slot.layer.videoGravity = value
      slot.imageLayer.contentsGravity =
        value == .resizeAspectFill ? .resizeAspectFill : (value == .resize ? .resize : .resizeAspect)
    }
    CATransaction.commit()
  }

  /// A still image on `index` instead of its video, or black with nil.
  func showImage(_ index: Int, path: String?) {
    let slot = slots[index]
    slot.release()
    slot.loadGeneration += 1
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    slot.imageLayer.contents = path.flatMap { UIImage(contentsOfFile: $0)?.cgImage }
    slot.imageLayer.isHidden = index != visibleSlot || slot.imageLayer.contents == nil
    CATransaction.commit()
    updateTicking()
  }

  // MARK: Players

  func load(_ index: Int, path: String, start: Double, paused: Bool) {
    let slot = slots[index]
    slot.release()
    slot.loadGeneration += 1
    let generation = slot.loadGeneration
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    slot.imageLayer.contents = nil
    slot.imageLayer.isHidden = true
    CATransaction.commit()

    let url = path.hasPrefix("file://") ? (URL(string: path) ?? URL(fileURLWithPath: path))
      : URL(fileURLWithPath: path)
    // A file under a folder picked with the security-scoped picker: the
    // plugin keeps the folder's access open, and asking again for the file
    // is harmless when it is not scoped (paso 04 §3).
    if url.startAccessingSecurityScopedResource() {
      slot.scopedURL = url
    }
    let asset = AVURLAsset(url: url)
    let item = AVPlayerItem(asset: asset)
    item.preferredForwardBufferDuration = 1
    slot.item = item
    slot.paused = paused
    slot.firstFramePending = true
    slot.statusObserver = item.observe(\.status, options: [.new]) { [weak self] observed, _ in
      onMain {
        guard let self = self, slot.loadGeneration == generation else { return }
        switch observed.status {
        case .readyToPlay:
          emit(.fileLoaded, slot: index)
          self.seek(index, to: start, generation: generation)
        case .failed:
          let reason = observed.error?.localizedDescription ?? "el vídeo no se pudo abrir"
          slot.release()
          emit(.loadFailed, slot: index, text: reason)
        default:
          break
        }
      }
    }
    slot.failObserver = NotificationCenter.default.addObserver(
      forName: .AVPlayerItemFailedToPlayToEndTime, object: item, queue: .main
    ) { notification in
      let error = notification.userInfo?[AVPlayerItemFailedToPlayToEndTimeErrorKey] as? Error
      emit(.loadFailed, slot: index, text: error?.localizedDescription ?? "error de reproducción")
    }
    slot.player.replaceCurrentItem(with: item)
  }

  private func seek(_ index: Int, to seconds: Double, generation: Int) {
    let slot = slots[index]
    guard let item = slot.item else { return }
    // The runtime only wants the last seek.
    item.cancelPendingSeeks()
    let target = CMTime(seconds: max(seconds, 0), preferredTimescale: 600)
    slot.player.seek(to: target, toleranceBefore: .zero, toleranceAfter: .zero) { finished in
      onMain {
        guard finished, slot.loadGeneration == generation else { return }
        slot.applyRate()
        emit(.playbackRestart, slot: index)
        self.updateTicking()
      }
    }
  }

  func seek(_ index: Int, seconds: Double) {
    let slot = slots[index]
    guard slot.item?.status == .readyToPlay else { return }
    seek(index, to: seconds, generation: slot.loadGeneration)
  }

  func setPause(_ index: Int, paused: Bool) {
    let slot = slots[index]
    slot.paused = paused
    if slot.item?.status == .readyToPlay {
      slot.applyRate()
    }
    updateTicking()
  }

  func setSpeed(_ index: Int, speed: Double) {
    let slot = slots[index]
    slot.speed = speed
    if !slot.paused, slot.item?.status == .readyToPlay {
      slot.player.rate = Float(speed)
    }
  }

  func stop(_ index: Int) {
    let slot = slots[index]
    slot.release()
    slot.loadGeneration += 1
    updateTicking()
  }

  // MARK: Time reporting

  /// One `CADisplayLink` while any player runs; none while all are paused
  /// (battery, as in project_idle_power_android).
  private func updateTicking() {
    let running = window != nil && slots.contains { !$0.paused && $0.item != nil }
    if running && displayLink == nil {
      let link = CADisplayLink(target: ticker, selector: #selector(DisplayTicker.tick(_:)))
      link.add(to: .main, forMode: .common)
      displayLink = link
    } else if !running {
      stopTicking()
    }
  }

  private func stopTicking() {
    displayLink?.invalidate()
    displayLink = nil
  }

  fileprivate func tick() {
    for slot in slots where !slot.paused && slot.item?.status == .readyToPlay {
      let seconds = CMTimeGetSeconds(slot.player.currentTime())
      if seconds.isFinite {
        ltVideoTime(Int32(slot.index), seconds)
      }
    }
  }

  // MARK: Sleep

  /// Paso 06 §4: no auto-lock while the output shows the session's video;
  /// the value before is restored, never left off by accident.
  func setKeepAwake(_ on: Bool) {
    guard on != keepAwake else { return }
    keepAwake = on
    if on {
      idleTimerBefore = UIApplication.shared.isIdleTimerDisabled
      UIApplication.shared.isIdleTimerDisabled = true
    } else {
      UIApplication.shared.isIdleTimerDisabled = idleTimerBefore
    }
  }
}

private func gravity(for fit: Int32) -> AVLayerVideoGravity {
  switch fit {
  case 1: return .resizeAspectFill
  case 2: return .resize
  default: return .resizeAspect
  }
}

// MARK: C entry points (declared in src/platform/ios_video.rs)

@_cdecl("lt_video_swift_start")
public func ltVideoSwiftStart() {
  onMain { VideoOutputController.shared.start() }
}

@_cdecl("lt_video_swift_open")
public func ltVideoSwiftOpen(_ display: UnsafePointer<CChar>, _ fit: Int32) -> Bool {
  let name = String(cString: display)
  let value = gravity(for: fit)
  onMain {
    VideoOutputController.shared.setGravity(value)
    VideoOutputController.shared.open(display: name)
  }
  return true
}

@_cdecl("lt_video_swift_close")
public func ltVideoSwiftClose() {
  onMain { VideoOutputController.shared.close() }
}

@_cdecl("lt_video_swift_load")
public func ltVideoSwiftLoad(
  _ slot: Int32, _ path: UnsafePointer<CChar>, _ start: Double, _ paused: Bool
) {
  let file = String(cString: path)
  onMain {
    VideoOutputController.shared.load(Int(slot), path: file, start: start, paused: paused)
  }
}

@_cdecl("lt_video_swift_seek")
public func ltVideoSwiftSeek(_ slot: Int32, _ seconds: Double) {
  onMain { VideoOutputController.shared.seek(Int(slot), seconds: seconds) }
}

@_cdecl("lt_video_swift_set_pause")
public func ltVideoSwiftSetPause(_ slot: Int32, _ paused: Bool) {
  onMain { VideoOutputController.shared.setPause(Int(slot), paused: paused) }
}

@_cdecl("lt_video_swift_set_speed")
public func ltVideoSwiftSetSpeed(_ slot: Int32, _ speed: Double) {
  onMain { VideoOutputController.shared.setSpeed(Int(slot), speed: speed) }
}

@_cdecl("lt_video_swift_stop")
public func ltVideoSwiftStop(_ slot: Int32) {
  onMain { VideoOutputController.shared.stop(Int(slot)) }
}

@_cdecl("lt_video_swift_show_slot")
public func ltVideoSwiftShowSlot(_ slot: Int32) {
  onMain { VideoOutputController.shared.showSlot(Int(slot)) }
}

@_cdecl("lt_video_swift_set_brightness")
public func ltVideoSwiftSetBrightness(_ value: Double) {
  onMain { VideoOutputController.shared.setBrightness(value) }
}

@_cdecl("lt_video_swift_set_fit")
public func ltVideoSwiftSetFit(_ fit: Int32) {
  let value = gravity(for: fit)
  onMain { VideoOutputController.shared.setGravity(value) }
}

@_cdecl("lt_video_swift_show_image")
public func ltVideoSwiftShowImage(_ slot: Int32, _ path: UnsafePointer<CChar>?) {
  let file = path.map { String(cString: $0) }
  onMain { VideoOutputController.shared.showImage(Int(slot), path: file) }
}

@_cdecl("lt_video_swift_set_keep_awake")
public func ltVideoSwiftSetKeepAwake(_ on: Bool) {
  onMain { VideoOutputController.shared.setKeepAwake(on) }
}
