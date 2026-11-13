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
            vid.style.display = "none";
            container.appendChild(vid);
        }
    }
    return vid;
}

// Critical for Smart TVs: Force release of hardware video decoder & GPU bitmap memory
function releaseMediaResources() {
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
        } catch (e) {}
        vidEl.style.display = "none";
    }

    const imgEl = getSlideshowImage();
    if (imgEl) {
        try {
            imgEl.onload = null;
            imgEl.onerror = null;
            imgEl.removeAttribute("src"); // Releases GPU bitmap memory
        } catch (e) {}
        imgEl.style.display = "none";
    }
}

function updateSyncProgress(msg) {
    const syncStatusText = document.getElementById("sync_status_text");
    if (syncStatusText) {
        syncStatusText.textContent = msg;
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
    if (mInput && !mInput.value) {
        try {
            const saved = localStorage.getItem("mirror_saved_name");
            if (saved) mInput.value = saved;
        } catch (e) {}
    }
}

// Auto-connect when mirror_name is present in URL or stored in localStorage, otherwise show login dialog
function initAutoConnect() {
    try {
        let queryMirrorName = "";
        try {
            const urlParams = new URLSearchParams(window.location.search);
            queryMirrorName = urlParams.get("mirror_name") || urlParams.get("name") || "";
        } catch (e) {
            const match = window.location.search.match(/[?&](?:mirror_name|name)=([^&#]*)/i);
            if (match) queryMirrorName = decodeURIComponent(match[1]);
        }

        // Check localStorage fallback for Smart TVs opened directly
        if (!queryMirrorName || queryMirrorName.trim() === "") {
            try {
                queryMirrorName = localStorage.getItem("mirror_saved_name") || "";
            } catch (e) {}
        }
        
        if (queryMirrorName && queryMirrorName.trim() !== "") {
            const cleanName = queryMirrorName.trim();
            console.log("Auto-connecting to mirror:", cleanName);
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
            console.log("No mirror_name configured. Presenting mirror name dialog.");
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
        alert("Mirror Name is required.");
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
    } catch (err) {}

    const request_data = {
        mirror_name: mirrorName,
        service: "login"
    };

    fetch(SERVER_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request_data)
    })
    .then(response => response.json())
    .then((data) => {
        if (data.status_code === 401 || data.status_code === 400 || data.status_code === 404) {
            if (errorText) {
                errorText.innerHTML = data.status_text || `Mirror "${mirrorName}" not found. Check the mirror name.`;
                errorText.style.display = "block";
            }
            if (loading_button) loading_button.style.display = "none";
            if (login_button) login_button.style.display = "flex";
            return;
        }

        console.log(`Mirror stream "${mirrorName}" connected successfully.`);
        if (errorText) errorText.style.display = "none";

        // Start HTTP polling sync
        startPollingFallback();

        if (data.photo_duration) {
            mirrorPhotoDuration = Number(data.photo_duration);
        }
        if (data.active_content_index !== undefined) {
            initialServerIndex = Number(data.active_content_index);
            currentIndex = initialServerIndex;
        }
        if (data.sync_timestamp) {
            lastKnownSyncTimestamp = data.sync_timestamp;
        }
        if (data.playback_state === "paused") {
            isPaused = true;
        }

        rawContents = (data.data || []).filter(item => item && item.content_url && item.is_active !== false);
        
        if (rawContents.length === 0) {
            console.log("No media assigned to this mirror yet.");
            showStandbyScreen();
            return;
        }

        console.log(`Loaded ${rawContents.length} media item(s). Starting slideshow immediately.`);
        if (initialServerIndex !== undefined && rawContents.length > 0) {
            currentIndex = initialServerIndex % rawContents.length;
        } else {
            currentIndex = 0;
        }

        // Start presentation immediately
        startSlideshow();
    })
    .catch((error) => {
        console.error("Mirror connect error:", error);
        if (errorText) {
            errorText.innerText = "Network connection error: " + error.message;
            errorText.style.display = "block";
        }
        if (loading_button) loading_button.style.display = "none";
        if (login_button) login_button.style.display = "flex";
    });
}

// Low-overhead adaptive polling: Only polls when needed to avoid CPU & memory thrashing on Smart TVs
function startPollingFallback() {
    if (pollTimeout) clearTimeout(pollTimeout);

    function pollStep() {
        if (!savedMirrorName || isReloading) {
            scheduleNextPoll(10000);
            return;
        }

        const nextDelay = 5000;

        fetch(SERVER_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                mirror_name: savedMirrorName,
                service: "CheckMirrorUpdate"
            })
        })
        .then(res => res.json())
        .then(resData => {
            if (!resData) {
                scheduleNextPoll(nextDelay);
                return;
            }

            // 1. Refresh detection
            if (resData.last_refresh_timestamp) {
                if (lastKnownTimestamp === 0) {
                    lastKnownTimestamp = resData.last_refresh_timestamp;
                } else if (resData.last_refresh_timestamp > lastKnownTimestamp) {
                    lastKnownTimestamp = resData.last_refresh_timestamp;
                    reloadMirrorContents(resData.data);
                    return;
                }
            }

            // 2. Playback state detection
            if (resData.playback_state) {
                if (resData.playback_state === "paused" && !isPaused) {
                    setPlaybackState("paused");
                } else if (resData.playback_state === "playing" && isPaused) {
                    setPlaybackState("playing");
                }
            }

            // 3. Slide sync detection
            if (resData.sync_timestamp && resData.sync_timestamp > lastKnownSyncTimestamp) {
                lastKnownSyncTimestamp = resData.sync_timestamp;
                if (resData.active_content_index !== undefined && rawContents.length > 0) {
                    const newIdx = Number(resData.active_content_index) % rawContents.length;
                    if (newIdx !== currentIndex) {
                        currentIndex = newIdx;
                        if (!isPaused && isSlideshowActive) {
                            showCurrentFile(false);
                        }
                    }
                }
            }

            // 4. Photo speed
            if (resData.photo_duration) {
                mirrorPhotoDuration = Number(resData.photo_duration);
            }

            scheduleNextPoll(nextDelay);
        })
        .catch(() => {
            scheduleNextPoll(nextDelay);
        });
    }

    function scheduleNextPoll(delay) {
        if (pollTimeout) clearTimeout(pollTimeout);
        pollTimeout = setTimeout(pollStep, delay);
    }

    scheduleNextPoll(6000);
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

function checkFullscreenKioskPrompt() {
    const isFs = !!(document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement || document.msFullscreenElement);
    let prompt = document.getElementById("kiosk-fullscreen-prompt");
    if (isFs) {
        if (prompt && prompt.parentNode) prompt.parentNode.removeChild(prompt);
        return;
    }
    if (!isSlideshowActive) return;

    if (!prompt) {
        prompt = document.createElement("div");
        prompt.id = "kiosk-fullscreen-prompt";
        prompt.style.cssText = "position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:99999;background:rgba(15,23,42,0.9);border:1px solid rgba(168,85,247,0.6);color:#f8fafc;padding:10px 22px;border-radius:9999px;font-family:system-ui,-apple-system,sans-serif;font-size:13px;font-weight:600;display:flex;align-items:center;gap:10px;box-shadow:0 12px 32px rgba(0,0,0,0.6);cursor:pointer;user-select:none;";
        prompt.innerHTML = `
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#a855f7" stroke-width="2.5"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>
            <span>Tap / Click anywhere for Kiosk Full-Screen</span>
        `;
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
    if (isFs) {
        const prompt = document.getElementById("kiosk-fullscreen-prompt");
        if (prompt && prompt.parentNode) prompt.parentNode.removeChild(prompt);
        return;
    }

    try {
        const req = docEl.requestFullscreen || docEl.webkitRequestFullscreen || docEl.mozRequestFullScreen || docEl.msRequestFullscreen;
        if (req) {
            const p = req.call(docEl);
            if (p && p.then) {
                p.then(() => {
                    const prompt = document.getElementById("kiosk-fullscreen-prompt");
                    if (prompt && prompt.parentNode) prompt.parentNode.removeChild(prompt);
                    document.body.classList.add("hide-cursor");
                }).catch(() => {
                    checkFullscreenKioskPrompt();
                });
            }
        }
    } catch (e) {
        checkFullscreenKioskPrompt();
    }
}

function startSlideshow() {
    isSlideshowActive = true;
    document.body.classList.add("slideshow-active", "hide-cursor");

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

    showCurrentFile();
}

function reportActiveSlide(contentId, index) {
    if (!savedMirrorName) return;

    const payload = {
        service: "UpdateActiveSlide",
        mirror_name: savedMirrorName,
        content_id: contentId || null,
        index: index !== undefined ? index : 0
    };

    fetch(SERVER_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
    }).catch(() => {});
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
            try { vidEl.pause(); } catch (e) {}
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
        if (pauseIndicator && pauseIndicator.parentNode) {
            pauseIndicator.parentNode.removeChild(pauseIndicator);
        }

        if (wasPaused && isSlideshowActive && rawContents.length > 0) {
            const currentItem = rawContents[currentIndex];
            const currentUrl = currentItem ? currentItem.content_url : "";
            const isVideo = currentItem && ((currentItem.content_format && currentItem.content_format.toLowerCase().includes("video")) ||
                            /\.(mp4|webm|ogg|mov)(\?.*)?$/i.test(currentUrl));
            const vidEl = getSlideshowVideo();

            if (isVideo && vidEl && vidEl.style.display !== "none") {
                vidEl.play().catch(() => {});
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

// Low-RAM Smart TV Engine: Switches between single <img> and single <video> with strict decoder cleanup
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

    const imgEl = getSlideshowImage();
    const vidEl = getSlideshowVideo();

    if (isVideo) {
        // Free image memory from GPU/RAM
        if (imgEl) {
            imgEl.onload = null;
            imgEl.onerror = null;
            imgEl.removeAttribute("src");
            imgEl.style.display = "none";
        }

        if (vidEl) {
            vidEl.style.display = "block";
            vidEl.onended = null;
            vidEl.onerror = null;

            try {
                vidEl.pause();
            } catch (e) {}

            vidEl.src = currentUrl;

            const handleVideoNext = () => {
                if (slideshowTimer) {
                    clearTimeout(slideshowTimer);
                    slideshowTimer = null;
                }
                if (!isPaused && isSlideshowActive) {
                    currentIndex = (currentIndex + 1) % rawContents.length;
                    showCurrentFile(true);
                }
            };

            vidEl.onended = handleVideoNext;

            // Handle Smart TV codec errors safely without crashing browser
            vidEl.onerror = (e) => {
                console.warn("[Smart TV Video] Video decode/network error:", e);
                if (slideshowTimer) clearTimeout(slideshowTimer);
                slideshowTimer = setTimeout(handleVideoNext, 2500);
            };

            // Watchdog timer: If video has duration 0 or ends without triggering onended, advance safely
            const maxVidDuration = (currentItem.duration && Number(currentItem.duration) > 0)
                ? Number(currentItem.duration)
                : (mirrorPhotoDuration || 10);
            slideshowTimer = setTimeout(() => {
                console.log("[Smart TV Video] Video watchdog timeout reached, advancing slide.");
                handleVideoNext();
            }, Math.max(4, maxVidDuration + 1) * 1000);

            const playPromise = vidEl.play();
            if (playPromise !== undefined) {
                playPromise.catch((err) => {
                    console.warn("[Smart TV Video] Autoplay blocked or error:", err);
                    if (slideshowTimer) clearTimeout(slideshowTimer);
                    slideshowTimer = setTimeout(handleVideoNext, 3000);
                });
            }
        }
    } else {
        // Showing photo: Safely unload video decoder without calling .load()
        if (vidEl) {
            try {
                vidEl.pause();
                vidEl.onended = null;
                vidEl.onerror = null;
                vidEl.removeAttribute("src");
            } catch (e) {}
            vidEl.style.display = "none";
        }

        if (imgEl) {
            imgEl.style.display = "block";
            imgEl.src = currentUrl;
        }

        const durationSec = (currentItem.duration && Number(currentItem.duration) > 0)
            ? Number(currentItem.duration)
            : (mirrorPhotoDuration || 5);
        const durationMs = Math.max(1, durationSec) * 1000;

        slideshowTimer = setTimeout(() => {
            if (!isPaused && isSlideshowActive) {
                currentIndex = (currentIndex + 1) % rawContents.length;
                showCurrentFile(true);
            }
        }, durationMs);
    }
}

// User Gesture listeners for kiosk full-screen
["click", "pointerdown", "touchstart"].forEach(evt => {
    document.addEventListener(evt, () => {
        enterFullscreen();
    }, { passive: true });
});

["fullscreenchange", "webkitfullscreenchange", "mozfullscreenchange", "MSFullscreenChange"].forEach(evt => {
    document.addEventListener(evt, () => {
        const isFs = !!(document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement || document.msFullscreenElement);
        const prompt = document.getElementById("kiosk-fullscreen-prompt");
        if (isFs) {
            if (prompt && prompt.parentNode) prompt.parentNode.removeChild(prompt);
            document.body.classList.add("hide-cursor");
        } else if (isSlideshowActive) {
            checkFullscreenKioskPrompt();
        }
    });
});

document.addEventListener("keydown", (e) => {
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
            }).catch(() => {});
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
