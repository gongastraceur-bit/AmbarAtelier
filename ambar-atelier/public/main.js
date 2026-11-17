/* ÂMBAR — Atelier de Beleza · interactions
   Vanilla JS, no dependencies. Every effect degrades gracefully
   and respects prefers-reduced-motion. */
(() => {
  'use strict';

  const root = document.documentElement;
  const $ = (s, c = document) => c.querySelector(s);
  const $$ = (s, c = document) => Array.from(c.querySelectorAll(s));
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const finePointer = matchMedia('(hover: hover) and (pointer: fine)').matches;

  /* ---------- Intro curtain ---------- */
  let introSeen = false;
  try { introSeen = sessionStorage.getItem('ambar-intro') === '1'; } catch (_) {}

  const startReveals = () => initReveals();

  if (reduceMotion || introSeen) {
    root.classList.add('intro-skip');
    startReveals();
  } else {
    const fontsReady = document.fonts ? document.fonts.ready : Promise.resolve();
    const minTime = new Promise(r => setTimeout(r, 900));
    const cap = new Promise(r => setTimeout(r, 1800)); // never hold the page longer than this
    Promise.race([Promise.all([fontsReady, minTime]), cap]).then(() => {
      root.classList.add('intro-done');
      try { sessionStorage.setItem('ambar-intro', '1'); } catch (_) {}
      setTimeout(startReveals, 380);
      setTimeout(() => root.classList.add('intro-skip'), 1200);
    });
  }

  /* ---------- Scroll reveals ---------- */
  function initReveals() {
    const targets = $$('[data-reveal], [data-lines]');
    if (!('IntersectionObserver' in window) || reduceMotion) {
      targets.forEach(el => el.classList.add('is-in'));
      return;
    }
    // Chromium reports fully clip-pathed elements as non-intersecting,
    // so clip reveals are triggered by observing their (unclipped) parent.
    const groups = new Map();
    targets.forEach(el => {
      const watch = el.dataset.reveal === 'clip' ? el.parentElement : el;
      if (!groups.has(watch)) groups.set(watch, []);
      groups.get(watch).push(el);
    });
    const io = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (!entry.isIntersecting) return;
        (groups.get(entry.target) || []).forEach(el => {
          el.classList.add('is-in');
          el.querySelectorAll('[data-count]').forEach(animateCount);
        });
        io.unobserve(entry.target);
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
    groups.forEach((_, watch) => io.observe(watch));
  }

  /* ---------- Counters ---------- */
  function animateCount(el) {
    if (reduceMotion || el.dataset.done) return;
    el.dataset.done = '1';
    const target = parseFloat(el.dataset.count);
    const decimals = parseInt(el.dataset.decimals || '0', 10);
    const fmt = new Intl.NumberFormat('pt-PT', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
    const dur = 1600;
    const t0 = performance.now();
    const tick = (now) => {
      const p = Math.min((now - t0) / dur, 1);
      const eased = 1 - Math.pow(1 - p, 4);
      el.textContent = fmt.format(target * eased);
      if (p < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  /* ---------- Header: solid on scroll, hide on scroll down ---------- */
  const parallaxEls = (finePointer && !reduceMotion) ? $$('[data-parallax]') : [];
  const edgeEls = $$('.has-edge');
  const storySteps = $('[data-story-steps]');
  const footerEl = $('.footer');
  const footerWord = $('.footer__big');
  const chapters = storySteps ? $$('.chapter', storySteps) : [];
  const storyFrames = $$('.story__img');
  const storyNum = $('[data-story-num]');
  const roman = ['I', 'II', 'III', 'IV'];
  let currentChapter = 0;
  const header = $('[data-header]');
  const mobileCta = $('[data-mobile-cta]');
  const bookingSection = $('#marcar');
  let lastY = window.scrollY;
  let ticking = false;
  let bookingVisible = false;

  // Hide the sticky mobile CTA where the page already offers booking
  if ('IntersectionObserver' in window) {
    const ctaZones = [bookingSection, $('.footer__cta')].filter(Boolean);
    const inView = new Set();
    const ctaIO = new IntersectionObserver(entries => {
      entries.forEach(e => e.isIntersecting ? inView.add(e.target) : inView.delete(e.target));
      bookingVisible = inView.size > 0;
      requestTick();
    }, { threshold: 0.05 });
    ctaZones.forEach(z => ctaIO.observe(z));
  }

  /* ---------- Scroll frame ----------
     Every frame reads all geometry first, then writes all styles,
     so the browser lays out once per frame (no forced reflows). */
  function onScroll() {
    ticking = false;
    // READ
    const y = window.scrollY;
    const vh = window.innerHeight;
    const vw = window.innerWidth;
    const max = document.documentElement.scrollHeight - vh;
    const writes = [parallax(vh, vw), edges(vh), storyRail(vh, vw), footerFill(vh)];
    // WRITE
    header.classList.toggle('is-scrolled', y > 24);
    const goingDown = y > lastY + 4;
    const goingUp = y < lastY - 4;
    if (!root.classList.contains('menu-open')) {
      if (goingDown && y > 400) header.classList.add('is-hidden');
      else if (goingUp || y < 400) header.classList.remove('is-hidden');
    }
    if (mobileCta) mobileCta.classList.toggle('is-visible', y > vh * 0.7 && !bookingVisible);
    lastY = y;
    writes.forEach(w => w && w());
    header.style.setProperty('--progress', max > 0 ? (y / max).toFixed(4) : 0);
  }
  function requestTick() {
    if (!ticking) { requestAnimationFrame(onScroll); ticking = true; }
  }

  /* ---------- Footer wordmark fills as the page ends ---------- */
  function footerFill(vh) {
    if (!footerWord || reduceMotion) return null;
    const r = footerEl.getBoundingClientRect();
    if (r.top > vh) return null;
    const p = Math.min(Math.max((vh - r.top) / r.height, 0), 1);
    const v = (p * 118).toFixed(1) + '%';
    return () => { if (footerWord._fill !== v) { footerWord.style.setProperty('--fill', v); footerWord._fill = v; } };
  }

  /* ---------- Experience story: rail fills as you read ---------- */
  function storyRail(vh, vw) {
    if (!storySteps) return null;
    const r = storySteps.getBoundingClientRect();
    if (r.bottom < -vh || r.top > vh * 2) return null;
    const p = Math.min(Math.max((vh * 0.5 - r.top) / r.height, 0), 1);
    const v = p.toFixed(3);
    // Active chapter = the last one whose top has passed the reading line.
    // Position-based, so fast flicks and anchor jumps stay correct.
    const line = vh * (vw >= 1024 ? 0.3 : 0.55); // desktop chapters are tall & centred
    let active = 0;
    chapters.forEach((c, i) => { if (c.getBoundingClientRect().top < line) active = i; });
    return () => {
      if (storySteps._rail !== v) { storySteps.style.setProperty('--rail', v); storySteps._rail = v; }
      if (active !== currentChapter) setChapter(active);
    };
  }

  function setChapter(i) {
    chapters[currentChapter].classList.remove('is-active');
    if (storyFrames[currentChapter]) storyFrames[currentChapter].classList.remove('is-active');
    currentChapter = i;
    chapters[i].classList.add('is-active');
    if (storyFrames[i]) storyFrames[i].classList.add('is-active');
    if (storyNum) {
      storyNum.textContent = roman[i];
      // restart the number animation on the next frame instead of forcing a reflow
      storyNum.classList.remove('is-changing');
      requestAnimationFrame(() => storyNum.classList.add('is-changing'));
    }
  }

  /* ---------- Arch edges between sections ----------
     Dome is full (1) when a section's top enters at the bottom of the
     viewport and relaxes to flat (0) by the time it reaches ~35% from top. */
  function edges(vh) {
    if (reduceMotion || !edgeEls.length) return null;
    const vals = edgeEls.map(el => {
      const t = el.getBoundingClientRect().top;
      if (t > vh * 1.3 || t < -vh * 0.2) return null;
      const p = Math.min(Math.max((t - vh * 0.35) / (vh * 0.65), 0), 1);
      return (p * p * (3 - 2 * p)).toFixed(3); // smoothstep
    });
    return () => edgeEls.forEach((el, i) => {
      const v = vals[i];
      if (v !== null && el._edge !== v) { el.style.setProperty('--edge', v); el._edge = v; }
    });
  }

  /* ---------- Subtle parallax (desktop only) ----------
     Measured from the parent, so the element's own transform
     never feeds back into its next position. */
  function parallax(vh, vw) {
    if (!parallaxEls.length || vw < 900) return null;
    const vals = parallaxEls.map(el => {
      const r = el.parentElement.getBoundingClientRect();
      if (r.bottom < -100 || r.top > vh + 100) return null;
      const speed = parseFloat(el.dataset.parallax) || 0;
      return `translate3d(0, ${((r.top + r.height / 2 - vh / 2) * speed).toFixed(1)}px, 0)`;
    });
    return () => parallaxEls.forEach((el, i) => { if (vals[i] !== null) el.style.transform = vals[i]; });
  }

  window.addEventListener('scroll', requestTick, { passive: true });
  window.addEventListener('resize', requestTick, { passive: true });
  requestTick();

  /* ---------- Active nav link ---------- */
  const navLinks = $$('.nav__list a');
  if ('IntersectionObserver' in window) {
    const map = new Map(navLinks.map(a => [a.getAttribute('href').slice(1), a]));
    const navIO = new IntersectionObserver(entries => {
      entries.forEach(e => {
        const link = map.get(e.target.id);
        if (link && e.isIntersecting) {
          navLinks.forEach(l => l.removeAttribute('aria-current'));
          link.setAttribute('aria-current', 'true');
        }
      });
    }, { rootMargin: '-45% 0px -50% 0px' });
    map.forEach((_, id) => { const s = document.getElementById(id); if (s) navIO.observe(s); });
  }

  /* ---------- Mobile menu ---------- */
  const toggle = $('.menu-toggle');
  const menu = $('#mobile-menu');
  function setMenu(open) {
    toggle.setAttribute('aria-expanded', String(open));
    toggle.setAttribute('aria-label', open ? 'Fechar menu' : 'Abrir menu');
    root.classList.toggle('menu-open', open);
    if (open) {
      menu.hidden = false;
      requestAnimationFrame(() => requestAnimationFrame(() => menu.classList.add('is-open')));
      setTimeout(() => $('a', menu).focus({ preventScroll: true }), 350);
    } else {
      menu.classList.remove('is-open');
      setTimeout(() => { if (!menu.classList.contains('is-open')) menu.hidden = true; }, reduceMotion ? 0 : 700);
    }
  }
  toggle.addEventListener('click', () => setMenu(toggle.getAttribute('aria-expanded') !== 'true'));
  menu.addEventListener('click', e => { if (e.target.closest('a')) setMenu(false); });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && root.classList.contains('menu-open')) { setMenu(false); toggle.focus(); }
    // simple focus trap
    if (e.key === 'Tab' && root.classList.contains('menu-open')) {
      const f = [toggle, ...$$('a, button', menu)];
      const i = f.indexOf(document.activeElement);
      if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
    }
  });
  matchMedia('(min-width: 1024px)').addEventListener('change', e => { if (e.matches) setMenu(false); });

  /* ---------- Services tabs (WAI-ARIA tabs pattern) ---------- */
  const tabs = $$('.tabs__tab');
  const indicator = $('.tabs__indicator');
  const visual = $('.services__visual');
  function moveIndicator(tab) {
    if (!indicator || !tab) return;
    indicator.style.width = tab.offsetWidth - (tab === tabs[0] ? 0 : 32) + 'px';
    const left = tab.offsetLeft + (tab === tabs[0] ? 0 : 16);
    indicator.style.transform = `translateX(${left}px)`;
  }
  function selectTab(tab, focus) {
    tabs.forEach(t => {
      const on = t === tab;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      $('#' + t.getAttribute('aria-controls')).hidden = !on;
    });
    if (focus) tab.focus();
    tab.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: reduceMotion ? 'auto' : 'smooth' });
    moveIndicator(tab);
    swapVisual($('#' + tab.getAttribute('aria-controls')).dataset.img);
  }
  function swapVisual(src) {
    if (!visual || !src) return;
    const current = $('.services__img.is-active', visual);
    if (current && current.src === src) return;
    const next = new Image();
    next.className = 'services__img';
    next.alt = '';
    next.decoding = 'async';
    next.src = src;
    const show = () => {
      visual.appendChild(next);
      requestAnimationFrame(() => next.classList.add('is-active'));
      if (current) {
        current.classList.add('is-leaving');
        current.style.zIndex = 1; next.style.zIndex = 0;
        setTimeout(() => current.remove(), 900);
      }
    };
    next.decode ? next.decode().then(show, show) : (next.onload = show);
  }
  tabs.forEach((tab, i) => {
    tab.addEventListener('click', () => selectTab(tab));
    tab.addEventListener('keydown', e => {
      let j = null;
      if (e.key === 'ArrowRight') j = (i + 1) % tabs.length;
      if (e.key === 'ArrowLeft') j = (i - 1 + tabs.length) % tabs.length;
      if (e.key === 'Home') j = 0;
      if (e.key === 'End') j = tabs.length - 1;
      if (j !== null) { e.preventDefault(); selectTab(tabs[j], true); }
    });
  });
  // preload category images when idle
  const idle = window.requestIdleCallback || (cb => setTimeout(cb, 1500));
  idle(() => $$('.tabs__panel').forEach(p => { if (p.dataset.img) { const i = new Image(); i.src = p.dataset.img; } }));
  const placeIndicator = () => moveIndicator($('.tabs__tab[aria-selected="true"]'));
  window.addEventListener('resize', placeIndicator, { passive: true });
  (document.fonts ? document.fonts.ready : Promise.resolve()).then(placeIndicator);

  /* ---------- Testimonials ---------- */
  const quotes = $$('.quote');
  const qImgs = $$('.quotes__img');
  const qTabs = $$('.qnav__btn');
  const qSince = $('[data-quote-since]');
  let qi = 0;

  // Split each quote into word spans so they can settle in one by one.
  quotes.forEach(q => {
    const p = $('blockquote p', q);
    const words = p.textContent.trim().split(/\s+/);
    p.innerHTML = words.map((w, i) => `<span class="w" style="--i:${i}">${w}</span>`).join(' ');
  });

  function showQuote(n, focusTab) {
    const next = (n + quotes.length) % quotes.length;
    if (next === qi) return;
    quotes[qi].classList.remove('is-active');
    quotes[qi].setAttribute('aria-hidden', 'true');
    qImgs[qi] && qImgs[qi].classList.remove('is-active');
    qTabs[qi] && qTabs[qi].removeAttribute('aria-current');
    qi = next;
    quotes[qi].removeAttribute('aria-hidden');
    void quotes[qi].offsetWidth; // restart word animation
    quotes[qi].classList.add('is-active');
    qImgs[qi] && qImgs[qi].classList.add('is-active');
    if (qTabs[qi]) { qTabs[qi].setAttribute('aria-current', 'true'); if (focusTab) qTabs[qi].focus(); }
    if (qSince) qSince.textContent = quotes[qi].dataset.since;
  }
  $$('[data-quote]').forEach(b => b.addEventListener('click', () => showQuote(qi + (b.dataset.quote === 'next' ? 1 : -1))));
  qTabs.forEach((t, i) => {
    t.addEventListener('click', () => showQuote(i));
    t.addEventListener('keydown', e => {
      if (e.key === 'ArrowRight') { e.preventDefault(); showQuote(qi + 1, true); }
      if (e.key === 'ArrowLeft') { e.preventDefault(); showQuote(qi - 1, true); }
    });
  });
  // swipe support with button fallback
  const qStage = $('.quotes__slides');
  let sx = null;
  qStage.addEventListener('touchstart', e => { sx = e.touches[0].clientX; }, { passive: true });
  qStage.addEventListener('touchend', e => {
    if (sx === null) return;
    const dx = e.changedTouches[0].clientX - sx;
    if (Math.abs(dx) > 50) showQuote(qi + (dx < 0 ? 1 : -1));
    sx = null;
  });

  /* ---------- Lightbox ---------- */
  const lb = $('.lightbox');
  const lbImg = $('img', lb);
  let lbOpener = null;
  $$('.g__btn').forEach(btn => btn.addEventListener('click', () => {
    if (typeof lb.showModal !== 'function') { window.open(btn.dataset.full, '_blank'); return; }
    lbOpener = btn;
    lbImg.src = btn.dataset.full;
    lbImg.alt = $('img', btn).alt;
    lb.showModal();
  }));
  $('.lightbox__close').addEventListener('click', () => lb.close());
  lb.addEventListener('click', e => { if (e.target === lb) lb.close(); });
  lb.addEventListener('close', () => { lbImg.removeAttribute('src'); if (lbOpener) lbOpener.focus(); });

  /* ---------- Booking form ---------- */
  const form = $('#booking-form');
  const steps = $$('.fstep', form);
  const progress = $$('.progress__step', form);
  const btnPrev = $('[data-prev]', form);
  const btnNext = $('[data-next]', form);
  const btnSubmit = $('[data-submit]', form);
  const success = $('.fsuccess', form);
  const dateInput = $('#date');
  const slotsBox = $('[data-slots]');
  const sum = k => $(`[data-sum="${k}"]`);
  let step = 0;

  const pad = n => String(n).padStart(2, '0');
  const toISO = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const today = new Date();
  const maxDate = new Date(); maxDate.setDate(maxDate.getDate() + 90);
  dateInput.min = toISO(today);
  dateInput.max = toISO(maxDate);

  const dateFmt = new Intl.DateTimeFormat('pt-PT', { weekday: 'short', day: 'numeric', month: 'long' });

  function setSum(key, val) {
    const el = sum(key);
    if (!el || el.textContent === val) return;
    el.textContent = val;
    el.classList.remove('is-updated'); void el.offsetWidth; el.classList.add('is-updated');
  }

  function setError(id, msg, field) {
    const el = document.getElementById(id);
    el.textContent = msg || '';
    if (field) field.setAttribute('aria-invalid', msg ? 'true' : 'false');
  }

  /* Live availability from the booking API (server.mjs) */
  const proSelect = $('#pro');
  const formError = $('[data-form-error]', form);
  const PHONE_HELP = 'ligue +351 210 000 000';
  let catalogue = null;
  let slotsReq = 0;

  /* ---------- Demo mode ----------
     When the site is hosted without server.mjs (e.g. a static demo on
     Cloudflare), the booking flow runs against this in-browser stand-in:
     same rules as the server, believable busy slots, no data leaves the page. */
  const DEMO_SERVICES = {
    'Corte & Brushing': { minutes: 60, pros: ['Inês Valadares', 'Beatriz Lemos'] },
    'Coloração Integral': { minutes: 90, pros: ['Inês Valadares', 'Beatriz Lemos'] },
    'Balayage Âmbar': { minutes: 180, pros: ['Beatriz Lemos', 'Inês Valadares'] },
    'Facial Luminosidade': { minutes: 90, pros: ['Marta Sequeira'] },
    'Lifting & Tinta de Pestanas': { minutes: 60, pros: ['Marta Sequeira'] },
    'Manicure Semipermanente': { minutes: 60, pros: ['Sofia Antunes'] },
    'Pedicure Spa': { minutes: 75, pros: ['Sofia Antunes'] },
    'Maquilhagem Social': { minutes: 60, pros: ['Sofia Antunes', 'Marta Sequeira'] },
    'Consulta (não tenho a certeza)': { minutes: 20, pros: ['Inês Valadares', 'Beatriz Lemos', 'Marta Sequeira', 'Sofia Antunes'] }
  };
  const demo = {
    booked: [], // bookings made during this visit, so a taken slot greys out
    hours: { 2: [600, 1200], 3: [600, 1200], 4: [600, 1200], 5: [600, 1200], 6: [540, 1140] },
    holidays: ['01-01', '04-25', '05-01', '06-10', '06-13', '08-15', '10-05', '11-01', '12-01', '12-08', '12-25'],
    busy(iso, pro, start, end) {
      if (this.booked.some(b => b.date === iso && b.pro === pro && b.start < end && start < b.end)) return true;
      // Deterministic "existing clients": same date + person always looks the same
      let seed = [...(iso + pro)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 233280, 7);
      for (let m = 540; m < 1200; m += 30) {
        seed = (seed * 9301 + 49297) % 233280;
        if (seed / 233280 < 0.14 && m < end && start < m + 60) return true;
      }
      return false;
    },
    availability(iso, service, pro) {
      const svc = DEMO_SERVICES[service];
      const d = new Date(iso + 'T12:00:00');
      const hours = this.hours[d.getDay()];
      if (!hours) return { closed: 'Estamos encerrados ao domingo e à segunda-feira.', slots: [] };
      if (this.holidays.includes(iso.slice(5))) return { closed: 'Feriado — o atelier está encerrado.', slots: [] };
      const pros = pro && pro !== 'Sem preferência' ? [pro] : svc.pros;
      const now = new Date();
      const earliest = iso === toISO(now) ? now.getHours() * 60 + now.getMinutes() + 60 : 0;
      const slots = [];
      for (let m = hours[0]; m + svc.minutes <= hours[1]; m += 30) {
        const free = m >= earliest && pros.some(p => !this.busy(iso, p, m, m + svc.minutes));
        slots.push({ time: `${pad(Math.floor(m / 60))}:${pad(m % 60)}`, available: free });
      }
      return { slots };
    },
    book(p) {
      const svc = DEMO_SERVICES[p.service];
      const start = Number(p.time.slice(0, 2)) * 60 + Number(p.time.slice(3));
      const pros = p.pro && p.pro !== 'Sem preferência' ? [p.pro] : svc.pros;
      const pro = pros.find(x => !this.busy(p.date, x, start, start + svc.minutes));
      if (!pro) return { status: 409, data: { errors: { time: 'Esse horário acabou de ser reservado. Escolha outro, por favor.' } } };
      this.booked.push({ date: p.date, pro, start, end: start + svc.minutes });
      const ref = 'AMB-' + Math.random().toString(16).slice(2, 8).toUpperCase();
      return { status: 201, data: { ref, emailed: false } };
    }
  };
  // Live if server.mjs answers, demo otherwise. Decided once, on load.
  const mode = fetch('/api/services', { headers: { Accept: 'application/json' } })
    .then(r => r.ok ? r.json() : Promise.reject())
    .then(d => { catalogue = d.services; return 'live'; })
    .catch(() => { catalogue = DEMO_SERVICES; return 'demo'; })
    .then(m => { filterPros(); return m; });
  const pause = ms => new Promise(r => setTimeout(r, ms));

  const emptySlots = msg => { slotsBox.innerHTML = `<p class="slots__empty">${msg}</p>`; };

  // Only offer professionals who actually do the chosen service
  function filterPros() {
    const sel = $('input[name="service"]:checked', form);
    const pros = catalogue && sel && catalogue[sel.value] ? catalogue[sel.value].pros : null;
    $$('option', proSelect).forEach(o => { o.disabled = Boolean(pros) && o.value !== 'Sem preferência' && !pros.includes(o.value); });
    if (proSelect.selectedOptions[0] && proSelect.selectedOptions[0].disabled) { proSelect.value = 'Sem preferência'; setSum('pro', 'Sem preferência'); }
  }

  async function buildSlots(iso) {
    setSum('time', '—');
    const sel = $('input[name="service"]:checked', form);
    if (!sel) { emptySlots('Escolha primeiro um serviço.'); return; }
    const req = ++slotsReq;
    slotsBox.setAttribute('aria-busy', 'true');
    emptySlots('A procurar horários…');
    try {
      let data;
      if (await mode === 'demo') {
        await pause(350); // feel like a real lookup
        data = demo.availability(iso, sel.value, proSelect.value);
      } else {
        const qs = new URLSearchParams({ date: iso, service: sel.value, pro: proSelect.value });
        const res = await fetch('/api/availability?' + qs);
        data = await res.json();
        if (!res.ok) throw new Error(data.error || 'erro');
      }
      if (req !== slotsReq) return; // a newer request has replaced this one
      if (data.closed) {
        setError('err-date', data.closed + ' Escolha outro dia.', dateInput);
        setSum('date', '—');
        emptySlots('Sem horários neste dia.');
        return;
      }
      setError('err-date', '', dateInput);
      if (!data.slots.some(s => s.available)) { emptySlots('Já não há horários livres neste dia. Experimente outra data ou outra profissional.'); return; }
      slotsBox.innerHTML = '';
      data.slots.forEach((s, i) => {
        const wrap = document.createElement('label');
        wrap.className = 'slot';
        wrap.style.setProperty('--i', i);
        wrap.innerHTML = `<input type="radio" name="time" value="${s.time}" ${s.available ? '' : 'disabled'}><span>${s.time}${s.available ? '' : '<span class="visually-hidden"> (ocupado)</span>'}</span>`;
        slotsBox.appendChild(wrap);
      });
    } catch {
      if (req === slotsReq) emptySlots(`Não conseguimos carregar os horários. Tente novamente ou ${PHONE_HELP}.`);
    } finally {
      if (req === slotsReq) slotsBox.removeAttribute('aria-busy');
    }
  }

  dateInput.addEventListener('change', () => {
    const v = dateInput.value;
    if (!v) return;
    const d = new Date(v + 'T12:00:00');
    if (d.getDay() === 0 || d.getDay() === 1) {
      setError('err-date', 'Estamos encerrados ao domingo e à segunda-feira. Escolha outro dia.', dateInput);
      emptySlots('Sem horários neste dia.');
      setSum('date', '—');
      return;
    }
    setError('err-date', '', dateInput);
    setSum('date', dateFmt.format(d));
    buildSlots(v);
  });

  form.addEventListener('change', e => {
    const t = e.target;
    if (t.name === 'service') {
      setSum('service', t.value);
      setSum('price', t.dataset.price);
      setSum('dur', t.dataset.dur);
      setError('err-service', '');
      filterPros();
    }
    if ((t.name === 'service' || t.name === 'pro') && dateInput.value && !$('#err-date').textContent) buildSlots(dateInput.value);
    if (t.name === 'pro') setSum('pro', t.value);
    if (t.name === 'time') { setSum('time', t.value); setError('err-time', ''); }
    if (t.name === 'consent' && t.checked) setError('err-consent', '', t);
  });

  // Validate on blur for text fields
  const validators = {
    name: v => v.trim().length >= 2 ? '' : 'Indique o seu nome.',
    phone: v => /^\+?[\d\s()-]{9,}$/.test(v.trim()) ? '' : 'Indique um número válido, por exemplo +351 912 345 678.',
    email: v => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v.trim()) ? '' : 'Indique um email válido, por exemplo nome@email.pt.'
  };
  Object.keys(validators).forEach(id => {
    const el = document.getElementById(id);
    el.addEventListener('blur', () => { if (el.value) setError('err-' + id, validators[id](el.value), el); });
    el.addEventListener('input', () => { if (el.getAttribute('aria-invalid') === 'true') setError('err-' + id, validators[id](el.value), el); });
  });

  function validateStep(n) {
    let firstInvalid = null;
    const flag = (el) => { if (!firstInvalid) firstInvalid = el; };
    if (n === 0) {
      const sel = $('input[name="service"]:checked', form);
      if (!sel) { setError('err-service', 'Escolha um serviço para continuar.'); flag($('input[name="service"]', form)); }
    }
    if (n === 1) {
      if (!dateInput.value) { setError('err-date', 'Escolha uma data.', dateInput); flag(dateInput); }
      else if ($('#err-date').textContent) flag(dateInput);
      if (!$('input[name="time"]:checked', form)) {
        if (dateInput.value && !$('#err-date').textContent) setError('err-time', 'Escolha uma hora disponível.');
        flag($('input[name="time"]:not(:disabled)', form) || dateInput);
      }
    }
    if (n === 2) {
      Object.keys(validators).forEach(id => {
        const el = document.getElementById(id);
        const msg = validators[id](el.value);
        setError('err-' + id, msg, el);
        if (msg) flag(el);
      });
      const c = $('#consent');
      if (!c.checked) { setError('err-consent', 'Precisamos da sua autorização para tratar a marcação.', c); flag(c); }
    }
    if (firstInvalid) firstInvalid.focus();
    return !firstInvalid;
  }

  function goTo(n, back) {
    steps[step].hidden = true;
    steps[step].classList.remove('is-active', 'is-back');
    step = n;
    const s = steps[step];
    s.hidden = false;
    void s.offsetWidth;
    s.classList.add(back ? 'is-back' : 'is-active');
    progress.forEach((p, i) => {
      p.classList.toggle('is-current', i === step);
      p.classList.toggle('is-done', i < step);
      if (i === step) p.setAttribute('aria-current', 'step'); else p.removeAttribute('aria-current');
    });
    btnPrev.hidden = step === 0;
    btnNext.hidden = step === steps.length - 1;
    btnSubmit.hidden = step !== steps.length - 1;
    const legend = $('.fstep__legend', s);
    legend.setAttribute('tabindex', '-1');
    legend.focus({ preventScroll: true });
    const top = form.getBoundingClientRect().top;
    if (top < 0) form.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
  }

  btnNext.addEventListener('click', () => { if (validateStep(step)) goTo(step + 1); });
  btnPrev.addEventListener('click', () => goTo(step - 1, true));

  // Which step holds each field, so server errors can send people to the right place
  const FIELD_STEP = { service: 0, pro: 0, date: 1, time: 1, name: 2, phone: 2, email: 2, consent: 2 };
  const fieldEl = k => k === 'service' ? $('input[name="service"]', form) : k === 'time' ? ($('input[name="time"]:not(:disabled)', form) || dateInput) : document.getElementById(k);

  form.addEventListener('submit', async e => {
    e.preventDefault();
    if (btnSubmit.disabled || !validateStep(step)) return;
    formError.textContent = '';
    btnSubmit.disabled = true;
    btnSubmit.classList.add('is-loading');
    btnSubmit.setAttribute('aria-busy', 'true');
    const fd = new FormData(form);
    const payload = Object.fromEntries(['service', 'pro', 'date', 'time', 'name', 'phone', 'email', 'notes', 'website'].map(k => [k, fd.get(k) || '']));
    payload.consent = $('#consent').checked;
    try {
      let res, data;
      if (await mode === 'demo') {
        await pause(1100);
        const r = demo.book(payload);
        res = { status: r.status }; data = r.data;
      } else {
        res = await fetch('/api/bookings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        data = await res.json().catch(() => ({}));
      }
      if (res.status === 201) {
        steps.forEach(s => s.hidden = true);
        $('.progress', form).hidden = true;
        $('.fnav', form).hidden = true;
        $('[data-success-ref]', form).textContent = data.ref || '';
        $('[data-success-when]', form).textContent = `${payload.service}, ${dateFmt.format(new Date(payload.date + 'T12:00:00'))} às ${payload.time}`;
        $('[data-success-email]', form).hidden = !data.emailed;
        $('[data-success-email] strong', form).textContent = payload.email;
        success.hidden = false;
        success.focus();
        return;
      }
      if (data.errors) {
        const keys = Object.keys(data.errors);
        const target = Math.min(...keys.map(k => FIELD_STEP[k] ?? 2));
        if (target !== step) goTo(target, target < step);
        if (data.errors.time && dateInput.value) await buildSlots(dateInput.value);
        keys.forEach(k => setError('err-' + k, data.errors[k], k === 'service' || k === 'time' ? null : document.getElementById(k)));
        const first = keys.find(k => FIELD_STEP[k] === target);
        if (first && fieldEl(first)) fieldEl(first).focus();
        return;
      }
      formError.textContent = (data.error || 'Não foi possível enviar o pedido.') + ` Se preferir, ${PHONE_HELP}.`;
    } catch {
      formError.textContent = `Sem ligação ao atelier neste momento. Tente novamente ou ${PHONE_HELP}.`;
    } finally {
      btnSubmit.disabled = false;
      btnSubmit.classList.remove('is-loading');
      btnSubmit.removeAttribute('aria-busy');
    }
  });

  $('[data-restart]', form).addEventListener('click', () => {
    form.reset();
    filterPros();
    formError.textContent = '';
    slotsBox.innerHTML = '<p class="slots__empty">Escolha primeiro uma data para ver as horas disponíveis.</p>';
    ['service', 'date', 'time', 'dur', 'price'].forEach(k => sum(k).textContent = '—');
    sum('pro').textContent = 'Sem preferência';
    success.hidden = true;
    $('.progress', form).hidden = false;
    $('.fnav', form).hidden = false;
    steps[step].hidden = true;
    step = 0;
    goTo(0);
  });

  /* ---------- Newsletter ---------- */
  const nl = $('.newsletter');
  nl.addEventListener('submit', async e => {
    e.preventDefault();
    const input = $('input[type="email"]', nl);
    const msg = $('.newsletter__msg', nl);
    if (validators.email(input.value)) { msg.textContent = 'Verifique o email, por favor.'; input.focus(); return; }
    msg.textContent = 'A enviar…';
    if (await mode === 'demo') {
      await pause(700);
      msg.textContent = 'Obrigada! Vai receber a próxima carta do atelier.';
      input.value = '';
      return;
    }
    try {
      const res = await fetch('/api/newsletter', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: input.value, website: $('input[name="website"]', nl).value }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error);
      msg.textContent = 'Obrigada! Vai receber a próxima carta do atelier.';
      input.value = '';
    } catch (err) {
      msg.textContent = (err && err.message) || 'Não foi possível subscrever agora. Tente mais tarde.';
    }
  });

  /* ---------- Live opening status (Lisbon time) ---------- */
  const openEl = $('[data-open-status]');
  if (openEl) {
    try {
      const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Lisbon', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date());
      const get = t => parts.find(p => p.type === t).value;
      const order = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      const ptDay = { Tue: 'terça', Wed: 'quarta', Thu: 'quinta', Fri: 'sexta', Sat: 'sábado' };
      const hours = { Tue: [10, 20], Wed: [10, 20], Thu: [10, 20], Fri: [10, 20], Sat: [9, 19] };
      const day = get('weekday');
      const now = (+get('hour') % 24) + (+get('minute')) / 60;
      const today = hours[day];
      const hh = h => `${String(h).padStart(2, '0')}h`;
      if (today && now >= today[0] && now < today[1]) {
        openEl.textContent = `Aberto agora · fecha às ${hh(today[1])}`;
        openEl.classList.add('is-open');
      } else if (today && now < today[0]) {
        openEl.textContent = `Encerrado · abre hoje às ${hh(today[0])}`;
      } else {
        const idx = order.indexOf(day);
        for (let i = 1; i <= 7; i++) {
          const d = order[(idx + i) % 7];
          if (hours[d]) { openEl.textContent = `Encerrado · abre ${i === 1 ? 'amanhã' : ptDay[d]} às ${hh(hours[d][0])}`; break; }
        }
      }
    } catch (_) { /* keep static fallback text */ }
  }

  /* ---------- Misc ---------- */
  $$('[data-year]').forEach(el => el.textContent = new Date().getFullYear());
})();
