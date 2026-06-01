#include <doctest/doctest.h>
#include <lt_engine/scheduler/jump_scheduler.h>
#include <lt_engine/transport/transport_clock.h>
#include <lt_engine/session/session.h>

using namespace lt;

// ── Helpers ──────────────────────────────────────────────────────────────────

static Session make_session_with_marker() {
    Session sess;
    sess.id = "s"; sess.sample_rate = 48000;
    Song song; song.id = "song-1"; song.start_frame = 0; song.end_frame = 480000; song.name = "S";
    Marker m; m.id = "m1"; m.name = "Chorus"; m.frame = 96000;
    song.markers.push_back(m);
    Region r; r.id = "r1"; r.name = "Verse"; r.start_frame = 0; r.end_frame = 96000; r.transpose_semitones = 0;
    song.regions.push_back(r);
    Song song2; song2.id = "song-2"; song2.start_frame = 480000; song2.end_frame = 960000; song2.name = "S2";
    sess.songs.push_back(std::move(song));
    sess.songs.push_back(std::move(song2));
    return sess;
}

static JumpTarget frame_target(Frame f) {
    JumpTarget t;
    t.kind  = JumpTarget::Kind::Frame;
    t.frame = f;
    return t;
}

static JumpTarget marker_target(Id id) {
    JumpTarget t;
    t.kind = JumpTarget::Kind::Marker;
    t.id   = std::move(id);
    return t;
}

static JumpTarget next_song_target() {
    JumpTarget t; t.kind = JumpTarget::Kind::NextSong; return t;
}

// ── resolve_jump_target ───────────────────────────────────────────────────────

TEST_CASE("resolve Frame target") {
    TransportClock clock(48000);
    auto sess = make_session_with_marker();
    auto r = resolve_jump_target(frame_target(12345), sess, clock);
    CHECK(r.is_ok());
    CHECK(r.unwrap() == 12345);
}

TEST_CASE("resolve Marker target") {
    TransportClock clock(48000);
    auto sess = make_session_with_marker();
    auto r = resolve_jump_target(marker_target("m1"), sess, clock);
    CHECK(r.is_ok());
    CHECK(r.unwrap() == 96000);
}

TEST_CASE("resolve unknown Marker returns error") {
    TransportClock clock(48000);
    auto sess = make_session_with_marker();
    auto r = resolve_jump_target(marker_target("nonexistent"), sess, clock);
    CHECK(r.is_err());
}

TEST_CASE("resolve marker target can use exact fallback frame") {
    TransportClock clock(48000);
    auto sess = make_session_with_marker();
    auto target = marker_target("rust-only-section");
    target.frame = 123456;
    auto r = resolve_jump_target(target, sess, clock);
    CHECK(r.is_ok());
    CHECK(r.unwrap() == 123456);
}

TEST_CASE("resolve marker target prefers explicit warped frame over marker frame") {
    TransportClock clock(48000);
    auto sess = make_session_with_marker();
    auto target = marker_target("m1");
    target.frame = 123456;
    auto r = resolve_jump_target(target, sess, clock);
    CHECK(r.is_ok());
    CHECK(r.unwrap() == 123456);
}

TEST_CASE("resolve NextSong from inside song-1") {
    TransportClock clock(48000);
    clock.seek(10000);  // inside song-1
    auto sess = make_session_with_marker();
    JumpTarget t; t.kind = JumpTarget::Kind::NextSong;
    auto r = resolve_jump_target(t, sess, clock);
    CHECK(r.is_ok());
    CHECK(r.unwrap() == 480000);  // song-2 start
}

TEST_CASE("resolve PreviousSong from inside song-2") {
    TransportClock clock(48000);
    clock.seek(500000);  // inside song-2
    auto sess = make_session_with_marker();
    JumpTarget t; t.kind = JumpTarget::Kind::PreviousSong;
    auto r = resolve_jump_target(t, sess, clock);
    CHECK(r.is_ok());
    CHECK(r.unwrap() == 0);  // song-1 start
}

TEST_CASE("resolve Region target") {
    TransportClock clock(48000);
    auto sess = make_session_with_marker();
    JumpTarget t; t.kind = JumpTarget::Kind::Region; t.id = "r1";
    auto r = resolve_jump_target(t, sess, clock);
    CHECK(r.is_ok());
    CHECK(r.unwrap() == 0);
}

