import React, { useEffect, useRef } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { ensureVideoLayerFileRestored, useVideoLayerSettingsStore } from '../../../stores/useVideoLayerSettingsStore';
import { useVideoLayerPlayback } from '../../../hooks/useVideoLayerPlayback';

// src/components/visualizer/videoLayer/VideoLayer.tsx
// Built-in muted video behind the lyrics (above the background, under the lyrics). The video follows
// playback without any per-frame React work: only play/pause follows the player state.
// Temporary stall investigation: the video runs at native speed and loops independently of music.

interface VideoLayerProps {
    /** The shell's pause signal (window hidden etc.); the video stops even while music plays. */
    paused: boolean;
}

const VideoLayer: React.FC<VideoLayerProps> = ({ paused }) => {
    const videoRef = useRef<HTMLVideoElement | null>(null);
    const { enabled, url, opacity, fit, localFileUrl } = useVideoLayerSettingsStore(useShallow(state => ({
        enabled: state.videoLayerEnabled,
        url: state.videoLayerUrl,
        opacity: state.videoLayerOpacity,
        fit: state.videoLayerFit,
        localFileUrl: state.localFileUrl,
    })));
    const source = localFileUrl ?? (url || null);
    const active = enabled && Boolean(source);
    useVideoLayerPlayback(videoRef, active, source, paused);

    useEffect(() => {
        ensureVideoLayerFileRestored();
    }, []);

    if (!active || !source) return null;

    return (
        <video
            ref={videoRef}
            key={source}
            src={source}
            muted
            loop
            playsInline
            preload="auto"
            aria-hidden
            className="absolute inset-0 h-full w-full pointer-events-none"
            style={{ opacity, objectFit: fit }}
        />
    );
};

export default VideoLayer;
