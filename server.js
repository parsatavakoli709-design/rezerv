'use strict';
const fs = require('fs');
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const Database = require('better-sqlite3');

/* ---------- تنظیمات ---------- */
const PORT = process.env.PORT || 3000;
const TZ = 'Asia/Tehran';
const CAPACITY = 20;                 // ظرفیت اولیه هر روز
const OPEN_MIN = 7 * 60 + 30;        // 07:30
const CLOSE_MIN = 13 * 60 + 40;      // 13:40
const GRADES = ['دهم', 'یازدهم', 'دوازدهم'];
const FIELDS = ['شبکه', 'مکانیک', 'گرافیک', 'حسابداری', 'نقشه کشی'];
const LETTERS = 'آابپتثجچحخدذرزژسشصضطظعغفقکگلمنوهیءئؤأإة\\u200c';
const NAME_RE = new RegExp(`^[${LETTERS}]+(?: [${LETTERS}]+)*$`);

/* ---------- زمان (ساعت ایران + تقویم شمسی) ---------- */
function tehranParts(d = new Date()) {
  const o = {};
  new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(d).forEach((p) => (o[p.type] = p.value));
  return o;
}
const todayKey = () => { const p = tehranParts(); return `${p.year}-${p.month}-${p.day}`; };
const addDays = (key, n) => {
  const d = new Date(`${key}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const faDate = (key) => {
  const o = {};
  new Intl.DateTimeFormat('fa-IR-u-ca-persian', {
    timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  }).formatToParts(new Date(`${key}T12:00:00Z`)).forEach((p) => (o[p.type] = p.value));
  return `${o.weekday} ${o.day} ${o.month} ${o.year}`;
};
function windowState() {
  const p = tehranParts();
  const m = Number(p.hour) * 60 + Number(p.minute);
  return m < OPEN_MIN ? 'before' : m > CLOSE_MIN ? 'after' : 'open';
}
const dateForDay = (day) => (day === 'tomorrow' ? addDays(todayKey(), 1) : todayKey());

/* ---------- دیتابیس ---------- */
const dbPath = process.env.DB_PATH || path.join(__dirname, 'data', 'buffet.db');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');
db.exec(`
  CREATE TABLE IF NOT EXISTS day_capacity (
    reservation_date TEXT PRIMARY KEY,
    capacity INTEGER NOT NULL DEFAULT ${CAPACITY} CHECK (capacity >= 0)
  );
  CREATE TABLE IF NOT EXISTS reservations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    first_name TEXT NOT NULL,
    last_name TEXT NOT NULL,
    grade TEXT NOT NULL CHECK (grade IN (${GRADES.map((g) => `'${g}'`).join(',')})),
    field TEXT NOT NULL CHECK (field IN (${FIELDS.map((f) => `'${f}'`).join(',')})),
    reservation_date TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (reservation_date, first_name, last_name)
  );
  CREATE INDEX IF NOT EXISTS idx_res_date ON reservations (reservation_date);
`);
const q = {
  ensureDay: db.prepare('INSERT OR IGNORE INTO day_capacity (reservation_date, capacity) VALUES (?, ?)'),
  capacity: db.prepare('SELECT capacity FROM day_capacity WHERE reservation_date = ?'),
  count: db.prepare('SELECT COUNT(*) AS n FROM reservations WHERE reservation_date = ?'),
  dup: db.prepare('SELECT 1 FROM reservations WHERE reservation_date = ? AND REPLACE(first_name, char(8204), \'\') = ? AND REPLACE(last_name, char(8204), \'\') = ?'),
  insert: db.prepare('INSERT INTO reservations (first_name, last_name, grade, field, reservation_date) VALUES (?, ?, ?, ?, ?)'),
  list: db.prepare('SELECT first_name, last_name, grade, field FROM reservations WHERE reservation_date = ? ORDER BY id'),
};

const noZw = (x) => x.replace(/\u200c/g, '');

function dayStatus(date) {
  q.ensureDay.run(date, CAPACITY);
  const capacity = q.capacity.get(date).capacity;
  const booked = q.count.get(date).n;
  return { date, dateFa: faDate(date), capacity, booked, remaining: Math.max(capacity - booked, 0) };
}

/* رزرو اتمیک: کل بررسی ظرفیت + درج داخل یک تراکنش IMMEDIATE (قفل نوشتن) */
const reserveTx = db.transaction((date, v) => {
  const s = dayStatus(date);
  if (q.dup.get(date, noZw(v.first_name), noZw(v.last_name))) return { error: 'DUP' };
  if (s.remaining <= 0) return { error: 'FULL' };
  q.insert.run(v.first_name, v.last_name, v.grade, v.field, date);
  return { ok: true };
});

/* ---------- اعتبارسنجی ---------- */
const norm = (s) => String(s ?? '').normalize('NFC')
  .replace(/ك/g, 'ک').replace(/[يى]/g, 'ی').replace(/\s+/g, ' ')
  .replace(/\u200c+/g, '\u200c').replace(/ ?\u200c ?/g, ' ').replace(/^[\u200c ]+|[\u200c ]+$/g, '');
function nameError(v, label) {
  if (!v) return `${label} را وارد کنید.`;
  const len = v.replace(/\u200c/g, '').length;
  if (len < 2 || v.length > 30) return `${label} باید بین ۲ تا ۳۰ حرف باشد.`;
  if (!NAME_RE.test(v)) return `${label} فقط می‌تواند شامل حروف فارسی باشد.`;
  return '';
}
function validate(body) {
  const v = {
    first_name: norm(body.first_name), last_name: norm(body.last_name),
    grade: String(body.grade ?? ''), field: String(body.field ?? ''),
    day: body.day === 'tomorrow' ? 'tomorrow' : body.day === 'today' ? 'today' : '',
  };
  const errors = {};
  const e1 = nameError(v.first_name, 'نام'); if (e1) errors.first_name = e1;
  const e2 = nameError(v.last_name, 'نام خانوادگی'); if (e2) errors.last_name = e2;
  if (!GRADES.includes(v.grade)) errors.grade = 'پایه را انتخاب کنید.';
  if (!FIELDS.includes(v.field)) errors.field = 'رشته را انتخاب کنید.';
  if (!v.day) errors.day = 'تاریخ رزرو را انتخاب کنید.';
  return { v, errors };
}

/* ---------- اپلیکیشن ---------- */
const app = express();
if (process.env.TRUST_PROXY) app.set('trust proxy', Number(process.env.TRUST_PROXY) || 1);
app.disable('x-powered-by');
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      // پشت پراکسی HTTPS (TRUST_PROXY) فعال؛ روی HTTP ساده همه‌ی فایل‌ها را می‌شکند
      upgradeInsecureRequests: process.env.TRUST_PROXY ? [] : null,
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:'],
      scriptSrc: ["'self'"],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
    },
  },
}));
app.use(express.json({ limit: '2kb' }));
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '1h',
  setHeaders: (res, file) => { if (file.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache'); },
}));

const readLimiter = rateLimit({ windowMs: 60_000, max: 1500, standardHeaders: true, legacyHeaders: false });
const writeLimiter = rateLimit({
  windowMs: 10 * 60_000, max: 60, standardHeaders: true, legacyHeaders: false,
  message: { message: 'درخواست‌های زیادی ارسال شده است. کمی بعد دوباره تلاش کنید.' },
});

app.get('/api/status', readLimiter, (req, res) => {
  res.set('Cache-Control', 'no-store');
  const today = todayKey();
  res.json({
    window: { state: windowState(), start: '07:30', end: '13:40' },
    today: dayStatus(today),
    tomorrow: dayStatus(addDays(today, 1)),
  });
});

app.get('/api/reservations', readLimiter, (req, res) => {
  res.set('Cache-Control', 'no-store');
  const day = req.query.day === 'tomorrow' ? 'tomorrow' : 'today';
  const date = dateForDay(day);
  res.json({ date, dateFa: faDate(date), items: q.list.all(date) });
});

app.post('/api/reserve', writeLimiter, (req, res) => {
  // جلوگیری از درخواست‌های جعلی بین‌سایتی
  const origin = req.get('origin');
  if (origin) {
    let ok = false;
    try { ok = new URL(origin).host === req.get('host'); } catch { ok = false; }
    if (!ok) return res.status(403).json({ message: 'درخواست نامعتبر است.' });
  }
  if (!req.is('application/json')) return res.status(415).json({ message: 'درخواست نامعتبر است.' });

  const { v, errors } = validate(req.body || {});
  if (Object.keys(errors).length) {
    return res.status(422).json({ message: 'اطلاعات واردشده معتبر نیست.', errors });
  }
  if (windowState() !== 'open') {
    return res.status(403).json({ code: 'CLOSED', message: 'زمان رزرو به پایان رسیده است.' });
  }
  const date = dateForDay(v.day); // تاریخ همیشه از سمت سرور و بر اساس ساعت ایران تعیین می‌شود
  try {
    const r = reserveTx.immediate(date, v);
    if (r.error === 'FULL') {
      return res.status(409).json({
        code: 'FULL',
        message: v.day === 'today' ? 'ظرفیت رزرو امروز تکمیل شده است.' : 'ظرفیت رزرو فردا تکمیل شده است.',
      });
    }
    if (r.error === 'DUP') {
      return res.status(409).json({ code: 'DUP', message: 'شما برای این روز قبلاً رزرو کرده‌اید.' });
    }
    res.status(201).json({
      reservation: {
        first_name: v.first_name, last_name: v.last_name, grade: v.grade, field: v.field,
        day: v.day, date, dateFa: faDate(date),
      },
      status: dayStatus(date),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'خطای سرور. لطفاً دوباره تلاش کنید.' });
  }
});

app.use('/api', (req, res) => res.status(404).json({ message: 'یافت نشد.' }));
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (err.type === 'entity.parse.failed' || err.type === 'entity.too.large') {
    return res.status(400).json({ message: 'درخواست نامعتبر است.' });
  }
  console.error(err);
  res.status(500).json({ message: 'خطای سرور.' });
});

const server = app.listen(PORT, () => console.log(`Buffet reservation running on http://localhost:${PORT}`));
const shutdown = () => server.close(() => { try { db.close(); } catch { /* ignore */ } process.exit(0); });
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
