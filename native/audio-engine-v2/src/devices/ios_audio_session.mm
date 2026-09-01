#include <lt_engine/devices/ios_audio_session.h>
#include <lt_engine/debug/logging.h>

#import <AVFoundation/AVFoundation.h>

#include <atomic>
#include <cstdio>

namespace lt {

namespace {

std::string describe_error(NSError* error) {
    if (error == nil) return "unknown AVAudioSession error";
    NSString* description = error.localizedDescription;
    return description != nil ? std::string(description.UTF8String)
                              : "AVAudioSession returned an error";
}

std::atomic<unsigned> g_route_generation{0};

/// Subscribe to the two things iOS can do behind the app's back. Idempotent:
/// configure_ios_playback_session runs on every device open.
///
/// The blocks touch nothing but an atomic and the log — no session calls, no
/// device work — so they are safe on whatever thread the notification arrives
/// on. What acts on them is the device manager's stall monitor, which already
/// owns the tear-down/reopen path (see ios_audio_route_generation).
void install_ios_session_observers() {
    static dispatch_once_t once_token;
    dispatch_once(&once_token, ^{
        NSNotificationCenter* center = NSNotificationCenter.defaultCenter;

        [center addObserverForName:AVAudioSessionRouteChangeNotification
                            object:nil
                             queue:nil
                        usingBlock:^(NSNotification* note) {
            const NSInteger reason =
                [note.userInfo[AVAudioSessionRouteChangeReasonKey] integerValue];
            // ONLY real hardware coming and going. In particular NOT
            // CategoryChange: this app's own setCategory during open posts one,
            // so reacting to it would make every open trigger another open.
            const bool hardware_changed =
                reason == AVAudioSessionRouteChangeReasonNewDeviceAvailable ||
                reason == AVAudioSessionRouteChangeReasonOldDeviceUnavailable;
            lt_debug_log("[LT_IOS_AUDIO] route change reason=%ld acted=%d\n",
                         static_cast<long>(reason), hardware_changed ? 1 : 0);
            if (hardware_changed) {
                g_route_generation.fetch_add(1, std::memory_order_relaxed);
            }
        }];

        [center addObserverForName:AVAudioSessionInterruptionNotification
                            object:nil
                             queue:nil
                        usingBlock:^(NSNotification* note) {
            const NSInteger type =
                [note.userInfo[AVAudioSessionInterruptionTypeKey] integerValue];
            // Only the END is actionable. The BEGIN needs nothing from us: iOS
            // has already stopped the callbacks and the stall monitor puts the
            // engine on its fallback clock within ~1.5 s, which is what keeps
            // the transport moving through the call.
            const bool ended = type == AVAudioSessionInterruptionTypeEnded;
            lt_debug_log("[LT_IOS_AUDIO] interruption type=%ld acted=%d\n",
                         static_cast<long>(type), ended ? 1 : 0);
            if (ended) {
                g_route_generation.fetch_add(1, std::memory_order_relaxed);
            }
        }];
    });
}

} // namespace

unsigned ios_audio_route_generation() {
    return g_route_generation.load(std::memory_order_relaxed);
}

bool configure_ios_playback_session(std::string* error_message,
                                    double preferred_sample_rate) {
    @autoreleasepool {
        install_ios_session_observers();
        AVAudioSession* session = AVAudioSession.sharedInstance;
        NSError* error = nil;

        // Playback already enables the system-managed A2DP and AirPlay routes.
        // Apple only permits allowAirPlay to be set explicitly with the
        // playAndRecord category, so passing it here makes setCategory fail on
        // a physical iPhone before JUCE can create its RemoteIO device.
        if (![session setCategory:AVAudioSessionCategoryPlayback
                             mode:AVAudioSessionModeDefault
                          options:0
                            error:&error]) {
            const std::string message = describe_error(error);
            lt_debug_log(
                "[LT_IOS_AUDIO] setCategory(Playback) failed code=%ld "
                "domain=\"%s\" error=\"%s\"\n",
                static_cast<long>(error.code),
                error.domain.UTF8String != nullptr ? error.domain.UTF8String : "",
                message.c_str());
            if (error_message != nullptr) *error_message = message;
            return false;
        }

        // These are preferences, not requirements: Bluetooth/AirPlay routes
        // commonly negotiate a different rate or buffer duration. The caller
        // reads AVAudioSession.sampleRate back afterwards and configures the
        // engine with what it actually got.
        const double requested_rate =
            preferred_sample_rate > 0.0 ? preferred_sample_rate : 48000.0;
        error = nil;
        [session setPreferredSampleRate:requested_rate error:&error];
        error = nil;
        [session setPreferredIOBufferDuration:(256.0 / requested_rate) error:&error];

        error = nil;
        if (![session setActive:YES error:&error]) {
            const std::string message = describe_error(error);
            lt_debug_log(
                "[LT_IOS_AUDIO] setActive failed code=%ld domain=\"%s\" "
                "error=\"%s\"\n",
                static_cast<long>(error.code),
                error.domain.UTF8String != nullptr ? error.domain.UTF8String : "",
                message.c_str());
            if (error_message != nullptr) *error_message = message;
            return false;
        }

        // Ask for the route's full output width. iOS grants two channels unless
        // an app asks for more, so a class-compliant USB interface with four or
        // eight outputs came up stereo and the rest of it was unreachable — no
        // separate click output, which is the point of a playback rig. Only
        // meaningful once the session is ACTIVE: before that,
        // maximumOutputNumberOfChannels describes nothing.
        //
        // A preference, like the sample rate above: if the route refuses, the
        // session stays where it was and playback still works in stereo. Re-run
        // on every open — which is also every route change — because unplugging
        // the interface drops the count back to the built-in output.
        const NSInteger max_channels = session.maximumOutputNumberOfChannels;
        if (max_channels > session.outputNumberOfChannels) {
            error = nil;
            if (![session setPreferredOutputNumberOfChannels:max_channels
                                                      error:&error]) {
                lt_debug_log(
                    "[LT_IOS_AUDIO] setPreferredOutputNumberOfChannels(%ld) "
                    "refused: \"%s\" (staying at %ld)\n",
                    static_cast<long>(max_channels),
                    describe_error(error).c_str(),
                    static_cast<long>(session.outputNumberOfChannels));
            }
        }
        lt_debug_log("[LT_IOS_AUDIO] output channels granted=%ld max=%ld\n",
                     static_cast<long>(session.outputNumberOfChannels),
                     static_cast<long>(max_channels));
        return true;
    }
}

int current_ios_output_channel_count() {
    @autoreleasepool {
        const NSInteger channels =
            AVAudioSession.sharedInstance.outputNumberOfChannels;
        // An inactive session (or a route reporting nothing) reads 0. Two is the
        // floor every iOS output honours, and what the app opened before this.
        return channels > 0 ? static_cast<int>(channels) : 2;
    }
}

std::string describe_ios_playback_session() {
    @autoreleasepool {
        AVAudioSession* session = AVAudioSession.sharedInstance;
        const auto route = current_ios_output_route();
        char buffer[768]{};
        std::snprintf(
            buffer, sizeof(buffer),
            "route=\"%s\" type=\"%s\" uid=\"%s\" volume=%.3f "
            "sample_rate=%.0f io_buffer_ms=%.3f other_audio=%d secondary_silenced=%d",
            route.display_name.c_str(), route.port_type.c_str(), route.uid.c_str(),
            static_cast<double>(session.outputVolume), session.sampleRate,
            session.IOBufferDuration * 1000.0,
            session.otherAudioPlaying ? 1 : 0,
            session.secondaryAudioShouldBeSilencedHint ? 1 : 0);
        return buffer;
    }
}

IosOutputRoute current_ios_output_route() {
    @autoreleasepool {
        IosOutputRoute result;
        AVAudioSessionRouteDescription* route = AVAudioSession.sharedInstance.currentRoute;
        NSMutableArray<NSString*>* names = [NSMutableArray array];
        NSMutableArray<NSString*>* types = [NSMutableArray array];
        NSMutableArray<NSString*>* uids = [NSMutableArray array];

        for (AVAudioSessionPortDescription* port in route.outputs) {
            if (port.portName.length > 0) [names addObject:port.portName];
            if (port.portType.length > 0) [types addObject:port.portType];
            if (port.UID.length > 0) [uids addObject:port.UID];
            for (AVAudioSessionChannelDescription* channel in port.channels) {
                NSString* channel_name = channel.channelName;
                if (channel_name.length == 0) {
                    channel_name = [NSString stringWithFormat:@"Output %lu",
                        static_cast<unsigned long>(channel.channelNumber)];
                }
                result.channel_names.emplace_back(channel_name.UTF8String);
            }
        }

        NSString* joined_names = [names componentsJoinedByString:@" + "];
        NSString* joined_types = [types componentsJoinedByString:@"+"];
        NSString* joined_uids = [uids componentsJoinedByString:@"+"];
        result.display_name = joined_names.length > 0
            ? std::string(joined_names.UTF8String) : "iOS system output";
        result.port_type = joined_types.length > 0
            ? std::string(joined_types.UTF8String) : "iOS";
        result.uid = joined_uids.length > 0
            ? std::string(joined_uids.UTF8String) : "system-route";
        return result;
    }
}

} // namespace lt
