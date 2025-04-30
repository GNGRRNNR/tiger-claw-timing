// --- Configuration ---
// Google Apps Script Web App URL (Points to script bound to "2025 TIGER CLAW SCANS + RESULTS")
const SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbwZhevUNNbiBcozjivgWRDqRSqftE9SyxciaO3vg-Px3TA9LHCaVJlMQrpx1GVfLPU/exec'; // <-- PASTE LATEST URL HERE!
const SCAN_THROTTLE_MS = 1500; // Min time between successful scans (1.5 seconds)
const SYNC_INTERVAL_MS = 30000; // Check for unsynced scans every 30 seconds
const MAX_RECENT_SCANS = 5; // How many recent scans to show in the list
const RUNNER_REFRESH_INTERVAL_MS = 5 * 60 * 1000; // Refresh runner list every 5 minutes
const SCAN_COUNT_REFRESH_INTERVAL_MS = 30 * 1000; // Refresh scan count every 30 seconds
const FLASH_DURATION_MS = 300; // How long the green flash stays visible (slightly shorter)
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
const installButton = document.getElementById('installButton'); // For non-iOS install prompt
const statsDisplayElement = document.getElementById('statsDisplay');
const flashOverlayElement = document.getElementById('flashOverlay'); // Flash overlay
const iosInstallInstructionsElement = document.getElementById('iosInstallInstructions'); // iOS instructions

// --- App State ---
let html5QrCode = null;
let isScanning = false;
let lastScanTime = 0;
let currentCheckpoint = null;
let currentRace = null;
let runnerData = []; // Holds { bib: '101', name: 'John Doe', status: '' }
let totalActiveRunners = 0; // Updated periodically
let currentScanCount = 0; // Fetched from sheet periodically
let recentScans = []; // Array of { bib: '101', time: 'HH:MM:SS', name: 'Jane Doe' }
let syncIntervalId = null;
let runnerRefreshIntervalId = null;
let scanCountRefreshIntervalId = null;
let deferredInstallPrompt = null; // For PWA installation
let toneJsStarted = false; // Track if Tone.js context has been started
let isFetchingScanCount = false; // Prevent simultaneous fetches
let isFetchingRunners = false; // Prevent simultaneous fetches

// --- Initialization ---
window.addEventListener('load', async () => {
    showStatus('Initializing application...', 'info');
    setupServiceWorker();
    setupInstallButton(); // Sets up install button OR iOS instructions
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
        // Hide stats display if config error
        if(statsDisplayElement) statsDisplayElement.classList.add('hidden');
        return; // Stop initialization if parameters are missing
    }
    checkpointDisplayElement.textContent = `${currentCheckpoint} (${currentRace})`;
    // Ensure stats display is visible if config is okay
    if(statsDisplayElement) statsDisplayElement.classList.remove('hidden');


    // 2. Initialize IndexedDB (can happen early)
    try {
        await db.init();
        showStatus('Database ready.', 'info');
    } catch (error) {
        showStatus(`Error initializing database: ${error.message}`, 'error', true);
        return;
    }

    // 3. **PRIORITY:** Initial Fetch of Runner List and Scan Count
    showStatus('Loading initial race data...', 'info');
    loadingSpinnerElement.classList.remove('hidden');
    await Promise.allSettled([
        fetchRunnerData(true),
        fetchScanCount(true)
    ]);
    loadingSpinnerElement.classList.add('hidden');

    // 4. Initialize Scanner
    initializeScanner();

    // 5. Load recent scans from this session
    updateRecentScansUI();

    // 6. Start periodic sync and data refreshes
    syncIntervalId = setInterval(syncOfflineScans, SYNC_INTERVAL_MS);
    runnerRefreshIntervalId = setInterval(() => fetchRunnerData(false), RUNNER_REFRESH_INTERVAL_MS);
    scanCountRefreshIntervalId = setInterval(() => fetchScanCount(false), SCAN_COUNT_REFRESH_INTERVAL_MS);
    syncOfflineScans();

    // 7. Enable UI
    if (currentCheckpoint && currentRace) {
        showStatus('Ready. Enter Manual Bib or Start Scan.', 'info');
        scanButton.disabled = false;
        scanButton.textContent = 'Start QR Code Scan';
    } else {
        showStatus('Initialization incomplete due to config error.', 'error', true);
    }
});

