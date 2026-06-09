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
//
// Keeping these definitions in the final binary takes two cooperating guards;
// neither alone is enough under a release build:
//   * Here, `used` sets the object-level N_NO_DEAD_STRIP flag on each atom.
//   * In build.rs, each symbol is passed to the linker as `-Wl,-u,<sym>` (a
//     required root). This is the load-bearing one: rustc links macOS release
//     binaries with `-dead_strip` by default, and because we build against a
//     modern (10.15+) SDK whose Foundation already exports these symbols, wry's
//     references bind to that strong dylib export, not to our weak definitions.
//     With no local referrer, `-dead_strip` deletes the (force-loaded) atoms and
//     the symbol vanishes entirely — the exact failure the CI "Verify High Sierra
//     cookie shim linked" guard catches. Marking each as a `-u` root keeps it.
// On 10.15+ the strong system symbol still wins, so the retained weak defs stay
// inert; on 10.13/10.14 they are what dyld resolves so the app launches.

#import <Foundation/Foundation.h>

__attribute__((weak, used)) NSString *const NSHTTPCookieSameSiteLax = @"Lax";
__attribute__((weak, used)) NSString *const NSHTTPCookieSameSiteStrict = @"Strict";
__attribute__((weak, used)) NSString *const NSHTTPCookieSameSitePolicy = @"SameSite";
