let currentIndex = 0;
let initialServerIndex = 0;
let savedMirrorName = "";
let savedMirrorId = "";
let slideshowTimer = null;
let isSlideshowActive = false;
let isReloading = false;
let isPaused = false;
let currentEligibilityCode = null;
let rawContents = [];
let lastKnownTimestamp = 0;
let lastKnownSyncTimestamp = 0;
let pollTimeout = null;
let mirrorPhotoDuration = 5;
let mirrorTransitions = [];
let previousContentId = null;

function showViewerLoading(title, subtitle) {
    const el = document.getElementById("viewer_loading_screen");
    if (!el) return;
    el.classList.remove("hidden");
    el.style.display = "flex";
    if (title) {
        const tEl = document.getElementById("viewer_loading_title");
        if (tEl) tEl.textContent = title;
    }
    if (subtitle) {
        const sEl = document.getElementById("viewer_loading_sub");
        if (sEl) sEl.textContent = subtitle;
    }
}

function hideViewerLoading() {
    const el = document.getElementById("viewer_loading_screen");
    if (!el) return;
    el.classList.add("hidden");
    setTimeout(() => {
        if (el && el.classList.contains("hidden")) {
            el.style.display = "none";
        }
    }, 450);
}

const ALL_TRANSITIONS = ["fade", "slide", "zoom", "wipe", "flip", "neon", "rainbow", "amber"];
const ALL_TRANSITION_CLASSES = ALL_TRANSITIONS.map(t => `sp-transition-${t}`);

function applyTransitionEffect(element, transitionType) {
    if (!element) return;
    element.classList.remove(...ALL_TRANSITION_CLASSES);
    if (transitionType && transitionType !== "none" && ALL_TRANSITIONS.includes(transitionType)) {
        void element.offsetWidth; // Force DOM reflow to trigger CSS keyframe animation
        element.classList.add(`sp-transition-${transitionType}`);
        setTimeout(() => {
            if (element) {
                element.classList.remove(`sp-transition-${transitionType}`);
            }
        }, 650);
    }
}