// --- PWA & Service Worker ---
// (setupServiceWorker, isIOS, setupInstallButton remain the same)
function setupServiceWorker() {
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('sw.js')
            .then(registration => console.log('Service Worker registered with scope:', registration.scope))
            .catch(error => console.error('Service Worker registration failed:', error));
    }
}
function isIOS() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
}
function setupInstallButton() {
     if (isIOS()) {
         if (iosInstallInstructionsElement) {
             iosInstallInstructionsElement.innerHTML = `To install on iOS: Tap the Share button <img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' fill='currentColor' viewBox='0 0 16 16'%3E%3Cpath d='M.5 9.9a.5.5 0 0 1 .5.5v2.5a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-2.5a.5.5 0 0 1 1 0v2.5a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2v-2.5a.5.5 0 0 1 .5-.5z'/%3E%3Cpath d='M7.646 1.146a.5.5 0 0 1 .708 0l3 3a.5.5 0 0 1-.708.708L8.5 2.707V11.5a.5.5 0 0 1-1 0V2.707L5.354 4.854a.5.5 0 1 1-.708-.708l3-3z'/%3E%3C/svg%3E" alt="Share Icon" style="display: inline; height: 1em; vertical-align: middle;">, then scroll down and tap 'Add to Home Screen'.`;
             iosInstallInstructionsElement.classList.remove('hidden');
         }
         console.log('iOS detected, showing install instructions.');
     } else {
         window.addEventListener('beforeinstallprompt', (event) => {
            event.preventDefault();
            deferredInstallPrompt = event;
            if (installButton) installButton.classList.remove('hidden');
            console.log('\'beforeinstallprompt\' event was fired.');
        });
        if (installButton) {
            installButton.addEventListener('click', async () => {
                if (!deferredInstallPrompt) { console.log('Install prompt not available.'); return; }
                deferredInstallPrompt.prompt();
                const { outcome } = await deferredInstallPrompt.userChoice;
                console.log(`User response: ${outcome}`);
                deferredInstallPrompt = null;
                installButton.classList.add('hidden');
            });
        }
     }
     window.addEventListener('appinstalled', () => {
        console.log('PWA was installed');
        if (installButton) installButton.classList.add('hidden');
        if (iosInstallInstructionsElement) iosInstallInstructionsElement.classList.add('hidden');
        deferredInstallPrompt = null;
    });
}


