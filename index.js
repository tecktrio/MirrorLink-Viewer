let db;
let files = [];
let currentIndex = 0;
let initialServerIndex = 0;
let ContentElement = [];
let key = "";

let savedMirrorName = "";
let wsConnection = null;
let slideshowTimer = null;
let currentVideoElement = null;
let isSlideshowActive = false;
let isReloading = false;
let isPaused = false;
let rawContents = [];
let lastKnownTimestamp = 0;
let lastKnownSyncTimestamp = 0;
let pollInterval = null;
let mirrorPhotoDuration = 5;

const SERVER_URL = "https://mirrorlink.bigburry.com/api/Mirror";
const SERVER_WEBSOCKET_URL = "wss://mirrorlink.bigburry.com/mirror?";

function updateSyncProgress(msg) {
    const syncStatusText = document.getElementById("sync_status_text");
    if (syncStatusText) {
        syncStatusText.textContent = msg;
    }
}

function showStandbyScreen() {
    const loadingText = document.getElementById('loadingText');
    const startBanner = document.getElementById('startBanner');
    const loginContainer = document.getElementById('login_container');
    const slideshowContainer = document.getElementById('slideshowContainer');

    if (slideshowContainer) slideshowContainer.style.display = "none";
    if (loginContainer) loginContainer.style.display = "flex";
    if (loadingText) loadingText.style.display = "none";
    if (startBanner) {
        startBanner.innerHTML = `
            <div class="ready-badge" style="border-color: rgba(59, 130, 246, 0.4); background: rgba(59, 130, 246, 0.1); color: #60a5fa;">
                <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#38bdf8;box-shadow:0 0 8px #38bdf8;"></span>
                <span>Connected to <strong>${savedMirrorName || "Mirror"}</strong></span>
            </div>
            <div style="margin-top: 14px; text-align: center; color: #94a3b8; font-size: 13px; line-height: 1.5;">
                <p style="margin: 0; color: #f1f5f9; font-weight: 600;">Display Standby Active</p>
                <p style="margin: 4px 0 0; font-size: 12px; color: #64748b;">Awaiting media contents from MirrorLink setup.<br>Presentation starts automatically once media is assigned.</p>
            </div>
        `;
        startBanner.style.display = 'block';
    }
}

function showLoginDialog() {
    const loginContainer = document.getElementById('login_container');
    const loadingText = document.getElementById('loadingText');
    const startBanner = document.getElementById('startBanner');
    const loading_button = document.getElementById("loading_button");
    const login_button = document.getElementById("login_button");
    const slideshowContainer = document.getElementById('slideshowContainer');

    if (slideshowContainer) slideshowContainer.style.display = 'none';
    if (loginContainer) loginContainer.style.display = 'flex';
    if (loadingText) loadingText.style.display = 'block';
    if (startBanner) startBanner.style.display = 'none';
    if (loading_button) loading_button.style.display = 'none';
    if (login_button) login_button.style.display = 'flex';

    const mInput = document.getElementById("mirror_name");
    if (mInput) {
        mInput.value = "";
        mInput.focus();
    }
}

// Auto-connect when mirror_name is present in URL, otherwise show login dialog
function initAutoConnect() {
    try {
        const urlParams = new URLSearchParams(window.location.search);
        const queryMirrorName = urlParams.get('mirror_name') || urlParams.get('name');
        
        if (queryMirrorName && queryMirrorName.trim() !== '') {
            const cleanName = queryMirrorName.trim();
            console.log("Auto-connecting to mirror from URL parameter:", cleanName);
            const mInput = document.getElementById("mirror_name");
            if (mInput) mInput.value = cleanName;

            const loading_button = document.getElementById("loading_button");
            const login_button = document.getElementById("login_button");
            if (loading_button) loading_button.style.display = 'flex';
            if (login_button) login_button.style.display = 'none';
            updateSyncProgress(`Connecting to ${cleanName}...`);

            // Start immediately
            Login();
        } else {
            console.log("No mirror_name in URL. Presenting mirror name dialog.");
            showLoginDialog();
        }
    } catch (e) {
        console.warn("Auto-connect notice:", e);
        showLoginDialog();
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initAutoConnect);
} else {
    initAutoConnect();
}

