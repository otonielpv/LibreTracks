// ---------------------------------------------------------------------------
// Does an iOS Simulator running on a CI machine actually deliver RemoteIO
// audio callbacks?
//
// Everything about LibreTracks' iOS audio path is unverified until someone
// plays sound on an iPhone, and the phone is the one thing CI does not have.
// The Simulator is the closest stand-in, but a GitHub runner is a VM with no
// sound card, and CoreAudio on a machine with no output device may refuse to
// start the unit — in which case a "the audio works" test built on top of it
// would be measuring nothing.
//
// So this probe answers that one question first, with the same setup
// audio_device_manager_ios.mm uses in production (Playback category,
// non-interleaved float32, RemoteIO), and nothing else. Build it for the
// simulator SDK and run it inside a booted simulator:
//
//   xcrun -sdk iphonesimulator clang -arch arm64 \
//     -mios-simulator-version-min=15.0 -fobjc-arc \
//     -framework AVFoundation -framework AudioToolbox -framework Foundation \
//     tests/ios/remoteio_probe.m -o /tmp/remoteio_probe
//   xcrun simctl spawn booted /tmp/remoteio_probe
//
// Exit code 0 means the callbacks ran and carried the signal this program
// wrote. Anything else prints why.
// ---------------------------------------------------------------------------

#import <AVFoundation/AVFoundation.h>
#import <AudioToolbox/AudioToolbox.h>

#include <math.h>
#include <stdio.h>

// Single writer (the audio thread) and a single reader that only looks after
// the unit has been stopped, so plain volatiles are enough here.
static volatile int   g_callbacks = 0;
static volatile int   g_frames = 0;
static volatile float g_peak = 0.0f;
static volatile int   g_buffers_seen = 0;
static double         g_phase = 0.0;
static double         g_sample_rate = 48000.0;

static OSStatus probe_render(void*                       ref_con,
                             AudioUnitRenderActionFlags* flags,
                             const AudioTimeStamp*       timestamp,
                             UInt32                      bus,
                             UInt32                      num_frames,
                             AudioBufferList*            io_data) {
    (void)ref_con; (void)flags; (void)timestamp; (void)bus;
    if (io_data == NULL) return noErr;

    const double increment = 2.0 * M_PI * 440.0 / g_sample_rate;
    float peak = 0.0f;
    for (UInt32 frame = 0; frame < num_frames; ++frame) {
        const float sample = (float)(0.25 * sin(g_phase));
        g_phase += increment;
        if (g_phase > 2.0 * M_PI) g_phase -= 2.0 * M_PI;
        if (sample > peak) peak = sample;
        for (UInt32 buffer = 0; buffer < io_data->mNumberBuffers; ++buffer) {
            float* out = (float*)io_data->mBuffers[buffer].mData;
            if (out != NULL) out[frame] = sample;
        }
    }

    g_buffers_seen = (int)io_data->mNumberBuffers;
    if (peak > g_peak) g_peak = peak;
    g_frames += (int)num_frames;
    g_callbacks += 1;
    return noErr;
}