// --- Network & Syncing ---
// (handleOnlineStatus, fetchRunnerData, fetchScanCount, syncOfflineScans remain the same)
function handleOnlineStatus() {
    if (navigator.onLine) {
        connectionStatusElement.textContent = 'Online';
        connectionStatusElement.className = 'absolute top-2 right-2 text-xs font-semibold px-2 py-1 rounded bg-green-100 text-green-800';
        console.log('Status: Online');
        if (currentCheckpoint && currentRace) {
             showStatus('Connection restored. Syncing & refreshing...', 'info');
             syncOfflineScans();
             fetchRunnerData(true);
             fetchScanCount(true);
        } else {
             showStatus('Online, but Checkpoint/Race missing in URL.', 'warning');
        }
    } else {
        connectionStatusElement.textContent = 'Offline';
        connectionStatusElement.className = 'absolute top-2 right-2 text-xs font-semibold px-2 py-1 rounded bg-yellow-100 text-yellow-800';
        showStatus('Connection lost. Scans will be saved locally.', 'warning');
        console.log('Status: Offline');
    }
}
async function fetchRunnerData(force = false) {
    if (!currentRace || isFetchingRunners) return;
    if (!force && !navigator.onLine) return;
    isFetchingRunners = true; console.log(`Fetching runner data (force=${force})...`);
    if (force) loadingSpinnerElement.classList.remove('hidden');
    try {
        const getUrl = `${SCRIPT_URL}?action=getRunners&race=${encodeURIComponent(currentRace)}&t=${Date.now()}`;
        const response = await fetch(getUrl);
        if (!response.ok) {
             const errorText = await response.text(); console.error(`Error response (getRunners): ${errorText}`);
             showStatus(`Warning: Could not refresh runner list (${response.status}).`, 'warning'); return;
        }
        const data = await response.json();
        if (data.status === 'success' && Array.isArray(data.runners)) {
            runnerData = data.runners;
            totalActiveRunners = runnerData.filter(r => !r.status || (r.status.toUpperCase() !== 'DNS' && r.status.toUpperCase() !== 'DNF')).length;
            console.log(`Refreshed runner data: ${runnerData.length} total, ${totalActiveRunners} active.`);
            updateStatsUI();
        } else {
             console.error(`Invalid data format (getRunners): ${data.message || JSON.stringify(data)}`);
             showStatus(`Warning: Invalid runner data received.`, 'warning');
        }
    } catch (error) {
        console.error('Error fetching runner data:', error);
        showStatus(`Error refreshing runners: ${error.message}.`, 'error');
    } finally {
         isFetchingRunners = false; if (force) loadingSpinnerElement.classList.add('hidden');
    }
}
async function fetchScanCount(force = false) {
    if (!currentRace || !currentCheckpoint || isFetchingScanCount) return;
    if (!force && !navigator.onLine) return;
    isFetchingScanCount = true; console.log(`Fetching scan count (force=${force})...`);
    if (force) loadingSpinnerElement.classList.remove('hidden');
    try {
        const getUrl = `${SCRIPT_URL}?action=getScanCount&race=${encodeURIComponent(currentRace)}&checkpoint=${encodeURIComponent(currentCheckpoint)}&t=${Date.now()}`;
        const response = await fetch(getUrl);
        if (!response.ok) {
             const errorText = await response.text(); console.error(`Error response (getScanCount): ${errorText}`);
             showStatus(`Warning: Could not refresh scan count (${response.status}).`, 'warning'); return;
        }
        const data = await response.json();
        if (data.status === 'success' && typeof data.scanCount === 'number') {
            currentScanCount = data.scanCount; console.log(`Refreshed scan count: ${currentScanCount}`);
            updateStatsUI();
        } else {
             console.error(`Invalid data format (getScanCount): ${data.message || JSON.stringify(data)}`);
             showStatus(`Warning: Invalid scan count data received.`, 'warning');
        }
    } catch (error) {
        console.error('Error fetching scan count:', error);
        showStatus(`Error refreshing scan count: ${error.message}.`, 'error');
    } finally {
        isFetchingScanCount = false; if (force) loadingSpinnerElement.classList.add('hidden');
    }
}
async function syncOfflineScans() {
    if (!navigator.onLine) { console.log("Offline, skipping sync."); return; }
    try {
        const unsynced = await db.getUnsyncedScans();
        if (unsynced.length === 0) { console.log("No unsynced scans."); return; }
        showStatus(`Syncing ${unsynced.length} saved scan(s)...`, 'info'); console.log("Attempting to sync:", unsynced);
        let allSynced = true; let successfullySyncedCount = 0;
        for (const scan of unsynced) {
            const success = await sendDataToSheet(scan.bib, scan.checkpoint, scan.timestamp, scan.race, scan.name);
            if (success) { await db.updateScanStatus(scan.id, 'synced'); console.log(`Synced scan ID: ${scan.id}`); successfullySyncedCount++; }
            else { allSynced = false; console.warn(`Failed to sync scan ID: ${scan.id}. Will retry later.`); break; }
        }
        if (allSynced && unsynced.length > 0) showStatus('Sync complete. All saved scans sent.', 'success');
        else if (!allSynced) showStatus('Sync incomplete. Some scans failed to send. Will retry later.', 'warning');
        if (successfullySyncedCount > 0) fetchScanCount(true);
    } catch (error) { console.error('Error during sync process:', error); showStatus(`Error during sync: ${error.message}`, 'error'); }
}


