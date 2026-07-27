// ---------------------------------------------------------------------------
// bench_purge_cache — does the engine's cache purge actually delete files?
//
// The user reports that "Clear cache" in Settings does not free the cache: the
// 25 PCM files and 25 .ltpeaks survived every click, and only a manual
// Remove-Item cleared them.
//
// purge_source_cache() lists entries with FindFirstFileA and keeps only names
// passing is_pcm_cache_file() (".wav" or ".rf64"). Both the directory listing
// and the extension filter are candidates. This exercises the REAL exported
// entry points against a directory we populate ourselves, so the answer is
// measured rather than reasoned:
//
//   - which files does it count (size_bytes)?
//   - which files does it actually delete (purge)?
//   - does it respect LIBRETRACKS_CACHE_DIR?
//
// Usage: run it; it creates its own scratch cache dir and cleans up.
// ---------------------------------------------------------------------------

#include <lt_engine/sources/source_manager.h>

#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <string>
#include <vector>

#if defined(_WIN32)
#include <windows.h>
#endif

namespace fs = std::filesystem;

namespace {

void write_file(const fs::path& p, std::size_t bytes) {
    fs::create_directories(p.parent_path());
    std::ofstream out(p, std::ios::binary);
    std::vector<char> data(bytes, 'x');
    out.write(data.data(), static_cast<std::streamsize>(bytes));
}

std::size_t count_files(const fs::path& dir) {
    std::error_code ec;
    if (!fs::exists(dir, ec)) return 0;
    std::size_t n = 0;
    for (auto& e : fs::directory_iterator(dir, ec))
        if (e.is_regular_file(ec)) ++n;
    return n;
}

} // namespace

int main() {
    const fs::path root =
        fs::temp_directory_path() / "lt_purge_probe";
    std::error_code ec;
    fs::remove_all(root, ec);
    fs::create_directories(root, ec);

    const std::string root_str = root.string();
#if defined(_WIN32)
    SetEnvironmentVariableA("LIBRETRACKS_CACHE_DIR", root_str.c_str());
#else
    setenv("LIBRETRACKS_CACHE_DIR", root_str.c_str(), 1);
#endif

    std::printf("=== purge probe ===\n");
    std::printf("scratch cache root: %s\n", root_str.c_str());

    const std::string engine_dir = lt::source_cache_directory();
    std::printf("engine reports source-cache dir: %s\n", engine_dir.c_str());
    const bool honoured = engine_dir.find(root_str) != std::string::npos;
    std::printf("honours LIBRETRACKS_CACHE_DIR: %s\n\n",
                honoured ? "YES" : "NO  <-- purge would target the wrong place");

    const fs::path src_cache = fs::path(engine_dir);

    // Populate with exactly what the real cache contains.
    write_file(src_cache / "10297814264876921736.wav", 1024);
    write_file(src_cache / "11119471213255137392.wav", 2048);
    write_file(src_cache / "legacy_float.rf64", 512);
    // A stray extension, to see whether the filter drops it.
    write_file(src_cache / "unexpected.tmp", 256);

    std::printf("populated source-cache with %zu files\n", count_files(src_cache));

    const unsigned long long size_before = lt::source_cache_dir_size_bytes();
    std::printf("source_cache_size_bytes() reports: %llu bytes\n", size_before);

    const unsigned long long freed = lt::purge_source_cache();
    const std::size_t left = count_files(src_cache);

    std::printf("purge_source_cache() freed:        %llu bytes\n", freed);
    std::printf("files left after purge:            %zu\n\n", left);

    std::printf("--- verdict (idle files) ---\n");
    if (freed == 0 && left > 0) {
        std::printf("PURGE IS BROKEN: it deleted nothing.\n");
    } else if (left == 0) {
        std::printf("purge removed every file (including the stray .tmp).\n");
    } else {
        std::printf("purge removed the PCM files but left %zu file(s) behind\n"
                    "  (extension filter: only .wav/.rf64 are purged).\n", left);
        for (auto& e : fs::directory_iterator(src_cache, ec))
            std::printf("    left: %s\n", e.path().filename().string().c_str());
    }

    // -----------------------------------------------------------------------
    // The real-world case: in the app the cache files belong to a LOADED
    // session, so the engine may still hold them open. On Windows a file open
    // without FILE_SHARE_DELETE cannot be unlinked — std::remove fails and the
    // purge silently reports 0 bytes freed while every file survives. That
    // matches the user's report exactly ("Clear cache did nothing"), so test it.
    // -----------------------------------------------------------------------
    std::printf("\n=== same purge, but with a file HELD OPEN ===\n");
    const fs::path held = src_cache / "held_open.wav";
    write_file(held, 4096);
    write_file(src_cache / "not_held.wav", 4096);

    {
#if defined(_WIN32)
        // Open the way a reader would, WITHOUT FILE_SHARE_DELETE.
        HANDLE h = CreateFileA(held.string().c_str(), GENERIC_READ,
                               FILE_SHARE_READ, nullptr, OPEN_EXISTING,
                               FILE_ATTRIBUTE_NORMAL, nullptr);
        const bool opened = (h != INVALID_HANDLE_VALUE);
        std::printf("holding %s open: %s\n", held.filename().string().c_str(),
                    opened ? "yes" : "FAILED");
#else
        std::ifstream keep(held, std::ios::binary);
        std::printf("holding %s open: yes\n", held.filename().string().c_str());
#endif
        unsigned int failed = 0;
        const unsigned long long freed2 = lt::purge_source_cache(&failed);
        const std::size_t left2 = count_files(src_cache);
        std::printf("purge freed: %llu bytes, files left: %zu, REPORTED FAILURES: %u\n",
                    freed2, left2, failed);
        for (auto& e : fs::directory_iterator(src_cache, ec))
            std::printf("    left: %s\n", e.path().filename().string().c_str());

        std::printf("\n--- verdict (open file) ---\n");
        if (failed == 0 && left2 > 0) {
            std::printf("BUG: files survived but the purge reported no failures —\n"
                        "  the caller cannot tell this apart from an empty cache.\n");
        } else if (failed > 0) {
            std::printf("Purge reports %u file(s) in use. The host can now tell the\n"
                        "  user to close the session instead of claiming success.\n", failed);
        } else {
            std::printf("Everything was deleted; nothing was in use.\n");
        }
#if defined(_WIN32)
        if (opened) CloseHandle(h);
#endif
    }

    fs::remove_all(root, ec);
    return 0;
}
