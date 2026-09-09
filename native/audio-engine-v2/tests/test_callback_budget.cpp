#include <lt_engine/diagnostics/callback_budget.h>
#include <doctest/doctest.h>

TEST_CASE("callback headroom warning is distinct from a missed render deadline") {
    CHECK_FALSE(lt::classify_callback_budget(7.5, 10.0).low_headroom);
    const auto warning = lt::classify_callback_budget(8.0, 10.0);
    CHECK(warning.low_headroom);
    CHECK_FALSE(warning.deadline_missed);
    CHECK_FALSE(lt::classify_callback_budget(10.0, 10.0).deadline_missed);
    CHECK(lt::classify_callback_budget(10.1, 10.0).deadline_missed);
    CHECK_FALSE(lt::classify_callback_budget(10.0, 0.0).low_headroom);
    CHECK_FALSE(lt::classify_callback_budget(10.0, -1.0).deadline_missed);
}