function Login(e) {
    console.log("Connecting mirror stream by name...");
    if (e) {
        if (e.preventDefault) e.preventDefault();
        // User gesture detected: immediately request fullscreen
        enterFullscreen();
    }

    const mirrorNameInput = document.getElementById("mirror_name");
    const mirrorName = mirrorNameInput ? mirrorNameInput.value.trim() : "";
    const errorText = document.getElementById("error");
    const loading_button = document.getElementById("loading_button");
    const login_button = document.getElementById("login_button");

    if (loading_button) loading_button.style.display = 'flex';
    if (login_button) login_button.style.display = 'none';
    updateSyncProgress(`Connecting to ${mirrorName}...`);

    if (!mirrorName) {
        alert("Mirror Name is required.");
        if (loading_button) loading_button.style.display = 'none';
        if (login_button) login_button.style.display = 'flex';
        return;
    }

    savedMirrorName = mirrorName;
    try {
        localStorage.setItem('mirror_saved_name', mirrorName);
    } catch (err) {}

    let request_data = {
        'mirror_name': mirrorName,
        'service': 'login'
    };

    fetch(SERVER_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(request_data)
    })
    .then(response => response.json())
    .then((data) => {
        if (data.status_code === 401 || data.status_code === 400 || data.status_code === 404) {
            if (errorText) {
                errorText.innerHTML = data.status_text || `Mirror "${mirrorName}" not found. Check the mirror name.`;
                errorText.style.display = 'block';
            }
            if (loading_button) loading_button.style.display = 'none';
            if (login_button) login_button.style.display = 'flex';
            return;
        }

        console.log(`Mirror stream "${mirrorName}" connected successfully.`);
        if (errorText) errorText.style.display = 'none';

        // Connect real-time WebSocket and polling fallback for remote refresh messages
        connectWebSocket(mirrorName);
        startPollingFallback();

        if (data.photo_duration) {
            mirrorPhotoDuration = Number(data.photo_duration);
            console.log("Configured mirror photo transition duration:", mirrorPhotoDuration, "seconds");
        }
        if (data.active_content_index !== undefined) {
            initialServerIndex = Number(data.active_content_index);
            currentIndex = initialServerIndex;
            console.log("Synchronized to server slide index:", currentIndex);
        }
        if (data.sync_timestamp) {
            lastKnownSyncTimestamp = data.sync_timestamp;
        }
        if (data.playback_state === 'paused') {
            isPaused = true;
        }

        rawContents = (data.data || []).filter(item => item && item.content_url && item.is_active !== false);
        
        if (rawContents.length === 0) {
            console.log("No media assigned to this mirror yet.");
            showStandbyScreen();
            return;
        }

        console.log(`Loaded ${rawContents.length} media item(s). Starting presentation immediately.`);
        ContentElement = createElementsFromContents(rawContents);
        if (initialServerIndex !== undefined && ContentElement.length > 0) {
            currentIndex = initialServerIndex % ContentElement.length;
        } else {
            currentIndex = 0;
        }

        // Start presentation immediately without waiting
        startSlideshow();
    })
    .catch((error) => {
        console.error("Mirror connect error:", error);
        if (errorText) {
            errorText.innerText = "Network connection error: " + error.message;
            errorText.style.display = 'block';
        }
        if (loading_button) loading_button.style.display = 'none';
        if (login_button) login_button.style.display = 'flex';
    });
}

