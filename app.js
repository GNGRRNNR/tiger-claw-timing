// --- Configuration ---
// IMPORTANT: Replace with your deployed Google Apps Script Web App URL
// ****** UPDATED SCRIPT URL ******
const SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbzYS0RC4S9oGb4ZGsyEukO9-RclUYEjC4OOg0XSgkBa-tdtqvU8Mm5IC2Y2mqN243Kd/exec';
const SCAN_THROTTLE_MS = 1500; // Min time between successful scans (1.5 seconds)
const SYNC_INTERVAL_MS = 30000; // Check for unsynced scans every 30 seconds
const MAX_RECENT_SCANS = 5; // How many recent scans to show in the list
// --- End Configuration ---

// --- DOM Elements ---
const readerElement = document.getElementById('reader');
const scanButton = document.getElementById('scanButton');
const statusMessageElement = document.getElementById('statusMessage');
const connectionStatusElement = document.getElementById('connectionStatus');
const checkpointDisplayElement = document.getElementById('checkpointDisplay');
const scannedCountElement = document.getElementById('scannedCount');
const totalActiveRunnersElement = document.getElementById('totalActiveRunners');
const loadingSpinnerElement = document.getElementById('loadingSpinner');
const manualBibInput = document.getElementById('manualBibInput');
const manualSubmitButton = document.getElementById('manualSubmitButton');
const recentScansListElement = document.getElementById('recentScansList');
const installButton = document.getElementById('installButton');

// --- App State ---
let html5QrCode = null;
let isScanning = false;
let lastScanTime = 0;
let currentCheckpoint = null;
let currentRace = null;
let runnerData = []; // Holds { bib: '101', name: 'John Doe', status: '' }
let totalActiveRunners = 0;
let scannedBibs = new Set(); // Track unique bibs scanned *at this checkpoint* in this session
let recentScans = []; // Array of { bib: '101', time: 'HH:MM:SS', name: 'Jane Doe' }
let syncIntervalId = null;
let deferredInstallPrompt = null; // For PWA installation
let toneJsStarted = false; // Track if Tone.js context has been started

// --- Initialization ---
window.addEventListener('load', async () => {
    showStatus('Initializing application...', 'info');
    setupServiceWorker();
    setupInstallButton();
    handleOnlineStatus(); // Initial check
    window.addEventListener('online', handleOnlineStatus);
    window.addEventListener('offline', handleOnlineStatus);

    // 1. Get Checkpoint/Race from URL
    const urlParams = new URLSearchParams(window.location.search);
    currentCheckpoint = urlParams.get('checkpoint');
    currentRace = urlParams.get('race');

    // *** Crucial Check ***
    if (!currentCheckpoint || !currentRace) {
        showStatus('Error: Missing checkpoint or race in URL. Please use the specific URL provided for this station.', 'error', true);
        checkpointDisplayElement.textContent = 'Config Error!';
        scanButton.disabled = true;
        scanButton.textContent = 'Configuration Error';
        console.error("URL must include ?checkpoint=CHECKPOINT_NAME&race=RACE_NAME");
        return; // Stop initialization if parameters are missing
    }
    checkpointDisplayElement.textContent = `${currentCheckpoint} (${currentRace})`;

    // 2. Initialize IndexedDB
    try {
        await db.init();
        showStatus('Database ready.', 'info');
    } catch (error) {
        showStatus(`Error initializing database: ${error.message}`, 'error', true);
        return;
    }

    // 3. Fetch Runner Data (Retry logic might be needed for flaky connections)
    await fetchRunnerData(); // This now only runs if checkpoint/race are present

    // 4. Initialize Scanner
    initializeScanner(); // This now only runs if checkpoint/race are present

    // 5. Load recent scans from this session (not persistent across reloads for simplicity here)
    updateRecentScansUI();

    // 6. Start periodic sync
    syncIntervalId = setInterval(syncOfflineScans, SYNC_INTERVAL_MS);
    syncOfflineScans(); // Attempt initial sync

    // Only enable scan button if init was successful
    if (currentCheckpoint && currentRace) {
        showStatus('Ready. Enter Manual Bib or Start Scan.', 'info');
        scanButton.disabled = false; // Enable button after successful setup
        scanButton.textContent = 'Start QR Code Scan';
    }
});

