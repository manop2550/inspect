/* Owner app: open jobs, record new jobs (1-3 photos each, circle marks), review the units' fixes,
   closed jobs, share unit links to LINE.
   Opens from data saved on the phone, refreshes in the background. Every server write goes
   through a queue kept in IndexedDB (up to 3 sent at the same time), so nothing waits and nothing is lost. */
(function () {
  'use strict';

  var API = 'https://script.google.com/macros/s/AKfycby-OI8fk6svAZTD5AZk4X-HM2ZLuqS8qP5tI5aZTuA4zFPXY9v9HxbQFMC9x5regFdN/exec';
  var MAX_SIDE = 1600, MAX_SHOTS = 3, PARALLEL = 3;

  /* ---------- helpers ---------- */
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 10); }
  function thumb(id, w) { return 'https://drive.google.com/thumbnail?id=' + encodeURIComponent(id) + '&sz=w' + w; }
  function z(n) { return (n < 10 ? '0' : '') + n; }
  function ymdOf(d) { return d.getFullYear() + '-' + z(d.getMonth() + 1) + '-' + z(d.getDate()); }
  function todayYmd() { return ymdOf(new Date()); }
  function dayDiff(a, b) {
    var pa = a.split('-'), pb = b.split('-');
    return Math.round((Date.UTC(+pb[0], +pb[1] - 1, +pb[2]) - Date.UTC(+pa[0], +pa[1] - 1, +pa[2])) / 86400000);
  }
  function noteStamp() { var d = new Date(); return z(d.getDate()) + '/' + z(d.getMonth() + 1) + ' ' + z(d.getHours()) + ':' + z(d.getMinutes()); }
  function dmy(ymd) { var p = ymd.split('-'); return p[2] + '/' + p[1] + '/' + p[0].slice(2); }
  function createdText(d) { return z(d.getDate()) + '/' + z(d.getMonth() + 1) + '/' + String(d.getFullYear()).slice(2) + ' ' + z(d.getHours()) + ':' + z(d.getMinutes()); }
  function jpg(b64) { return 'data:image/jpeg;base64,' + b64; }

  /* ---------- owner link: ?o=TOKEN, kept on the phone ---------- */
  var TOK = new URLSearchParams(location.search).get('o') || lsGet('ownerTok') || '';
  if (TOK) lsSet('ownerTok', TOK);
  var UNIT_BASE = new URL('../', location.href.split('?')[0].split('#')[0]).href;   // .../inspect/

  /* ---------- state ---------- */
  var data = null;              // {at, today, sites, units, cats, items}
  var done = null;              // {at, items}
  var tab = 'list';
  var filt = { f: lsGet('ownerFilt') || 'all', site: lsGet('ownerSite') || '' };
  var navIds = [], navPos = 0, navFrom = 'list';
  var current = null;
  var queue = [], lastErr = '', retryTimer = null, loading = false, again = false;
  var localSrc = {};            // Drive file id -> data URL (photos taken on this phone this session)
  var closePhoto = null;
  var drafts = [];              // see addDraft
  var reports = [];             // [{id, url}] report images, newest last

  /* ---------- API ---------- */
  function api(body, timeoutMs) {
    var ctl = window.AbortController ? new AbortController() : null;
    var t = ctl ? setTimeout(function () { ctl.abort(); }, timeoutMs || 60000) : null;
    return fetch(API, { method: 'POST', body: JSON.stringify(body), signal: ctl ? ctl.signal : undefined, redirect: 'follow' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (t) clearTimeout(t);
        if (!j.ok) { var e = new Error(j.error || 'error'); e.server = true; throw e; }
        return j.data;
      }, function (e) { if (t) clearTimeout(t); throw e; });
  }

  /* ---------- IndexedDB: queue, drafts, report images ---------- */
  var db = null;
  function dbOpen() {
    return new Promise(function (res) {
      try {
        var rq = indexedDB.open('ownerQueue', 2);
        rq.onupgradeneeded = function () {
          var d = rq.result;
          if (!d.objectStoreNames.contains('q')) d.createObjectStore('q', { keyPath: 'n', autoIncrement: true });
          if (!d.objectStoreNames.contains('drafts')) d.createObjectStore('drafts', { keyPath: 'k' });
          if (!d.objectStoreNames.contains('reports')) d.createObjectStore('reports', { keyPath: 'id' });
        };
        rq.onsuccess = function () { db = rq.result; res(); };
        rq.onerror = function () { res(); };
      } catch (e) { res(); }
    });
  }
  function dbAll(store) {
    return new Promise(function (res) {
      if (!db) return res([]);
      try {
        var out = [], c = db.transaction(store).objectStore(store).openCursor();
        c.onsuccess = function () { var cur = c.result; if (cur) { out.push(cur.value); cur.continue(); } else res(out); };
        c.onerror = function () { res([]); };
      } catch (e) { res([]); }
    });
  }
  function dbPut(store, v) {
    return new Promise(function (res) {
      if (!db) { if (store === 'q') v.n = v.n || Date.now() + Math.random(); return res(v); }
      try {
        var rq = db.transaction(store, 'readwrite').objectStore(store).put(v);
        rq.onsuccess = function () { if (store === 'q') v.n = rq.result; res(v); };
        rq.onerror = function () { res(v); };
      } catch (e) { res(v); }
    });
  }
  function dbDel(store, key) {
    return new Promise(function (res) {
      if (!db) return res();
      try { var rq = db.transaction(store, 'readwrite').objectStore(store).delete(key); rq.onsuccess = rq.onerror = function () { res(); }; }
      catch (e) { res(); }
    });
  }
  function dbClear(store) {
    return new Promise(function (res) {
      if (!db) return res();
      try { var rq = db.transaction(store, 'readwrite').objectStore(store).clear(); rq.onsuccess = rq.onerror = function () { res(); }; }
      catch (e) { res(); }
    });
  }

  function enqueue(t) {
    t.cid = t.cid || uid(); t.stamp = noteStamp();
    queue.push(t);
    repaint();
    return dbPut('q', t).then(function () { pump(); });
  }
  function dropTask(t) { queue = queue.filter(function (x) { return x !== t; }); return dbDel('q', t.n); }

  /* ---------- what the screen shows = server data + changes still waiting in the queue ---------- */
  function view(it) {
    var v = { status: it.status, due: it.due, dueText: it.dueText, daysLeft: it.daysLeft,
              note: it.note, fixPhotos: (it.fixPhotos || []).slice(), pending: false };
    function addNote(s) { v.note = v.note ? v.note + '\n' + s : s; }
    if (it.local) { v.pending = true; return v; }
    queue.forEach(function (t) {
      if (t.id !== it.id) return;
      v.pending = true;
      if (t.op === 'accept') { v.status = 'Done'; addNote(t.stamp + ' ตรวจรับงานจากหน่วยงาน'); }
      if (t.op === 'close') { v.status = 'Done'; addNote(t.stamp + ' ' + (t.note ? 'ปิดงาน: ' + t.note : 'ปิดงาน')); }
      if (t.op === 'return') { v.status = 'Returned'; v.fixPhotos = []; addNote(t.stamp + ' ส่งกลับให้แก้ใหม่: ' + t.reason); }
      if (t.op === 'update') {
        if (t.status && (v.status === 'Open' || v.status === 'In progress')) v.status = t.status;
        if (t.due !== undefined) { v.due = t.due; v.dueText = t.due ? dmy(t.due) : ''; v.daysLeft = t.due ? dayDiff(todayYmd(), t.due) : null; }
        if (t.note) addNote(t.stamp + ' ' + t.note);
      }
    });
    return v;
  }
  /** New jobs still waiting to be saved, shown like normal jobs. */
  function pendingNew() {
    return queue.filter(function (t) { return t.op === 'new'; }).map(function (t) {
      return { id: t.id, site: t.site, title: t.title, detail: t.detail, category: t.category, status: 'Open',
               created: createdText(new Date(t.created)), due: t.due, dueText: t.due ? dmy(t.due) : '',
               daysLeft: t.due ? dayDiff(todayYmd(), t.due) : null, note: '', photoId: '', more: [], fixPhotos: [],
               local: t.photos.map(jpg) };
    });
  }

  /* ---------- queue runner: up to 3 at once, jobs of the same id keep their order ---------- */
  function pump() {
    qbar();
    if (!navigator.onLine) return;
    var active = queue.filter(function (x) { return x.run; }).length;
    for (var i = 0; i < queue.length && active < PARALLEL; i++) {
      var t = queue[i];
      if (t.run || !t.n) continue;   // already sending, or not stored yet
      var blocked = false;
      for (var j = 0; j < i; j++) if (queue[j].id === t.id) { blocked = true; break; }
      if (blocked) continue;
      if (t.wait && t.wait > Date.now()) continue;
      t.run = true; active++;
      send(t);
    }
  }
  function bodyOf(t) {
    var b = { a: 'own.' + t.op, o: TOK, id: t.id, cid: t.cid };
    if (t.op === 'close') { b.note = t.note; b.b64 = t.b64 || ''; }
    if (t.op === 'return') b.reason = t.reason;
    if (t.op === 'update') { if (t.due !== undefined) b.due = t.due; if (t.status) b.status = t.status; b.note = t.note || ''; }
    if (t.op === 'new') { b.site = t.site; b.title = t.title; b.detail = t.detail; b.category = t.category; b.due = t.due; b.photos = t.photos; }
    return b;
  }
  function send(t) {
    api(bodyOf(t)).then(function (res) {
      t.run = false; lastErr = '';
      applyDone(t, res);
      dropTask(t).then(function () { repaint(); if (!queue.length) refresh(true); pump(); });
    }, function (e) {
      t.run = false;
      var msg = (e && e.message) || String(e);
      if (e && e.server && /ไม่พบ|ปิดไปแล้ว|ยังไม่ได้ส่ง|เหตุผล|ไม่ถูกต้อง|ปัญหาที่พบ|Unknown/i.test(msg)) {
        if (t.op === 'new') restoreDraft(t);   // nothing lost: back to the record tab
        toast('ส่งไม่สำเร็จ: ' + msg, true, 'listMsg');
        dropTask(t).then(function () { repaint(); refresh(true); pump(); });
        return;
      }
      lastErr = msg; t.tries = (t.tries || 0) + 1; t.wait = Date.now() + Math.min(60000, 3000 * t.tries);
      qbar();
      clearTimeout(retryTimer);
      retryTimer = setTimeout(pump, Math.min(60000, 3000 * t.tries) + 50);
    });
  }
  /** Bake a finished task into the saved data, so the screen does not jump back. */
  function applyDone(t, res) {
    if (t.op === 'new') {
      var ids = res.photoIds || [];
      ids.forEach(function (fid, i) { if (t.photos[i]) localSrc[fid] = jpg(t.photos[i]); });
      var it = pendingNew().filter(function (x) { return x.id === t.id; })[0];
      if (it && data) {
        delete it.local; it.id = res.id; it.photoId = ids[0] || ''; it.more = ids.slice(1); it.ageDays = 0;
        data.items.push(it); saveList();
        if (current && current.id === t.id) { current = it; navIds[navPos] = it.id; }
      }
      makeReport(t, res.id);
      return;
    }
    var x = findOpen(t.id);
    if (!x) return;
    var saved = queue; queue = [t];
    var v = view(x);
    queue = saved;
    x.status = v.status; x.due = v.due; x.dueText = v.dueText; x.daysLeft = v.daysLeft; x.note = v.note; x.fixPhotos = v.fixPhotos;
    if (x.status === 'Done') data.items = data.items.filter(function (y) { return y !== x; });
    saveList();
  }
  function qbar() {
    var b = $('qbar');
    if (!queue.length) { b.classList.add('hidden'); return; }
    var nNew = queue.filter(function (t) { return t.op === 'new'; }).length;
    b.classList.remove('hidden');
    b.classList.toggle('err', !!lastErr || !navigator.onLine);
    b.textContent = !navigator.onLine ? '📵 ไม่มีสัญญาณ · จะส่ง ' + queue.length + ' รายการให้เองเมื่อออนไลน์ (เปิดแอปค้างไว้)'
      : lastErr ? '⚠ ส่งไม่สำเร็จ กำลังลองใหม่ (' + queue.length + ' รายการ)'
      : '⏳ กำลังส่ง ' + queue.length + ' รายการ' + (nNew ? ' (งานใหม่ ' + nNew + ')' : '') + ' · ทำงานต่อได้เลย';
  }
  window.addEventListener('online', function () { clearTimeout(retryTimer); queue.forEach(function (t) { t.wait = 0; }); pump(); refresh(true); });
  window.addEventListener('offline', qbar);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') { pump(); refresh(true); }
  });

  /* ---------- data ---------- */
  function findOpen(id) {
    if (!data) return null;
    for (var i = 0; i < data.items.length; i++) if (data.items[i].id === id) return data.items[i];
    return null;
  }
  function findAny(id) {
    var x = findOpen(id);
    if (x) return x;
    var p = pendingNew().filter(function (y) { return y.id === id; })[0];
    if (p) return p;
    if (done) for (var i = 0; i < done.items.length; i++) if (done.items[i].id === id) return done.items[i];
    return null;
  }
  function saveList() { if (data) lsSet('ownerList', JSON.stringify(data)); }
  function refresh(quiet) {
    if (!TOK) return;
    if (loading) { again = true; return; }
    loading = true; again = false;
    if (!quiet) $('refBtn').innerHTML = '<span class="spin">⟳</span>';
    var wantDone = tab === 'done' || navFrom === 'done';
    api({ a: 'own.list', o: TOK }).then(function (d) {
      loading = false; $('refBtn').textContent = '⟳';
      if (again) return refresh(true);
      data = d; saveList(); $('topMsg').innerHTML = '';
      if (current && !current.local) { var it = findOpen(current.id); if (it) current = it; }
      repaint();
      if (wantDone) loadDone();
    }, function (e) {
      loading = false; $('refBtn').textContent = '⟳';
      if (again) return refresh(true);
      if (e && e.server) $('topMsg').innerHTML = '<div class="msg err-m">' + esc(e.message) + '</div>';
      else if (!data) $('topMsg').innerHTML = '<div class="msg err-m">เชื่อมต่อไม่ได้ ลองกด ⟳ อีกครั้ง</div>';
      subLine();
    });
  }
  function loadDone() {
    api({ a: 'own.done', o: TOK }).then(function (d) {
      done = d; lsSet('ownerDone', JSON.stringify(d)); $('doneMsg').innerHTML = ''; repaint();
    }, function (e) {
      if (!done) $('doneMsg').innerHTML = '<div class="msg err-m">' + esc(e && e.server ? e.message : 'เชื่อมต่อไม่ได้ ลองกด ⟳') + '</div>';
    });
  }
  function subLine() {
    if (!data) return;
    var min = Math.round((Date.now() - data.at) / 60000);
    $('sub').textContent = min < 1 ? 'อัปเดตเมื่อสักครู่' : 'อัปเดตเมื่อ ' + (min < 60 ? min + ' นาทีที่แล้ว' : Math.round(min / 60) + ' ชม.ที่แล้ว');
  }
  setInterval(subLine, 30000);

  /* ---------- tabs ---------- */
  function go(t) {
    tab = t;
    if (current) { current = null; history.replaceState(null, '', location.pathname + location.search); }
    ['list', 'new', 'done', 'units'].forEach(function (x) {
      $('pg' + { list: 'List', 'new': 'New', done: 'Done', units: 'Units' }[x]).classList.toggle('hidden', x !== t);
    });
    $('pgDetail').classList.add('hidden');
    $('backBtn').classList.add('hidden'); $('refBtn').classList.remove('hidden');
    $('hdr').textContent = { list: 'สมุดตรวจงาน', 'new': 'บันทึกงานใหม่', done: 'งานที่ปิดแล้ว', units: 'หน่วยงาน' }[t];
    Array.prototype.forEach.call(document.querySelectorAll('#tabs button'), function (b) { b.classList.toggle('on', b.getAttribute('data-t') === t); });
    if (t === 'done') { if (!done) { try { done = JSON.parse(lsGet('ownerDone') || 'null'); } catch (e) {} } loadDone(); }
    repaint();
    window.scrollTo(0, 0);
  }
  $('tabs').addEventListener('click', function (ev) {
    var b = ev.target.closest('button');
    if (b) go(b.getAttribute('data-t'));
  });

  function repaint() {
    subLine(); qbar();
    var n = drafts.length;
    $('tNew').textContent = n; $('tNew').classList.toggle('hidden', !n);
    if (current) { renderDetail(); return; }
    if (tab === 'list') renderList();
    if (tab === 'done') renderDone();
    if (tab === 'units') renderUnits();
    if (tab === 'new') renderNewTop();
  }

  /* ---------- open jobs ---------- */
  function kind(v) {
    if (v.status === 'Review') return 'rev';
    if (v.status === 'Returned') return 'ret';
    if (v.daysLeft !== null && v.daysLeft < 0) return 'over';
    if (v.daysLeft !== null && v.daysLeft <= 2) return 'soon';
    return '';
  }
  function badges(it, v) {
    var b = '';
    if (it.local) b += '<span class="badge wait">⏳ กำลังบันทึก</span>';
    else if (v.pending) b += '<span class="badge wait">⏳ รอส่ง</span>';
    if (v.status === 'Done') return b + '<span class="badge">🔒 ปิดแล้ว ' + esc(it.closed || '') + '</span>';
    if (v.status === 'Review') return b + '<span class="badge rev">📥 รอตรวจรับ</span>';
    if (v.status === 'Returned') b += '<span class="badge ret">↩️ ส่งกลับแล้ว</span>';
    if (v.status === 'In progress') b += '<span class="badge prog">🔧 กำลังแก้</span>';
    if (v.daysLeft === null) b += '<span class="badge">ไม่มีกำหนด</span>';
    else if (v.daysLeft < 0) b += '<span class="badge over">⚠ เกินกำหนด ' + (-v.daysLeft) + ' วัน</span>';
    else if (v.daysLeft === 0) b += '<span class="badge soon">ครบกำหนดวันนี้</span>';
    else if (v.daysLeft <= 2) b += '<span class="badge soon">เหลือ ' + v.daysLeft + ' วัน</span>';
    else b += '<span class="badge">ครบ ' + esc(v.dueText) + '</span>';
    if (v.fixPhotos.length) b += '<span class="badge">📎 รูปร่าง ' + v.fixPhotos.length + '</span>';
    if (it.more && it.more.length) b += '<span class="badge">📷 ' + (it.more.length + 1) + ' มุม</span>';
    return b;
  }
  function openItems() {
    if (!data) return pendingNew();
    return pendingNew().concat(data.items.filter(function (it) { return view(it).status !== 'Done'; }));
  }
  function matches(it, f) {
    var v = view(it);
    if (f === 'rev') return v.status === 'Review';
    if (f === 'over') return v.status !== 'Review' && v.daysLeft !== null && v.daysLeft < 0;
    if (f === 'soon') return v.status !== 'Review' && v.daysLeft !== null && v.daysLeft >= 0 && v.daysLeft <= 2;
    return true;
  }
  function visible() {
    return openItems().filter(function (it) { return (!filt.site || it.site === filt.site) && matches(it, filt.f); });
  }
  function fillSites(sel, withAll) {
    var sites = (data && data.sites) || [];
    var want = (withAll ? 1 : 0) + sites.length;
    if (sel.options.length === want && sel.getAttribute('data-n') === sites.join('|')) return;
    sel.innerHTML = (withAll ? '<option value="">ทุกหน่วยงาน</option>' : '') + sites.map(function (s) {
      return '<option value="' + esc(s) + '">' + esc(s) + '</option>';
    }).join('');
    sel.setAttribute('data-n', sites.join('|'));
  }
  function renderList() {
    if (!TOK) {
      $('sub').textContent = '';
      $('topMsg').innerHTML = '<div class="msg err-m">กรุณาเปิดจากลิงก์ผู้ตรวจ (ลิงก์ที่มี ?o=...)</div>';
      return;
    }
    if (!data) { $('list').innerHTML = '<div class="empty">กำลังโหลด...</div>'; return; }
    fillSites($('fSite'), true);
    $('fSite').value = filt.site;
    var base = openItems().filter(function (it) { return !filt.site || it.site === filt.site; });
    $('cAll').textContent = base.length;
    $('cRev').textContent = base.filter(function (it) { return matches(it, 'rev'); }).length;
    $('cOver').textContent = base.filter(function (it) { return matches(it, 'over'); }).length;
    $('cSoon').textContent = base.filter(function (it) { return matches(it, 'soon'); }).length;
    Array.prototype.forEach.call(document.querySelectorAll('.chip'), function (c) { c.classList.toggle('on', c.getAttribute('data-f') === filt.f); });
    var list = visible();
    $('list').innerHTML = list.length ? list.map(card).join('') : '<div class="empty">✨ ไม่มีงานในกลุ่มนี้</div>';
  }
  function thumbSrc(it, w) {
    if (it.local && it.local.length) return it.local[0];
    if (!it.photoId) return '';
    return localSrc[it.photoId] || thumb(it.photoId, w);
  }
  function card(it) {
    var v = view(it), src = thumbSrc(it, 240);
    return '<div class="card ' + (it.closed ? '' : kind(v)) + '" data-id="' + esc(it.id) + '">' +
      '<div class="th">' + (src ? '<img loading="lazy" decoding="async" alt="" src="' + esc(src) + '">' : '') + '</div>' +
      '<div class="bd"><div class="top"><span class="site">' + esc(it.site) + '</span><span>' + (it.local ? '' : esc(it.id)) + '</span></div>' +
      '<div class="title">' + esc(it.title || '(ไม่มีหัวข้อ)') + '</div>' + badges(it, v) +
      '<div class="d-meta" style="margin:2px 0 0;font-size:12.5px">' + (it.category ? esc(it.category) + ' · ' : '') +
      (it.closed ? 'ปิดเมื่อ ' + esc(it.closed) : 'แจ้งเมื่อ ' + esc(it.created)) + '</div></div></div>';
  }
  $('list').addEventListener('click', function (ev) {
    var c = ev.target.closest('.card');
    if (c) openDetail(c.getAttribute('data-id'), visible(), 'list');
  });
  $('chips').addEventListener('click', function (ev) {
    var c = ev.target.closest('.chip');
    if (!c) return;
    var f = c.getAttribute('data-f');
    filt.f = (filt.f === f && f !== 'all') ? 'all' : f;
    lsSet('ownerFilt', filt.f); repaint();
  });
  $('fSite').addEventListener('change', function () { filt.site = this.value; lsSet('ownerSite', filt.site); repaint(); });

  /* ---------- closed jobs ---------- */
  function doneVisible() {
    if (!done) return [];
    return done.items.filter(function (it) { return !filt.site || it.site === filt.site; });
  }
  function renderDone() {
    fillSites($('dSite'), true);
    $('dSite').value = filt.site;
    if (!done) { $('doneList').innerHTML = '<div class="empty">กำลังโหลด...</div>'; return; }
    var all = doneVisible();
    var week = all.filter(function (it) { return it.closedAgo <= 7; }), older = all.filter(function (it) { return it.closedAgo > 7; });
    var h = '<div class="grp">ปิดใน 7 วันล่าสุด (' + week.length + ')</div>' + (week.length ? week.map(card).join('') : '<div class="empty">ไม่มี</div>');
    if (older.length) h += '<div class="grp">เก่ากว่า 7 วัน (' + older.length + ')</div>' + older.map(card).join('');
    $('doneList').innerHTML = h;
  }
  $('doneList').addEventListener('click', function (ev) {
    var c = ev.target.closest('.card');
    if (c) openDetail(c.getAttribute('data-id'), doneVisible(), 'done');
  });
  $('dSite').addEventListener('change', function () { filt.site = this.value; lsSet('ownerSite', filt.site); repaint(); });

  /* ---------- units: share link + counts to the unit's LINE group ---------- */
  function unitCounts(site) {
    var c = { open: 0, overdue: 0, review: 0, returned: 0, today: 0 };
    var today = createdText(new Date()).slice(0, 8);
    openItems().forEach(function (it) {
      if (it.site !== site || it.local) return;
      var v = view(it);
      if (v.status === 'Done') return;
      if (v.status === 'Review') { c.review++; return; }
      c.open++;
      if (v.status === 'Returned') c.returned++;
      if (v.daysLeft !== null && v.daysLeft < 0) c.overdue++;
      if (String(it.created).slice(0, 8) === today) c.today++;
    });
    return c;
  }
  function unitUrl(u) { return u.key ? UNIT_BASE + '?k=' + encodeURIComponent(u.key) : ''; }
  function unitText(u) {
    var c = unitCounts(u.site), t = '📋 แจ้งงานตรวจ · ' + u.site + '\n';
    t += c.open ? 'มีงานที่ต้องแก้ไข ' + c.open + ' เรื่อง' : 'ไม่มีงานค้าง 👍';
    if (c.today) t += '\n🆕 งานใหม่วันนี้ ' + c.today + ' เรื่อง';
    if (c.overdue) t += '\n⚠️ เกินกำหนด ' + c.overdue + ' เรื่อง';
    if (c.returned) t += '\n↩️ ส่งกลับให้แก้ใหม่ ' + c.returned + ' เรื่อง';
    t += '\n\nกดเปิดดู แก้ไขแล้วถ่ายรูปแจ้งกลับได้ที่ลิงก์นี้:\n' + unitUrl(u);
    return t;
  }
  function renderUnits() {
    if (!data || !data.units) { $('unitList').innerHTML = '<div class="empty">กำลังโหลด...</div>'; return; }
    $('unitList').innerHTML = data.units.map(function (u, i) {
      var c = unitCounts(u.site), ch = '<span class="badge">ต้องแก้ ' + c.open + '</span>';
      if (c.today) ch += '<span class="badge prog">ใหม่วันนี้ ' + c.today + '</span>';
      if (c.overdue) ch += '<span class="badge over">เกินกำหนด ' + c.overdue + '</span>';
      if (c.returned) ch += '<span class="badge ret">ส่งกลับ ' + c.returned + '</span>';
      if (c.review) ch += '<span class="badge rev">รอตรวจรับ ' + c.review + '</span>';
      var ok = !!u.key;
      return '<div class="unit"><div class="nm">' + esc(u.site) + '</div><div>' + ch + '</div>' +
        (ok ? '' : '<div class="hint">ยังไม่มีรหัสในแท็บ Sites คอลัมน์ B</div>') +
        '<div class="acts"><button type="button" class="sh" data-i="' + i + '"' + (ok ? '' : ' disabled') + '>📤 แชร์แจ้งเตือน</button>' +
        '<button type="button" class="cp" data-i="' + i + '"' + (ok ? '' : ' disabled') + '>🔗 คัดลอกลิงก์</button></div></div>';
    }).join('') || '<div class="empty">ยังไม่มีหน่วยงานในแท็บ Sites</div>';
  }
  function shareFallback(text) {
    var ta = $('shareText');
    ta.classList.remove('hidden'); ta.value = text; ta.focus(); ta.select();
    toast('แชร์จากหน้านี้ไม่ได้ ข้อความอยู่ในกล่องด้านบนแล้ว กดค้างแล้วเลือก "คัดลอก"', true, 'unitMsg');
  }
  // share must run directly inside the tap (iPhone rule)
  $('unitList').addEventListener('click', function (ev) {
    var b = ev.target.closest('button[data-i]');
    if (!b) return;
    var u = data.units[+b.getAttribute('data-i')];
    if (b.classList.contains('sh')) {
      var text = unitText(u);
      try {
        if (navigator.share) {
          navigator.share({ text: text }).catch(function (e) { if (e && e.name !== 'AbortError') shareFallback(text); });
          return;
        }
      } catch (e) {}
      shareFallback(text);
    } else {
      var url = unitUrl(u);
      try {
        navigator.clipboard.writeText(url).then(function () { toast('✅ คัดลอกลิงก์ ' + u.site + ' แล้ว', false, 'unitMsg'); },
          function () { shareFallback(url); });
      } catch (e) { shareFallback(url); }
    }
  });

  /* ---------- detail ---------- */
  function openDetail(id, list, from) {
    var it = findAny(id);
    if (!it) return;
    navFrom = from;
    navIds = list.map(function (x) { return x.id; });
    if (navIds.indexOf(id) === -1) navIds = [id];
    navPos = navIds.indexOf(id);
    show(it, true);
  }
  function show(it, push) {
    current = it;
    var st = { id: it.id, from: navFrom };
    if (push) history.pushState(st, '', '#' + encodeURIComponent(it.id)); else history.replaceState(st, '', '#' + encodeURIComponent(it.id));
    ['pgList', 'pgNew', 'pgDone', 'pgUnits'].forEach(function (p) { $(p).classList.add('hidden'); });
    $('pgDetail').classList.remove('hidden');
    $('backBtn').classList.remove('hidden'); $('refBtn').classList.add('hidden');
    $('dMsg').innerHTML = ''; $('rReason').value = ''; $('mNote').value = ''; $('cNote').value = '';
    setClosePhoto(null);
    var img = $('dPhoto'), src = it.local ? it.local[0] : (it.photoId ? (localSrc[it.photoId] || thumb(it.photoId, 1000)) : '');
    img.classList.toggle('hidden', !src);
    img.removeAttribute('src');
    if (src) img.src = src;
    var more = it.local ? it.local.slice(1).map(function (s) { return { src: s, full: s }; })
      : (it.more || []).map(function (f) { return { src: localSrc[f] || thumb(f, 400), full: localSrc[f] || thumb(f, 2000) }; });
    $('dMore').innerHTML = more.map(function (m) { return '<img alt="" data-src="' + esc(m.full) + '" src="' + esc(m.src) + '">'; }).join('');
    renderDetail();
    window.scrollTo(0, 0);
    [navPos - 1, navPos + 1].forEach(function (p) {
      var x = findAny(navIds[p]);
      if (x && x.photoId && !localSrc[x.photoId]) { var im = new Image(); im.src = thumb(x.photoId, 1000); }
    });
  }
  function renderDetail() {
    if (!current) return;
    var it = current, v = view(it);
    $('hdr').textContent = (it.local ? 'งานใหม่' : it.id) + ' · ' + it.site;
    $('dPos').textContent = (navPos + 1) + ' / ' + navIds.length;
    $('dPrev').disabled = navPos <= 0; $('dNext').disabled = navPos >= navIds.length - 1;
    $('dTop').textContent = (it.category ? it.category + ' · ' : '') + 'แจ้งเมื่อ ' + it.created;
    $('dTitle').textContent = it.title || '(ไม่มีหัวข้อ)';
    $('dBadges').innerHTML = badges(it, v);
    $('dDetail').textContent = it.detail || '';
    $('dDetailWrap').classList.toggle('hidden', !it.detail);
    $('dNote').textContent = v.note || '';
    $('dNoteWrap').classList.toggle('hidden', !v.note);
    var isDone = v.status === 'Done', rev = v.status === 'Review', locked = isDone || !!it.local;
    $('revBox').classList.toggle('hidden', !rev);
    $('revThumbs').innerHTML = rev ? v.fixPhotos.map(fixImg).join('') : '';
    var shots = v.fixPhotos.slice();
    if (isDone && it.closePhotoId) shots.push(it.closePhotoId);
    var box = !rev && shots.length > 0;
    $('draftBox').classList.toggle('hidden', !box);
    if (box) {
      $('draftLbl').textContent = isDone ? '📷 รูปหลังแก้ / รูปตอนปิดงาน' : '📎 หน่วยงานแนบรูปไว้ ' + shots.length + ' รูป (ยังไม่กดยืนยันส่ง)';
      $('draftThumbs').innerHTML = shots.map(fixImg).join('');
    }
    $('manBox').classList.toggle('hidden', locked);
    $('closeBox').classList.toggle('hidden', locked);
    var canSeg = v.status === 'Open' || v.status === 'In progress';
    $('segWrap').classList.toggle('hidden', !canSeg);
    Array.prototype.forEach.call(document.querySelectorAll('.seg button'), function (b) { b.classList.toggle('on', b.getAttribute('data-s') === v.status); });
    if (document.activeElement !== $('mDue')) $('mDue').value = v.due || '';
  }
  function fixImg(id) { return '<img loading="lazy" alt="" data-src="' + esc(thumb(id, 2000)) + '" src="' + esc(thumb(id, 400)) + '">'; }

  function step(d) {
    var p = navPos + d;
    while (p >= 0 && p < navIds.length) {
      var x = findAny(navIds[p]);
      if (x && (navFrom === 'done' || view(x).status !== 'Done')) { navPos = p; show(x, false); return true; }
      p += d;
    }
    return false;
  }
  $('dPrev').addEventListener('click', function () { step(-1); });
  $('dNext').addEventListener('click', function () { step(1); });
  var sx = 0, sy = 0;
  $('pgDetail').addEventListener('touchstart', function (e) { sx = e.touches[0].clientX; sy = e.touches[0].clientY; }, { passive: true });
  $('pgDetail').addEventListener('touchend', function (e) {
    var dx = e.changedTouches[0].clientX - sx, dy = e.changedTouches[0].clientY - sy;
    if (Math.abs(dx) > 70 && Math.abs(dy) < 50) step(dx < 0 ? 1 : -1);
  }, { passive: true });

  function leaveDetail() {
    current = null;
    $('pgDetail').classList.add('hidden');
    go(navFrom === 'done' ? 'done' : 'list');
  }
  function backToList() { if (history.state && history.state.id) history.back(); else leaveDetail(); }
  $('backBtn').addEventListener('click', backToList);
  window.addEventListener('popstate', function (e) {
    if (e.state && e.state.id && findAny(e.state.id)) { navFrom = e.state.from || 'list'; show(findAny(e.state.id), false); }
    else if (current) leaveDetail();
  });
  $('refBtn').addEventListener('click', function () { queue.forEach(function (t) { t.wait = 0; }); refresh(false); pump(); if (tab === 'done') loadDone(); });

  /* full screen photo */
  var viewRep = -1;
  function openViewer(src, repIdx) {
    viewRep = repIdx === undefined ? -1 : repIdx;
    $('vBar').classList.toggle('hidden', viewRep < 0);
    $('vImg').src = src; $('viewer').classList.remove('hidden');
  }
  $('viewer').addEventListener('click', function (ev) {
    if (ev.target.closest('#vBar')) return;
    $('viewer').classList.add('hidden'); $('vImg').removeAttribute('src');
  });
  $('dPhoto').addEventListener('click', function () {
    if (!current) return;
    openViewer(current.local ? current.local[0] : (localSrc[current.photoId] || thumb(current.photoId, 2000)));
  });
  ['revThumbs', 'draftThumbs', 'dMore'].forEach(function (b) {
    $(b).addEventListener('click', function (ev) {
      var im = ev.target.closest('img[data-src]');
      if (im) openViewer(im.getAttribute('data-src'));
    });
  });

  function afterFinish(text) {
    var moved = step(1) || step(-1);
    if (!moved) backToList();
    toast(text, false, moved ? 'dMsg' : 'listMsg');
  }

  /* review */
  $('rOk').addEventListener('click', function () {
    if (!current || !confirm('ตรวจรับและปิดงาน ' + current.id + ' ?')) return;
    enqueue({ op: 'accept', id: current.id });
    afterFinish('✅ ตรวจรับ ' + current.id + ' แล้ว');
  });
  $('rBack').addEventListener('click', function () {
    var r = $('rReason').value.trim();
    if (!r) { toast('กรุณาใส่เหตุผลที่ส่งกลับ', true); $('rReason').focus(); return; }
    enqueue({ op: 'return', id: current.id, reason: r });
    $('rReason').value = '';
    toast('↩️ ส่งกลับให้หน่วยงานแล้ว', false);
  });

  /* follow up */
  Array.prototype.forEach.call(document.querySelectorAll('.seg button'), function (b) {
    b.addEventListener('click', function () {
      var s = b.getAttribute('data-s');
      if (!current || view(current).status === s) return;
      enqueue({ op: 'update', id: current.id, status: s, note: s === 'In progress' ? 'เปลี่ยนสถานะ: กำลังแก้' : 'เปลี่ยนสถานะ: รอแก้' });
    });
  });
  $('mSave').addEventListener('click', function () {
    if (!current) return;
    var v = view(current), due = $('mDue').value, note = $('mNote').value.trim();
    var t = { op: 'update', id: current.id };
    if (due !== (v.due || '')) { t.due = due; note = (note ? note + ' · ' : '') + 'กำหนดเสร็จ ' + (due ? dmy(due) : 'ไม่มีกำหนด'); }
    if (t.due === undefined && !note) { toast('ยังไม่มีอะไรเปลี่ยน', true); return; }
    t.note = note;
    enqueue(t);
    $('mNote').value = '';
    toast('💾 บันทึกแล้ว', false);
  });

  /* close by myself */
  function setClosePhoto(b64) {
    closePhoto = b64;
    $('cPrev').classList.toggle('hidden', !b64);
    if (b64) $('cImg').src = jpg(b64); else $('cImg').removeAttribute('src');
  }
  function resizeFile(file, cb) {
    var url = URL.createObjectURL(file), img = new Image();
    img.onload = function () {
      var s = Math.min(1, MAX_SIDE / Math.max(img.width, img.height));
      var c = document.createElement('canvas');
      c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url); cb(c.toDataURL('image/jpeg', 0.78).split(',')[1]);
    };
    img.onerror = function () { URL.revokeObjectURL(url); cb(null); };
    img.src = url;
  }
  ['cCam', 'cLib'].forEach(function (id) {
    $(id).addEventListener('change', function () {
      var f = this.files && this.files[0]; this.value = '';
      if (f) resizeFile(f, setClosePhoto);
    });
  });
  $('cDrop').addEventListener('click', function () { setClosePhoto(null); });
  $('cBtn').addEventListener('click', function () {
    if (!current || !confirm('ปิดงาน ' + current.id + ' ?')) return;
    enqueue({ op: 'close', id: current.id, note: $('cNote').value.trim(), b64: closePhoto || '' });
    afterFinish('🔒 ปิดงาน ' + current.id + ' แล้ว');
  });

  /* ======================= record new jobs ======================= */
  /* draft = {k, n (order), site, siteCustom, cat (index|null), probs[], title, titleAuto, detail, due, dueAuto,
              shots:[{orig:b64, marks:[[x0,y0,x1,y1]...], out:b64|null}], time} */
  var draftSeq = 0, addTarget = null, saveTimers = {};
  function cats() { return (data && data.cats) || []; }
  function lastSite() { var s = lsGet('lastSite') || ''; return (data && data.sites.indexOf(s) !== -1) ? s : ((data && data.sites[0]) || ''); }
  function persist(d) {
    clearTimeout(saveTimers[d.k]);
    saveTimers[d.k] = setTimeout(function () { dbPut('drafts', d); }, 300);
  }
  function renderNewTop() {
    fillSites($('nSite'), false);
    // drafts restored before the server data arrived: redraw once sites and categories are known
    var nS = ((data && data.sites) || []).length, nC = cats().length;
    drafts.forEach(function (d) {
      var e = $('dr' + d.k);
      if (e && (e.querySelector('[data-f=site]').options.length !== nS || e.querySelectorAll('.cats .pill').length !== nC) && nS) drawDraft(d);
    });
    if (!$('nSite').value || document.activeElement !== $('nSite')) $('nSite').value = lastSite();
    $('nSave').textContent = '💾 บันทึกทั้งหมด (' + drafts.length + ' เรื่อง)';
    $('nSave').classList.toggle('hidden', !drafts.length);
    drafts.forEach(function (d, i) { var e = $('dr' + d.k); if (e) e.querySelector('.dnum').textContent = 'เรื่องที่ ' + (i + 1) + ' / ' + drafts.length; });
    renderReps();
  }
  function shotSrc(s) { return jpg(s.out || s.orig); }
  function addDraft(shot, time, restore) {
    var d = restore || { k: ++draftSeq, n: Date.now() + Math.random(), site: $('nSite').value || lastSite(), siteCustom: false, cat: null,
                         probs: [], title: '', titleAuto: '', detail: '', due: '', dueAuto: '',
                         shots: shot ? [shot] : [], time: time || '' };
    if (restore) draftSeq = Math.max(draftSeq, d.k);
    drafts.push(d);
    var div = document.createElement('div');
    div.className = 'draft'; div.id = 'dr' + d.k;
    $('drafts').appendChild(div);
    drawDraft(d);
    if (!restore) persist(d);
    repaint();
    return d;
  }
  function drawDraft(d) {
    var div = $('dr' + d.k), C = cats();
    var siteOpts = ((data && data.sites) || [d.site]).map(function (s) {
      return '<option value="' + esc(s) + '"' + (s === d.site ? ' selected' : '') + '>' + esc(s) + '</option>';
    }).join('');
    div.innerHTML =
      '<div class="dhead"><span><b class="dnum"></b>' + (d.time ? ' · ถ่าย ' + esc(d.time) : '') + '</span>' +
      '<button type="button" data-act="del" aria-label="ลบ">✕</button></div>' +
      '<div class="shots"></div>' +
      '<div class="hint">แตะรูปเพื่อวงจุดที่ต้องแก้ · เพิ่มได้ถึง 3 มุม</div>' +
      '<select data-f="site">' + siteOpts + '</select>' +
      (C.length ? '<div class="pills cats">' + C.map(function (c, i) {
        return '<button type="button" class="pill' + (d.cat === i ? ' on' : '') + '" data-cat="' + i + '">' + esc(c.name) + '</button>';
      }).join('') + '</div><div class="pills probs"></div>' : '') +
      '<input type="text" data-f="title" placeholder="ปัญหาที่พบ * (กดเลือกด้านบน หรือพิมพ์เอง)">' +
      '<textarea data-f="detail" placeholder="รายละเอียด / สิ่งที่ต้องทำ เช่น ย้ายถังน้ำขึ้นไปบนแท่น"></textarea>' +
      '<span class="sm">กำหนดแก้เสร็จ (ไม่บังคับ)</span><input type="date" data-f="due">';
    div.querySelector('[data-f=title]').value = d.title;
    div.querySelector('[data-f=detail]').value = d.detail;
    div.querySelector('[data-f=due]').value = d.due;
    drawProbs(d); drawShots(d);
  }
  function drawProbs(d) {
    var box = $('dr' + d.k).querySelector('.probs'), C = cats();
    if (!box) return;
    box.innerHTML = (d.cat === null || !C[d.cat]) ? '' : C[d.cat].items.map(function (p, i) {
      return '<button type="button" class="pill' + (d.probs.indexOf(p) !== -1 ? ' on' : '') + '" data-prob="' + i + '">' + esc(p) + '</button>';
    }).join('');
  }
  function drawShots(d) {
    var box = $('dr' + d.k).querySelector('.shots');
    box.innerHTML = d.shots.map(function (s, i) {
      return '<div class="shot"><img alt="" data-shot="' + i + '" src="' + shotSrc(s) + '">' +
        '<span class="tag">' + (i === 0 ? 'รูปหลัก' : 'มุม ' + (i + 1)) + '</span>' +
        (s.marks && s.marks.length ? '<span class="mk">⭕ ' + s.marks.length + '</span>' : '') +
        '<button type="button" class="rm" data-rm="' + i + '">✕</button></div>';
    }).join('') + (d.shots.length < MAX_SHOTS ? '<div class="addshot"><button type="button" data-add="cam">📷 ถ่ายเพิ่ม</button>' +
      '<button type="button" data-add="lib">🖼️ เพิ่มจากคลัง</button></div>' : '');
  }
  function draftOf(el) {
    var div = el.closest('.draft'), k = div && +div.id.slice(2);
    for (var i = 0; i < drafts.length; i++) if (drafts[i].k === k) return drafts[i];
    return null;
  }
  function applyAuto(d) {
    var div = $('dr' + d.k), title = div.querySelector('[data-f=title]'), due = div.querySelector('[data-f=due]');
    var auto = d.probs.join(', '), prev = d.titleAuto || '', cur = title.value, extra = null;
    if (!prev) extra = cur.trim();
    else if (cur.indexOf(prev) === 0) extra = cur.slice(prev.length).trim();
    if (extra !== null) title.value = [auto, extra].filter(function (s) { return s; }).join(' ');
    d.titleAuto = auto; d.title = title.value;
    if (d.title) div.classList.remove('missing');
    var C = cats(), days = (d.cat !== null && C[d.cat] && C[d.cat].days > 0) ? C[d.cat].days : 0, nd = '';
    if (days) { var t = new Date(); t.setDate(t.getDate() + days); nd = ymdOf(t); }
    if (due.value === '' || due.value === (d.dueAuto || '')) due.value = nd;
    d.dueAuto = nd; d.due = due.value;
  }
  $('drafts').addEventListener('click', function (ev) {
    var el = ev.target, d = draftOf(el);
    if (!d) return;
    var b;
    if ((b = el.closest('[data-act=del]'))) {
      if ((d.title || d.detail) && !confirm('ลบเรื่องนี้?')) return;
      drafts = drafts.filter(function (x) { return x !== d; });
      $('dr' + d.k).remove(); dbDel('drafts', d.k); repaint(); return;
    }
    if ((b = el.closest('[data-cat]'))) {
      var ci = +b.getAttribute('data-cat');
      d.cat = d.cat === ci ? null : ci; d.probs = [];
      Array.prototype.forEach.call($('dr' + d.k).querySelectorAll('.cats .pill'), function (p, i) { p.classList.toggle('on', i === d.cat); });
      drawProbs(d); applyAuto(d); persist(d); return;
    }
    if ((b = el.closest('[data-prob]'))) {
      var p = cats()[d.cat].items[+b.getAttribute('data-prob')], at = d.probs.indexOf(p);
      if (at === -1) d.probs.push(p); else d.probs.splice(at, 1);
      b.classList.toggle('on', at === -1); applyAuto(d); persist(d); return;
    }
    if ((b = el.closest('[data-rm]'))) {
      if (!confirm('ลบรูปนี้?')) return;
      d.shots.splice(+b.getAttribute('data-rm'), 1); drawShots(d); persist(d); return;
    }
    if ((b = el.closest('[data-shot]'))) { openEditor(d, +b.getAttribute('data-shot')); return; }
    if ((b = el.closest('[data-add]'))) { addTarget = d; $(b.getAttribute('data-add') === 'cam' ? 'aCam' : 'aLib').click(); }
  });
  $('drafts').addEventListener('input', function (ev) {
    var f = ev.target.getAttribute('data-f'), d = draftOf(ev.target);
    if (!d || !f) return;
    if (f === 'site') { d.site = ev.target.value; d.siteCustom = true; }
    else d[f] = ev.target.value;
    if (f === 'title' && d.title.trim()) $('dr' + d.k).classList.remove('missing');
    persist(d);
  });
  $('drafts').addEventListener('change', function (ev) {
    var d = draftOf(ev.target);
    if (d && ev.target.getAttribute('data-f') === 'site') { d.site = ev.target.value; d.siteCustom = true; persist(d); }
  });
  $('nSite').addEventListener('change', function () {
    var v = this.value; lsSet('lastSite', v);
    drafts.forEach(function (d) {
      if (d.siteCustom) return;
      d.site = v; var s = $('dr' + d.k).querySelector('[data-f=site]'); if (s) s.value = v; persist(d);
    });
  });
  function readFiles(files, each, done) {
    files = Array.prototype.slice.call(files || []);
    files.sort(function (a, b) { return (a.lastModified || 0) - (b.lastModified || 0); });   // walking order
    var i = 0;
    (function next() {
      if (i >= files.length) { $('prep').textContent = ''; if (done) done(); return; }
      if (files.length > 1) $('prep').textContent = 'กำลังเตรียมรูป ' + (i + 1) + ' / ' + files.length + ' ...';
      var f = files[i++];
      resizeFile(f, function (b64) {
        if (b64) {
          var t = f.lastModified ? new Date(f.lastModified) : null;
          each({ orig: b64, marks: [], out: null }, t ? z(t.getHours()) + ':' + z(t.getMinutes()) : '');
        }
        setTimeout(next, 0);
      });
    })();
  }
  $('nLibBtn').addEventListener('click', function () { $('nLib').click(); });
  $('nCamBtn').addEventListener('click', function () { $('nCam').click(); });
  $('nNoPic').addEventListener('click', function () { var d = addDraft(null, ''); $('dr' + d.k).querySelector('[data-f=title]').focus(); });
  ['nLib', 'nCam'].forEach(function (id) {
    $(id).addEventListener('change', function () {
      var fs = Array.prototype.slice.call(this.files || []); this.value = '';
      readFiles(fs, function (shot, time) { addDraft(shot, time); });
    });
  });
  ['aLib', 'aCam'].forEach(function (id) {
    $(id).addEventListener('change', function () {
      var d = addTarget, fs = Array.prototype.slice.call(this.files || []); this.value = '';
      if (!d) return;
      readFiles(fs, function (shot) {
        if (d.shots.length >= MAX_SHOTS) return;
        d.shots.push(shot); drawShots(d); persist(d);
        openEditor(d, d.shots.length - 1);
      });
    });
  });

  $('nSave').addEventListener('click', function () {
    if (!drafts.length) return;
    var first = null;
    drafts.forEach(function (d) {
      var div = $('dr' + d.k);
      d.title = div.querySelector('[data-f=title]').value.trim();
      if (!d.title) { div.classList.add('missing'); if (!first) first = div; }
    });
    if (first) {
      toast('❌ ยังไม่ได้ใส่ "ปัญหาที่พบ" (กรอบสีแดง)', true, 'nMsg');
      first.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    var n = drafts.length, C = cats();
    drafts.forEach(function (d) {
      var div = $('dr' + d.k);
      enqueue({ op: 'new', id: 'NEW-' + uid(), created: Date.now(), site: d.site, title: d.title,
                detail: div.querySelector('[data-f=detail]').value.trim(), due: div.querySelector('[data-f=due]').value,
                category: (d.cat !== null && C[d.cat]) ? C[d.cat].name : '',
                photos: d.shots.map(function (s) { return s.out || s.orig; }) });
      dbDel('drafts', d.k);
    });
    drafts = []; $('drafts').innerHTML = '';
    window.scrollTo(0, 0);
    repaint();
    toast('📨 รับ ' + n + ' เรื่องแล้ว กำลังส่งเบื้องหลัง · ทำอย่างอื่นต่อได้เลย (เปิดแอปค้างไว้จนแถบเหลืองหายไป)', false, 'nMsg', 9000);
  });
  /** A job the server refused for good goes back to the record tab, so nothing typed is lost. */
  function restoreDraft(t) {
    var d = addDraft(null, '');
    d.site = t.site; d.siteCustom = true; d.title = t.title; d.detail = t.detail; d.due = t.due;
    d.shots = t.photos.map(function (b) { return { orig: b, marks: [], out: null }; });
    drawDraft(d); persist(d);
  }

  /* ---------- circle marks on a photo ---------- */
  var ed = null;   // {d, i, img, marks, scale, drag}
  function openEditor(d, i) {
    var s = d.shots[i], img = new Image();
    img.onload = function () {
      ed = { d: d, i: i, img: img, marks: (s.marks || []).map(function (m) { return m.slice(); }), drag: null };
      $('editor').classList.remove('hidden');
      fitEditor(); drawEditor();
    };
    img.src = jpg(s.orig);
  }
  function fitEditor() {
    var st = $('eStage'), c = $('eCanvas');
    var sc = Math.min(st.clientWidth / ed.img.width, st.clientHeight / ed.img.height);
    ed.scale = sc;
    c.width = Math.round(ed.img.width * sc); c.height = Math.round(ed.img.height * sc);
  }
  function strokeMarks(ctx, marks, sc, w) {
    ctx.strokeStyle = '#ff2d2d'; ctx.lineWidth = Math.max(4, Math.round(w * 0.009)) * sc;
    ctx.shadowColor = 'rgba(0,0,0,.45)'; ctx.shadowBlur = 3 * sc;
    marks.forEach(function (m) {
      var cx = (m[0] + m[2]) / 2 * sc, cy = (m[1] + m[3]) / 2 * sc;
      var rx = Math.abs(m[2] - m[0]) / 2 * sc, ry = Math.abs(m[3] - m[1]) / 2 * sc;
      if (rx < 2 || ry < 2) return;
      ctx.beginPath(); ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2); ctx.stroke();
    });
    ctx.shadowBlur = 0;
  }
  function drawEditor() {
    var c = $('eCanvas'), ctx = c.getContext('2d');
    ctx.drawImage(ed.img, 0, 0, c.width, c.height);
    strokeMarks(ctx, ed.drag ? ed.marks.concat([ed.drag]) : ed.marks, ed.scale, ed.img.width);
  }
  function ptOf(e) {
    var r = $('eCanvas').getBoundingClientRect();
    return [(e.clientX - r.left) / ed.scale, (e.clientY - r.top) / ed.scale];
  }
  $('eCanvas').addEventListener('pointerdown', function (e) {
    if (!ed) return;
    e.preventDefault(); this.setPointerCapture(e.pointerId);
    var p = ptOf(e); ed.drag = [p[0], p[1], p[0], p[1]];
  });
  $('eCanvas').addEventListener('pointermove', function (e) {
    if (!ed || !ed.drag) return;
    var p = ptOf(e); ed.drag[2] = p[0]; ed.drag[3] = p[1]; drawEditor();
  });
  function endDrag() {
    if (!ed || !ed.drag) return;
    var m = ed.drag; ed.drag = null;
    if (Math.abs(m[2] - m[0]) > 12 && Math.abs(m[3] - m[1]) > 12) ed.marks.push(m);
    drawEditor();
  }
  $('eCanvas').addEventListener('pointerup', endDrag);
  $('eCanvas').addEventListener('pointercancel', endDrag);
  $('eUndo').addEventListener('click', function () { if (ed) { ed.marks.pop(); drawEditor(); } });
  $('eClear').addEventListener('click', function () { if (ed) { ed.marks = []; drawEditor(); } });
  $('eCancel').addEventListener('click', function () { ed = null; $('editor').classList.add('hidden'); });
  $('eDone').addEventListener('click', function () {
    if (!ed) return;
    var s = ed.d.shots[ed.i];
    s.marks = ed.marks;
    if (s.marks.length) {   // burn the circles into a full-size copy; the original stays for later edits
      var c = document.createElement('canvas'); c.width = ed.img.width; c.height = ed.img.height;
      var ctx = c.getContext('2d'); ctx.drawImage(ed.img, 0, 0);
      strokeMarks(ctx, s.marks, 1, ed.img.width);
      s.out = c.toDataURL('image/jpeg', 0.8).split(',')[1];
    } else s.out = null;
    drawShots(ed.d); persist(ed.d);
    ed = null; $('editor').classList.add('hidden');
  });
  window.addEventListener('resize', function () { if (ed) { fitEditor(); drawEditor(); } });

  /* ---------- report images (same layout as the approved sample) ---------- */
  var RFONT = 'Sarabun, Thonburi, "Sukhumvit Set", sans-serif';
  var RC = { green: '#2e6b3a', dark: '#1d2b1f', muted: '#5b6b5d', bg: '#f2f4f2', white: '#ffffff', line: '#d5ddd6',
             amber: '#9a6408', amberBg: '#fcefd2', red: '#a93226', redBg: '#f6d5d5', foot: '#e4ece5', headSub: '#d6e8d9' };
  var fontsReady = false;
  function ensureFonts(cb) {
    if (fontsReady || !document.fonts || !document.fonts.load) { cb(); return; }
    var fin = false, finish = function () { if (!fin) { fin = true; fontsReady = true; cb(); } };
    Promise.all(['400', '600', '700'].map(function (w) { return document.fonts.load(w + ' 40px Sarabun', 'ก'); })).then(finish, finish);
    setTimeout(finish, 2500);
  }
  function thDate(d) { return d.toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: 'numeric' }); }
  function thTime(d) { return z(d.getHours()) + ':' + z(d.getMinutes()) + ' น.'; }
  function wrapText(ctx, text, maxW) {
    text = String(text || '').replace(/\s+/g, ' ').trim();
    if (!text) return [];
    var parts = (window.Intl && Intl.Segmenter) ? Array.from(new Intl.Segmenter('th', { granularity: 'word' }).segment(text), function (s) { return s.segment; }) : Array.from(text);
    var lines = [], cur = '';
    parts.forEach(function (w) {
      if (ctx.measureText(cur + w).width > maxW && cur) {
        lines.push(cur.trim()); cur = w.replace(/^\s+/, '');
        while (ctx.measureText(cur).width > maxW && cur.length > 1) {
          var k = cur.length; while (k > 1 && ctx.measureText(cur.slice(0, k)).width > maxW) k--;
          lines.push(cur.slice(0, k)); cur = cur.slice(k);
        }
      } else cur += w;
    });
    if (cur.trim()) lines.push(cur.trim());
    return lines;
  }
  function rrect(ctx, x, y, w, h, r) {
    ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }
  function loadImgs(b64s, cb) {
    var out = [], left = b64s.length;
    if (!left) return cb([]);
    b64s.forEach(function (b, i) {
      var im = new Image();
      im.onload = function () { out[i] = im; if (!--left) cb(out); };
      im.onerror = function () { out[i] = null; if (!--left) cb(out); };
      im.src = jpg(b);
    });
  }
  /** r = {id, site, title, detail, due, created:Date, photos:[b64]} -> cb(jpeg data URL) */
  function renderReport(r, cb) {
    ensureFonts(function () { loadImgs(r.photos || [], function (imgs) { draw(imgs.filter(function (x) { return x; })); }); });
    function draw(imgs) {
      var W = 1080, P = 56, IW = W - 2 * P, GAP = 16;
      var c = document.createElement('canvas'), ctx = c.getContext('2d');
      var F = function (w, s) { return w + ' ' + s + 'px ' + RFONT; };
      ctx.font = F(700, 58); var tl = wrapText(ctx, r.title, IW);
      ctx.font = F(400, 36); var dl = wrapText(ctx, r.detail, IW - 48);
      var main = imgs[0], ph = 0, extra = imgs.slice(1), eh = 0;
      if (main) { ph = Math.round(main.height * IW / main.width); if (ph > 1300) ph = 1300; }
      if (extra.length) eh = Math.round((IW - GAP * (extra.length - 1)) / extra.length * (extra.length === 1 ? 0.75 : 1));
      var due = /^(\d{4})-(\d{2})-(\d{2})$/.exec(r.due || ''), dueD = due ? new Date(+due[1], +due[2] - 1, +due[3]) : null;
      var left = dueD ? dayDiff(todayYmd(), r.due) : null;
      var H = 210 + 80 + tl.length * 76 + 30 + (main ? ph + 40 : 0) + (extra.length ? eh + 40 : 0) +
              (dl.length ? 60 + dl.length * 52 + 40 + 40 : 0) + 2 * 64 + 30 + 120;
      c.width = W; c.height = H; ctx.textBaseline = 'top';
      ctx.fillStyle = RC.bg; ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = RC.green; ctx.fillRect(0, 0, W, 170);
      ctx.fillStyle = RC.white; ctx.font = F(700, 46); ctx.fillText('รายงานตรวจงาน', P, 40);
      ctx.fillStyle = RC.headSub; ctx.font = F(400, 30); ctx.fillText('แจ้งเพื่อดำเนินการแก้ไข', P, 100);
      ctx.font = F(600, 32); var iw = ctx.measureText(r.id).width + 48;
      ctx.fillStyle = RC.white; rrect(ctx, W - P - iw, 58, iw, 56, 28); ctx.fill();
      ctx.fillStyle = RC.green; ctx.fillText(r.id, W - P - iw + 24, 66);
      var y = 210;
      ctx.fillStyle = RC.green; ctx.beginPath(); ctx.arc(P + 11, y + 21, 11, 0, 7); ctx.fill();
      ctx.fillStyle = RC.bg; ctx.beginPath(); ctx.arc(P + 11, y + 21, 4.5, 0, 7); ctx.fill();
      ctx.fillStyle = RC.dark; ctx.font = F(600, 32); ctx.fillText(r.site, P + 36, y + 2);
      var stT = left !== null && left < 0 ? 'เกินกำหนด ' + (-left) + ' วัน' : 'รอแก้ไข';
      var sw = ctx.measureText(stT).width + 44;
      ctx.fillStyle = left !== null && left < 0 ? RC.redBg : RC.amberBg; rrect(ctx, W - P - sw, y - 4, sw, 52, 26); ctx.fill();
      ctx.fillStyle = left !== null && left < 0 ? RC.red : RC.amber; ctx.fillText(stT, W - P - sw + 22, y + 2);
      y += 80;
      ctx.fillStyle = RC.dark; ctx.font = F(700, 58);
      tl.forEach(function (l) { ctx.fillText(l, P, y); y += 76; });
      y += 30;
      function cover(im, x, yy, w, h, rad) {
        var sr = im.width / im.height, dr = w / h, sx = 0, sy = 0, sw2 = im.width, sh2 = im.height;
        if (sr > dr) { sw2 = im.height * dr; sx = (im.width - sw2) / 2; } else { sh2 = im.width / dr; sy = (im.height - sh2) / 2; }
        ctx.save(); rrect(ctx, x, yy, w, h, rad); ctx.clip(); ctx.drawImage(im, sx, sy, sw2, sh2, x, yy, w, h); ctx.restore();
      }
      if (main) { cover(main, P, y, IW, ph, 28); y += ph + 40; }
      if (extra.length) {
        var ew = (IW - GAP * (extra.length - 1)) / extra.length;
        extra.forEach(function (im, i) { cover(im, P + i * (ew + GAP), y, ew, eh, 22); });
        y += eh + 40;
      }
      if (dl.length) {
        var bh = 60 + dl.length * 52 + 40;
        ctx.fillStyle = RC.white; rrect(ctx, P, y, IW, bh, 24); ctx.fill();
        ctx.fillStyle = RC.muted; ctx.font = F(600, 32); ctx.fillText('รายละเอียด / สิ่งที่ต้องทำ', P + 24, y + 22);
        ctx.fillStyle = RC.dark; ctx.font = F(400, 36);
        var yy = y + 80; dl.forEach(function (l) { ctx.fillText(l, P + 24, yy); yy += 52; });
        y += bh + 40;
      }
      var dueTxt = dueD ? thDate(dueD) + (left < 0 ? '  (เกิน ' + (-left) + ' วัน)' : left === 0 ? '  (วันนี้)' : '  (อีก ' + left + ' วัน)') : 'ไม่ได้กำหนด';
      [['กำหนดแก้เสร็จ', dueTxt, dueD ? (left < 0 ? RC.red : RC.amber) : RC.muted],
       ['บันทึกเมื่อ', thDate(r.created) + '  ' + thTime(r.created), RC.dark]].forEach(function (row) {
        ctx.fillStyle = RC.muted; ctx.font = F(400, 36); ctx.fillText(row[0], P, y);
        ctx.font = F(600, 36); ctx.fillStyle = row[2]; ctx.fillText(row[1], W - P - ctx.measureText(row[1]).width, y);
        y += 64; ctx.fillStyle = RC.line; ctx.fillRect(P, y - 11, IW, 2);
      });
      y += 30;
      ctx.fillStyle = RC.foot; ctx.fillRect(0, y, W, H - y);
      ctx.fillStyle = RC.green; ctx.font = F(400, 30);
      ctx.fillText('แก้ไขเสร็จแล้ว กรุณาถ่ายรูปส่งกลับ พร้อมแจ้งเลข ' + r.id, P, y + 22);
      ctx.fillStyle = RC.muted; ctx.font = F(400, 26); ctx.fillText('สมุดตรวจงาน · ส่งจากแอปตรวจงาน', P, y + 66);
      cb(c.toDataURL('image/jpeg', 0.86));
    }
  }
  var repJobs = [], repBusy = false;
  function makeReport(t, id) {
    reports.push({ id: id, url: '', n: Date.now() });
    repJobs.push({ id: id, site: t.site, title: t.title, detail: t.detail, due: t.due, created: new Date(t.created), photos: t.photos });
    renderReps(); nextReport();
  }
  function nextReport() {
    if (repBusy || !repJobs.length) return;
    repBusy = true;
    var r = repJobs.shift();
    renderReport(r, function (url) {
      reports.forEach(function (x) { if (x.id === r.id && !x.url) { x.url = url; dbPut('reports', x); } });
      repBusy = false; renderReps(); setTimeout(nextReport, 0);
    });
  }
  function renderReps() {
    $('repBox').classList.toggle('hidden', !reports.length);
    $('repN').textContent = '(' + reports.length + ')';
    $('repGrid').innerHTML = reports.map(function (x, i) {
      return x.url ? '<img alt="" data-rep="' + i + '" src="' + x.url + '">' : '<div class="wait">กำลังสร้าง<br>' + esc(x.id) + '</div>';
    }).join('');
  }
  $('repGrid').addEventListener('click', function (ev) {
    var im = ev.target.closest('img[data-rep]');
    if (im) { var i = +im.getAttribute('data-rep'); openViewer(reports[i].url, i); }
  });
  function dataUrlToFile(url, name) {
    var b = atob(url.split(',')[1]), n = b.length, u = new Uint8Array(n);
    while (n--) u[n] = b.charCodeAt(n);
    return new File([u], name, { type: 'image/jpeg' });
  }
  function shareFiles(items) {
    var files = items.filter(function (x) { return x.url; }).map(function (x) { return dataUrlToFile(x.url, x.id + '.jpg'); });
    if (!files.length) return;
    try {
      if (navigator.canShare && navigator.canShare({ files: files })) {
        navigator.share({ files: files }).catch(function (e) { if (e && e.name !== 'AbortError') toast('แชร์ไม่ได้: แตะรูปแล้วกดค้าง → บันทึกไปยังรูปภาพ', true, 'nMsg'); });
        return;
      }
    } catch (e) {}
    toast('เครื่องนี้แชร์รูปจากหน้าเว็บไม่ได้: แตะรูปแล้วกดค้าง → บันทึกไปยังรูปภาพ', true, 'nMsg');
  }
  $('repAll').addEventListener('click', function () { shareFiles(reports); });
  $('vShare').addEventListener('click', function () { if (viewRep >= 0) shareFiles([reports[viewRep]]); });
  $('repClear').addEventListener('click', function () {
    if (!confirm('ล้างภาพรายงานทั้งหมด? (งานที่บันทึกไว้ไม่หาย)')) return;
    reports = []; dbClear('reports'); renderReps();
  });

  function toast(text, bad, where, ms) {
    var el = $(where || (current ? 'dMsg' : 'listMsg'));
    el.innerHTML = '<div class="msg ' + (bad ? 'err-m' : 'ok-m') + '">' + esc(text) + '</div>';
    clearTimeout(el._t);
    el._t = setTimeout(function () { el.innerHTML = ''; }, ms || 4000);
  }

  /* ---------- start: saved data at once, then refresh ---------- */
  try { data = JSON.parse(lsGet('ownerList') || 'null'); } catch (e) { data = null; }
  go('list');
  dbOpen().then(function () { return Promise.all([dbAll('q'), dbAll('drafts'), dbAll('reports')]); }).then(function (r) {
    queue = r[0]; queue.forEach(function (t) { t.run = false; });
    r[1].sort(function (a, b) { return a.n - b.n; }).forEach(function (d) { addDraft(null, null, d); });
    reports = r[2].sort(function (a, b) { return a.n - b.n; });
    var hashId = decodeURIComponent((location.hash || '').slice(1));
    if (hashId && findAny(hashId)) openDetail(hashId, visible(), 'list');
    repaint(); pump();
  });
  refresh(!!data);
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(function () {});
})();
