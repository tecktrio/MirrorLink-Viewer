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
        'username': username,
        'password': password,
        'service': 'login'
    }
    fetch(SERVER_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(request_data)
    }).then(response => response.json())
        .then((data) => {
            if (data.status_code == 401) {
                errorText.innerHTML = data.status_text
            }
            openDB(data.data)
        }).catch((error) => {
            errorText.value = error
        })

}
function openDB(contents) {
    const IndexedDB = indexedDB.open("mirrorLinkContentStorage", 1);

    IndexedDB.onerror = function (event) {
        console.error("Database error:", event.target.errorCode);
    };

    IndexedDB.onupgradeneeded = function (event) {
        const db = event.target.result;
        console.log("Upgrade needed. Current object store names:", db.objectStoreNames);

        // Create the object store if it doesn't exist
        if (!db.objectStoreNames.contains("contents")) {
            const objectStore = db.createObjectStore("contents", { keyPath: "id", autoIncrement: true });
            objectStore.createIndex("fileName", "fileName", { unique: true });
            console.log("Object store 'contents' created.");
        }
    };

    IndexedDB.onsuccess = function (event) {
        const db = event.target.result;
        console.log("Database opened successfully:", db);

        // Download and store files
        const downloadPromises = contents.map(content => {
            return new Promise((resolve, reject) => {
                const transaction = db.transaction(["contents"], "readwrite");
                const table_contents = transaction.objectStore("contents");
                const fileName = content.content_url.split('/').pop(); // Extract filename from URL

                fetch(content.content_url)
                    .then(response => {
                        if (!response.ok) {
                            throw new Error(`Error fetching content: ${response.status}`);
                        }
                        return response.blob(); // Convert the response to a Blob
                    })
                    .then(blob => {
                        const fileData = {
                            fileName: fileName,
                            fileContent: blob
                        };
                        const request = table_contents.add(fileData);
                        request.onsuccess = () => {
                            console.log(`File ${fileName} added successfully.`);
                            resolve(); // Resolve the promise
                        };
                        request.onerror = () => {
                            reject(new Error(`Error adding ${fileName} to database.`));
                        };
                    })
                    .catch(error => {
                        console.error("Error downloading file:", error);
                        reject(error); // Reject the promise on fetch error
                    });
            });
        });

        // Wait for all downloads and additions to complete
        Promise.all(downloadPromises)
            .then(() => {
                console.log('All content downloaded and stored successfully!');
                // Optionally call loadFiles() here to fetch the stored files
            })
            .catch(error => {
                console.error('Error storing files:', error);
            });
    };
}

// Example usage
// openDB([{ content_url: 'your_file_url_1' }, { content_url: 'your_file_url_2' }]);
function openDB(contents) {
    const IndexedDB = indexedDB.open("mirrorLinkContentStorage", 1);

    IndexedDB.onerror = function (event) {
        console.error("Database error:", event.target.errorCode);
    };

    IndexedDB.onupgradeneeded = function (event) {
        const db = event.target.result;
        console.log("Upgrade needed. Current object store names:", db.objectStoreNames);

        // Create the object store if it doesn't exist
        if (!db.objectStoreNames.contains("contents")) {
            const objectStore = db.createObjectStore("contents", { keyPath: "id", autoIncrement: true });
            objectStore.createIndex("Index", "fileName", { unique: true });
            console.log("Object store 'contents' created.");
        }
    };

    IndexedDB.onsuccess = function (event) {
        let temp_contents = []
        const db = event.target.result;
        const transaction = db.transaction(["contents"], "readwrite");
        const transaction_object = transaction.objectStore("contents");// Adding an object
        const downloadPromises = contents.map(content => {
            return new Promise((resolve, reject) => {
                const fileName = content.content_url.split('/').pop(); // Extract filename from URL
                try {
                    fetch(content.content_url)
                    .then(response => {
                        if (!response.ok) {
                            throw new Error(`Error fetching content: ${response.status}`);
                        }
                        return response.blob().then(fileContent => {
                            return { fileName, fileContent };
                          });
                    }).then(({fileName, fileContent})=>{
                        temp_contents.push(fileContent)
                        const transaction = db.transaction(["contents"], "readwrite");
                        const transaction_object = transaction.objectStore("contents");
                        transaction_object.add({fileName,fileContent})
                        resolve(); // Resolve the promise
                    })
                    .catch(error => {
                        reject(error); // Reject the promise on fetch error
                    });
                }
                catch{
                    console.log('here',error)
                    reject('No Network')
                }
            });
        });
        // Wait for all downloads and additions to complete
        Promise.all(downloadPromises)
            .then(() => {
                console.log('All content downloaded and stored successfully!');
                const transaction = db.transaction(["contents"], "readwrite");
                const transaction_object = transaction.objectStore("contents");
                transaction_object.openCursor().onsuccess = function (event) {
                    const cursor = event.target.result;
                    if (cursor) {
                        files.push(cursor.value.fileContent);
                        cursor.continue();
                    }
                };
                loadFiles(temp_contents)
            })
            .catch(error => {
                console.error(error);
            });

    }
}



function loadFiles(files) {
    const ContentPromise = [];
    files.forEach(file => {


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
                    ContentElement.push(video) 
                    resolve()// Load video content
                };
                fileReader.onerror = function (e) {
                    reject(e);
                };
                fileReader.readAsDataURL(file);

            }).catch((error)=>{
                console.log(error)
            })

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

    Promise.all(ContentPromise).then((res) => {

        console.log('contentElement',ContentElement)
        const startbutton = document.getElementById('startButton')
        const loadingText = document.getElementById('loadingText')
        startbutton.style.display = "flex";
        loadingText.style.display = "none";
    }).catch((error)=>{
        console.log(error)
    })
}


function startSlideshow() {
    const slideshowContainer = document.getElementById('slideshowContainer');
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
    login_container.style.display = 'none'; 
    const content = ContentElement[currentIndex];
    if (content.tagName == "VIDEO") {
        content.play().then(() => {
            content.onended = function () {
                showCurrentFile();
            };
        }).catch(error => {
            console.error("Failed to play video:", error);
        });
        slideshowContainer.appendChild(content);
    }
    else {
        setTimeout(() => {
            showCurrentFile(); // Call the function after a delay
        }, 4000);
        slideshowContainer.appendChild(content);
    }
    currentIndex = currentIndex + 1
    if (ContentElement.length === currentIndex){
        currentIndex = 0;
        loadFiles()
    }

}

