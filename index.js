let currentIndex = 0;
let initialServerIndex = 0;
let savedMirrorName = "";
let slideshowTimer = null;
let isSlideshowActive = false;
let isReloading = false;
let isPaused = false;
let rawContents = [];
let lastKnownTimestamp = 0;
let lastKnownSyncTimestamp = 0;
let pollTimeout = null;
let mirrorPhotoDuration = 5;

const SERVER_URL = "https://mirrorlink.bigburry.com/api/Mirror";
const SERVER_STREAM_URL = "https://mirrorlink.bigburry.com/api/MirrorStream";
let mirrorEventSource = null;

// Low-RAM Smart TV Architecture: Single Reusable DOM Elements
function getSlideshowImage() {
    let img = document.getElementById("slideshowImage");
    if (!img) {
        const container = document.getElementById("slideshowContainer");
        if (container) {
            img = document.createElement("img");
            img.id = "slideshowImage";
            img.style.display = "none";
            container.appendChild(img);
        }
    }
    return img;
}

function getSlideshowVideo() {
    let vid = document.getElementById("slideshowVideo");
    if (!vid) {
        const container = document.getElementById("slideshowContainer");
        if (container) {
            vid = document.createElement("video");
            vid.id = "slideshowVideo";
            vid.muted = true;
            vid.autoplay = true;
            vid.controls = false;
            vid.loop = false;
            vid.playsInline = true;
            vid.setAttribute("playsinline", "");
            vid.setAttribute("webkit-playsinline", "");
            vid.preload = "auto";
            vid.setAttribute("preload", "auto");
            vid.style.display = "none";
            container.appendChild(vid);
        }
    }
    return vid;
}

// Critical for Smart TVs: Force release of hardware video decoder & GPU bitmap memory
function releaseMediaResources() {
    pauseKeepAwakeMedia();
    if (slideshowTimer) {
        clearTimeout(slideshowTimer);
        slideshowTimer = null;
    }

    const vidEl = getSlideshowVideo();
    if (vidEl) {
        try {
            vidEl.pause();
            vidEl.onended = null;
            vidEl.onerror = null;
            vidEl.removeAttribute("src");
            // Do NOT call vidEl.load() with an empty src - causes native WebKit segfault on Smart TVs
        } catch (e) { }
        vidEl.style.display = "none";
    }

    const imgEl = getSlideshowImage();
    if (imgEl) {
        try {
            imgEl.onload = null;
            imgEl.onerror = null;
            imgEl.removeAttribute("src"); // Releases GPU bitmap memory
        } catch (e) { }
        imgEl.style.display = "none";
    }
}

function updateSyncProgress(msg) {
    const syncStatusText = document.getElementById("sync_status_text");
    if (syncStatusText) {
        syncStatusText.textContent = msg;
    }
}

// ==========================================
// Kiosk Display Keep-Awake / Anti-Screensaver Engine
// ==========================================
let screenWakeLock = null;
let keepAwakeVideoEl = null;

function requestScreenWakeLock() {
    // 1. Standard W3C Screen Wake Lock API (Chrome, Safari iOS 16.4+, Android TV, modern webOS)
    if ('wakeLock' in navigator && typeof navigator.wakeLock.request === 'function') {
        try {
            navigator.wakeLock.request('screen').then(lock => {
                screenWakeLock = lock;
                console.log("[KeepAwake] Standard Screen Wake Lock acquired.");
                screenWakeLock.addEventListener('release', () => {
                    screenWakeLock = null;
                    if (document.visibilityState === 'visible' && isSlideshowActive) {
                        requestScreenWakeLock();
                    }
                });
            }).catch(err => {
                console.warn("[KeepAwake] Wake Lock request:", err);
            });
        } catch (e) { }
    }

    // 2. Samsung Tizen TV Native Power API
    try {
        if (window.tizen && window.tizen.power && typeof window.tizen.power.request === 'function') {
            window.tizen.power.request('SCREEN', 'SCREEN_NORMAL');
            console.log("[KeepAwake] Samsung Tizen SCREEN_NORMAL power lock requested.");
        }
    } catch (e) { }

    // 3. LG webOS TV Native Power API
    try {
        if (window.webOS && typeof window.webOS.service === 'object' && typeof window.webOS.service.request === 'function') {
            window.webOS.service.request('luna://com.webos.service.tv.power', {
                method: 'turnOffScreenSaver',
                parameters: {},
                onSuccess: function () { },
                onFailure: function () { }
            });
        }
    } catch (e) { }
}

