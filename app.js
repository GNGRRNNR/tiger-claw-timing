// --- Configuration ---
// IMPORTANT: Replace with your deployed Google Apps Script Web App URL
const SCRIPT_URL = 'YOUR_GOOGLE_APPS_SCRIPT_WEB_APP_URL';
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

    if (!currentCheckpoint || !currentRace) {
        showStatus('Error: Missing checkpoint or race in URL.', 'error', true);
        checkpointDisplayElement.textContent = 'Config Error!';
        scanButton.disabled = true;
        scanButton.textContent = 'Configuration Error';
        return;
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
    await fetchRunnerData();

    // 4. Initialize Scanner
    initializeScanner();

    // 5. Load recent scans from this session (not persistent across reloads for simplicity here)
    updateRecentScansUI();

    // 6. Start periodic sync
    syncIntervalId = setInterval(syncOfflineScans, SYNC_INTERVAL_MS);
    syncOfflineScans(); // Attempt initial sync

    showStatus('Ready. Enter Manual Bib or Start Scan.', 'info');
    scanButton.disabled = false; // Re-enable button after setup
    scanButton.textContent = 'Start QR Code Scan'; // Set correct text
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
        showStatus('Connection restored. Syncing pending scans...', 'info');
        syncOfflineScans(); // Attempt sync immediately when back online
    } else {
        connectionStatusElement.textContent = 'Offline';
        connectionStatusElement.className = 'absolute top-2 right-2 text-xs font-semibold px-2 py-1 rounded bg-yellow-100 text-yellow-800';
        showStatus('Connection lost. Scans will be saved locally.', 'warning');
        console.log('Status: Offline');
    }
}

async function fetchRunnerData() {
    if (!currentRace) return;
    if (SCRIPT_URL === 'YOUR_GOOGLE_APPS_SCRIPT_WEB_APP_URL') {
        showStatus('Error: App Script URL not configured.', 'error', true);
        return;
    }

    loadingSpinnerElement.classList.remove('hidden');
    totalActiveRunnersElement.textContent = '?';
    scannedCountElement.textContent = '0'; // Reset count while loading

    try {
        // Construct URL for GET request to fetch runner list
        const getUrl = `${SCRIPT_URL}?action=getRunners&race=${encodeURIComponent(currentRace)}`;
        const response = await fetch(getUrl);

        if (!response.ok) {
             const errorText = await response.text();
             throw new Error(`Failed to fetch runner data: ${response.status} ${errorText || ''}`);
        }

        const data = await response.json();

        if (data.status === 'success' && Array.isArray(data.runners)) {
            runnerData = data.runners; // Expecting [{bib, name, status}, ...]
            // Calculate total active runners (Status is blank or not DNS/DNF)
            totalActiveRunners = runnerData.filter(r => !r.status || (r.status.toUpperCase() !== 'DNS' && r.status.toUpperCase() !== 'DNF')).length;
            totalActiveRunnersElement.textContent = totalActiveRunners;
            scannedBibs.clear(); // Clear scanned set for the new list
            updateStatsUI(); // Update display
            showStatus(`Loaded ${runnerData.length} runners for ${currentRace}. ${totalActiveRunners} active.`, 'info');
            console.log("Runner data loaded:", runnerData);
        } else {
            throw new Error(data.message || 'Invalid data format received.');
        }
    } catch (error) {
        console.error('Error fetching runner data:', error);
        showStatus(`Error fetching runners: ${error.message}. Stats may be inaccurate.`, 'error');
        totalActiveRunnersElement.textContent = 'Err'; // Indicate error
        // Decide if the app should proceed without runner data (maybe allow scanning anyway?)
        // For now, we allow it, but stats will be off.
    } finally {
         loadingSpinnerElement.classList.add('hidden');
    }
}

