/**
 * Video Player Component
 * Handles HLS video playback with custom controls
 */

// Check if device is mobile
function isMobile() {
    return /Mobi|Android|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
}

class VideoPlayer {
    constructor() {
        this.video = document.getElementById('video-player');

        // iOS: ensure inline playback (not fullscreen by default)
        if (this.video) {
            this.video.setAttribute('playsinline', '');
            this.video.setAttribute('webkit-playsinline', '');
        }

        this.container = document.querySelector('.video-container');
        this.overlay = document.getElementById('player-overlay');
        this.nowPlaying = document.getElementById('now-playing');
        this.hls = null;
        this.currentChannel = null;
        this.overlayTimer = null;
        this.overlayDuration = 5000; // 5 seconds
        this.currentUrl = null;
        this.settingsLoaded = false;

        // Settings - start with defaults, load from server async
        this.settings = this.getDefaultSettings();

        // Load settings from server, then init
        this.loadSettingsFromServer().then(() => {
            // Volume is a preference for this browser, not a server setting.
            try {
                const saved = localStorage.getItem('pigtv_last_volume');
                const volume = Number(saved);
                if (this.settings.rememberVolume && saved !== null && Number.isFinite(volume) && volume >= 0 && volume <= 100) {
                    this.settings.lastVolume = volume;
                }
            } catch (err) { /* storage may be unavailable */ }
            this.init();
        });
    }

    /**
     * Default settings
     */
    getDefaultSettings() {
        return {
            arrowKeysChangeChannel: true,
            overlayDuration: 5,
            defaultVolume: 80,
            rememberVolume: true,
            lastVolume: 80,
            streamFormat: 'm3u8',
            epgRefreshInterval: '24'
        };
    }

    /**
     * Load settings from server API
     */
    async loadSettingsFromServer() {
        try {
            const serverSettings = await API.settings.get();
            this.settings = { ...this.getDefaultSettings(), ...serverSettings };
            this.settingsLoaded = true;
            console.log('[Player] Settings loaded from server');
        } catch (err) {
            console.warn('[Player] Failed to load settings from server, using defaults:', err.message);
            // Fall back to localStorage for backwards compatibility
            try {
                const saved = localStorage.getItem('pigtv_player_settings');
                if (saved) {
                    this.settings = { ...this.getDefaultSettings(), ...JSON.parse(saved) };
                    console.log('[Player] Settings loaded from localStorage (fallback)');
                }
            } catch (localErr) {
                console.error('[Player] Error loading localStorage settings:', localErr);
            }
        }
    }

    saveVolume() {
        try {
            localStorage.setItem('pigtv_last_volume', String(this.settings.lastVolume));
        } catch (err) { /* volume still works when browser storage is disabled */ }
    }

    /**
     * Save settings to server API (admin Settings page only).
     */
    async saveSettings() {
        try {
            await API.settings.update(this.settings);
            console.log('[Player] Settings saved to server');
        } catch (err) {
            console.error('[Player] Error saving settings to server:', err);
            // Also save to localStorage as backup
            try {
                localStorage.setItem('pigtv_player_settings', JSON.stringify(this.settings));
            } catch (localErr) {
                console.error('[Player] Error saving to localStorage:', localErr);
            }
        }
    }

    /**
     * Get HLS.js configuration with buffer settings optimized for stable playback
     */
    getHlsConfig() {
        return {
            enableWorker: true,
            // Buffer settings to prevent underruns during background tab throttling
            maxBufferLength: 30,           // Buffer up to 30 seconds of content
            maxMaxBufferLength: 60,        // Absolute max buffer 60 seconds
            maxBufferSize: 60 * 1000 * 1000, // 60MB max buffer size
            maxBufferHole: 1.0,            // Allow 1s holes in buffer (helps with discontinuities)
            // Live stream settings - stay further from live edge for stability
            liveSyncDurationCount: 3,      // Stay 3 segments behind live
            liveMaxLatencyDurationCount: 10, // Allow up to 10 segments behind before catching up
            liveBackBufferLength: 30,      // Keep 30s of back buffer for seeking
            // Audio discontinuity handling (fixes garbled audio during ad transitions)
            stretchShortVideoTrack: true,  // Stretch short segments to avoid gaps
            forceKeyFrameOnDiscontinuity: true, // Force keyframe sync on discontinuity
            // Audio settings - prevent glitches during stream transitions
            // Higher drift tolerance = less aggressive correction = fewer glitches
            maxAudioFramesDrift: 8,        // Allow ~185ms audio drift before correction (was 4)
            // Disable progressive/streaming mode for stability with discontinuities
            progressive: false,
            // Stall recovery settings
            nudgeOffset: 0.2,              // Larger nudge steps for recovery (default 0.1)
            nudgeMaxRetry: 6,              // More retry attempts (default 3)
            // Faster recovery from errors
            levelLoadingMaxRetry: 4,
            manifestLoadingMaxRetry: 4,
            fragLoadingMaxRetry: 6,
            // Low latency mode off for more stable audio
            lowLatencyMode: false,
            // Caption/Subtitle settings
            enableCEA708Captions: true,    // Enable CEA-708 closed captions
            enableWebVTT: true,            // Enable WebVTT subtitles
            renderTextTracksNatively: true // Use native browser rendering for text tracks
        };
    }

    /**
     * Initialize custom video controls for mobile
     */
    /**
     * Initialize custom video controls
     */
    initCustomControls() {
        // Elements
        this.controlsOverlay = document.getElementById('player-controls-overlay');
        this.loadingSpinner = document.getElementById('player-loading');

        // iOS Safari: detect and compensate for floating bottom toolbar
        const updateIosUiBottom = () => {
            let uiBottom = 0;
            if (window.visualViewport) {
                const vv = window.visualViewport;
                uiBottom = Math.max(0, window.innerHeight - (vv.height + vv.offsetTop));
            }
            document.documentElement.style.setProperty('--ios-ui-bottom', uiBottom + 'px');
        };

        updateIosUiBottom();

        if (window.visualViewport) {
            window.visualViewport.addEventListener('resize', updateIosUiBottom);
            window.visualViewport.addEventListener('scroll', updateIosUiBottom);
        } else {
            window.addEventListener('resize', updateIosUiBottom);
        }

        // iOS: use custom --vh unit to avoid 100vh issues with dynamic toolbar
        const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent);
        if (isIOS && this.container) {
            const vh = window.innerHeight * 0.01;
            document.documentElement.style.setProperty('--vh', `${vh}px`);
            this.container.style.height = 'calc(var(--vh) * 100)';
        }

        // Apply safe area + iOS toolbar padding to controls overlay
        if (this.controlsOverlay) {
            this.controlsOverlay.style.paddingBottom = 'calc(env(safe-area-inset-bottom, 0px) + var(--ios-ui-bottom, 0px) + 12px)';
        }

        const btnPlay = document.getElementById('btn-play');
        const btnMute = document.getElementById('btn-mute');
        const btnFullscreen = document.getElementById('btn-fullscreen');
        const volumeSlider = document.getElementById('player-volume');
        const channelNameEl = document.getElementById('player-channel-name');