// --- QR Scanner Logic ---
// (initializeScanner, startScanning, stopScanning, onScanFailure remain the same)
function initializeScanner() {
    try { html5QrCode = new Html5Qrcode("reader"); }
    catch (error) { console.error("Failed to initialize Html5Qrcode:", error); showStatus(`Error initializing scanner: ${error.message}`, 'error', true); scanButton.disabled = true; scanButton.textContent = 'Scanner Error'; }
}
function startScanning() {
    if (isScanning || !html5QrCode) return;
    startToneContext();
    const config = { fps: 10, qrbox: { width: 250, height: 250 }, aspectRatio: 1.0 };
    const cameraConfig = { facingMode: "environment" };
    showStatus('Starting scanner...', 'info'); readerElement.classList.remove('hidden');
    html5QrCode.start(cameraConfig, config, onScanSuccess, onScanFailure)
    .then(() => { isScanning = true; scanButton.textContent = 'Stop Scan'; scanButton.classList.remove('bg-indigo-600', 'hover:bg-indigo-700'); scanButton.classList.add('bg-red-600', 'hover:bg-red-700'); showStatus('Scanner active. Point at QR code.', 'info'); })
    .catch((err) => {
        console.error(`Unable to start scanning with environment camera: ${err}`);
        if (err.name === "NotAllowedError" || err.name === "NotFoundError" || err.name === "OverconstrainedError" || err.name === "NotReadableError") {
             console.log("Trying front camera..."); showStatus('Trying front camera...', 'info');
             html5QrCode.start({ facingMode: "user" }, config, onScanSuccess, onScanFailure)
                 .then(() => { isScanning = true; scanButton.textContent = 'Stop Scan'; scanButton.classList.remove('bg-indigo-600', 'hover:bg-indigo-700'); scanButton.classList.add('bg-red-600', 'hover:bg-red-700'); showStatus('Scanner active (using front camera).', 'info'); })
                 .catch(err2 => { console.error(`Unable to start scanning with front camera either: ${err2}`); showStatus(`Scanner Error: ${err2.message}. Check permissions.`, 'error'); readerElement.classList.add('hidden'); isScanning = false; scanButton.textContent = 'Scanner Error'; scanButton.disabled = true; });
        } else { showStatus(`Scanner Error: ${err.message}. Check permissions.`, 'error'); readerElement.classList.add('hidden'); scanButton.textContent = 'Scanner Error'; scanButton.disabled = true; }
    });
}
function stopScanning() {
    if (!isScanning || !html5QrCode) return;
    html5QrCode.stop().then(() => { console.log("QR Code scanning stopped."); }).catch((err) => { console.error(`Failed to stop scanning cleanly: ${err}`); })
        .finally(() => { isScanning = false; scanButton.textContent = 'Start QR Code Scan'; scanButton.classList.remove('bg-red-600', 'hover:bg-red-700'); scanButton.classList.add('bg-indigo-600', 'hover:bg-indigo-700'); readerElement.classList.add('hidden'); showStatus('Scanner stopped.', 'info'); });
}
function onScanFailure(error) { /* console.warn(`Code scan error = ${error}`); */ }

// --- Modified onScanSuccess to trigger flash ---
function onScanSuccess(decodedText, decodedResult) {
    const now = Date.now();
    if (now - lastScanTime < SCAN_THROTTLE_MS) { console.log("Scan throttled."); return; }
    lastScanTime = now;
    const timestamp = new Date().toISOString();
    const parts = decodedText.trim().split(',');
    let bibNumber = null, nameFromQR = null;
    if (parts.length >= 1) bibNumber = parts[0].trim();
    if (parts.length >= 2) nameFromQR = parts.slice(1).join(',').trim();
    if (!bibNumber || !/^\d+$/.test(bibNumber)) {
        console.warn(`Invalid QR data format: "${decodedText}"`); showStatus(`Scan Error: Invalid QR data format.`, 'error');
        if (navigator.vibrate) navigator.vibrate([50, 50, 50]); return;
    }
    console.log(`Scan successful: Bib ${bibNumber}, Name (QR): ${nameFromQR || 'N/A'} at ${timestamp}`);
    triggerFlashOverlay(); // Trigger flash
    if (navigator.vibrate) navigator.vibrate(150);
    playSound();
    processScanData(bibNumber, timestamp, nameFromQR);
}

