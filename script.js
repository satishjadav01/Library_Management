/**
 * ============================================================
 * PageTurn Bookstore — script.js
 * ============================================================
 * Depends on storage.js being loaded first.
 *
 * Modules:
 *  1. Helpers & Utilities
 *  2. Auth Module         — register, login, logout, session
 *  3. Router              — switch between views
 *  4. API Module          — Open Library API + debounce
 *  5. Renderer            — render book cards
 *  6. Bookmarks Module    — per-user bookmark management
 *  7. History Module      — per-user reading history
 *  8. Modal Module        — read-book modal
 *  9. UI Module           — toast, spinner, error states
 * 10. Event Bindings      — wire DOM events
 * 11. App Init            — entry point
 * ============================================================
 */

/* ══════════════════════════════════════════════════════════
   1. HELPERS & UTILITIES
   Note: localStorage helpers (lsGet/lsSet/lsRemove) and the
   Store object live in storage.js which is loaded first.
══════════════════════════════════════════════════════════ */

/**
 * Validate an email address format.
 */
function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

/**
 * Create a debounced version of fn that fires after `delay` ms.
 */
function debounce(fn, delay) {
  let timer;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), delay);
  };
}

/**
 * Sanitise a string for safe innerHTML insertion.
 */
function sanitise(str) {
  const d = document.createElement('div');
  d.textContent = str || '';
  return d.innerHTML;
}

/* ══════════════════════════════════════════════════════════
   2. AUTH MODULE
   Delegates all storage reads/writes to Store (storage.js).
══════════════════════════════════════════════════════════ */

const Auth = {

  /** Return all registered users (array). */
  getUsers() {
    return Store.getUsers();
  },

  /** Return the currently logged-in user object, or null. */
  getSession() {
    const email = Store.getSession();
    if (!email) return null;
    return Store.getUsers().find(u => u.email === email) || null;
  },

  /** Set session to the given email. */
  setSession(email) {
    Store.setSession(email);
  },

  /** Clear current session. */
  clearSession() {
    Store.clearSession();
  },

  /**
   * Register a new user.
   * Returns { ok: true } or { ok: false, field: '...', message: '...' }
   */
  register({ name, email, password, confirm }) {
    const trimmedName  = (name  || '').trim();
    const trimmedEmail = (email || '').trim().toLowerCase();
    const pw           = password || '';
    const cpw          = confirm  || '';

    if (!trimmedName)
      return { ok: false, field: 'name', message: 'Full name is required.' };

    if (!isValidEmail(trimmedEmail))
      return { ok: false, field: 'email', message: 'Please enter a valid email address.' };

    if (pw.length < 6)
      return { ok: false, field: 'password', message: 'Password must be at least 6 characters.' };

    if (pw !== cpw)
      return { ok: false, field: 'confirm', message: 'Passwords do not match.' };

    const users = Store.getUsers();
    if (users.some(u => u.email === trimmedEmail))
      return { ok: false, field: 'email', message: 'An account with this email already exists.' };

    users.push({
      name:     trimmedName,
      email:    trimmedEmail,
      password: pw,          // NOTE: plain-text only for this demo; use hashing in production
      joinedAt: new Date().toISOString(),
    });
    Store.saveUsers(users);

    return { ok: true };
  },

  /**
   * Attempt login with email + password.
   * Returns { ok: true, user } or { ok: false, message: '...' }
   */
  login({ email, password }) {
    const trimmedEmail = (email || '').trim().toLowerCase();
    const pw           = password || '';

    if (!trimmedEmail || !pw)
      return { ok: false, message: 'Please fill in all fields.' };

    const users = Store.getUsers();
    const user  = users.find(u => u.email === trimmedEmail && u.password === pw);

    if (!user)
      return { ok: false, message: 'Incorrect email or password. Please try again.' };

    Store.setSession(user.email);
    return { ok: true, user };
  },

  /** Log out current user and redirect to login. */
  logout() {
    Store.clearSession();
    Router.showAuth('login');
  },
};

/* ══════════════════════════════════════════════════════════
   3. ROUTER — view switching
══════════════════════════════════════════════════════════ */

const Router = {

  /** Show an auth view: 'login' | 'register' */
  showAuth(view = 'login') {
    el('auth-section').classList.remove('hidden');
    el('dashboard-section').classList.add('hidden');

    el('login-view').classList.toggle('hidden', view !== 'login');
    el('register-view').classList.toggle('hidden', view !== 'register');

    // Reset forms and errors
    el('login-form').reset();
    el('register-form').reset();
    clearFormErrors('login');
    clearFormErrors('register');
  },

  /** Show the dashboard/bookmarks view after login. */
  showDashboard(view = 'explore') {
    el('auth-section').classList.add('hidden');
    el('dashboard-section').classList.remove('hidden');

    this.showDashboardView(view);

    // Populate user info in navbar
    const user = Auth.getSession();
    if (user) {
      el('user-name-display').textContent = user.name.split(' ')[0];
      el('user-avatar').textContent = user.name.charAt(0).toUpperCase();
    }

    // Populate profile panel
    ProfilePanel.render();
    Bookmarks.updateBadge();
    History.updateBadge();
  },

  /** Switch between explore / bookmarks / history inner views. */
  showDashboardView(view) {
    const isExplore   = view === 'explore';
    const isBookmarks = view === 'bookmarks';
    const isHistory   = view === 'history';

    el('explore-view').classList.toggle('hidden',   !isExplore);
    el('bookmarks-view').classList.toggle('hidden', !isBookmarks);
    el('history-view').classList.toggle('hidden',   !isHistory);

    el('nav-explore').classList.toggle('active', isExplore);
    el('nav-bookmarks').classList.toggle('active', isBookmarks);
    el('nav-history').classList.toggle('active', isHistory);

    if (isBookmarks) Bookmarks.renderBookmarksPage();
    if (isHistory)   History.renderView();
  },
};

