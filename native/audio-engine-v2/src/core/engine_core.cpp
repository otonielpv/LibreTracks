#include <lt_engine/core/engine_core.h>
#include <sstream>

namespace lt {

std::string engine_version_string() {
    std::ostringstream ss;
    ss << kEngineMajor << '.' << kEngineMinor << '.' << kEnginePatch;
    return ss.str();
}

} // namespace lt
