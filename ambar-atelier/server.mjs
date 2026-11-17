// Âmbar — Atelier de Beleza · web server + booking API
// Zero dependencies. Node 20+.  Run:  node server.mjs   (see README.md for env vars)
import { createServer } from 'node:http';
import { readFile, writeFile, rename, mkdir, stat } from 'node:fs/promises';
import { extname, join, normalize, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { gzipSync, brotliCompressSync, constants as zc } from 'node:zlib';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(ROOT, 'public');
const DATA = process.env.DATA_DIR || join(ROOT, 'data');
const PORT = Number(process.env.PORT) || 5174;
const HOST = process.env.HOST || '0.0.0.0';
const env = k => (process.env[k] || '').trim();

/* =========================================================
   Catalogue — the single source of truth for services.
   Names must match the values of the booking form's radios.
   ========================================================= */
const TEAM = ['Inês Valadares', 'Beatriz Lemos', 'Marta Sequeira', 'Sofia Antunes'];
const SERVICES = {
  'Corte & Brushing':              { min: 60,  price: 'desde 55 €',  pros: ['Inês Valadares', 'Beatriz Lemos'] },
  'Coloração Integral':            { min: 90,  price: 'desde 75 €',  pros: ['Inês Valadares', 'Beatriz Lemos'] },
  'Balayage Âmbar':                { min: 180, price: 'desde 160 €', pros: ['Beatriz Lemos', 'Inês Valadares'] },
  'Facial Luminosidade':           { min: 90,  price: '110 €',       pros: ['Marta Sequeira'] },
  'Lifting & Tinta de Pestanas':   { min: 60,  price: '65 €',        pros: ['Marta Sequeira'] },
  'Manicure Semipermanente':       { min: 60,  price: '35 €',        pros: ['Sofia Antunes'] },
  'Pedicure Spa':                  { min: 75,  price: '48 €',        pros: ['Sofia Antunes'] },
  'Maquilhagem Social':            { min: 60,  price: '70 €',        pros: ['Sofia Antunes', 'Marta Sequeira'] },
  'Consulta (não tenho a certeza)': { min: 20,  price: 'Gratuita',    pros: TEAM }
};
// Opening hours in Lisbon time, minutes from midnight. 0 = Sunday.
const HOURS = { 2: [600, 1200], 3: [600, 1200], 4: [600, 1200], 5: [600, 1200], 6: [540, 1140] };
const SLOT_STEP = 30;          // minutes between start times
const LEAD_MIN = 60;           // earliest same-day start: now + 60 min
const WINDOW_DAYS = 90;        // how far ahead people can book
const ACTIVE = new Set(['pending', 'confirmed']);

/* ---------- Lisbon calendar helpers ---------- */
const pad = n => String(n).padStart(2, '0');
const hhmm = m => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
const isoOf = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;

function lisbonNow() {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Lisbon', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(new Date()).map(x => [x.type, x.value]));
  return { iso: `${p.year}-${p.month}-${p.day}`, minutes: (Number(p.hour) % 24) * 60 + Number(p.minute) };
}
function parseISO(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso || '')) return null;
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? dt : null;
}
const addDays = (dt, n) => new Date(dt.getTime() + n * 864e5);
const isoUTC = dt => isoOf(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());

// Portuguese national holidays + Lisbon's Santo António (13 June)
function easter(y) { // Anonymous Gregorian algorithm
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(y, month - 1, day));
}
const holidayCache = new Map();
function holidays(y) {
  if (holidayCache.has(y)) return holidayCache.get(y);
  const fixed = { '01-01': 'Ano Novo', '04-25': 'Dia da Liberdade', '05-01': 'Dia do Trabalhador', '06-10': 'Dia de Portugal',
    '06-13': 'Santo António', '08-15': 'Assunção de Nossa Senhora', '10-05': 'Implantação da República',
    '11-01': 'Dia de Todos-os-Santos', '12-01': 'Restauração da Independência', '12-08': 'Imaculada Conceição', '12-25': 'Natal' };
  const map = new Map(Object.entries(fixed).map(([md, n]) => [`${y}-${md}`, n]));
  const e = easter(y);
  map.set(isoUTC(addDays(e, -2)), 'Sexta-feira Santa');
  map.set(isoUTC(e), 'Páscoa');
  map.set(isoUTC(addDays(e, 60)), 'Corpo de Deus');
  holidayCache.set(y, map);
  return map;
}