// --- PWA & Service Worker ---
function setupServiceWorker() {
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('sw.js')
            .then(registration => console.log('Service Worker registered with scope:', registration.scope))
            .catch(error => console.error('Service Worker registration failed:', error));
    }
}

function setupInstallButton() {
     window.addEventListener('beforeinstallprompt', (event) => {
        // Prevent the mini-infobar from appearing on mobile
        event.preventDefault();
        // Stash the event so it can be triggered later.
        deferredInstallPrompt = event;
        // Update UI notify the user they can install the PWA
        installButton.classList.remove('hidden');
        console.log('\'beforeinstallprompt\' event was fired.');
    });

    installButton.addEventListener('click', async () => {
        if (!deferredInstallPrompt) {
            console.log('Install prompt not available.');
            return;
        }
        // Show the install prompt
        deferredInstallPrompt.prompt();
        // Wait for the user to respond to the prompt
        const { outcome } = await deferredInstallPrompt.userChoice;
        console.log(`User response to the install prompt: ${outcome}`);
        // We've used the prompt, and can't use it again, discard it
        deferredInstallPrompt = null;
        // Hide the install button
        installButton.classList.add('hidden');
    });

     window.addEventListener('appinstalled', () => {
        console.log('PWA was installed');
        // Hide the install button maybe?
        installButton.classList.add('hidden');
        deferredInstallPrompt = null; // Clear the prompt
    });
}


// --- Network & Syncing ---
function handleOnlineStatus() {
    if (navigator.onLine) {
        connectionStatusElement.textContent = 'Online';
        connectionStatusElement.className = 'absolute top-2 right-2 text-xs font-semibold px-2 py-1 rounded bg-green-100 text-green-800';
        console.log('Status: Online');
        // Only sync if app is configured correctly
        if (currentCheckpoint && currentRace && SCRIPT_URL !== 'YOUR_GOOGLE_APPS_SCRIPT_WEB_APP_URL') {
             showStatus('Connection restored. Syncing pending scans...', 'info');
             syncOfflineScans(); // Attempt sync immediately when back online
        } else if (SCRIPT_URL === 'YOUR_GOOGLE_APPS_SCRIPT_WEB_APP_URL') {
             // This case should no longer happen if URL is correctly set above
             showStatus('Online, but App Script URL not configured.', 'warning');
        } else {
             // This case happens if the page is loaded without parameters
             showStatus('Online, but Checkpoint/Race missing in URL.', 'warning');
        }
    } else {
        connectionStatusElement.textContent = 'Offline';
        connectionStatusElement.className = 'absolute top-2 right-2 text-xs font-semibold px-2 py-1 rounded bg-yellow-100 text-yellow-800';
        showStatus('Connection lost. Scans will be saved locally.', 'warning');
        console.log('Status: Offline');
    }
}

