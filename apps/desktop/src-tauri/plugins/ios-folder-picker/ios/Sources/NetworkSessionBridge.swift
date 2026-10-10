import Foundation
import UIKit

// Network sessions on iOS (docs/plans/network-sessions, pasos 03 y 04).
//
// - Keep-awake registry: the screen must not auto-lock while this device
//   hosts or follows a host. Several features want that (video output too),
//   so they register a reason and the screen stays on while any is set; the
//   value from before the first reason comes back after the last one goes.
// - Bonjour through the system (NetService / NetServiceBrowser). Raw
//   multicast sockets, which the mdns-sd crate uses elsewhere, need the
//   `com.apple.developer.networking.multicast` entitlement that Apple grants
//   by hand; the system's Bonjour only needs NSBonjourServices in Info.plist.
//
// Every entry point copies its arguments and hops to the main queue: the
// NetService objects live on the main run loop, and Rust never waits.

@_silgen_name("lt_link_ios_discovery")
private func ltLinkDiscovery(_ kind: Int32, _ key: UnsafePointer<CChar>?, _ json: UnsafePointer<CChar>?)

final class KeepAwakeRegistry {
  static let shared = KeepAwakeRegistry()
  private var reasons = Set<String>()
  private var before = false

  /// Main thread only.
  func set(_ reason: String, _ on: Bool) {
    let wasEmpty = reasons.isEmpty
    if on {
      reasons.insert(reason)
    } else {
      reasons.remove(reason)
    }
    if wasEmpty && !reasons.isEmpty {
      before = UIApplication.shared.isIdleTimerDisabled
      UIApplication.shared.isIdleTimerDisabled = true
    } else if !wasEmpty && reasons.isEmpty {
      UIApplication.shared.isIdleTimerDisabled = before
    }
  }
}

@_cdecl("lt_keep_awake_set")
public func ltKeepAwakeSet(_ reason: UnsafePointer<CChar>?, _ on: Bool) {
  guard let reason = reason else { return }
  let name = String(cString: reason)
  DispatchQueue.main.async { KeepAwakeRegistry.shared.set(name, on) }
}

final class LinkBonjour: NSObject, NetServiceDelegate, NetServiceBrowserDelegate {
  static let shared = LinkBonjour()

  private var published: NetService?
  private var browser: NetServiceBrowser?
  /// Services found and being (or already) resolved, by instance name.
  private var found: [String: NetService] = [:]

  func advertise(name: String, type: String, port: Int32, txt: [String: String]) {
    stopAdvertising()
    let service = NetService(domain: "local.", type: type + ".", name: name, port: port)
    let record = txt.mapValues { Data($0.utf8) }
    service.setTXTRecord(NetService.data(fromTXTRecord: record))
    service.publish()
    published = service
  }

  func stopAdvertising() {
    published?.stop()
    published = nil
  }

  func browse(type: String) {
    stopBrowsing()
    let browser = NetServiceBrowser()
    browser.delegate = self
    browser.searchForServices(ofType: type + ".", inDomain: "local.")
    self.browser = browser
  }

  func stopBrowsing() {
    browser?.stop()
    browser = nil
    for service in found.values {
      service.stop()
    }
    found.removeAll()
  }

  func netServiceBrowser(_ browser: NetServiceBrowser, didFind service: NetService, moreComing: Bool) {
    found[service.name] = service
    service.delegate = self
    service.resolve(withTimeout: 5)
  }

  func netServiceBrowser(_ browser: NetServiceBrowser, didRemove service: NetService, moreComing: Bool) {
    found.removeValue(forKey: service.name)
    service.name.withCString { key in ltLinkDiscovery(2, key, nil) }
  }

  func netServiceDidResolveAddress(_ sender: NetService) {
    var ips: [String] = []
    for data in sender.addresses ?? [] {
      if let ip = LinkBonjour.ipString(data), !ips.contains(ip) {
        ips.append(ip)
      }
    }
    var txt: [String: String] = [:]
    if let record = sender.txtRecordData() {
      for (key, value) in NetService.dictionary(fromTXTRecord: record) {
        txt[key] = String(data: value, encoding: .utf8) ?? ""
      }
    }
    let payload: [String: Any] = ["ips": ips, "port": sender.port, "txt": txt]
    guard
      let data = try? JSONSerialization.data(withJSONObject: payload),
      let json = String(data: data, encoding: .utf8)
    else { return }
    sender.name.withCString { key in
      json.withCString { text in ltLinkDiscovery(1, key, text) }
    }
  }

  static func ipString(_ data: Data) -> String? {
    return data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) -> String? in
      guard let base = raw.baseAddress, raw.count >= MemoryLayout<sockaddr>.size else { return nil }
      let family = base.assumingMemoryBound(to: sockaddr.self).pointee.sa_family
      var buffer = [CChar](repeating: 0, count: Int(INET6_ADDRSTRLEN))
      if family == sa_family_t(AF_INET), raw.count >= MemoryLayout<sockaddr_in>.size {
        var address = base.assumingMemoryBound(to: sockaddr_in.self).pointee.sin_addr
        guard inet_ntop(AF_INET, &address, &buffer, socklen_t(buffer.count)) != nil else { return nil }
      } else if family == sa_family_t(AF_INET6), raw.count >= MemoryLayout<sockaddr_in6>.size {
        var address = base.assumingMemoryBound(to: sockaddr_in6.self).pointee.sin6_addr
        guard inet_ntop(AF_INET6, &address, &buffer, socklen_t(buffer.count)) != nil else { return nil }
      } else {
        return nil
      }
      return String(cString: buffer)
    }
  }
}

private func optionalString(_ pointer: UnsafePointer<CChar>?) -> String? {
  guard let pointer = pointer else { return nil }
  return String(cString: pointer)
}

@_cdecl("lt_link_bonjour_advertise")
public func ltLinkBonjourAdvertise(
  _ name: UnsafePointer<CChar>?,
  _ type: UnsafePointer<CChar>?,
  _ port: Int32,
  _ txtJson: UnsafePointer<CChar>?
) {
  guard let name = optionalString(name), let type = optionalString(type) else { return }
  var txt: [String: String] = [:]
  if let json = optionalString(txtJson), let data = json.data(using: .utf8),
    let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: String]
  {
    txt = parsed
  }
  let record = txt
  DispatchQueue.main.async {
    LinkBonjour.shared.advertise(name: name, type: type, port: port, txt: record)
  }
}

@_cdecl("lt_link_bonjour_stop_advertise")
public func ltLinkBonjourStopAdvertise() {
  DispatchQueue.main.async { LinkBonjour.shared.stopAdvertising() }
}

@_cdecl("lt_link_bonjour_browse")
public func ltLinkBonjourBrowse(_ type: UnsafePointer<CChar>?) {
  guard let type = optionalString(type) else { return }
  DispatchQueue.main.async { LinkBonjour.shared.browse(type: type) }
}

@_cdecl("lt_link_bonjour_stop_browse")
public func ltLinkBonjourStopBrowse() {
  DispatchQueue.main.async { LinkBonjour.shared.stopBrowsing() }
}
