#pragma once
// ---------------------------------------------------------------------------
// Session V2 adapter — converts the libretracks-project JSON format into the
// engine's Session V2 model.
//
// Called once before the engine loads a session.
// The JSON schema matches what libretracks-project serialises from Rust.
// ---------------------------------------------------------------------------

#include <lt_engine/session/session.h>
#include <lt_engine/core/result.h>
#include <string>

namespace lt {

/// Parse a libretracks-project JSON payload and produce a validated Session V2.
Result<Session> session_from_project_json(const std::string& project_json,
                                           int engine_sample_rate);

} // namespace lt