async function fetchRunnerData() {
    // Should only be called if currentRace is set
    if (!currentRace) return;
    // *** Crucial Check ***
    if (SCRIPT_URL === 'YOUR_GOOGLE_APPS_SCRIPT_WEB_APP_URL' || !SCRIPT_URL) {
        // This check is now mainly a safeguard; the URL should be set.
        showStatus('Error: App Script URL not configured in app.js.', 'error', true);
        console.error('SCRIPT_URL is not set.');
        totalActiveRunnersElement.textContent = 'CFG'; // Indicate config error
        return;
    }

    loadingSpinnerElement.classList.remove('hidden');
    totalActiveRunnersElement.textContent = '?';
    scannedCountElement.textContent = '0'; // Reset count while loading

    try {
        // Construct URL for GET request to fetch runner list
        const getUrl = `${SCRIPT_URL}?action=getRunners&race=${encodeURIComponent(currentRace)}`;
        console.log(`Fetching runner data from: ${getUrl}`);
        const response = await fetch(getUrl);

        if (!response.ok) {
             const errorText = await response.text();
             // Log the error text from Apps Script if available
             console.error(`Error response from Apps Script (getRunners): ${errorText}`);
             throw new Error(`Failed to fetch runner data: ${response.status} ${errorText || response.statusText}`);
        }

        const data = await response.json();

        if (data.status === 'success' && Array.isArray(data.runners)) {
            runnerData = data.runners; // Expecting [{bib, name, status}, ...]
            // Calculate total active runners (Status is blank or not DNS/DNF)
            totalActiveRunners = runnerData.filter(r => !r.status || (r.status.toUpperCase() !== 'DNS' && r.status.toUpperCase() !== 'DNF')).length;
            totalActiveRunnersElement.textContent = totalActiveRunners;
            scannedBibs.clear(); // Clear scanned set for the new list
            updateStatsUI(); // Update display
            showStatus(`Loaded ${runnerData.length} runners for ${currentRace}. ${totalActiveRunners} active. Ready.`, 'info');
            console.log("Runner data loaded:", runnerData);
        } else {
             // Log error message from Apps Script response if status is not 'success'
             console.error(`Invalid data format received from Apps Script (getRunners): ${data.message || JSON.stringify(data)}`);
            throw new Error(data.message || 'Invalid data format received from server.');
        }
    } catch (error) {
        // Catch fetch errors and errors thrown above
        console.error('Error fetching runner data:', error);
        showStatus(`Error fetching runners: ${error.message}. Stats may be inaccurate.`, 'error');
        totalActiveRunnersElement.textContent = 'Err'; // Indicate error
    } finally {
         loadingSpinnerElement.classList.add('hidden');
    }
}

async function syncOfflineScans() {
    if (!navigator.onLine) {
        console.log("Offline, skipping sync.");
        return;
    }
    // *** Crucial Check ***
    if (SCRIPT_URL === 'YOUR_GOOGLE_APPS_SCRIPT_WEB_APP_URL' || !SCRIPT_URL) {
        console.error('Cannot sync: Google Apps Script URL not configured.');
        return;
    }

    try {
        const unsynced = await db.getUnsyncedScans();
        if (unsynced.length === 0) {
            console.log("No unsynced scans.");
            return;
        }

        showStatus(`Syncing ${unsynced.length} saved scan(s)...`, 'info');
        console.log("Attempting to sync:", unsynced);

        let allSynced = true;
        for (const scan of unsynced) {
            // Pass the stored name along with the bib during sync
            const success = await sendDataToSheet(scan.bib, scan.checkpoint, scan.timestamp, scan.race, scan.name);
            if (success) {
                await db.updateScanStatus(scan.id, 'synced');
                console.log(`Synced scan ID: ${scan.id}`);
            } else {
                allSynced = false;
                console.warn(`Failed to sync scan ID: ${scan.id}. Will retry later.`);
                // Stop trying to sync others in this batch if one fails,
                // as it might indicate a persistent server/network issue.
                break;
            }
        }
        if (allSynced && unsynced.length > 0) {
             showStatus('Sync complete. All saved scans sent.', 'success');
        } else if (!allSynced) {
             showStatus('Sync incomplete. Some scans failed to send. Will retry later.', 'warning');
        }


    } catch (error) {
        console.error('Error during sync process:', error);
        showStatus(`Error during sync: ${error.message}`, 'error');
    }
}