const SERVER_URL = "https://screenpilot.bigburry.com/api/Mirror";
const MQTT_BROKER_URL = window.MIRRORLINK_MQTT_URL || "wss://screenpilot.bigburry.com/mqtt";
let mirrorMqttClient = null;

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
            vid.preload = "metadata";
            vid.setAttribute("preload", "metadata");
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
    hideViewerLoading();
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
            <div class="viewer-standby-copy">
                <p class="viewer-reason-title">No active media assigned</p>
                <p>In the ScreenPilot control panel, add media to this mirror or re-enable a disabled playlist item. Playback starts automatically when active media is available.</p>
            </div>
        `;
        startBanner.style.display = "block";
    }
}

function showSubscriptionInactiveScreen() {
    showStandbyScreen();
    const startBanner = document.getElementById("startBanner");
    if (!startBanner) return;
    startBanner.innerHTML = `
        <div class="viewer-reason-card">
            <span class="viewer-reason-kicker">MIRRORLINK ACCOUNT</span>
            <h2>Subscription inactive</h2>
            <p>This display stopped receiving content because the account subscription is inactive or was not found.</p>
            <ol><li>Sign in to the control panel using the account that owns this mirror.</li><li>Open Pricing and activate the ScreenPilot subscription.</li><li>Return here and reconnect the display.</li></ol>
            <a href="https://screenpilot.bigburry.com/login?next=%2Fpricing" target="_blank" rel="noopener noreferrer">Open control panel <span aria-hidden="true">↗</span></a>
        </div>`;
    startBanner.style.display = "block";
}

function showMirrorInactiveScreen() {
    showStandbyScreen();
    const startBanner = document.getElementById("startBanner");
    if (!startBanner) return;
    startBanner.innerHTML = `
        <div class="viewer-reason-card">
            <span class="viewer-reason-kicker">DISPLAY STATUS</span>
            <h2>Mirror inactive</h2>
            <p>This mirror has been marked inactive, so it cannot receive or play content.</p>
            <ol><li>Sign in to the ScreenPilot control panel.</li><li>Ask the account administrator to reactivate this mirror.</li><li>Reconnect the display after it has been reactivated.</li></ol>
            <a href="https://screenpilot.bigburry.com/login?next=%2Fmanage_mirrors" target="_blank" rel="noopener noreferrer">Open control panel <span aria-hidden="true">↗</span></a>
        </div>`;
    startBanner.style.display = "block";
}

function showLoginDialog() {
    hideViewerLoading();
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

            showViewerLoading(cleanName, "Connecting to mirror stream...");

            const loading_button = document.getElementById("loading_button");
            const login_button = document.getElementById("login_button");
            if (loading_button) loading_button.style.display = "flex";
            if (login_button) login_button.style.display = "none";
            updateSyncProgress(`Connecting to ${cleanName}...`);

            // Start immediately
            Login();
        } else {
            console.log("No mirror_name in URL. Presenting mirror name dialog.");
            hideViewerLoading();
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
    showViewerLoading(mirrorName, "Syncing display media...");

    savedMirrorName = mirrorName;
    try {
        localStorage.setItem("mirror_saved_name", mirrorName);
    } catch (err) { }

    connectMirrorMQTT(mirrorName);
}

// =========================================================================
// Real-Time Server-Driven Conductor: MQTT topic subscription.
// The server owns the playback clock and publishes each content trigger.
// =========================================================================
function connectMirrorMQTT(mirrorName) {
    if (mirrorMqttClient) { try { mirrorMqttClient.end(true); } catch (e) { } }
    const errorText = document.getElementById("error");
    const loading_button = document.getElementById("loading_button");
    const login_button = document.getElementById("login_button");
    let mqttConnected = false;
    const subscribeMirror = () => {
        if (mqttConnected && savedMirrorId && mirrorMqttClient) {
            mirrorMqttClient.subscribe(`mirror/${savedMirrorId}`, { qos: 1 });
        }
    };
    try {
        mirrorMqttClient = window.mqtt.connect(MQTT_BROKER_URL, {
            ...(window.MIRRORLINK_MQTT_OPTIONS || {}),
            reconnectPeriod: 3000,
            connectTimeout: 10000
        });
        mirrorMqttClient.on("connect", () => {
            mqttConnected = true;
            subscribeMirror();
        });
        mirrorMqttClient.on("message", (_topic, payload) => {
            try {
                const message = JSON.parse(payload.toString());
                const data = message.data || {};
                if (message.event === "eligibility_status") {
                    const statusCode = Number(data.status_code);
                    if (currentEligibilityCode === statusCode) return;
                    currentEligibilityCode = statusCode;
                    if (statusCode === 600) showMirrorInactiveScreen();
                    else showSubscriptionInactiveScreen();
                } else if (message.event === "init") {
                    currentEligibilityCode = null;
                    rawContents = (data.data || []).filter(item => item && item.content_url && item.is_active !== false);
                    if (data.transitions) mirrorTransitions = data.transitions;
                    if (data.photo_duration) mirrorPhotoDuration = Number(data.photo_duration);
                    if (data.active_content_index !== undefined) currentIndex = initialServerIndex = Number(data.active_content_index);
                    const errorText = document.getElementById("error");
                    if (errorText) errorText.style.display = "none";
                    if (rawContents.length) {
                        const initialIndex = Number(data.active_content_index);
                        currentIndex = initialServerIndex = Number.isInteger(initialIndex) && initialIndex >= 0
                            ? initialIndex % rawContents.length
                            : 0;
                        if (!isSlideshowActive) startSlideshow();
                        if (data.playback_state) setPlaybackState(data.playback_state);
                    } else {
                        showStandbyScreen();
                    }
                } else if (message.event === "slide_change") {
                    if (slideshowTimer) {
                        clearTimeout(slideshowTimer);
                        slideshowTimer = null;
                    }
                    currentEligibilityCode = null;
                    const startBanner = document.getElementById("startBanner");
                    if (startBanner) startBanner.style.display = "none";
                    let item = data.content_id && rawContents.find(c => String(c._id || c.id) === String(data.content_id));
                    if (!item && data.content) {
                        item = { ...data.content, _id: data.content._id || data.content_id };
                    }
                    if (!item && data.content_url) item = { ...data, _id: data.content_id };
                    if (item) {
                        const existingIndex = rawContents.findIndex(c => String(c._id || c.id) === String(item._id || item.id));
                        if (existingIndex >= 0) {
                            rawContents[existingIndex] = { ...rawContents[existingIndex], ...item };
                        } else {
                            const insertionIndex = Number.isInteger(Number(data.index))
                                ? Math.max(0, Math.min(Number(data.index), rawContents.length))
                                : rawContents.length;
                            rawContents.splice(insertionIndex, 0, item);
                        }
                        currentIndex = initialServerIndex = rawContents.indexOf(item);
                        if (currentIndex < 0) {
                            currentIndex = initialServerIndex = existingIndex;
                        }
                        if (!isSlideshowActive) startSlideshow(); else showCurrentFile(false);
                        if (isPaused) setPlaybackState("playing");
                    }
                } else if (message.event === "playback_control") setPlaybackState(data.action);
                else if (message.event === "ReloadContents" || message.event === "update_playlist") {
                    if (data.transitions) mirrorTransitions = data.transitions;
                    reloadMirrorContents(data.data);
                }
                else if (message.event === "update_transitions") {
                    mirrorTransitions = data.transitions || [];
                }
                else if (message.event === "standby") showStandbyScreen();
            } catch (err) { console.error("[MirrorSync] MQTT event error:", err); }
        });
        mirrorMqttClient.on("error", err => console.warn("[MirrorSync] MQTT connection error:", err));
    } catch (err) { console.error("[MirrorSync] Failed to initialize MQTT:", err); }

    // Resolve the mirror and load its initial content independently of MQTT.
    // This keeps the screen useful during broker reconnects and with older servers.
    // Built-in instant support for public demo mirror (no sign-in needed, test on any screen)
    if (mirrorName && mirrorName.trim().toLowerCase() === "demo") {
        const demoData = {
            status_text: "ok",
            status_code: 200,
            mirror_id: "demo_screen_mock_id",
            mirror_name: "demo",
            photo_duration: 3,
            active_content_index: 0,
            playback_state: "playing",
            data: [
                {
                    _id: "demo_content_vid_1",
                    content_title: "Content 1",
                    content_url: "https://screenpilot.bigburry.com/testvid1.mp4",
                    content_format: "mp4",
                    is_active: true,
                    duration: 3
                },
                {
                    _id: "demo_content_vid_2",
                    content_title: "Content 2",
                    content_url: "https://screenpilot.bigburry.com/testvid2.mp4",
                    content_format: "mp4",
                    is_active: true,
                    duration: 3
                },
                {
                    _id: "demo_content_vid_3",
                    content_title: "Content 3",
                    content_url: "https://screenpilot.bigburry.com/testvid3.mp4",
                    content_format: "mp4",
                    is_active: true,
                    duration: 3
                }
            ]
        };
        currentEligibilityCode = null;
        if (errorText) errorText.style.display = "none";
        if (loading_button) loading_button.style.display = "none";
        if (login_button) login_button.style.display = "flex";
        savedMirrorId = demoData.mirror_id;
        subscribeMirror();
        updateSyncProgress("Loading demo display playlist...");
        reloadMirrorContents(demoData);
        return;
    }

    fetch(SERVER_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ service: "login", mirror_name: mirrorName })
    }).then(async res => {
        const data = await res.json();
        if (!res.ok || (Number(data.status_code) >= 400)) {
            const error = new Error(data.status_text || (res.status === 402
                ? "This mirror is in setup mode. Subscribe to activate live playback."
                : "Unable to connect this mirror."));
            error.status = Number(data.status_code) >= 400 ? Number(data.status_code) : res.status;
            error.data = data;
            throw error;
        }
        return data;
    }).then(data => {
        currentEligibilityCode = null;
        if (errorText) errorText.style.display = "none";
        if (loading_button) loading_button.style.display = "none";
        if (login_button) login_button.style.display = "flex";
        savedMirrorId = data.mirror_id || "";
        subscribeMirror();
        if (data.photo_duration) mirrorPhotoDuration = Number(data.photo_duration);
        if (data.transitions) mirrorTransitions = data.transitions;
        isPaused = data.playback_state === "paused";
        rawContents = (data.data || []).filter(item => item && item.content_url && item.is_active !== false);
        if (rawContents.length) {
            const initialIndex = Number(data.active_content_index);
            currentIndex = initialServerIndex = Number.isInteger(initialIndex) && initialIndex >= 0
                ? initialIndex % rawContents.length
                : 0;
            startSlideshow();
            setPlaybackState(data.playback_state || "playing");
        } else {
            showStandbyScreen();
        }
    }).catch(err => {
        console.error("[MirrorSync] Mirror login failed:", err);
        if (err.data && err.data.mirror_id) {
            savedMirrorId = err.data.mirror_id;
            subscribeMirror();
        }
        if (errorText) {
            if (err.status === 402) {
                errorText.classList.add("subscription-required");
                errorText.classList.remove("mirror-inactive");
                errorText.innerHTML = `
                    <strong>Subscription not found or inactive</strong>
                    <p>This display is in setup mode. Activate a ScreenPilot subscription to start streaming content.</p>
                    <ol>
                        <li>Open the ScreenPilot control panel and sign in to the account that owns this mirror.</li>
                        <li>Choose <strong>Pricing</strong> and complete the subscription.</li>
                        <li>Return here and reconnect the display.</li>
                    </ol>
                    <a href="https://screenpilot.bigburry.com/login?next=%2Fpricing" target="_blank" rel="noopener noreferrer">Open control panel and subscribe <span aria-hidden="true">↗</span></a>
                `;
            } else if (err.status === 423) {
                errorText.classList.remove("subscription-required");
                errorText.classList.add("mirror-inactive");
                errorText.innerHTML = `
                    <strong>This mirror is inactive</strong>
                    <p>The display cannot receive content while it is inactive.</p>
                    <ol><li>Sign in to the ScreenPilot control panel.</li><li>Ask the account administrator to reactivate this mirror.</li><li>Reconnect the display after it has been reactivated.</li></ol>
                    <a href="https://screenpilot.bigburry.com/login?next=%2Fmanage_mirrors" target="_blank" rel="noopener noreferrer">Open control panel <span aria-hidden="true">↗</span></a>
                `;
            } else {
                errorText.classList.remove("subscription-required", "mirror-inactive");
                errorText.textContent = err.message || "Unable to load mirror contents.";
            }
            errorText.style.display = "block";
        }
        if (loading_button) loading_button.style.display = "none";
        if (login_button) login_button.style.display = "flex";
        const loginContainer = document.getElementById("login_container");
        const loginForm = document.getElementById("loadingText");
        if (loginContainer) loginContainer.style.display = "flex";
        if (loginForm) loginForm.style.display = "block";
        hideViewerLoading();
    });
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
            .then(data => {
                if (data && data.transitions) mirrorTransitions = data.transitions;
                return data.data || [];
            })
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

        // if (isIPhoneDevice()) {
        //     prompt.innerHTML = `
        //         <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#38bdf8" stroke-width="2"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg>
        //         <span>For Full-Screen on iOS: Tap Share ➔ <strong>Add to Home Screen</strong></span>
        //         <span style="opacity:0.6;font-size:11px;margin-left:4px;">✕</span>
        //     `;
        //     setTimeout(() => {
        //         const p = document.getElementById("kiosk-fullscreen-prompt");
        //         if (p) p.remove();
        //     }, 6000);
        // } else {
        //     prompt.innerHTML = `
        //         <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#a855f7" stroke-width="2.5"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>
        //         <span>Tap / Click anywhere for Kiosk Full-Screen</span>
        //     `;
        // }

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