function connectWebSocket(mirrorName) {
    if (wsConnection) {
        try {
            wsConnection.onclose = null;
            wsConnection.close();
        } catch (e) {}
    }

    const wsUrl = `${SERVER_WEBSOCKET_URL}mirror_name=${encodeURIComponent(mirrorName)}`;
    console.log("[Mirror WebSocket] Connecting stream for:", mirrorName);

    try {
        wsConnection = new WebSocket(wsUrl);

        wsConnection.onopen = () => {
            console.log("[Mirror WebSocket] Connected to MirrorLink Server successfully for mirror:", mirrorName);
        };

        wsConnection.onmessage = (event) => {
            console.log("[Mirror WebSocket] Message received:", event.data);
            try {
                const message = JSON.parse(event.data);
                const payload = message.data !== undefined ? message.data : message;
                const service = message.service || (payload && payload.service);

                if (service === 'ReloadContents' || service === 'ReloadMirror' || service === 'refresh' || service === 'RefreshMirror') {
                    console.log("[Mirror WebSocket] Reload trigger received! Reloading new contents...");
                    const incomingList = Array.isArray(payload) ? payload : (payload && payload.contents ? payload.contents : null);
                    reloadMirrorContents(incomingList);
                } else if (service === 'PlaybackControl') {
                    const action = payload.action;
                    console.log("[Mirror WebSocket] Playback control signal received:", action);
                    setPlaybackState(action === 'pause' || action === 'paused' ? 'paused' : 'playing');
                } else if (service === 'SyncSlide') {
                    const targetIndex = payload.index;
                    console.log("[Mirror WebSocket] Sync slide signal received:", targetIndex, payload);
                    if (targetIndex !== undefined && ContentElement.length > 0) {
                        const newIdx = Number(targetIndex) % ContentElement.length;
                        if (newIdx !== currentIndex) {
                            currentIndex = newIdx;
                            if (!isPaused && isSlideshowActive) {
                                showCurrentFile(false); // don't re-broadcast on remote sync
                            }
                        } else {
                            // Align local slideshow timer with remote sync timing
                            if (slideshowTimer) clearTimeout(slideshowTimer);
                            if (!isPaused && isSlideshowActive) {
                                const activeMeta = rawContents && rawContents[currentIndex];
                                const durationSec = (activeMeta && activeMeta.duration) ? Number(activeMeta.duration) : (mirrorPhotoDuration || 5);
                                slideshowTimer = setTimeout(() => {
                                    if (!isPaused) {
                                        currentIndex = (currentIndex + 1) % ContentElement.length;
                                        showCurrentFile(true);
                                    }
                                }, Math.max(1, durationSec) * 1000);
                            }
                        }
                    }
                } else if (service === 'UpdateSettings' || service === 'SetPhotoSpeed') {
                    if (payload && payload.photo_duration) {
                        mirrorPhotoDuration = Number(payload.photo_duration);
                        console.log("[Mirror WebSocket] Updated photo transition duration to:", mirrorPhotoDuration, "seconds");
                    }
                    if (payload && payload.content_id && payload.duration && rawContents) {
                        const target = rawContents.find(c => String(c._id) === String(payload.content_id));
                        if (target) {
                            target.duration = Number(payload.duration);
                            console.log("[Mirror WebSocket] Updated photo duration for content:", target._id, "to", target.duration, "s");
                        }
                    }
                }
            } catch (err) {
                console.error("[Mirror WebSocket] Error handling message:", err);
            }
        };

        wsConnection.onerror = (err) => {
            console.warn("[Mirror WebSocket] Connection notice:", err);
        };

        wsConnection.onclose = () => {
            console.log("[Mirror WebSocket] Connection closed. Auto-reconnecting in 4 seconds...");
            setTimeout(() => {
                if (savedMirrorName) {
                    connectWebSocket(savedMirrorName);
                }
            }, 4000);
        };
    } catch (e) {
        console.error("[Mirror WebSocket] Failed to initialize:", e);
    }
}

