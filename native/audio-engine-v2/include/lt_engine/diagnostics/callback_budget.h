#pragma once

namespace lt {

struct CallbackBudgetStatus {
    bool low_headroom = false;
    bool deadline_missed = false;
};

// Duration is render wall time, not process CPU utilization or a driver xrun.
constexpr CallbackBudgetStatus classify_callback_budget(double duration_ms,
                                                         double budget_ms) noexcept {
    return budget_ms > 0.0
        ? CallbackBudgetStatus{duration_ms > budget_ms * 0.75, duration_ms > budget_ms}
        : CallbackBudgetStatus{};
}

} // namespace lt