function getKeepAwakeVideo() {
    if (!keepAwakeVideoEl) {
        keepAwakeVideoEl = document.getElementById("keepAwakeVideo");
        if (!keepAwakeVideoEl) {
            keepAwakeVideoEl = document.createElement("video");
            keepAwakeVideoEl.id = "keepAwakeVideo";
            keepAwakeVideoEl.muted = true;
            keepAwakeVideoEl.playsInline = true;
            keepAwakeVideoEl.setAttribute("playsinline", "");
            keepAwakeVideoEl.setAttribute("webkit-playsinline", "");
            keepAwakeVideoEl.loop = true;
            keepAwakeVideoEl.setAttribute("loop", "");
            keepAwakeVideoEl.preload = "auto";
            keepAwakeVideoEl.src = "keepawake.mp4";
            keepAwakeVideoEl.style.cssText = "position:fixed;bottom:0;right:0;width:1px;height:1px;opacity:0.01;pointer-events:none;z-index:-1;";
            document.body.appendChild(keepAwakeVideoEl);
        }
    }
    return keepAwakeVideoEl;
}

function startKeepAwakeMedia() {
    try {
        const v = getKeepAwakeVideo();
        if (v && v.paused) {
            v.play().catch(() => { });
        }
    } catch (e) { }
}

function pauseKeepAwakeMedia() {
    try {
        if (keepAwakeVideoEl && !keepAwakeVideoEl.paused) {
            keepAwakeVideoEl.pause();
        }
    } catch (e) { }
}

function enableKeepAwake() {
    requestScreenWakeLock();
    // Only start background keep-awake video if not already showing an active video slide
    const vidEl = getSlideshowVideo();
    const isPlayingSlideVideo = vidEl && vidEl.style.display !== "none" && !vidEl.paused;
    if (!isPlayingSlideVideo) {
        startKeepAwakeMedia();
    }
}

function showStandbyScreen() {
    releaseMediaResources();
    isSlideshowActive = false;
    document.body.classList.remove("slideshow-active");

    const loadingText = document.getElementById("loadingText");
    const startBanner = document.getElementById("startBanner");
    const loginContainer = document.getElementById("login_container");
    const slideshowContainer = document.getElementById("slideshowContainer");

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
        startBanner.style.display = "block";
    }
}

function showLoginDialog() {
    releaseMediaResources();
    isSlideshowActive = false;
    document.body.classList.remove("slideshow-active");

    const loginContainer = document.getElementById("login_container");
    const loadingText = document.getElementById("loadingText");
    const startBanner = document.getElementById("startBanner");
    const loading_button = document.getElementById("loading_button");
    const login_button = document.getElementById("login_button");
    const slideshowContainer = document.getElementById("slideshowContainer");

    if (slideshowContainer) slideshowContainer.style.display = "none";
    if (loginContainer) loginContainer.style.display = "flex";
    if (loadingText) loadingText.style.display = "block";
    if (startBanner) startBanner.style.display = "none";
    if (loading_button) loading_button.style.display = "none";
    if (login_button) login_button.style.display = "flex";

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
        const queryMirrorName = urlParams.get("mirror_name") || urlParams.get("name");

        if (queryMirrorName && queryMirrorName.trim() !== "") {
            const cleanName = queryMirrorName.trim();
            console.log("Auto-connecting to mirror from URL parameter:", cleanName);
            const mInput = document.getElementById("mirror_name");
            if (mInput) mInput.value = cleanName;

            const loading_button = document.getElementById("loading_button");
            const login_button = document.getElementById("login_button");
            if (loading_button) loading_button.style.display = "flex";
            if (login_button) login_button.style.display = "none";
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

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initAutoConnect);
} else {
    initAutoConnect();
}

