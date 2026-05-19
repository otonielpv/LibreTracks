#pragma once

#include <lt_engine/core/types.h>

#include <memory>
#include <unordered_map>

namespace lt {

class BungeePitchVoice;

using PreparedVoiceMap = std::unordered_map<Id, std::shared_ptr<BungeePitchVoice>>;

} // namespace lt
