#pragma once
#include "streaming_benchmark_engine.h"
#include <atomic>
#include <chrono>
#include <latch>
#include <thread>

class StreamingJumpWorkload {
public:
    StreamingJumpWorkload(lt::StreamingBenchmarkEngine& engine, lt::Frame target)
        : thread_([this, &engine, target] {
            start_.wait();
            if (cancelled_.load()) return;
            const auto begin = std::chrono::steady_clock::now();
            try { engine.seek(target); } catch (...) { error_ = std::current_exception(); }
            elapsed_ms_ = std::chrono::duration<double, std::milli>(
                std::chrono::steady_clock::now() - begin).count();
        }) {}
    ~StreamingJumpWorkload() {
        if (!started_) { cancelled_.store(true); start_.count_down(); }
        if (thread_.joinable()) thread_.join();
    }
    void start() { started_ = true; start_.count_down(); }
    double finish() {
        if (thread_.joinable()) thread_.join();
        if (error_) std::rethrow_exception(error_);
        return elapsed_ms_;
    }
private:
    std::latch start_{1};
    std::atomic<bool> cancelled_{false};
    bool started_ = false;
    double elapsed_ms_ = 0;
    std::exception_ptr error_;
    std::thread thread_;
};
