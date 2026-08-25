#include <lt_engine/devices/ios_audio_session.h>

#import <AVFoundation/AVFoundation.h>

namespace lt {

namespace {

std::string describe_error(NSError* error) {
    if (error == nil) return "unknown AVAudioSession error";
    NSString* description = error.localizedDescription;
    return description != nil ? std::string(description.UTF8String)
                              : "AVAudioSession returned an error";
}

} // namespace

bool configure_ios_playback_session(std::string* error_message) {
    @autoreleasepool {
        AVAudioSession* session = AVAudioSession.sharedInstance;
        NSError* error = nil;
        const AVAudioSessionCategoryOptions options =
            AVAudioSessionCategoryOptionAllowBluetoothA2DP |
            AVAudioSessionCategoryOptionAllowAirPlay;

        if (![session setCategory:AVAudioSessionCategoryPlayback
                             mode:AVAudioSessionModeDefault
                          options:options
                            error:&error]) {
            if (error_message != nullptr) *error_message = describe_error(error);
            return false;
        }

        // These are preferences, not requirements: Bluetooth/AirPlay routes
        // commonly negotiate a different rate or buffer duration.
        error = nil;
        [session setPreferredSampleRate:48000.0 error:&error];
        error = nil;
        [session setPreferredIOBufferDuration:(256.0 / 48000.0) error:&error];

        error = nil;
        if (![session setActive:YES error:&error]) {
            if (error_message != nullptr) *error_message = describe_error(error);
            return false;
        }
        return true;
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
