/**
 * server.js — Professional Client–Server demo (no external deps).
 * Features: REST API, search/sort/pagination, ETag/304, optimistic concurrency,
 * bulk import, stats, atomic persistence, basic rate limiting, access logs, CORS.
 *
 * Run:
 *   node server.js
 * Visit:
 *   http://localhost:8080
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const crypto = require('crypto');

/* --------------------------------- Helpers -------------------------------- */
const ok = (data, meta) => ({ ok: true, data, meta });
const err = (message, code = 'BAD_REQUEST', details) => ({ ok: false, error: { code, message, details }});
const nowISO = () => new Date().toISOString();
const sha = (s) => crypto.createHash('sha1').update(s).digest('hex');

function sendJSON(res, status, payload, etag) {
    const body = JSON.stringify(payload, null, 2);
    const headers = {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store'
    };
    if (etag) headers['ETag'] = etag;
    res.writeHead(status, headers);
    res.end(body);
}

function maybe304(req, res, compute) {
    const { body, etag } = compute();
    if (req.headers['if-none-match'] && req.headers['if-none-match'] === etag) {
        res.writeHead(304, { 'ETag': etag, 'Cache-Control': 'no-store' });
        res.end();
        return true;
    }
    sendJSON(res, 200, body, etag);
    return true;
}

function contentType(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    return ({
        '.html': 'text/html; charset=utf-8',
        '.css' : 'text/css; charset=utf-8',
        '.js'  : 'application/javascript; charset=utf-8',
        '.json': 'application/json; charset=utf-8',
        '.ico' : 'image/x-icon',
        '.svg' : 'image/svg+xml',
    })[ext] || 'application/octet-stream';
}

function sendFile(res, filePath) {
    try {
        const data = fs.readFileSync(filePath);
        res.writeHead(200, { 'Content-Type': contentType(filePath), 'Cache-Control': 'no-store' });
        res.end(data);
    } catch {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not found');
    }
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        const lim = 1e6; // ~1MB
        let size = 0;
        const chunks = [];
        req.on('data', c => {
            size += c.length;
            if (size > lim) { req.destroy(); reject(new Error('Payload too large')); }
            chunks.push(c);
        });
        req.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf-8');
            if (!raw) return resolve({});
            try { resolve(JSON.parse(raw)); }
            catch (e) { reject(new Error('Invalid JSON body')); }
        });
        req.on('error', reject);
    });
}