async function syncOfflineScans() {
    if (!navigator.onLine) {
        console.log("Offline, skipping sync.");
        return;
    }
    if (SCRIPT_URL === 'YOUR_GOOGLE_APPS_SCRIPT_WEB_APP_URL') {
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

        // Send scans in batches (e.g., 10 at a time) or individually
        // For simplicity, sending individually here, but batching is better for many scans
        for (const scan of unsynced) {
            // Pass the stored name along with the bib during sync
            const success = await sendDataToSheet(scan.bib, scan.checkpoint, scan.timestamp, scan.race, scan.name);
            if (success) {
                await db.updateScanStatus(scan.id, 'synced');
                console.log(`Synced scan ID: ${scan.id}`);
            } else {
                console.warn(`Failed to sync scan ID: ${scan.id}. Will retry later.`);
                // Optional: Implement a max retry count or specific error handling
            }
        }
        showStatus('Sync attempt complete.', 'info');

    } catch (error) {
        console.error('Error during sync process:', error);
        showStatus(`Error during sync: ${error.message}`, 'error');
    }
}


// --- QR Scanner Logic ---
function initializeScanner() {
    try {
        html5QrCode = new Html5Qrcode("reader");
        // Don't enable button here, wait for full init in window.onload
    } catch (error) {
        console.error("Failed to initialize Html5Qrcode:", error);
        showStatus(`Error initializing scanner: ${error.message}`, 'error', true);
         scanButton.disabled = true;
         scanButton.textContent = 'Scanner Error';
    }
}

function startScanning() {
    if (isScanning || !html5QrCode) return;

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
        console.error(`Unable to start scanning: ${err}`);
        // Try the other camera if environment fails
        if (err.name === "NotAllowedError" || err.name === "NotFoundError" || err.name === "OverconstrainedError") {
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
            // html5QrCode.clear(); // Often called internally by stop, but can be explicit
            // html5QrCode = null; // Re-initialize if needed? Or keep instance? Keep for now.
        });
}

// ****** MODIFIED onScanSuccess ******
function onScanSuccess(decodedText, decodedResult) {
    const now = Date.now();
    if (now - lastScanTime < SCAN_THROTTLE_MS) {
        console.log("Scan throttled.");
        return; // Prevent rapid double scans
    }
    lastScanTime = now;
    const timestamp = new Date().toISOString();

    // --- Parse QR Code Data ---
    // Assuming format "BIB,RUNNER NAME" (e.g., "123,John Doe")
    // Adjust separator (e.g., ' ') if needed.
    const parts = decodedText.trim().split(',');
    let bibNumber = null;
    let nameFromQR = null; // Name extracted directly from QR

    if (parts.length >= 1) {
        bibNumber = parts[0].trim(); // First part is always bib
    }
    if (parts.length >= 2) {
         // Join remaining parts in case name has commas
        nameFromQR = parts.slice(1).join(',').trim();
    }

    // Validate Bib Number (basic check)
    if (!bibNumber || !/^\d+$/.test(bibNumber)) {
        console.warn(`Invalid QR data format: Bib number not found or invalid in "${decodedText}"`);
        showStatus(`Scan Error: Invalid QR data format.`, 'error');
        // Optional: Vibrate differently for error?
        if (navigator.vibrate) navigator.vibrate([50, 50, 50]); // Short pulses
        return; // Stop processing this scan
    }

    console.log(`Scan successful: Bib ${bibNumber}, Name (from QR): ${nameFromQR || 'N/A'} at ${timestamp}`);

    // --- Feedback ---
    // 1. Vibrate
    if (navigator.vibrate) {
        navigator.vibrate(150); // Vibrate for 150ms
    }
    // 2. Sound (using Tone.js)
    try {
        // Ensure Tone.js context is started (might need earlier user interaction)
        Tone.start().then(() => {
            const synth = new Tone.Synth().toDestination();
            synth.triggerAttackRelease("C5", "8n", Tone.now());
        });
    } catch (soundError) {
        console.warn("Could not play sound:", soundError); // Log warning if sound fails
    }
    // 3. Visual Flash
    document.body.classList.add('scan-success-flash');
    setTimeout(() => {
        document.body.classList.remove('scan-success-flash');
    }, 600); // Match animation duration

    // --- Process Scan ---
    // Pass both bib and the name found in the QR code
    processScanData(bibNumber, timestamp, nameFromQR);
}
// ****** END MODIFIED onScanSuccess ******

