#include <doctest/doctest.h>
#include <lt_engine/render/mixer.h>

#include <atomic>
#include <latch>
#include <memory>
#include <thread>

using namespace lt;

TEST_CASE("step04 folder peak accumulation keeps concurrent maximum") {
    auto session = std::make_shared<Session>();
    session->sample_rate = 48000;
    Mixer mixer(session, nullptr, nullptr, nullptr);
    std::latch ready(2);
    std::latch go(1);
    std::thread a([&] {
        ready.count_down(); go.wait();
        for (int i = 0; i < 10000; ++i) mixer.accumulate_folder_meter_for_test(0, static_cast<float>(i));
    });
    std::thread b([&] {
        ready.count_down(); go.wait();
        for (int i = 0; i < 10000; ++i) mixer.accumulate_folder_meter_for_test(0, static_cast<float>(i) + 0.5f);
    });
    ready.wait(); go.count_down();
    a.join(); b.join();
    CHECK(mixer.folder_meter_peak_for_test(0) == 9999.5f);
}
