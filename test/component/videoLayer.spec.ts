import { expect, test } from './fixtures';

// test/component/videoLayer.spec.ts
// Count script-initiated seeks separately from the browser's native loop, using real decoded video.

test.beforeEach(async ({ page, mount }) => {
    await page.addInitScript(() => {
        const descriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime')!;
        Object.defineProperty(window, '__videoLayerSeeks', { value: [], configurable: true });
        Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', {
            ...descriptor,
            set(value: number) {
                if (this.tagName === 'VIDEO') {
                    (window as unknown as { __videoLayerSeeks: number[] }).__videoLayerSeeks.push(value);
                }
                descriptor.set!.call(this, value);
            },
        });
    });
    await mount('videoLayer');
    await expect.poll(() => page.locator('video').evaluate((video: HTMLVideoElement) => (
        !video.paused && video.readyState >= 2 && video.getVideoPlaybackQuality().totalVideoFrames > 5
    ))).toBe(true);
});

test('keeps decoding across loops and a tempo change without periodic script seeks', async ({ page }) => {
    const video = page.locator('video');
    const seeks = () => page.evaluate(() => (window as unknown as { __videoLayerSeeks: number[] }).__videoLayerSeeks.length);
    const baseline = await seeks();
    const frames = await video.evaluate((video: HTMLVideoElement) => video.getVideoPlaybackQuality().totalVideoFrames);
    // More than two complete loops, including a live Automix-style rate change.
    await page.waitForTimeout(4500);
    await page.getByRole('button', { name: 'Tempo 1.1x' }).click();
    await expect.poll(() => video.evaluate((video: HTMLVideoElement) => video.playbackRate)).toBeCloseTo(1.1, 1);
    await page.waitForTimeout(4500);
    expect(await seeks()).toBe(baseline);
    expect(await video.evaluate((video: HTMLVideoElement) => video.getVideoPlaybackQuality().totalVideoFrames) - frames).toBeGreaterThan(150);
    await expect(video).toHaveJSProperty('paused', false);
});

test('pauses on a stopped music clock, recovers, and still follows an explicit seek', async ({ page }) => {
    const video = page.locator('video');
    const seeks = () => page.evaluate(() => (window as unknown as { __videoLayerSeeks: number[] }).__videoLayerSeeks.length);
    const baseline = await seeks();
    await page.getByRole('button', { name: 'Stop clock' }).click();
    await expect(video).toHaveJSProperty('paused', true);
    await page.waitForTimeout(2100);
    expect(await seeks()).toBe(baseline);
    await page.getByRole('button', { name: 'Resume clock' }).click();
    await expect(video).toHaveJSProperty('paused', false);
    const beforeSeek = await seeks();
    await page.getByRole('button', { name: 'Seek', exact: true }).click();
    await expect.poll(seeks).toBe(beforeSeek + 1);
    await expect(video).toHaveJSProperty('paused', false);
});

test('keeps a replacement source aligned and paused until playback resumes', async ({ page }) => {
    const video = page.locator('video');
    await page.evaluate(async () => {
        const playbackPath = '/src/stores/usePlaybackStore.ts';
        const settingsPath = '/src/stores/useVideoLayerSettingsStore.ts';
        const typesPath = '/src/types.ts';
        const [{ usePlaybackStore }, { useVideoLayerSettingsStore }, { PlayerState }] = await Promise.all([
            import(playbackPath), import(settingsPath), import(typesPath),
        ]);
        usePlaybackStore.getState().setPlayerState(PlayerState.PAUSED);
        const settings = useVideoLayerSettingsStore.getState();
        settings.setVideoLayerUrl(`${settings.videoLayerUrl}?replacement`);
    });
    await expect(video).toHaveAttribute('src', /replacement$/);
    await expect.poll(() => video.evaluate((video: HTMLVideoElement) => video.readyState)).toBeGreaterThanOrEqual(2);
    await expect(video).toHaveJSProperty('paused', true);
    await page.evaluate(async () => {
        const signalsPath = '/src/stores/motionSignals.ts';
        const { currentTime } = await import(signalsPath);
        const video = document.querySelector('video')!;
        // The newly loaded file's frame must still describe the paused song position.
        const phaseError = Math.abs(video.currentTime - (currentTime.get() % video.duration));
        if (phaseError > 0.1) throw new Error(`Paused replacement is out of sync: ${phaseError}`);
    });
    await page.evaluate(async () => {
        const playbackPath = '/src/stores/usePlaybackStore.ts';
        const typesPath = '/src/types.ts';
        const [{ usePlaybackStore }, { PlayerState }] = await Promise.all([import(playbackPath), import(typesPath)]);
        usePlaybackStore.getState().setPlayerState(PlayerState.PLAYING);
    });
    await expect(video).toHaveJSProperty('paused', false);
});

test('logs an injected main-thread block and delayed video frames without adding script seeks', async ({ page }) => {
    const tasks: Array<Record<string, number>> = [];
    const frames: Array<Record<string, number>> = [];
    page.on('console', message => {
        const line = message.text();
        if (line.startsWith('[VideoLayer] main-thread-longtask')) tasks.push(JSON.parse(line.slice(line.indexOf('{'))));
        if (line.startsWith('[VideoLayer] frame-gap')) frames.push(JSON.parse(line.slice(line.indexOf('{'))));
    });
    const baseline = await page.evaluate(() => (window as unknown as { __videoLayerSeeks: number[] }).__videoLayerSeeks.length);
    await page.evaluate(() => new Promise<void>(resolve => {
        // Use a browser task rather than DevTools evaluation, which may be omitted from longtask.
        setTimeout(() => {
            const end = performance.now() + 350;
            while (performance.now() < end) { /* Controlled reproduction of a blocking task. */ }
            resolve();
        }, 0);
    }));
    await expect.poll(() => tasks.some(task => task.taskDurationMs >= 300)).toBe(true);
    await expect.poll(() => frames.some(frame => frame.frameGapMs >= 300)).toBe(true);
    expect(await page.evaluate(() => (window as unknown as { __videoLayerSeeks: number[] }).__videoLayerSeeks.length)).toBe(baseline);
});