// ── Schedule / cancel / replace ──────────────────────────────────────────────

TEST_CASE("resolve region target prefers explicit warped frame over region start") {
    TransportClock clock(48000);
    auto sess = make_session_with_marker();
    JumpTarget t; t.kind = JumpTarget::Kind::Region; t.id = "r1"; t.frame = 123456;
    auto r = resolve_jump_target(t, sess, clock);
    CHECK(r.is_ok());
    CHECK(r.unwrap() == 123456);
}

TEST_CASE("schedule and drain pending appears in list") {
    TransportClock clock(48000);
    auto sess = make_session_with_marker();
    JumpScheduler sched;

    ScheduledJump j;
    j.jump_id       = "j1";
    j.target        = frame_target(1000);
    j.trigger       = JumpTrigger::Immediate;
    j.status        = JumpStatus::Armed;
    j.created_frame = 0;

    sched.schedule(j);
    sched.drain_pending();

    auto list = sched.jump_list();
    CHECK(list.size() == 1);
    CHECK(list[0].jump_id == "j1");
    CHECK(list[0].status  == JumpStatus::Armed);
}

TEST_CASE("cancel changes status to Cancelled") {
    TransportClock clock(48000);
    JumpScheduler sched;

    ScheduledJump j;
    j.jump_id = "j2"; j.target = frame_target(5000);
    j.trigger = JumpTrigger::AtSongEnd; j.status = JumpStatus::Pending;
    sched.schedule(j);
    sched.drain_pending();

    sched.cancel("j2");
    sched.drain_pending();

    auto list = sched.jump_list();
    REQUIRE(list.size() == 1);
    CHECK(list[0].status == JumpStatus::Cancelled);
}

TEST_CASE("cancel_all cancels pending and armed") {
    JumpScheduler sched;
    for (int i = 0; i < 3; ++i) {
        ScheduledJump j;
        j.jump_id = "j" + std::to_string(i);
        j.target  = frame_target(i * 1000);
        j.trigger = JumpTrigger::Immediate;
        j.status  = JumpStatus::Pending;
        sched.schedule(j);
    }
    sched.drain_pending();
    sched.cancel_all();
    sched.drain_pending();

    for (const auto& jmp : sched.jump_list())
        CHECK(jmp.status == JumpStatus::Cancelled);
}

TEST_CASE("replace changes target and resets to Pending") {
    JumpScheduler sched;
    ScheduledJump j;
    j.jump_id = "j1"; j.target = frame_target(1000);
    j.trigger = JumpTrigger::Immediate; j.status = JumpStatus::Pending;
    sched.schedule(j);
    sched.drain_pending();

    sched.replace("j1", frame_target(9999), JumpTrigger::AtSongEnd);
    sched.drain_pending();

    auto list = sched.jump_list();
    REQUIRE(list.size() == 1);
    CHECK(list[0].status         == JumpStatus::Pending);
    CHECK(list[0].trigger        == JumpTrigger::AtSongEnd);
    CHECK(list[0].target.frame.value() == 9999);
}

// ── check_due / mark_executed ─────────────────────────────────────────────────

TEST_CASE("armed immediate jump is due on first check_due") {
    TransportClock clock(48000);
    clock.play();
    auto sess = make_session_with_marker();
    JumpScheduler sched;

    ScheduledJump j;
    j.jump_id = "j1"; j.target = frame_target(96000);
    j.trigger = JumpTrigger::Immediate; j.status = JumpStatus::Armed;
    sched.schedule(j);
    sched.drain_pending();

    auto due = sched.check_due(clock, sess);
    CHECK(due.has_value());
    CHECK(due->target_frame == 96000);
    CHECK(due->trigger_frame == 0);
}

TEST_CASE("mark_executed sets status to Executed") {
    TransportClock clock(48000);
    clock.play();
    auto sess = make_session_with_marker();
    JumpScheduler sched;

    ScheduledJump j;
    j.jump_id = "j1"; j.target = frame_target(5000);
    j.trigger = JumpTrigger::Immediate; j.status = JumpStatus::Armed;
    sched.schedule(j);
    sched.drain_pending();

    sched.check_due(clock, sess);
    sched.mark_executed(0, 5000);

    auto list = sched.jump_list();
    CHECK(list[0].status == JumpStatus::Executed);
}

