import React, { useEffect, useRef } from 'react';
import type { ProbeDefinition } from './definition';
import VideoLayer from '../../src/components/visualizer/videoLayer/VideoLayer';
import { currentTime, displayPlaybackRate } from '../../src/stores/motionSignals';
import { usePlaybackStore } from '../../src/stores/usePlaybackStore';
import { useVideoLayerSettingsStore } from '../../src/stores/useVideoLayerSettingsStore';
import { PlayerState } from '../../src/types';
import videoUrl from '../../test/fixtures/videoLayer-loop.webm?url';

// dev/probes/videoLayer.probe.tsx
// A real, decoded looping video driven by an independent clock; no mocked media methods.

const VideoLayerProbe = () => {
    const clockRef = useRef({ time: 0, rate: 1, frozen: false });

    useEffect(() => {
        const clock = clockRef.current;
        clock.time = 0;
        currentTime.set(0);
        displayPlaybackRate.set(1);
        useVideoLayerSettingsStore.getState().setVideoLayerUrl(videoUrl);
        useVideoLayerSettingsStore.getState().setVideoLayerEnabled(true);
        usePlaybackStore.getState().setPlayerState(PlayerState.PLAYING);
        let frame = 0;
        let previous = performance.now();
        const update = (now: number) => {
            if (!clock.frozen && usePlaybackStore.getState().playerState === PlayerState.PLAYING) {
                clock.time += (now - previous) / 1000 * clock.rate;
                currentTime.set(clock.time);
            }
            previous = now;
            frame = requestAnimationFrame(update);
        };
        frame = requestAnimationFrame(update);
        return () => {
            cancelAnimationFrame(frame);
            usePlaybackStore.getState().setPlayerState(PlayerState.PAUSED);
        };
    }, []);

    return (
        <div>
            <div className="relative w-[320px] h-[180px]">
                <VideoLayer paused={false} />
            </div>
            <button onClick={() => {
                clockRef.current.rate = 1.1;
                displayPlaybackRate.set(1.1);
            }}>Tempo 1.1x</button>
            <button onClick={() => { clockRef.current.frozen = true; }}>Stop clock</button>
            <button onClick={() => { clockRef.current.frozen = false; }}>Resume clock</button>
            <button onClick={() => {
                clockRef.current.time = 20;
                currentTime.set(20);
            }}>Seek</button>
        </div>
    );
};

const definition: ProbeDefinition = {
    id: 'videoLayer',
    title: '视频层 · 连续播放与同步',
    description: '真实 WebM 循环、变速、拖动进度、播放时钟停滞与恢复。',
    Component: VideoLayerProbe,
};

export default definition;
