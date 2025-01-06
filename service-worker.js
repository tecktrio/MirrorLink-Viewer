// service-worker.js

// const CACHE_NAME = 'api-cache-v1';

// Function to fetch data from the API
async function fetchDataFromAPI() {
  const apiUrl = 'https://jsonplaceholder.typicode.com/posts'; // Example API

  try {
    const response = await fetch(apiUrl);
    const data = await response.json();

    // Log the data to the console (you can do something else with it)
    console.log('API Data:', data);
  } catch (error) {
    console.error('API fetch error:', error);
  }
}

// Install event for the service worker
self.addEventListener('install', (event) => {
  console.log('Service worker installed');
});

// Activate event for the service worker
self.addEventListener('activate', (event) => {
  console.log('Service worker activated');
});

// Listen for a message to start periodic sync
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'START_SYNC') {
    // Start periodic sync to call the API every minute (60,000 ms)
    self.registration.periodicSync.register({
      tag: 'fetch-api-data',
      minInterval: 60 * 100, // 1 minute in milliseconds
    });
  }
});

// Periodic sync event to handle API request
self.addEventListener('periodicsync', (event) => {
  if (event.tag === 'fetch-api-data') {
    console.log('calling')
    event.waitUntil(fetchDataFromAPI());
  }
});

// Handle fetch events (optional, for caching and offline support)
// self.addEventListener('fetch', (event) => {
//   // You can cache or manage API requests here if needed
// });
