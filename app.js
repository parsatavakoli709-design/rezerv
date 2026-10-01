(() => {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const fa = (n) => Number(n).toLocaleString('fa-IR');
  const GRADES = ['دهم', 'یازدهم', 'دوازدهم'];
  const FIELDS = ['شبکه', 'مکانیک', 'گرافیک', 'حسابداری', 'نقشه کشی'];
  const LET = 'آابپتثجچحخدذرزژسشصضطظعغفقکگلمنوهیءئؤأإة\u200c';
  const NAME_RE = new RegExp(`^[${LET}]+(?: [${LET}]+)*$`);
  const norm = (s) => String(s).normalize('NFC').replace(/ك/g, 'ک').replace(/[يى]/g, 'ی').replace(/\s+/g, ' ')
    .replace(/\u200c+/g, '\u200c').replace(/ ?\u200c ?/g, ' ').replace(/^[\u200c ]+|[\u200c ]+$/g, '');

  let S = null;            // آخرین وضعیت دریافتی از سرور
  let day = 'today';
  let submitting = false;
  let lastFocus = null;

  /* ---------- Toast ---------- */
  function toast(msg, type = '') {
    const t = document.createElement('div');
    t.className = `toast ${type}`;
    t.textContent = msg;
    $('#toasts').appendChild(t);
    setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; setTimeout(() => t.remove(), 300); }, 3800);
  }

  /* ---------- API ---------- */
  async function api(url, opts) {
    const r = await fetch(url, { cache: 'no-store', ...opts });
    let data = {};
    try { data = await r.json(); } catch { /* ignore */ }
    return { ok: r.ok, status: r.status, data };
  }

  /* ---------- نمایش وضعیت ---------- */
  function level(d) { return d.remaining === 0 ? 'empty' : d.remaining <= 5 ? 'low' : 'ok'; }
  function badgeText(d) { return d.remaining === 0 ? 'تمام شد!' : d.remaining <= 5 ? 'رو به اتمام' : 'موجود'; }

  function blockReason(which) {
    if (!S) return '';
    if (S.window.state === 'after') return 'زمان رزرو به پایان رسیده است.';
    if (S.window.state === 'before') return 'رزرو از ساعت ۰۷:۳۰ شروع می‌شود.';
    if (S[which].remaining === 0) return which === 'today' ? 'ظرفیت رزرو امروز تکمیل شده است.' : 'ظرفیت رزرو فردا تکمیل شده است.';
    return '';
  }

  function render() {
    const t = S.today, m = S.tomorrow;
    const stock = $('#heroStock');
    const next = t.remaining === 0 ? '۰' : fa(t.remaining);
    if (stock.textContent !== next) { stock.textContent = next; stock.classList.add('bump'); setTimeout(() => stock.classList.remove('bump'), 300); }

    $('#todayFa').textContent = t.dateFa;
    $('#tomFa').textContent = m.dateFa;
    $('#stCount').textContent = t.remaining === 0 ? 'تمام شد!' : fa(t.remaining);
    $('#stTotal').hidden = t.remaining === 0;
    $('#stTotal').textContent = ` / ${fa(t.capacity)}`;
    const card = $('#statusCard');
    card.dataset.level = level(t);
    $('#stBadge').textContent = badgeText(t);
    $('#barFill').style.width = `${t.capacity ? (t.remaining / t.capacity) * 100 : 0}%`;
    $('#bar').setAttribute('aria-valuemax', t.capacity); $('#bar').setAttribute('aria-valuenow', t.remaining);
    $('#bar').setAttribute('aria-label', `موجودی امروز ${fa(t.remaining)} از ${fa(t.capacity)}`);
    $('#stMsg').textContent = t.remaining === 0 ? 'ظرفیت رزرو امروز تکمیل شده است.'
      : t.remaining <= 5 ? `فقط ${fa(t.remaining)} ساندویچ باقی مانده، عجله کن!` : `${fa(t.booked)} نفر تا الان رزرو کرده‌اند.`;

    $('#tmCount').textContent = fa(m.remaining);
    const lv = level(m);
    $('#tmBadge').textContent = badgeText(m);
    $('#tmBadge').className = `badge ${lv === 'ok' ? '' : lv}`;
    $('#tmFill').style.width = `${m.capacity ? (m.remaining / m.capacity) * 100 : 0}%`;
    $('#tmFill').className = lv === 'ok' ? '' : lv;

    // دکمه‌ها و پیام
    let note = '';
    $$('.js-book').forEach((b) => {
      const why = blockReason(b.dataset.day);
      b.disabled = !!why;
      b.title = why;
      if (why && !note) note = why;
    });
    const notice = $('#notice');
    const both = blockReason('today') && blockReason('tomorrow');
    notice.hidden = !both;
    if (both) {
      notice.textContent = blockReason('today');
      notice.dataset.t = S.window.state === 'before' ? 'info' : '';
    }
  }

  async function loadStatus() {
    try {
      const r = await api('/api/status');
      if (!r.ok) throw new Error();
      const prev = S && S.today.date;
      S = r.data;
      render();
      if (prev && prev !== S.today.date) toast('روز جدید شروع شد و ظرفیت امروز به‌روز شد.', 'ok');
    } catch {
      $('#stBadge').textContent = 'خطا در ارتباط';
      $('#stMsg').textContent = 'ارتباط با سرور برقرار نشد. دوباره تلاش می‌کنیم…';
    }
  }

  /* ---------- لیست رزروهای امروز ---------- */
  let listLoaded = false;
  async function loadList() {
    const box = $('#people');
    if (!listLoaded) box.innerHTML = '<div class="skel"></div>'.repeat(4);
    try {
      const r = await api('/api/reservations?day=today');
      if (!r.ok) throw new Error();
      listLoaded = true;
      const items = r.data.items;
      $('#listCount').textContent = items.length ? `${fa(items.length)} نفر · ${r.data.dateFa}` : r.data.dateFa;
      box.replaceChildren();
      if (!items.length) {
        box.innerHTML = '<div class="empty-state"><span class="emoji">🥪</span>هنوز کسی امروز رزرو نکرده. اولین نفر باش!</div>';
        return;
      }
      for (const p of items) {
        const el = document.createElement('div');
        el.className = 'glass person';
        const av = document.createElement('span'); av.className = 'avatar'; av.textContent = p.first_name.charAt(0);
        const info = document.createElement('div');
        const b = document.createElement('b'); b.textContent = `${p.first_name} ${p.last_name}`;
        const s = document.createElement('small'); s.textContent = `${p.grade} · ${p.field}`;
        info.append(b, s); el.append(av, info); box.appendChild(el);
      }
    } catch {
      if (!listLoaded) box.innerHTML = '<div class="retry">بارگذاری فهرست انجام نشد. دوباره تلاش می‌کنیم…</div>';
    }
  }

  /* ---------- فرم ---------- */
  const form = $('#form'), fn = $('#fn'), ln = $('#ln');
  function chips(el, name, items) {
    el.innerHTML = '';
    items.forEach((v) => {
      const l = document.createElement('label'); l.className = 'chip-o';
      const i = document.createElement('input'); i.type = 'radio'; i.name = name; i.value = v;
      const s = document.createElement('span'); s.textContent = v;
      l.append(i, s); el.appendChild(l);
    });
  }
  chips($('#grades'), 'grade', GRADES);
  chips($('#fields'), 'field', FIELDS);

  function nameErr(v, label) {
    v = norm(v);
    if (!v) return `${label} را وارد کنید.`;
    if (v.replace(/\u200c/g, '').length < 2 || v.length > 30) return `${label} باید بین ۲ تا ۳۰ حرف باشد.`;
    if (!NAME_RE.test(v)) return `${label} فقط می‌تواند شامل حروف فارسی (بدون عدد، حروف انگلیسی و ایموجی) باشد.`;
    return '';
  }
  function setErr(name, msg) {
    const f = $(`[data-f="${name}"]`);
    if (!f) return;
    f.classList.toggle('bad', !!msg);
    $('.err', f).textContent = msg || '';
  }
  const val = () => ({
    first_name: fn.value, last_name: ln.value,
    grade: ($('input[name=grade]:checked') || {}).value || '',
    field: ($('input[name=field]:checked') || {}).value || '',
  });
  function valid() {
    const v = val();
    return !nameErr(v.first_name, 'نام') && !nameErr(v.last_name, 'نام خانوادگی') && v.grade && v.field && !submitting;
  }
  const refresh = () => { $('#submit').disabled = !valid(); };

  fn.addEventListener('input', () => { setErr('first_name', fn.value ? nameErr(fn.value, 'نام') : ''); refresh(); });
  ln.addEventListener('input', () => { setErr('last_name', ln.value ? nameErr(ln.value, 'نام خانوادگی') : ''); refresh(); });
  fn.addEventListener('blur', () => setErr('first_name', nameErr(fn.value, 'نام')));
  ln.addEventListener('blur', () => setErr('last_name', nameErr(ln.value, 'نام خانوادگی')));
  $('#grades').addEventListener('change', () => {
    $('#fieldSet').disabled = false;
    $('#fieldHint').hidden = true;
    setErr('grade', ''); refresh();
  });
  $('#fields').addEventListener('change', () => { setErr('field', ''); refresh(); });

  /* ---------- مودال ---------- */
  const modal = $('#modal'), sheet = $('.sheet', modal);
  function openModal(d) {
    const why = blockReason(d);
    if (why) { toast(why, 'err'); return; }
    day = d; lastFocus = document.activeElement;
    form.reset(); form.hidden = false; $('#success').hidden = true;
    $('#fieldSet').disabled = true; $('#fieldHint').hidden = false;
    ['first_name', 'last_name', 'grade', 'field'].forEach((n) => setErr(n, ''));
    $('#formErr').hidden = true;
    $('#mTitle').textContent = d === 'today' ? 'رزرو امروز' : 'رزرو برای فردا';
    $('#mDate').textContent = S ? S[d].dateFa : '';
    submitting = false; $('#submit').classList.remove('loading'); refresh();
    modal.hidden = false; document.body.style.overflow = 'hidden';
    setTimeout(() => fn.focus(), 60);
  }
  function closeModal() {
    modal.hidden = true; document.body.style.overflow = '';
    if (lastFocus) lastFocus.focus();
    loadStatus(); loadList();
  }
  $$('.js-book').forEach((b) => b.addEventListener('click', () => openModal(b.dataset.day)));
  $$('[data-close]', modal).forEach((b) => b.addEventListener('click', closeModal));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !modal.hidden) closeModal(); });
  modal.addEventListener('keydown', (e) => { // نگه‌داشتن فوکوس داخل مودال
    if (e.key !== 'Tab') return;
    const f = $$('button:not([disabled]),input:not([disabled])', sheet).filter((x) => x.offsetParent !== null && !x.matches(':disabled') && (x.type !== 'radio' || x.checked));
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (submitting) return;
    const v = val();
    const e1 = nameErr(v.first_name, 'نام'), e2 = nameErr(v.last_name, 'نام خانوادگی');
    setErr('first_name', e1); setErr('last_name', e2);
    setErr('grade', v.grade ? '' : 'پایه را انتخاب کنید.');
    setErr('field', v.field ? '' : 'رشته را انتخاب کنید.');
    if (e1 || e2 || !v.grade || !v.field) return;

    submitting = true; $('#submit').classList.add('loading'); $('#submit').disabled = true;
    $('#submitTxt').textContent = 'در حال ثبت…'; $('#formErr').hidden = true;
    try {
      const r = await api('/api/reserve', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...v, first_name: norm(v.first_name), last_name: norm(v.last_name), day }),
      });
      if (r.ok) { showSuccess(r.data.reservation); return; }
      if (r.data.errors) Object.entries(r.data.errors).forEach(([k, m]) => setErr(k, m));
      const msg = r.data.message || 'ثبت رزرو انجام نشد. دوباره تلاش کنید.';
      const fe = $('#formErr'); fe.textContent = msg; fe.hidden = false;
      toast(msg, 'err');
      if (r.data.code) loadStatus();
    } catch {
      const fe = $('#formErr'); fe.textContent = 'ارتباط با سرور برقرار نشد. اینترنت خود را بررسی و دوباره تلاش کنید.'; fe.hidden = false;
    } finally {
      submitting = false; $('#submit').classList.remove('loading'); $('#submitTxt').textContent = 'ثبت رزرو'; refresh();
    }
  });

  function showSuccess(r) {
    form.hidden = true;
    const rc = $('#recap'); rc.replaceChildren();
    const rows = [
      ['نام', `${r.first_name} ${r.last_name}`], ['پایه', r.grade], ['رشته', r.field],
      ['تاریخ', `${r.day === 'today' ? 'امروز' : 'فردا'} · ${r.dateFa}`],
    ];
    rows.forEach(([k, v]) => {
      const d = document.createElement('div');
      const dt = document.createElement('dt'); dt.textContent = k;
      const dd = document.createElement('dd'); dd.textContent = v;
      d.append(dt, dd); rc.appendChild(d);
    });
    $('#success').hidden = false;
    $('#success .btn').focus();
    loadStatus(); loadList();
  }

  /* ---------- ناوبری ---------- */
  const burger = $('#burger'), links = $('#links');
  burger.addEventListener('click', () => {
    const o = links.classList.toggle('open');
    burger.setAttribute('aria-expanded', o);
    burger.querySelector('use').setAttribute('href', o ? '#i-x' : '#i-menu');
  });
  links.addEventListener('click', (e) => {
    if (e.target.tagName === 'A') { links.classList.remove('open'); burger.setAttribute('aria-expanded', 'false'); burger.querySelector('use').setAttribute('href', '#i-menu'); }
  });
  const spy = new IntersectionObserver((es) => es.forEach((en) => {
    if (en.isIntersecting) $$('.links a').forEach((a) => a.classList.toggle('on', a.getAttribute('href') === `#${en.target.id}`));
  }), { rootMargin: '-45% 0px -50% 0px' });
  ['home', 'reserve', 'today'].forEach((id) => spy.observe(document.getElementById(id)));

  /* ---------- عکس اختیاری قهرمان: اگر public/img/hero.jpg وجود داشته باشد جایگزین تصویر برداری می‌شود ---------- */
  const probe = new Image();
  probe.onload = () => { const p = $('#heroPhoto'); p.src = probe.src; p.hidden = false; $('#sandwich').style.display = 'none'; };
  probe.src = '/img/hero.jpg';

  /* ---------- شروع ---------- */
  loadStatus(); loadList();
  setInterval(() => { if (!document.hidden) { loadStatus(); if (modal.hidden) loadList(); } }, 10000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { loadStatus(); loadList(); } });
})();