/* =========================================================
   Storage — JSON files, atomic writes, one writer at a time
   ========================================================= */
let queue = Promise.resolve();
const serial = fn => (queue = queue.then(fn, fn));
async function readJSON(name, fallback) {
  try { return JSON.parse(await readFile(join(DATA, name), 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
}
async function writeJSON(name, value) {
  await mkdir(DATA, { recursive: true });
  const file = join(DATA, name), tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2));
  await rename(tmp, file);
}
const extraClosures = () => readJSON('closures.json', []); // e.g. ["2026-08-10", "2026-08-11"] for holidays/training

/* =========================================================
   Availability
   ========================================================= */
async function dayInfo(iso) {
  const dt = parseISO(iso);
  if (!dt) return { closed: 'Data inválida.' };
  const now = lisbonNow();
  const today = parseISO(now.iso);
  if (dt < today) return { closed: 'Essa data já passou.' };
  if (dt > addDays(today, WINDOW_DAYS)) return { closed: `Aceitamos marcações até ${WINDOW_DAYS} dias de antecedência.` };
  const hours = HOURS[dt.getUTCDay()];
  if (!hours) return { closed: 'Estamos encerrados ao domingo e à segunda-feira.' };
  const hol = holidays(dt.getUTCFullYear()).get(iso);
  if (hol) return { closed: `Feriado (${hol}) — o atelier está encerrado.` };
  if ((await extraClosures()).includes(iso)) return { closed: 'O atelier está encerrado neste dia.' };
  return { hours, earliest: iso === now.iso ? now.minutes + LEAD_MIN : 0 };
}

function freePros(bookings, iso, start, end, candidates) {
  const busy = new Set(bookings
    .filter(b => b.date === iso && ACTIVE.has(b.status) && b.start < end && start < b.end)
    .map(b => b.assignedPro));
  return candidates.filter(p => !busy.has(p));
}

async function availability(iso, serviceName, pro) {
  const svc = SERVICES[serviceName];
  if (!svc) return { error: 'Serviço desconhecido.' };
  if (pro && !svc.pros.includes(pro)) return { error: `${pro} não realiza este serviço.` };
  const info = await dayInfo(iso);
  if (info.closed) return { closed: info.closed, slots: [] };
  const bookings = await readJSON('bookings.json', []);
  const candidates = pro ? [pro] : svc.pros;
  const [open, close] = info.hours;
  const slots = [];
  for (let m = open; m + svc.min <= close; m += SLOT_STEP) {
    const ok = m >= info.earliest && freePros(bookings, iso, m, m + svc.min, candidates).length > 0;
    slots.push({ time: hhmm(m), available: ok });
  }
  return { slots };
}

/* =========================================================
   Validation
   ========================================================= */
const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, max);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE = /^\+?[\d\s()-]{9,20}$/;

function validateBooking(body) {
  const v = {
    service: clean(body.service, 80), pro: clean(body.pro, 60), date: clean(body.date, 10), time: clean(body.time, 5),
    name: clean(body.name, 80), phone: clean(body.phone, 30), email: clean(body.email, 120).toLowerCase(),
    notes: clean(body.notes, 600), consent: body.consent === true || body.consent === 'on'
  };
  if (v.pro === 'Sem preferência') v.pro = '';
  const errors = {};
  if (!SERVICES[v.service]) errors.service = 'Escolha um serviço para continuar.';
  else if (v.pro && !SERVICES[v.service].pros.includes(v.pro)) errors.pro = 'Essa profissional não realiza este serviço.';
  if (!parseISO(v.date)) errors.date = 'Escolha uma data.';
  if (!/^\d{2}:\d{2}$/.test(v.time)) errors.time = 'Escolha uma hora disponível.';
  if (v.name.length < 2) errors.name = 'Indique o seu nome.';
  if (!PHONE.test(v.phone)) errors.phone = 'Indique um número válido, por exemplo +351 912 345 678.';
  if (!EMAIL.test(v.email)) errors.email = 'Indique um email válido, por exemplo nome@email.pt.';
  if (!v.consent) errors.consent = 'Precisamos da sua autorização para tratar a marcação.';
  return { v, errors };
}

