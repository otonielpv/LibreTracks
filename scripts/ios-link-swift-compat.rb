#!/usr/bin/env ruby
# frozen_string_literal: true

# Teaches the generated iOS target where Swift's libraries live.
#
# The app's Swift — Tauri's own plugins plus our folder picker — is compiled by
# tauri-utils through swift-rs and ends up INSIDE libapp.a, the Rust staticlib.
# Xcode therefore never sees a .swift file in the target, decides the target is
# pure Objective-C, and leaves the toolchain's Swift library directory out of
# the link line. That is invisible until something in libapp.a references a
# library that lives there.
#
# Which is exactly what happens from Xcode 26 on:
#
#   ld: Could not find or use auto-linked library 'swiftCompatibility56'
#   Undefined symbols: "__swift_FORCE_LOAD_$_swiftCompatibility56",
#     referenced from: libapp.a(lib.swift.o), (Channel.swift.o), ...
#
# The library is not missing from Xcode 26 — it ships it, and 16.4 shipped it
# too. Nobody was looking in its directory. swiftc emits that force-load for
# any deployment target below iOS 16 (measured: 13.0 also pulls 51 and
# Concurrency; 15.0 and 15.4 pull 56; 16.0 pulls none), and tauri-utils
# compiles the Swift for iOS 13 unless IPHONEOS_DEPLOYMENT_TARGET says
# otherwise. Raising our minimum to 16 would also silence it, at the price of
# every iPhone 7 and 6s — a real cost, to work around a missing -L.
#
# Run after `tauri ios init` and before `tauri ios build`. Idempotent.
#
#   ruby scripts/ios-link-swift-compat.rb <path/to/App.xcodeproj>

require 'xcodeproj'

# What Xcode itself puts in LIBRARY_SEARCH_PATHS for a target it knows has
# Swift in it. Kept as build settings, not literal paths, so the same project
# links against whichever Xcode and platform the build happens to use —
# iphoneos for the IPA, iphonesimulator for the screenshot runs.
# $(TOOLCHAIN_DIR) is NOT the answer, even though the template already uses it
# and it reads like it should be: under Xcode 26 it expands to the Metal
# toolchain's cryptex mount, and the link line ends up with
#
#   -L/var/run/com.apple.security.cryptexd/.../Metal.xctoolchain/usr/lib/swift/iphoneos
#
# which does not exist. $(DT_TOOLCHAIN_DIR) is the developer-tools toolchain,
# which is the one that actually holds libswiftCompatibility56.a.
SWIFT_LIBRARY_PATHS = [
  '$(inherited)',
  '$(DT_TOOLCHAIN_DIR)/usr/lib/swift/$(PLATFORM_NAME)',
  '$(SDKROOT)/usr/lib/swift'
].freeze

# And a belt to go with those braces: the directory as it resolves right now,
# from the compiler the build will actually use. A build setting that silently
# expands to the wrong place is precisely what this script exists to undo, and
# the generated project is rebuilt from scratch on every run, so an absolute
# path in it ages out the same day it is written.
def resolved_swift_library_dirs
  swiftc = `xcrun -f swiftc 2>/dev/null`.strip
  return [] if swiftc.empty?

  toolchain_lib = File.expand_path('../../lib/swift', swiftc)
  %w[iphoneos iphonesimulator]
    .map { |platform| File.join(toolchain_lib, platform) }
    .select { |dir| Dir.exist?(dir) }
end

project_path = ARGV[0]
abort 'usage: ios-link-swift-compat.rb <App.xcodeproj>' if project_path.nil?

project = Xcodeproj::Project.open(project_path)

target = project.targets.find do |candidate|
  candidate.product_type == 'com.apple.product-type.application'
end
abort 'no application target in the generated project' if target.nil?

changed = false

wanted = SWIFT_LIBRARY_PATHS + resolved_swift_library_dirs

target.build_configurations.each do |config|
  existing = config.build_settings['LIBRARY_SEARCH_PATHS']
  existing = [existing].compact unless existing.is_a?(Array)

  missing = wanted - existing
  next if missing.empty?

  config.build_settings['LIBRARY_SEARCH_PATHS'] = existing + missing
  changed = true
  puts "#{config.name}: added #{missing.join(' ')}"
end

if changed
  project.save
  puts "Swift library search paths set on #{target.name}"
else
  puts "#{target.name} already searches the Swift library directories"
end
