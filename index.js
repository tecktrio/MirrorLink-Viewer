let db;
let files = [];
let currentIndex = 0;
let initialServerIndex = 0;
let ContentElement = [];
let key = "";

let savedUsername = "";
let savedPassword = "";
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

const IS_REMOTE_SERVER = false;

let SERVER_URL;
let SERVER_WEBSOCKET_URL;
const SERVER_ROOT_REMOTE_URL = "https://mirrorlinkserver.developingkerala.com/Mirror";
const SERVER_ROOT_LOCAL_URL = "http://127.0.0.1:8000/Mirror";
const CONTROLLER_WEBSOCKET_REMOTE_URL = "wss://mirrorlinkserver.developingkerala.com/ws/mirror?";
const CONTROLLER_WEBSOCKET_LOCAL_URL = "ws://127.0.0.1:8000/mirror?";

if (IS_REMOTE_SERVER) {
    SERVER_URL = SERVER_ROOT_REMOTE_URL;
    SERVER_WEBSOCKET_URL = CONTROLLER_WEBSOCKET_REMOTE_URL;
} else {
    SERVER_URL = SERVER_ROOT_LOCAL_URL;
    SERVER_WEBSOCKET_URL = CONTROLLER_WEBSOCKET_LOCAL_URL;
}

// Restore saved credentials if available
window.addEventListener('DOMContentLoaded', () => {
    try {
        const saved = localStorage.getItem('mirror_saved_auth');
        if (saved) {
            const parsed = JSON.parse(saved);
            if (parsed.username && parsed.password) {
                const uInput = document.getElementById("username");
                const pInput = document.getElementById("password");
                if (uInput && !uInput.value) uInput.value = parsed.username;
                if (pInput && !pInput.value) pInput.value = parsed.password;
            }
        }
    } catch (e) {
        console.warn("Storage check:", e);
    }
});

function Login(e) {
    console.log("Trying to Login and fetch content urls");
    if (e && e.preventDefault) e.preventDefault();

    const usernameInput = document.getElementById("username");
    const passwordInput = document.getElementById("password");
    const username = usernameInput ? usernameInput.value.trim() : "";
    const password = passwordInput ? passwordInput.value.trim() : "";
    const errorText = document.getElementById("error");
    const loading_button = document.getElementById("loading_button");
    const login_button = document.getElementById("login_button");

    if (loading_button) loading_button.style.display = 'flex';
    if (login_button) login_button.style.display = 'none';

    if (username === "" || password === "") {
        alert("Both Screen ID and Access Key are required.");
        if (loading_button) loading_button.style.display = 'none';
        if (login_button) login_button.style.display = 'flex';
        return;
    }

    savedUsername = username;
    savedPassword = password;
    try {
        localStorage.setItem('mirror_saved_auth', JSON.stringify({ username, password }));
    } catch (err) {}

    let request_data = {
        'username': username,
        'password': password,
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
        if (data.status_code === 401 || data.status_code === 400) {
            if (errorText) {
                errorText.innerHTML = data.status_text || "Invalid Screen ID or Access Key";
                errorText.style.display = 'block';
            }
            if (loading_button) loading_button.style.display = 'none';
            if (login_button) login_button.style.display = 'flex';
            return;
        }

        console.log("Content URLs fetched successfully for mirror display");
        if (errorText) errorText.style.display = 'none';

        // Connect real-time WebSocket and polling fallback for remote refresh messages
        connectWebSocket(username, password);
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
        openDB(rawContents);
    })
    .catch((error) => {
        console.error("Login fetch error:", error);
        if (errorText) {
            errorText.innerText = "Network connection error: " + error.message;
            errorText.style.display = 'block';
        }
        if (loading_button) loading_button.style.display = 'none';
        if (login_button) login_button.style.display = 'flex';
    });
}

