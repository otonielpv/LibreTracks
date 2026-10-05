import AVFoundation
import Foundation
import UIKit

// Analysis and thumbnails of a video without libmpv (plan video-mobile, paso
// 07), called from Rust (src/platform/ios_video.rs) on a worker thread.
// Blocking on purpose: the caller is the thumbnail worker or an async import,
// never the main thread, and AVAsset's synchronous accessors are fine there.
//
// The answers go back through the C callback Rust passes, during the call:
// the probe as JSON (read by `libretracks_video::media::parse_native_probe`;
// rotation reported, not applied), each thumbnail as JPEG bytes.

public typealias LtVideoProbeCallback = @convention(c) (UnsafeMutableRawPointer?, UnsafePointer<CChar>?) -> Void
public typealias LtVideoFrameCallback = @convention(c) (UnsafeMutableRawPointer?, Int32, UnsafePointer<UInt8>?, Int) -> Void

private func fileURL(_ path: String) -> URL {
  if path.hasPrefix("file://"), let url = URL(string: path) {
    return url
  }
  return URL(fileURLWithPath: path)
}

private func fourCC(_ code: FourCharCode) -> String {
  let bytes = [24, 16, 8, 0].map { UInt8((code >> $0) & 0xff) }
  let text = String(bytes: bytes, encoding: .ascii) ?? ""
  return text.trimmingCharacters(in: .whitespaces)
}

private func probeJSON(_ path: String) -> String {
  var out: [String: Any] = [:]
  let url = fileURL(path)
  let scoped = url.startAccessingSecurityScopedResource()
  defer {
    if scoped { url.stopAccessingSecurityScopedResource() }
  }
  let asset = AVURLAsset(url: url)
  let duration = CMTimeGetSeconds(asset.duration)
  out["durationSeconds"] = duration.isFinite ? duration : 0
  guard let video = asset.tracks(withMediaType: .video).first else {
    out["error"] = asset.isReadable ? "no contiene una pista de vídeo" : "no se pudo leer el fichero"
    return serialize(out)
  }
  let size = video.naturalSize
  out["width"] = Int(abs(size.width))
  out["height"] = Int(abs(size.height))
  // preferredTransform holds the rotation the picture is shown with.
  let transform = video.preferredTransform
  let degrees = Int((atan2(transform.b, transform.a) * 180 / .pi).rounded())
  out["rotationDegrees"] = ((degrees % 360) + 360) % 360
  out["fps"] = Double(video.nominalFrameRate)
  if let description = video.formatDescriptions.first {
    // swiftlint:disable:next force_cast
    let format = description as! CMFormatDescription
    out["codec"] = fourCC(CMFormatDescriptionGetMediaSubType(format))
  }
  out["hasAudio"] = !asset.tracks(withMediaType: .audio).isEmpty
  out["decodable"] = video.isDecodable && asset.isPlayable
  out["hardwareDecode"] = true
  return serialize(out)
}

private func serialize(_ object: [String: Any]) -> String {
  guard let data = try? JSONSerialization.data(withJSONObject: object),
        let text = String(data: data, encoding: .utf8) else {
    return "{\"error\":\"respuesta nativa no serializable\"}"
  }
  return text
}

@_cdecl("lt_video_swift_probe")
public func ltVideoSwiftProbe(
  _ path: UnsafePointer<CChar>,
  _ context: UnsafeMutableRawPointer?,
  _ callback: LtVideoProbeCallback
) {
  let json = probeJSON(String(cString: path))
  json.withCString { callback(context, $0) }
}

@_cdecl("lt_video_swift_frames")
public func ltVideoSwiftFrames(
  _ path: UnsafePointer<CChar>,
  _ times: UnsafePointer<Double>,
  _ count: Int32,
  _ width: Int32,
  _ context: UnsafeMutableRawPointer?,
  _ callback: LtVideoFrameCallback
) {
  let url = fileURL(String(cString: path))
  let scoped = url.startAccessingSecurityScopedResource()
  defer {
    if scoped { url.stopAccessingSecurityScopedResource() }
  }
  let generator = AVAssetImageGenerator(asset: AVURLAsset(url: url))
  generator.appliesPreferredTrackTransform = true
  generator.maximumSize = CGSize(width: CGFloat(width), height: CGFloat(width) * 4)
  // Wide tolerances: a thumbnail does not need the exact frame, and the
  // nearest keyframe decodes without the frames before it (paso 07 §2).
  generator.requestedTimeToleranceBefore = CMTime(seconds: 1, preferredTimescale: 600)
  generator.requestedTimeToleranceAfter = CMTime(seconds: 1, preferredTimescale: 600)
  for index in 0..<Int(count) {
    let time = CMTime(seconds: times[index], preferredTimescale: 600)
    var bytes: Data?
    autoreleasepool {
      if let image = try? generator.copyCGImage(at: time, actualTime: nil) {
        bytes = UIImage(cgImage: image).jpegData(compressionQuality: 0.72)
      }
    }
    if let bytes = bytes {
      bytes.withUnsafeBytes { buffer in
        let pointer = buffer.bindMemory(to: UInt8.self).baseAddress
        callback(context, Int32(index), pointer, buffer.count)
      }
    } else {
      callback(context, Int32(index), nil, 0)
    }
  }
}