function startPollingFallback() {
    if (pollInterval) clearInterval(pollInterval);
    pollInterval = setInterval(() => {
        if (!savedMirrorName || isReloading) return;

        fetch(SERVER_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                mirror_name: savedMirrorName,
                service: 'CheckMirrorUpdate'
            })
        })
        .then(res => res.json())
        .then(resData => {
            if (!resData) return;

            // 1. Refresh detection
            if (resData.last_refresh_timestamp) {
                if (lastKnownTimestamp === 0) {
                    lastKnownTimestamp = resData.last_refresh_timestamp;
                } else if (resData.last_refresh_timestamp > lastKnownTimestamp) {
                    console.log("[Mirror Poll] New refresh timestamp detected:", resData.last_refresh_timestamp);
                    lastKnownTimestamp = resData.last_refresh_timestamp;
                    reloadMirrorContents(resData.data);
                    return;
                }
            }

            // 2. Playback state detection (Pause / Play)
            if (resData.playback_state) {
                if (resData.playback_state === 'paused' && !isPaused) {
                    console.log("[Mirror Poll] Detected paused state from server");
                    setPlaybackState('paused');
                } else if (resData.playback_state === 'playing' && isPaused) {
                    console.log("[Mirror Poll] Detected playing state from server");
                    setPlaybackState('playing');
                }
            }

            // 3. Slide sync detection
            if (resData.sync_timestamp && resData.sync_timestamp > lastKnownSyncTimestamp) {
                lastKnownSyncTimestamp = resData.sync_timestamp;
                if (resData.active_content_index !== undefined && ContentElement.length > 0) {
                    const newIdx = Number(resData.active_content_index) % ContentElement.length;
                    if (newIdx !== currentIndex) {
                        console.log("[Mirror Poll] Synchronizing to index:", newIdx);
                        currentIndex = newIdx;
                        if (!isPaused && isSlideshowActive) {
                            showCurrentFile(false);
                        }
                    }
                }
            }

            // 4. Photo speed / duration detection
            if (resData.photo_duration) {
                mirrorPhotoDuration = Number(resData.photo_duration);
            }
        })
        .catch(() => {});
    }, 2500);
}

function createElementsFromContents(contents) {
    if (!contents || !Array.isArray(contents)) return [];

    return contents.map((item) => {
        if (!item || !item.content_url) return null;
        const url = item.content_url;
        const isVideo = (item.content_format && item.content_format.toLowerCase().includes('video')) ||
                        /\.(mp4|webm|ogg|mov)(\?.*)?$/i.test(url);

        if (isVideo) {
            const video = document.createElement('video');
            video.src = url;
            video.controls = false;
            video.loop = false;
            video.autoplay = true;
            video.muted = true;
            video.playsInline = true;
            video.setAttribute('playsinline', '');
            video.setAttribute('webkit-playsinline', '');
            video.style.width = "100vw";
            video.style.height = "100vh";
            video.style.objectFit = "cover";
            video.style.position = "fixed";
            video.style.top = "0";
            video.style.left = "0";
            video.style.zIndex = "10";
            video.style.background = "#000";
            video.preload = "auto";
            return video;
        } else {
            const img = document.createElement('img');
            img.src = url;
            img.style.width = "100vw";
            img.style.height = "100vh";
            img.style.objectFit = "cover";
            img.style.position = "fixed";
            img.style.top = "0";
            img.style.left = "0";
            img.style.zIndex = "10";
            img.style.background = "#000";
            return img;
        }
    }).filter(Boolean);
}

