//! Live audio output sink.
//!
//! On macOS this drives a CoreAudio `AudioQueue` output (interleaved f32
//! stereo); the queue's render thread pulls PCM blocks from a caller-supplied
//! fill closure. Other native targets get a no-op sink so the shared audio
//! runtime still builds. The deterministic verification path is the WAV render
//! in `app::audio::wav` (same mixer blocks); audible device output is confirmed
//! interactively.

#![allow(non_snake_case, non_upper_case_globals)]

use std::os::raw::c_void;

/// A boxed fill callback: writes `out.len()` interleaved-stereo f32 samples.
pub type FillFn = Box<dyn FnMut(&mut [f32]) + Send>;

#[cfg(target_os = "macos")]
mod coreaudio {
    use super::*;

    pub type AudioQueueRef = *mut c_void;
    pub type AudioQueueBufferRef = *mut AudioQueueBuffer;

    #[repr(C)]
    pub struct AudioStreamBasicDescription {
        pub mSampleRate: f64,
        pub mFormatID: u32,
        pub mFormatFlags: u32,
        pub mBytesPerPacket: u32,
        pub mFramesPerPacket: u32,
        pub mBytesPerFrame: u32,
        pub mChannelsPerFrame: u32,
        pub mBitsPerChannel: u32,
        pub mReserved: u32,
    }

    #[repr(C)]
    pub struct AudioQueueBuffer {
        pub mAudioDataBytesCapacity: u32,
        pub mAudioData: *mut c_void,
        pub mAudioDataByteSize: u32,
        pub mUserData: *mut c_void,
        pub mPacketDescriptionCapacity: u32,
        pub mPacketDescriptions: *mut c_void,
        pub mPacketDescriptionCount: u32,
    }

    // 'lpcm'
    pub const K_AUDIO_FORMAT_LINEAR_PCM: u32 = 0x6c70_636d;
    pub const K_LINEAR_PCM_FLAG_IS_FLOAT: u32 = 1 << 0;
    pub const K_LINEAR_PCM_FLAG_IS_PACKED: u32 = 1 << 3;

    #[link(name = "AudioToolbox", kind = "framework")]
    extern "C" {
        pub fn AudioQueueNewOutput(
            inFormat: *const AudioStreamBasicDescription,
            inCallbackProc: extern "C" fn(*mut c_void, AudioQueueRef, AudioQueueBufferRef),
            inUserData: *mut c_void,
            inCallbackRunLoop: *mut c_void,
            inCallbackRunLoopMode: *const c_void,
            inFlags: u32,
            outAQ: *mut AudioQueueRef,
        ) -> i32;
        pub fn AudioQueueAllocateBuffer(
            inAQ: AudioQueueRef,
            inBufferByteSize: u32,
            outBuffer: *mut AudioQueueBufferRef,
        ) -> i32;
        pub fn AudioQueueEnqueueBuffer(
            inAQ: AudioQueueRef,
            inBuffer: AudioQueueBufferRef,
            inNumPacketDescs: u32,
            inPacketDescs: *const c_void,
        ) -> i32;
        pub fn AudioQueueStart(inAQ: AudioQueueRef, inStartTime: *const c_void) -> i32;
        pub fn AudioQueueStop(inAQ: AudioQueueRef, inImmediate: u8) -> i32;
        pub fn AudioQueueDispose(inAQ: AudioQueueRef, inImmediate: u8) -> i32;
    }
}

/// State handed to the CoreAudio render callback (kept alive by `AudioOutput`).
struct FillState {
    fill: FillFn,
    scratch: Vec<f32>,
}

#[cfg(target_os = "macos")]
extern "C" fn render_cb(
    user: *mut c_void,
    queue: coreaudio::AudioQueueRef,
    buf: coreaudio::AudioQueueBufferRef,
) {
    use coreaudio::*;
    unsafe {
        let state = &mut *(user as *mut FillState);
        let cap = (*buf).mAudioDataBytesCapacity as usize;
        let floats = cap / 4;
        if state.scratch.len() < floats {
            state.scratch.resize(floats, 0.0);
        }
        let slice = &mut state.scratch[..floats];
        (state.fill)(slice);
        core::ptr::copy_nonoverlapping(
            slice.as_ptr() as *const u8,
            (*buf).mAudioData as *mut u8,
            floats * 4,
        );
        (*buf).mAudioDataByteSize = (floats * 4) as u32;
        AudioQueueEnqueueBuffer(queue, buf, 0, core::ptr::null());
    }
}

/// A live output device sink. Dropping it stops + disposes the queue.
pub struct AudioOutput {
    #[cfg(target_os = "macos")]
    queue: coreaudio::AudioQueueRef,
    // Boxed so its address is stable for the C callback userdata.
    _state: Box<FillState>,
    started: bool,
}

impl AudioOutput {
    /// Open a stereo f32 output at `sample_rate` and start pulling `fill`.
    /// Returns `None` if the OS has no output device / the queue fails.
    pub fn start(sample_rate: u32, fill: FillFn) -> Option<Self> {
        let mut state = Box::new(FillState {
            fill,
            scratch: Vec::new(),
        });
        #[cfg(target_os = "macos")]
        {
            use coreaudio::*;
            let fmt = AudioStreamBasicDescription {
                mSampleRate: sample_rate as f64,
                mFormatID: K_AUDIO_FORMAT_LINEAR_PCM,
                mFormatFlags: K_LINEAR_PCM_FLAG_IS_FLOAT | K_LINEAR_PCM_FLAG_IS_PACKED,
                mBytesPerPacket: 8,
                mFramesPerPacket: 1,
                mBytesPerFrame: 8, // 2 ch * f32
                mChannelsPerFrame: 2,
                mBitsPerChannel: 32,
                mReserved: 0,
            };
            let mut queue: AudioQueueRef = core::ptr::null_mut();
            let user = &mut *state as *mut FillState as *mut c_void;
            let rc = unsafe {
                AudioQueueNewOutput(
                    &fmt,
                    render_cb,
                    user,
                    core::ptr::null_mut(),
                    core::ptr::null(),
                    0,
                    &mut queue,
                )
            };
            if rc != 0 || queue.is_null() {
                return None;
            }
            // Three ~1024-frame buffers, primed and enqueued.
            let bytes = 1024u32 * 8;
            for _ in 0..3 {
                let mut buf: AudioQueueBufferRef = core::ptr::null_mut();
                if unsafe { AudioQueueAllocateBuffer(queue, bytes, &mut buf) } != 0 {
                    unsafe { AudioQueueDispose(queue, 1) };
                    return None;
                }
                render_cb(user, queue, buf);
            }
            if unsafe { AudioQueueStart(queue, core::ptr::null()) } != 0 {
                unsafe { AudioQueueDispose(queue, 1) };
                return None;
            }
            Some(Self {
                queue,
                _state: state,
                started: true,
            })
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = sample_rate;
            // No device backend for this target; a headless no-op sink.
            Some(Self {
                _state: state,
                started: false,
            })
        }
    }

    pub fn is_active(&self) -> bool {
        self.started
    }
}

impl Drop for AudioOutput {
    fn drop(&mut self) {
        #[cfg(target_os = "macos")]
        unsafe {
            if !self.queue.is_null() {
                coreaudio::AudioQueueStop(self.queue, 1);
                coreaudio::AudioQueueDispose(self.queue, 1);
            }
        }
    }
}
