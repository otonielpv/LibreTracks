import Foundation
import QuartzCore

// Video output for iOS, driven from Rust over C (src/platform/ios_video.rs;
// plan video-mobile, paso 03).
//
// STUB of paso 03: it draws nothing. It answers each order with the events the
// real one will send (FileLoaded, PlaybackRestart, a TimePos that moves with
// the clock) so the Rust side runs end to end on a phone. Paso 04 replaces it
// with AVPlayer on the external screen.
//
// Every entry point copies its arguments and returns at once; the work runs on
// the main queue. Event kinds must match `video/native_events.rs::kind`.

@_silgen_name("lt_video_ios_time")
private func ltVideoTime(_ slot: Int32, _ seconds: Double)

@_silgen_name("lt_video_ios_event")
private func ltVideoEvent(_ kind: Int32, _ slot: Int32, _ text: UnsafePointer<CChar>?)

@_silgen_name("lt_video_ios_displays")
private func ltVideoDisplays(_ lines: UnsafePointer<CChar>?)

private enum EventKind: Int32 {
  case fileLoaded = 0
  case playbackRestart = 1
}

private final class StubPlayer {
  var path: String?
  var position = 0.0
  var anchoredAt = CACurrentMediaTime()
  var playing = false
  var speed = 1.0

  func now() -> Double {
    playing ? position + (CACurrentMediaTime() - anchoredAt) * speed : position
  }

  func anchor() {
    position = now()
    anchoredAt = CACurrentMediaTime()
  }
}

private final class StubOutput {
  static let shared = StubOutput()
  let players = [StubPlayer(), StubPlayer()]
  var timer: Timer?

  func emit(_ kind: EventKind, _ slot: Int32) {
    ltVideoEvent(kind.rawValue, slot, nil)
  }

  func startTicking() {
    timer?.invalidate()
    timer = Timer.scheduledTimer(withTimeInterval: 1.0 / 60.0, repeats: true) { [weak self] _ in
      guard let self else { return }
      for (index, player) in self.players.enumerated() where player.playing && player.path != nil {
        ltVideoTime(Int32(index), player.now())
      }
    }
  }
}

private func onMain(_ work: @escaping () -> Void) {
  DispatchQueue.main.async(execute: work)
}

@_cdecl("lt_video_swift_start")
public func ltVideoSwiftStart() {
  onMain { ltVideoDisplays("") }
}

@_cdecl("lt_video_swift_open")
public func ltVideoSwiftOpen(_ display: UnsafePointer<CChar>, _ fit: Int32) -> Bool {
  onMain { StubOutput.shared.startTicking() }
  return true
}

@_cdecl("lt_video_swift_close")
public func ltVideoSwiftClose() {
  onMain {
    StubOutput.shared.timer?.invalidate()
    StubOutput.shared.timer = nil
    StubOutput.shared.players.forEach { $0.path = nil }
  }
}

@_cdecl("lt_video_swift_load")
public func ltVideoSwiftLoad(_ slot: Int32, _ path: UnsafePointer<CChar>, _ start: Double, _ paused: Bool) {
  let file = String(cString: path)
  onMain {
    let player = StubOutput.shared.players[Int(slot)]
    player.path = file
    player.position = start
    player.anchoredAt = CACurrentMediaTime()
    player.playing = !paused
    StubOutput.shared.emit(.fileLoaded, slot)
    StubOutput.shared.emit(.playbackRestart, slot)
  }
}

@_cdecl("lt_video_swift_seek")
public func ltVideoSwiftSeek(_ slot: Int32, _ seconds: Double) {
  onMain {
    let player = StubOutput.shared.players[Int(slot)]
    player.position = seconds
    player.anchoredAt = CACurrentMediaTime()
    StubOutput.shared.emit(.playbackRestart, slot)
  }
}

@_cdecl("lt_video_swift_set_pause")
public func ltVideoSwiftSetPause(_ slot: Int32, _ paused: Bool) {
  onMain {
    let player = StubOutput.shared.players[Int(slot)]
    player.anchor()
    player.playing = !paused
  }
}

@_cdecl("lt_video_swift_set_speed")
public func ltVideoSwiftSetSpeed(_ slot: Int32, _ speed: Double) {
  onMain {
    let player = StubOutput.shared.players[Int(slot)]
    player.anchor()
    player.speed = speed
  }
}

@_cdecl("lt_video_swift_stop")
public func ltVideoSwiftStop(_ slot: Int32) {
  onMain { StubOutput.shared.players[Int(slot)].path = nil }
}

@_cdecl("lt_video_swift_show_slot")
public func ltVideoSwiftShowSlot(_ slot: Int32) {}

@_cdecl("lt_video_swift_set_brightness")
public func ltVideoSwiftSetBrightness(_ value: Double) {}

@_cdecl("lt_video_swift_set_fit")
public func ltVideoSwiftSetFit(_ fit: Int32) {}

@_cdecl("lt_video_swift_show_image")
public func ltVideoSwiftShowImage(_ slot: Int32, _ path: UnsafePointer<CChar>?) {}

@_cdecl("lt_video_swift_set_keep_awake")
public func ltVideoSwiftSetKeepAwake(_ on: Bool) {}
