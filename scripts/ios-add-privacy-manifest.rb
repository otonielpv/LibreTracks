#!/usr/bin/env ruby
# frozen_string_literal: true

# Adds PrivacyInfo.xcprivacy to the generated iOS app target as a resource.
#
# Apple reads the privacy manifest from the ROOT of the app bundle and rejects
# the upload without it (ITMS-91053). Tauri's bundle.resources cannot put it
# there: the generated project declares `assets` as a folder reference
# (`type: folder` in project.yml), so the whole directory is copied as-is and
# every resource lands under .app/assets/.
#
# It also cannot be copied into the .app after the build. That works for the
# unsigned smoke IPA, but the App Store build is signed by Xcode and adding a
# file afterwards invalidates the signature — which fails notarization/upload
# in a way that is annoying to diagnose. Making it a real target resource is
# the one approach that behaves identically for both.
#
# Run after `tauri ios init` and before `tauri ios build`. Idempotent.
#
#   ruby scripts/ios-add-privacy-manifest.rb <path/to/App.xcodeproj> <manifest>
#
# <manifest> is relative to the project directory (SRCROOT).

require 'xcodeproj'

project_path, manifest_path = ARGV

if project_path.nil? || manifest_path.nil?
  abort 'usage: ios-add-privacy-manifest.rb <App.xcodeproj> <PrivacyInfo.xcprivacy>'
end

unless File.exist?(File.join(File.dirname(project_path), manifest_path))
  abort "manifest not found next to the project: #{manifest_path}"
end

project = Xcodeproj::Project.open(project_path)

target = project.targets.find do |candidate|
  candidate.product_type == 'com.apple.product-type.application'
end
abort 'no application target in the generated project' if target.nil?

already_present = target.resources_build_phase.files.any? do |build_file|
  build_file.file_ref && build_file.file_ref.path == manifest_path
end

if already_present
  puts "#{manifest_path} is already a resource of #{target.name}"
  exit 0
end

file_reference = project.main_group.new_reference(manifest_path)
# Xcode has no built-in type for .xcprivacy; without this it guesses from the
# extension and can end up with none at all. It is a plist, so: XML.
file_reference.last_known_file_type = 'text.xml'
target.resources_build_phase.add_file_reference(file_reference, true)
project.save

puts "Added #{manifest_path} to the resources of #{target.name}"
