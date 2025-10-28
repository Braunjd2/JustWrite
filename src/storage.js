const DB_NAME = 'simplewriter-v2';
const DB_VERSION = 1;
const STORE_STATE = 'app_state';
const STATE_KEY = 'state';
const LEGACY_STORAGE_KEY = 'simplewriter-v2-state';

let dbPromise = null;

function openDatabase() {
  if (dbPromise) {
    return dbPromise;
  }

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_STATE)) {
        database.createObjectStore(STORE_STATE, { keyPath: 'key' });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Failed to open SimpleWriter database'));
  });

  return dbPromise;
}

export async function loadStateFromDb() {
  const db = await openDatabase();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_STATE, 'readonly');
    const store = transaction.objectStore(STORE_STATE);
    const request = store.get(STATE_KEY);

    request.onsuccess = () => {
      resolve(request.result ? request.result.value : null);
    };
    request.onerror = () => reject(request.error || new Error('Failed to read state from database'));
  });
}

export async function saveStateToDb(state) {
  if (!state) {
    return;
  }

  const db = await openDatabase();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_STATE, 'readwrite');
    const store = transaction.objectStore(STORE_STATE);
    const request = store.put({ key: STATE_KEY, value: state, savedAt: new Date().toISOString() });

    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error || new Error('Failed to write state to database'));
  });
}

export async function clearStateFromDb() {
  const db = await openDatabase();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_STATE, 'readwrite');
    const store = transaction.objectStore(STORE_STATE);
    const request = store.delete(STATE_KEY);

    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error || new Error('Failed to clear state from database'));
  });
}

export function loadLegacyState() {
  try {
    if (typeof localStorage === 'undefined') {
      return null;
    }
    const raw = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    return JSON.parse(raw);
  } catch (error) {
    console.warn('Failed to load legacy localStorage state', error);
    return null;
  }
}

export function clearLegacyState() {
  try {
    if (typeof localStorage === 'undefined') {
      return;
    }
    localStorage.removeItem(LEGACY_STORAGE_KEY);
  } catch (error) {
    console.warn('Failed to clear legacy localStorage state', error);
  }
}