        if (!this.controlsOverlay) return;

        // Disable native controls
        this.video.controls = false;

        // Initial State: Hide all overlay elements until content is loaded
        this.loadingSpinner?.classList.remove('show');
        this.controlsOverlay?.classList.add('hidden');

        // Play/Pause toggle
        const togglePlay = () => {
            if (this.video.paused) {
                this.video.play();
            } else {
                this.video.pause();
            }
        };

        btnPlay?.addEventListener('click', (e) => {
            e.stopPropagation();
            togglePlay();
        });

        // Center play button (large button shown when paused)
        const centerPlayBtn = document.getElementById('player-center-play');
        centerPlayBtn?.addEventListener('click', (e) => {
            e.stopPropagation();
            togglePlay();
        });

        // Click on video to toggle play/pause
        this.video?.addEventListener('click', (e) => {
            e.stopPropagation();
            togglePlay();
        });

        // Update play/pause UI
        const updatePlayUI = () => {
            const isPaused = this.video.paused;
            const hasVideo = this.video.src && this.video.src !== '' && this.video.readyState > 0;

            // Bottom bar button
            const iconPlay = btnPlay?.querySelector('.icon-play');
            const iconPause = btnPlay?.querySelector('.icon-pause');

            if (iconPlay && iconPause) {
                iconPlay.classList.toggle('hidden', !isPaused);
                iconPause.classList.toggle('hidden', isPaused);
            }

            // Center play button - show only when paused AND video is loaded
            if (centerPlayBtn) {
                centerPlayBtn.classList.toggle('show', isPaused && hasVideo);
            }
        };

        this.video.addEventListener('play', updatePlayUI);
        this.video.addEventListener('pause', updatePlayUI);

        // Keep the LIVE indicator honest without polling: timeupdate fires
        // about four times a second during playback and not at all otherwise.
        this.video.addEventListener('timeupdate', () => this.updateLiveButton());
        this.video.addEventListener('play', () => this.updateLiveButton());

        // Loading spinner
        this.video.addEventListener('waiting', () => {
            this.loadingSpinner?.classList.add('show');
        });

        this.video.addEventListener('canplay', () => {
            this.loadingSpinner?.classList.remove('show');
        });

        // A <video> that cannot decode what it is given drops its connection and
        // says nothing: the stream just stops. Record why (see handleMediaError).
        this.video.addEventListener('error', () => this.handleMediaError());

        // A stream that never starts raises no error at all - the element just
        // waits - so that kind of failure used to leave no trace anywhere. Note it
        // when nothing has played some seconds after loading began.
        this.video.addEventListener('loadstart', () => this.armStartWatch());
        this.video.addEventListener('playing', () => { this.clearStartWatch(); this.notePlaying(); });

        // Measurement for comparing delivery paths (see reportPlayEnd): a stall is
        // the element running out of data after it had started, not a seek.
        this.video.addEventListener('waiting', () => {
            if (this._playingAt != null && !this.video.seeking) this._stalls = (this._stalls || 0) + 1;
        });

        // Mute/Volume
        const updateVolumeUI = () => {
            const isMuted = this.video.muted || this.video.volume === 0;
            const iconVol = btnMute?.querySelector('.icon-vol');
            const iconMuted = btnMute?.querySelector('.icon-muted');

            if (iconVol && iconMuted) {
                iconVol.classList.toggle('hidden', isMuted);
                iconMuted.classList.toggle('hidden', !isMuted);
            }

            if (volumeSlider) {
                volumeSlider.value = this.video.muted ? 0 : Math.round(this.video.volume * 100);
            }
        };

        btnMute?.addEventListener('click', (e) => {
            e.stopPropagation();
            if (this.video.muted) {
                this.video.muted = false;
                this.video.volume = (parseInt(volumeSlider?.value || 80) / 100) || 0.8;
            } else {
                this.video.muted = true;
            }
            updateVolumeUI();
        });

        volumeSlider?.addEventListener('input', (e) => {
            e.stopPropagation();
            const val = parseInt(e.target.value);
            this.video.volume = val / 100;
            this.video.muted = val === 0;
            updateVolumeUI();
        });

        this.video.addEventListener('volumechange', updateVolumeUI);

        // Captions
        this.captionsBtn = document.getElementById('player-captions-btn');
        this.captionsMenu = document.getElementById('player-captions-menu');
        this.captionsList = document.getElementById('player-captions-list');
        this.captionsMenuOpen = false;

        this.captionsBtn?.addEventListener('click', (e) => {
            e.stopPropagation();
            this.toggleCaptionsMenu();
        });

        // Close captions menu when clicking outside
        document.addEventListener('click', (e) => {
            if (this.captionsMenuOpen &&
                !this.captionsMenu.contains(e.target) &&
                !this.captionsBtn.contains(e.target)) {
                this.closeCaptionsMenu();
            }
        });

        // Fullscreen
        btnFullscreen?.addEventListener('click', (e) => {
            e.stopPropagation();
            this.toggleFullscreen();
        });

        // Picture-in-Picture
        const btnStop = document.getElementById('btn-stop');
        btnStop?.addEventListener('click', (e) => {
            e.stopPropagation();
            this.stop();
        });

        const btnGoLive = document.getElementById('btn-go-live');
        btnGoLive?.addEventListener('click', (e) => {
            e.stopPropagation();
            this.goToLive();
        });

        const btnPip = document.getElementById('btn-pip');
        btnPip?.addEventListener('click', (e) => {
            e.stopPropagation();
            this.togglePictureInPicture();
        });

        // Overflow Menu
        const btnOverflow = document.getElementById('btn-overflow');
        const overflowMenu = document.getElementById('player-overflow-menu');

        btnOverflow?.addEventListener('click', (e) => {
            e.stopPropagation();
            overflowMenu?.classList.toggle('hidden');
        });

        // Copy Stream URL
        const btnCopyUrl = document.getElementById('btn-copy-url');
        btnCopyUrl?.addEventListener('click', (e) => {
            e.stopPropagation();
            this.copyStreamUrl();
            overflowMenu?.classList.add('hidden');
        });

        // Close overflow menu when clicking outside
        document.addEventListener('click', (e) => {
            if (overflowMenu && !overflowMenu.classList.contains('hidden') &&
                !overflowMenu.contains(e.target) && e.target !== btnOverflow) {
                overflowMenu.classList.add('hidden');
            }
        });

        this.container.addEventListener('dblclick', () => this.toggleFullscreen());

        // Overlay Auto-hide Logic
        let overlayTimeout;
        const sidebarExpandBtn = document.getElementById('sidebar-expand-btn');

        const showOverlay = () => {
            this.controlsOverlay.classList.remove('hidden');
            this.container.style.cursor = 'default';
            sidebarExpandBtn?.classList.add('visible');
            resetOverlayTimer();
        };

