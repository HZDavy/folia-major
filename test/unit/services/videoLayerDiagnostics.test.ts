import { afterEach, describe, expect, it, vi } from 'vitest';
import { createVideoLayerDiagnostics } from '@/services/videoLayerDiagnostics';
import { createVideoLayerFrameDiagnostics } from '@/services/videoLayerFrameDiagnostics';

// test/unit/services/videoLayerDiagnostics.test.ts
// Verify diagnostic evidence, throttling, and teardown independently of browser timing.

/** Provide manually delivered media/frame events and a monotonic clock. */
const setup = () => {
    let now = 0;
    let clock = 1;
    let frameId = 0;
    const events = new Map<string, Set<() => void>>();
    const callbacks = new Map<number, VideoFrameRequestCallback>();
    const video = {
        currentTime: 1, duration: 10, playbackRate: 1, paused: false, seeking: false, ended: false,
        readyState: 4, networkState: 1, videoWidth: 160, videoHeight: 90, error: null,
        buffered: { length: 1, start: () => 0, end: () => 10 },
        getVideoPlaybackQuality: () => ({ totalVideoFrames: 24, droppedVideoFrames: 2 }),
        requestVideoFrameCallback: vi.fn((callback: VideoFrameRequestCallback) => {
            callbacks.set(++frameId, callback); return frameId;
        }),
        cancelVideoFrameCallback: vi.fn((id: number) => { callbacks.delete(id); }),
        addEventListener: (event: string, callback: () => void) => {
            if (!events.has(event)) events.set(event, new Set());
            events.get(event)!.add(callback);
        },
        removeEventListener: (event: string, callback: () => void) => { events.get(event)?.delete(callback); },
    };
    const ports = {
        now: () => now, getTime: () => clock, getRate: () => 1, isPlaying: () => true,
        isShellPaused: () => false, source: 'https://video.test/movie.webm?token=secret', report: vi.fn(),
    };
    return {
        video, ports, events, callbacks, media: video as unknown as HTMLVideoElement,
        advance: (ms: number) => { now += ms; },
        setClock: (value: number) => { clock = value; },
        event: (event: string) => { events.get(event)?.forEach(callback => callback()); },
        frame: (frames: number, decode = 0.01) => {
            const id = Math.max(...callbacks.keys());
            const callback = callbacks.get(id)!;
            callbacks.delete(id);
            callback(now, { presentedFrames: frames, processingDuration: decode, mediaTime: clock,
                expectedDisplayTime: now - 200 } as VideoFrameCallbackMetadata);
        },
    };
};

const payload = (line: unknown) => JSON.parse(String(line).slice(String(line).indexOf('{'))) as Record<string, unknown>;

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('video layer diagnostics', () => {
    it('logs immutable media snapshots without exposing source query tokens', () => {
        const info = vi.spyOn(console, 'info').mockImplementation(() => {});
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const probe = setup();
        const diagnostics = createVideoLayerDiagnostics(probe.media, probe.ports);
        probe.event('waiting');
        const captured = payload(warn.mock.calls[0][0]);
        probe.video.currentTime = 9;
        expect(captured).toMatchObject({ videoTimeSec: 1, readyState: 4, bufferedRangesSec: [[0, 10]], videoSize: [160, 90], bufferAheadSec: 9 });
        expect(warn.mock.calls[0]).toHaveLength(1);
        expect(JSON.stringify(info.mock.calls)).not.toContain('secret');
        diagnostics.dispose();
        expect(probe.callbacks.size).toBe(0);
        expect([...probe.events.values()].every(list => list.size === 0)).toBe(true);
    });

    it('throttles warnings but preserves the total number of script seeks', () => {
        vi.spyOn(console, 'info').mockImplementation(() => {});
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const probe = setup();
        const diagnostics = createVideoLayerDiagnostics(probe.media, probe.ports);
        diagnostics.report('script-seek');
        diagnostics.report('script-seek');
        diagnostics.report('script-seek');
        diagnostics.report('clock-stalled');
        expect(payload(warn.mock.calls[0][0])).toMatchObject({ scriptSeekCount: 3 });
        diagnostics.report('clock-stalled');
        probe.advance(1000);
        diagnostics.report('clock-stalled');
        expect(warn).toHaveBeenCalledTimes(2);
        expect(payload(warn.mock.calls[1][0])).toMatchObject({ eventCount: 3, suppressedSincePrevious: 1 });
        diagnostics.dispose();
    });

    it('reports delayed timers, clock age and a sparse frame/drop summary', () => {
        const info = vi.spyOn(console, 'info').mockImplementation(() => {});
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const probe = setup();
        const diagnostics = createVideoLayerDiagnostics(probe.media, probe.ports);
        probe.advance(5000);
        probe.setClock(6);
        diagnostics.onClockChange(6);
        diagnostics.tick();
        expect(warn.mock.calls.some(([line]) => String(line).startsWith('[VideoLayer] timer-gap ') && payload(line).timerDelayMs === 4500)).toBe(true);
        expect(payload(info.mock.calls.find(([line]) => String(line).startsWith('[VideoLayer] summary '))![0]))
            .toMatchObject({ framesSinceSummary: 24, droppedSinceSummary: 2, clockAgeMs: 0 });
        diagnostics.dispose();
    });

    it('records the latest speed change and the complete buffering duration in copied text', () => {
        const info = vi.spyOn(console, 'info').mockImplementation(() => {});
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const probe = setup();
        const diagnostics = createVideoLayerDiagnostics(probe.media, probe.ports);
        diagnostics.report('rate-adjustment', { fromRate: 1, toRate: 1.05, reason: 'drift-correction' });
        probe.advance(50); probe.event('waiting');
        expect(payload(warn.mock.calls[0][0])).toMatchObject({
            lastRateAdjustment: { atMs: 0, fromRate: 1, toRate: 1.05, reason: 'drift-correction' },
        });
        probe.advance(776); probe.event('canplay');
        const recovered = info.mock.calls.find(([line]) => String(line).startsWith('[VideoLayer] buffer-recovered '))!;
        expect(payload(recovered[0])).toMatchObject({ waitMs: 776, waitingAgeMs: null });
        diagnostics.dispose();
    });
});

