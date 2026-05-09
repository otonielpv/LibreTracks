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
    CHECK(due.value() == 96000);
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