/* =========================================================
   Notifications — Resend (email) and/or a webhook. Optional.
   ========================================================= */
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const longDate = iso => new Intl.DateTimeFormat('pt-PT', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(parseISO(iso));
const emailEnabled = () => Boolean(env('RESEND_API_KEY') && env('MAIL_FROM'));

async function sendEmail(to, subject, html) {
  if (!emailEnabled() || !to) return false;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env('RESEND_API_KEY')}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: env('MAIL_FROM'), to: [to], subject, html, reply_to: env('SALON_EMAIL') || undefined })
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
  return true;
}
const mailShell = (title, rows, foot) => `<div style="font-family:Georgia,serif;background:#F6F1E9;padding:32px;color:#2A211B">
  <p style="font-size:26px;margin:0 0 4px">Âmbar</p><p style="font:12px Arial,sans-serif;letter-spacing:.2em;text-transform:uppercase;color:#7A5E33;margin:0 0 24px">Atelier de Beleza · Lisboa</p>
  <h1 style="font-weight:400;font-size:24px">${title}</h1>
  <table style="font:15px Arial,sans-serif;border-collapse:collapse">${rows.map(([k, v]) => `<tr><td style="padding:6px 24px 6px 0;color:#5F5349">${esc(k)}</td><td style="padding:6px 0">${esc(v)}</td></tr>`).join('')}</table>
  <p style="font:14px/1.6 Arial,sans-serif;color:#5F5349;margin-top:24px">${foot}</p></div>`;
const bookingRows = b => [['Referência', b.ref], ['Serviço', b.service], ['Profissional', b.assignedPro], ['Data', longDate(b.date)], ['Hora', hhmm(b.start)], ['Duração', `${b.end - b.start} min`], ['Estimativa', b.price]];

function notifyNew(b) {
  const jobs = [];
  if (emailEnabled()) {
    jobs.push(sendEmail(b.email, `Recebemos o seu pedido · ${b.ref}`, mailShell(`Olá ${esc(b.name.split(' ')[0])}, recebemos o seu pedido.`,
      bookingRows(b), 'Vamos confirmar por mensagem em menos de duas horas, dentro do horário do atelier. Cancelamento gratuito até 24 horas antes.<br>Rua da Escola Politécnica, 00 — 2.º, 1250-000 Lisboa · +351 210 000 000')));
    if (env('SALON_EMAIL')) jobs.push(sendEmail(env('SALON_EMAIL'), `Nova marcação · ${b.service} · ${b.date} ${hhmm(b.start)}`,
      mailShell('Novo pedido de marcação', [...bookingRows(b), ['Nome', b.name], ['Telemóvel', b.phone], ['Email', b.email], ['Notas', b.notes || '—']], 'Confirme ou cancele no painel /admin.')));
  }
  if (env('BOOKING_WEBHOOK_URL')) jobs.push(fetch(env('BOOKING_WEBHOOK_URL'), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event: 'booking.created', booking: b })
  }).then(r => { if (!r.ok) throw new Error(`Webhook ${r.status}`); }));
  Promise.allSettled(jobs).then(rs => rs.forEach(r => r.status === 'rejected' && console.error('[notify]', r.reason?.message || r.reason)));
}
function notifyStatus(b) {
  if (b.status === 'confirmed') sendEmail(b.email, `Marcação confirmada · ${b.ref}`, mailShell('A sua visita está confirmada.', bookingRows(b),
    'Até breve. Se precisar de alterar, responda a este email ou ligue +351 210 000 000 (sem custos até 24 horas antes).')).catch(e => console.error('[notify]', e.message));
  if (b.status === 'cancelled') sendEmail(b.email, `Marcação cancelada · ${b.ref}`, mailShell('A sua marcação foi cancelada.', bookingRows(b),
    'Se não pediu este cancelamento, contacte-nos: +351 210 000 000.')).catch(e => console.error('[notify]', e.message));
}

