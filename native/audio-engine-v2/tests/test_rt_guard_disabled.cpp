#include <lt_engine/diagnostics/rt_guard.h>

#include <type_traits>

static_assert(sizeof(lt::rt::ScopedRealtimeSection) <= 1);
static_assert(std::is_trivially_destructible_v<lt::rt::ScopedRealtimeSection>);
static_assert(lt::rt::violations().allocations == 0);
static_assert(lt::rt::violations().deallocations == 0);
