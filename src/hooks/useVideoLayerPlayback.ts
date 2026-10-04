import { useEffect, useRef, type RefObject } from 'react';
import { PlayerState } from '../types';
import { currentTime, displayPlaybackRate } from '../stores/motionSignals';
import { selectDisplayPlayerState, usePlaybackStore } from '../stores/usePlaybackStore';
import { createVideoLayerPlayback, VIDEO_LAYER_SYNC_INTERVAL_MS } from '../services/videoLayerPlayback';
import { createVideoLayerDiagnostics } from '../services/videoLayerDiagnostics';

// src/hooks/useVideoLayerPlayback.ts
// Wire stable playback signals to the media controller without rendering at clock frequency.

/** Subscribe once per source and release the controller, timers, and signal listeners together. */
export const useVideoLayerPlayback = (
    videoRef: RefObject<HTMLVideoElement | null>,
    active: boolean,
    source: string | null,
    paused: boolean,
) => {
    const pausedRef = useRef(paused);
    pausedRef.current = paused;
    const controllerRef = useRef<ReturnType<typeof createVideoLayerPlayback> | null>(null);

    useEffect(() => {
        const video = videoRef.current;
        if (!active || !video) return;
        const ports = {
            getTime: () => currentTime.get(),
            getRate: () => displayPlaybackRate.get(),
            isPlaying: () => !pausedRef.current
                && selectDisplayPlayerState(usePlaybackStore.getState()) === PlayerState.PLAYING,
            now: () => performance.now(),
        };
        const diagnostics = createVideoLayerDiagnostics(video, { ...ports, source, isShellPaused: () => pausedRef.current });
        const controller = createVideoLayerPlayback(video, { ...ports, report: diagnostics.report });
        controllerRef.current = controller;
        const unsubscribeClock = currentTime.on('change', time => {
            diagnostics.onClockChange(time);
            controller.onClockChange(time);
        });
        const unsubscribeRate = displayPlaybackRate.on('change', controller.onRateChange);
        const unsubscribeStore = usePlaybackStore.subscribe((state, previous) => {
            if (selectDisplayPlayerState(state) !== selectDisplayPlayerState(previous)) controller.followState();
        });
        const timer = window.setInterval(() => {
            diagnostics.tick();
            controller.tick();
        }, VIDEO_LAYER_SYNC_INTERVAL_MS);
        return () => {
            window.clearInterval(timer);
            unsubscribeClock();
            unsubscribeRate();
            unsubscribeStore();
            controller.dispose();
            diagnostics.dispose();
            controllerRef.current = null;
        };
    }, [active, source, videoRef]);

    // The shell's pause flag changes without touching the source; only play/pause needs to follow.
    useEffect(() => {
        controllerRef.current?.followState();
    }, [paused]);
};
