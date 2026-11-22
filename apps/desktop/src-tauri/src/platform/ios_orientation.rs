//! Girar el iPhone a vertical u horizontal (plan `portrait-text-modals`).
//!
//! `Info.ios.plist` admite vertical en iPhone, pero el view controller de tao
//! se limita a horizontal al arrancar ([`set_screen_orientation`] con
//! `Landscape` desde el setup), así que la app sigue en horizontal como antes.
//!
//! `setSupportedInterfaceOrientations` de tao solo llama a
//! `attemptRotationToDeviceOrientation`, que desde iOS 16 no gira nada si el
//! usuario no mueve el móvil. Por eso, en iOS 16+, además se avisa al view
//! controller (`setNeedsUpdateOfSupportedInterfaceOrientations`) y se pide el
//! giro a la escena (`requestGeometryUpdateWithPreferences:errorHandler:`).
//! Hecho aquí y no en `vendor/tao` para no ampliar el parche de tao.

use std::ptr::null_mut;

use objc2::runtime::{AnyClass, AnyObject};
use objc2::{msg_send, sel};
use tauri::WebviewWindow;

use super::screen_orientation::ScreenOrientation;

/// `UIInterfaceOrientationMaskPortrait`
const MASK_PORTRAIT: usize = 1 << 1;
/// `UIInterfaceOrientationMaskLandscape` (left | right)
const MASK_LANDSCAPE: usize = (1 << 3) | (1 << 4);
/// `UIInterfaceOrientationMaskAllButUpsideDown`
const MASK_FREE: usize = MASK_PORTRAIT | MASK_LANDSCAPE;

pub fn set_screen_orientation(
    window: &WebviewWindow,
    orientation: ScreenOrientation,
) -> Result<(), String> {
    let mask = match orientation {
        ScreenOrientation::Portrait => MASK_PORTRAIT,
        ScreenOrientation::Landscape => MASK_LANDSCAPE,
        ScreenOrientation::Free => MASK_FREE,
    };
    // Libre no fuerza ningún giro: solo amplía lo admitido y el sensor decide.
    let force = orientation != ScreenOrientation::Free;
    window
        .with_webview(move |webview| {
            // SAFETY: Tauri ejecuta esto en el hilo principal. El view
            // controller es el de tao (tiene la propiedad
            // `supportedInterfaceOrientations`) y vive lo que la ventana. Cada
            // selector de iOS 16 se comprueba con `respondsToSelector:` antes.
            unsafe {
                let vc: *mut AnyObject = webview.view_controller().cast();
                if vc.is_null() {
                    return;
                }
                let _: () = msg_send![vc, setSupportedInterfaceOrientations: mask];

                let responds: bool = msg_send![
                    vc,
                    respondsToSelector: sel!(setNeedsUpdateOfSupportedInterfaceOrientations)
                ];
                if responds {
                    let _: () = msg_send![vc, setNeedsUpdateOfSupportedInterfaceOrientations];
                }

                let view: *mut AnyObject = msg_send![vc, view];
                if view.is_null() {
                    return;
                }
                let ui_window: *mut AnyObject = msg_send![view, window];
                if ui_window.is_null() {
                    return;
                }
                let scene: *mut AnyObject = msg_send![ui_window, windowScene];
                if scene.is_null() {
                    return;
                }
                let responds: bool = msg_send![
                    scene,
                    respondsToSelector: sel!(requestGeometryUpdateWithPreferences:errorHandler:)
                ];
                if !responds || !force {
                    return;
                }
                let Some(class) = AnyClass::get(c"UIWindowSceneGeometryPreferencesIOS") else {
                    return;
                };
                let preferences: *mut AnyObject = msg_send![class, alloc];
                let preferences: *mut AnyObject =
                    msg_send![preferences, initWithInterfaceOrientations: mask];
                if preferences.is_null() {
                    return;
                }
                let no_handler: *mut AnyObject = null_mut();
                let _: () = msg_send![
                    scene,
                    requestGeometryUpdateWithPreferences: preferences,
                    errorHandler: no_handler
                ];
                let _: () = msg_send![preferences, release];
            }
        })
        .map_err(|error| format!("with_webview: {error}"))
}
