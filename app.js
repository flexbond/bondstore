/*
 * Bond Store - Progressive Web App (iPhone / Android / PC browser).
 * Same data files and export formats as the Android app (BondStoreApp) and BondTools.ps1 / Bond Manager.
 * Everything is stored on the device (IndexedDB); nothing is sent anywhere.
 */
'use strict';

const APP_VERSION = '1.0.6';
const DEFAULT_LETTER = 'I';

// ================================================================== small helpers
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = (n, w = 2) => String(n).padStart(w, '0');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtDayTime = (ms) => { const d = new Date(ms); return `${pad(d.getDate())} ${MONTHS[d.getMonth()]} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const fmtFull = (ms) => { const d = new Date(ms); return `${pad(d.getDate())} ${MONTHS[d.getMonth()]} ${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const stamp = (ms, sep = '-') => { const d = new Date(ms); return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${sep}${pad(d.getHours())}${pad(d.getMinutes())}`; };
const usd = (v) => (Math.round(v * 100) / 100).toFixed(2);
const sum = (arr, f) => arr.reduce((a, x) => a + f(x), 0);
const uniq = (arr) => [...new Set(arr)];
const newId = () => (crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
  const r = (crypto.getRandomValues(new Uint8Array(1))[0] & 15); return (c === 'x' ? r : (r & 3) | 8).toString(16);
}));

// ================================================================== CSV (port of Csv.kt)
const Csv = {
  detect(headerLine) {
    let best = ';', n = 0;
    for (const d of [';', ',', '\t']) { const c = headerLine.split(d).length - 1; if (c > n) { best = d; n = c; } }
    return best;
  },
  parse(text) {
    const clean = text.replace(/^﻿/, '');
    if (!clean.length) return [];
    const d = this.detect(clean.split('\n')[0]);
    const rows = []; let row = []; let field = ''; let q = false;
    for (let i = 0; i < clean.length; i++) {
      const c = clean[i];
      if (q) {
        if (c === '"') { if (clean[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += c;
      } else if (c === '"') q = true;
      else if (c === d) { row.push(field); field = ''; }
      else if (c === '\r') { /* skip */ }
      else if (c === '\n') { row.push(field); field = ''; rows.push(row); row = []; }
      else field += c;
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }
    return rows.filter((r) => r.some((x) => x.trim() !== ''));
  },
  key: (s) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, ''),
  /** Rows as objects keyed by the normalised header name. A missing column is undefined. */
  rows(text) {
    const rows = this.parse(text);
    if (!rows.length) return [];
    const h = rows[0].map((x) => this.key(x));
    return rows.slice(1).map((r) => { const o = {}; h.forEach((k, i) => { o[k] = (r[i] ?? '').trim(); }); return o; });
  },
  esc(s, d = ';') { s = String(s ?? ''); return /[;"\r\n]/.test(s) || s.includes(d) ? '"' + s.replace(/"/g, '""') + '"' : s; },
  line(vals, d = ';') { return vals.map((v) => this.esc(v, d)).join(d); },
  num(s) {
    if (s == null) return null;
    const t = String(s).trim().replace(/,/g, '.');
    if (!t || !/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t)) return null;
    return Number(t);
  },
  fmt(v) {
    const r = Math.round(v * 1e6) / 1e6;
    if (Number.isInteger(r)) return String(r === 0 ? 0 : r);
    return String(r);
  },
};
/** Factor and report qty keep 10 decimals so 24 x (1/24) adds up to 1 in Bond Manager. */
const fmtF = (v) => { const r = Math.round(v * 1e10) / 1e10; return String(r === 0 ? 0 : r); };
/** Pieces in one unit for a factor below 1 (0.041667 -> 24). */
const piecesOf = (f) => { const p = 1 / f; return Math.abs(p - Math.round(p)) < 1e-3 * p ? Math.round(p) : Math.round(p * 100) / 100; };
/** 0.0416666667 -> "1/24", 0.5 -> "1/2", 2 -> "2". */
const factorText = (f) => (f < 1 && Number.isInteger(piecesOf(f)) && Math.abs(1 / piecesOf(f) - f) < 1e-6 ? `1/${piecesOf(f)}` : Csv.fmt(f));
/** First of the given columns that exists in the row (like Kotlin's r["a"] ?: r["b"]). */
const col = (r, ...keys) => { for (const k of keys) if (r[k] !== undefined) return r[k]; return undefined; };

// ================================================================== Expiry (port of Model.kt)
const ymd = (y, m, d) => `${String(y).padStart(4, '0')}-${pad(m)}-${pad(d)}`;
const daysIn = (y, m) => new Date(y, m, 0).getDate();
const todayYmd = () => { const d = new Date(); return ymd(d.getFullYear(), d.getMonth() + 1, d.getDate()); };
function plusMonths(s, n) {
  let [y, m, d] = s.split('-').map(Number);
  m += n; y += Math.floor((m - 1) / 12); m = ((m - 1) % 12 + 12) % 12 + 1;
  return ymd(y, m, Math.min(d, daysIn(y, m)));
}
const Expiry = {
  parse(text) {
    const s = String(text ?? '').trim();
    if (!s) return null;
    const of = (y, m, d) => { y = +y; m = +m; d = +d; return m >= 1 && m <= 12 && d >= 1 && d <= daysIn(y, m) ? ymd(y, m, d) : null; };
    const eom = (y, m) => { y = +y; m = +m; return m >= 1 && m <= 12 ? ymd(y, m, daysIn(y, m)) : null; };
    let r;
    if ((r = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s))) return of(r[1], r[2], r[3]);
    if ((r = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/.exec(s))) return of(r[3], r[2], r[1]);
    if ((r = /^(\d{4})-(\d{1,2})$/.exec(s))) return eom(r[1], r[2]);
    if ((r = /^(\d{1,2})[./-](\d{4})$/.exec(s))) return eom(r[2], r[1]);
    return null;
  },
  /** 0 expired, 1/2/3 = within 1/2/3 months, null = later or no date. Dates are yyyy-MM-dd strings. */
  level(date, today = todayYmd()) {
    if (!date) return null;
    if (date < today) return 0;
    if (date <= plusMonths(today, 1)) return 1;
    if (date <= plusMonths(today, 2)) return 2;
    if (date <= plusMonths(today, 3)) return 3;
    return null;
  },
  label: (lv) => ['EXPIRED', 'Expires within 1 month', 'Expires within 2 months', 'Expires within 3 months'][lv],
  short: (lv) => ['expired', 'within 1 month', 'within 2 months', 'within 3 months'][lv],
  color: (lv) => ['#B3261E', '#D84315', '#EF6C00', '#B07A00'][lv],
  pretty(date) { const [y, m, d] = date.split('-'); return `${d} ${MONTHS[+m - 1]} ${y}`; },
};

// ================================================================== IndexedDB storage
const DB = {
  db: null,
  open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('bondstore', 1);
      r.onupgradeneeded = () => { for (const s of ['files', 'photos', 'settings']) if (!r.result.objectStoreNames.contains(s)) r.result.createObjectStore(s); };
      r.onsuccess = () => { this.db = r.result; res(); };
      r.onerror = () => rej(r.error);
    });
  },
  run(store, mode, fn) {
    return new Promise((res, rej) => {
      const t = this.db.transaction(store, mode);
      const req = fn(t.objectStore(store));
      let out;
      if (req) req.onsuccess = () => { out = req.result; };
      t.oncomplete = () => res(out);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error || new Error('Storage aborted'));
    });
  },
  get: (st, k) => DB.run(st, 'readonly', (s) => s.get(k)),
  put: (st, k, v) => DB.run(st, 'readwrite', (s) => s.put(v, k)),
  del: (st, k) => DB.run(st, 'readwrite', (s) => s.delete(k)),
  keys: (st) => DB.run(st, 'readonly', (s) => s.getAllKeys()),
  async all(st) {
    const out = {};
    await this.run(st, 'readonly', (s) => {
      const c = s.openCursor();
      c.onsuccess = () => { const cur = c.result; if (cur) { out[cur.key] = cur.value; cur.continue(); } };
      return null;
    });
    return out;
  },
};

// ================================================================== Repository (port of Repository.kt)
/** In-memory copies of the data files (crew.csv, lots.csv, ...). Every change is written to IndexedDB. */
const F = {};
const DATA_FILES = ['crew.csv', 'lots.csv', 'eanmap.csv', 'names.csv', 'expiry.csv', 'factors.csv', 'sessions.csv', 'issues.csv', 'meta.properties'];
let photoKeys = new Set();
const photoUrls = new Map();

function saveFile(name, text) {
  F[name] = text;
  DB.put('files', name, text).catch((e) => error('Could not save ' + name + ': ' + e.message));
}

const SPECIAL = [['CHARTERER', 'Charterer'], ['OWNER', 'Owner'], ['CLUB', 'Club'], ['SPOILAGE', 'Spoilage']]
  .map(([code, name]) => ({ code, name, reportColumn: code, special: true }));
const SESSION_HEADER = ['id', 'name', 'started_ms', 'closed_ms', 'exported_ms', 'export_file', 'export_count'];
const ISSUE_HEADER = ['id', 'session', 'timestamp_ms', 'date', 'time', 'person_code', 'person_name', 'report_column',
  'lot_code', 'item_code', 'description', 'port', 'price_usd', 'unit', 'qty', 'factor', 'report_qty', 'note'];
const LOTS_EXPORT_HEADER = ['lot_code', 'item_code', 'description', 'store_name', 'port', 'price_usd', 'unit', 'factor', 'ean', 'expiry', 'stock'];
const LEGACY_SESSION = 'S0000';

// ---- meta.properties (Java properties, shared with Android backups)
function meta() {
  const m = {};
  for (const ln of String(F['meta.properties'] || '').split(/\r?\n/)) {
    if (!ln.trim() || ln.startsWith('#') || ln.startsWith('!')) continue;
    const i = ln.search(/[=:]/);
    if (i > 0) m[ln.slice(0, i).trim()] = ln.slice(i + 1).trim();
  }
  return m;
}
function setMeta(k, v) {
  const m = meta(); m[k] = String(v);
  saveFile('meta.properties', '#' + new Date().toISOString() + '\n' + Object.entries(m).map(([a, b]) => `${a}=${b}`).join('\n') + '\n');
}
const lotsImportTs = () => Number(meta().lotsImportTs) || 0;

// ---- crew
function loadCrew() {
  const crew = Csv.rows(F['crew.csv'] || '').map((r) => {
    const code = String(col(r, 'code', 'employee_no', 'number') ?? '').trim().toUpperCase();
    if (!code) return null;
    const name = r.name || code;
    return { code, name, reportColumn: r.report_column || name, special: false };
  }).filter(Boolean);
  const codes = new Set(crew.map((p) => p.code));
  return crew.concat(SPECIAL.filter((p) => !codes.has(p.code)));
}
function importCrew(text) {
  const rows = Csv.rows(text);
  if (!rows.length) throw new Error('Crew file is empty');
  if (rows[0].code === undefined) throw new Error("Crew file needs a 'code' column (code;name;report_column)");
  saveFile('crew.csv', text.replace(/^﻿/, ''));
  return rows.filter((r) => (r.code || '').trim()).length;
}

// ---- lots
const mapFile = (name, valueKey) => {
  const m = new Map();
  for (const r of Csv.rows(F[name] || '')) m.set((r.lot_code || '').toUpperCase(), (r[valueKey] ?? '').trim());
  return m;
};
function loadEanMap() {
  const m = new Map();
  for (const r of Csv.rows(F['eanmap.csv'] || '')) {
    const k = (r.lot_code || '').toUpperCase();
    if (!m.has(k)) m.set(k, new Set());
    if ((r.ean || '').trim()) m.get(k).add(r.ean.trim());
  }
  return m;
}
function loadLots() {
  const extra = loadEanMap(), names = mapFile('names.csv', 'store_name'), exps = mapFile('expiry.csv', 'expiry');
  const facs = mapFile('factors.csv', 'factor');
  return Csv.rows(F['lots.csv'] || '').map((r) => {
    const code = (r.lot_code || '').trim().toUpperCase();
    if (!code) return null;
    const eans = new Set(String(r.ean || '').split(/[ |/]/).map((x) => x.trim()).filter(Boolean));
    for (const e of extra.get(code) || []) eans.add(e);
    const f = Csv.num(r.factor), fp = Csv.num(facs.get(code));
    const lot = {
      lotCode: code, itemCode: r.item_code || '', description: r.description || '', port: r.port || '',
      priceUsd: Csv.num(col(r, 'price_usd', 'price')) ?? 0, unit: r.unit || '',
      // A factor changed on the phone (factors.csv) wins over the lots file.
      factor: fp != null && fp > 0 ? fp : f != null && f > 0 ? f : 1, eans,
      fileFactor: f != null && f > 0 ? f : 1, factorOnPhone: fp != null && fp > 0,
      stockAtImport: Csv.num(col(r, 'stock', 'rob')),
      storeName: names.has(code) ? names.get(code) : (r.store_name || '').trim(),
      // A date set on the phone (or cleared there) wins over the lots file.
      expiry: exps.has(code) ? Expiry.parse(exps.get(code)) : Expiry.parse(r.expiry),
    };
    lot.name = lot.storeName || lot.description;
    return lot;
  }).filter(Boolean);
}
function importLots(text) {
  const rows = Csv.rows(text);
  if (!rows.length) throw new Error('Lots file is empty');
  if (rows[0].lot_code === undefined) throw new Error("Lots file needs a 'lot_code' column");
  saveFile('lots.csv', text.replace(/^﻿/, ''));
  setMeta('lotsImportTs', Date.now());
  // Phone factors that the new lots file already has (e.g. after Bond Manager's Phone data) are no longer needed.
  const facs = mapFile('factors.csv', 'factor');
  if (facs.size) {
    for (const r of rows) {
      const k = (r.lot_code || '').trim().toUpperCase();
      if (facs.has(k) && Csv.num(r.factor) != null && Math.abs(Csv.num(r.factor) - (Csv.num(facs.get(k)) ?? 0)) < 1e-6) facs.delete(k);
    }
    writeMap('factors.csv', ['lot_code', 'factor'], facs);
  }
  return rows.filter((r) => (r.lot_code || '').trim()).length;
}
function writeMap(name, header, map) {
  saveFile(name, Csv.line(header) + '\n' + [...map.entries()].map(([k, v]) => Csv.line([k, v]) + '\n').join(''));
}
function repoSetExpiry(code, date) { const m = mapFile('expiry.csv', 'expiry'); m.set(code, date || ''); writeMap('expiry.csv', ['lot_code', 'expiry'], m); }
function repoSetFactor(code, factor) {
  const m = mapFile('factors.csv', 'factor');
  if (factor == null) m.delete(code); else m.set(code, fmtF(factor));
  writeMap('factors.csv', ['lot_code', 'factor'], m);
}
/** "0.041667", "1/24", "0,5" -> number > 0, else null. */
function parseFactor(s) {
  const t = String(s || '').trim().replace(/,/g, '.');
  const m = t.match(/^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/);
  const v = m ? Number(m[1]) / Number(m[2]) : Csv.num(t);
  return v != null && isFinite(v) && v > 0 ? Math.round(v * 1e10) / 1e10 : null;
}
function repoSetStoreName(code, name) {
  const m = mapFile('names.csv', 'store_name');
  if (!name.trim()) m.delete(code); else m.set(code, name.trim());
  writeMap('names.csv', ['lot_code', 'store_name'], m);
}
function repoSetEan(code, ean, add) {
  let rows = Csv.rows(F['eanmap.csv'] || '').map((r) => [(r.lot_code || '').toUpperCase(), r.ean || '']);
  if (add && ean != null) rows.push([code, ean]); else rows = rows.filter(([c, e]) => !(c === code && (ean == null || e === ean)));
  const seen = new Set();
  rows = rows.filter(([c, e]) => { const k = c + '\u0000' + e; if (seen.has(k)) return false; seen.add(k); return true; });
  saveFile('eanmap.csv', 'lot_code;ean\n' + rows.map(([c, e]) => `${c};${e}\n`).join(''));
}
function lotsExportText() {
  return '﻿' + Csv.line(LOTS_EXPORT_HEADER) + '\r\n' + S.lots.map((l) => Csv.line([
    l.lotCode, l.itemCode, l.description, l.storeName, l.port, Csv.fmt(l.priceUsd), l.unit, fmtF(l.factor),
    [...l.eans].sort().join(' '), l.expiry || '', l.stockAtImport != null ? Csv.fmt(l.stockAtImport) : '',
  ]) + '\r\n').join('');
}

// ---- issues
const reportQty = (i) => i.qty * i.factor;
function issueLine(i) {
  const d = new Date(i.timestamp);
  return Csv.line([
    i.id, i.sessionId, String(i.timestamp),
    ymd(d.getFullYear(), d.getMonth() + 1, d.getDate()), `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`,
    i.personCode, i.personName, i.reportColumn, i.lotCode, i.itemCode, i.description, i.port,
    Csv.fmt(i.priceUsd), i.unit, Csv.fmt(i.qty), fmtF(i.factor), fmtF(reportQty(i)), i.note,
  ]);
}
function parseIssues() {
  return Csv.rows(F['issues.csv'] || '').map((r) => {
    const ts = Number(r.timestamp_ms);
    if (!r.timestamp_ms || !Number.isFinite(ts)) return null;
    return {
      id: r.id || '', timestamp: ts, personCode: r.person_code || '', personName: r.person_name || '',
      reportColumn: r.report_column || '', lotCode: r.lot_code || '', itemCode: r.item_code || '',
      description: r.description || '', port: r.port || '', priceUsd: Csv.num(r.price_usd) ?? 0, unit: r.unit || '',
      qty: Csv.num(r.qty) ?? 0, factor: Csv.num(r.factor) ?? 1, note: r.note || '', sessionId: r.session || '',
    };
  }).filter(Boolean);
}
/** Issue logs from before sessions existed (old Android backups) are moved into session S0000 "Earlier issues". */
function migrateIssues() {
  const text = F['issues.csv'];
  if (!text) return;
  const first = text.replace(/^﻿/, '').split('\n')[0];
  if (first.split(/[;,\t]/).some((x) => x.trim().replace(/^"|"$/g, '').toLowerCase() === 'session')) return;
  const old = parseIssues().map((i) => ({ ...i, sessionId: LEGACY_SESSION }));
  saveFile('issues.csv', Csv.line(ISSUE_HEADER) + '\n' + old.map((i) => issueLine(i) + '\n').join(''));
  const sessions = loadSessions();
  if (old.length && !sessions.some((s) => s.id === LEGACY_SESSION)) {
    const last = Number(meta().lastExportTs) || 0;
    const exported = last > 0 && old.every((i) => i.timestamp <= last) ? last : null;
    saveSessions([{ id: LEGACY_SESSION, name: 'Earlier issues', started: Math.min(...old.map((i) => i.timestamp)),
      closed: Math.max(...old.map((i) => i.timestamp)), exportedTs: exported, exportFile: '', exportCount: exported ? 1 : 0 }, ...sessions]);
  }
}
function loadIssues() { migrateIssues(); return parseIssues(); }
function appendIssues(list) {
  migrateIssues();
  let text = F['issues.csv'] || '';
  if (!text) text = Csv.line(ISSUE_HEADER) + '\n';
  else if (!text.endsWith('\n')) text += '\n';
  saveFile('issues.csv', text + list.map((i) => issueLine(i) + '\n').join(''));
}
function issuesExportText(list) {
  return '﻿' + Csv.line(ISSUE_HEADER) + '\r\n' + list.map((i) => issueLine(i) + '\r\n').join('');
}

// ---- sessions
function loadSessions() {
  const n = (v) => (v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
  return Csv.rows(F['sessions.csv'] || '').map((r) => r.id ? {
    id: r.id, name: r.name || '', started: n(r.started_ms) ?? 0, closed: n(r.closed_ms), exportedTs: n(r.exported_ms),
    exportFile: r.export_file || '', exportCount: Number.parseInt(r.export_count, 10) || 0,
  } : null).filter(Boolean);
}
function saveSessions(list) {
  saveFile('sessions.csv', Csv.line(SESSION_HEADER) + '\n' + list.map((s) => Csv.line([
    s.id, s.name, String(s.started), s.closed != null ? String(s.closed) : '', s.exportedTs != null ? String(s.exportedTs) : '',
    s.exportFile, String(s.exportCount),
  ]) + '\n').join(''));
}
const sessionTitle = (s) => (s.name.trim() ? `${s.id} · ${s.name}` : s.id);
/** Next number for this device's letter: I0001, I0002 ... (never reused). */
function nextSessionId(list) {
  const L = S.settings.letter;
  const max = Math.max(0, ...list.filter((s) => s.id.startsWith(L) && /^\d+$/.test(s.id.slice(1))).map((s) => Number(s.id.slice(1))));
  return L + pad(max + 1, 4);
}

// ---- photos
const photoName = (code) => code.replace(/[^A-Za-z0-9_-]/g, '_') + '.jpg';
async function photoUrl(name) {
  if (photoUrls.has(name)) return photoUrls.get(name);
  const blob = await DB.get('photos', name);
  if (!blob) return null;
  const url = URL.createObjectURL(blob);
  photoUrls.set(name, url);
  return url;
}
function forgetPhotos() { for (const u of photoUrls.values()) URL.revokeObjectURL(u); photoUrls.clear(); }
/** Reads an image file, turns it upright, scales it to max 1280 px and stores it as the lot's JPEG. */
async function savePhoto(code, file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('Not an image')); i.src = url; });
    const k = Math.min(1, 1280 / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    const blob = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.85));
    if (!blob) throw new Error('Cannot convert the image');
    const name = photoName(code);
    await DB.put('photos', name, blob);
    photoKeys.add(name);
    if (photoUrls.has(name)) { URL.revokeObjectURL(photoUrls.get(name)); photoUrls.delete(name); }
  } finally { URL.revokeObjectURL(url); }
}

// ---- backup ZIP (same entries as Android)
async function backupZip() {
  const enc = new TextEncoder();
  const entries = {};
  for (const n of DATA_FILES) if (F[n] != null) entries[n] = [enc.encode(F[n]), { level: 6 }];
  const photos = await DB.all('photos');
  for (const [n, blob] of Object.entries(photos)) {
    if (!n.endsWith('.jpg') || n.startsWith('_')) continue;
    entries['photos/' + n] = [new Uint8Array(await blob.arrayBuffer()), { level: 0 }];
  }
  return new Blob([fflate.zipSync(entries)], { type: 'application/zip' });
}
async function restoreZip(file) {
  const files = fflate.unzipSync(new Uint8Array(await file.arrayBuffer()));
  const dec = new TextDecoder('utf-8');
  let n = 0;
  for (const [raw, data] of Object.entries(files)) {
    const name = raw.replace(/\\/g, '/');
    if (DATA_FILES.includes(name)) {
      F[name] = dec.decode(data);
      await DB.put('files', name, F[name]); n++;
    } else if (name.startsWith('photos/') && name.endsWith('.jpg') && !name.slice(7).includes('/') && name.length > 11) {
      const pn = name.slice(7);
      await DB.put('photos', pn, new Blob([data], { type: 'image/jpeg' }));
      photoKeys.add(pn); n++;
    }
  }
  forgetPhotos();
  return n;
}

// ================================================================== state
const S = {
  screen: 'HOME', loaded: false,
  crew: [], lots: [], issues: [], sessions: [],
  settings: { letter: DEFAULT_LETTER, lastBackupTs: 0 },
  person: null, cart: [], lastLot: null, choice: null,
  selectedLot: null, waitingForEan: false,
  cameraOn: true, manual: '',
  dialog: null, showSessionPrompt: false, showNewSession: false, showExpiryAlert: false,
  hist: { sessionId: '', mode: 0, filter: '' }, lotsFilter: '',
  backgroundSince: 0, persisted: null,
};
const activeSession = () => { for (let i = S.sessions.length - 1; i >= 0; i--) if (S.sessions[i].closed == null) return S.sessions[i]; return null; };
const linesOf = (s) => S.issues.filter((i) => i.sessionId === s.id);
const unexported = (s) => S.issues.filter((i) => i.sessionId === s.id && i.timestamp > (s.exportedTs ?? -Infinity)).length;
const persons = (lines) => uniq(lines.map((i) => i.personCode)).length;

function reload() {
  S.crew = loadCrew(); S.lots = loadLots(); S.issues = loadIssues(); S.sessions = loadSessions();
  if (S.selectedLot) S.selectedLot = S.lots.find((l) => l.lotCode === S.selectedLot.lotCode) || null;
  S.cart.forEach((c) => { c.lot = S.lots.find((l) => l.lotCode === c.lot.lotCode) || c.lot; });
}

/** Pieces left = (stock at import - report units issued since import) / factor. null if stock unknown. */
function stockLeft(lot) {
  if (lot.stockAtImport == null) return null;
  const since = lotsImportTs();
  const used = sum(S.issues.filter((i) => i.lotCode === lot.lotCode && i.timestamp >= since), reportQty);
  return (lot.stockAtImport - used) / lot.factor;
}
function expiryAlerts() {
  return S.lots.filter((l) => Expiry.level(l.expiry) != null && (() => { const s = stockLeft(l); return s == null || s > 1e-9; })())
    .sort((a, b) => (a.expiry < b.expiry ? -1 : a.expiry > b.expiry ? 1 : 0));
}

// ================================================================== feedback
let audio = null;
function beep(isError) {
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state === 'suspended') audio.resume();
    const o = audio.createOscillator(), g = audio.createGain();
    o.type = 'square'; o.frequency.value = isError ? 220 : 1500;
    g.gain.value = 0.08;
    o.connect(g); g.connect(audio.destination);
    o.start(); o.stop(audio.currentTime + (isError ? 0.4 : 0.12));
  } catch (e) { /* no sound */ }
  if (navigator.vibrate && navigator.userActivation?.hasBeenActive) navigator.vibrate(isError ? [80, 60, 80] : 40);
}
let msgTimer = 0;
function showMsg(text, isErr) {
  const m = $('#msg');
  m.textContent = text; m.className = isErr ? 'err' : ''; m.hidden = false;
  clearTimeout(msgTimer);
  msgTimer = setTimeout(() => { m.hidden = true; }, 6000);
}
function ok(text) { showMsg(text, false); beep(false); }
function error(text) { showMsg(text, true); beep(true); }

// ================================================================== camera scanning
const Cam = {
  box: null, video: null, stream: null, timer: 0, onCode: null, starting: false, detector: null, reader: null, canvas: null,
  init() {
    this.box = document.createElement('div');
    this.box.className = 'cam';
    this.box.innerHTML = '<video playsinline muted autoplay></video><div class="aim"></div><div class="aimbox"></div><div class="camerr" hidden></div>';
    this.video = this.box.querySelector('video');
    this.canvas = document.createElement('canvas');
    // In Button mode a tap on the picture also captures.
    this.box.addEventListener('click', () => { if (this.captureMode()) this.capture(); });
    $('#camHolder').append(this.box);
  },
  captureMode: () => S.settings.scanMode !== 'auto',
  /** Called after the scan mode changes: Auto reads continuously, Button reads only on Capture. */
  applyMode() {
    this.box.classList.toggle('capture', this.captureMode());
    if (this.captureMode()) clearTimeout(this.timer); else if (this.stream) this.loop();
  },
  async setupDecoder() {
    if (this.detector || this.reader) return;
    try {
      if ('BarcodeDetector' in window) {
        const want = ['code_128', 'ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_39', 'qr_code', 'data_matrix'];
        const have = await BarcodeDetector.getSupportedFormats();
        const formats = want.filter((f) => have.includes(f));
        if (formats.includes('code_128')) { this.detector = new BarcodeDetector({ formats }); return; }
      }
    } catch (e) { /* fall back to ZXing */ }
    const Z = window.ZXing;
    const F = Z.BarcodeFormat;
    const hints = new Map();
    hints.set(Z.DecodeHintType.POSSIBLE_FORMATS, [F.CODE_128, F.EAN_13, F.EAN_8, F.UPC_A, F.UPC_E, F.CODE_39, F.QR_CODE, F.DATA_MATRIX]);
    this.reader = new Z.MultiFormatReader();
    this.reader.setHints(hints);
  },
  async start(onCode) {
    this.onCode = onCode;
    if (this.stream || this.starting) return;
    this.starting = true;
    const err = this.box.querySelector('.camerr');
    try {
      await this.setupDecoder();
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser has no camera access here (the app must be opened over https).');
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
      });
      if (!this.onCode) { this.stop(); return; }
      this.video.srcObject = this.stream;
      await this.video.play().catch(() => {});
      err.hidden = true;
      this.applyMode();
    } catch (e) {
      err.textContent = 'Camera not available: ' + (e.name === 'NotAllowedError' ? 'permission refused. Allow the camera for this app in Settings.' : e.message || e.name) +
        '\nYou can still use a Bluetooth scanner or type the code.';
      err.hidden = false;
    } finally { this.starting = false; }
  },
  stop() {
    this.onCode = null;
    clearTimeout(this.timer);
    if (this.stream) { this.stream.getTracks().forEach((t) => t.stop()); this.stream = null; }
    this.video.srcObject = null;
    $('#camHolder').append(this.box);
  },
  loop() {
    clearTimeout(this.timer);
    if (!this.stream || this.captureMode()) return;
    this.timer = setTimeout(async () => {
      try {
        const text = await this.decode();
        if (text && this.onCode) {
          this.box.classList.add('hit'); setTimeout(() => this.box.classList.remove('hit'), 250);
          this.onCode(text);
        }
      } catch (e) { /* nothing found */ }
      this.loop();
    }, 120);
  },
  /** Button mode: reads the code inside the red box (tries for up to 1.5 s). The same item can be captured again and again. */
  async capture() {
    if (this.capturing || !this.onCode) return;
    if (!this.stream) { error('Camera is not running'); return; }
    this.capturing = true;
    this.box.classList.add('busy');
    try {
      for (let i = 0; i < 15; i++) {
        const text = await this.decode(true).catch(() => null);
        if (text) {
          this.box.classList.add('hit'); setTimeout(() => this.box.classList.remove('hit'), 250);
          this.onCode(text, true);
          return;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      error('No barcode read – fit the barcode inside the red frame (not smaller than it), then tap Capture again');
    } finally { this.capturing = false; this.box.classList.remove('busy'); }
  },
  /** crop = only the part of the picture inside the red box (Button mode). A neighbouring label cut by the
   *  edge of the box can stop the reader, so narrower centred strips are tried too. */
  async decode(crop = false) {
    const v = this.video;
    if (v.readyState < 2 || !v.videoWidth) return null;
    if (!crop) {
      if (this.detector) { const found = await this.detector.detect(v); return found.length ? found[0].rawValue : null; }
      return this.decodeRegion(0, 0, v.videoWidth, v.videoHeight);
    }
    // The video fills the box (object-fit: cover, centred). Map the red frame's on-screen rectangle to video pixels.
    const bw = this.box.clientWidth || 1, bh = this.box.clientHeight || 1;
    const scale = Math.max(bw / v.videoWidth, bh / v.videoHeight);
    const offX = (v.videoWidth * scale - bw) / 2, offY = (v.videoHeight * scale - bh) / 2;
    const fr = this.box.querySelector('.aimbox');
    const r = fr.offsetWidth ? { x: fr.offsetLeft, y: fr.offsetTop - fr.offsetHeight / 2, w: fr.offsetWidth, h: fr.offsetHeight }
      : { x: bw * 0.07, y: bh / 2 - bw * 0.086, w: bw * 0.86, h: bw * 0.172 }; // fallback = CSS values
    const cx = (r.x + r.w / 2 + offX) / scale, cy = (r.y + r.h / 2 + offY) / scale;
    // A little wider than the frame (white margins), and taller (1D code: any line across the bars is enough,
    // labels above/below are far away).
    // Product barcodes (short, usually alone on the pack): allow more room around the frame, then tighter.
    const ean = this.box.classList.contains('ean');
    const W = (r.w * 1.06) / scale, H = Math.min(v.videoHeight, (r.h * 1.8) / scale);
    for (const f of this.detector ? [ean ? 1.4 : 1] : ean ? [1.4, 1.15, 1, 0.8] : [1, 0.85, 0.7, 0.55]) {
      const sw = Math.min(v.videoWidth, Math.round(W * f)), sh = Math.round(H);
      const sx = Math.max(0, Math.min(v.videoWidth - sw, Math.round(cx - sw / 2)));
      const sy = Math.max(0, Math.min(v.videoHeight - sh, Math.round(cy - sh / 2)));
      const text = await this.decodeRegion(sx, sy, sw, sh);
      if (text) return text;
    }
    return null;
  },
  async decodeRegion(sx, sy, sw, sh) {
    const v = this.video;
    const k = Math.min(1, 960 / sw);
    const w = Math.round(sw * k), h = Math.round(sh * k);
    const c = this.canvas;
    if (c.width !== w) c.width = w;
    if (c.height !== h) c.height = h;
    c.getContext('2d', { willReadFrequently: true }).drawImage(v, sx, sy, sw, sh, 0, 0, w, h);
    if (this.detector) {
      // Several codes found: take the one nearest the middle of the box.
      const found = await this.detector.detect(c);
      if (!found.length) return null;
      const d = (b) => { const r = b.boundingBox; return Math.hypot(r.x + r.width / 2 - w / 2, r.y + r.height / 2 - h / 2); };
      return found.sort((a, b2) => d(a) - d(b2))[0].rawValue;
    }
    const Z = window.ZXing;
    try {
      const bmp = new Z.BinaryBitmap(new Z.HybridBinarizer(new Z.HTMLCanvasElementLuminanceSource(c)));
      return this.reader.decodeWithState(bmp).getText();
    } catch (e) { return null; } finally { this.reader.reset(); }
  },
};

// ================================================================== scanning logic (port of AppViewModel.kt)
let lastCode = '', lastCodeAt = 0;
function onScan(raw, fromCamera) {
  const code = String(raw).trim().toUpperCase();
  if (!code) return;
  const now = Date.now();
  // The camera sees the same code many times per second: ignore repeats for 1.5 s.
  if (fromCamera && code === lastCode && now - lastCodeAt < 1500) return;
  lastCode = code; lastCodeAt = now;
  if (S.screen === 'ISSUE') issueScan(code);
  else if (S.screen === 'LOT_DETAIL') { if (S.waitingForEan) assignEan(String(raw).trim()); }
  else if (S.screen === 'LOTS') { const l = S.lots.find((x) => x.lotCode === code || x.eans.has(code)); if (l) openLot(l); }
}
function issueScan(code) {
  if (S.choice) return;
  if (code === 'DONE') return confirmIssue();
  if (code === 'CANCEL') return cancelIssue();
  if (code === 'UNDO') return undo();
  const p = S.crew.find((x) => x.code === code);
  if (p) {
    if (S.person && S.person.code !== p.code && S.cart.length) error(`Finish (DONE) or cancel the issue for ${S.person.name} first`);
    else { S.person = p; ok(`${p.name}: scan items`); }
    return render();
  }
  if (!activeSession()) { error('Start an issue session first'); S.showNewSession = true; return render(); }
  const byLot = S.lots.find((l) => l.lotCode === code);
  const byEan = byLot ? [] : S.lots.filter((l) => l.eans.has(code));
  if (!byLot && !byEan.length) { error('Unknown code: ' + code); return render(); }
  if (!S.person) { error('Scan the employee card first'); return render(); }
  if (byLot) addLot(byLot);
  else if (byEan.length === 1) addLot(byEan[0]);
  else { S.choice = byEan; beep(true); }
  render();
}
function chooseLot(code) {
  const lot = S.choice && S.choice.find((l) => l.lotCode === code);
  S.choice = null;
  if (lot) addLot(lot);
  render();
}
function addLot(lot, n = 1) {
  let line = S.cart.find((c) => c.lot.lotCode === lot.lotCode);
  if (line) line.qty += n; else S.cart.push(line = { lot, qty: n });
  S.lastLot = lot;
  const left = stockLeft(lot);
  if (left != null && line.qty > left + 1e-9) error(`${lot.name}: only ${Csv.fmt(left)} left in stock`);
  else if (Expiry.level(lot.expiry) === 0) error(`${lot.name} (${lot.port}) EXPIRED on ${lot.expiry} – check before issuing`);
  else ok(`+${n} ${lot.name} (${lot.port})`);
}
function changeQty(code, d) {
  const line = S.cart.find((c) => c.lot.lotCode === code);
  if (!line) return;
  line.qty += d;
  if (line.qty <= 0) S.cart.splice(S.cart.indexOf(line), 1);
  render();
}
function undo() {
  const l = (S.lastLot && S.cart.find((c) => c.lot.lotCode === S.lastLot.lotCode)) || S.cart[S.cart.length - 1];
  if (!l) { error('Nothing to undo'); return render(); }
  l.qty -= 1;
  if (l.qty <= 0) S.cart.splice(S.cart.indexOf(l), 1);
  ok('Removed 1 ' + l.lot.name);
  render();
}
function confirmIssue() {
  const p = S.person;
  if (!p || !S.cart.length) { error('Nothing to save'); return render(); }
  const session = activeSession();
  if (!session) { error('Start an issue session first'); S.showNewSession = true; return render(); }
  const now = Date.now();
  const lines = S.cart.map((c) => ({
    id: newId(), timestamp: now, personCode: p.code, personName: p.name, reportColumn: p.reportColumn,
    lotCode: c.lot.lotCode, itemCode: c.lot.itemCode, description: c.lot.description, port: c.lot.port,
    priceUsd: c.lot.priceUsd, unit: c.lot.unit, qty: c.qty, factor: c.lot.factor, note: '', sessionId: session.id,
  }));
  appendIssues(lines);
  S.issues = S.issues.concat(lines);
  const count = sum(S.cart, (c) => c.qty);
  S.cart = []; S.person = null; S.lastLot = null;
  ok(`Saved ${count} item(s) for ${p.name}`);
  render();
}
function cancelIssue() {
  S.cart = []; S.person = null; S.lastLot = null; S.choice = null;
  ok('Cancelled');
  render();
}
function reverse(id) {
  const i = S.issues.find((x) => x.id === id);
  if (!i) return;
  // The reversal belongs to the same session as the line it corrects, so that session's file is complete.
  const r = { ...i, id: newId(), timestamp: Date.now(), qty: -i.qty, note: 'Reversal of ' + i.id,
    sessionId: i.sessionId || activeSession()?.id || LEGACY_SESSION };
  appendIssues([r]);
  S.issues = S.issues.concat([r]);
  ok(`Reversed ${Csv.fmt(i.qty)} ${i.description} for ${i.personName}`);
}

// ---- sessions
function startSession(name) {
  if (S.cart.length) { error('Save (DONE) or cancel the current issue first'); return false; }
  const now = Date.now();
  const list = S.sessions.map((s) => (s.closed == null ? { ...s, closed: now } : s));
  const s = { id: nextSessionId(list), name: name.trim(), started: now, closed: null, exportedTs: null, exportFile: '', exportCount: 0 };
  saveSessions(list.concat([s]));
  S.sessions = list.concat([s]);
  S.person = null; S.lastLot = null;
  S.showNewSession = false; S.showSessionPrompt = false;
  ok(`Session ${sessionTitle(s)} started`);
  return true;
}
function endSession() {
  const a = activeSession();
  if (!a) return;
  if (S.cart.length) { error('Save (DONE) or cancel the current issue first'); return; }
  S.sessions = S.sessions.map((s) => (s.id === a.id ? { ...s, closed: Date.now() } : s));
  saveSessions(S.sessions);
  S.person = null; S.lastLot = null;
  ok(`Session ${a.id} ended – export it in Import / export`);
}
const sessionFileName = (s) => `BOND_${s.id}_${stamp(s.started)}` + (s.exportCount > 0 ? `_v${s.exportCount + 1}` : '') + '.csv';
function markExported(id, fileName) {
  S.sessions = loadSessions().map((s) => (s.id === id ? { ...s, exportedTs: Date.now(), exportFile: fileName, exportCount: s.exportCount + 1 } : s));
  saveSessions(S.sessions);
}

// ---- lots
function openLot(l) { S.selectedLot = l; S.waitingForEan = false; go('LOT_DETAIL'); }
function assignEan(ean) {
  const l = S.selectedLot;
  if (!l) return;
  S.waitingForEan = false;
  repoSetEan(l.lotCode, ean, true);
  reload(); ok(`Product barcode ${ean} linked to ${l.lotCode}`); render();
}

// ================================================================== files in / out
function csvBlob(text) { return new Blob([text], { type: 'text/csv;charset=utf-8' }); }
/** Shows "file ready" with Share (iPhone: Save to Files, AirDrop, Mail) and Download. onDone runs after either. */
function offerFile(name, blob, onDone) {
  S.dialog = { type: 'file', name, blob, onDone };
  render();
}
async function shareFile() {
  const d = S.dialog;
  if (!d || d.type !== 'file') return;
  const file = new File([d.blob], d.name, { type: d.blob.type || 'application/octet-stream' });
  try {
    await navigator.share({ files: [file], title: d.name });
    S.dialog = null;
    d.onDone && d.onDone();
    render();
  } catch (e) {
    if (e.name !== 'AbortError') error('Share failed: ' + e.message + ' – try Download');
  }
}
function downloadFile() {
  const d = S.dialog;
  if (!d || d.type !== 'file') return;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(d.blob); a.download = d.name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  S.dialog = null;
  d.onDone && d.onDone();
  render();
}
const canShareFiles = () => { try { return !!(navigator.canShare && navigator.canShare({ files: [new File(['x'], 'x.csv', { type: 'text/csv' })] })); } catch (e) { return false; } };

function pick(id) { const el = $(id); el.value = ''; el.click(); }
function bindFileInputs() {
  const readText = (f) => f.text();
  $('#fLots').addEventListener('change', async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try { const n = importLots(await readText(f)); reload(); ok(`Imported ${n} lots`); } catch (x) { error(x.message); }
    render();
  });
  $('#fCrew').addEventListener('change', async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try { const n = importCrew(await readText(f)); reload(); ok(`Imported ${n} crew`); } catch (x) { error(x.message); }
    render();
  });
  $('#fRestore').addEventListener('change', (e) => {
    const f = e.target.files[0]; if (!f) return;
    S.dialog = { type: 'restore', file: f }; render();
  });
  const photo = async (e) => {
    const f = e.target.files[0]; const l = S.selectedLot; if (!f || !l) return;
    try { await savePhoto(l.lotCode, f); ok('Photo saved'); } catch (x) { error('Photo not saved: ' + x.message); }
    render();
  };
  $('#fPhotoCam').addEventListener('change', photo);
  $('#fPhotoLib').addEventListener('change', photo);
}
async function saveSetting(k, v) { S.settings[k] = v; try { await DB.put('settings', k, v); } catch (e) { error(e.message); } }

// ================================================================== rendering
const TITLES = { HOME: 'Bond Store', ISSUE: 'Issue items', HISTORY: 'History', LOTS: 'Lots & photos', CREW: 'Crew', DATA: 'Import / export', EXPIRY: 'Expiry check' };

function photoHtml(code, cls) {
  const name = photoName(code);
  return photoKeys.has(name) ? `<div class="photo ${cls}"><img data-photo="${esc(name)}" alt=""></div>` : `<div class="photo ${cls}">no<br>photo</div>`;
}
async function hydratePhotos(root = document) {
  for (const img of root.querySelectorAll('img[data-photo]:not([src])')) {
    const url = await photoUrl(img.dataset.photo);
    if (url) img.src = url;
  }
}
function expiryHtml(date, small) {
  if (!date) return '';
  const lv = Expiry.level(date), s = small ? ' s' : '';
  if (lv == null) return `<div class="exp-plain${s}">Exp. ${Expiry.pretty(date)}</div>`;
  return `<div><span class="exp${s}" style="background:${Expiry.color(lv)}">${lv === 0 ? 'EXPIRED ' : 'Exp. '}${Expiry.pretty(date)}${lv > 0 ? ` (${Expiry.short(lv)})` : ''}</span></div>`;
}
const big = (go, title, sub) => `<button class="big" data-go="${go}"><b>${esc(title)}</b><span>${esc(sub)}</span></button>`;
const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

function homeHtml() {
  const out = [];
  if (!isStandalone() && /iPhone|iPad|iPod/.test(navigator.userAgent)) {
    out.push(`<div class="banner info"><b>Install the app</b>In Safari tap <b style="display:inline;font-size:inherit">Share → Add to Home Screen</b>, then always open Bond Store from the Home Screen icon. It then works offline. (Safari and the Home Screen app keep separate data.)</div>`);
  }
  const alerts = expiryAlerts();
  if (alerts.length) {
    const worst = Math.min(...alerts.map((l) => Expiry.level(l.expiry)));
    const parts = [0, 1, 2, 3].map((lv) => { const n = alerts.filter((l) => Expiry.level(l.expiry) === lv).length; return n ? `${n} ${Expiry.short(lv)}` : null; }).filter(Boolean);
    out.push(`<button class="banner" data-go="EXPIRY" style="background:${Expiry.color(worst)}"><b>Expiry: ${alerts.length} lot(s) need attention</b>${esc(parts.join(' · '))}</button>`);
  }
  const days = S.settings.lastBackupTs ? Math.floor((Date.now() - S.settings.lastBackupTs) / 86400000) : null;
  if (S.issues.length && (days == null || days >= 7)) {
    out.push(`<button class="banner warn" data-go="DATA"><b>${days == null ? 'No backup yet' : `Last backup ${days} days ago`}</b>Make a backup in Import / export and keep it on the PC. The data lives only on this phone.</button>`);
  }
  const a = activeSession();
  const notExp = sum(S.sessions, unexported);
  out.push(big('ISSUE', 'Issue items', a ? `Open session ${sessionTitle(a)} · ${linesOf(a).length} line(s)` : 'No open session – tap to start one'));
  out.push(big('HISTORY', 'History', `${S.issues.length} lines in ${S.sessions.length} session(s) · by crew or item`));
  out.push(big('LOTS', 'Lots & photos', `${S.lots.length} lots · take product photos`));
  out.push(big('EXPIRY', 'Expiry check', `${S.lots.filter((l) => l.expiry).length} of ${S.lots.length} lots have an expiry date`));
  out.push(big('CREW', 'Crew', `${S.crew.filter((p) => !p.special).length} people + special accounts`));
  out.push(big('DATA', 'Import / export', notExp > 0 ? `${notExp} line(s) not exported yet` : 'All sessions exported · load lots & crew, backup'));
  if (!S.lots.length || !S.crew.some((p) => !p.special)) out.push(`<p class="red">Start here: Import / export → import lots.csv and crew.csv made on the PC.</p>`);
  return `<div class="stack">${out.join('')}</div>`;
}

function sessionCardHtml() {
  const a = activeSession();
  if (!a) return `<div class="card row"><div class="grow red name">No open issue session</div><button class="btn" data-act="newSession">Start session</button></div>`;
  const lines = linesOf(a);
  return `<div class="card row" style="padding:8px 8px 8px 14px"><div class="grow"><div class="navy name ellipsis">Session ${esc(sessionTitle(a))}</div>
    <div class="tiny">Since ${fmtDayTime(a.started)} · ${lines.length} line(s) · ${persons(lines)} person(s)</div></div>
    <button class="btn text" data-go="HISTORY">History</button><button class="btn text" data-act="endSession" ${S.cart.length ? 'disabled' : ''}>End</button></div>`;
}
const scanModeHtml = () => `<div class="seg" style="margin-top:0">${[['capture', 'Button (one by one)'], ['auto', 'Auto']].map(([m, t]) =>
  `<button data-act="scanMode" data-m="${m}" class="${(S.settings.scanMode !== 'auto') === (m === 'capture') ? 'on' : ''}">${t}</button>`).join('')}</div>`;
const captureBtn = () => (Cam.captureMode() ? '<button class="btn full capbtn" data-act="capture">Capture</button>' : '');
function issueHtml() {
  const p = S.person, l = S.lastLot;
  const left = l ? stockLeft(l) : null;
  const cartQty = sum(S.cart, (c) => c.qty);
  return `<div class="stack">
    ${sessionCardHtml()}
    <div>
      <label class="row" style="min-height:44px"><span class="grow">Camera</span><input type="checkbox" class="switch" data-act="toggleCam" ${S.cameraOn ? 'checked' : ''}></label>
      ${S.cameraOn ? `${scanModeHtml()}<div id="camSlot"></div>${captureBtn()}` : ''}
      <div class="row" style="margin-top:8px"><input type="text" id="manual" class="grow" placeholder="Type a code" value="${esc(S.manual)}" autocomplete="off" autocorrect="off" autocapitalize="characters" spellcheck="false" enterkeyhint="done">
      <button class="btn text" data-act="manualEnter">Enter</button></div>
    </div>
    <div class="card row"><div class="grow">
      ${p ? `<div class="big-name">${esc(p.name)}</div><div class="small">${esc(p.code)}${p.special ? ' · special account' : ''}</div><div class="navy">2. Scan items, then DONE</div>`
    : '<div class="navy" style="font-size:20px;font-weight:600">1. Scan employee card</div>'}
    </div><button class="btn text" data-act="pickPerson" ${S.cart.length ? 'disabled' : ''}>Pick</button></div>
    ${l ? `<div class="card row" style="align-items:flex-start;padding:10px">${photoHtml(l.lotCode, 'ph130')}<div class="grow">
      <div class="tiny">Last scanned</div><div style="font-size:18px;font-weight:600">${esc(l.name)}</div>
      ${l.storeName ? `<div class="tiny">ERP: ${esc(l.description)}</div>` : ''}
      <div class="navy bold">Port: ${esc(l.port)}</div><div>${Csv.fmt(l.priceUsd)} USD / ${esc(l.unit)}</div>
      <div class="tiny">${esc(l.lotCode)}</div>${left != null ? `<div class="small">In stock: ${Csv.fmt(left)}</div>` : ''}${expiryHtml(l.expiry)}</div></div>` : ''}
    ${S.cart.map((c) => `<div class="card row" style="padding:8px">${photoHtml(c.lot.lotCode, 'ph56')}
      <div class="grow"><div class="name clamp2">${esc(c.lot.name)}</div><div class="small navy">${esc(c.lot.port)}</div>${Expiry.level(c.lot.expiry) != null ? expiryHtml(c.lot.expiry, true) : ''}</div>
      <button class="btn out sq" data-act="qty" data-code="${esc(c.lot.lotCode)}" data-d="-1">−</button>
      <div style="width:40px;text-align:center;font-size:20px;font-weight:700">${c.qty}</div>
      <button class="btn out sq" data-act="qty" data-code="${esc(c.lot.lotCode)}" data-d="1">+</button></div>`).join('')}
    <div class="btnrow"><button class="btn out" data-act="cancelIssue">Cancel</button>
      <button class="btn w2" data-act="confirmIssue" ${p && S.cart.length ? '' : 'disabled'}>Save (DONE) · ${cartQty}</button></div>
  </div>`;
}

function histBase() {
  const h = S.hist, f = h.filter.trim().toLowerCase();
  const names = new Map(S.lots.map((l) => [l.lotCode, l.name]));
  return S.issues.filter((i) => !h.sessionId || i.sessionId === h.sessionId).filter((i) => !f ||
    [i.personName, i.personCode, i.description, i.port, i.lotCode, names.get(i.lotCode) || ''].some((s) => s.toLowerCase().includes(f)));
}
function historyHtml() {
  const h = S.hist;
  const opts = [`<option value="">All sessions</option>`].concat(S.sessions.slice().reverse().map((s) =>
    `<option value="${esc(s.id)}" ${s.id === h.sessionId ? 'selected' : ''}>${esc(sessionTitle(s))}${s.closed == null ? ' (open)' : ''} · ${fmtDayTime(s.started)}</option>`));
  return `<select id="histSession">${opts.join('')}</select>
    <div class="seg">${['Lines', 'By crew', 'By item'].map((t, i) => `<button data-act="histMode" data-m="${i}" class="${h.mode === i ? 'on' : ''}">${t}</button>`).join('')}</div>
    <div class="row"><input type="search" id="histFilter" class="grow" placeholder="Search name, item, port" value="${esc(h.filter)}" autocomplete="off" autocorrect="off">
    ${h.filter ? '<button class="btn text" data-act="histClear">Clear</button>' : ''}</div>
    <div id="histList">${histListHtml()}</div>`;
}
function histListHtml() {
  const h = S.hist, base = histBase();
  const names = new Map(S.lots.map((l) => [l.lotCode, l.name]));
  const reversed = new Set(S.issues.filter((i) => i.note.startsWith('Reversal of ')).map((i) => i.note.slice(12)));
  const head = `<p class="small">${base.length} line(s) · ${Csv.fmt(sum(base, (i) => i.qty))} pcs · ${usd(sum(base, (i) => reportQty(i) * i.priceUsd))} USD (net)</p>`;
  const summary = (title, sub, qty, money, act, val) => `<button class="item" data-act="${act}" data-v="${esc(val)}"><div class="grow">
    <div class="name clamp2">${esc(title)}</div><div class="small navy">${esc(sub)}</div></div>
    <div class="right"><div class="qty">${Csv.fmt(qty)} pcs</div><div class="tiny">${usd(money)} USD</div></div></button>`;
  let rows = '';
  if (h.mode === 0) {
    rows = base.slice().reverse().slice(0, 500).map((i) => {
      const isRev = i.qty < 0, was = reversed.has(i.id);
      const can = !isRev && !was;
      return `<${can ? 'button' : 'div'} class="item${can ? '' : ' static'}" ${can ? `data-act="askReverse" data-id="${esc(i.id)}"` : ''}><div class="grow">
        <div class="small">${fmtDayTime(i.timestamp)} · ${esc(i.personName)}${h.sessionId ? '' : ' · ' + esc(i.sessionId)}</div>
        <div class="name">${esc(names.get(i.lotCode) || i.description)}</div><div class="small navy">${esc(i.port)}${was ? ' · reversed' : ''}</div></div>
        <div class="qty" style="color:${isRev ? 'var(--red)' : 'inherit'}">${Csv.fmt(i.qty)}</div></${can ? 'button' : 'div'}>`;
    }).join('');
  } else if (h.mode === 1) {
    const g = new Map(); base.forEach((i) => { if (!g.has(i.personCode)) g.set(i.personCode, []); g.get(i.personCode).push(i); });
    rows = [...g.values()].sort((a, b) => a[0].personName.localeCompare(b[0].personName)).map((ls) =>
      summary(ls[0].personName, `${uniq(ls.map((i) => i.lotCode)).length} item(s) · ${ls.length} line(s)`, sum(ls, (i) => i.qty), sum(ls, (i) => reportQty(i) * i.priceUsd), 'histPick', ls[0].personName)).join('');
  } else {
    const g = new Map(); base.forEach((i) => { if (!g.has(i.lotCode)) g.set(i.lotCode, []); g.get(i.lotCode).push(i); });
    const t = (code, ls) => names.get(code) || ls[0].description;
    rows = [...g.entries()].sort((a, b) => t(...a).localeCompare(t(...b))).map(([code, ls]) =>
      summary(t(code, ls), `${ls[0].port} · ${uniq(ls.map((i) => i.personCode)).length} person(s)`, sum(ls, (i) => i.qty), sum(ls, (i) => reportQty(i) * i.priceUsd), 'histPick', code)).join('');
  }
  return head + `<div class="list">${rows}</div>`;
}

function lotRow(l, act = 'openLot') {
  const left = stockLeft(l);
  return `<button class="item" data-act="${act}" data-code="${esc(l.lotCode)}">${photoHtml(l.lotCode, 'ph56')}<div class="grow">
    <div class="name clamp2">${esc(l.name)}</div>${l.storeName ? `<div class="tiny ellipsis">ERP: ${esc(l.description)}</div>` : ''}
    <div class="small navy">${esc(l.port)} · ${Csv.fmt(l.priceUsd)} USD</div><div class="tiny">${esc(l.lotCode)}</div>${expiryHtml(l.expiry, true)}</div>
    ${left != null ? `<div class="bold">${Csv.fmt(left)}</div>` : ''}</button>`;
}
function lotsHtml() {
  return `<input type="search" id="lotsFilter" placeholder="Search item, port, code" value="${esc(S.lotsFilter)}" autocomplete="off" autocorrect="off">
    <div style="height:8px"></div>${S.lots.length ? '' : '<p>No lots yet. Import lots.csv in Import / export.</p>'}<div id="lotsList" class="list">${lotsListHtml()}</div>`;
}
function lotsListHtml() {
  const f = S.lotsFilter.trim().toLowerCase();
  return S.lots.filter((l) => !f || [l.description, l.storeName, l.port, l.lotCode, l.itemCode].some((s) => s.toLowerCase().includes(f))).map((l) => lotRow(l)).join('');
}
function lotDetailHtml() {
  const l = S.selectedLot;
  const left = stockLeft(l);
  const info = (a, b) => `<div class="info"><div class="l">${esc(a)}</div><div class="v">${b}</div></div>`;
  return `<div class="stack">
    ${photoHtml(l.lotCode, 'ph260')}
    <div class="btnrow"><button class="btn" data-act="photoCam">Take photo</button><button class="btn out" data-act="photoLib">From gallery</button></div>
    <div style="font-size:20px;font-weight:600">${esc(l.name)}</div>
    <div>${info('ERP name', esc(l.description))}
    <div class="row" style="margin:6px 0"><input type="text" id="storeName" class="grow" placeholder="Store name (as on the product)" value="${esc(l.storeName)}" autocomplete="off">
      <button class="btn text" data-act="saveStoreName">Save</button></div>
    ${info('Port', esc(l.port))}${info('Price', `${Csv.fmt(l.priceUsd)} USD / ${esc(l.unit)}`)}${info('Item code', esc(l.itemCode))}
    ${info('Lot code', esc(l.lotCode))}
    <div class="info" style="align-items:center"><div class="l">Factor</div><div class="v grow">${factorText(l.factor)} ${esc(l.unit)} per scanned piece${l.factor < 1 ? ` <span class="small">(${piecesOf(l.factor)} pieces per ${esc(l.unit)})</span>` : ''}${l.factorOnPhone ? `<div class="tiny orange">Changed on this phone · lots file: ${factorText(l.fileFactor)}</div>` : ''}</div>
      <button class="btn text" data-act="askFactor">Change</button></div>
    ${left != null ? info('In stock', Csv.fmt(left) + ' pieces') : ''}${info('Product barcodes', esc([...l.eans].join(', ') || 'none'))}
    <div class="info" style="align-items:center"><div class="l">Expiry date</div><div class="v grow">${l.expiry ? expiryHtml(l.expiry) : 'not set'}</div>
      <button class="btn text" data-act="askExpiry">${l.expiry ? 'Change' : 'Set'}</button>${l.expiry ? '<button class="btn text" data-act="clearExpiry">Clear</button>' : ''}</div></div>
    ${S.waitingForEan ? `<div class="navy name">Scan the barcode printed on the product…</div>${scanModeHtml()}<div id="camSlot"></div>${captureBtn()}<button class="btn out" data-act="stopEan">Stop</button>`
    : `<div class="btnrow"><button class="btn" data-act="linkEan">Link product barcode</button><button class="btn out" data-act="unlinkEan" ${l.eans.size ? '' : 'disabled'}>Unlink</button></div>`}
    <p class="tiny">Tip: if the same product barcode is linked to several lots, the app shows their photos and ports so you can pick the right one.</p>
  </div>`;
}
function crewHtml() {
  return `<div class="list">${S.crew.map((p) => `<div class="item static"><div class="grow"><div class="name">${esc(p.code)}&nbsp; ${esc(p.name)}</div>
    <div class="tiny">${p.special ? 'Special account' : 'Report column: ' + esc(p.reportColumn)}</div></div></div>`).join('')}</div>`;
}
function sessionListHtml() {
  if (!S.sessions.length) return '<p class="small">No sessions yet.</p>';
  return S.sessions.slice().reverse().map((s) => {
    const lines = linesOf(s), pend = unexported(s);
    let cls, st;
    if (!lines.length) { cls = 'grey'; st = 'Empty – nothing to export'; }
    else if (s.exportedTs == null) { cls = 'red'; st = 'NOT EXPORTED'; }
    else if (pend > 0) { cls = 'orange'; st = `CHANGED AFTER EXPORT – ${pend} new line(s). Last file: ${s.exportFile}`; }
    else { cls = 'green'; st = `Exported ${fmtFull(s.exportedTs)}\n${s.exportFile}`; }
    const btn = !lines.length ? '' : (s.exportedTs == null || pend > 0)
      ? `<button class="btn" data-act="exportSession" data-id="${esc(s.id)}">Export</button>`
      : `<button class="btn out" data-act="exportSession" data-id="${esc(s.id)}">Again</button>`;
    return `<div class="sess ${cls}"><div class="name">${esc(sessionTitle(s))}${s.closed == null ? '  (open)' : ''}</div>
      <div class="tiny">${fmtFull(s.started)} – ${s.closed != null ? fmtFull(s.closed) : 'still open'} · ${lines.length} line(s) · ${persons(lines)} person(s)</div>
      <div class="row"><div class="grow bold st-${cls}" style="font-size:13px;white-space:pre-line">${esc(st)}</div>${btn}</div></div>`;
  }).join('<div style="height:8px"></div>');
}
function dataHtml() {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
  const lb = S.settings.lastBackupTs;
  return `<div class="stack">
    <div class="h-sec">From the PC</div>
    <button class="btn full" data-act="importLots">Import lots.csv</button>
    <button class="btn full" data-act="importCrew">Import crew.csv</button>
    <p class="small">${S.lots.length} lots, ${S.crew.filter((p) => !p.special).length} crew loaded. Re-importing lots keeps photos, store names and product barcodes.</p>
    <div class="h-sec">Issue sessions → PC</div>
    <p class="tiny">Each session is exported as its own file. Red = not exported, orange = new lines since the export, green = exported.</p>
    ${sessionListHtml()}
    <button class="btn out full" data-act="exportAll">Export ALL issues in one file</button>
    <div class="h-sec">Lots → PC</div>
    <button class="btn out full" data-act="exportLots">Export lots (store names, barcodes)</button>
    <p class="tiny">Copy the exported lots.csv over lots.csv in BOND, folder app-data, on the PC, then run Phone data or Labels.</p>
    <div class="h-sec">Backup</div>
    <p class="small ${!lb && S.issues.length ? 'red' : ''}">Last backup: ${lb ? fmtFull(lb) : 'never'}</p>
    <button class="btn out full" data-act="backup">Backup everything (ZIP with photos)</button>
    <button class="btn danger full" data-act="restore">Restore from backup…</button>
    <p class="tiny">The backup ZIP is the same as the Android app's, so it can be restored on either.</p>
    <div class="h-sec">Settings</div>
    <div class="row"><div class="grow">Device letter for session numbers<div class="tiny">Next session: ${esc(nextSessionId(S.sessions))}. Android uses S; give every phone its own letter.</div></div>
      <select id="letter" style="width:90px">${letters.map((c) => `<option ${c === S.settings.letter ? 'selected' : ''}>${c}</option>`).join('')}</select></div>
    <button class="btn out full" data-act="showQr">Install on another phone (QR code)</button>
    <p class="tiny">Storage: ${S.persisted == null ? 'unknown' : S.persisted ? 'kept by the browser (persistent)' : 'may be cleared by the system when space is low – keep backups'} · App ${APP_VERSION}${isStandalone() ? ' · installed' : ''}</p>
  </div>`;
}
function expiryScreenHtml() {
  const alerts = expiryAlerts();
  const later = S.lots.filter((l) => l.expiry && Expiry.level(l.expiry) == null).sort((a, b) => (a.expiry < b.expiry ? -1 : 1));
  const noDate = S.lots.filter((l) => !l.expiry && (() => { const s = stockLeft(l); return s == null || s > 1e-9; })());
  const out = [`<p class="small">Lots with stock that are expired or expire within 3 months. Tap a lot to change its date (set the next batch's date when the old pieces are gone).</p>`];
  for (const lv of [0, 1, 2, 3]) {
    const g = alerts.filter((l) => Expiry.level(l.expiry) === lv);
    if (g.length) out.push(`<div class="bold" style="color:${Expiry.color(lv)};margin:10px 0 4px">${Expiry.label(lv)} (${g.length})</div><div class="list">${g.map((l) => lotRow(l)).join('')}</div>`);
  }
  if (!alerts.length) out.push('<p class="green bold">Nothing expires within 3 months.</p>');
  if (later.length) out.push(`<div class="bold navy" style="margin:10px 0 4px">Later (${later.length})</div><div class="list">${later.map((l) => lotRow(l)).join('')}</div>`);
  if (noDate.length) out.push(`<div class="bold" style="color:#80868B;margin:10px 0 4px">No expiry date set (${noDate.length})</div><div class="list">${noDate.map((l) => lotRow(l)).join('')}</div>`);
  return out.join('');
}

// ---- QR code of the app's own address (to install it on another phone)
const appUrl = () => location.origin + location.pathname.replace(/index\.html$/, '');
function qrSvg(text) {
  try {
    const m = ZXing.QRCodeEncoder.encode(text, ZXing.QRCodeDecoderErrorCorrectionLevel.M).getMatrix();
    const n = m.getWidth(), q = 4;
    let path = '';
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (m.get(x, y) === 1) path += `M${x + q},${y + q}h1v1h-1z`;
    return `<svg id="qr" viewBox="0 0 ${n + 2 * q} ${n + 2 * q}" width="240" height="240" shape-rendering="crispEdges" style="background:#fff">` +
      `<path d="${path}" fill="#000"/></svg>`;
  } catch (e) { return `<p class="red">QR code not available: ${esc(e.message)}</p>`; }
}

// ---- dialogs
function dlg(title, body, acts) {
  return `<div class="dlg" role="dialog" aria-modal="true"><h2>${esc(title)}</h2><div class="body">${body}</div><div class="acts">${acts}</div></div>`;
}
const b = (act, text, cls = 'text', extra = '') => `<button class="btn ${cls}" data-act="${act}" ${extra}>${esc(text)}</button>`;
function factorPreview() {
  const p = $('#facPreview'); if (!p) return;
  const l = S.selectedLot, f = parseFactor($('#facValue').value);
  p.innerHTML = f == null ? '<span class="red">Not a valid factor</span>'
    : `Scanning 3 pieces → <b>${Csv.fmt(3 * f)} ${esc(l.unit)}</b> in the report` + (f < 1 ? ` · ${piecesOf(f)} pieces = 1 ${esc(l.unit)}` : '');
}
function dialogHtml() {
  if (!S.loaded) return '';
  if (S.showSessionPrompt) {
    const a = activeSession();
    if (a) {
      const lines = linesOf(a);
      return dlg('Issue session still open', esc(`${sessionTitle(a)}\nStarted ${fmtDayTime(a.started)} · ${lines.length} line(s), ${persons(lines)} person(s).\n\nContinue it, or end it and start a new one?`),
        b('promptNotNow', 'Not now') + b('promptNew', 'New session') + b('promptContinue', 'Continue', ''));
    }
    return dlg('Start an issue session?', 'No issue session is open. Start one to issue items.', b('promptNotNow', 'Not now') + b('promptNew', 'Start new session', ''));
  }
  if (S.showNewSession) {
    const a = activeSession();
    const d = new Date();
    return dlg('New issue session', `<div class="nowrap"><input type="text" id="sessName" value="${esc(`Bond issue ${pad(d.getDate())} ${MONTHS[d.getMonth()]}`)}" autocomplete="off">
      <div class="small" style="margin-top:6px">Number: ${esc(nextSessionId(S.sessions))}</div>${a ? `<div class="small red">${esc(sessionTitle(a))} will be ended.</div>` : ''}</div>`,
    b('newCancel', 'Cancel') + b('newStart', 'Start', ''));
  }
  const d = S.dialog;
  if (S.choice) {
    return dlg('Which one is it?', `<div class="nowrap">${S.choice.map((l) => `<div class="choice" data-act="choose" data-code="${esc(l.lotCode)}">${photoHtml(l.lotCode, 'ph96')}
      <div><div class="name">${esc(l.name)}</div>${l.storeName ? `<div class="tiny">ERP: ${esc(l.description)}</div>` : ''}<div class="navy bold">Port: ${esc(l.port)}</div>
      <div>${Csv.fmt(l.priceUsd)} USD</div>${expiryHtml(l.expiry, true)}</div></div>`).join('')}</div>`, b('choose', 'None of these', 'text', 'data-code=""'));
  }
  if (d) {
    switch (d.type) {
      case 'pickPerson':
        return dlg('Pick person (lost card)', `<div class="nowrap">${S.crew.map((p) => `<div class="person" data-act="pickPersonDo" data-code="${esc(p.code)}">${esc(p.code)}&nbsp; ${esc(p.name)}</div>`).join('')}</div>`,
          b('closeDlg', 'Close'));
      case 'reverse': {
        const i = S.issues.find((x) => x.id === d.id);
        return dlg('Reverse this line?', esc(`${Csv.fmt(i.qty)} × ${i.description} (${i.port})\nfor ${i.personName}\n\nA minus line is added to session ${i.sessionId}; the original stays in the log.`),
          b('closeDlg', 'Keep') + b('reverseDo', 'Reverse', ''));
      }
      case 'endSession': {
        const a = activeSession();
        return dlg(`End session ${a ? a.id : ''}?`, 'No more items can be added to it. Export it afterwards in Import / export.', b('closeDlg', 'Keep open') + b('endDo', 'End session', ''));
      }
      case 'restore':
        return dlg('Restore backup?', 'Crew, lots, issue log and photos on this phone will be replaced by the backup\'s copies.', b('closeDlg', 'Cancel') + b('restoreDo', 'Restore', ''));
      case 'expiry': {
        const l = S.selectedLot;
        const v = l.expiry || plusMonths(todayYmd(), 6);
        return dlg('Earliest expiry / best before', `<div class="nowrap"><input type="date" id="expDate" value="${v}"></div>`, b('closeDlg', 'Cancel') + b('expirySave', 'Save', ''));
      }
      case 'factor': {
        const l = S.selectedLot, u = esc(l.unit || 'unit');
        return dlg('Factor per scanned piece', `<div class="nowrap">
          <div class="small">One scan of this label = how many <b>${u}</b> in the bond report?</div>
          <label class="small" style="display:block;margin-top:10px">Pieces in one ${u} (e.g. 24 cans in a case)</label>
          <input type="text" id="facPieces" inputmode="decimal" autocomplete="off" value="${l.factor < 1 ? piecesOf(l.factor) : ''}">
          <label class="small" style="display:block;margin-top:10px">or Factor (${u} per piece, e.g. 1/24 or 0.041667)</label>
          <input type="text" id="facValue" inputmode="decimal" autocomplete="off" value="${factorText(l.factor)}">
          <div class="small" id="facPreview" style="margin-top:8px"></div>
          <div class="small orange" style="margin-top:8px">Only new scans use the new factor. Lines already issued keep theirs (reverse and scan again if they are wrong).${l.factorOnPhone ? `<br>Lots file value: ${factorText(l.fileFactor)}` : ''}</div></div>`,
          b('closeDlg', 'Cancel') + (l.factorOnPhone ? b('factorReset', 'Use lots file') : '') + b('factorSave', 'Save', ''));
      }
      case 'qr': {
        const url = appUrl();
        return dlg('Install on another phone', `<div class="nowrap" style="text-align:center">${qrSvg(url)}
          <div class="name" style="word-break:break-all;margin-top:8px">${esc(url)}</div>
          <p class="small" style="text-align:left">Scan with the phone's camera app and open the link.<br>iPhone: in <b>Safari</b> → Share → Add to Home Screen.<br>Android: in <b>Chrome</b> → ⋮ → Install app.<br>Each phone keeps its own data: give it its own Device letter.</p></div>`,
        b('closeDlg', 'Close', ''));
      }
      case 'file': {
        const share = canShareFiles();
        return dlg('File ready', `<div class="nowrap"><div class="name" style="word-break:break-all">${esc(d.name)}</div>
          <p class="small">${share ? 'Share → <b>Save to Files</b> (or AirDrop / Mail) to move it to the PC.' : 'Download saves it to this device\'s Downloads folder.'}</p></div>`,
        b('closeDlg', 'Cancel') + b('download', 'Download', share ? 'out' : '') + (share ? b('share', 'Share / Save to Files', '') : ''));
      }
      default: return '';
    }
  }
  if (S.showExpiryAlert) {
    const alerts = expiryAlerts();
    if (!alerts.length) { S.showExpiryAlert = false; return ''; }
    const parts = [0, 1, 2, 3].map((lv) => { const g = alerts.filter((l) => Expiry.level(l.expiry) === lv); return g.length ?
      `<div class="bold" style="color:${Expiry.color(lv)};margin:8px 0 4px">${Expiry.label(lv)} (${g.length})</div><div class="list">${g.map((l) => lotRow(l, 'alertOpenLot')).join('')}</div>` : ''; });
    return dlg('Expiry check', `<div class="nowrap">${parts.join('')}</div>`, b('alertList', 'Open list') + b('alertOk', 'OK', ''));
  }
  return '';
}

// ---- main render
let wakeLock = null;
async function setWake(on) {
  try {
    if (on && !wakeLock && navigator.wakeLock && document.visibilityState === 'visible') {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } else if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch (e) { /* not supported */ }
}
function render() {
  if (S.screen === 'LOT_DETAIL' && !S.selectedLot) S.screen = 'LOTS';
  $('#title').textContent = S.screen === 'LOT_DETAIL' ? S.selectedLot.lotCode : TITLES[S.screen];
  $('#back').hidden = S.screen === 'HOME';
  // Keep the camera element alive while the screen is redrawn.
  $('#camHolder').append(Cam.box);
  const main = $('#main');
  main.innerHTML = !S.loaded ? '<p class="pad">Loading…</p>' : ({
    HOME: homeHtml, ISSUE: issueHtml, HISTORY: historyHtml, LOTS: lotsHtml, LOT_DETAIL: lotDetailHtml,
    CREW: crewHtml, DATA: dataHtml, EXPIRY: expiryScreenHtml,
  })[S.screen]();
  const slot = $('#camSlot');
  // Frame shape: lot labels (wide strip) on Issue, product barcode EAN/UPC (3 : 2) when linking on Lot detail.
  Cam.box.classList.toggle('ean', S.screen === 'LOT_DETAIL' && !!S.waitingForEan);
  if (slot) { slot.append(Cam.box); Cam.start((c, captured) => onScan(c, !captured)); Cam.applyMode(); } else if (Cam.stream || Cam.onCode) Cam.stop();
  setWake(S.screen === 'ISSUE');
  const m = $('#modal');
  const html = dialogHtml();
  m.innerHTML = html; m.hidden = !html;
  hydratePhotos();
}
function go(screen) {
  if (screen === 'HISTORY') S.hist = { sessionId: activeSession()?.id || '', mode: 0, filter: '' };
  if (screen !== 'LOT_DETAIL') S.waitingForEan = false;
  if (screen === 'ISSUE' && S.loaded && !activeSession()) S.showNewSession = true;
  S.screen = screen;
  window.scrollTo(0, 0);
  render();
}
function back() { go(S.screen === 'LOT_DETAIL' ? 'LOTS' : 'HOME'); }

// ================================================================== actions
const ACT = {
  newSession() { S.showNewSession = true; render(); },
  endSession() { S.dialog = { type: 'endSession' }; render(); },
  endDo() { S.dialog = null; endSession(); render(); },
  toggleCam(el) { S.cameraOn = el.checked; render(); },
  manualEnter() { const v = $('#manual').value; S.manual = ''; $('#manual').value = ''; onScan(v, false); },
  pickPerson() { S.dialog = { type: 'pickPerson' }; render(); },
  pickPersonDo(el) { S.dialog = null; render(); onScan(el.dataset.code, false); },
  qty(el) { changeQty(el.dataset.code, Number(el.dataset.d)); },
  cancelIssue, confirmIssue,
  choose(el) { chooseLot(el.dataset.code); },
  closeDlg() { S.dialog = null; render(); },
  histMode(el) { S.hist.mode = Number(el.dataset.m); render(); },
  histClear() { S.hist.filter = ''; render(); },
  histPick(el) { S.hist.filter = el.dataset.v; S.hist.mode = 0; render(); },
  askReverse(el) { S.dialog = { type: 'reverse', id: el.dataset.id }; render(); },
  reverseDo() { const id = S.dialog.id; S.dialog = null; reverse(id); render(); },
  openLot(el) { const l = S.lots.find((x) => x.lotCode === el.dataset.code); if (l) openLot(l); },
  alertOpenLot(el) { S.showExpiryAlert = false; ACT.openLot(el); },
  alertOk() { S.showExpiryAlert = false; render(); },
  alertList() { S.showExpiryAlert = false; go('EXPIRY'); },
  photoCam() { pick('#fPhotoCam'); },
  photoLib() { pick('#fPhotoLib'); },
  saveStoreName() {
    const l = S.selectedLot, v = $('#storeName').value;
    if (v.trim() === l.storeName) return;
    repoSetStoreName(l.lotCode, v); reload(); ok(v.trim() ? 'Store name saved' : 'Store name cleared'); render();
  },
  askExpiry() { S.dialog = { type: 'expiry' }; render(); },
  askFactor() { S.dialog = { type: 'factor' }; render(); factorPreview(); },
  factorSave() {
    const l = S.selectedLot, f = parseFactor($('#facValue').value);
    if (f == null) { error('Enter a factor above 0, e.g. 1, 0.5 or 1/24'); return; }
    S.dialog = null;
    repoSetFactor(l.lotCode, fmtF(f) === fmtF(l.fileFactor) ? null : f);
    reload(); ok(`Factor for ${l.lotCode} set to ${factorText(f)} ${l.unit} per piece`); render();
  },
  factorReset() {
    const l = S.selectedLot;
    S.dialog = null; repoSetFactor(l.lotCode, null); reload();
    ok(`Factor back to the lots file value ${factorText(l.fileFactor)}`); render();
  },
  expirySave() {
    const v = $('#expDate').value;
    S.dialog = null;
    if (v) { repoSetExpiry(S.selectedLot.lotCode, v); reload(); ok('Expiry date set to ' + v); }
    render();
  },
  clearExpiry() { repoSetExpiry(S.selectedLot.lotCode, null); reload(); ok('Expiry date cleared'); render(); },
  linkEan() { S.waitingForEan = true; render(); },
  stopEan() { S.waitingForEan = false; render(); },
  unlinkEan() { repoSetEan(S.selectedLot.lotCode, null, false); reload(); ok('Product barcodes removed (codes from the lots file stay)'); render(); },
  promptNotNow() { S.showSessionPrompt = false; render(); },
  promptNew() { S.showSessionPrompt = false; S.showNewSession = true; render(); },
  promptContinue() { S.showSessionPrompt = false; go('ISSUE'); },
  newCancel() { S.showNewSession = false; render(); },
  newStart() { if (startSession($('#sessName').value)) go('ISSUE'); else render(); },
  importLots() { pick('#fLots'); },
  importCrew() { pick('#fCrew'); },
  exportSession(el) {
    const s = S.sessions.find((x) => x.id === el.dataset.id);
    const name = sessionFileName(s), lines = linesOf(s);
    offerFile(name, csvBlob(issuesExportText(lines)), () => { markExported(s.id, name); ok(`Exported ${lines.length} line(s) of ${s.id} as ${name}`); });
  },
  exportAll() {
    const n = S.issues.length;
    offerFile(`BOND_ALL_${stamp(Date.now(), '_')}.csv`, csvBlob(issuesExportText(S.issues)), () => ok(`Exported all ${n} line(s) (session export status not changed)`));
  },
  exportLots() { const n = S.lots.length; offerFile('lots.csv', csvBlob(lotsExportText()), () => ok(`Exported ${n} lots with store names and product barcodes`)); },
  async backup() {
    try {
      const blob = await backupZip();
      offerFile(`bondstore_backup_${stamp(Date.now(), '_')}.zip`, blob, () => { saveSetting('lastBackupTs', Date.now()); ok('Backup saved'); });
    } catch (e) { error('Backup failed: ' + e.message); }
  },
  restore() { pick('#fRestore'); },
  async restoreDo() {
    const f = S.dialog.file; S.dialog = null;
    try { const n = await restoreZip(f); reload(); ok(`Restored ${n} file(s)`); } catch (e) { error('Restore failed: ' + e.message); }
    render();
  },
  scanMode(el) { saveSetting('scanMode', el.dataset.m); render(); },
  capture() { Cam.capture(); },
  showQr() { S.dialog = { type: 'qr' }; render(); },
  share: shareFile,
  download: downloadFile,
};

function bindEvents() {
  document.addEventListener('click', (e) => {
    const g = e.target.closest('[data-go]');
    if (g) { go(g.dataset.go); return; }
    const a = e.target.closest('[data-act]');
    if (a && !a.disabled && ACT[a.dataset.act] && !(a.type === 'checkbox')) ACT[a.dataset.act](a, e);
  });
  document.addEventListener('change', (e) => {
    const t = e.target;
    if (t.matches('input[type=checkbox][data-act]')) ACT[t.dataset.act](t);
    else if (t.id === 'histSession') { S.hist.sessionId = t.value; $('#histList').innerHTML = histListHtml(); }
    else if (t.id === 'letter') { saveSetting('letter', t.value); render(); }
  });
  document.addEventListener('input', (e) => {
    const t = e.target;
    if (t.id === 'histFilter') { S.hist.filter = t.value; $('#histList').innerHTML = histListHtml(); }
    else if (t.id === 'lotsFilter') { S.lotsFilter = t.value; $('#lotsList').innerHTML = lotsListHtml(); hydratePhotos($('#lotsList')); }
    else if (t.id === 'manual') S.manual = t.value;
    else if (t.id === 'facPieces') { const n = parseFactor(t.value); if (n) $('#facValue').value = Number.isInteger(n) ? `1/${n}` : fmtF(1 / n); factorPreview(); }
    else if (t.id === 'facValue') { const f = parseFactor(t.value); $('#facPieces').value = f && f < 1 ? piecesOf(f) : ''; factorPreview(); }
  });
  // Enter in the code field and in dialogs
  document.addEventListener('keydown', (e) => {
    const t = e.target;
    if (e.key !== 'Enter') return;
    if (t.id === 'manual') { e.preventDefault(); ACT.manualEnter(); }
    else if (t.id === 'sessName') { e.preventDefault(); ACT.newStart(); }
    else if (t.id === 'storeName') { e.preventDefault(); ACT.saveStoreName(); t.blur(); }
    else if (t.id === 'facValue' || t.id === 'facPieces') { e.preventDefault(); ACT.factorSave(); }
  });
  $('#back').addEventListener('click', back);
  $('#msg').addEventListener('click', () => { $('#msg').hidden = true; });

  // Bluetooth / USB barcode scanners type the code like a keyboard and press Enter (or Tab).
  let buf = '';
  window.addEventListener('keydown', (e) => {
    const t = document.activeElement;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'Enter' || e.key === 'Tab') {
      if (buf) { e.preventDefault(); const code = buf; buf = ''; onScan(code, false); }
      return;
    }
    if (e.key.length === 1) { buf += e.key; e.preventDefault(); }
  }, true);

  // Sound needs one tap before it can play on iPhone.
  document.addEventListener('pointerdown', () => {
    try { audio = audio || new (window.AudioContext || window.webkitAudioContext)(); if (audio.state === 'suspended') audio.resume(); } catch (e) { /* */ }
  }, { once: true });

  // "Opened" = first start, or back after more than 10 minutes away (camera / file picker trips don't count).
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      S.backgroundSince = Date.now();
      if (Cam.stream) { Cam.stream.getTracks().forEach((t) => t.stop()); Cam.stream = null; }
    } else {
      if (S.backgroundSince && Date.now() - S.backgroundSince > 10 * 60000) { S.showSessionPrompt = true; S.showExpiryAlert = true; }
      S.backgroundSince = 0;
      wakeLock = null;
      render();
    }
  });
}

// ================================================================== start
async function main() {
  Cam.init();
  bindEvents();
  bindFileInputs();
  try {
    await DB.open();
    Object.assign(F, await DB.all('files'));
    const st = await DB.all('settings');
    Object.assign(S.settings, st);
    photoKeys = new Set(await DB.keys('photos'));
  } catch (e) {
    $('#main').innerHTML = `<p class="pad red">Storage is not available: ${esc(e.message)}.<br>Private browsing blocks it – open the app normally.</p>`;
    return;
  }
  reload();
  S.loaded = true;
  S.showSessionPrompt = true; S.showExpiryAlert = true;
  render();
  try {
    if (navigator.storage?.persist) S.persisted = (await navigator.storage.persisted()) || (await navigator.storage.persist());
  } catch (e) { /* */ }
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
    let first = !navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (first) { first = false; return; }
      showMsg('A new version of the app was installed. Close and reopen the app to use it.', false);
    });
  }
}
main();