        const hideOverlay = () => {
            if (!this.video.paused) {
                this.controlsOverlay.classList.add('hidden');
                this.container.style.cursor = 'none';
                sidebarExpandBtn?.classList.remove('visible');
            }
        };

        const resetOverlayTimer = () => {
            clearTimeout(overlayTimeout);
            if (!this.video.paused) {
                overlayTimeout = setTimeout(hideOverlay, 3000);
            }
        };

        this.container.addEventListener('mousemove', showOverlay);
        this.container.addEventListener('click', (e) => {
            showOverlay();
            // Only toggle play if clicking directly on video or container (not controls)
            if (e.target === this.video || e.target === this.container || e.target.classList.contains('watch-overlay')) {
                togglePlay();
            }
        });
        this.container.addEventListener('touchstart', showOverlay);

        this.video.addEventListener('play', resetOverlayTimer);
        this.video.addEventListener('pause', showOverlay);

        // Update Title when channel changes
        window.addEventListener('channelChanged', (e) => {
            if (channelNameEl && e.detail) {
                channelNameEl.textContent = e.detail.name || e.detail.tvgName || 'Live TV';
            }
            showOverlay();
        });

        // Initial state
        updatePlayUI();
        updateVolumeUI();
    }

    /**
     * Toggle fullscreen mode (cross-browser including Safari)
     */
    toggleFullscreen() {
        const isFullscreen = document.fullscreenElement || document.webkitFullscreenElement;

        if (isFullscreen) {
            if (document.exitFullscreen) {
                document.exitFullscreen();
            } else if (document.webkitExitFullscreen) {
                document.webkitExitFullscreen();
            }
        } else {
            const element = this.container;
            if (element.requestFullscreen) {
                element.requestFullscreen().catch(err => console.error('Fullscreen error:', err));
            } else if (element.webkitRequestFullscreen) {
                element.webkitRequestFullscreen();
            } else if (this.video.webkitEnterFullscreen) {
                // iOS Safari: use native video fullscreen
                this.video.webkitEnterFullscreen();
            }
        }
    }

    /**
     * Toggle Picture-in-Picture mode (cross-browser including Safari)
     */
    async togglePictureInPicture() {
        try {
            // Standard PiP API (Chrome, Edge, Firefox)
            if (document.pictureInPictureElement) {
                await document.exitPictureInPicture();
            } else if (document.pictureInPictureEnabled && this.video.readyState >= 2) {
                await this.video.requestPictureInPicture();
            }
            // Safari fallback using webkitPresentationMode
            else if (typeof this.video.webkitSetPresentationMode === 'function') {
                const mode = this.video.webkitPresentationMode;
                this.video.webkitSetPresentationMode(mode === 'picture-in-picture' ? 'inline' : 'picture-in-picture');
            }
        } catch (err) {
            if (err.name !== 'NotAllowedError') {
                console.error('Picture-in-Picture error:', err);
            }
        }
    }

    /**
     * Copy current stream URL to clipboard
     */
    copyStreamUrl() {
        if (!this.currentUrl) {
            console.warn('[Player] No stream URL to copy');
            return;
        }

        let streamUrl = this.currentUrl;

        // If it's a relative URL, make it absolute
        if (streamUrl.startsWith('/')) {
            streamUrl = window.location.origin + streamUrl;
        }

        const showPromptFallback = () => {
            prompt('Copy this URL:', streamUrl);
        };

        // navigator.clipboard is only available in secure contexts (HTTPS/localhost)
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(streamUrl).then(() => {
                // Show brief feedback
                const btn = document.getElementById('btn-copy-url');
                if (btn) {
                    const originalText = btn.textContent;
                    btn.textContent = '✓ Copied!';
                    setTimeout(() => {
                        btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" class="icon"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg> Copy Stream URL`;
                    }, 1500);
                }
                console.log('[Player] Stream URL copied:', streamUrl);
            }).catch(() => {
                showPromptFallback();
            });
        } else {
            // Fallback for insecure contexts (HTTP)
            showPromptFallback();
        }
    }


    /**
     * Toggle captions menu visibility
     */
    toggleCaptionsMenu() {
        if (!this.captionsMenu) return;

        this.captionsMenuOpen = !this.captionsMenuOpen;

        if (this.captionsMenuOpen) {
            this.updateCaptionsTracks();
            this.captionsMenu.classList.remove('hidden');
        } else {
            this.captionsMenu.classList.add('hidden');
        }
    }

    /**
     * Close captions menu
     */
    closeCaptionsMenu() {
        if (!this.captionsMenu) return;
        this.captionsMenuOpen = false;
        this.captionsMenu.classList.add('hidden');
    }

    /**
     * Update available caption tracks in the menu
     */
    updateCaptionsTracks() {
        if (!this.captionsList) return;

        // Clear existing list (keep only Off option)
        this.captionsList.innerHTML = '<button class="captions-option" data-index="-1">Off</button>';

        // Add tracks
        if (this.video.textTracks && this.video.textTracks.length > 0) {
            let hasActiveTrack = false;

            for (let i = 0; i < this.video.textTracks.length; i++) {
                const track = this.video.textTracks[i];
                const btn = document.createElement('button');
                btn.className = 'captions-option';
                btn.textContent = track.label || `Track ${i + 1} (${track.language || 'unknown'})`;
                btn.dataset.index = i;

                if (track.mode === 'showing') {
                    btn.classList.add('active');
                    // Add checkmark
                    btn.innerHTML += ' <span style="float: right;">✓</span>';
                    hasActiveTrack = true;
                }

                btn.onclick = (e) => {
                    e.stopPropagation();
                    this.selectCaptionTrack(i);
                };

                this.captionsList.appendChild(btn);
            }

            // Handle "Off" button state
            const offBtn = this.captionsList.querySelector('[data-index="-1"]');
            if (offBtn) {
                if (!hasActiveTrack) {
                    offBtn.classList.add('active');
                    offBtn.innerHTML += ' <span style="float: right;">✓</span>';
                }
                offBtn.onclick = (e) => {
                    e.stopPropagation();
                    this.selectCaptionTrack(-1);
                };
            }
        }
    }

    /**
     * Select a caption track
     */
    selectCaptionTrack(index) {
        if (!this.video.textTracks) return;

        // Turn off all tracks
        for (let i = 0; i < this.video.textTracks.length; i++) {
            this.video.textTracks[i].mode = 'hidden'; // or 'disabled'
        }

        // Turn on selected track
        if (index >= 0 && index < this.video.textTracks.length) {
            this.video.textTracks[index].mode = 'showing';
        }

        this.closeCaptionsMenu();
    }

    init() {
        // Apply default/remembered volume
        const volume = this.settings.rememberVolume ? this.settings.lastVolume : this.settings.defaultVolume;
        this.video.volume = volume / 100;

        // Save volume changes
        this.video.addEventListener('volumechange', () => {
            if (this.settings.rememberVolume) {
                this.settings.lastVolume = Math.round(this.video.volume * 100);
                this.saveVolume();
            }
        });

        // Setup custom video controls
        this.initCustomControls();

        // Detect video resolution when metadata loads (works for all streams)
        this.video.addEventListener('loadedmetadata', () => {
            if (this.video.videoHeight > 0) {
                this.currentStreamInfo = {
                    width: this.video.videoWidth,
                    height: this.video.videoHeight
                };
                this.updateQualityBadge();
            }
        });

        // Keyboard controls
        document.addEventListener('keydown', (e) => this.handleKeyboard(e));

        // Click on video shows overlay
        this.video.addEventListener('click', () => this.showNowPlayingOverlay());
    }

    /**
     * Show the now playing overlay briefly
     */
    showNowPlayingOverlay() {
        if (!this.currentChannel) return;

        // Clear existing timer
        if (this.overlayTimer) {
            clearTimeout(this.overlayTimer);
        }

        // Show overlay
        this.nowPlaying.classList.remove('hidden');

        // Hide after duration
        this.overlayTimer = setTimeout(() => {
            this.nowPlaying.classList.add('hidden');
        }, this.settings.overlayDuration * 1000);
    }

    /**
     * Hide the now playing overlay
     */
    hideNowPlayingOverlay() {
        if (this.overlayTimer) {
            clearTimeout(this.overlayTimer);
        }
        this.nowPlaying.classList.add('hidden');
    }

    /**
     * What this browser can actually decode, asked directly rather than
     * assumed. Chrome on Windows plays HEVC when the platform has a decoder,
     * Safari always does, and treating it as unsupported means re-encoding
     * streams that would have played untouched.
     */
    getCodecCapabilities() {
        if (this._codecCaps) return this._codecCaps;

        const MS = window.MediaSource;
        const supported = (type) => {
            try {
                if (MS && typeof MS.isTypeSupported === 'function' && MS.isTypeSupported(type)) return true;
            } catch (e) { /* fall through */ }
            try {
                return this.video.canPlayType(type) === 'probably';
            } catch (e) {
                return false;
            }
        };

        this._codecCaps = {
            hevc: supported('video/mp4; codecs="hvc1.1.6.L93.B0"')
                || supported('video/mp4; codecs="hev1.1.6.L93.B0"'),
            av1: supported('video/mp4; codecs="av01.0.05M.08"'),
            ac3: supported('audio/mp4; codecs="ac-3"'),
            eac3: supported('audio/mp4; codecs="ec-3"'),
            flac: supported('audio/mp4; codecs="flac"')
        };
        console.log('[Player] Codec support:', this._codecCaps);
        return this._codecCaps;
    }

    /**
     * Ask the server how to play something.
     *
     * The strategy used to be decided here: probe, apply heuristics, request a
     * session type. That logic now lives on the server so every client shares
     * one implementation. This sends what the browser can decode and plays
     * whatever comes back.
     *
     * Always asks for HLS segments (segmentedDelivery), exactly as the Apple
     * client does: there is one delivery path for every device. Returns null when
     * the server could not start the channel; play() then asks once more.
     */
    async resolvePlayback(channel, streamUrl, { force = false, audioEncode = false } = {}) {
        const caps = this.getCodecCapabilities();
        const body = {
            force,
            // Ask for the audio to be re-encoded rather than copied: for a channel
            // whose audio frames this browser's decoder has already failed on.
            audioEncode: audioEncode || this.needsAudioEncode(channel),
            capabilities: {
                ...caps,
                hls: !!(window.Hls && window.Hls.isSupported()) || this.video.canPlayType('application/vnd.apple.mpegurl') !== '',
                fmp4: true,
                segmentedDelivery: true
            },
            upscale: this.settings.upscaleEnabled === true
        };

        // Prefer identifying the channel, so the server can record history and
        // resolve the URL itself. Fall back to the URL for anything else.
        if (channel && channel.sourceId !== undefined && channel.id !== undefined) {
            body.sourceId = channel.sourceId;
            body.channelId = channel.id;
        } else {
            body.url = streamUrl;
        }

        try {
            const res = await fetch('/api/playback/resolve', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...(localStorage.getItem('authToken') ? { Authorization: `Bearer ${localStorage.getItem('authToken')}` } : {})
                },
                body: JSON.stringify(body)
            });
            if (res.status === 409) {
                // Something else is using the provider's only stream: a
                // recording, or another device that is really watching. Ask
                // before taking it: the user is the only one who knows which
                // they would rather have.
                const conflict = (await res.json()).conflict;
                const otherViewer = conflict.type === 'viewer-in-progress';
                const proceed = confirm(`${conflict.message}\n\n${otherViewer ? 'Stop the other stream and watch here?' : 'Stop the recording and watch now?'}`);
                if (!proceed) {
                    this.updateTranscodeStatus('idle', otherViewer ? 'Another device is watching' : 'Recording in progress');
                    // Not null: null means "the server could not start it", which play()
                    // answers by asking again - and answering "no" to the prompt and then
                    // taking the other viewer's stream anyway is the one outcome the prompt
                    // exists to prevent.
                    return VideoPlayer.CANCELLED;
                }
                return this.resolvePlayback(channel, streamUrl, { force: true, audioEncode });
            }
            // 0180: the server stopped this start because a newer play from this viewer took
            // over. Not a failure: the newer play owns the screen, so this one says nothing.
            if (res.status === 499) return VideoPlayer.SUPERSEDED;
            if (!res.ok) return null;
            const decision = await res.json();
            if (!decision || !decision.url) return null;
            console.log(`[Player] Server chose ${decision.strategy}: ${decision.reason}`);
            return decision;
        } catch (err) {
            console.warn('[Player] Playback resolve failed:', err.message);
            return null;
        }
    }

    /**
     * Watch for a recording that needs the provider stream.
     *
     * Polled only while something is playing, because that is the only time
     * the question can arise. Asks once per recording: if the answer is no,
     * the recording waits and starts the moment playback stops.
     */
    startConflictWatch() {
        if (this._conflictTimer) clearInterval(this._conflictTimer);
        this._conflictTimer = setInterval(() => this.checkConflict(), 20000);
        this.checkConflict();
    }

    stopConflictWatch() {
        if (this._conflictTimer) clearInterval(this._conflictTimer);
        this._conflictTimer = null;
    }

    async checkConflict() {
        if (this.video.paused || !this.currentUrl) return;
        try {
            const res = await fetch('/api/playback/conflict', {
                headers: localStorage.getItem('authToken')
                    ? { Authorization: `Bearer ${localStorage.getItem('authToken')}` } : {}
            });
            if (!res.ok) return;
            const prompt = await res.json();
            if (!prompt || this._promptedFor === prompt.scheduleId) return;

            this._promptedFor = prompt.scheduleId;
            const mins = Math.max(1, Math.round(prompt.startsInSec / 60));
            const stopNow = confirm(
                `${prompt.message}\n\nIt is due in about ${mins} minute${mins === 1 ? '' : 's'}.\n\n` +
                `Stop watching so it can record?`
            );

            if (stopNow) {
                await this.stop();
            } else {
                await fetch('/api/playback/conflict/decline', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        ...(localStorage.getItem('authToken')
                            ? { Authorization: `Bearer ${localStorage.getItem('authToken')}` } : {})
                    },
                    body: JSON.stringify({ scheduleId: prompt.scheduleId })
                });
            }
        } catch (err) {
            // A coordination failure must never interrupt playback.
        }
    }

    /**
     * Play what the server told us to play.
     */
    async playDecision(decision, channel) {
        this.currentStrategy = decision.strategy || null;
        this.currentSessionId = decision.sessionId || null;
        this.currentStreamInfo = decision.info || null;
        this.updateQualityBadge();

        // What the measurement events (play-start / play-end) will say about this play.
        this._playMeta = {
            strategy: decision.strategy || 'unknown',
            container: decision.container || null,
            videoMode: decision.videoMode || null,
            hlsDelivery: true
        };
        this._resolveMs = this.elapsedSincePlayStart();

        const label = {
            direct: ['direct', 'Direct'],
            transcode: ['transcoding', `HLS (video ${decision.videoMode === 'copy' ? 'copied' : 'encoded'})`]
        }[decision.strategy] || ['direct', 'Direct'];
        this.updateTranscodeStatus(label[0], label[1]);

        if (decision.container === 'hls') {
            this.currentUrl = API.withStreamToken(decision.url);
            this.playHls(this.currentUrl);
        } else {
            this.currentUrl = API.withStreamToken(decision.url);
            this.video.src = this.currentUrl;
            this.video.play().catch(e => {
                if (e.name !== 'AbortError') console.log('[Player] Autoplay prevented:', e);
            });
        }

        this.updateNowPlaying(channel);
        this.showNowPlayingOverlay();
        this.fetchEpgData(channel);
        this.startConflictWatch();
        window.dispatchEvent(new CustomEvent('channelChanged', { detail: channel }));
    }

    /**
     * Jump back to the live edge. On an HLS stream that means seeking to the
     * end of the seekable range.
     */
    goToLive() {
        if (this.hls && this.hls.liveSyncPosition != null) {
            this.video.currentTime = this.hls.liveSyncPosition;
            this.video.play().catch(() => { });
            this.updateLiveButton();
            return;
        }

        const seekable = this.video.seekable;
        if (seekable && seekable.length > 0) {
            const end = seekable.end(seekable.length - 1);
            if (isFinite(end) && end > 0) {
                this.video.currentTime = end;
                this.video.play().catch(() => { });
                this.updateLiveButton();
                return;
            }
        }

        // Nothing seekable yet: playback is already at the live edge.
        console.log('[Player] Stream is not seekable — already at the live edge');
    }

    /**
     * How far behind the live edge we are, in seconds. Null when unknown.
     */
    getLiveLatency() {
        if (this.hls && typeof this.hls.latency === 'number') return this.hls.latency;

        const seekable = this.video.seekable;
        if (seekable && seekable.length > 0) {
            const end = seekable.end(seekable.length - 1);
            if (isFinite(end)) return Math.max(0, end - this.video.currentTime);
        }
        return null;
    }

    updateLiveButton() {
        const btn = document.getElementById('btn-go-live');
        if (!btn) return;
        const latency = this.getLiveLatency();
        // Within ~10s of the edge counts as live; HLS segments are 4s, so a
        // tighter threshold would flicker on every segment boundary.
        const atLive = latency === null ? true : latency < 10;
        btn.classList.toggle('at-live', atLive);
        btn.title = atLive ? 'At live edge' : `Go to live (${Math.round(latency)}s behind)`;
    }

    /**
     * Stop and cleanup current transcode session
     */
    async stopTranscodeSession() {
        if (this.currentSessionId) {
            console.log('[Player] Stopping transcode session:', this.currentSessionId);
            try {
                // Fire and forget cleanup
                fetch(`/api/transcode/${this.currentSessionId}`, {
                    method: 'DELETE',
                    headers: localStorage.getItem('authToken')
                        ? { Authorization: `Bearer ${localStorage.getItem('authToken')}` } : {}
                });
            } catch (err) {
                console.error('Failed to stop session:', err);
            }
            this.currentSessionId = null;
        }
    }

    /**
     * Play a channel
     */
    async play(channel, streamUrl, options = {}) {
        this.currentChannel = channel;
        this.currentStreamUrl = streamUrl;
        // A fresh selection gets its own single audio-re-encode retry; the retry
        // itself does not (that is what stops it looping).
        if (!options.isRetry) {
            this._audioRetryKey = null;
            this._recoveredKey = null;
        }
        this._audioEncodeActive = options.audioEncode === true || this.needsAudioEncode(channel);

        try {
            // Stop current playback (this also closes out the previous play's measurement)
            this.stop();
            this.updateTranscodeStatus('hidden');
            this.beginPlayMeasurement();

            // Hide "select a channel" overlay
            this.overlay.classList.add('hidden');

            // Show custom controls overlay
            this.controlsOverlay?.classList.remove('hidden');
            this.loadingSpinner?.classList.add('show');

            this.currentUrl = streamUrl;

            // One path for every device: the server probes the channel and hands back
            // an HLS session (or, for a source that is already browser-ready, a proxied
            // direct stream). The browser-side strategies that used to live here - its
            // own probe, the piped remux, the force-* settings - are gone (0102).
            const decision = await this.resolvePlayback(channel, streamUrl, { audioEncode: options.audioEncode === true });
            if (decision === VideoPlayer.CANCELLED) {
                this.abandonPlay();
                return;
            }
            // 0180: overtaken by a newer play; leave the screen, the spinner and the retry alone.
            if (decision === VideoPlayer.SUPERSEDED) return;
            if (!decision) {
                if (this.recoverPlayback('The server could not start this channel')) return;
                this.loadingSpinner?.classList.remove('show');
                this.showError('This channel could not be started. Try again, or pick another channel.');
                return;
            }
            await this.playDecision(decision, channel);
        } catch (err) {
            console.error('Error playing channel:', err);
            this.showError('Failed to play channel');
        }
    }

    /**
     * The web player's recovery, now that there is one path: ask the server again,
     * once per selection. A fresh resolve gets a fresh HLS session - what the Apple
     * client does after a failure - so a session that failed to start, or died with a
     * fatal hls.js error (including a segment 404, which hls.js never retries), gets
     * one clean second attempt. A second failure is shown and left alone, so it can
     * never loop. Returns whether a retry was started.
     */
    recoverPlayback(reason, { audioEncode = false } = {}) {
        const key = this.channelKey(this.currentChannel);
        // The channel's identity is what is replayed (0121: the web resolves by
        // source + bare id and never holds a stream URL).
        if (!key || this._recoveredKey === key) return false;
        this._recoveredKey = key;
        console.warn(`[Player] ${reason}; asking the server again`);
        this.play(this.currentChannel, this.currentStreamUrl, { isRetry: true, audioEncode: audioEncode || this._audioEncodeActive });
        return true;
    }

    /**
     * Helper to play HLS stream (reduces duplication)
     */
    playHls(url) {
        if (this.hls) {
            this.hls.destroy();
        }

        // hls.js plays from a blob: URL, so remember the playlist's own path for the logs.
        this._playlistPath = null;
        try { this._playlistPath = new URL(url, 'http://localhost').pathname; } catch (e) { /* not a URL */ }

        const hls = new Hls(this.getHlsConfig());
        this.hls = hls;
        hls.loadSource(url);
        hls.attachMedia(this.video);

        hls.on(Hls.Events.MANIFEST_PARSED, () => {
            this.video.play().catch(e => {
                if (e.name !== 'AbortError') console.log('Autoplay prevented:', e);
            });
        });

        hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, () => {
            // The element's text tracks fill in a moment later.
            setTimeout(() => this.updateCaptionsTracks(), 100);
        });

        let mediaRecovered = false;
        hls.on(Hls.Events.ERROR, (event, data) => {
            if (!data.fatal) return;
            // hls.js's own remedy for a fatal media error (the decoder rejected a
            // buffer) is to rebuild the media pipeline in place. Once; if that does not
            // hold, the session is given up and the server is asked again.
            if (!mediaRecovered && Hls.ErrorTypes && data.type === Hls.ErrorTypes.MEDIA_ERROR) {
                mediaRecovered = true;
                console.warn('[Player] Fatal media error, recovering in place:', data.details);
                hls.recoverMediaError();
                return;
            }
            console.error('Fatal HLS error:', data);
            this.handleHlsFatal(data);
            hls.destroy();
            this.recoverPlayback(`HLS failed (${String(data.details || 'unknown')})`);
        });
    }

    /**
     * hls.js gave up on this stream. That used to leave a frozen picture and no
     * trace anywhere; say so on screen and in the server log, as handleMediaError
     * does for the element's own errors. Only the error's type, reason and HTTP
     * status are sent - never its URL, which carries the session token.
     */
    handleHlsFatal(data) {
        if (this._reportedHlsFatalFor === this.hls) return;
        this._reportedHlsFatalFor = this.hls;

        const details = String((data && data.details) || 'unknown').slice(0, 60);
        const http = data && data.response && Number.isFinite(data.response.code) ? ` http ${data.response.code}` : '';
        this.loadingSpinner?.classList.remove('show');
        // Nothing is playing any more, so the time from here to the next channel is not "watched".
        this._playingAt = null;
        this.updateTranscodeStatus('error', `Playback error (HLS ${details})`);
        this.reportClientEvent({
            ...this.describeMediaError(),
            event: 'media-error',
            code: null,
            codeName: `HLS_${String((data && data.type) || 'error').slice(0, 20)}`,
            message: `${details}${http}`
        });
    }

    /**
     * What the <video> element knows about a playback failure, in a form safe to
     * log and to send to the server. The URL is reduced to its path: the query
     * string carries the provider's address and login (url=...) and this
     * session's token, neither of which belongs in a log someone may paste.
     */
    describeMediaError(video = this.video) {
        const err = video.error;
        const names = { 1: 'MEDIA_ERR_ABORTED', 2: 'MEDIA_ERR_NETWORK', 3: 'MEDIA_ERR_DECODE', 4: 'MEDIA_ERR_SRC_NOT_SUPPORTED' };
        let path = null;
        try { path = new URL(video.currentSrc, 'http://localhost').pathname; } catch (e) { /* not a URL */ }
        // Under hls.js currentSrc is an opaque blob: URL; the playlist's path is what is useful.
        if (this.hls && this._playlistPath) path = this._playlistPath;
        const round = (n) => (Number.isFinite(n) ? Math.round(n * 10) / 10 : null);
        const buffered = video.buffered;
        return {
            code: err ? err.code : null,
            codeName: err ? (names[err.code] || 'UNKNOWN') : null,
            message: err && err.message ? String(err.message).slice(0, 200) : '',
            networkState: video.networkState,
            readyState: video.readyState,
            currentTime: round(video.currentTime),
            bufferedEnd: buffered && buffered.length ? round(buffered.end(buffered.length - 1)) : 0,
            strategy: this.hls ? 'hls' : (this.currentStrategy || 'local'),
            path
        };
    }

    /**
     * The element reported a playback error. Log it, tell the user something
     * went wrong rather than leaving a silent spinner, and report it to the
     * server so the reason is in `docker logs` and not only in this browser.
     */
    handleMediaError() {
        const video = this.video;
        if (!video || !video.error) return;
        if (this.isSourceCleared(video)) return;

        const details = this.describeMediaError(video);
        console.error(`[Player] Media error: ${details.codeName} "${details.message}" (${details.strategy}, ${details.path})`, details);
        this.loadingSpinner?.classList.remove('show');
        // hls.js recovers from many of these by itself, so leave the badge to it.
        if (!this.hls) this.updateTranscodeStatus('error', `Playback error (${details.codeName || 'unknown'})`);

        if (this._reportedMediaErrorFor !== video.currentSrc) {
            this._reportedMediaErrorFor = video.currentSrc;
            this.reportClientEvent({ event: 'media-error', ...details });
        }

        if (this.shouldRetryWithAudioEncode(details)) {
            this.retryWithAudioEncode();
        } else if (this._audioEncodeActive && this.isAudioDecodeError(details)) {
            // Re-encoding the audio did not help this channel, so do not keep
            // asking for it.
            this.rememberAudioEncode(this.currentChannel, false);
        }
    }

    /**
     * Was this error just the element reacting to its source being cleared?
     * stop() sets src to '' (changing channel, replaying a failed stream), and the
     * browser answers with "MEDIA_ELEMENT_ERROR: Empty src attribute" (code 4).
     * That is routine, not a failure - and it must not be reported or shown.
     *
     * currentSrc is NOT a reliable signal for it: Chrome still holds the *previous*
     * URL there while raising this error, which is how the first version of this
     * handler mistook every channel change for a playback failure. The src
     * attribute is: it is '' (or gone) once cleared. The message is a second,
     * independent check.
     */
    isSourceCleared(video) {
        const attribute = typeof video.getAttribute === 'function' ? video.getAttribute('src') : video.currentSrc;
        if (!attribute) return true;
        return /empty src attribute/i.test((video.error && video.error.message) || '');
    }

    /** A decode failure the browser attributes to the audio track. */
    isAudioDecodeError(details) {
        return details.code === 3 && /audio/i.test(details.message || '');
    }

    /**
     * Should a failed stream be replayed with the audio re-encoded? Chrome aborts
     * the whole element when its decoder rejects one audio frame, and a copied
     * stream hands it exactly what the provider sent, damaged frames included
     * (ffmpeg conceals them when it re-encodes). Only for an audio decode error on a
     * stream the server built (not a proxied direct one, which has nothing to
     * re-encode) that was not already re-encoding, and only once per selection.
     */
    shouldRetryWithAudioEncode(details) {
        if (!this.isAudioDecodeError(details)) return false;
        if (!this.currentStrategy || this.currentStrategy === 'direct') return false;
        if (this._audioEncodeActive) return false;
        const key = this.channelKey(this.currentChannel);
        return !!key && this._audioRetryKey !== key;
    }

    async retryWithAudioEncode() {
        const channel = this.currentChannel;
        const key = this.channelKey(channel);
        if (!key) return;
        this._audioRetryKey = key;
        this.rememberAudioEncode(channel, true);
        console.warn('[Player] Audio decode failed; replaying with the audio re-encoded');
        await this.play(channel, this.currentStreamUrl, { audioEncode: true, isRetry: true });
    }

    channelKey(channel) {
        return channel && channel.sourceId !== undefined && channel.id !== undefined
            ? `${channel.sourceId}:${channel.id}` : null;
    }

    /** Channels whose audio this browser could not decode as sent, remembered locally. */
    loadAudioEncodeChannels() {
        try {
            const list = JSON.parse(localStorage.getItem('pigtv_audio_encode') || '[]');
            return Array.isArray(list) ? list : [];
        } catch (e) {
            return [];
        }
    }

    needsAudioEncode(channel) {
        const key = this.channelKey(channel);
        if (!key) return false;
        const list = this.loadAudioEncodeChannels();
        // Before 0121 the web keyed channels by their composite id (m3u_<source>_<id>).
        const legacy = `${channel.sourceId}:${channel.sourceType === 'xtream' ? 'xtream' : 'm3u'}_${channel.sourceId}_${channel.id}`;
        return list.includes(key) || list.includes(legacy);
    }

    rememberAudioEncode(channel, on) {
        const key = this.channelKey(channel);
        if (!key) return;
        let list = this.loadAudioEncodeChannels().filter(k => k !== key);
        if (on) list = [...list, key].slice(-200);
        try { localStorage.setItem('pigtv_audio_encode', JSON.stringify(list)); } catch (e) { /* remembering is optional */ }
    }

    /** How long a load may go without anything playing before it is worth reporting. */
    get startTimeoutMs() { return 15000; }

    armStartWatch() {
        this.clearStartWatch();
        const src = this.video && this.video.currentSrc;
        if (!src) return;
        this._startWatch = setTimeout(() => this.reportStartTimeout(src), this.startTimeoutMs);
    }

    clearStartWatch() {
        if (this._startWatch) {
            clearTimeout(this._startWatch);
            this._startWatch = null;
        }
    }

    /**
     * Nothing has played since this source began loading. Report it - once - with
     * what the element knows, unless there is an innocent explanation: playback
     * was paused (autoplay refused, or the user), the source was cleared or
     * replaced, or it has in fact moved.
     */
    reportStartTimeout(src) {
        this._startWatch = null;
        const video = this.video;
        if (!video || video.currentSrc !== src || this.isSourceCleared(video)) return;
        if (video.paused || video.currentTime > 0) return;
        if (this._reportedStartTimeoutFor === src) return;
        this._reportedStartTimeoutFor = src;

        const details = { ...this.describeMediaError(video), waitedSec: Math.round(this.startTimeoutMs / 1000) };
        console.warn(`[Player] Nothing played within ${details.waitedSec}s (${details.strategy}, ${details.path})`, details);
        this.reportClientEvent({ event: 'start-timeout', ...details });
    }

    /**
     * Measurement, so the two delivery paths can be compared on evidence rather than
     * feel: how long a channel change takes to reach a picture (play-start), and how
     * a play went once it had (play-end). Both go to the server log; neither affects
     * playback. Clock is performance.now(), so it does not jump with the wall clock.
     */
    elapsedSincePlayStart() {
        return this._playT0 == null ? null : performance.now() - this._playT0;
    }

    /**
     * The person chose not to start this play after all. Put the screen back the way
     * it was before they picked the channel and drop the half-started measurement, so
     * a cancelled selection never reports a play-start or counts towards the trial.
     */
    abandonPlay() {
        this._playT0 = null;
        this._playMeta = null;
        this.currentUrl = null;
        this.loadingSpinner?.classList.remove('show');
        this.controlsOverlay?.classList.add('hidden');
        this.overlay?.classList.remove('hidden');
    }

    beginPlayMeasurement() {
        this._playT0 = performance.now();
        this._playMeta = { strategy: 'local', container: null, videoMode: null, hlsDelivery: true };
        this._resolveMs = null;
        this._playingAt = null;
        this._stalls = 0;
    }

    /** The element started playing. The first time per play, report how long it took. */
    notePlaying() {
        if (this._playT0 == null || this._playingAt != null) return;
        this._playingAt = performance.now();
        this.reportClientEvent({
            event: 'play-start',
            ...this._playMeta,
            resolveMs: this._resolveMs,
            totalMs: this._playingAt - this._playT0
        });
    }

    /** A play that got going is being closed out: say how it went, unless it was only a glimpse. */
    reportPlayEnd() {
        if (this._playingAt == null) return;
        const watchedSec = Math.round((performance.now() - this._playingAt) / 1000);
        this._playingAt = null;
        if (watchedSec < 10) return;
        this.reportClientEvent({ event: 'play-end', ...this._playMeta, watchedSec, stalls: this._stalls || 0 });
    }

    /** Best-effort diagnostics to the server. Must never affect playback. */
    reportClientEvent(payload) {
        try {
            API.streamFetch('/api/playback/client-event', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            }).catch(() => { /* diagnostics only */ });
        } catch (e) { /* diagnostics only */ }
    }

    async updateTranscodeStatus(mode, text) {
        const el = document.getElementById('player-transcode-status');
        if (!el) return;

        el.className = 'transcode-status'; // Reset classes

        if (mode === 'hidden') {
            el.classList.add('hidden');
            return;
        }

        el.textContent = text || mode;
        el.classList.add(mode);

        // Ensure it's visible
        el.classList.remove('hidden');
    }

    /**
     * Get quality label from video height
     */
    getQualityLabel(height) {
        if (height >= 2160) return '4K';
        if (height >= 1440) return '1440p';
        if (height >= 1080) return '1080p';
        if (height >= 720) return '720p';
        if (height >= 480) return '480p';
        if (height > 0) return `${height}p`;
        return null;
    }

    /**
     * Update quality badge display
     */
    updateQualityBadge() {
        const badge = document.getElementById('player-quality-badge');
        if (!badge) return;

        if (this.currentStreamInfo?.height > 0) {
            badge.textContent = this.getQualityLabel(this.currentStreamInfo.height);
            badge.classList.remove('hidden');
        } else {
            badge.classList.add('hidden');
        }
    }

    /**
     * Now/next for the current channel: the guide's loaded window (0121:
     * /api/library/guide), else the channel row's own now/next.
     */
    async fetchEpgData(channel) {
        if (!channel) return;
        try {
            const now = Date.now();
            const programmes = window.app?.epgGuide?.getProgrammesFor?.(channel) || [];
            const current = programmes.find(p => p.startMs <= now && p.stopMs > now)
                || (channel.now && channel.now.startTime <= now && channel.now.endTime > now
                    ? { title: channel.now.title, start: channel.now.startTime, stop: channel.now.endTime, description: '' } : null);
            let upcoming = programmes
                .filter(p => p.startMs > now)
                .slice(0, 5)
                .map(p => ({ title: p.title, start: new Date(p.startMs), stop: new Date(p.stopMs), description: p.description || '' }));
            if (upcoming.length === 0 && channel.next && channel.next.startTime > now) {
                upcoming = [{ title: channel.next.title, start: new Date(channel.next.startTime), stop: new Date(channel.next.endTime), description: '' }];
            }
            if (!current) {
                this.updateNowPlaying(channel, null);
                return;
            }
            this.updateNowPlaying(channel, {
                current: {
                    title: current.title,
                    start: new Date(current.startMs ?? current.start),
                    stop: new Date(current.stopMs ?? current.stop),
                    description: current.description || ''
                },
                upcoming
            });
        } catch (err) {
            console.log('EPG data not available:', err.message);
        }
    }

    /**
     * Stop playback
     */
    stop() {
        this.clearStartWatch();
        this.reportPlayEnd();
        this._playT0 = null; // nothing is being timed until the next play() begins
        // Stop any running transcode session first
        this.stopTranscodeSession();
        this.stopConflictWatch();

        if (this.hls) {
            this.hls.destroy();
            this.hls = null;
        }
        this.video.pause();
        this.video.src = '';
        this.video.load();

        // Reset UI to idle state
        this.overlay.classList.remove('hidden'); // Show "Select a channel"
        this.controlsOverlay?.classList.add('hidden'); // Hide controls
        this.loadingSpinner?.classList.remove('show');
        this.nowPlaying.classList.add('hidden');

        // Hide quality badge
        this.currentStreamInfo = null;
        this.currentStrategy = null;
        const badge = document.getElementById('player-quality-badge');
        if (badge) badge.classList.add('hidden');
    }

    /**
     * Update now playing display
     */
    updateNowPlaying(channel, epgData = null) {
        const channelName = this.nowPlaying.querySelector('.channel-name');
        const programTitle = this.nowPlaying.querySelector('.program-title');
        const programTime = this.nowPlaying.querySelector('.program-time');
        const upNextList = document.getElementById('up-next-list');

        channelName.textContent = channel.name || channel.tvgName || 'Unknown Channel';

        if (epgData && epgData.current) {
            programTitle.textContent = epgData.current.title;
            const start = new Date(epgData.current.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            const end = new Date(epgData.current.stop).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            programTime.textContent = `${start} - ${end}`;
        } else {
            programTitle.textContent = '';
            programTime.textContent = '';
        }

        // Update up next
        upNextList.innerHTML = '';
        if (epgData && epgData.upcoming) {
            epgData.upcoming.slice(0, 3).forEach(prog => {
                const li = document.createElement('li');
                const time = new Date(prog.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                li.textContent = `${time} - ${prog.title}`;
                upNextList.appendChild(li);
            });
        }
    }

    /**
     * Show error overlay
     */
    showError(message) {
        this.overlay.classList.remove('hidden');
        this.overlay.querySelector('.overlay-content').innerHTML = `<p style="color: var(--color-error);">${message}</p>`;
    }

    /**
     * Handle keyboard shortcuts
     */
    handleKeyboard(e) {
        if (document.activeElement.tagName === 'INPUT') return;

        switch (e.key) {
            case ' ':
            case 'k':
                e.preventDefault();
                this.video.paused ? this.video.play() : this.video.pause();
                break;
            case 'f':
                e.preventDefault();
                this.toggleFullscreen();
                break;
            case 'm':
                e.preventDefault();
                this.video.muted = !this.video.muted;
                break;
            case 'ArrowUp':
                if (!this.settings.arrowKeysChangeChannel) {
                    e.preventDefault();
                    this.video.volume = Math.min(1, this.video.volume + 0.1);
                }
                // If arrowKeysChangeChannel is true, let HomePage handle it
                break;
            case 'ArrowDown':
                if (!this.settings.arrowKeysChangeChannel) {
                    e.preventDefault();
                    this.video.volume = Math.max(0, this.video.volume - 0.1);
                }
                // If arrowKeysChangeChannel is true, let HomePage handle it
                break;
            case 'ArrowLeft':
                e.preventDefault();
                // Volume down when arrow keys are for channels
                if (this.settings.arrowKeysChangeChannel) {
                    this.video.volume = Math.max(0, this.video.volume - 0.1);
                }
                break;
            case 'ArrowRight':
                e.preventDefault();
                // Volume up when arrow keys are for channels
                if (this.settings.arrowKeysChangeChannel) {
                    this.video.volume = Math.min(1, this.video.volume + 0.1);
                }
                break;
            case 'PageUp':
            case 'ChannelUp':
                e.preventDefault();
                this.channelUp();
                break;
            case 'PageDown':
            case 'ChannelDown':
                e.preventDefault();
                this.channelDown();
                break;
            case 'i':
                // Show/hide info overlay
                e.preventDefault();
                if (this.nowPlaying.classList.contains('hidden')) {
                    this.showNowPlayingOverlay();
                } else {
                    this.hideNowPlayingOverlay();
                }
                break;
        }
    }

    /**
     * Go to previous channel
     */
    channelUp() {
        if (!window.app?.channelList) return;
        const channels = window.app.channelList.getVisibleChannels();
        if (channels.length === 0) return;

        const currentIdx = this.currentChannel
            ? channels.findIndex(c => c.id === this.currentChannel.id && String(c.sourceId) === String(this.currentChannel.sourceId))
            : -1;

        const prevIdx = currentIdx <= 0 ? channels.length - 1 : currentIdx - 1;
        window.app.channelList.selectChannel({ channelId: channels[prevIdx].id, sourceId: channels[prevIdx].sourceId });
    }

    /**
     * Go to next channel
     */
    channelDown() {
        if (!window.app?.channelList) return;
        const channels = window.app.channelList.getVisibleChannels();
        if (channels.length === 0) return;

        const currentIdx = this.currentChannel
            ? channels.findIndex(c => c.id === this.currentChannel.id && String(c.sourceId) === String(this.currentChannel.sourceId))
            : -1;

        const nextIdx = currentIdx >= channels.length - 1 ? 0 : currentIdx + 1;
        window.app.channelList.selectChannel({ channelId: channels[nextIdx].id, sourceId: channels[nextIdx].sourceId });
    }

    /**
     * Toggle fullscreen
     */
    toggleFullscreen() {
        if (document.fullscreenElement) {
            document.exitFullscreen();
        } else if (this.container) {
            this.container.requestFullscreen();
        }
    }
}

// What resolvePlayback returns when the person declined to take the provider's only
// stream. Distinct from null, which means "no resolve endpoint here - fall back to the
// local strategy": the two used to share null, so cancelling fell through to the local
// path and took the stream regardless.
VideoPlayer.CANCELLED = Symbol('playback-cancelled');
VideoPlayer.SUPERSEDED = Symbol('playback-superseded');

// Export
window.VideoPlayer = VideoPlayer;