/* ══════════════════════════════════════════════════════════
   4. OPEN LIBRARY API
   docs: openlibrary.org/dev/api — free, no key, 20M+ books
══════════════════════════════════════════════════════════ */

const API_BASE   = 'https://openlibrary.org/search.json';
const COVER_BASE = 'https://covers.openlibrary.org/b/id';
let   lastQuery  = 'fiction';

const API = {

  /**
   * Fetch books from Open Library search API.
   * Only returns books that have a cover image (cover_i field present).
   */
  async fetchBooks(query = 'fiction', maxResults = 24) {
    const fields = 'key,title,author_name,cover_i,ia,first_sentence,subject,first_publish_year';
    const url    = `${API_BASE}?q=${encodeURIComponent(query)}&limit=40&fields=${fields}`;

    UI.showSpinner();
    UI.hideError();
    UI.hideEmpty();
    el('books-grid').innerHTML = '';
    el('results-meta').textContent = '';
    lastQuery = query;

    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      UI.hideSpinner();

      // Only show books that have a cover image for visual quality
      const items = (data.docs || [])
        .filter(d => d.cover_i && d.title)
        .slice(0, maxResults);

      if (items.length === 0) {
        UI.showEmpty();
        return;
      }

      el('results-meta').textContent =
        `✨ ${items.length} books found for “${query}”`;

      Renderer.renderBooks(items);

    } catch (err) {
      console.error('API error:', err);
      UI.hideSpinner();
      UI.showError('Could not connect to Open Library. Check your internet and try again.');
    }
  },
};


/* ══════════════════════════════════════════════════════════
   5. RENDERER — book card generation
══════════════════════════════════════════════════════════ */

const Renderer = {

  /**
   * Render an array of Google Books volume items into the grid.
   */
  renderBooks(items) {
    const grid = el('books-grid');
    grid.innerHTML = '';

    items.forEach((item, idx) => {
      const card = this.createBookCard(item, idx);
      grid.appendChild(card);
    });
  },

  /**
   * Build a single book card DOM element.
   */
  createBookCard(item, idx) {
    // Open Library document fields
    const id          = item.key;                                    // e.g. "/works/OL45804W"
    const title       = item.title || 'Untitled';
    const authors     = (item.author_name || []).slice(0, 2).join(', ') || 'Unknown Author';
    const year        = item.first_publish_year ? ` · ${item.first_publish_year}` : '';
    const description = (() => {
      const fs = item.first_sentence;
      if (fs) {
        if (typeof fs === 'string') return fs;
        if (Array.isArray(fs) && fs.length) return String(fs[0]);
        if (fs.value) return fs.value;
      }
      if (Array.isArray(item.subject) && item.subject.length)
        return 'Topics: ' + item.subject.slice(0, 5).join(' · ');
      return 'A must-read classic.';
    })();
    const cover       = `${COVER_BASE}/${item.cover_i}-M.jpg`;
    const iaId        = (item.ia || [])[0] || null;   // Internet Archive ID for preview
    const infoLink    = `https://openlibrary.org${item.key}`;
    const isBookmarked = Bookmarks.isBookmarked(id);

    // Average rating badge
    const avgRating = Reviews.getAverage(id);
    const ratingBadge = avgRating
      ? `<span class="card-rating">★ ${avgRating}</span>`
      : `<span class="card-rating hidden"></span>`;

    const card = document.createElement('div');
    card.className = 'book-card';
    card.setAttribute('role', 'listitem');
    card.setAttribute('data-id', id);

    card.innerHTML = `
      <div class="book-cover-wrap">
        <img class="book-cover" src="${sanitise(cover)}" alt="${sanitise(title)} cover" loading="lazy"
             onerror="this.parentElement.innerHTML='<div class=cover-placeholder><span>📚</span><p>${sanitise(title)}</p></div>'" />
        <button class="bookmark-pill ${isBookmarked ? 'bookmarked' : ''}"
                aria-label="${isBookmarked ? 'Remove bookmark' : 'Add bookmark'}"
                data-id="${sanitise(id)}" data-action="bookmark">
          ${isBookmarked ? '🔖' : '🏷'}
        </button>
        ${iaId ? '<span class="preview-badge">📖 Preview</span>' : ''}
      </div>
      <div class="book-body">
        <h3 class="book-title" title="${sanitise(title)}">${sanitise(title)}</h3>
        <p class="book-author">${sanitise(authors)}<span class="book-year">${sanitise(year)}</span></p>
        ${ratingBadge}
        <p class="book-desc">${sanitise(description)}</p>
        <div class="book-actions">
          <button class="btn btn-primary" data-action="read" data-id="${sanitise(id)}"
                  aria-label="Read ${sanitise(title)}">
            📖 Read
          </button>
          <button class="btn btn-outline ${isBookmarked ? 'btn-danger' : ''}"
                  data-action="bookmark-btn" data-id="${sanitise(id)}"
                  aria-label="${isBookmarked ? 'Remove bookmark' : 'Bookmark'}">
            ${isBookmarked ? '✕ Remove' : '🔖 Save'}
          </button>
        </div>
      </div>
    `;

    card._bookData = { id, title, authors, description, cover, iaId, infoLink };
    return card;
  },

  /**
   * Refresh bookmark state on all visible cards after a bookmark change.
   */
  refreshCardBookmarkState(id) {
    const isBookmarked = Bookmarks.isBookmarked(id);

    // Update pill buttons
    document.querySelectorAll(`.bookmark-pill[data-id="${id}"]`).forEach(pill => {
      pill.classList.toggle('bookmarked', isBookmarked);
      pill.textContent   = isBookmarked ? '🔖' : '🏷';
      pill.ariaLabel     = isBookmarked ? 'Remove bookmark' : 'Add bookmark';
    });

    // Update bottom action buttons
    document.querySelectorAll(`[data-action="bookmark-btn"][data-id="${id}"]`).forEach(btn => {
      btn.classList.toggle('btn-danger', isBookmarked);
      btn.textContent = isBookmarked ? '✕ Remove' : '🔖 Save';
      btn.ariaLabel   = isBookmarked ? 'Remove bookmark' : 'Bookmark';
    });
  },

  /**
   * Refresh the rating badge on a card after a review is saved.
   */
  refreshCardRating(id) {
    const avg = Reviews.getAverage(id);
    document.querySelectorAll(`.book-card[data-id="${CSS.escape(id)}"] .card-rating`).forEach(badge => {
      if (avg) {
        badge.textContent = `★ ${avg}`;
        badge.classList.remove('hidden');
      }
    });
  },
};

