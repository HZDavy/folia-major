import { createVideoLayerFrameDiagnostics } from '../../src/services/videoLayerFrameDiagnostics';

// dev/video-test/page.ts
// Observe native playback only; never synchronize time or import the app/store/rendering runtime.
const video = document.querySelector<HTMLVideoElement>('#video')!;
const status = document.querySelector<HTMLElement>('#status')!;
const logView = document.querySelector<HTMLElement>('#logs')!;
const lines: string[] = [];
let session = 0;
let objectUrl: string | null = null;
let waitingAt: number | null = null;
let frames: ReturnType<typeof createVideoLayerFrameDiagnostics> | null = null;
let lastSummary = 0;
let lastTick = performance.now();
let lastQuality = { total: 0, dropped: 0 };

const snapshot = () => {
    const quality = video.getVideoPlaybackQuality?.();
    const buffered = Array.from({ length: video.buffered.length }, (_, i) => [video.buffered.start(i), video.buffered.end(i)]);
    const range = buffered.find(([start, end]) => video.currentTime >= start && video.currentTime <= end);
    return {
        atMs: performance.now(), session, videoTimeSec: video.currentTime,
        videoDurationSec: Number.isFinite(video.duration) ? video.duration : null,
        videoRate: video.playbackRate, paused: video.paused, seeking: video.seeking,
        readyState: video.readyState, networkState: video.networkState,
        bufferedRangesSec: buffered, bufferAheadSec: range ? range[1] - video.currentTime : 0,
        videoSize: [video.videoWidth, video.videoHeight], visibility: document.visibilityState,
        totalFrames: quality?.totalVideoFrames, droppedFrames: quality?.droppedVideoFrames,
        waitingAgeMs: waitingAt === null ? null : performance.now() - waitingAt,
        mediaError: video.error ? { code: video.error.code, message: video.error.message } : null,
        ...frames?.snapshot(),
    };
};

const report = (event: string, detail: Record<string, unknown> = {}) => {
    const line = `[NativeVideo] ${event} ${JSON.stringify({ ...snapshot(), ...detail })}`;
    lines.push(line);
    if (lines.length > 2000) lines.shift();
    console.info(line);
};

const play = () => { void video.play().catch(error => report('play-rejected', { message: String(error) })); };

/** Start an isolated diagnostic session; replacing a source is the only automatic media reset. */
const load = (source: string, label: string, local: boolean) => {
    frames?.dispose();
    frames = null;
    video.pause();
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = local ? source : null;
    session += 1;
    waitingAt = null;
    lastSummary = lastTick = performance.now();
    lastQuality = { total: 0, dropped: 0 };
    video.src = source;
    video.playbackRate = 1;
    video.load();
    frames = createVideoLayerFrameDiagnostics(video, {
        now: () => performance.now(), isPlaying: () => !video.paused && !video.seeking, report,
    });
    document.querySelector('#source')!.textContent = label;
    report('source-loaded', { sourceType: local ? 'local-file' : 'url', userAgent: navigator.userAgent });
    play();
};

for (const event of ['loadedmetadata', 'playing', 'pause', 'waiting', 'stalled', 'canplay', 'seeking', 'seeked', 'ratechange', 'error', 'ended']) {
    video.addEventListener(event, () => {
        if (event === 'waiting' && waitingAt === null) waitingAt = performance.now();
        report(event);
        if ((event === 'canplay' || event === 'playing') && waitingAt !== null) {
            const waitMs = performance.now() - waitingAt;
            waitingAt = null;
            report('buffer-recovered', { waitMs });
        }
    });
}
document.querySelector<HTMLInputElement>('#file')!.addEventListener('change', event => {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (file) load(URL.createObjectURL(file), file.name, true);
});
document.querySelector('#url-form')!.addEventListener('submit', event => {
    event.preventDefault();
    const source = document.querySelector<HTMLInputElement>('#url')!.value;
    const url = new URL(source);
    if (!['http:', 'https:'].includes(url.protocol)) return;
    load(source, '远程视频（日志不记录链接）', false);
});
document.querySelector('#play')!.addEventListener('click', play);
document.querySelector('#pause')!.addEventListener('click', () => video.pause());
document.addEventListener('visibilitychange', () => report('visibility-change'));
document.querySelector('#download')!.addEventListener('click', () => {
    const url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'native-video-log.txt';
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
});

// Sample UI at 2 Hz and log summaries at 5-second intervals, never update DOM per video frame.
const timer = window.setInterval(() => {
    const now = performance.now();
    if (session && !video.paused && now - lastTick > 1000) report('timer-gap', { timerGapMs: now - lastTick });
    lastTick = now;
    if (!session) return;
    frames?.tick();
    if (!video.paused && now - lastSummary >= 5000) {
        const quality = video.getVideoPlaybackQuality?.();
        const total = quality?.totalVideoFrames ?? 0;
        const dropped = quality?.droppedVideoFrames ?? 0;
        report('summary', { framesSinceSummary: total - lastQuality.total, droppedSinceSummary: dropped - lastQuality.dropped });
        lastQuality = { total, dropped };
        lastSummary = now;
    }
    status.textContent = JSON.stringify(snapshot(), null, 2);
    if (logView.parentElement!.hasAttribute('open')) logView.textContent = lines.slice(-12).join('\n');
}, 500);
window.addEventListener('pagehide', () => {
    clearInterval(timer);
    frames?.dispose();
    if (objectUrl) URL.revokeObjectURL(objectUrl);
});