describe('video frame diagnostics', () => {
    it('reports delayed callbacks separately from decode timing and compositor frame skips', () => {
        const probe = setup();
        const monitor = createVideoLayerFrameDiagnostics(probe.media, probe.ports);
        probe.advance(40); probe.frame(1);
        probe.advance(400); probe.frame(10, 0.08);
        expect(probe.ports.report).toHaveBeenCalledWith('frame-gap', expect.objectContaining({
            frameGapMs: 400, skippedCallbacks: 8, decodeMs: 80, callbackDelayMs: 200,
        }));
        monitor.dispose();
    });

    it('reports absent frames once, then their recovery', () => {
        const probe = setup();
        const monitor = createVideoLayerFrameDiagnostics(probe.media, probe.ports);
        probe.advance(600); monitor.tick(); monitor.tick();
        expect(probe.ports.report.mock.calls.filter(([event]) => event === 'no-video-frames')).toHaveLength(1);
        probe.frame(1);
        expect(probe.ports.report).toHaveBeenCalledWith('frames-resumed', { frameGapMs: 600 });
        monitor.dispose();
        expect(probe.callbacks.size).toBe(0);
    });

    it('does not report unsupported frame callbacks or an intentional pause as a stall', () => {
        const probe = setup();
        probe.video.requestVideoFrameCallback = undefined as unknown as typeof probe.video.requestVideoFrameCallback;
        const monitor = createVideoLayerFrameDiagnostics(probe.media, probe.ports);
        probe.advance(3000); monitor.tick();
        expect(probe.ports.report).not.toHaveBeenCalled();
        monitor.dispose();
        const paused = setup();
        paused.video.paused = true;
        const pausedMonitor = createVideoLayerFrameDiagnostics(paused.media, paused.ports);
        paused.advance(3000); pausedMonitor.tick();
        expect(paused.ports.report).not.toHaveBeenCalled();
        pausedMonitor.dispose();
    });

    it('records long task timing and disconnects its observer', () => {
        let receive: ((list: { getEntries: () => PerformanceEntry[] }) => void) | undefined;
        const disconnect = vi.fn();
        vi.stubGlobal('PerformanceObserver', class {
            static supportedEntryTypes = ['longtask'];
            constructor(callback: typeof receive) { receive = callback; }
            observe = vi.fn();
            disconnect = disconnect;
        });
        const probe = setup();
        const monitor = createVideoLayerFrameDiagnostics(probe.media, probe.ports);
        receive!({ getEntries: () => [{ startTime: 20, duration: 450, name: 'self' } as PerformanceEntry] });
        expect(probe.ports.report).toHaveBeenCalledWith('main-thread-longtask', {
            taskStartMs: 20, taskDurationMs: 450, taskName: 'self',
        });
        monitor.dispose();
        expect(disconnect).toHaveBeenCalledOnce();
    });
});