/* ══════════════════════════════════════════════════════════
   6. BOOKMARKS MODULE — per-user bookmark storage
   Reads/writes via Store (storage.js).
══════════════════════════════════════════════════════════ */

const Bookmarks = {

  /** Return the current user's bookmarks array. */
  getAll() {
    const session = Auth.getSession();
    return session ? Store.getBookmarks(session.email) : [];
  },

  /** Save the full bookmarks array for the current user. */
  _save(bookmarks) {
    const session = Auth.getSession();
    if (session) Store.saveBookmarks(session.email, bookmarks);
  },

  /** Check if a book (by id) is bookmarked. */
  isBookmarked(id) {
    return this.getAll().some(b => b.id === id);
  },

  /** Toggle bookmark for a book. Returns true if now bookmarked. */
  toggle(bookData) {
    const bookmarks = this.getAll();
    const idx       = bookmarks.findIndex(b => b.id === bookData.id);

    if (idx !== -1) {
      bookmarks.splice(idx, 1);
      this._save(bookmarks);
      this.updateBadge();
      Renderer.refreshCardBookmarkState(bookData.id);
      UI.toast('Bookmark removed', 'info');
      return false;
    } else {
      bookmarks.push(bookData);
      this._save(bookmarks);
      this.updateBadge();
      Renderer.refreshCardBookmarkState(bookData.id);
      UI.toast('📖 Saved to Bookmarks!', 'success');
      return true;
    }
  },

  /** Remove a bookmark by id (used from bookmarks page). */
  remove(id) {
    const bookmarks = this.getAll().filter(b => b.id !== id);
    this._save(bookmarks);
    this.updateBadge();
    UI.toast('Bookmark removed', 'info');
    this.renderBookmarksPage();
  },

  /** Update the bookmark badge count in the navbar. */
  updateBadge() {
    const count  = this.getAll().length;
    const badge  = el('bookmark-badge');
    badge.textContent = count;
    badge.dataset.count = count;
  },

  /** Render the My Bookmarks page. */
  renderBookmarksPage() {
    const bookmarks = this.getAll();
    const grid      = el('bookmarks-grid');
    const empty     = el('bm-empty-state');
    const subtitle  = el('bookmarks-subtitle');

    grid.innerHTML = '';

    if (bookmarks.length === 0) {
      empty.classList.remove('hidden');
      subtitle.textContent = '';
      return;
    }

    empty.classList.add('hidden');
    subtitle.textContent = `${bookmarks.length} book${bookmarks.length > 1 ? 's' : ''} saved`;

    bookmarks.forEach(book => {
      const cover = book.cover
        ? `<img class="book-cover" src="${sanitise(book.cover)}" alt="${sanitise(book.title)} cover" loading="lazy" />`
        : `<div class="cover-placeholder"><span>📚</span><p>${sanitise(book.title)}</p></div>`;

      const card = document.createElement('div');
      card.className = 'book-card';
      card.setAttribute('role', 'listitem');
      card.setAttribute('data-id', book.id);

      card.innerHTML = `
        <div class="book-cover-wrap">
          ${cover}
          <button class="bookmark-pill bookmarked"
                  aria-label="Remove bookmark"
                  data-id="${sanitise(book.id)}"
                  data-action="bm-remove-pill">
            🔖
          </button>
        </div>
        <div class="book-body">
          <h3 class="book-title" title="${sanitise(book.title)}">${sanitise(book.title)}</h3>
          <p class="book-author">${sanitise(book.authors)}</p>
          <p class="book-desc">${sanitise(book.description)}</p>
          <div class="book-actions">
            <button class="btn btn-primary"
                    data-action="bm-read"
                    data-id="${sanitise(book.id)}"
                    aria-label="Read ${sanitise(book.title)}">
              📖 Read
            </button>
            <button class="btn btn-danger"
                    data-action="bm-remove"
                    data-id="${sanitise(book.id)}"
                    aria-label="Remove bookmark">
              ✕ Remove
            </button>
          </div>
        </div>
      `;

      card._bookData = book;
      grid.appendChild(card);
    });
  },
};