// --- Modified Manual Entry handler to trigger flash ---
manualSubmitButton.addEventListener('click', () => {
    startToneContext();
    const bibNumber = manualBibInput.value.trim();
    if (!bibNumber) { showStatus('Please enter a Bib Number.', 'error'); return; }
    if (!/^\d+$/.test(bibNumber)) { showStatus('Invalid Bib Number format.', 'error'); return; }
    const timestamp = new Date().toISOString();
    console.log(`Manual entry: Bib ${bibNumber} at ${timestamp}`);
    triggerFlashOverlay(); // Trigger flash
    if (navigator.vibrate) navigator.vibrate(100);
    playSound();
    processScanData(bibNumber, timestamp, null);
    manualBibInput.value = '';
});


// --- Data Processing & Storage ---
// (processScanData remains the same)
async function processScanData(bibNumber, timestamp, nameFromQR) {
    const runnerInfo = runnerData.find(r => r.bib === bibNumber);
    const runnerName = runnerInfo ? runnerInfo.name : (nameFromQR || 'Unknown');
    const runnerStatus = runnerInfo ? (runnerInfo.status || 'Active') : 'Unknown';
    if (runnerInfo) {
         if (runnerStatus === 'DNS' || runnerStatus === 'DNF') showStatus(`Warning: ${runnerStatus} - Bib ${bibNumber} (${runnerName}). Scan recorded.`, 'warning');
         else showStatus(`Scan: Bib ${bibNumber} (${runnerName})`, 'success');
    } else if (runnerData.length > 0 || totalActiveRunners > 0) showStatus(`Warning: Bib ${bibNumber} not in list. Scan recorded (${nameFromQR || 'No Name'}).`, 'warning');
    else showStatus(`Scan: Bib ${bibNumber} (${nameFromQR || 'No Name'})`, 'success');
    addScanToRecentList(bibNumber, timestamp, runnerName);
    try {
        const scanRecord = { bib, checkpoint: currentCheckpoint, timestamp, race: currentRace, name: runnerName, status: 'unsynced' };
        const id = await db.addScan(scanRecord);
        console.log(`Scan stored locally with ID: ${id}, Name: ${runnerName}`);
        if (navigator.onLine) {
            const success = await sendDataToSheet(bibNumber, currentCheckpoint, timestamp, currentRace, runnerName);
            if (success) {
                await db.updateScanStatus(id, 'synced');
                console.log(`Scan ID ${id} synced immediately.`);
                showStatus(`Scan for ${bibNumber} synced successfully!`, 'success');
                fetchScanCount(true); // Force refresh scan count
            } else {
                 console.warn(`Immediate sync failed for scan ID ${id}. Will retry later.`);
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

// --- sendDataToSheet function remains the same (using text/plain) ---
async function sendDataToSheet(runnerId, checkpoint, timestamp, race, runnerName) {
    const data = { action: 'recordScan', bib: runnerId, checkpoint, timestamp, race, name: runnerName };
    console.log("Sending data:", data);
    try {
        const response = await fetch(SCRIPT_URL, {
            method: 'POST', mode: 'cors', cache: 'no-cache',
            headers: { 'Content-Type': 'text/plain' }, redirect: 'follow',
            body: JSON.stringify(data)
        });
        if (!response.ok) {
            const errorText = await response.text();
            console.error(`Network error sending data: ${response.status} - ${errorText}`);
             let backendMessage = errorText;
             try { const errorJson = JSON.parse(errorText); if (errorJson && errorJson.message) backendMessage = errorJson.message; } catch (e) {}
            throw new Error(`Sync failed: ${response.status} ${backendMessage || response.statusText}`);
        }
        const result = await response.json();
        if (result.status === 'success') {
            console.log('Data sent successfully:', result.message); return true;
        } else {
            console.error('Error from backend:', result.message || 'Unknown error');
            showStatus(`Sync Error: ${result.message || 'Unknown error from server.'}`, 'error'); return false;
        }
    } catch (error) {
        console.error('Error sending data:', error);
        if (navigator.onLine) showStatus(`Sync Error: ${error.message}. Will retry.`, 'error');
        else console.warn("Send failed while offline.");
        return false;
    }
}


// --- UI Updates ---
let statusTimeoutId = null;

function showStatus(message, type = 'info', permanent = false) {
    if (statusTimeoutId) clearTimeout(statusTimeoutId);
    statusMessageElement.textContent = message;
    let currentType = type;
    if (!navigator.onLine && type !== 'error') currentType = 'warning';
    statusMessageElement.className = `status-${currentType}`;
    console.log(`Status (${currentType}): ${message}`);
    if (!permanent && type !== 'error') {
        statusTimeoutId = setTimeout(() => {
            if (statusMessageElement.textContent === message && statusMessageElement.className.includes(`status-${currentType}`)) {
                 const defaultMsg = navigator.onLine ? 'Ready.' : 'Offline. Scans saved locally.';
                 const defaultType = navigator.onLine ? 'info' : 'warning';
                 showStatus(defaultMsg, defaultType);
            }
             statusTimeoutId = null;
        }, 5000);
    }
}

function updateStatsUI() {
    const totalText = totalActiveRunners > 0 ? totalActiveRunners : (runnerData.length > 0 ? '0' : 'N/A');
    scannedCountElement.textContent = currentScanCount;
    totalActiveRunnersElement.textContent = totalText;
    console.log(`UI Stats Updated: Scanned (Sheet): ${currentScanCount}, Active Runners: ${totalText}`);
}

function addScanToRecentList(bib, timestamp, name) {
     const timeString = new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit'});
     recentScans.unshift({ bib: bib, time: timeString, name: name });
    if (recentScans.length > MAX_RECENT_SCANS) recentScans.pop();
    updateRecentScansUI();
}

function updateRecentScansUI() {
    recentScansListElement.innerHTML = '';
    if (recentScans.length === 0) {
        recentScansListElement.innerHTML = '<li class="p-2 text-gray-500 italic">No scans yet.</li>';
        return;
    }
    recentScans.forEach(scan => {
        const li = document.createElement('li');
        li.className = 'p-2 border-b border-gray-200 last:border-b-0';
        const nameText = scan.name && scan.name !== 'Unknown' ? ` (${scan.name})` : '';
        li.textContent = `Bib: ${scan.bib}${nameText} at ${scan.time}`;
        recentScansListElement.appendChild(li);
    });
}

// --- Flash Overlay ---
// ****** UPDATED triggerFlashOverlay ******
function triggerFlashOverlay() {
    if (!flashOverlayElement) return;
    // Use classList to ensure styles are applied correctly
    flashOverlayElement.classList.add('visible');

    // Set timeout to remove the class after the duration
    setTimeout(() => {
        flashOverlayElement.classList.remove('visible');
    }, FLASH_DURATION_MS);
}
// ****** END UPDATED triggerFlashOverlay ******


// --- Audio Handling ---
// (startToneContext and playSound functions remain the same)
async function startToneContext() {
    if (!toneJsStarted && typeof Tone !== 'undefined' && Tone.context.state !== 'running') {
        console.log('Attempting to start Tone.js Audio Context...');
        try { await Tone.start(); toneJsStarted = true; console.log('Tone.js Audio Context started.'); }
        catch (e) { console.error('Failed to start Tone.js context:', e); showStatus('Warning: Could not enable audio chime.', 'warning'); }
    }
}
function playSound() {
    if (!toneJsStarted || typeof Tone === 'undefined' || Tone.context.state !== 'running') { console.warn("Cannot play sound: Context not ready."); return; }
    try { const synth = new Tone.Synth().toDestination(); synth.triggerAttackRelease("C5", "8n", Tone.now()); setTimeout(() => { if (synth && !synth.disposed) synth.dispose(); }, 500); }
    catch (soundError) { console.warn("Could not play sound:", soundError); }
}


// --- Event Listeners ---
scanButton.addEventListener('click', () => {
    startToneContext();
    if (isScanning) stopScanning(); else startScanning();
});
manualSubmitButton.addEventListener('click', startToneContext);