/* =========================================================
   HTTP plumbing
   ========================================================= */
const rate = new Map();
function limited(ip, key, max, windowMs) {
  const k = `${key}:${ip}`, now = Date.now();
  const hits = (rate.get(k) || []).filter(t => now - t < windowMs);
  hits.push(now); rate.set(k, hits);
  return hits.length > max;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of rate) if (!v.some(t => now - t < 36e5)) rate.delete(k); }, 6e5).unref();

const clientIp = req => (env('TRUST_PROXY') ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() : '') || req.socket.remoteAddress || '';
function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}
async function readBody(req, limit = 16 * 1024) {
  if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) throw Object.assign(new Error('JSON esperado.'), { status: 415 });
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > limit) throw Object.assign(new Error('Pedido demasiado grande.'), { status: 413 }); chunks.push(c); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
  catch { throw Object.assign(new Error('JSON inválido.'), { status: 400 }); }
}
// Reject cross-site form posts (CSRF): browsers always send Origin on POST.
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}

const securityHeaders = (extra = {}) => ({
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
  ...(env('HTTPS') ? { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' } : {}),
  ...extra
});

/* ---------- Static files (from /public only) ---------- */
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.avif': 'image/avif',
  '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml'
};
const COMPRESSIBLE = new Set(['.html', '.css', '.js', '.svg', '.json', '.txt', '.xml']);
const fileCache = new Map(); // path -> { mtime, raw, gz, br, etag, csp }

function cspFor(html) {
  // Hash every inline executable script so CSP can forbid all other inline JS.
  const hashes = [...html.matchAll(/<script(?![^>]*type="application\/ld\+json")(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)]
    .map(m => `'sha256-${createHash('sha256').update(m[1]).digest('base64')}'`);
  return [
    "default-src 'self'", `script-src 'self' ${hashes.join(' ')}`.trim(), "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https://images.unsplash.com", "font-src 'self'", "connect-src 'self'",
    'frame-src https://www.openstreetmap.org', "frame-ancestors 'none'", "base-uri 'self'", "form-action 'self'", "object-src 'none'"
  ].join('; ');
}
function buildEntry(raw, ext) {
  const entry = { raw, etag: `"${createHash('sha1').update(raw).digest('base64url').slice(0, 20)}"` };
  if (COMPRESSIBLE.has(ext)) {
    entry.br = brotliCompressSync(raw, { params: { [zc.BROTLI_PARAM_QUALITY]: 11 } });
    entry.gz = gzipSync(raw, { level: 9 });
  }
  return entry;
}
// Cache-busting: HTML references to styles.css / main.js get ?v=<content hash>,
// so those files can be cached for a year and still update the moment they change.
const VERSIONED = ['styles.css', 'main.js'];
async function assetVersions() {
  const v = {};
  for (const f of VERSIONED) { try { v[f] = (await loadFile(join(PUBLIC, f))).etag.slice(1, 11); } catch { /* missing asset */ } }
  return v;
}
async function loadFile(file) {
  const st = await stat(file);
  if (!st.isFile()) throw Object.assign(new Error('not file'), { code: 'ENOENT' });
  const ext = extname(file);
  const versions = ext === '.html' ? await assetVersions() : null;
  const vkey = versions ? JSON.stringify(versions) : '';
  const hit = fileCache.get(file);
  if (hit && hit.mtime === st.mtimeMs && hit.vkey === vkey) return hit;
  let raw = await readFile(file);
  if (versions) {
    raw = Buffer.from(raw.toString('utf8').replace(/(href|src)="(\/?)(styles\.css|main\.js)"/g,
      (m, attr, slash, f) => versions[f] ? `${attr}="${slash}${f}?v=${versions[f]}"` : m));
  }
  const entry = { ...buildEntry(raw, ext), mtime: st.mtimeMs, vkey };
  if (ext === '.html') entry.csp = cspFor(raw.toString('utf8'));
  fileCache.set(file, entry);
  return entry;
}
async function resolveStatic(pathname) {
  const candidates = pathname.endsWith('/') ? [pathname + 'index.html'] : extname(pathname) ? [pathname] : [pathname + '.html', pathname + '/index.html'];
  for (const p of candidates) {
    const file = normalize(join(PUBLIC, p));
    if (!file.startsWith(PUBLIC + sep)) return null;
    try { return { file, entry: await loadFile(file) }; } catch (e) { if (e.code !== 'ENOENT' && e.code !== 'EISDIR') throw e; }
  }
  return null;
}
function cacheControl(ext, versioned) {
  if (versioned || ext === '.woff2') return 'public, max-age=31536000, immutable'; // fonts: rename the file if it ever changes
  if (ext === '.woff2' || ['.png', '.jpg', '.webp', '.avif', '.ico'].includes(ext)) return 'public, max-age=2592000';
  return 'no-cache'; // html and unversioned css/js: always revalidate (cheap 304 via ETag)
}
async function serveStatic(req, res, pathname, search = '') {
  let found = await resolveStatic(pathname);
  let status = 200;
  if (!found) { found = await resolveStatic('/404.html'); status = 404; }
  if (!found) { res.writeHead(404, securityHeaders({ 'Content-Type': 'text/plain; charset=utf-8' })).end('Não encontrado'); return; }
  const { file, entry } = found, ext = extname(file);
  const headers = securityHeaders({ 'Content-Type': TYPES[ext] || 'application/octet-stream', 'Cache-Control': cacheControl(ext, status === 200 && /[?&]v=/.test(search)), ETag: entry.etag, Vary: 'Accept-Encoding' });
  if (entry.csp) headers['Content-Security-Policy'] = entry.csp;
  if (status === 200 && req.headers['if-none-match'] === entry.etag) { res.writeHead(304, headers).end(); return; }
  let body = entry.raw;
  const ae = String(req.headers['accept-encoding'] || '');
  if (entry.br && /\bbr\b/.test(ae)) { body = entry.br; headers['Content-Encoding'] = 'br'; }
  else if (entry.gz && /\bgzip\b/.test(ae)) { body = entry.gz; headers['Content-Encoding'] = 'gzip'; }
  headers['Content-Length'] = body.length;
  res.writeHead(status, headers);
  res.end(req.method === 'HEAD' ? undefined : body);
}

/* ---------- Admin (Basic auth, enabled only when ADMIN_PASSWORD is set) ---------- */
function authorised(req) {
  const pass = env('ADMIN_PASSWORD');
  if (!pass) return false;
  const [scheme, token] = String(req.headers.authorization || '').split(' ');
  if (scheme !== 'Basic' || !token) return false;
  const given = Buffer.from(Buffer.from(token, 'base64').toString('utf8'));
  const want = Buffer.from(`atelier:${pass}`);
  return given.length === want.length && timingSafeEqual(given, want);
}
const STATUS_PT = { pending: 'Por confirmar', confirmed: 'Confirmada', cancelled: 'Cancelada' };
async function adminPage(res) {
  const today = lisbonNow().iso;
  const list = (await readJSON('bookings.json', [])).filter(b => b.date >= today).sort((a, b) => (a.date + hhmm(a.start)).localeCompare(b.date + hhmm(b.start)));
  const rows = list.map(b => `<tr class="s-${b.status}"><td>${esc(b.date)}<br><b>${hhmm(b.start)}–${hhmm(b.end)}</b></td>
    <td><b>${esc(b.service)}</b><br>${esc(b.assignedPro)}${b.pro ? '' : ' <small>(atribuída)</small>'}</td>
    <td>${esc(b.name)}<br><a href="tel:${esc(b.phone.replace(/\s/g, ''))}">${esc(b.phone)}</a><br><a href="mailto:${esc(b.email)}">${esc(b.email)}</a></td>
    <td>${esc(b.notes || '—')}</td><td>${esc(b.ref)}<br><span class="tag">${STATUS_PT[b.status]}</span></td>
    <td>${b.status !== 'confirmed' && b.status !== 'cancelled' ? `<form method="post" action="/admin/bookings/${esc(b.id)}"><button name="status" value="confirmed">Confirmar</button></form>` : ''}
    ${b.status !== 'cancelled' ? `<form method="post" action="/admin/bookings/${esc(b.id)}" onsubmit="return confirm('Cancelar esta marcação?')"><button name="status" value="cancelled" class="ghost">Cancelar</button></form>` : ''}</td></tr>`).join('');
  const html = `<!doctype html><html lang="pt-PT"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>Marcações · Âmbar</title><style>body{font:15px/1.5 system-ui,sans-serif;background:#F6F1E9;color:#2A211B;margin:0;padding:24px}h1{font:300 32px Georgia,serif;margin:0 0 4px}
p{color:#5F5349}table{width:100%;border-collapse:collapse;background:#fff}td,th{padding:12px;border-bottom:1px solid #e6dccd;text-align:left;vertical-align:top}th{font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#7A5E33}
.s-cancelled{opacity:.45}.tag{font-size:12px;padding:2px 8px;border-radius:99px;background:#EDE5D8}.s-confirmed .tag{background:#2A211B;color:#F6F1E9}
button{font:inherit;padding:6px 12px;margin:2px 0;border-radius:99px;border:1px solid #2A211B;background:#2A211B;color:#F6F1E9;cursor:pointer}.ghost{background:none;color:#2A211B}
.wrap{overflow-x:auto}</style><h1>Marcações</h1><p>${list.length} marcações a partir de hoje · horário de Lisboa</p>
<div class="wrap"><table><thead><tr><th>Quando</th><th>Serviço</th><th>Cliente</th><th>Notas</th><th>Estado</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan="6">Sem marcações.</td></tr>'}</tbody></table></div></html>`;
  res.writeHead(200, securityHeaders({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src-attr 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'" }));
  res.end(html);
}
async function readForm(req) {
  let s = ''; for await (const c of req) { s += c; if (s.length > 2048) break; }
  return Object.fromEntries(new URLSearchParams(s));
}

/* =========================================================
   Routes
   ========================================================= */
async function route(req, res) {
  const url = new URL(req.url, 'http://local');
  const path = decodeURIComponent(url.pathname);
  const ip = clientIp(req);

  if (path === '/api/services' && req.method === 'GET') {
    return json(res, 200, { services: Object.fromEntries(Object.entries(SERVICES).map(([n, s]) => [n, { minutes: s.min, price: s.price, pros: s.pros }])) });
  }

  if (path === '/api/availability' && req.method === 'GET') {
    if (limited(ip, 'avail', 120, 6e4)) return json(res, 429, { error: 'Demasiados pedidos. Tente daqui a um minuto.' });
    const pro = url.searchParams.get('pro');
    const r = await availability(url.searchParams.get('date'), url.searchParams.get('service'), pro && pro !== 'Sem preferência' ? pro : '');
    return json(res, r.error ? 400 : 200, r);
  }

  if (path === '/api/bookings' && req.method === 'POST') {
    if (!sameOrigin(req)) return json(res, 403, { error: 'Origem não permitida.' });
    if (limited(ip, 'book', 10, 15 * 6e4)) return json(res, 429, { error: 'Recebemos vários pedidos seguidos. Tente daqui a alguns minutos ou ligue +351 210 000 000.' });
    const body = await readBody(req);
    if (clean(body.website, 200)) return json(res, 201, { ref: 'AMB-' + randomBytes(3).toString('hex').toUpperCase() }); // honeypot: pretend success
    const { v, errors } = validateBooking(body);
    if (Object.keys(errors).length) return json(res, 422, { errors });
    const svc = SERVICES[v.service];
    const start = Number(v.time.slice(0, 2)) * 60 + Number(v.time.slice(3));
    // Re-check and save inside the queue so two people can't take the same slot.
    return serial(async () => {
      const info = await dayInfo(v.date);
      if (info.closed) return json(res, 422, { errors: { date: info.closed } });
      const [open, close] = info.hours;
      const end = start + svc.min;
      if ((start - open) % SLOT_STEP || start < open || end > close || start < info.earliest) return json(res, 422, { errors: { time: 'Essa hora não está disponível. Escolha outra.' } });
      const bookings = await readJSON('bookings.json', []);
      const free = freePros(bookings, v.date, start, end, v.pro ? [v.pro] : svc.pros);
      if (!free.length) return json(res, 409, { errors: { time: 'Esse horário acabou de ser reservado. Escolha outro, por favor.' } });
      const b = {
        id: randomBytes(8).toString('hex'), ref: 'AMB-' + randomBytes(3).toString('hex').toUpperCase(), status: 'pending',
        service: v.service, price: svc.price, pro: v.pro, assignedPro: free[0], date: v.date, start, end,
        name: v.name, phone: v.phone, email: v.email, notes: v.notes, consentAt: new Date().toISOString(), createdAt: new Date().toISOString()
      };
      bookings.push(b);
      await writeJSON('bookings.json', bookings);
      console.log(`[booking] ${b.ref} ${b.service} ${b.date} ${hhmm(b.start)} → ${b.assignedPro}`);
      notifyNew(b);
      json(res, 201, { ref: b.ref, service: b.service, date: b.date, time: hhmm(b.start), pro: b.assignedPro, emailed: emailEnabled() });
    });
  }

  if (path === '/api/newsletter' && req.method === 'POST') {
    if (!sameOrigin(req)) return json(res, 403, { error: 'Origem não permitida.' });
    if (limited(ip, 'nl', 5, 15 * 6e4)) return json(res, 429, { error: 'Tente daqui a alguns minutos.' });
    const body = await readBody(req, 2048);
    const email = clean(body.email, 120).toLowerCase();
    if (!EMAIL.test(email)) return json(res, 422, { error: 'Verifique o email, por favor.' });
    if (clean(body.website, 200)) return json(res, 201, { ok: true });
    await serial(async () => {
      const subs = await readJSON('subscribers.json', []);
      if (!subs.some(s => s.email === email)) { subs.push({ email, consentAt: new Date().toISOString() }); await writeJSON('subscribers.json', subs); }
    });
    return json(res, 201, { ok: true });
  }

  if (path === '/admin' || path.startsWith('/admin/')) {
    if (!env('ADMIN_PASSWORD')) { res.writeHead(404).end(); return; }
    if (!authorised(req)) { res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Âmbar", charset="UTF-8"' }).end('Autenticação necessária'); return; }
    const m = path.match(/^\/admin\/bookings\/([a-f0-9]{16})$/);
    if (m && req.method === 'POST') {
      if (!sameOrigin(req)) { res.writeHead(403).end(); return; }
      const { status } = await readForm(req);
      if (!['confirmed', 'cancelled'].includes(status)) { res.writeHead(400).end(); return; }
      await serial(async () => {
        const list = await readJSON('bookings.json', []);
        const b = list.find(x => x.id === m[1]);
        if (b && b.status !== status) { b.status = status; b.updatedAt = new Date().toISOString(); await writeJSON('bookings.json', list); notifyStatus(b); }
      });
      res.writeHead(303, { Location: '/admin' }).end(); return;
    }
    if (path === '/admin' && req.method === 'GET') return adminPage(res);
    res.writeHead(404).end(); return;
  }

  if (path.startsWith('/api/')) return json(res, 404, { error: 'Não encontrado.' });
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD' }).end(); return; }
  return serveStatic(req, res, path, url.search);
}

createServer((req, res) => {
  route(req, res).catch(err => {
    if (err.status) return json(res, err.status, { error: err.message });
    console.error(err);
    if (!res.headersSent) json(res, 500, { error: 'Erro inesperado. Tente novamente ou ligue +351 210 000 000.' });
  });
}).listen(PORT, HOST, () => {
  console.log(`Âmbar on http://localhost:${PORT}`);
  console.log(`  email: ${emailEnabled() ? 'Resend' : 'off'} · webhook: ${env('BOOKING_WEBHOOK_URL') ? 'on' : 'off'} · admin: ${env('ADMIN_PASSWORD') ? '/admin' : 'off (set ADMIN_PASSWORD)'}`);
});