/* ══════════════════════════════════════════════════════════
   6b. REVIEWS MODULE — per-book star ratings & text reviews
   Reviews are visible to all users on the same device,
   simulating a real community review section.
   Reads/writes via Store (storage.js).
══════════════════════════════════════════════════════════ */

const Reviews = {

  /** Return all reviews for a book (array). */
  getAll(bookId) {
    return Store.getReviews(bookId);
  },

  /** Return the logged-in user's review for this book, or null. */
  getMine(bookId) {
    const session = Auth.getSession();
    if (!session) return null;
    return Store.getReviews(bookId).find(r => r.email === session.email) || null;
  },

  /**
   * Save (add or update) the current user's review.
   * @param {string} bookId
   * @param {number} rating  — 1 to 5
   * @param {string} text    — optional review body
   */
  save(bookId, rating, text) {
    const session = Auth.getSession();
    if (!session) return;
    // Remove any previous review by this user, then prepend the new one
    const others = Store.getReviews(bookId).filter(r => r.email !== session.email);
    others.unshift({
      email:  session.email,
      name:   session.name,
      rating,
      text:   (text || '').trim(),
      date:   new Date().toLocaleDateString('en-IN', {
        day: 'numeric', month: 'short', year: 'numeric',
      }),
    });
    Store.saveReviews(bookId, others);
  },

  /** Calculate the average rating (1 decimal) or 0 if no reviews. */
  getAverage(bookId) {
    const reviews = this.getAll(bookId);
    if (!reviews.length) return 0;
    const sum = reviews.reduce((acc, r) => acc + r.rating, 0);
    return Math.round((sum / reviews.length) * 10) / 10;
  },

  /**
   * Render all reviews for a book into #reviews-list.
   * @param {string} bookId
   */
  render(bookId) {
    const reviews = this.getAll(bookId);
    const list    = el('reviews-list');
    const session = Auth.getSession();

    if (!reviews.length) {
      list.innerHTML = '<p class="no-reviews">No reviews yet — be the first to review this book!</p>';
      return;
    }

    list.innerHTML = reviews.map(r => `
      <div class="review-card ${r.email === session?.email ? 'mine' : ''}">
        <div class="review-header">
          <span class="review-avatar">${sanitise(r.name.charAt(0).toUpperCase())}</span>
          <div class="review-meta">
            <span class="review-name">${sanitise(r.name)}</span>
            <span class="review-date">${sanitise(r.date)}</span>
          </div>
          <div class="review-stars" aria-label="${r.rating} out of 5 stars">
            ${'★'.repeat(r.rating)}${'☆'.repeat(5 - r.rating)}
          </div>
        </div>
        ${r.text ? `<p class="review-text">${sanitise(r.text)}</p>` : ''}
      </div>
    `).join('');
  },
};

/* ══════════════════════════════════════════════════════════
   7. HISTORY MODULE — per-user reading history
   Reads/writes via Store (storage.js).
══════════════════════════════════════════════════════════ */

const History = {

  /** Return all history entries for current user. */
  getAll() {
    const session = Auth.getSession();
    return session ? Store.getHistory(session.email) : [];
  },

  /** Add or bump a book to the top of reading history. */
  add(bookData) {
    const session = Auth.getSession();
    if (!session) return;
    const existing = this.getAll().filter(b => b.id !== bookData.id);
    existing.unshift({
      ...bookData,
      readAt: new Date().toISOString(),
    });
    // Keep at most 50 history entries
    Store.saveHistory(session.email, existing.slice(0, 50));
    this.updateBadge();
  },

  /** Return number of unique books read. */
  count() {
    return this.getAll().length;
  },

  /** Update the nav History badge. */
  updateBadge() {
    const badge = el('history-badge');
    if (!badge) return;
    const cnt = this.count();
    badge.textContent = cnt;
    badge.style.display = cnt ? 'inline-flex' : 'none';
  },

  /** Render the history grid. */
  renderView() {
    const books = this.getAll();
    const grid  = el('history-grid');
    const empty = el('history-empty-state');
    const sub   = el('history-subtitle');

    if (!books.length) {
      grid.innerHTML = '';
      empty.classList.remove('hidden');
      if (sub) sub.textContent = 'No books read yet';
      return;
    }

    empty.classList.add('hidden');
    if (sub) sub.textContent = `${books.length} book${books.length !== 1 ? 's' : ''} read`;
    grid.innerHTML = '';

    books.forEach(book => {
      const card = document.createElement('div');
      card.className = 'book-card';
      card.setAttribute('data-id', book.id);
      const cover = book.cover
        ? `<img class="book-cover" src="${sanitise(book.cover)}" alt="cover" loading="lazy" onerror="this.style.display='none'" />`
        : `<div class="cover-placeholder"><span>📚</span></div>`;
      card.innerHTML = `
        <div class="book-cover-wrap">${cover}</div>
        <div class="book-body">
          <h3 class="book-title">${sanitise(book.title)}</h3>
          <p class="book-author">${sanitise(book.authors)}</p>
          <p class="history-date">🕒 ${new Date(book.readAt).toLocaleDateString('en-IN', {day:'numeric',month:'short',year:'numeric'})}</p>
          <div class="book-actions">
            <button class="btn btn-primary" data-action="read" data-id="${sanitise(book.id)}"
                    style="width:100%">📖 Read Again</button>
          </div>
        </div>`;
      card._bookData = book;
      grid.appendChild(card);
    });
  },
};