function onScanFailure(error) {
    // Log only occasionally or specific errors to avoid console spam
    // console.warn(`Code scan error = ${error}`);
}

// --- Manual Entry ---
manualSubmitButton.addEventListener('click', () => {
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

    // For manual entry, we don't have a name from QR, so pass null/undefined
    processScanData(bibNumber, timestamp, null);

    manualBibInput.value = ''; // Clear input field
});


// --- Data Processing & Storage ---
// ****** MODIFIED processScanData ******
// Added nameFromQR parameter
async function processScanData(bibNumber, timestamp, nameFromQR) {
     // 1. Determine Runner Name and Status
     // Prefer name/status from the fetched runner list if available and matches bib
    const runnerInfo = runnerData.find(r => r.bib === bibNumber);
    const runnerName = runnerInfo ? runnerInfo.name : (nameFromQR || 'Unknown'); // Use list name > QR name > 'Unknown'
    const runnerStatus = runnerInfo ? (runnerInfo.status || 'Active') : 'Unknown';

    // Display feedback using the determined name
    if (runnerInfo) {
         if (runnerStatus === 'DNS' || runnerStatus === 'DNF') {
             showStatus(`Warning: ${runnerStatus} - Bib ${bibNumber} (${runnerName}). Scan recorded.`, 'warning');
         } else {
             showStatus(`Scan: Bib ${bibNumber} (${runnerName})`, 'success');
         }
    } else if (runnerData.length > 0) {
        // Runner list loaded, but bib not found
        showStatus(`Warning: Bib ${bibNumber} not in list. Scan recorded (${nameFromQR || 'No Name'}).`, 'warning');
    } else {
         // Runner list not loaded, use QR name if available
         showStatus(`Scan: Bib ${bibNumber} (${nameFromQR || 'No Name'})`, 'success');
    }

    // 2. Add to Recent Scans UI (using the determined name)
    addScanToRecentList(bibNumber, timestamp, runnerName);

    // 3. Update Stats UI
    scannedBibs.add(bibNumber); // Add to the set of unique bibs scanned this session
    updateStatsUI();

    // 4. Store in IndexedDB
    try {
        const scanRecord = {
            bib: bibNumber,
            checkpoint: currentCheckpoint,
            timestamp: timestamp,
            race: currentRace,
            name: runnerName, // Store the determined name for potential use during sync
            status: 'unsynced' // Mark as not yet sent to server
        };
        const id = await db.addScan(scanRecord);
        console.log(`Scan stored locally with ID: ${id}, Name: ${runnerName}`);

        // 5. Attempt immediate sync if online
        if (navigator.onLine) {
             // Pass the determined name to the send function
            const success = await sendDataToSheet(bibNumber, currentCheckpoint, timestamp, currentRace, runnerName);
            if (success) {
                await db.updateScanStatus(id, 'synced');
                console.log(`Scan ID ${id} synced immediately.`);
            } else {
                 console.warn(`Immediate sync failed for scan ID ${id}. Will retry later.`);
                 // Status remains 'unsynced'
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
// ****** END MODIFIED processScanData ******


// ****** MODIFIED sendDataToSheet ******
// Added runnerName parameter
async function sendDataToSheet(runnerId, checkpoint, timestamp, race, runnerName) {
    if (SCRIPT_URL === 'YOUR_GOOGLE_APPS_SCRIPT_WEB_APP_URL') {
        console.error('Cannot send data: Google Apps Script URL not configured.');
        return false; // Indicate failure
    }

    const data = {
        action: 'recordScan', // Add action for backend routing
        bib: runnerId,
        checkpoint: checkpoint,
        timestamp: timestamp,
        race: race,
        name: runnerName // Send the name determined by the frontend
    };

    console.log("Sending data:", data);

    try {
        const response = await fetch(SCRIPT_URL, {
            method: 'POST',
            mode: 'cors',
            cache: 'no-cache',
            headers: {
                'Content-Type': 'text/plain', // Sending as text/plain often works better with doPost
            },
            redirect: 'follow',
             // Stringify data and send as plain text for simple doPost parsing
            body: JSON.stringify(data)
        });

        // Check if response is ok (status 200-299)
        if (!response.ok) {
            const errorText = await response.text(); // Try to get error details from response
            throw new Error(`Network response was not ok. Status: ${response.status}. Message: ${errorText || 'No details'}`);
        }

        const result = await response.json(); // Assuming backend returns JSON

        if (result.status === 'success') {
            console.log('Data sent successfully:', result.message);
            // Don't show status message here, as it might overwrite other messages.
            // Let the calling function handle UI updates.
            return true; // Indicate success
        } else {
            // Log specific error from backend if provided
            console.error('Error from backend:', result.message || 'Unknown error');
            showStatus(`Sync Error: ${result.message || 'Unknown error from server.'}`, 'error');
            return false; // Indicate failure
        }
    } catch (error) {
        console.error('Error sending data:', error);
        // Show error only if it's likely a persistent issue, not just a temporary network blip
        if (!navigator.onLine) {
             console.warn("Send failed while offline."); // Expected
        } else {
            // Show network/parsing errors
            showStatus(`Sync Error: ${error.message}. Will retry.`, 'error');
        }
        return false; // Indicate failure
    }
}
// ****** END MODIFIED sendDataToSheet ******


// --- UI Updates ---
function showStatus(message, type = 'info', permanent = false) {
    statusMessageElement.textContent = message;
    // Adjust class based on type, including online/offline status
    let currentType = type;
    if (!navigator.onLine && type !== 'error') {
        currentType = 'warning'; // Show warning color if offline, unless it's an error
    }
    statusMessageElement.className = `status-${currentType}`;
    console.log(`Status (${currentType}): ${message}`);

    // Optionally clear the message after a delay, unless permanent
    if (!permanent) {
        // Use a variable to track the timeout ID for this specific message
        const timeoutId = setTimeout(() => {
            // Check if the current message is still the one we set the timeout for
            if (statusMessageElement.textContent === message) {
                 // Restore to a default state based on online status
                 const defaultMsg = navigator.onLine ? 'Ready.' : 'Offline. Scans saved locally.';
                 const defaultType = navigator.onLine ? 'info' : 'warning';
                 // Only update if the message hasn't changed to something else important
                 if (statusMessageElement.className.includes(`status-${currentType}`)) {
                      showStatus(defaultMsg, defaultType);
                 }
            }
        }, 5000); // Clear after 5 seconds
    }
}


function updateStatsUI() {
    scannedCountElement.textContent = scannedBibs.size;
    // totalActiveRunnersElement is updated when runner data is fetched
}

// ****** MODIFIED addScanToRecentList ******
// Added name parameter
function addScanToRecentList(bib, timestamp, name) {
     const timeString = new Date(timestamp).toLocaleTimeString();
     // Include name in the recent scan object
     recentScans.unshift({ bib: bib, time: timeString, name: name }); // Add to beginning

    // Keep only the last MAX_RECENT_SCANS
    if (recentScans.length > MAX_RECENT_SCANS) {
        recentScans.pop(); // Remove the oldest
    }
    updateRecentScansUI();
}
// ****** END MODIFIED addScanToRecentList ******


// ****** MODIFIED updateRecentScansUI ******
// Displays name along with bib and time
function updateRecentScansUI() {
    recentScansListElement.innerHTML = ''; // Clear existing list

    if (recentScans.length === 0) {
        recentScansListElement.innerHTML = '<li class="p-2 text-gray-500 italic">No scans yet.</li>';
        return;
    }

    recentScans.forEach(scan => {
        const li = document.createElement('li');
        li.className = 'p-2 border-b border-gray-200 last:border-b-0';
        // Display name if available, otherwise just bib
        const nameText = scan.name && scan.name !== 'Unknown' ? ` (${scan.name})` : '';
        li.textContent = `Bib: ${scan.bib}${nameText} at ${scan.time}`;
        recentScansListElement.appendChild(li);
    });
}
// ****** END MODIFIED updateRecentScansUI ******

// --- Event Listeners ---
scanButton.addEventListener('click', () => {
    // Ensure Tone.js context is started by user interaction if not already
    Tone.start();

    if (isScanning) {
        stopScanning();
    } else {
        startScanning();
    }
});