TEST_CASE("cancelled jump is not due") {
    TransportClock clock(48000);
    clock.play();
    auto sess = make_session_with_marker();
    JumpScheduler sched;

    ScheduledJump j;
    j.jump_id = "j1"; j.target = frame_target(5000);
    j.trigger = JumpTrigger::Immediate; j.status = JumpStatus::Pending;
    sched.schedule(j);
    sched.drain_pending();
    sched.cancel("j1");
    sched.drain_pending();

    auto due = sched.check_due(clock, sess);
    CHECK_FALSE(due.has_value());
}

// ── schedule_immediate convenience ───────────────────────────────────────────

TEST_CASE("schedule_immediate resolves frame and arms jump") {
    TransportClock clock(48000);
    auto sess = make_session_with_marker();
    JumpScheduler sched;

    auto r = sched.schedule_immediate("j-imm", marker_target("m1"), sess, clock);
    CHECK(r.is_ok());
    CHECK(r.unwrap() == 96000);

    sched.drain_pending();
    auto list = sched.jump_list();
    REQUIRE(list.size() == 1);
    CHECK(list[0].status == JumpStatus::Armed);
}

TEST_CASE("multiple immediate jumps coalesce to latest target") {
    TransportClock clock(48000);
    clock.play();
    auto sess = make_session_with_marker();
    JumpScheduler sched;

    for (int i = 0; i < 100; ++i) {
        auto r = sched.schedule_immediate("jump-" + std::to_string(i),
                                          frame_target(1000 + i),
                                          sess,
                                          clock);
        CHECK(r.is_ok());
    }

    sched.drain_pending();
    auto list = sched.jump_list();
    REQUIRE(list.size() == 1);
    CHECK(list[0].jump_id == "jump-99");
    auto due = sched.check_due(clock, sess, 128);
    REQUIRE(due.has_value());
    CHECK(due->target_frame == 1099);
    CHECK(due->trigger_frame == 0);
}

TEST_CASE("region end trigger uses actual render block size") {
    TransportClock clock(48000);
    auto sess = make_session_with_marker();
    JumpScheduler sched;
    clock.seek(95600);
    clock.play();

    ScheduledJump jump;
    jump.jump_id = "region-end";
    jump.target = frame_target(1234);
    jump.trigger = JumpTrigger::AtRegionEnd;
    jump.status = JumpStatus::Pending;
    sched.schedule(jump);
    sched.drain_pending();

    CHECK_FALSE(sched.check_due(clock, sess, 128).has_value());
    auto due = sched.check_due(clock, sess, 512);
    REQUIRE(due.has_value());
    CHECK(due->target_frame == 1234);
    CHECK(due->trigger_frame == 96000);
}

TEST_CASE("at-frame trigger fires at trigger frame and resolves separate target") {
    TransportClock clock(48000);
    auto sess = make_session_with_marker();
    JumpScheduler sched;
    clock.seek(95600);
    clock.play();

    ScheduledJump jump;
    jump.jump_id = "after-bars";
    jump.target = frame_target(1234);
    jump.trigger = JumpTrigger::AtFrame;
    jump.status = JumpStatus::Pending;
    jump.trigger_frame = 96000;
    sched.schedule(jump);
    sched.drain_pending();

    CHECK_FALSE(sched.check_due(clock, sess, 128).has_value());
    auto due = sched.check_due(clock, sess, 512);
    REQUIRE(due.has_value());
    CHECK(due->target_frame == 1234);
    CHECK(due->trigger_frame == 96000);
}

TEST_CASE("at-frame due jump carries prepared voice map payload") {
    TransportClock clock(48000);
    auto sess = make_session_with_marker();
    JumpScheduler sched;
    clock.seek(95600);
    clock.play();

    auto prepared = std::make_shared<const PreparedVoiceMap>();

    ScheduledJump jump;
    jump.jump_id = "after-bars";
    jump.target = frame_target(1234);
    jump.trigger = JumpTrigger::AtFrame;
    jump.status = JumpStatus::Pending;
    jump.trigger_frame = 96000;
    jump.suppress_seek_fade = true;
    jump.prepared_voice_map = prepared;
    sched.schedule(jump);
    sched.drain_pending();

    auto due = sched.check_due(clock, sess, 512);
    REQUIRE(due.has_value());
    CHECK(due->prepared_voice_map.get() == prepared.get());
    CHECK(due->suppress_seek_fade);
}
