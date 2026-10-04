// src/services/videoLayerFrameDiagnostics.ts
// Observe compositor callbacks and main-thread stalls without React updates or per-frame logging.

type FrameDiagnosticPorts = {
    now: () => number;
    report: (event: string, detail?: Record<string, unknown>) => void;
    isPlaying: () => boolean;
};

/** Correlate missing video frames with callback delay, decode timing, and long main-thread tasks. */
export const createVideoLayerFrameDiagnostics = (video: HTMLVideoElement, ports: FrameDiagnosticPorts) => {
    let disposed = false;
    let callbackId: number | null = null;
    let lastFrameAt = ports.now();
    let lastFrameGapMs = 0;
    let expectedGapMs = 40;
    let presentedFrames = 0;
    let decodeMs: number | null = null;
    let missingFrames = false;
    let observer: PerformanceObserver | null = null;

    const reset = () => { lastFrameAt = ports.now(); missingFrames = false; };
    const visible = () => typeof document === 'undefined' || document.visibilityState === 'visible';
    const onFrame: VideoFrameRequestCallback = (now, metadata) => {
        if (disposed) return;
        lastFrameGapMs = Math.max(0, now - lastFrameAt);
        decodeMs = metadata.processingDuration === undefined ? null : metadata.processingDuration * 1000;
        const skippedCallbacks = presentedFrames === 0 ? 0 : Math.max(0, metadata.presentedFrames - presentedFrames - 1);
        const gapLimit = Math.max(150, expectedGapMs * 3.5);
        if (ports.isPlaying() && !video.paused && visible() && lastFrameGapMs > gapLimit) {
            ports.report('frame-gap', {
                frameGapMs: lastFrameGapMs, expectedGapMs, skippedCallbacks, decodeMs,
                callbackDelayMs: now - metadata.expectedDisplayTime, mediaTimeSec: metadata.mediaTime,
            });
        } else if (lastFrameGapMs > 0 && lastFrameGapMs < gapLimit) {
            expectedGapMs += (lastFrameGapMs - expectedGapMs) * 0.05;
        }
        if (missingFrames) ports.report('frames-resumed', { frameGapMs: lastFrameGapMs });
        missingFrames = false;
        lastFrameAt = now;
        presentedFrames = metadata.presentedFrames;
        callbackId = video.requestVideoFrameCallback(onFrame);
    };
    if (typeof video.requestVideoFrameCallback === 'function') callbackId = video.requestVideoFrameCallback(onFrame);
    video.addEventListener('play', reset);

    if (typeof PerformanceObserver !== 'undefined' && PerformanceObserver.supportedEntryTypes?.includes('longtask')) {
        observer = new PerformanceObserver(list => {
            if (disposed || !ports.isPlaying() || !visible()) return;
            for (const entry of list.getEntries()) {
                if (entry.duration >= 100) ports.report('main-thread-longtask', {
                    taskStartMs: entry.startTime, taskDurationMs: entry.duration, taskName: entry.name,
                });
            }
        });
        observer.observe({ type: 'longtask' });
    }

    return {
        snapshot: () => ({
            frameCallbacksSupported: typeof video.requestVideoFrameCallback === 'function',
            longTasksSupported: observer !== null,
            frameAgeMs: Math.max(0, ports.now() - lastFrameAt), lastFrameGapMs, presentedFrames, decodeMs,
        }),
        tick: () => {
            if (disposed || callbackId === null || !ports.isPlaying() || video.paused || !visible()) return;
            const age = ports.now() - lastFrameAt;
            if (!missingFrames && age > Math.max(500, expectedGapMs * 6)) {
                missingFrames = true;
                ports.report('no-video-frames', { frameAgeMs: age });
            }
        },
        dispose: () => {
            disposed = true;
            if (callbackId !== null) video.cancelVideoFrameCallback(callbackId);
            observer?.disconnect();
            video.removeEventListener('play', reset);
        },
    };
};