/* ══════════════════════════════════════════════════════════
   8. MODAL MODULE — read book preview
══════════════════════════════════════════════════════════ */

// Track the currently open book and selected star rating
let currentModalBook = null;
let selectedRating   = 0;
let readerFontSize   = 17; // default reader font-size in px

/**
 * Visually highlight stars 1…rating in the star input.
 * @param {number} rating — 0 clears all
 */
function updateStarUI(rating) {
  document.querySelectorAll('#star-input .star').forEach((star, idx) => {
    star.classList.toggle('active', idx < rating);
  });
}

const Modal = {

  /**
   * Open the read-book modal for the given book.
   * Records to reading history and resets the reader panel.
   */
  open(bookData) {
    currentModalBook = bookData;
    selectedRating   = 0;

    const { title, authors, description, cover, infoLink, iaId, id } = bookData;

    el('modal-title').textContent       = title;
    el('modal-author').textContent      = authors;
    el('modal-description').textContent = description;

    const coverEl = el('modal-cover');
    coverEl.src = cover || '';
    coverEl.alt = cover ? `${title} cover` : '';
    coverEl.style.display = cover ? '' : 'none';

    // Info link — Open Library book page
    el('modal-info-link').href = infoLink || `https://openlibrary.org/search?q=${encodeURIComponent(title)}`;

    // Internet Archive embedded preview
    const iaWrap  = el('ia-preview-wrap');
    const iaFrame = el('ia-preview-frame');
    if (iaId) {
      iaFrame.src = `https://archive.org/embed/${iaId}`;
      iaWrap.classList.remove('hidden');
      el('modal-read-btn').querySelector('.btn-text').textContent = '✅ Preview Loaded';
    } else {
      iaFrame.src = '';
      iaWrap.classList.add('hidden');
      el('modal-read-btn').querySelector('.btn-text').textContent = '📖 Read In Page';
    }

    // Reset fallback text reader
    el('book-reader-wrap').classList.add('hidden');
    el('book-reader-content').innerHTML = '';
    el('reader-spinner').classList.add('hidden');
    el('modal-read-btn').disabled = false;

    // Review form
    const myReview = Reviews.getMine(id);
    if (myReview) {
      selectedRating = myReview.rating;
      el('review-text').value = myReview.text;
      el('submit-review-btn').textContent = '✏ Update Review';
    } else {
      el('review-text').value = '';
      el('submit-review-btn').textContent = '⭐ Submit Review';
    }
    updateStarUI(selectedRating);
    Reviews.render(id);

    History.add(bookData);

    el('read-modal').classList.remove('hidden');
    document.body.style.overflow = 'hidden';
  },

  /** Close the modal and reset state. */
  close() {
    currentModalBook = null;
    selectedRating   = 0;
    updateStarUI(0);
    el('book-reader-wrap').classList.add('hidden');
    el('book-reader-content').innerHTML = '';
    // Clear IA iframe to stop audio/video
    const iaFrame = el('ia-preview-frame');
    if (iaFrame) iaFrame.src = '';
    el('ia-preview-wrap')?.classList.add('hidden');
    el('read-modal').classList.add('hidden');
    document.body.style.overflow = '';
  },
};

/**
/**
 * Handle the "Read In Page" button click.
 * - If an IA preview is embedded, scroll to it.
 * - Otherwise, show a friendly link to Open Library.
 */
function readBook() {
  if (!currentModalBook) return;

  const { iaId, infoLink, title } = currentModalBook;
  const iaWrap = el('ia-preview-wrap');

  // IA preview is already embedded — just scroll to it
  if (iaId && !iaWrap.classList.contains('hidden')) {
    iaWrap.scrollIntoView({ behavior: 'smooth' });
    return;
  }

  // If there's an IA ID but the wrap was closed, re-open it
  if (iaId) {
    el('ia-preview-frame').src = `https://archive.org/embed/${iaId}`;
    iaWrap.classList.remove('hidden');
    iaWrap.scrollIntoView({ behavior: 'smooth' });
    UI.toast(`📖 Opening preview for "${title}"`, 'success');
    return;
  }

  // No IA preview — show the text reader panel with a helpful link
  const wrap    = el('book-reader-wrap');
  const content = el('book-reader-content');
  wrap.classList.remove('hidden');
  content.innerHTML = `
    <div class="reader-error">
      <p style="font-size:15px;margin-bottom:8px;">Full preview is not available for this edition.</p>
      <p style="margin-bottom:16px;color:var(--clr-text-muted);">You can read or borrow it on Open Library:</p>
      <a href="${sanitise(infoLink)}" target="_blank" rel="noopener" class="btn btn-primary">
        📖 Open on Open Library →
      </a>
    </div>`;
  wrap.scrollIntoView({ behavior: 'smooth' });
}