/* ------------------------------- Persistence ------------------------------- */
const DATA_PATH = path.join(__dirname, 'data.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

function ensureDataFile() {
    if (!fs.existsSync(DATA_PATH)) {
        const seed = {
            books: [
                { id: 'b1', title: 'Clean Architecture', author: 'Robert C. Martin', year: 2017, rating: 4.6, tags: ['architecture'], createdAt: nowISO(), updatedAt: nowISO(), version: 1 },
                { id: 'b2', title: 'Designing Data-Intensive Applications', author: 'Martin Kleppmann', year: 2017, rating: 4.8, tags: ['data','systems'], createdAt: nowISO(), updatedAt: nowISO(), version: 1 },
                { id: 'b3', title: "You Don't Know JS Yet", author: 'Kyle Simpson', year: 2020, rating: 4.5, tags: ['javascript'], createdAt: nowISO(), updatedAt: nowISO(), version: 1 }
            ]
        };
        fs.writeFileSync(DATA_PATH, JSON.stringify(seed, null, 2));
        return seed;
    }
    return JSON.parse(fs.readFileSync(DATA_PATH, 'utf-8'));
}
let db = ensureDataFile();
migrateDb(db);
persist();

function migrateDb(dbObj) {
    let changed = false;
    for (const b of dbObj.books) {
        if (!Array.isArray(b.tags)) { b.tags = []; changed = true; }
        if (!b.createdAt) { b.createdAt = nowISO(); changed = true; }
        if (!b.updatedAt) { b.updatedAt = b.createdAt; changed = true; }
        if (!Number.isInteger(b.version)) { b.version = 1; changed = true; }
    }
    return changed;
}

function atomicWrite(obj) {
    const tmp = DATA_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
    fs.renameSync(tmp, DATA_PATH);
}

function persist() {
    atomicWrite(db);
}

/* ------------------------------- Rate limiting ----------------------------- */
const HORIZON = 5 * 60 * 1000; // 5 minutes
const LIMIT = 100; // requests per IP per horizon
const ipHits = new Map();
function rateLimited(ip) {
    const now = Date.now();
    const arr = ipHits.get(ip) || [];
    while (arr.length && now - arr[0] > HORIZON) arr.shift();
    arr.push(now);
    ipHits.set(ip, arr);
    return arr.length > LIMIT;
}

/* ------------------------------- Business logic ---------------------------- */
function findBook(id) {
    return db.books.find(b => b.id === id);
}
function validateBook(input, { partial = false } = {}) {
    const problems = [];
    const out = {};
    const fields = ['id','title','author','year','rating','tags','version'];
    for (const k of fields) if (k in input) out[k] = input[k];

    if (!partial) {
        if (!out.title || typeof out.title !== 'string') problems.push('title is required (string)');
    }
    if ('year' in out && out.year != null) {
        const n = Number(out.year); if (!Number.isInteger(n) || n < 0 || n > 3000) problems.push('year must be integer 0..3000'); else out.year = n;
    }
    if ('rating' in out && out.rating != null) {
        const n = Number(out.rating); if (Number.isNaN(n) || n < 0 || n > 5) problems.push('rating must be 0..5'); else out.rating = Math.round(n * 10) / 10;
    }
    if ('tags' in out && out.tags != null) {
        if (!Array.isArray(out.tags)) problems.push('tags must be an array of strings');
        else out.tags = out.tags.map(t => String(t)).slice(0, 20);
    }
    return { ok: problems.length === 0, value: out, problems };
}

function createBook(input) {
    const { ok: valid, value, problems } = validateBook(input);
    if (!valid) throw { code: 400, payload: err('Validation failed', 'VALIDATION', problems) };
    if (value.id && findBook(value.id)) throw { code: 409, payload: err('ID already exists', 'CONFLICT') };
    const id = value.id || ('b' + crypto.randomBytes(3).toString('hex'));
    const now = nowISO();
    const book = {
        id, title: value.title, author: value.author || 'Unknown',
        year: value.year ?? null, rating: value.rating ?? null, tags: value.tags || [],
        createdAt: now, updatedAt: now, version: 1
    };
    db.books.push(book); persist();
    return book;
}
function updateBook(id, patch) {
    const b = findBook(id);
    if (!b) throw { code: 404, payload: err('Book not found', 'NOT_FOUND') };
    if (patch.version != null && Number(patch.version) !== b.version)
        throw { code: 409, payload: err('Version conflict', 'VERSION_CONFLICT', { expected: b.version }) };
    const { ok: valid, value, problems } = validateBook(patch, { partial: true });
    if (!valid) throw { code: 400, payload: err('Validation failed', 'VALIDATION', problems) };
    Object.assign(b, value);
    b.updatedAt = nowISO();
    b.version += 1;
    persist();
    return b;
}
function deleteBook(id) {
    const i = db.books.findIndex(b => b.id === id);
    if (i === -1) throw { code: 404, payload: err('Book not found', 'NOT_FOUND') };
    const [removed] = db.books.splice(i, 1); persist();
    return removed;
}

/* ------------------------------ Query helpers ----------------------------- */
function applyQuery(list, url) {
    const q = (url.searchParams.get('q') || '').toLowerCase();
    const sort = url.searchParams.get('sort') || 'title';
    const dir = (url.searchParams.get('dir') || 'asc').toLowerCase() === 'desc' ? -1 : 1;
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit') || 20), 1), 100);
    const offset = Math.max(Number(url.searchParams.get('offset') || 0), 0);

    let out = list;
    if (q) {
        out = out.filter(b =>
            (b.title || '').toLowerCase().includes(q) ||
            (b.author || '').toLowerCase().includes(q) ||
            (b.id || '').toLowerCase().includes(q) ||
            (Array.isArray(b.tags) ? b.tags.join(',') : '').toLowerCase().includes(q)
        );
    }

    const sortable = new Set(['id','title','author','year','rating','createdAt','updatedAt']);
    const s = sortable.has(sort) ? sort : 'title';
    out = out.slice().sort((a,b) => {
        const av = a[s] ?? '';
        const bv = b[s] ?? '';
        return av > bv ? dir : av < bv ? -dir : 0;
    });

    const total = out.length;
    out = out.slice(offset, offset + limit);
    return { list: out, meta: { total, limit, offset, sort: s, dir: dir === 1 ? 'asc' : 'desc', q } };
}

/* --------------------------------- Server --------------------------------- */
const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const method = req.method.toUpperCase();
    const ip = req.socket.remoteAddress || 'unknown';

    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, If-None-Match');
    if (method === 'OPTIONS') return res.end();

    // Access log
    console.log(`${new Date().toISOString()} ${ip} ${method} ${url.pathname}${url.search}`);

    // Rate limit
    if (rateLimited(ip)) {
        return sendJSON(res, 429, err('Too many requests', 'RATE_LIMIT'));
    }

    try {
        // ---------------------- API routes ----------------------
        if (url.pathname === '/api/health' && method === 'GET') {
            return sendJSON(res, 200, ok({ status: 'ok', time: nowISO() }));
        }

        if (url.pathname === '/api/stats' && method === 'GET') {
            const count = db.books.length;
            const rated = db.books.filter(b => b.rating != null);
            const avgRating = rated.length ? Number((rated.reduce((s,b)=>s+(b.rating||0),0) / rated.length).toFixed(2)) : null;
            const topAuthors = Object.entries(db.books.reduce((m,b)=>((m[b.author]= (m[b.author]||0)+1),m),{}))
                .sort((a,b)=>b[1]-a[1]).slice(0,5).map(([author,count])=>({author,count}));
            const topTags = Object.entries(db.books.flatMap(b=>b.tags||[]).reduce((m,t)=>((m[t]= (m[t]||0)+1),m),{}))
                .sort((a,b)=>b[1]-a[1]).slice(0,5).map(([tag,count])=>({tag,count}));
            return sendJSON(res, 200, ok({ count, avgRating, topAuthors, topTags }));
        }

        if (url.pathname === '/api/books' && method === 'GET') {
            return maybe304(req, res, () => {
                const { list, meta } = applyQuery(db.books, url);
                const body = ok(list, meta);
                const etag = sha(JSON.stringify({ list, meta }));
                return { body, etag };
            });
        }

        if (url.pathname.startsWith('/api/books/') && method === 'GET') {
            const id = decodeURIComponent(url.pathname.split('/').pop());
            const b = findBook(id);
            if (!b) return sendJSON(res, 404, err('Not found', 'NOT_FOUND'));
            return maybe304(req, res, () => {
                const body = ok(b);
                const etag = sha(JSON.stringify(b));
                return { body, etag };
            });
        }

        if (url.pathname === '/api/books' && method === 'POST') {
            const body = await readBody(req);
            const created = createBook(body);
            return sendJSON(res, 201, ok(created));
        }

        if (url.pathname.startsWith('/api/books/') && method === 'PUT') {
            const id = decodeURIComponent(url.pathname.split('/').pop());
            const patch = await readBody(req);
            const updated = updateBook(id, patch);
            return sendJSON(res, 200, ok(updated));
        }

        if (url.pathname.startsWith('/api/books/') && method === 'DELETE') {
            const id = decodeURIComponent(url.pathname.split('/').pop());
            const removed = deleteBook(id);
            return sendJSON(res, 200, ok(removed));
        }

        if (url.pathname === '/api/books/bulk' && method === 'POST') {
            const { items = [], mode = 'append' } = await readBody(req);
            if (!Array.isArray(items)) return sendJSON(res, 400, err('items must be an array', 'VALIDATION'));
            const added = [];
            if (mode === 'replace') db.books = [];
            for (const raw of items) {
                try { added.push(createBook(raw)); }
                catch (e) {
                    added.push({ error: e.payload?.error || { code: 'UNKNOWN', message: String(e) }, input: raw });
                }
            }
            return sendJSON(res, 200, ok(added, { mode }));
        }

        // ------------------- Static client assets -------------------
        if (url.pathname === '/' || !path.extname(url.pathname)) {
            return sendFile(res, path.join(PUBLIC_DIR, 'index.html'));
        }
        return sendFile(res, path.join(PUBLIC_DIR, url.pathname.replace(/^\/+/, '')));
    } catch (e) {
        if (e && typeof e === 'object' && 'code' in e && 'payload' in e) {
            return sendJSON(res, e.code, e.payload);
        }
        console.error('Unhandled error:', e);
        return sendJSON(res, 500, err('Internal server error', 'INTERNAL'));
    }
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
    console.log(`Client–Server Pro listening on http://localhost:${PORT}`);
});
