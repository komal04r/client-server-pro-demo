// app.js — Client UI: search/sort/pagination, toasts, theme toggle, stats, import/export.
// Uses fetch() to talk to the server. Pure browser JS, no frameworks.

const API = '/api/books';
const API_STATS = '/api/stats';
const API_HEALTH = '/api/health';

const els = {
    // form
    form: document.getElementById('book-form'),
    id: document.getElementById('id'),
    title: document.getElementById('title'),
    author: document.getElementById('author'),
    year: document.getElementById('year'),
    rating: document.getElementById('rating'),
    tags: document.getElementById('tags'),
    version: document.getElementById('version'),
    formMsg: document.getElementById('form-msg'),
    createBtn: document.getElementById('create-btn'),
    updateBtn: document.getElementById('update-btn'),

    // list
    table: document.getElementById('books-table'),
    tbody: document.querySelector('#books-table tbody'),
    search: document.getElementById('search'),
    refreshBtn: document.getElementById('refresh-btn'),
    pageSize: document.getElementById('page-size'),
    prevPage: document.getElementById('prev-page'),
    nextPage: document.getElementById('next-page'),
    pageInfo: document.getElementById('page-info'),

    // stats & health
    stats: document.getElementById('stats'),
    health: document.getElementById('health'),

    // theme & io
    themeToggle: document.getElementById('theme-toggle'),
    exportBtn: document.getElementById('export-btn'),
    importInput: document.getElementById('import-input'),

    // toast
    toast: document.getElementById('toast')
};

const state = {
    q: '',
    sort: 'title',
    dir: 'asc',
    limit: Number(els.pageSize.value),
    offset: 0,
    total: 0,
};

function showToast(msg, type = 'info') {
    els.toast.textContent = msg;
    els.toast.className = 'toast ' + type;
    els.toast.style.opacity = 1;
    setTimeout(() => els.toast.style.opacity = 0, 2500);
}

async function api(method, path = '', body) {
    const res = await fetch(API + path, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.ok === false) {
        const m = json?.error?.message || res.statusText;
        throw new Error(m);
    }
    return json;
}

function renderStats({ count, avgRating, topAuthors, topTags }) {
    els.stats.innerHTML = `
    <div class="stats-grid">
      <div><div class="stat-label">Total Books</div><div class="stat-value">${count}</div></div>
      <div><div class="stat-label">Avg Rating</div><div class="stat-value">${(avgRating ?? '—')}</div></div>
      <div><div class="stat-label">Top Authors</div><div class="stat-list">${topAuthors.map(a=>`${a.author} (${a.count})`).join(', ') || '—'}</div></div>
      <div><div class="stat-label">Top Tags</div><div class="stat-list">${topTags.map(t=>`${t.tag} (${t.count})`).join(', ') || '—'}</div></div>
    </div>
  `;
}

function rowTemplate(b) {
    const tagStr = (b.tags || []).join(', ');
    const updated = new Date(b.updatedAt).toLocaleString();
    return `
    <tr data-id="${b.id}" data-version="${b.version || 1}">
      <td>${b.id}</td>
      <td>${escapeHtml(b.title)}</td>
      <td>${escapeHtml(b.author || '')}</td>
      <td>${b.year ?? ''}</td>
      <td>${b.rating ?? ''}</td>
      <td>${escapeHtml(tagStr)}</td>
      <td>${updated}</td>
      <td class="actions-cell">
        <button data-action="edit">Edit</button>
        <button data-action="delete" class="danger">Delete</button>
      </td>
    </tr>
  `;
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function renderTable(list) {
    els.tbody.innerHTML = list.map(rowTemplate).join('');
    const start = state.offset + 1;
    const end = Math.min(state.offset + state.limit, state.total);
    const page = Math.floor(state.offset / state.limit) + 1;
    const pages = Math.max(1, Math.ceil(state.total / state.limit));
    els.pageInfo.textContent = `Page ${page} of ${pages} • Showing ${start}-${end} of ${state.total}`;
}

async function refresh() {
    const params = new URLSearchParams({
        q: state.q, sort: state.sort, dir: state.dir, limit: state.limit, offset: state.offset
    });
    try {
        const { data, meta } = await api('GET', '?' + params.toString());
        state.total = meta.total;
        renderTable(data);
    } catch (e) {
        showToast('Load failed: ' + e.message, 'error');
    }
}

async function refreshStats() {
    try {
        const res = await fetch(API_STATS);
        const { data } = await res.json();
        renderStats(data);
    } catch { /* ignore */ }
}

async function refreshHealth() {
    try {
        const res = await (await fetch(API_HEALTH)).json();
        els.health.textContent = `Health: ${res?.data?.status || 'unknown'}`;
        els.health.classList.toggle('ok', res?.data?.status === 'ok');
    } catch {
        els.health.textContent = 'Health: down';
        els.health.classList.remove('ok');
    }
}

/* ------------------------------- Handlers -------------------------------- */
els.refreshBtn.addEventListener('click', () => { state.offset = 0; refresh(); });
els.pageSize.addEventListener('change', () => {
    state.limit = Number(els.pageSize.value);
    state.offset = 0;
    refresh();
});

els.prevPage.addEventListener('click', () => {
    state.offset = Math.max(0, state.offset - state.limit);
    refresh();
});
els.nextPage.addEventListener('click', () => {
    const next = state.offset + state.limit;
    if (next < state.total) { state.offset = next; refresh(); }
});

let searchTimer;
els.search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
        state.q = els.search.value.trim();
        state.offset = 0;
        refresh();
    }, 250);
});