function reloadMirrorContents(incomingContents) {
    if (isReloading) {
        console.log("Reload already in progress, skipping duplicate call...");
        return;
    }
    isReloading = true;
    console.log("Starting mirror reload & restart sequence...");

    // 1. Immediately pause and clear existing playback timers and video streams
    if (slideshowTimer) {
        clearTimeout(slideshowTimer);
        slideshowTimer = null;
    }
    if (currentVideoElement) {
        try {
            currentVideoElement.pause();
            currentVideoElement.onended = null;
            currentVideoElement.src = "";
        } catch (e) {}
        currentVideoElement = null;
    }

    // 2. Fetch fresh content list if not provided directly
    const fetchFreshPromise = incomingContents && Array.isArray(incomingContents)
        ? Promise.resolve(incomingContents)
        : fetch(SERVER_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                mirror_name: savedMirrorName,
                service: 'login'
            })
        })
        .then(res => res.json())
        .then(data => data.data || [])
        .catch(err => {
            console.error("Error fetching fresh contents on reload:", err);
            return [];
        });

    fetchFreshPromise.then(contents => {
        isReloading = false;
        rawContents = (contents || []).filter(item => item && item.content_url && item.is_active !== false);
        console.log(`Fetched ${rawContents.length} fresh content item(s) for mirror.`);

        ContentElement = createElementsFromContents(rawContents);

        const slideshowContainer = document.getElementById('slideshowContainer');
        if (slideshowContainer) {
            slideshowContainer.innerHTML = '';
        }

        // If mirror has content, immediately launch/refresh presentation
        if (ContentElement.length > 0) {
            if (initialServerIndex !== undefined && ContentElement.length > 0) {
                currentIndex = initialServerIndex % ContentElement.length;
            } else {
                currentIndex = 0;
            }
            startSlideshow();
        } else {
            showStandbyScreen();
        }
    });
}

function checkFullscreenKioskPrompt() {
    const isFs = !!(document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement || document.msFullscreenElement);
    let prompt = document.getElementById('kiosk-fullscreen-prompt');
    if (isFs) {
        if (prompt) prompt.remove();
        return;
    }
    if (!isSlideshowActive) return;

    if (!prompt) {
        prompt = document.createElement('div');
        prompt.id = 'kiosk-fullscreen-prompt';
        prompt.style.cssText = "position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:99999;background:rgba(15,23,42,0.9);backdrop-filter:blur(12px);border:1px solid rgba(168,85,247,0.6);color:#f8fafc;padding:10px 22px;border-radius:9999px;font-family:system-ui,-apple-system,sans-serif;font-size:13px;font-weight:600;letter-spacing:0.02em;display:flex;align-items:center;gap:10px;box-shadow:0 12px 32px rgba(0,0,0,0.6);cursor:pointer;user-select:none;transition:all 0.2s ease;";
        prompt.innerHTML = `
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#a855f7" stroke-width="2.5"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>
            <span>Tap / Click anywhere for Kiosk Full-Screen</span>
        `;
        prompt.addEventListener('click', (e) => {
            e.stopPropagation();
            enterFullscreen();
        });
        document.body.appendChild(prompt);
    }
}

function enterFullscreen() {
    const docEl = document.documentElement;
    const isFs = !!(document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement || document.msFullscreenElement);
    if (isFs) {
        const prompt = document.getElementById('kiosk-fullscreen-prompt');
        if (prompt) prompt.remove();
        return;
    }

    try {
        const req = docEl.requestFullscreen || docEl.webkitRequestFullscreen || docEl.mozRequestFullScreen || docEl.msRequestFullscreen;
        if (req) {
            const p = req.call(docEl);
            if (p && p.then) {
                p.then(() => {
                    const prompt = document.getElementById('kiosk-fullscreen-prompt');
                    if (prompt) prompt.remove();
                    document.body.classList.add('hide-cursor');
                }).catch(err => {
                    console.log("Fullscreen request notice:", err.message);
                    checkFullscreenKioskPrompt();
                });
            }
        }
    } catch (e) {
        console.warn("Fullscreen request error:", e);
        checkFullscreenKioskPrompt();
    }
}

