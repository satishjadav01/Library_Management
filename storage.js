/**
 * ============================================================
 * PageTurn Bookstore — storage.js
 * ============================================================
 * Centralised localStorage layer for the entire application.
 *
 * Exports (globals used by script.js):
 *   Core helpers  — lsGet, lsSet, lsRemove
 *   Storage keys  — STORAGE_KEYS  (all localStorage key strings)
 *   Store object  — Store         (high-level read/write helpers
 *                                   for each data domain)
 *   DB object     — DB            (JSON database loader — db.json)
 * ============================================================
 */

/* ══════════════════════════════════════════════════════════
   CORE localStorage HELPERS
   These are the only three places in the entire app that
   touch window.localStorage directly.
══════════════════════════════════════════════════════════ */

/**
 * Retrieve a value from localStorage, parsing JSON.
 * Returns defaultValue if key is absent or JSON is malformed.
 * @param {string} key
 * @param {*} [defaultValue=null]
 * @returns {*}
 */
function lsGet(key, defaultValue = null) {
  try {
    const raw = localStorage.getItem(key);
    return raw !== null ? JSON.parse(raw) : defaultValue;
  } catch {
    return defaultValue;
  }
}

/**
 * Store a value in localStorage, serialised as JSON.
 * @param {string} key
 * @param {*} value
 */
function lsSet(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

/**
 * Remove a key from localStorage.
 * @param {string} key
 */
function lsRemove(key) {
  localStorage.removeItem(key);
}

/* ══════════════════════════════════════════════════════════
   STORAGE KEY REGISTRY
   Every key the app writes to localStorage is declared here.
   Dynamic per-user keys are generated via factory functions.
══════════════════════════════════════════════════════════ */

const STORAGE_KEYS = {
  /** Array of registered user objects: { name, email, password, joinedAt } */
  USERS:   'pt_users',

  /** Email string of the currently logged-in user */
  SESSION: 'pt_session',

  /**
   * Per-user bookmark arrays.
   * Use STORAGE_KEYS.bookmarks(email) to get the key.
   * @param {string} email
   * @returns {string}
   */
  bookmarks(email) {
    return `pt_bm_${email}`;
  },

  /**
   * Per-user reading history arrays.
   * Use STORAGE_KEYS.history(email) to get the key.
   * @param {string} email
   * @returns {string}
   */
  history(email) {
    return `pt_history_${email}`;
  },

  /**
   * Per-book review arrays (shared across all users on same device).
   * Use STORAGE_KEYS.reviews(bookId) to get the key.
   * @param {string} bookId  — e.g. "/works/OL45804W"
   * @returns {string}
   */
  reviews(bookId) {
    return 'pt_reviews_' + bookId.replace(/[^a-zA-Z0-9]/g, '_');
  },
};

/* ══════════════════════════════════════════════════════════
   HIGH-LEVEL STORE OBJECT
   Domain-specific read / write helpers that the rest of the
   application calls. No module outside storage.js should ever
   call lsGet / lsSet / lsRemove directly.
══════════════════════════════════════════════════════════ */

const Store = {

  /* ── Auth ─────────────────────────────────────────────── */

  /** @returns {Array<{name:string, email:string, password:string, joinedAt:string}>} */
  getUsers() {
    return lsGet(STORAGE_KEYS.USERS, []);
  },

  /** @param {Array} users */
  saveUsers(users) {
    lsSet(STORAGE_KEYS.USERS, users);
  },

  /** @returns {string|null} Currently logged-in email, or null */
  getSession() {
    return lsGet(STORAGE_KEYS.SESSION, null);
  },

  /** @param {string} email */
  setSession(email) {
    lsSet(STORAGE_KEYS.SESSION, email);
  },

  clearSession() {
    lsRemove(STORAGE_KEYS.SESSION);
  },

  /* ── Bookmarks ────────────────────────────────────────── */

  /**
   * @param {string} email
   * @returns {Array} Bookmark objects for this user
   */
  getBookmarks(email) {
    return lsGet(STORAGE_KEYS.bookmarks(email), []);
  },

  /**
   * @param {string} email
   * @param {Array}  bookmarks
   */
  saveBookmarks(email, bookmarks) {
    lsSet(STORAGE_KEYS.bookmarks(email), bookmarks);
  },

  /* ── Reading History ──────────────────────────────────── */

  /**
   * @param {string} email
   * @returns {Array} History entries for this user
   */
  getHistory(email) {
    return lsGet(STORAGE_KEYS.history(email), []);
  },

  /**
   * @param {string} email
   * @param {Array}  history
   */
  saveHistory(email, history) {
    lsSet(STORAGE_KEYS.history(email), history);
  },

  /* ── Reviews ──────────────────────────────────────────── */

  /**
   * @param {string} bookId
   * @returns {Array} Review objects for this book
   */
  getReviews(bookId) {
    return lsGet(STORAGE_KEYS.reviews(bookId), []);
  },

  /**
   * @param {string} bookId
   * @param {Array}  reviews
   */
  saveReviews(bookId, reviews) {
    lsSet(STORAGE_KEYS.reviews(bookId), reviews);
  },
};

/* ══════════════════════════════════════════════════════════
   DB MODULE — JSON DATABASE LOADER
   Fetches db.json and merges its users into localStorage.
   Acts as a permanent seed database that initialises on
   every page load without overwriting user-registered data.
══════════════════════════════════════════════════════════ */

const DB = {

  /**
   * Fetch db.json and merge its users into localStorage.
   * Only adds users whose email doesn't already exist —
   * so locally-registered users are never overwritten.
   *
   * @returns {Promise<void>}
   */
  async init() {
    try {
      const res  = await fetch('db.json');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      const dbUsers   = Array.isArray(data.users) ? data.users : [];
      const lsUsers   = Store.getUsers();
      const lsEmails  = new Set(lsUsers.map(u => u.email.toLowerCase()));

      let added = 0;
      dbUsers.forEach(dbUser => {
        const email = (dbUser.email || '').toLowerCase();
        if (email && !lsEmails.has(email)) {
          lsUsers.push({
            name:     dbUser.name     || 'Unknown',
            email:    email,
            password: dbUser.password || '',
            joinedAt: dbUser.joinedAt || new Date().toISOString(),
          });
          lsEmails.add(email);
          added++;
        }
      });

      if (added > 0) {
        Store.saveUsers(lsUsers);
        console.log(`[DB] Merged ${added} user(s) from db.json into localStorage.`);
      } else {
        console.log('[DB] db.json loaded — no new users to merge.');
      }
    } catch (err) {
      // Non-fatal: app still works with whatever is in localStorage
      console.warn('[DB] Could not load db.json:', err.message);
    }
  },
};
