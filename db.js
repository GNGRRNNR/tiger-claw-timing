// db.js - IndexedDB Helper Functions
const db = (() => {
    const DB_NAME = 'RunnerTrackerDB';
    const STORE_NAME = 'scans';
    const DB_VERSION = 1;
    let dbInstance = null;

    // Function to initialize the database
    async function init() {
        return new Promise((resolve, reject) => {
            if (dbInstance) {
                resolve(dbInstance);
                return;
            }

            const request = indexedDB.open(DB_NAME, DB_VERSION);

            request.onerror = (event) => {
                console.error("IndexedDB error:", event.target.error);
                reject(new Error(`Database error: ${event.target.error}`));
            };

            request.onsuccess = (event) => {
                dbInstance = event.target.result;
                console.log("Database opened successfully.");
                resolve(dbInstance);
            };

            // This event is only triggered if the version number changes
            // or if the database is created for the first time.
            request.onupgradeneeded = (event) => {
                console.log("Database upgrade needed.");
                const db = event.target.result;
                if (!db.objectStoreNames.contains(STORE_NAME)) {
                    // Create object store with auto-incrementing key and indexes
                    const store = db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
                    // Index for efficient lookup of unsynced items
                    store.createIndex('statusIndex', 'status', { unique: false });
                    // Optional: Index for bib, checkpoint, timestamp if needed for queries
                    store.createIndex('bibIndex', 'bib', { unique: false });
                    store.createIndex('checkpointIndex', 'checkpoint', { unique: false });
                    console.log(`Object store "${STORE_NAME}" created.`);
                }
            };
        });
    }

    // Function to add a scan record
    async function addScan(scanData) {
        return new Promise(async (resolve, reject) => {
            if (!dbInstance) await init(); // Ensure DB is initialized

            const transaction = dbInstance.transaction([STORE_NAME], 'readwrite');
            const store = transaction.objectStore(STORE_NAME);
            // Ensure 'status' is set, default to 'unsynced' if not provided
            const dataToAdd = { ...scanData, status: scanData.status || 'unsynced' };
            const request = store.add(dataToAdd);

            request.onsuccess = (event) => {
                console.log("Scan added to DB with ID:", event.target.result);
                resolve(event.target.result); // Returns the new key (id)
            };

            request.onerror = (event) => {
                console.error("Error adding scan:", event.target.error);
                reject(new Error(`Error adding scan: ${event.target.error}`));
            };

             transaction.oncomplete = () => {
                console.log("Add transaction complete.");
            };
             transaction.onerror = (event) => {
                 console.error("Add transaction error:", event.target.error);
                 reject(new Error(`Add transaction error: ${event.target.error}`));
             };
        });
    }

    // Function to get all scans marked as 'unsynced'
    async function getUnsyncedScans() {
        return new Promise(async (resolve, reject) => {
             if (!dbInstance) await init();

            const transaction = dbInstance.transaction([STORE_NAME], 'readonly');
            const store = transaction.objectStore(STORE_NAME);
            const statusIndex = store.index('statusIndex');
            // Query the index for items with status 'unsynced'
            const request = statusIndex.getAll('unsynced');

            request.onsuccess = (event) => {
                resolve(event.target.result); // Returns an array of matching records
            };

            request.onerror = (event) => {
                console.error("Error getting unsynced scans:", event.target.error);
                reject(new Error(`Error getting unsynced scans: ${event.target.error}`));
            };
        });
    }

    // Function to update the status of a scan (e.g., to 'synced')
    async function updateScanStatus(id, newStatus) {
        return new Promise(async (resolve, reject) => {
             if (!dbInstance) await init();

            const transaction = dbInstance.transaction([STORE_NAME], 'readwrite');
            const store = transaction.objectStore(STORE_NAME);
            // First, get the existing record
            const getRequest = store.get(id);

            getRequest.onsuccess = (event) => {
                const scanRecord = event.target.result;
                if (scanRecord) {
                    // Update the status
                    scanRecord.status = newStatus;
                    // Put the updated record back into the store
                    const updateRequest = store.put(scanRecord);

                    updateRequest.onsuccess = () => {
                        console.log(`Scan ID ${id} status updated to ${newStatus}`);
                        resolve();
                    };
                    updateRequest.onerror = (event) => {
                         console.error(`Error updating scan ID ${id}:`, event.target.error);
                         reject(new Error(`Error updating scan: ${event.target.error}`));
                    };
                } else {
                    console.warn(`Scan ID ${id} not found for update.`);
                    reject(new Error(`Scan ID ${id} not found.`));
                }
            };

            getRequest.onerror = (event) => {
                console.error(`Error getting scan ID ${id} for update:`, event.target.error);
                reject(new Error(`Error getting scan for update: ${event.target.error}`));
            };

             transaction.oncomplete = () => {
                console.log("Update transaction complete.");
            };
             transaction.onerror = (event) => {
                 console.error("Update transaction error:", event.target.error);
                 reject(new Error(`Update transaction error: ${event.target.error}`));
             };
        });
    }

     // Function to get the last N scans (optional, for restoring recent list on reload)
    async function getRecentScans(limit = 5) {
        return new Promise(async (resolve, reject) => {
            if (!dbInstance) await init();

            const transaction = dbInstance.transaction([STORE_NAME], 'readonly');
            const store = transaction.objectStore(STORE_NAME);
            const scans = [];
            // Open cursor to iterate in reverse order (newest first)
            const request = store.openCursor(null, 'prev');

            request.onsuccess = (event) => {
                const cursor = event.target.result;
                if (cursor && scans.length < limit) {
                    scans.push(cursor.value);
                    cursor.continue();
                } else {
                    resolve(scans); // Resolve when cursor is done or limit reached
                }
            };

            request.onerror = (event) => {
                console.error("Error getting recent scans:", event.target.error);
                reject(new Error(`Error getting recent scans: ${event.target.error}`));
            };
        });
    }


    // Public interface
    return {
        init,
        addScan,
        getUnsyncedScans,
        updateScanStatus,
        getRecentScans
    };
})();