function Login(e) {
    console.log("Connecting mirror stream by name...");
    if (e) {
        if (e.preventDefault) e.preventDefault();
        enterFullscreen();
    }

    const mirrorNameInput = document.getElementById("mirror_name");
    const mirrorName = mirrorNameInput ? mirrorNameInput.value.trim() : "";
    const errorText = document.getElementById("error");
    const loading_button = document.getElementById("loading_button");
    const login_button = document.getElementById("login_button");

    if (!mirrorName) {
        console.warn("Mirror Name is required.");
        if (errorText) {
            errorText.innerText = "Please enter a valid Mirror Name.";
            errorText.style.display = "block";
        }
        if (loading_button) loading_button.style.display = "none";
        if (login_button) login_button.style.display = "flex";
        return;
    }

    if (loading_button) loading_button.style.display = "flex";
    if (login_button) login_button.style.display = "none";
    updateSyncProgress(`Connecting to ${mirrorName}...`);

    savedMirrorName = mirrorName;
    try {
        localStorage.setItem("mirror_saved_name", mirrorName);
    } catch (err) { }

    connectMirrorStream(mirrorName);
}

// =========================================================================
// Real-Time Server-Driven Conductor: Server-Sent Events (SSE) Stream
// The server owns the master timeline and triggers slide changes to 100+
// screens simultaneously with ZERO client polling overhead.
// =========================================================================
function connectMirrorStream(mirrorName) {
    if (mirrorEventSource) {
        try { mirrorEventSource.close(); } catch (e) { }
        mirrorEventSource = null;
    }

    const errorText = document.getElementById("error");
    const loading_button = document.getElementById("loading_button");
    const login_button = document.getElementById("login_button");

    const streamUrl = `${SERVER_STREAM_URL}?mirror_name=${encodeURIComponent(mirrorName)}`;
    console.log("[MirrorSync] Connecting real-time Server Conductor stream:", streamUrl);

    try {
        mirrorEventSource = new EventSource(streamUrl);

        // 1. Initial State Handshake: Server sends current playlist and active index on connect
        mirrorEventSource.addEventListener("init", (e) => {
            try {
                const data = JSON.parse(e.data);
                console.log("[MirrorSync] Initial state received from server conductor:", data);
                if (data.status_code === 404) {
                    if (errorText) {
                        errorText.innerText = data.status_text || `Mirror "${mirrorName}" not found. Check the mirror name.`;
                        errorText.style.display = "block";
                    }
                    if (loading_button) loading_button.style.display = "none";
                    if (login_button) login_button.style.display = "flex";
                    return;
                }

                if (errorText) errorText.style.display = "none";
                if (loading_button) loading_button.style.display = "none";
                if (login_button) login_button.style.display = "flex";

                if (data.photo_duration) mirrorPhotoDuration = Number(data.photo_duration);
                if (data.active_content_index !== undefined) {
                    currentIndex = Number(data.active_content_index);
                    initialServerIndex = currentIndex;
                }
                isPaused = (data.playback_state === "paused");

                rawContents = (data.data || []).filter(item => item && item.content_url && item.is_active !== false);
                if (rawContents.length === 0) {
                    console.log("[MirrorSync] No media assigned to this mirror yet.");
                    showStandbyScreen();
                } else {
                    console.log(`[MirrorSync] Loaded ${rawContents.length} media item(s). Starting synchronized slideshow at index ${currentIndex}.`);
                    startSlideshow();
                }
            } catch (err) {
                console.error("[MirrorSync] Init event parse error:", err);
            }
        });

        // 2. Synchronized Slide Transition Trigger:
        // All 100+ screens receive this event at the exact same millisecond and switch together!
        mirrorEventSource.addEventListener("slide_change", (e) => {
            try {
                const data = JSON.parse(e.data);
                console.log("[MirrorSync] Server conductor triggered slide change:", data.index);
                if (data.index !== undefined && rawContents.length > 0) {
                    const newIndex = Number(data.index) % rawContents.length;
                    currentIndex = newIndex;
                    initialServerIndex = newIndex;
                    if (!isSlideshowActive) {
                        startSlideshow();
                    } else {
                        showCurrentFile(false);
                    }
                }
            } catch (err) {
                console.error("[MirrorSync] Slide change trigger error:", err);
            }
        });

        // 3. Central Playback Control: Admin paused or resumed the mirror from dashboard
        mirrorEventSource.addEventListener("playback_control", (e) => {
            try {
                const data = JSON.parse(e.data);
                console.log("[MirrorSync] Server pushed playback control:", data.action);
                setPlaybackState(data.action);
            } catch (err) {
                console.error("[MirrorSync] Playback control error:", err);
            }
        });

        // 4. Content / Playlist Update: Admin added, reordered, or removed content
        mirrorEventSource.addEventListener("update_playlist", (e) => {
            try {
                const data = JSON.parse(e.data);
                console.log("[MirrorSync] Server pushed updated playlist:", data);
                reloadMirrorContents(data.data);
            } catch (err) {
                console.error("[MirrorSync] Playlist update error:", err);
            }
        });

        // 5. Standby screen: No content assigned
        mirrorEventSource.addEventListener("standby", (e) => {
            console.log("[MirrorSync] Standby triggered by server.");
            showStandbyScreen();
        });

        mirrorEventSource.onerror = (err) => {
            console.warn("[MirrorSync] SSE stream interrupted. Holding current slide on screen while auto-reconnecting...", err);
            // EventSource automatically reconnects. While disconnected, the current slide stays on screen without crashing.
        };

        mirrorEventSource.onopen = () => {
            console.log("[MirrorSync] SSE Stream connected. Ready for server triggers.");
        };

    } catch (e) {
        console.error("[MirrorSync] Failed to initialize EventSource:", e);
    }
}

