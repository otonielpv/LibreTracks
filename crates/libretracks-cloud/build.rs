//! Makes the build-time client secret actually take effect.
//!
//! `option_env!` is resolved when the crate compiles, and Cargo does not know
//! that the result depends on an environment variable. Without the line below,
//! setting `LIBRETRACKS_GOOGLE_CLIENT_SECRET` after a build leaves the old
//! value (usually `None`) baked into the artifact until something unrelated
//! forces a recompile — which looks exactly like the secret being ignored.

fn main() {
    println!("cargo:rerun-if-env-changed=LIBRETRACKS_GOOGLE_CLIENT_SECRET");
}