/* ══════════════════════════════════════════════════════════
   8. UI MODULE — toast, spinner, error/empty states
══════════════════════════════════════════════════════════ */

let toastTimer = null;

const UI = {

  /** Show a toast notification. type: 'success' | 'error' | 'info' */
  toast(message, type = 'info', duration = 2800) {
    const t     = el('toast');
    t.textContent = message;
    t.className   = `toast toast-${type}`;
    t.classList.remove('hidden');

    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      t.classList.add('hidden');
    }, duration);
  },

  /** Show the loading spinner (and hide the books grid). */
  showSpinner() {
    el('loading-spinner').classList.remove('hidden');
    el('books-grid').classList.add('hidden');
  },

  /** Hide the loading spinner (and show the books grid). */
  hideSpinner() {
    el('loading-spinner').classList.add('hidden');
    el('books-grid').classList.remove('hidden');
  },

  /** Show the API error state. */
  showError(msg) {
    el('api-error').classList.remove('hidden');
    el('api-error-msg').textContent = msg || 'Could not fetch books. Please try again.';
  },

  /** Hide the API error state. */
  hideError() {
    el('api-error').classList.add('hidden');
  },

  /** Show the "no results" empty state. */
  showEmpty() {
    el('empty-state').classList.remove('hidden');
  },

  /** Hide the "no results" empty state. */
  hideEmpty() {
    el('empty-state').classList.add('hidden');
  },
};

/* ══════════════════════════════════════════════════════════
   8b. FORM HELPERS
══════════════════════════════════════════════════════════ */

/**
 * Get a DOM element by id.
 * @param {string} id
 */
function el(id) {
  return document.getElementById(id);
}

/**
 * Show a field-level error message in the auth forms.
 * @param {string} prefix — 'login' | 'reg'
 * @param {string} field  — 'email' | 'password' | 'name' | 'confirm'
 * @param {string} msg
 */
function setFieldError(prefix, field, msg) {
  const input   = el(`${prefix}-${field}`);
  const errSpan = el(`${prefix}-${field}-err`);
  if (input)   input.classList.add('invalid');
  if (errSpan) errSpan.textContent = msg;
}

/**
 * Clear all errors for a form.
 * @param {string} prefix — 'login' | 'register'
 */
function clearFormErrors(prefix) {
  if (prefix === 'login') {
    ['email', 'password'].forEach(f => {
      el(`login-${f}`)?.classList.remove('invalid');
      const errEl = el(`login-${f}-err`);
      if (errEl) errEl.textContent = '';
    });
    el('login-error').classList.add('hidden');
    el('login-error').textContent = '';
  }

  if (prefix === 'register') {
    ['name', 'email', 'password', 'confirm'].forEach(f => {
      el(`reg-${f}`)?.classList.remove('invalid');
      const errEl = el(`reg-${f}-err`);
      if (errEl) errEl.textContent = '';
    });
    el('register-error').classList.add('hidden');
    el('register-error').textContent = '';
    el('register-success').classList.add('hidden');
    el('register-success').textContent = '';
  }
}

/**
 * Set loading state on a submit button.
 * @param {string} btnId
 * @param {boolean} isLoading
 */
function setBtnLoading(btnId, isLoading) {
  const btn     = el(btnId);
  const text    = btn.querySelector('.btn-text');
  const spinner = btn.querySelector('.btn-spinner');
  btn.disabled  = isLoading;
  if (text)    text.classList.toggle('hidden', isLoading);
  if (spinner) spinner.classList.toggle('hidden', !isLoading);
}

/* ══════════════════════════════════════════════════════════
   9. EVENT BINDINGS
══════════════════════════════════════════════════════════ */

/**
 * Wire all DOM event listeners after the page loads.
 */