// --- QR Scanner Logic ---
function initializeScanner() {
    try {
        html5QrCode = new Html5Qrcode("reader");
        // Button is enabled in window.onload if init succeeds
    } catch (error) {
        console.error("Failed to initialize Html5Qrcode:", error);
        showStatus(`Error initializing scanner: ${error.message}`, 'error', true);
         scanButton.disabled = true;
         scanButton.textContent = 'Scanner Error';
    }
}

function startScanning() {
    if (isScanning || !html5QrCode) return;

    // --- Start Tone.js context on user gesture ---
    startToneContext(); // Ensure context is ready before camera starts

    const config = { fps: 10, qrbox: { width: 250, height: 250 }, aspectRatio: 1.0 };
     // Try environment camera first, then user
    const cameraConfig = { facingMode: "environment" };

    showStatus('Starting scanner...', 'info');
    readerElement.classList.remove('hidden'); // Show the reader

    html5QrCode.start(
        cameraConfig,
        config,
        onScanSuccess,
        onScanFailure
    )
    .then(() => {
        isScanning = true;
        scanButton.textContent = 'Stop Scan';
        scanButton.classList.remove('bg-indigo-600', 'hover:bg-indigo-700');
        scanButton.classList.add('bg-red-600', 'hover:bg-red-700');
        showStatus('Scanner active. Point at QR code.', 'info');
    })
    .catch((err) => {
        console.error(`Unable to start scanning with environment camera: ${err}`);
        // Try the other camera if environment fails
        if (err.name === "NotAllowedError" || err.name === "NotFoundError" || err.name === "OverconstrainedError" || err.name === "NotReadableError") {
             console.log("Environment camera failed or not found, trying front camera...");
             showStatus('Trying front camera...', 'info');
             html5QrCode.start({ facingMode: "user" }, config, onScanSuccess, onScanFailure)
                 .then(() => {
                     isScanning = true;
                     scanButton.textContent = 'Stop Scan';
                     scanButton.classList.remove('bg-indigo-600', 'hover:bg-indigo-700');
                     scanButton.classList.add('bg-red-600', 'hover:bg-red-700');
                     showStatus('Scanner active (using front camera).', 'info');
                 })
                 .catch(err2 => {
                      console.error(`Unable to start scanning with front camera either: ${err2}`);
                      showStatus(`Scanner Error: ${err2.message}. Check camera permissions.`, 'error');
                      readerElement.classList.add('hidden'); // Hide reader on error
                      isScanning = false; // Ensure state is correct
                      scanButton.textContent = 'Scanner Error';
                      scanButton.disabled = true;
                 });
        } else {
            showStatus(`Scanner Error: ${err.message}. Check permissions.`, 'error');
             readerElement.classList.add('hidden');
             scanButton.textContent = 'Scanner Error';
             scanButton.disabled = true;
        }
    });
}

function stopScanning() {
    if (!isScanning || !html5QrCode) return;

    html5QrCode.stop()
        .then(() => {
            console.log("QR Code scanning stopped.");
        })
        .catch((err) => {
            console.error(`Failed to stop scanning cleanly: ${err}`);
            // Even if stop fails, update UI
        })
        .finally(() => {
            // This block executes regardless of success/failure of stop()
            isScanning = false;
            scanButton.textContent = 'Start QR Code Scan';
            scanButton.classList.remove('bg-red-600', 'hover:bg-red-700');
            scanButton.classList.add('bg-indigo-600', 'hover:bg-indigo-700');
            readerElement.classList.add('hidden'); // Hide the reader element
            showStatus('Scanner stopped.', 'info');
            // Consider clearing the stream if issues persist on restart
            // try { html5QrCode.clear(); } catch(e) { console.warn("Error clearing QR code instance", e); }
        });
}

