//! Makes the build-time OAuth inputs actually take effect.
//!
//! `option_env!` is resolved when the crate compiles, and Cargo does not know
//! that the result depends on an environment variable. Without the lines
//! below, setting `LIBRETRACKS_GOOGLE_CLIENT_SECRET` (or a OneDrive/Dropbox
//! id) after a build leaves the old value (usually `None`) baked into the
//! artifact until something unrelated forces a recompile — which looks exactly
//! like the value being ignored.

fn main() {
    println!("cargo:rerun-if-env-changed=LIBRETRACKS_GOOGLE_CLIENT_SECRET");
    println!("cargo:rerun-if-env-changed=LIBRETRACKS_ONEDRIVE_CLIENT_ID");
    println!("cargo:rerun-if-env-changed=LIBRETRACKS_DROPBOX_APP_KEY");
}
