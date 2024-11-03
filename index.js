let db;
let files = [];
let currentIndex = 0;
let ContentElement = [];
let key = "";

const IS_REMOTE_SERVER = false

let SERVER_URL;
let SERVER_WEBSOCKET_URL;
const SERVER_ROOT_REMOTE_URL = "https://mirrorlinkserver.developingkerala.com/Mirror"
const SERVER_ROOT_LOCAL_URL = "http://127.0.0.1:8000/Mirror"
// const CONTROLLER_HTTP_URL = "https://mirrorlinkserver.developingkerala.com/AdministratorLogin"
const CONTROLLER_WEBSOCKET_REMOTE_URL = "wss://mirrorlinkserver.developingkerala.com/ws/mirror?"
const CONTROLLER_WEBSOCKET_LOCAL_URL = "ws://127.0.0.1:8000/mirror?"

if (IS_REMOTE_SERVER) {
    SERVER_URL = SERVER_ROOT_REMOTE_URL
    SERVER_WEBSOCKET_URL = CONTROLLER_WEBSOCKET_REMOTE_URL
}
else {
    SERVER_URL = SERVER_ROOT_LOCAL_URL
    SERVER_WEBSOCKET_URL = CONTROLLER_WEBSOCKET_LOCAL_URL
}

function openDB(data) {
    
    const request = indexedDB.open("fileDatabase", 1);
    

    request.onerror = function (event) {
        console.error("Database error:", event.target.errorCode);
    };

    request.onsuccess = function (event) {
        db = event.target.result;
       
                data.map((content) => {
                    saveFileFromUrl(content)  

                })
    };

    request.onupgradeneeded = function (event) {
        db = event.target.result;
        const objectStore = db.createObjectStore("files", { keyPath: "id", autoIncrement: true });
        objectStore.createIndex("fileName", "fileName", { unique: false });
        // console.log("Object store created successfully");
    };
}
function saveFileFromUrl(contentData) {
    const contentUrl = contentData.content_url;
    console.log(contentUrl)
    const fileName = contentUrl.split('/').pop(); // Extract filename from URL

    fetch(contentUrl)
        .then(response => {
            if (!response.ok) {
                throw new Error(`HTTP error! Status: ${response.status}`);
            }
            return response.blob(); // Convert the response to a Blob
        })
        .then(blob => {
            const transaction = db.transaction(["files"], "readwrite");
            const objectStore = transaction.objectStore("files");
            const file = new File([blob], fileName, { type: blob.type });
            console.log(file)

            const fileData = {
                fileName: fileName,
                fileContent: blob, // Store the downloaded Blob content
                mirrorId: contentData.mirror_id,
                isActive: contentData.is_active,
                order: contentData.order
            };

            const request = objectStore.add(fileData);

            request.onsuccess = function (event) {
                loadFiles(); // Reload files and preload them
            };

            request.onerror = function (event) {
            };
        })
        .catch(error => {
            console.error("Error downloading file:", error);
        });
}
function loadFiles() {
    files = []; // Clear the existing list
    const transaction = db.transaction(["files"], "readonly");
    const objectStore = transaction.objectStore("files");

    // console.log(objectStore)

    objectStore.openCursor().onsuccess = function (event) {
        const cursor = event.target.result;

        if (cursor) {
            // if (cursor.value.fileContent.type.startsWith('image/')) {
                console.log(cursor.value)
            files.push(cursor.value.fileContent);
            // }
            cursor.continue();
        } else {
            preloadFiles(); // Preload files before starting the slideshow
        }
    };
}
function preloadFiles() {
    const ContentPromise = [];
    // console.log(files)
    files.forEach(file => {

        // console.log(file.type)

        if (file.type === 'video/mp4') {

            const fileReader = new FileReader();
            const filePromise = new Promise((resolve, reject) => {
                fileReader.onload = function (e) {
                    const url = e.target.result;
                    const video = document.createElement('video');
                    video.src = url;
                    video.controls = false; // Hide controls
                    video.loop = false;

                    // Ensure the video fills the viewport without extra space
                    video.style.width = "100vw";
                    video.style.height = "100vh";
                    video.style.position = "absolute"; // Use absolute positioning if necessary
                    video.style.top = "0";
                    video.style.left = "0";
                    video.style.margin = "0";
                    video.style.padding = "0";
                    video.preload = "auto";
                    ContentElement.push(video) // Load video content
                };
                fileReader.onerror = function (e) {
                    reject(e);
                };
                fileReader.readAsDataURL(file);
            });

            ContentPromise.push(filePromise);
        }

        else {
            const fileReader = new FileReader();
            const filePromise = new Promise((resolve, reject) => {
                fileReader.onload = function (e) {
                    const url = e.target.result;
                    const img = document.createElement('img');
                    img.src = url;
                    // img.style.maxWidth = '100%';
                    img.style.height = '100vh';
                    img.style.width = "100vw";
                    ContentElement.push(img);
                    resolve();
                };
                fileReader.onerror = function (e) {
                    reject(e);
                };
                fileReader.readAsDataURL(file);
            });

            ContentPromise.push(filePromise);
        }
    });

    Promise.all(ContentPromise).then(() => {
        showStartButton()
        // startSlideshow(); // Start the slideshow after preloading all files
    });
}
function showStartButton() {
    const startbutton = document.getElementById('startButton')
    const loadingText = document.getElementById('loadingText')
    startbutton.style.display = "flex";
    loadingText.style.display = "none";
}
function startSlideshow() {
    const slideshowContainer = document.getElementById('slideshowContainer');
    // slideshowContainer.style.width = "100%"
    // slideshowContainer.style.height = "100%"
    if (files.length === 0) {
        slideshowContainer.innerHTML = '<p>No files uploaded yet.</p>';
        return;
    }
    currentIndex = 0;
    showCurrentFile();
}
async function showCurrentFile() {
    const slideshowContainer = document.getElementById('slideshowContainer');
    const login_container = document.getElementById('login_container');
    slideshowContainer.innerHTML = ''; // Clear the current display
    login_container.style.display = 'none'; // Clear the current display
    // console.log(ContentElement)
    // console.log(currentIndex)
    const content = ContentElement[currentIndex];
    // console.log(content.tagName)
    if (content.tagName == "VIDEO") {

        // Make sure user has interacted with the page
        content.play().then(() => {
            content.onended = function () {

                showCurrentFile();
            };
        }).catch(error => {
            console.error("Failed to play video:", error);
        });
        slideshowContainer.appendChild(content);

        // Delay of 2 seconds between images
    }
    else {

        setTimeout(() => {
            showCurrentFile(); // Call the function after a delay
        }, 4000);
        // showCurrentFile();
        slideshowContainer.appendChild(content);


    }
    // console.log("index",currentIndex)

    // console.log(ContentElement.length)
    currentIndex = currentIndex + 1

    if (ContentElement.length === currentIndex) {
        // console.log('reset')
        currentIndex = 0;
        await loadFiles()
    }


}
function Login(e) {
    e.preventDefault();

    // Get input values
    const username = document.getElementById("username").value;
    const password = document.getElementById("password").value;
    const errorText = document.getElementById("error");

    // Basic validation
    if (username === "" || password === "") {
        alert("Both fields are required.");
        return;
    }

    let request_data = {
        'username':username,
        'password':password,
        'service':'login'
    }

    // Handle login logic (e.g., send credentials to server)
    // console.log("Logging in with:", { username, password });

    // You can use fetch or another method to send this data to your server
    fetch(SERVER_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(request_data)
    }).then(response => response.json())
        .then((data) => {
            // openDB(data.key);
            if (data.status_code == 401) {

                errorText.innerHTML = data.status_text
            }
            // key = data.ws_secret_key;
            console.log(data)
            // document.cookie = `sockect_key=${key}`
            // window.location = 'index.html'

            openDB(data.data)
        }).catch((error) => {
            errorText.value = error
        })

}
window.onbeforeunload = function () {
    // Close the database first (optional but recommended)
    if (db) {
        db.close();
    }

    // Delete the database
    const request = indexedDB.deleteDatabase("fileDatabase");

    request.onsuccess = function () {
        // console.log("Database deleted successfully.");
    };

    request.onerror = function (event) {
        // console.error("Error deleting database:", event.target.errorCode);
    };

    request.onblocked = function () {
        // console.log("Database deletion is blocked.");
    };
};