function onScanSuccess(decodedText, decodedResult) {
    const now = Date.now();
    if (now - lastScanTime < SCAN_THROTTLE_MS) {
        console.log("Scan throttled.");
        return; // Prevent rapid double scans
    }
    lastScanTime = now;
    const timestamp = new Date().toISOString();

    // --- Parse QR Code Data ---
    const parts = decodedText.trim().split(',');
    let bibNumber = null;
    let nameFromQR = null;

    if (parts.length >= 1) {
        bibNumber = parts[0].trim();
    }
    if (parts.length >= 2) {
        nameFromQR = parts.slice(1).join(',').trim();
    }

    if (!bibNumber || !/^\d+$/.test(bibNumber)) {
        console.warn(`Invalid QR data format: Bib number not found or invalid in "${decodedText}"`);
        showStatus(`Scan Error: Invalid QR data format.`, 'error');
        if (navigator.vibrate) navigator.vibrate([50, 50, 50]);
        return;
    }

    console.log(`Scan successful: Bib ${bibNumber}, Name (from QR): ${nameFromQR || 'N/A'} at ${timestamp}`);

    // --- Feedback ---
    // 1. Vibrate
    if (navigator.vibrate) {
        navigator.vibrate(150);
    }
    // 2. Sound (Ensure Tone.js context is started)
    playSound(); // Call helper function for sound
    // 3. Visual Flash
    document.body.classList.add('scan-success-flash');
    setTimeout(() => {
        document.body.classList.remove('scan-success-flash');
    }, 600);

    // --- Process Scan ---
    processScanData(bibNumber, timestamp, nameFromQR);
}

function onScanFailure(error) {
    // console.warn(`Code scan error = ${error}`);
}

// --- Manual Entry ---
manualSubmitButton.addEventListener('click', () => {
    // --- Start Tone.js context on user gesture ---
    startToneContext(); // Ensure context is ready

    const bibNumber = manualBibInput.value.trim();
    if (!bibNumber) {
        showStatus('Please enter a Bib Number.', 'error');
        return;
    }
    if (!/^\d+$/.test(bibNumber)) {
         showStatus('Invalid Bib Number format (should be digits only).', 'error');
         return;
    }

    const timestamp = new Date().toISOString();
    console.log(`Manual entry: Bib ${bibNumber} at ${timestamp}`);

    // --- Feedback for Manual Entry ---
     if (navigator.vibrate) navigator.vibrate(100); // Shorter vibration
     playSound(); // Play sound
     // Maybe a different visual flash? Or just rely on status message.

    processScanData(bibNumber, timestamp, null); // Pass null for nameFromQR

    manualBibInput.value = ''; // Clear input field
});


// --- Data Processing & Storage ---
async function processScanData(bibNumber, timestamp, nameFromQR) {
     // 1. Determine Runner Name and Status
    const runnerInfo = runnerData.find(r => r.bib === bibNumber);
    const runnerName = runnerInfo ? runnerInfo.name : (nameFromQR || 'Unknown');
    const runnerStatus = runnerInfo ? (runnerInfo.status || 'Active') : 'Unknown';

    // Display feedback using the determined name
    if (runnerInfo) {
         if (runnerStatus === 'DNS' || runnerStatus === 'DNF') {
             showStatus(`Warning: ${runnerStatus} - Bib ${bibNumber} (${runnerName}). Scan recorded.`, 'warning');
         } else {
             showStatus(`Scan: Bib ${bibNumber} (${runnerName})`, 'success');
         }
    } else if (runnerData.length > 0) {
        // Runner list was loaded, but bib not found
        showStatus(`Warning: Bib ${bibNumber} not in list. Scan recorded (${nameFromQR || 'No Name'}).`, 'warning');
    } else {
         // Runner list wasn't loaded or failed to load
         showStatus(`Scan: Bib ${bibNumber} (${nameFromQR || 'No Name'})`, 'success');
    }

    // 2. Add to Recent Scans UI
    addScanToRecentList(bibNumber, timestamp, runnerName);

    // 3. Update Stats UI
    scannedBibs.add(bibNumber);
    updateStatsUI();

    // 4. Store in IndexedDB
    try {
        const scanRecord = {
            bib: bibNumber,
            checkpoint: currentCheckpoint,
            timestamp: timestamp,
            race: currentRace,
            name: runnerName, // Store the determined name
            status: 'unsynced'
        };
        const id = await db.addScan(scanRecord);
        console.log(`Scan stored locally with ID: ${id}, Name: ${runnerName}`);

        // 5. Attempt immediate sync if online
        if (navigator.onLine) {
            const success = await sendDataToSheet(bibNumber, currentCheckpoint, timestamp, currentRace, runnerName);
            if (success) {
                await db.updateScanStatus(id, 'synced');
                console.log(`Scan ID ${id} synced immediately.`);
            } else {
                 console.warn(`Immediate sync failed for scan ID ${id}. Will retry later.`);
                 // Optionally update status message if sync fails immediately
                 showStatus(`Scan for ${bibNumber} saved, but sync failed. Will retry.`, 'warning');
            }
        } else {
            console.log(`Offline. Scan ID ${id} saved for later sync.`);
            showStatus(`Offline: Scan for ${bibNumber} saved locally.`, 'warning');
        }

    } catch (error) {
        console.error('Error processing or storing scan:', error);
        showStatus(`Error saving scan: ${error.message}`, 'error');
    }
}