function connectWebSocket(username, password) {
    if (wsConnection) {
        try {
            wsConnection.onclose = null;
            wsConnection.close();
        } catch (e) {}
    }

    const wsUrl = `${SERVER_WEBSOCKET_URL}key=${encodeURIComponent(username + password)}&username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`;
    console.log("[Mirror WebSocket] Connecting to:", wsUrl);

    try {
        wsConnection = new WebSocket(wsUrl);

        wsConnection.onopen = () => {
            console.log("[Mirror WebSocket] Connected to MirrorLink Server successfully.");
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
                if (savedUsername && savedPassword) {
                    connectWebSocket(savedUsername, savedPassword);
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
        if (!savedUsername || !savedPassword || isReloading) return;

        fetch(SERVER_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                username: savedUsername,
                password: savedPassword,
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
                username: savedUsername,
                password: savedPassword,
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
        console.log(`Fetched ${contents.length} fresh content item(s) for mirror.`);
        rawContents = contents || [];
        
        // 3. Clear IndexedDB storage to flush removed files and save new ones
        openDBForReload(contents)
            .then(loadedElements => {
                ContentElement = loadedElements;
                if (initialServerIndex !== undefined && ContentElement.length > 0) {
        currentIndex = initialServerIndex % ContentElement.length;
    } else {
        currentIndex = 0;
    }
                isReloading = false;
                console.log("New contents downloaded. Restarting slideshow now!");

                const slideshowContainer = document.getElementById('slideshowContainer');
                if (slideshowContainer) {
                    slideshowContainer.innerHTML = '';
                }

                // If mirror was already in slideshow mode or has content, immediately restart presentation
                if (isSlideshowActive || ContentElement.length > 0) {
                    isSlideshowActive = true;
                    showCurrentFile();
                } else {
                    const startButton = document.getElementById('startButton');
                    const startBanner = document.getElementById('startBanner');
                    if (startButton) startButton.style.display = 'flex';
                    if (startBanner) startBanner.style.display = 'block';
                }
            })
            .catch(err => {
                console.error("Error during content reload:", err);
                isReloading = false;
            });
    });
}

function openDBForReload(contents) {
    return new Promise((resolve) => {
        const IndexedDB = indexedDB.open("mirrorLinkContentStorage", 1);
        IndexedDB.onerror = function (e) {
            console.error("DB error on reload:", e);
            resolve([]);
        };

        IndexedDB.onsuccess = function (event) {
            const dbInstance = event.target.result;
            try {
                const clearTx = dbInstance.transaction(["contents"], "readwrite");
                const store = clearTx.objectStore("contents");
                store.clear();
            } catch (e) {
                console.warn("Could not clear objectStore:", e);
            }

            if (!contents || contents.length === 0) {
                resolve([]);
                return;
            }

            const downloadPromises = contents.map(content => {
                const fileName = content.content_url.split('/').pop();
                return fetch(content.content_url)
                    .then(response => {
                        if (!response.ok) throw new Error("HTTP error " + response.status);
                        return response.blob();
                    })
                    .then(fileContent => {
                        try {
                            const addTx = dbInstance.transaction(["contents"], "readwrite");
                            addTx.objectStore("contents").add({ fileName, fileContent });
                        } catch (err) {}
                        return fileContent;
                    })
                    .catch(err => {
                        console.warn("Could not download file:", content.content_url, err);
                        return null;
                    });
            });

            Promise.all(downloadPromises).then(blobs => {
                const validBlobs = blobs.filter(b => b !== null);
                createElementsFromBlobs(validBlobs).then(elements => {
                    resolve(elements);
                });
            });
        };
    });
}

function createElementsFromBlobs(blobList) {
    const promises = blobList.map(file => {
        return new Promise((resolve) => {
            const fileReader = new FileReader();
            fileReader.onload = function (e) {
                const url = e.target.result;
                if (file.type && file.type.startsWith('video/')) {
                    const video = document.createElement('video');
                    video.src = url;
                    video.controls = false;
                    video.loop = false;
                    video.autoplay = true;
                    video.muted = true;
                    video.playsInline = true;
                    video.style.width = "100vw";
                    video.style.height = "100vh";
                    video.style.objectFit = "cover";
                    video.style.position = "fixed";
                    video.style.top = "0";
                    video.style.left = "0";
                    video.style.zIndex = "10";
                    document.body.style.overflow = "hidden";
                    video.preload = "auto";
                    resolve(video);
                } else {
                    const img = document.createElement('img');
                    img.src = url;
                    img.style.height = '100vh';
                    img.style.width = "100vw";
                    img.style.objectFit = "cover";
                    img.style.position = "fixed";
                    img.style.top = "0";
                    img.style.left = "0";
                    img.style.zIndex = "10";
                    resolve(img);
                }
            };
            fileReader.onerror = function () {
                resolve(null);
            };
            fileReader.readAsDataURL(file);
        });
    });

    return Promise.all(promises).then(items => items.filter(i => i !== null));
}

function openDB(contents) {
    console.log("Downloading the Your Contents...");
    const IndexedDB = indexedDB.open("mirrorLinkContentStorage", 1);

    IndexedDB.onerror = function (event) {
        console.error("Database error:", event.target.errorCode);
    };

    IndexedDB.onupgradeneeded = function (event) {
        const db = event.target.result;
        if (!db.objectStoreNames.contains("contents")) {
            const objectStore = db.createObjectStore("contents", { keyPath: "id", autoIncrement: true });
            objectStore.createIndex("Index", "fileName", { unique: true });
        }
    };

    IndexedDB.onsuccess = function (event) {
        let temp_contents = [];
        const dbInstance = event.target.result;
        db = dbInstance;

        if (!contents || contents.length === 0) {
            console.log("No contents assigned to this mirror yet.");
            const startbutton = document.getElementById('startButton');
            const loadingText = document.getElementById('loadingText');
            const startBanner = document.getElementById('startBanner');
            if (startbutton) startbutton.style.display = "flex";
            if (loadingText) loadingText.style.display = "none";
            if (startBanner) startBanner.style.display = "block";
            return;
        }

        const downloadPromises = contents.map(content => {
            return new Promise((resolve) => {
                const fileName = content.content_url.split('/').pop();
                fetch(content.content_url)
                    .then(response => {
                        if (!response.ok) throw new Error(`HTTP ${response.status}`);
                        return response.blob();
                    })
                    .then(fileContent => {
                        temp_contents.push(fileContent);
                        try {
                            const transaction = dbInstance.transaction(["contents"], "readwrite");
                            const transaction_object = transaction.objectStore("contents");
                            transaction_object.add({ fileName, fileContent });
                        } catch (err) {}
                        resolve();
                    })
                    .catch(error => {
                        console.warn("Fetch error for content:", error);
                        resolve();
                    });
            });
        });

        Promise.all(downloadPromises).then(() => {
            console.log('All initial content downloaded successfully!');
            files = temp_contents;
            loadFiles(temp_contents);
        });
    };
}

function loadFiles(fileList) {
    console.log('Loading downloaded files into display presentation...');
    createElementsFromBlobs(fileList || files).then(elements => {
        ContentElement = elements;
        const startbutton = document.getElementById('startButton');
        const loadingText = document.getElementById('loadingText');
        const startBanner = document.getElementById('startBanner');

        if (startbutton) startbutton.style.display = "flex";
        if (loadingText) loadingText.style.display = "none";
        if (startBanner) startBanner.style.display = "block";
    });
}

function enterFullscreen() {
    const docEl = document.documentElement;
    try {
        if (!document.fullscreenElement && !document.webkitFullscreenElement && !document.mozFullScreenElement && !document.msFullscreenElement) {
            if (docEl.requestFullscreen) {
                docEl.requestFullscreen().catch(err => {
                    console.log("Fullscreen request notice:", err.message);
                });
            } else if (docEl.webkitRequestFullscreen) {
                docEl.webkitRequestFullscreen();
            } else if (docEl.mozRequestFullScreen) {
                docEl.mozRequestFullScreen();
            } else if (docEl.msRequestFullscreen) {
                docEl.msRequestFullscreen();
            }
        }
    } catch (e) {
        console.warn("Fullscreen request error:", e);
    }
}

function startSlideshow() {
    isSlideshowActive = true;
    enterFullscreen();
    document.body.classList.add('hide-cursor');

    const slideshowContainer = document.getElementById('slideshowContainer');
    const login_container = document.getElementById('login_container');

    if (login_container) login_container.style.display = 'none';

    if (!ContentElement || ContentElement.length === 0) {
        if (slideshowContainer) {
            slideshowContainer.innerHTML = '<div style="color:white;display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;font-size:20px;letter-spacing:1px;background:#030712;"><span>Screen Idle — No media assigned to this mirror</span></div>';
        }
        return;
    }

    if (initialServerIndex !== undefined && ContentElement.length > 0) {
        currentIndex = initialServerIndex % ContentElement.length;
    } else {
        currentIndex = 0;
    }
    showCurrentFile();
}

function reportActiveSlide(contentId, index) {
    if (!savedUsername && !savedPassword) return;

    const payload = {
        service: 'UpdateActiveSlide',
        username: savedUsername,
        password: savedPassword,
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
document.addEventListener('click', () => {
    if (isSlideshowActive) {
        enterFullscreen();
    }
});

document.addEventListener('touchstart', () => {
    if (isSlideshowActive) {
        enterFullscreen();
    }
}, { passive: true });

document.addEventListener('keydown', (e) => {
    if (isSlideshowActive) {
        enterFullscreen();
        if (e.key === 'p' || e.key === 'P' || e.key === ' ') {
            e.preventDefault();
            const targetState = isPaused ? 'playing' : 'paused';
            setPlaybackState(targetState);
            const req = { service: 'PlaybackControl', action: targetState, username: savedUsername, password: savedPassword };
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