int main(void) {
    @autoreleasepool {
        AVAudioSession* session = AVAudioSession.sharedInstance;
        NSError* error = nil;

        if (![session setCategory:AVAudioSessionCategoryPlayback
                             mode:AVAudioSessionModeDefault
                          options:0
                            error:&error]) {
            printf("PROBE_RESULT=session-category-failed error=\"%s\"\n",
                   error.localizedDescription.UTF8String);
            return 2;
        }
        [session setPreferredSampleRate:48000.0 error:NULL];
        [session setPreferredIOBufferDuration:(256.0 / 48000.0) error:NULL];

        error = nil;
        if (![session setActive:YES error:&error]) {
            printf("PROBE_RESULT=session-activate-failed error=\"%s\"\n",
                   error.localizedDescription.UTF8String);
            return 3;
        }

        g_sample_rate = session.sampleRate > 0 ? session.sampleRate : 48000.0;
        const int channels = session.outputNumberOfChannels > 0
            ? (int)session.outputNumberOfChannels : 2;

        NSMutableArray<NSString*>* ports = [NSMutableArray array];
        for (AVAudioSessionPortDescription* port in session.currentRoute.outputs)
            [ports addObject:[NSString stringWithFormat:@"%@ (%@)",
                              port.portName, port.portType]];
        printf("route=\"%s\" sample_rate=%.0f channels=%d io_buffer_ms=%.2f\n",
               ports.count > 0
                   ? [ports componentsJoinedByString:@" + "].UTF8String
                   : "<no output ports>",
               g_sample_rate, channels, session.IOBufferDuration * 1000.0);

        AudioComponentDescription description = {0};
        description.componentType = kAudioUnitType_Output;
        description.componentSubType = kAudioUnitSubType_RemoteIO;
        description.componentManufacturer = kAudioUnitManufacturer_Apple;

        AudioComponent component = AudioComponentFindNext(NULL, &description);
        if (component == NULL) {
            printf("PROBE_RESULT=no-remoteio-component\n");
            return 4;
        }

        AudioUnit unit = NULL;
        OSStatus status = AudioComponentInstanceNew(component, &unit);
        if (status != noErr || unit == NULL) {
            printf("PROBE_RESULT=instance-new-failed status=%d\n", (int)status);
            return 5;
        }

        UInt32 enable_output = 1;
        status = AudioUnitSetProperty(unit, kAudioOutputUnitProperty_EnableIO,
                                      kAudioUnitScope_Output, 0,
                                      &enable_output, sizeof(enable_output));
        if (status != noErr) {
            printf("PROBE_RESULT=enable-io-failed status=%d\n", (int)status);
            return 6;
        }

        // The same client format the engine asks for: one buffer per channel.
        AudioStreamBasicDescription format = {0};
        format.mSampleRate       = g_sample_rate;
        format.mFormatID         = kAudioFormatLinearPCM;
        format.mFormatFlags      = kAudioFormatFlagIsFloat
                                 | kAudioFormatFlagIsPacked
                                 | kAudioFormatFlagIsNonInterleaved;
        format.mFramesPerPacket  = 1;
        format.mChannelsPerFrame = (UInt32)channels;
        format.mBitsPerChannel   = 32;
        format.mBytesPerFrame    = sizeof(float);
        format.mBytesPerPacket   = sizeof(float);
        status = AudioUnitSetProperty(unit, kAudioUnitProperty_StreamFormat,
                                      kAudioUnitScope_Input, 0,
                                      &format, sizeof(format));
        if (status != noErr) {
            printf("PROBE_RESULT=set-format-failed status=%d\n", (int)status);
            return 7;
        }

        AURenderCallbackStruct render_callback = {0};
        render_callback.inputProc = &probe_render;
        render_callback.inputProcRefCon = NULL;
        status = AudioUnitSetProperty(unit, kAudioUnitProperty_SetRenderCallback,
                                      kAudioUnitScope_Input, 0,
                                      &render_callback, sizeof(render_callback));
        if (status != noErr) {
            printf("PROBE_RESULT=set-callback-failed status=%d\n", (int)status);
            return 8;
        }

        status = AudioUnitInitialize(unit);
        if (status != noErr) {
            printf("PROBE_RESULT=initialize-failed status=%d\n", (int)status);
            return 9;
        }

        status = AudioOutputUnitStart(unit);
        if (status != noErr) {
            printf("PROBE_RESULT=start-failed status=%d\n", (int)status);
            return 10;
        }

        [NSThread sleepForTimeInterval:1.5];

        AudioOutputUnitStop(unit);
        AudioUnitUninitialize(unit);
        AudioComponentInstanceDispose(unit);

        const int callbacks = g_callbacks;
        const int frames = g_frames;
        const float peak = g_peak;
        const int buffers = g_buffers_seen;
        const double expected_frames = g_sample_rate * 1.5;
        const double coverage = expected_frames > 0
            ? (double)frames / expected_frames : 0.0;

        printf("callbacks=%d frames=%d buffers_per_callback=%d peak=%.4f "
               "coverage=%.2f\n",
               callbacks, frames, buffers, (double)peak, coverage);

        if (callbacks == 0) {
            printf("PROBE_RESULT=no-callbacks\n");
            return 11;
        }
        if (buffers < channels) {
            printf("PROBE_RESULT=fewer-buffers-than-channels\n");
            return 12;
        }
        // Under a third of real time means the callbacks are running but the
        // clock is not: a "dry" device that drains nothing.
        if (coverage < 0.33) {
            printf("PROBE_RESULT=callbacks-not-realtime\n");
            return 13;
        }
        printf("PROBE_RESULT=ok\n");
        return 0;
    }
}