async function sendDataToSheet(runnerId, checkpoint, timestamp, race, runnerName) {
    // *** Crucial Check ***
    if (SCRIPT_URL === 'YOUR_GOOGLE_APPS_SCRIPT_WEB_APP_URL' || !SCRIPT_URL) {
        console.error('Cannot send data: Google Apps Script URL not configured.');
        return false; // Indicate failure
    }

    const data = {
        action: 'recordScan',
        bib: runnerId,
        checkpoint: checkpoint,
        timestamp: timestamp,
        race: race,
        name: runnerName
    };

    console.log("Sending data:", data);

    try {
        const response = await fetch(SCRIPT_URL, {
            method: 'POST',
            mode: 'cors',
            cache: 'no-cache',
            headers: {
                'Content-Type': 'text/plain', // Keep as text/plain for simple doPost parsing
            },
            redirect: 'follow',
            body: JSON.stringify(data) // Send stringified JSON
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error(`Network error sending data: ${response.status} - ${errorText}`);
             // Try to parse errorText as JSON, maybe Apps Script sent structured error
             let backendMessage = errorText;
             try {
                 const errorJson = JSON.parse(errorText);
                 if (errorJson && errorJson.message) {
                     backendMessage = errorJson.message;
                 }
             } catch (e) { /* Ignore parsing error, use raw text */ }
            throw new Error(`Sync failed: ${response.status} ${backendMessage || response.statusText}`);
        }

        const result = await response.json();

        if (result.status === 'success') {
            console.log('Data sent successfully:', result.message);
            return true; // Indicate success
        } else {
            // Log specific error from backend if provided
            console.error('Error from backend:', result.message || 'Unknown error');
            // Show a more specific error if possible
            showStatus(`Sync Error: ${result.message || 'Unknown error from server.'}`, 'error');
            return false; // Indicate failure
        }
    } catch (error) {
        // Catches fetch errors and errors thrown above
        console.error('Error sending data:', error);
        if (!navigator.onLine) {
             console.warn("Send failed while offline."); // Expected
        } else {
            // Show network/parsing errors or errors from backend
            showStatus(`Sync Error: ${error.message}. Will retry.`, 'error');
        }
        return false; // Indicate failure
    }
}


// --- UI Updates ---
let statusTimeoutId = null; // Keep track of the status message timeout

function showStatus(message, type = 'info', permanent = false) {
    // Clear any existing timeout to prevent old messages from reappearing
    if (statusTimeoutId) {
        clearTimeout(statusTimeoutId);
        statusTimeoutId = null;
    }

    statusMessageElement.textContent = message;
    let currentType = type;
    // If offline, most messages become 'warning' unless they are 'error'
    if (!navigator.onLine && type !== 'error') {
        currentType = 'warning';
    }
    statusMessageElement.className = `status-${currentType}`;
    console.log(`Status (${currentType}): ${message}`);

    // Set a new timeout unless the message is permanent or an error
    // Errors should persist until the next status update
    if (!permanent && type !== 'error') {
        statusTimeoutId = setTimeout(() => {
            // Check if the message is still the one we set the timeout for
            // And if the type is still the same (e.g. hasn't become offline warning)
            if (statusMessageElement.textContent === message && statusMessageElement.className.includes(`status-${currentType}`)) {
                 const defaultMsg = navigator.onLine ? 'Ready.' : 'Offline. Scans saved locally.';
                 const defaultType = navigator.onLine ? 'info' : 'warning';
                 showStatus(defaultMsg, defaultType); // Show the default message
            }
             statusTimeoutId = null; // Clear the timeout ID tracker
        }, 5000); // Clear after 5 seconds
    }
}


function updateStatsUI() {
    scannedCountElement.textContent = scannedBibs.size;
    // totalActiveRunnersElement is updated when runner data is fetched
}

function addScanToRecentList(bib, timestamp, name) {
     const timeString = new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit'}); // Format time HH:MM:SS
     recentScans.unshift({ bib: bib, time: timeString, name: name }); // Add to beginning

    if (recentScans.length > MAX_RECENT_SCANS) {
        recentScans.pop(); // Remove the oldest
    }
    updateRecentScansUI();
}

function updateRecentScansUI() {
    recentScansListElement.innerHTML = ''; // Clear existing list

    if (recentScans.length === 0) {
        recentScansListElement.innerHTML = '<li class="p-2 text-gray-500 italic">No scans yet.</li>';
        return;
    }

    recentScans.forEach(scan => {
        const li = document.createElement('li');
        li.className = 'p-2 border-b border-gray-200 last:border-b-0';
        const nameText = scan.name && scan.name !== 'Unknown' ? ` (${scan.name})` : '';
        // Display Bib, Name (if known), and Time
        li.textContent = `Bib: ${scan.bib}${nameText} at ${scan.time}`;
        recentScansListElement.appendChild(li);
    });
}

// --- Audio Handling ---
async function startToneContext() {
    // Start context only once
    if (!toneJsStarted && typeof Tone !== 'undefined' && Tone.context.state !== 'running') {
        console.log('Attempting to start Tone.js Audio Context...');
        try {
            await Tone.start();
            toneJsStarted = true;
            console.log('Tone.js Audio Context started successfully.');
        } catch (e) {
            console.error('Failed to start Tone.js context:', e);
            // Maybe show a warning that sound won't work
            showStatus('Warning: Could not enable audio chime.', 'warning');
        }
    }
}

function playSound() {
    // Check if Tone is available and context is running
    if (!toneJsStarted || typeof Tone === 'undefined' || Tone.context.state !== 'running') {
        console.warn("Cannot play sound: Tone.js context not started or not running.");
        // Optionally try starting again, though likely won't work outside user gesture
        // startToneContext();
        return;
    }

    try {
        // Create synth only when needed
        const synth = new Tone.Synth().toDestination();
        synth.triggerAttackRelease("C5", "8n", Tone.now());
        // Dispose synth after sound plays to free resources
        setTimeout(() => {
             if (synth && !synth.disposed) {
                 synth.dispose();
             }
        }, 500); // Dispose after 500ms
    } catch (soundError) {
        console.warn("Could not play sound:", soundError);
    }
}


// --- Event Listeners ---
scanButton.addEventListener('click', () => {
    // Ensure Tone.js context is started by this user interaction
    startToneContext(); // Call this first

    if (isScanning) {
        stopScanning();
    } else {
        startScanning();
    }
});

// Add listener for manual submit button as well to ensure context starts
manualSubmitButton.addEventListener('click', startToneContext);