function bindEvents() {

  /* ── Auth navigation ─────────────────────────────── */
  el('go-to-register').addEventListener('click', () => Router.showAuth('register'));
  el('go-to-login').addEventListener('click',    () => Router.showAuth('login'));

  /* ── Toggle password visibility ──────────────────── */
  el('login-toggle-pwd').addEventListener('click', () => {
    const inp = el('login-password');
    inp.type  = inp.type === 'password' ? 'text' : 'password';
  });

  el('reg-toggle-pwd').addEventListener('click', () => {
    const inp = el('reg-password');
    inp.type  = inp.type === 'password' ? 'text' : 'password';
  });

  /* ── Clear field error on input ──────────────────── */
  ['login-email', 'login-password'].forEach(id => {
    el(id)?.addEventListener('input', () => {
      el(id)?.classList.remove('invalid');
    });
  });

  ['reg-name', 'reg-email', 'reg-password', 'reg-confirm'].forEach(id => {
    el(id)?.addEventListener('input', () => {
      el(id)?.classList.remove('invalid');
    });
  });

  /* ── Login Form Submit ───────────────────────────── */
  el('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    clearFormErrors('login');

    const email    = el('login-email').value;
    const password = el('login-password').value;

    // Basic client-side checks
    if (!isValidEmail(email)) {
      setFieldError('login', 'email', 'Please enter a valid email.');
      return;
    }
    if (!password) {
      setFieldError('login', 'password', 'Password is required.');
      return;
    }

    setBtnLoading('login-btn', true);

    // Simulate small async delay for UX
    await new Promise(r => setTimeout(r, 400));

    const result = Auth.login({ email, password });
    setBtnLoading('login-btn', false);

    if (!result.ok) {
      el('login-error').textContent = result.message;
      el('login-error').classList.remove('hidden');
      return;
    }

    // Successful login → dashboard
    Router.showDashboard('explore');
    API.fetchBooks(lastQuery);
  });

  /* ── Register Form Submit ────────────────────────── */
  el('register-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    clearFormErrors('register');

    const name     = el('reg-name').value;
    const email    = el('reg-email').value;
    const password = el('reg-password').value;
    const confirm  = el('reg-confirm').value;

    setBtnLoading('register-btn', true);
    await new Promise(r => setTimeout(r, 400));

    const result = Auth.register({ name, email, password, confirm });
    setBtnLoading('register-btn', false);

    if (!result.ok) {
      // Map field names from Auth to form IDs
      const fieldMap = {
        name:     ['reg', 'name'],
        email:    ['reg', 'email'],
        password: ['reg', 'password'],
        confirm:  ['reg', 'confirm'],
      };

      if (result.field && fieldMap[result.field]) {
        const [prefix, field] = fieldMap[result.field];
        setFieldError(prefix, field, result.message);

        // Also show general error for context
        el('register-error').textContent = result.message;
        el('register-error').classList.remove('hidden');
      }
      return;
    }

    // Success — show message then switch to login
    el('register-success').textContent = '✓ Account created! You can now sign in.';
    el('register-success').classList.remove('hidden');

    setTimeout(() => {
      Router.showAuth('login');
      UI.toast('Account created! Please sign in.', 'success');
    }, 1400);
  });

  /* ── Logout ──────────────────────────────────────── */
  el('logout-btn').addEventListener('click', () => {
    Auth.logout();
    UI.toast('You have been signed out.', 'info');
  });

  /* ── Navbar links ────────────────────────────────── */
  el('nav-explore').addEventListener('click', () => {
    Router.showDashboardView('explore');
    closeHamburger();
  });

  el('nav-bookmarks').addEventListener('click', () => {
    Router.showDashboardView('bookmarks');
    closeHamburger();
  });

  el('nav-history').addEventListener('click', () => {
    Router.showDashboardView('history');
    closeHamburger();
  });

  /* ── Hamburger (mobile nav) ──────────────────────── */
  el('hamburger').addEventListener('click', () => {
    const links = el('navbar-links');
    const isOpen = links.classList.toggle('open');
    el('hamburger').setAttribute('aria-expanded', isOpen);
  });

  function closeHamburger() {
    el('navbar-links').classList.remove('open');
    el('hamburger').setAttribute('aria-expanded', 'false');
  }

  /* ── Go Explore from Bookmarks empty state ───────── */
  el('go-explore-btn').addEventListener('click', () => {
    Router.showDashboardView('explore');
  });

  /* ── Go Explore from History empty state ────────── */
  el('go-explore-from-history')?.addEventListener('click', () => {
    Router.showDashboardView('explore');
  });

  /* ── Search bar (debounced) ──────────────────────── */
  const debouncedSearch = debounce((query) => {
    const q = query.trim();
    if (q.length > 1) API.fetchBooks(q);
  }, 500);

  el('search-input').addEventListener('input', (e) => {
    debouncedSearch(e.target.value);
  });

  /* ── Search button click ─────────────────────────── */
  el('search-btn').addEventListener('click', () => {
    const q = el('search-input').value.trim();
    if (q.length > 1) API.fetchBooks(q);
  });

  /* ── Search input Enter key ──────────────────────── */
  el('search-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const q = el('search-input').value.trim();
      if (q.length > 1) API.fetchBooks(q);
    }
  });

  /* ── Quick search chips ──────────────────────────── */
  document.querySelectorAll('.chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const query = chip.dataset.query;
      el('search-input').value = query;
      API.fetchBooks(query);
    });
  });

  /* ── Retry button ────────────────────────────────── */
  el('retry-btn').addEventListener('click', () => {
    API.fetchBooks(lastQuery);
  });

  /* ── Book grid actions (event delegation) ────────── */
  el('books-grid').addEventListener('click', (e) => {
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (!action) return;

    const card     = e.target.closest('.book-card');
    const bookData = card?._bookData;
    if (!bookData) return;

    if (action === 'read') {
      Modal.open(bookData);
    }

    if (action === 'bookmark' || action === 'bookmark-btn') {
      Bookmarks.toggle(bookData);
    }
  });

  /* ── Bookmarks grid actions (event delegation) ───── */
  el('bookmarks-grid').addEventListener('click', (e) => {
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (!action) return;

    const card     = e.target.closest('.book-card');
    const bookData = card?._bookData;
    if (!bookData) return;

    if (action === 'bm-read') {
      Modal.open(bookData);
    }

    if (action === 'bm-remove' || action === 'bm-remove-pill') {
      Bookmarks.remove(bookData.id);
    }
  });

  /* ── Modal close button ──────────────────────────── */
  el('modal-close').addEventListener('click', () => Modal.close());

  /* ── IA preview close button ─────────────────────── */
  el('ia-preview-close')?.addEventListener('click', () => {
    el('ia-preview-frame').src = '';
    el('ia-preview-wrap').classList.add('hidden');
  });

  /* ── Genre pills ─────────────────────────────────── */
  document.querySelectorAll('.genre-pill').forEach(pill => {
    pill.addEventListener('click', () => {
      document.querySelectorAll('.genre-pill').forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      API.fetchBooks(pill.dataset.query);
    });
  });

  /* ── Close modal on overlay click ───────────────────── */
  el('read-modal').addEventListener('click', (e) => {
    if (e.target === el('read-modal')) Modal.close();
  });

  /* ── Close modal on Escape key ───────────────────────── */
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') Modal.close();
  });

  /* ── In-page Read button ─────────────────────────────── */
  el('modal-read-btn').addEventListener('click', readBook);

  /* ── Reader font size controls ──────────────────────── */
  el('reader-font-sm').addEventListener('click', () => {
    readerFontSize = Math.max(13, readerFontSize - 1);
    el('book-reader-content').style.fontSize = `${readerFontSize}px`;
  });
  el('reader-font-lg').addEventListener('click', () => {
    readerFontSize = Math.min(26, readerFontSize + 1);
    el('book-reader-content').style.fontSize = `${readerFontSize}px`;
  });
  el('reader-close').addEventListener('click', () => {
    el('book-reader-wrap').classList.add('hidden');
    el('book-reader-content').innerHTML = '';
    el('modal-read-btn').querySelector('.btn-text').textContent = '📖 Read Book In Page';
    el('modal-read-btn').disabled = false;
  });

  /* ── History grid actions (event delegation) ─────────── */
  el('history-grid')?.addEventListener('click', (e) => {
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (!action) return;
    const card     = e.target.closest('.book-card');
    const bookData = card?._bookData;
    if (!bookData) return;
    if (action === 'read') Modal.open(bookData);
  });

  /* ── Star rating — click to select ──────────────────── */
  el('star-input').addEventListener('click', (e) => {
    const star = e.target.closest('.star');
    if (!star) return;
    selectedRating = parseInt(star.dataset.value, 10);
    updateStarUI(selectedRating);
  });

  /* ── Star rating — hover preview ────────────────────── */
  el('star-input').addEventListener('mouseover', (e) => {
    const star = e.target.closest('.star');
    if (!star) return;
    const val = parseInt(star.dataset.value, 10);
    document.querySelectorAll('#star-input .star').forEach((s, idx) => {
      s.classList.toggle('hover', idx < val);
    });
  });

  el('star-input').addEventListener('mouseleave', () => {
    document.querySelectorAll('#star-input .star').forEach(s => s.classList.remove('hover'));
  });

  /* ── Submit or update a review ───────────────────────── */
  el('submit-review-btn').addEventListener('click', () => {
    if (!currentModalBook) return;

    if (!selectedRating) {
      UI.toast('Please select a star rating first ⭐', 'error');
      return;
    }

    const text = el('review-text').value;
    Reviews.save(currentModalBook.id, selectedRating, text);
    Reviews.render(currentModalBook.id);
    el('submit-review-btn').textContent = '✏ Update Review';
    UI.toast('Review saved! ⭐', 'success');

    // Refresh the average rating badge on the book card
    Renderer.refreshCardRating(currentModalBook.id);
  });
}

