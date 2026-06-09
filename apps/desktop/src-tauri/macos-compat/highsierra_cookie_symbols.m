// macOS High Sierra (10.13) / Mojave (10.14) compatibility shim.
//
// wry 0.54 / Tauri 2.10 reference the NSHTTPCookieSameSite* string constants
// that Apple only introduced in Foundation on macOS 10.15 Catalina. On 10.13/
// 10.14 those symbols are absent, so dyld aborts at launch with:
//   dyld: Symbol not found: _NSHTTPCookieSameSiteLax
// before the app ever opens a window (see tauri-apps/tauri#14201).
//
// We provide the symbols ourselves, marked weak. The weak attribute means dyld
// only binds to these when no strong definition exists:
//   * macOS 10.15+  -> the system Foundation symbol (strong) wins; these are
//                      discarded. The app uses the normal, native behaviour and
//                      this shim is completely inert.
//   * macOS 10.13/14 -> the system symbol is missing, so dyld resolves these and
//                      the app launches instead of crashing.
//
// This lets us keep wry/Tauri on their current modern versions (no downgrade)
// while still booting on High Sierra. The string values mirror Apple's
// documented NSHTTPCookieStringPolicy constant values.

#import <Foundation/Foundation.h>

__attribute__((weak)) NSString *const NSHTTPCookieSameSiteLax = @"Lax";
__attribute__((weak)) NSString *const NSHTTPCookieSameSiteStrict = @"Strict";
__attribute__((weak)) NSString *const NSHTTPCookieSameSitePolicy = @"SameSite";