function advanceNextSlide() {
    if (!isSlideshowActive || isPaused || !rawContents || rawContents.length <= 1) return;
    currentIndex = (currentIndex + 1) % rawContents.length;
    showCurrentFile(true);
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
            pauseIndicator.innerHTML = `<div class="viewer-pause-card"><span class="viewer-pause-dot"></span><div><strong>Playback paused</strong><span>Resume this mirror from the ScreenPilot control panel.</span></div></div>`;
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
        // Keep the current frame until the server publishes a valid next item.
        return;
    }

    const currentUrl = currentItem.content_url;
    const isVideo = (currentItem.content_format && currentItem.content_format.toLowerCase().includes("video")) ||
        /\.(mp4|webm|ogg|mov)(\?.*)?$/i.test(currentUrl);

    const activeCid = currentItem._id || currentItem.id;
    if (shouldBroadcast) {
        reportActiveSlide(activeCid, currentIndex);
    }

    // Match transition between previousContentId and activeCid
    let transitionEffect = null;
    if (previousContentId && activeCid && String(previousContentId) !== String(activeCid)) {
        const match = (mirrorTransitions || []).find(t =>
            String(t.left_content_id) === String(previousContentId) &&
            String(t.right_content_id) === String(activeCid)
        );
        if (match && match.transition_id && match.transition_id !== 'none') {
            transitionEffect = match.transition_id; // 'fade' | 'slide' | 'zoom'
        }
    }
    previousContentId = activeCid;

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

            // If video is not already loaded/buffered for this URL, show warm brown loading screen
            const isAlreadyLoaded = vidEl.src === currentUrl && vidEl.readyState >= 3;
            if (!isAlreadyLoaded) {
                showViewerLoading(currentItem.content_title || savedMirrorName, "Loading video...");
            }

            // Seamless transition: Keep the previous image visible until the video has decoded its first frame!
            let videoStarted = false;
            const onVideoStarted = () => {
                if (videoStarted) return;
                videoStarted = true;
                hideViewerLoading();
                applyTransitionEffect(vidEl, transitionEffect);
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
            vidEl.onloadedmetadata = () => {
                const duration = Number(vidEl.duration);
                if (savedMirrorId && activeCid && Number.isFinite(duration) && duration > 0) {
                    fetch(SERVER_URL, {
                        method: "POST", headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ service: "ReportContentDuration", mirror_id: savedMirrorId, content_id: activeCid, duration })
                    }).catch(() => { });
                }
            };
            // Safety watchdog: ensure previous image is hidden if video started silently
            setTimeout(onVideoStarted, 2500);

            const handleVideoNext = () => {
                if (vidEl) {
                    try { vidEl.pause(); } catch (e) { }
                }
                advanceNextSlide();
            };

            vidEl.onended = handleVideoNext;

            if (rawContents.length > 1) {
                const vidDuration = Number(currentItem.duration) || 10;
                slideshowTimer = setTimeout(advanceNextSlide, Math.max(3, vidDuration + 2) * 1000);
            }

            // Handle Smart TV codec or network stall errors safely without black screen freeze
            vidEl.onerror = (e) => {
                console.warn("[Smart TV Video] Video decode/network error:", e);
                hideViewerLoading();
                // Fail-safe: if the video errors on TV, hold final/previous frame or notify
                try {
                    const mediaErr = vidEl.error;
                    if (mediaErr) {
                        console.warn("[Smart TV Video] Error code:", mediaErr.code, mediaErr.message);
                    }
                } catch (_) { }
            };

            vidEl.src = currentUrl;

            // If no previous image was displayed (e.g. boot-up), reveal video immediately
            if (!imgEl || imgEl.style.display === "none") {
                vidEl.style.display = "block";
                vidEl.style.zIndex = "2";
            }

            if (isPaused) {
                vidEl.pause();
            } else {
                const playPromise = vidEl.play();
                if (playPromise !== undefined) {
                    playPromise.catch((err) => {
                        console.warn("[Smart TV Video] Autoplay blocked or error:", err);
                    });
                }
            }
        }
    } else {
        // Showing photo: Ensure keep-awake video is active to prevent TV screensaver
        startKeepAwakeMedia();
        requestScreenWakeLock();

        // Seamless transition: Preload the image in memory before swapping so there is zero black flash
        const imgPreloader = new Image();
        let imageProcessed = false;

        const showLoadedImage = () => {
            if (imageProcessed) return;
            imageProcessed = true;
            hideViewerLoading();

            if (!isSlideshowActive || isPaused) return;

            if (imgEl) {
                applyTransitionEffect(imgEl, transitionEffect);
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
            // Client auto-advance fallback timer: Ensures mirror always cycles content smoothly
            // even if MQTT broker is disconnected or delayed.
            if (rawContents.length > 1) {
                const photoDuration = Math.max(2, Number(currentItem.duration) || mirrorPhotoDuration || 5);
                slideshowTimer = setTimeout(advanceNextSlide, photoDuration * 1000);
            }
        };

        imgPreloader.onload = showLoadedImage;
        imgPreloader.onerror = showLoadedImage;
        imgPreloader.src = currentUrl;

        // If the image is not already in memory/browser cache, show warm brown loading screen
        if (!imgPreloader.complete) {
            showViewerLoading(currentItem.content_title || savedMirrorName, "Loading content...");
        } else {
            showLoadedImage();
        }
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

// Periodic playlist sync watchdog: ensures any new media uploaded or changed from web app
// is detected and loaded within seconds even on network hiccups or packet drops.
setInterval(() => {
    if (!savedMirrorId || !isSlideshowActive) return;
    fetch(SERVER_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            service: "CheckMirrorUpdate",
            mirror_id: savedMirrorId,
            mirror_name: savedMirrorName
        })
    })
    .then(r => r.json())
    .then(data => {
        if (data && data.status_code === 200) {
            if (data.transitions) mirrorTransitions = data.transitions;
            const incomingRefresh = Number(data.last_refresh_timestamp || 0);
            const freshItems = data.data || [];
            if (incomingRefresh > lastKnownTimestamp) {
                lastKnownTimestamp = incomingRefresh;
                reloadMirrorContents(freshItems);
            } else if (Array.isArray(freshItems) && freshItems.length !== rawContents.length) {
                reloadMirrorContents(freshItems);
            }
        }
    })
    .catch(() => {});
}, 10000);