/* ══════════════════════════════════════════════════════════
   10. PROFILE PANEL — show logged-in user's data
══════════════════════════════════════════════════════════ */

const ProfilePanel = {
  /** Render or refresh the user profile card. */
  render() {
    const panel = el('profile-panel');
    if (!panel) return;
    const user = Auth.getSession();
    if (!user) { panel.classList.add('hidden'); return; }

    const joined = user.joinedAt
      ? new Date(user.joinedAt).toLocaleDateString('en-IN', {
          day: 'numeric', month: 'long', year: 'numeric',
        })
      : 'Unknown';

    const bookmarkCount = Store.getBookmarks(user.email).length;
    const historyCount  = Store.getHistory(user.email).length;

    el('profile-avatar').textContent     = user.name.charAt(0).toUpperCase();
    el('profile-name').textContent       = user.name;
    el('profile-email').textContent      = user.email;
    el('profile-joined').textContent     = `Joined: ${joined}`;
    el('profile-bookmarks').textContent  = bookmarkCount;
    el('profile-history').textContent    = historyCount;

    panel.classList.remove('hidden');
  },
};

/* ══════════════════════════════════════════════════════════
   11. APP INIT — entry point
══════════════════════════════════════════════════════════ */

/**
 * Bootstrap the application.
 * First loads db.json (merges seed users), then checks
 * the session and shows the correct view.
 */
async function init() {
  // Load and merge db.json before anything else
  await DB.init();

  bindEvents();

  const session = Auth.getSession();

  if (session) {
    // User already logged in — go straight to dashboard
    Router.showDashboard('explore');
    API.fetchBooks('fiction');
  } else {
    // No active session → show login
    Router.showAuth('login');
  }
}

// Start the app when DOM is ready
document.addEventListener('DOMContentLoaded', init);