// Sort by clicking header
document.querySelectorAll('#books-table thead th[data-sort]').forEach(th => {
    th.addEventListener('click', () => {
        const key = th.getAttribute('data-sort');
        if (state.sort === key) state.dir = state.dir === 'asc' ? 'desc' : 'asc';
        else { state.sort = key; state.dir = 'asc'; }
        state.offset = 0;
        refresh();
        updateSortIndicators();
    });
});
function updateSortIndicators() {
    document.querySelectorAll('#books-table thead th[data-sort]').forEach(th => {
        const key = th.getAttribute('data-sort');
        th.classList.toggle('sorted', key === state.sort);
        th.classList.toggle('desc', key === state.sort && state.dir === 'desc');
    });
}

// Table actions
els.tbody.addEventListener('click', async (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const tr = e.target.closest('tr');
    const id = tr?.dataset?.id;
    const action = btn.dataset.action;

    if (action === 'edit') {
        try {
            const { data } = await api('GET', '/' + encodeURIComponent(id));
            els.id.value = data.id;
            els.title.value = data.title || '';
            els.author.value = data.author || '';
            els.year.value = data.year ?? '';
            els.rating.value = data.rating ?? '';
            els.tags.value = (data.tags || []).join(',');
            els.version.value = data.version || 1;
            els.id.focus();
            els.formMsg.textContent = `Loaded "${data.title}" (version ${data.version})`;
        } catch (err) {
            showToast('Load failed: ' + err.message, 'error');
        }
    }

    if (action === 'delete') {
        if (!confirm(`Delete book ${id}?`)) return;
        try {
            await api('DELETE', '/' + encodeURIComponent(id));
            showToast('Deleted.', 'success');
            refresh(); refreshStats();
        } catch (err) {
            showToast('Delete failed: ' + err.message, 'error');
        }
    }
});

// Create
els.form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const payload = collectPayload();
    try {
        const { data } = await api('POST', '', payload);
        showToast(`Created "${data.title}"`, 'success');
        els.form.reset(); els.version.value = '';
        refresh(); refreshStats();
    } catch (err) {
        showToast('Create failed: ' + err.message, 'error');
    }
});

// Update (optimistic concurrency)
els.updateBtn.addEventListener('click', async () => {
    const id = els.id.value.trim();
    if (!id) return (els.formMsg.textContent = 'Provide an ID (or click a row’s Edit).');
    const patch = collectPayload({ partial: true });
    patch.version = Number(els.version.value || 0);
    try {
        const { data } = await api('PUT', '/' + encodeURIComponent(id), patch);
        els.version.value = data.version;
        showToast(`Updated to version ${data.version}`, 'success');
        refresh(); refreshStats();
    } catch (err) {
        showToast('Update failed: ' + err.message, 'error');
    }
});

function collectPayload({ partial = false } = {}) {
    const tags = (els.tags.value || '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
    const payload = {
        id: els.id.value.trim() || undefined,
        title: els.title.value.trim(),
        author: els.author.value.trim() || undefined,
        year: els.year.value ? Number(els.year.value) : undefined,
        rating: els.rating.value ? Number(els.rating.value) : undefined,
        tags: tags.length ? tags : undefined
    };
    if (partial) {
        Object.keys(payload).forEach(k => (payload[k] === undefined || k === 'id') && delete payload[k]);
    }
    return payload;
}

/* ------------------------------- Theme toggle ------------------------------ */
(function initTheme() {
    const saved = localStorage.getItem('theme') || 'light';
    document.documentElement.setAttribute('data-theme', saved);
})();
els.themeToggle.addEventListener('click', () => {
    const cur = document.documentElement.getAttribute('data-theme') || 'light';
    const next = cur === 'light' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('theme', next);
});

/* ------------------------------- Export/Import ----------------------------- */
els.exportBtn.addEventListener('click', async () => {
    const params = new URLSearchParams({
        q: state.q, sort: state.sort, dir: state.dir, limit: 1000, offset: 0
    });
    try {
        const { data } = await api('GET', '?' + params.toString());
        const blob = new Blob([JSON.stringify({ items: data }, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'books-export.json';
        document.body.appendChild(a);
        a.click();
        URL.revokeObjectURL(a.href);
        a.remove();
    } catch (e) {
        showToast('Export failed: ' + e.message, 'error');
    }
});

els.importInput.addEventListener('change', async () => {
    const file = els.importInput.files[0];
    if (!file) return;
    try {
        const text = await file.text();
        const parsed = JSON.parse(text);
        const items = Array.isArray(parsed) ? parsed : parsed.items;
        if (!Array.isArray(items)) throw new Error('Invalid format: expected { items: [...] }');
        const mode = confirm('Import will REPLACE all books? Click OK to replace, Cancel to append.')
            ? 'replace' : 'append';
        const res = await fetch('/api/books/bulk', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ items, mode })
        });
        const json = await res.json();
        if (!res.ok || json.ok === false) throw new Error(json?.error?.message || 'Import failed');
        showToast(`Imported ${json.data.length} item(s) (${mode}).`, 'success');
        refresh(); refreshStats();
    } catch (e) {
        showToast('Import error: ' + e.message, 'error');
    } finally {
        els.importInput.value = '';
    }
});

/* --------------------------------- Init ----------------------------------- */
function initSortUI() { updateSortIndicators(); }
async function init() {
    initSortUI();
    await Promise.all([refresh(), refreshStats(), refreshHealth()]);
}
init();
