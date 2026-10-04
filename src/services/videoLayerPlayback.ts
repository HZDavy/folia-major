// src/services/videoLayerPlayback.ts
// Keep continuous video playback outside React. Ordinary drift changes the rate, not the read-head.

export const VIDEO_LAYER_SYNC_INTERVAL_MS = 500;
const SOFT_TOLERANCE_SEC = 0.08;
const HARD_DRIFT_SEC = 2;
const CLOCK_JUMP_TOLERANCE_SEC = 0.5;
const CLOCK_STALE_MS = 1500;

type VideoLayerPlaybackPorts = {
    getTime: () => number;
    getRate: () => number;
    isPlaying: () => boolean;
    now: () => number;
    report?: (event: string, detail?: Record<string, unknown>) => void;
};

/** Owns alignment, gradual drift correction, and recovery from a stopped playback clock. */
export const createVideoLayerPlayback = (video: HTMLVideoElement, ports: VideoLayerPlaybackPorts) => {
    let lastTime = ports.getTime();
    let lastSampleAt = ports.now();
    let lastMovementAt = lastSampleAt;
    let lastRate = ports.getRate();
    let wasPlaying = false;
    let clockStalled = false;
    let pendingAlignment: string | null = 'initial';
    let playPending = false;
    let disposed = false;

    const baseRate = () => {
        const rate = ports.getRate();
        return Number.isFinite(rate) && rate > 0 ? rate : 1;
    };
    const setRate = (rate: number, reason = 'drift-correction') => {
        if (Math.abs(video.playbackRate - rate) > 0.001) {
            ports.report?.('rate-adjustment', { fromRate: video.playbackRate, toRate: rate, reason });
            video.playbackRate = rate;
        }
    };
    const play = () => {
        if (disposed || !video.paused || playPending) return;
        playPending = true;
        ports.report?.('play-request');
        void video.play().catch(error => {
            ports.report?.('play-rejected', { errorName: error?.name, errorMessage: error?.message });
        }).finally(() => { playPending = false; });
    };

    // Measure phase on a ring: 9.9s and 0.1s in a 10s loop are only 0.2s apart.
    const align = () => {
        const time = ports.getTime();
        const duration = video.duration;
        if (disposed || !Number.isFinite(time) || !Number.isFinite(duration) || duration <= 0 || video.seeking) return;
        const target = Math.max(0, time) % duration;
        const error = ((target - video.currentTime + duration * 1.5) % duration) - duration / 2;
        const hardAlign = pendingAlignment || Math.abs(error) > HARD_DRIFT_SEC;
        if (hardAlign && Math.abs(error) > SOFT_TOLERANCE_SEC) {
            ports.report?.('script-seek', { reason: pendingAlignment ?? 'severe-drift', fromSec: video.currentTime, toSec: target, errorSec: error });
            video.currentTime = target;
        }
        pendingAlignment = null;
        const correction = hardAlign || Math.abs(error) <= SOFT_TOLERANCE_SEC
            ? 0
            : Math.max(-0.08, Math.min(0.08, error * 0.2));
        setRate(Math.max(0.0625, Math.min(16, baseRate() + correction)));
    };

    const followState = () => {
        if (disposed) return;
        const playing = ports.isPlaying();
        if (playing !== wasPlaying) {
            lastTime = ports.getTime();
            lastSampleAt = lastMovementAt = ports.now();
            lastRate = baseRate();
            clockStalled = false;
            // A seek already started by the music clock must finish once. Queuing another resume
            // seek here makes a slow 4K decoder restart again just after the first frame arrives.
            if (playing && !video.seeking) pendingAlignment = 'playback-state-change';
            ports.report?.('playback-state-change', { playing });
        }
        wasPlaying = playing;
        if (playing) {
            align();
            play();
        } else {
            if (!video.paused) video.pause();
            setRate(baseRate(), 'playback-paused');
        }
    };

    // Subtract elapsed playback before classifying a jump; a delayed RAF is not a seek.
    const onClockChange = (time: number) => {
        if (disposed || !Number.isFinite(time) || time === lastTime) return;
        const now = ports.now();
        const elapsed = Math.max(0, now - lastSampleAt) / 1000;
        const delta = time - lastTime;
        const expectedDelta = elapsed * lastRate;
        const jumped = delta < -SOFT_TOLERANCE_SEC
            || Math.abs(delta - expectedDelta) > CLOCK_JUMP_TOLERANCE_SEC
            || (!ports.isPlaying() && Math.abs(delta) > SOFT_TOLERANCE_SEC);
        lastTime = time;
        lastSampleAt = lastMovementAt = now;
        lastRate = baseRate();
        if (jumped || clockStalled) {
            ports.report?.(clockStalled ? 'clock-resumed' : 'clock-jump', { deltaSec: delta, elapsedSec: elapsed, expectedDeltaSec: expectedDelta });
            pendingAlignment = clockStalled ? 'clock-resumed' : 'clock-jump';
            align();
            clockStalled = false;
            if (ports.isPlaying()) play();
        }
    };

    const tick = () => {
        if (disposed || !ports.isPlaying()) return;
        if (ports.now() - lastMovementAt > CLOCK_STALE_MS) {
            if (!clockStalled) ports.report?.('clock-stalled', { clockAgeMs: ports.now() - lastMovementAt });
            clockStalled = true;
            if (!video.paused) video.pause();
            setRate(baseRate(), 'clock-stalled');
            return;
        }
        // Buffering and an in-flight seek should finish before another correction is attempted.
        if (video.readyState < 2 || video.seeking) return;
        align();
        play();
    };

    const onMetadata = () => {
        pendingAlignment = 'loadedmetadata';
        align();
        followState();
    };
    video.addEventListener('loadedmetadata', onMetadata);
    if (video.readyState >= 1) onMetadata();

    return {
        followState,
        onClockChange,
        tick,
        onRateChange: () => {
            if (disposed) return;
            lastRate = baseRate();
            setRate(lastRate, 'music-rate-change');
        },
        dispose: () => {
            disposed = true;
            video.removeEventListener('loadedmetadata', onMetadata);
            video.pause();
        },
    };
};