function reloadMirrorContents(incomingContents) {
    if (isReloading) return;
    isReloading = true;
    console.log("Starting mirror reload & restart sequence...");

    // Immediately pause and release TV hardware video decoders
    releaseMediaResources();

    const fetchFreshPromise = (incomingContents && Array.isArray(incomingContents))
        ? Promise.resolve(incomingContents)
        : fetch(SERVER_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                mirror_name: savedMirrorName,
                service: "login"
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

        if (rawContents.length > 0) {
            if (initialServerIndex !== undefined && rawContents.length > 0) {
                currentIndex = initialServerIndex % rawContents.length;
            } else {
                currentIndex = 0;
            }
            startSlideshow();
        } else {
            showStandbyScreen();
        }
    });
}

function isIOSDevice() {
    return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
        (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function isIPhoneDevice() {
    return /iPhone|iPod/.test(navigator.userAgent) ||
        (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1 && window.innerWidth < 600);
}

function isStandaloneMode() {
    return (window.navigator.standalone === true) ||
        window.matchMedia('(display-mode: standalone)').matches;
}

function checkFullscreenKioskPrompt() {
    if (isStandaloneMode()) return;

    const isFs = !!(document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement || document.msFullscreenElement);
    let prompt = document.getElementById("kiosk-fullscreen-prompt");
    if (isFs) {
        if (prompt) prompt.remove();
        return;
    }
    if (!isSlideshowActive) return;

    if (!prompt) {
        prompt = document.createElement("div");
        prompt.id = "kiosk-fullscreen-prompt";
        prompt.style.cssText = "position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:99999;background:rgba(15,23,42,0.92);border:1px solid rgba(168,85,247,0.6);color:#f8fafc;padding:10px 20px;border-radius:9999px;font-family:system-ui,-apple-system,sans-serif;font-size:13px;font-weight:600;display:flex;align-items:center;gap:10px;box-shadow:0 12px 32px rgba(0,0,0,0.6);cursor:pointer;user-select:none;max-width:92vw;text-align:center;";

        if (isIPhoneDevice()) {
            prompt.innerHTML = `
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#38bdf8" stroke-width="2"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg>
                <span>For Full-Screen on iOS: Tap Share ➔ <strong>Add to Home Screen</strong></span>
                <span style="opacity:0.6;font-size:11px;margin-left:4px;">✕</span>
            `;
            setTimeout(() => {
                const p = document.getElementById("kiosk-fullscreen-prompt");
                if (p) p.remove();
            }, 6000);
        } else {
            prompt.innerHTML = `
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#a855f7" stroke-width="2.5"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>
                <span>Tap / Click anywhere for Kiosk Full-Screen</span>
            `;
        }

        prompt.addEventListener("click", (e) => {
            e.stopPropagation();
            enterFullscreen();
        });
        document.body.appendChild(prompt);
    }
}

function enterFullscreen() {
    const docEl = document.documentElement;
    const isFs = !!(document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement || document.msFullscreenElement);
    if (isFs || isStandaloneMode()) {
        const prompt = document.getElementById("kiosk-fullscreen-prompt");
        if (prompt) prompt.remove();
        return;
    }

    try {
        window.scrollTo(0, 1);
    } catch (e) { }

    const req = docEl.requestFullscreen ||
        docEl.webkitRequestFullscreen ||
        docEl.webkitRequestFullScreen ||
        docEl.mozRequestFullScreen ||
        docEl.msRequestFullscreen;

    if (req) {
        try {
            const p = req.call(docEl);
            if (p && typeof p.then === 'function') {
                p.then(() => {
                    const prompt = document.getElementById("kiosk-fullscreen-prompt");
                    if (prompt) prompt.remove();
                    document.body.classList.add("hide-cursor");
                }).catch(() => { });
            } else {
                // Synchronous WebKit/Safari
                const prompt = document.getElementById("kiosk-fullscreen-prompt");
                if (prompt) prompt.remove();
                document.body.classList.add("hide-cursor");
            }
        } catch (e) {
            console.warn("Fullscreen request error:", e);
        }
    } else if (isIPhoneDevice()) {
        // iPhone Safari doesn't support DOM requestFullscreen; try native video fullscreen if playing
        const vidEl = getSlideshowVideo();
        if (vidEl && vidEl.style.display !== "none" && typeof vidEl.webkitEnterFullscreen === "function") {
            try {
                vidEl.webkitEnterFullscreen();
            } catch (e) { }
        }
        const prompt = document.getElementById("kiosk-fullscreen-prompt");
        if (prompt) prompt.remove();
    }
}

function startSlideshow() {
    isSlideshowActive = true;
    document.body.classList.add("slideshow-active", "hide-cursor");
    enableKeepAwake();

    const slideshowContainer = document.getElementById("slideshowContainer");
    const login_container = document.getElementById("login_container");

    if (login_container) login_container.style.display = "none";
    if (slideshowContainer) slideshowContainer.style.display = "flex";

    if (!rawContents || rawContents.length === 0) {
        showStandbyScreen();
        return;
    }

    if (initialServerIndex !== undefined && rawContents.length > 0) {
        currentIndex = initialServerIndex % rawContents.length;
    } else {
        currentIndex = 0;
    }

    showCurrentFile(false);
}

function reportActiveSlide(contentId, index) {
    // In server-conductor mode, the server controls and knows the active slide.
    // Client does not need to send update requests.
}

function setPlaybackState(targetState) {
    const shouldPause = (targetState === "paused" || targetState === "pause");
    if (shouldPause) {
        isPaused = true;
        if (slideshowTimer) {
            clearTimeout(slideshowTimer);
            slideshowTimer = null;
        }

        const vidEl = getSlideshowVideo();
        if (vidEl && vidEl.style.display !== "none") {
            try { vidEl.pause(); } catch (e) { }
        }

        let pauseIndicator = document.getElementById("mirror-pause-indicator");
        if (!pauseIndicator) {
            pauseIndicator = document.createElement("div");
            pauseIndicator.id = "mirror-pause-indicator";
            pauseIndicator.innerHTML = `
                <div style="position:fixed;top:24px;right:24px;z-index:99999;background:rgba(15,23,42,0.85);border:1px solid rgba(251,191,36,0.6);color:#fbbf24;padding:8px 18px;border-radius:9999px;font-family:system-ui,-apple-system,sans-serif;font-size:13px;font-weight:700;display:flex;align-items:center;gap:8px;box-shadow:0 10px 25px rgba(0,0,0,0.5);pointer-events:none;">
                    <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#fbbf24;box-shadow:0 0 8px #fbbf24;"></span>
                    <span>PAUSED</span>
                </div>
            `;
            document.body.appendChild(pauseIndicator);
        }
    } else {
        const wasPaused = isPaused;
        isPaused = false;

        const pauseIndicator = document.getElementById("mirror-pause-indicator");
        if (pauseIndicator) {
            pauseIndicator.remove();
        }

        if (wasPaused && isSlideshowActive && rawContents.length > 0) {
            const currentItem = rawContents[currentIndex];
            const currentUrl = currentItem ? currentItem.content_url : "";
            const isVideo = currentItem && ((currentItem.content_format && currentItem.content_format.toLowerCase().includes("video")) ||
                /\.(mp4|webm|ogg|mov)(\?.*)?$/i.test(currentUrl));
            const vidEl = getSlideshowVideo();

            if (isVideo && vidEl && vidEl.style.display !== "none") {
                vidEl.play().catch(() => { });
            } else {
                if (slideshowTimer) clearTimeout(slideshowTimer);
                slideshowTimer = setTimeout(() => {
                    if (!isPaused && isSlideshowActive) {
                        currentIndex = (currentIndex + 1) % rawContents.length;
                        showCurrentFile(true);
                    }
                }, 3000);
            }
        }
    }
}

function preloadNextSlide() {
    if (!rawContents || rawContents.length <= 1) return;
    const nextIdx = (currentIndex + 1) % rawContents.length;
    const nextItem = rawContents[nextIdx];
    if (nextItem && nextItem.content_url) {
        const isNextVideo = (nextItem.content_format && nextItem.content_format.toLowerCase().includes("video")) ||
            /\.(mp4|webm|ogg|mov)(\?.*)?$/i.test(nextItem.content_url);
        if (!isNextVideo) {
            const preloader = new Image();
            preloader.src = nextItem.content_url;
        }
    }
}

// Low-RAM Smart TV Engine: Switches between single <img> and single <video> with seamless zero-black-screen transitions
function showCurrentFile(shouldBroadcast = true) {
    if (!isSlideshowActive) return;

    if (slideshowTimer) {
        clearTimeout(slideshowTimer);
        slideshowTimer = null;
    }

    if (!rawContents || rawContents.length === 0) {
        releaseMediaResources();
        showStandbyScreen();
        return;
    }

    if (currentIndex >= rawContents.length) {
        currentIndex = 0;
    }

    const currentItem = rawContents[currentIndex];
    if (!currentItem || !currentItem.content_url) {
        currentIndex = (currentIndex + 1) % rawContents.length;
        slideshowTimer = setTimeout(() => showCurrentFile(true), 1000);
        return;
    }

    const currentUrl = currentItem.content_url;
    const isVideo = (currentItem.content_format && currentItem.content_format.toLowerCase().includes("video")) ||
        /\.(mp4|webm|ogg|mov)(\?.*)?$/i.test(currentUrl);

    const activeCid = currentItem._id || currentItem.id;
    if (shouldBroadcast) {
        reportActiveSlide(activeCid, currentIndex);
    }

    if (isPaused) {
        return;
    }

    // Preload next upcoming slide to eliminate network lag transitions
    preloadNextSlide();

    const imgEl = getSlideshowImage();
    const vidEl = getSlideshowVideo();

    if (isVideo) {
        pauseKeepAwakeMedia();
        requestScreenWakeLock();

        if (vidEl) {
            vidEl.onended = null;
            vidEl.onerror = null;
            vidEl.onplaying = null;
            vidEl.onloadeddata = null;

            try {
                vidEl.pause();
            } catch (e) { }

            // Seamless transition: Keep the previous image visible until the video has decoded its first frame!
            let videoStarted = false;
            const onVideoStarted = () => {
                if (videoStarted) return;
                videoStarted = true;
                vidEl.style.display = "block";
                vidEl.style.zIndex = "2";
                if (imgEl && imgEl.style.display !== "none") {
                    imgEl.onload = null;
                    imgEl.onerror = null;
                    imgEl.removeAttribute("src");
                    imgEl.style.display = "none";
                    imgEl.style.zIndex = "1";
                }
            };

            vidEl.onplaying = onVideoStarted;
            vidEl.onloadeddata = onVideoStarted;
            // Safety watchdog: ensure previous image is hidden if video started silently
            setTimeout(onVideoStarted, 2500);

            const handleVideoNext = () => {
                // Video ended: Hold final frame until server conductor triggers slide_change
                if (vidEl) {
                    try { vidEl.pause(); } catch (e) { }
                }
            };

            vidEl.onended = handleVideoNext;

            // Video watchdog timer: ensures a stalled network stream never freezes the display
            const fallbackDuration = (currentItem.duration && Number(currentItem.duration) > 0)
                ? Number(currentItem.duration)
                : (mirrorPhotoDuration || 10);
            slideshowTimer = setTimeout(() => {
                console.log("[Smart TV Video] Video watchdog timeout reached, advancing slide.");
                handleVideoNext();
            }, Math.max(5, fallbackDuration + 3) * 1000);

            vidEl.onloadedmetadata = () => {
                const actualDuration = (vidEl.duration && !isNaN(vidEl.duration) && vidEl.duration > 0)
                    ? vidEl.duration
                    : fallbackDuration;
                if (slideshowTimer) clearTimeout(slideshowTimer);
                slideshowTimer = setTimeout(() => {
                    console.log("[Smart TV Video] Video duration watchdog timeout, advancing slide.");
                    handleVideoNext();
                }, Math.max(5, Math.ceil(actualDuration + 2)) * 1000);
            };

            // Handle Smart TV codec errors safely without crashing browser
            vidEl.onerror = (e) => {
                console.warn("[Smart TV Video] Video decode/network error:", e);
                if (slideshowTimer) clearTimeout(slideshowTimer);
                slideshowTimer = setTimeout(handleVideoNext, 3000);
            };

            vidEl.src = currentUrl;

            // If no previous image was displayed (e.g. boot-up), reveal video immediately
            if (!imgEl || imgEl.style.display === "none") {
                vidEl.style.display = "block";
                vidEl.style.zIndex = "2";
            }

            const playPromise = vidEl.play();
            if (playPromise !== undefined) {
                playPromise.catch((err) => {
                    console.warn("[Smart TV Video] Autoplay blocked or error:", err);
                    if (slideshowTimer) clearTimeout(slideshowTimer);
                    slideshowTimer = setTimeout(handleVideoNext, 4000);
                });
            }
        }
    } else {
        // Showing photo: Ensure keep-awake video is active to prevent TV screensaver
        startKeepAwakeMedia();
        requestScreenWakeLock();

        // Seamless transition: Preload the image in memory before swapping so there is zero black flash
        const imgPreloader = new Image();
        const showLoadedImage = () => {
            if (!isSlideshowActive || isPaused) return;

            if (imgEl) {
                imgEl.src = currentUrl;
                imgEl.style.display = "block";
                imgEl.style.zIndex = "2";
            }

            // Immediately free video hardware decoder and video buffer from TV firmware
            if (vidEl) {
                try {
                    vidEl.pause();
                    vidEl.onended = null;
                    vidEl.onerror = null;
                    vidEl.onplaying = null;
                    vidEl.onloadeddata = null;
                    vidEl.removeAttribute("src");
                    // Do NOT call vidEl.load() with an empty src - causes native WebKit segfault on Smart TVs
                } catch (e) { }
                vidEl.style.display = "none";
                vidEl.style.zIndex = "1";
            }
        };

        imgPreloader.onload = showLoadedImage;
        imgPreloader.onerror = showLoadedImage;
        imgPreloader.src = currentUrl;

        // Note: Slide is NOT advanced by local client timer.
        // It holds on screen until the central server conductor pushes the synchronized 'slide_change' trigger!
    }
}

// User Gesture listeners for kiosk full-screen and keep-awake activation
["click", "touchend"].forEach(evt => {
    document.addEventListener(evt, () => {
        enterFullscreen();
        enableKeepAwake();
    }, { passive: true });
});

["visibilitychange", "fullscreenchange", "webkitfullscreenchange", "mozfullscreenchange", "MSFullscreenChange"].forEach(evt => {
    document.addEventListener(evt, () => {
        const isFs = !!(document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement || document.msFullscreenElement);
        const prompt = document.getElementById("kiosk-fullscreen-prompt");
        if (isFs) {
            if (prompt) prompt.remove();
            document.body.classList.add("hide-cursor");
        } else if (isSlideshowActive) {
            checkFullscreenKioskPrompt();
        }
        if (document.visibilityState === "visible" && isSlideshowActive) {
            enableKeepAwake();
        }
    });
});

document.addEventListener("keydown", (e) => {
    enableKeepAwake();
    if (isSlideshowActive) {
        enterFullscreen();
        if (e.key === "p" || e.key === "P" || e.key === " ") {
            e.preventDefault();
            const targetState = isPaused ? "playing" : "paused";
            setPlaybackState(targetState);
            const req = { service: "PlaybackControl", action: targetState, mirror_name: savedMirrorName };
            fetch(SERVER_URL, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(req)
            }).catch(() => { });
        }
    }
});

// Auto-hide mouse cursor after 2 seconds of inactivity
let mouseInactivityTimer = null;
document.addEventListener("mousemove", () => {
    if (!isSlideshowActive) return;
    document.body.classList.remove("hide-cursor");
    if (mouseInactivityTimer) clearTimeout(mouseInactivityTimer);
    mouseInactivityTimer = setTimeout(() => {
        if (isSlideshowActive) {
            document.body.classList.add("hide-cursor");
        }
    }, 2000);
});

// Periodic keep-awake watchdog: ensures screen saver / display sleep remains suppressed indefinitely
setInterval(() => {
    if (isSlideshowActive && !isPaused) {
        enableKeepAwake();
    }
}, 30000);

// Enterprise Signage Best Practice: 24-Hour clean memory cycle (prevents browser RAM leak accumulation on 24/7 TV panels)
const VIEWER_BOOT_TIMESTAMP = Date.now();
setInterval(() => {
    if (Date.now() - VIEWER_BOOT_TIMESTAMP > 24 * 60 * 60 * 1000) {
        console.log("[Signage Watchdog] 24-hour continuous playback threshold reached. Soft-refreshing to purge RAM.");
        window.location.reload();
    }
}, 30 * 60 * 1000);