function startSlideshow() {
    isSlideshowActive = true;
    enterFullscreen();
    document.body.classList.add('hide-cursor');

    const slideshowContainer = document.getElementById('slideshowContainer');
    const login_container = document.getElementById('login_container');

    if (login_container) login_container.style.display = 'none';
    if (slideshowContainer) slideshowContainer.style.display = 'block';

    if (!ContentElement || ContentElement.length === 0) {
        showStandbyScreen();
        return;
    }

    if (initialServerIndex !== undefined && ContentElement.length > 0) {
        currentIndex = initialServerIndex % ContentElement.length;
    } else {
        currentIndex = 0;
    }
    showCurrentFile();

    // Verify fullscreen activation; if browser blocked auto-fullscreen without gesture, present prompt
    setTimeout(() => {
        enterFullscreen();
    }, 400);
}

function reportActiveSlide(contentId, index) {
    if (!savedMirrorName) return;

    const payload = {
        service: 'UpdateActiveSlide',
        mirror_name: savedMirrorName,
        content_id: contentId || null,
        index: index !== undefined ? index : 0
    };

    if (wsConnection && wsConnection.readyState === WebSocket.OPEN) {
        try {
            wsConnection.send(JSON.stringify(payload));
        } catch (e) {}
    }

    fetch(SERVER_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    }).catch(() => {});
}

function setPlaybackState(targetState) {
    const shouldPause = (targetState === 'paused' || targetState === 'pause');
    if (shouldPause) {
        isPaused = true;
        if (slideshowTimer) {
            clearTimeout(slideshowTimer);
            slideshowTimer = null;
        }
        if (currentVideoElement) {
            try {
                currentVideoElement.pause();
            } catch (e) {}
        }

        let pauseIndicator = document.getElementById('mirror-pause-indicator');
        if (!pauseIndicator) {
            pauseIndicator = document.createElement('div');
            pauseIndicator.id = 'mirror-pause-indicator';
            pauseIndicator.innerHTML = `
                <div style="position:fixed;top:24px;right:24px;z-index:99999;background:rgba(15,23,42,0.85);backdrop-filter:blur(12px);border:1px solid rgba(251,191,36,0.6);color:#fbbf24;padding:8px 18px;border-radius:9999px;font-family:system-ui,-apple-system,sans-serif;font-size:13px;font-weight:700;letter-spacing:0.05em;display:flex;align-items:center;gap:8px;box-shadow:0 10px 25px rgba(0,0,0,0.5);pointer-events:none;">
                    <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#fbbf24;box-shadow:0 0 8px #fbbf24;"></span>
                    <span>PAUSED</span>
                </div>
            `;
            document.body.appendChild(pauseIndicator);
        }
    } else {
        const wasPaused = isPaused;
        isPaused = false;

        const pauseIndicator = document.getElementById('mirror-pause-indicator');
        if (pauseIndicator) {
            pauseIndicator.remove();
        }

        if (wasPaused && isSlideshowActive && ContentElement.length > 0) {
            const currentEl = ContentElement[currentIndex];
            if (currentEl && currentEl.tagName === "VIDEO" && currentVideoElement) {
                currentVideoElement.play().catch(() => {});
            } else {
                if (slideshowTimer) clearTimeout(slideshowTimer);
                slideshowTimer = setTimeout(() => {
                    if (!isPaused) {
                        currentIndex = (currentIndex + 1) % ContentElement.length;
                        showCurrentFile();
                    }
                }, 4000);
            }
        }
    }
}

