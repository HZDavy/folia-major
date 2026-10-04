// src/services/videoLayerPlayback.ts
// Temporary playback-only experiment: let the browser advance and loop video independently.

type VideoLayerPlaybackPorts = {
    isPlaying: () => boolean;
    report?: (event: string, detail?: Record<string, unknown>) => void;
};

/** Follow playback state without seeking, rate correction, or music-clock stall detection. */
export const createVideoLayerPlayback = (video: HTMLVideoElement, ports: VideoLayerPlaybackPorts) => {
    let playPending = false;
    let disposed = false;
    let wasPlaying: boolean | null = null;

    const followState = () => {
        if (disposed) return;
        const playing = ports.isPlaying();
        if (playing !== wasPlaying) ports.report?.('playback-state-change', { playing });
        wasPlaying = playing;
        if (!playing) {
            if (!video.paused) video.pause();
            return;
        }
        if (!video.paused || playPending) return;
        playPending = true;
        ports.report?.('play-request');
        void video.play().catch(error => {
            ports.report?.('play-rejected', { errorName: error?.name, errorMessage: error?.message });
        }).finally(() => { playPending = false; });
    };

    // Clear a correction left on the same DOM element by hot reload, once on attachment.
    video.playbackRate = 1;
    video.addEventListener('loadedmetadata', followState);
    followState();

    return {
        followState,
        dispose: () => {
            disposed = true;
            video.removeEventListener('loadedmetadata', followState);
            video.pause();
        },
    };
};
