import { createVideoLayerFrameDiagnostics } from './videoLayerFrameDiagnostics';

// src/services/videoLayerDiagnostics.ts
// Default-on, bounded console diagnostics for intermittent video stalls; reuse the app's log capture.

type VideoLayerDiagnosticPorts = {
    source: string | null;
    getTime: () => number;
    getRate: () => number;
    isPlaying: () => boolean;
    isShellPaused: () => boolean;
    now: () => number;
};

const MEDIA_EVENTS = ['loadstart', 'loadedmetadata', 'loadeddata', 'canplay', 'playing', 'pause', 'waiting', 'stalled', 'seeking', 'seeked', 'ratechange', 'ended', 'error', 'emptied'] as const;
const WARN_EVENTS = new Set(['waiting', 'stalled', 'error', 'play-rejected', 'clock-stalled', 'clock-jump', 'frame-gap', 'no-video-frames', 'main-thread-longtask', 'timer-gap']);
let nextSession = 0;

/** Record media events and sparse snapshots, with a distinct session id for each source mount. */
export const createVideoLayerDiagnostics = (video: HTMLVideoElement, ports: VideoLayerDiagnosticPorts) => {
    const session = ++nextSession;
    const lastReports = new Map<string, number>();
    const eventCounts = new Map<string, number>();
    const lastReportedCounts = new Map<string, number>();
    let disposed = false;
    let lastTickAt = ports.now();
    let lastSummaryAt = lastTickAt;
    let lastClockAt = lastTickAt;
    let lastClock = ports.getTime();
    let lastQuality = { total: 0, dropped: 0 };
    let lastRateAdjustment: Record<string, unknown> | null = null;
    let lastScriptSeek: Record<string, unknown> | null = null;
    let waitingSince: number | null = null;
    let frames: ReturnType<typeof createVideoLayerFrameDiagnostics> | null = null;

    const snapshot = () => {
        const musicTime = ports.getTime();
        const duration = video.duration;
        const target = Number.isFinite(duration) && duration > 0 ? Math.max(0, musicTime) % duration : null;
        const ranges = Array.from({ length: Math.min(video.buffered.length, 4) }, (_, index) => (
            [video.buffered.start(index), video.buffered.end(index)]
        ));
        let bufferAheadSec = 0;
        for (let index = 0; index < video.buffered.length; index += 1) {
            if (video.currentTime >= video.buffered.start(index) && video.currentTime <= video.buffered.end(index)) {
                bufferAheadSec = video.buffered.end(index) - video.currentTime;
                break;
            }
        }
        const quality = video.getVideoPlaybackQuality?.();
        return {
            atMs: ports.now(), session, musicTimeSec: musicTime, musicRate: ports.getRate(),
            intendedPlaying: ports.isPlaying(), shellPaused: ports.isShellPaused(),
            videoTimeSec: video.currentTime, videoDurationSec: Number.isFinite(duration) ? duration : null,
            phaseErrorSec: target === null ? null : ((target - video.currentTime + duration * 1.5) % duration) - duration / 2,
            videoRate: video.playbackRate, paused: video.paused, seeking: video.seeking, ended: video.ended,
            readyState: video.readyState, networkState: video.networkState, bufferedRangesSec: ranges, bufferAheadSec,
            videoSize: [video.videoWidth, video.videoHeight],
            totalFrames: quality?.totalVideoFrames, droppedFrames: quality?.droppedVideoFrames,
            clockAgeMs: ports.now() - lastClockAt,
            scriptSeekCount: eventCounts.get('script-seek') ?? 0,
            rateAdjustmentCount: eventCounts.get('rate-adjustment') ?? 0, lastRateAdjustment, lastScriptSeek,
            waitingAgeMs: waitingSince === null ? null : ports.now() - waitingSince,
            visibility: typeof document === 'undefined' ? 'unknown' : document.visibilityState,
            mediaError: video.error ? { code: video.error.code, message: video.error.message } : null,
            ...frames?.snapshot(),
        };
    };

    // Throttle repeated warnings; logging must never throw into playback or print a live DOM object.
    const report = (event: string, detail: Record<string, unknown> = {}) => {
        if (disposed) return;
        const now = ports.now();
        const eventCount = (eventCounts.get(event) ?? 0) + 1;
        eventCounts.set(event, eventCount);
        if (event === 'rate-adjustment') lastRateAdjustment = { atMs: now, ...detail };
        if (event === 'script-seek') lastScriptSeek = { atMs: now, ...detail };
        if (now - (lastReports.get(event) ?? -Infinity) < 1000) return;
        lastReports.set(event, now);
        try {
            const suppressedSincePrevious = eventCount - (lastReportedCounts.get(event) ?? 0) - 1;
            lastReportedCounts.set(event, eventCount);
            const payload = { ...snapshot(), eventCount, suppressedSincePrevious, ...detail };
            // A single string preserves all fields when copying DevTools output instead of `…`.
            const line = `[VideoLayer] ${event} ${JSON.stringify(payload)}`;
            if (WARN_EVENTS.has(event)) console.warn(line);
            else console.info(line);
        } catch { /* Diagnostics must not interrupt the media controller. */ }
    };
    frames = createVideoLayerFrameDiagnostics(video, { now: ports.now, isPlaying: ports.isPlaying, report });
    const listeners = MEDIA_EVENTS.map(event => {
        const listener = () => {
            if (event === 'waiting' && waitingSince === null) waitingSince = ports.now();
            report(event);
            if ((event === 'canplay' || event === 'playing') && waitingSince !== null) {
                const waitMs = ports.now() - waitingSince;
                waitingSince = null;
                report('buffer-recovered', { waitMs });
            }
        };
        video.addEventListener(event, listener);
        return { event, listener };
    });
    const onVisibility = () => report('visibility-change');
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);
    // Omit URL queries (often signed tokens); a source type and media metadata suffice for correlation.
    const sourceType = ports.source?.startsWith('blob:') ? 'local-file'
        : ports.source?.match(/^([a-z][a-z\d+.-]*):/i)?.[1] ?? 'relative-url';
    report('mounted', { sourceType });

    return {
        report,
        onClockChange: (time: number) => {
            if (time !== lastClock) { lastClock = time; lastClockAt = ports.now(); }
        },
        tick: () => {
            if (disposed) return;
            const now = ports.now();
            const gap = now - lastTickAt;
            lastTickAt = now;
            if (ports.isPlaying() && gap > 1000) report('timer-gap', { timerGapMs: gap, timerDelayMs: gap - 500 });
            frames?.tick();
            if (ports.isPlaying() && now - lastSummaryAt >= 5000) {
                lastSummaryAt = now;
                const quality = video.getVideoPlaybackQuality?.();
                const total = quality?.totalVideoFrames ?? 0;
                const dropped = quality?.droppedVideoFrames ?? 0;
                report('summary', { framesSinceSummary: total - lastQuality.total, droppedSinceSummary: dropped - lastQuality.dropped });
                lastQuality = { total, dropped };
            }
        },
        dispose: () => {
            report('unmounted');
            disposed = true;
            frames?.dispose();
            for (const { event, listener } of listeners) video.removeEventListener(event, listener);
            if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
        },
    };
};