async function showCurrentFile(shouldBroadcast = true) {
    const slideshowContainer = document.getElementById('slideshowContainer');
    const login_container = document.getElementById('login_container');
    if (login_container) login_container.style.display = 'none';

    if (!slideshowContainer) return;

    if (slideshowTimer) {
        clearTimeout(slideshowTimer);
        slideshowTimer = null;
    }
    if (currentVideoElement) {
        try {
            currentVideoElement.pause();
            currentVideoElement.onended = null;
        } catch (e) {}
        currentVideoElement = null;
    }

    if (!ContentElement || ContentElement.length === 0) {
        slideshowContainer.innerHTML = '<div style="color:white;display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;font-size:20px;letter-spacing:1px;background:#030712;"><span>Screen Idle — No media assigned to this mirror</span></div>';
        return;
    }

    if (currentIndex >= ContentElement.length) {
        if (initialServerIndex !== undefined && ContentElement.length > 0) {
        currentIndex = initialServerIndex % ContentElement.length;
    } else {
        currentIndex = 0;
    }
    }

    // Determine content ID and broadcast active slide to connected controller
    const activeMeta = rawContents && rawContents[currentIndex];
    const activeCid = activeMeta ? (activeMeta._id || activeMeta.id) : null;
    if (shouldBroadcast) {
        reportActiveSlide(activeCid, currentIndex);
    }

    if (isPaused) {
        return;
    }

    slideshowContainer.innerHTML = '';
    const content = ContentElement[currentIndex];

    if (content.tagName === "VIDEO") {
        currentVideoElement = content;
        content.currentTime = 0;
        slideshowContainer.appendChild(content);

        content.play().then(() => {
            content.onended = function () {
                if (!isPaused) {
                    currentIndex = (currentIndex + 1) % ContentElement.length;
                    showCurrentFile();
                }
            };
        }).catch(error => {
            console.error("Failed to autoplay video:", error);
            slideshowTimer = setTimeout(() => {
                if (!isPaused) {
                    currentIndex = (currentIndex + 1) % ContentElement.length;
                    showCurrentFile();
                }
            }, 4000);
        });
    } else {
        slideshowContainer.appendChild(content);
        const durationSec = (activeMeta && activeMeta.duration) ? Number(activeMeta.duration) : (mirrorPhotoDuration || 5);
        const durationMs = Math.max(1, durationSec) * 1000;
        slideshowTimer = setTimeout(() => {
            if (!isPaused) {
                currentIndex = (currentIndex + 1) % ContentElement.length;
                showCurrentFile();
            }
        }, durationMs);
    }
}

// TV Remote, Mouse, & Touch listeners to ensure immersive full screen
['click', 'pointerdown', 'touchstart'].forEach(evt => {
    document.addEventListener(evt, () => {
        enterFullscreen();
    }, { passive: true });
});

['fullscreenchange', 'webkitfullscreenchange', 'mozfullscreenchange', 'MSFullscreenChange'].forEach(evt => {
    document.addEventListener(evt, () => {
        const isFs = !!(document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement || document.msFullscreenElement);
        const prompt = document.getElementById('kiosk-fullscreen-prompt');
        if (isFs) {
            if (prompt) prompt.remove();
            document.body.classList.add('hide-cursor');
        } else if (isSlideshowActive) {
            checkFullscreenKioskPrompt();
        }
    });
});

document.addEventListener('keydown', (e) => {
    if (isSlideshowActive) {
        enterFullscreen();
        if (e.key === 'p' || e.key === 'P' || e.key === ' ') {
            e.preventDefault();
            const targetState = isPaused ? 'playing' : 'paused';
            setPlaybackState(targetState);
            const req = { service: 'PlaybackControl', action: targetState, mirror_name: savedMirrorName };
            if (wsConnection && wsConnection.readyState === WebSocket.OPEN) {
                try { wsConnection.send(JSON.stringify(req)); } catch(err){}
            }
            fetch(SERVER_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(req)
            }).catch(() => {});
        }
    }
});

// Auto-hide mouse cursor after 2 seconds of inactivity on Smart TVs
let mouseInactivityTimer = null;
document.addEventListener('mousemove', () => {
    if (!isSlideshowActive) return;
    document.body.classList.remove('hide-cursor');
    if (mouseInactivityTimer) clearTimeout(mouseInactivityTimer);
    mouseInactivityTimer = setTimeout(() => {
        if (isSlideshowActive) {
            document.body.classList.add('hide-cursor');
        }
    }, 2000);
});
