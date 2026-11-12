/* Unit app: shows one unit's jobs, lets staff send after-fix photos.
   Opens instantly from data saved on the phone, then refreshes in the background.
   All server writes go through a queue saved in IndexedDB, so nothing is lost
   if the app is closed or the network drops. */
(function () {
  'use strict';

  var API = 'https://script.google.com/macros/s/AKfycbzihl-yRLksiij7rRmstAH9iVYgBRh003bgQBQnDJq8iA_2WCYHcL5uX-6DFCSlzgEO4g/exec';
  var MAX_PHOTOS = 3, MAX_SIDE = 1600;

  /* ---------- small helpers ---------- */
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 10); }
  // Drive's own thumbnail (photos are shared by link)
  function thumb(id, w) { return 'https://drive.google.com/thumbnail?id=' + encodeURIComponent(id) + '&sz=w' + w; }

  /* ---------- key from the link (kept on the phone for the home-screen icon) ---------- */
  var KEY = new URLSearchParams(location.search).get('k') || lsGet('unitKey') || '';
  if (KEY) lsSet('unitKey', KEY);
  var LIST_KEY = 'list:' + KEY;

  /* ---------- state ---------- */
  var data = null;          // {site, at, items}
  var current = null;       // item open in detail
  var localSrc = {};        // fileId or tmp id -> data URL shown while Drive makes its thumbnail
  var queue = [];           // pending server writes (mirrors IndexedDB)
  var busy = false, lastErr = '', retryTimer = null, loading = false;

  /* ---------- API ---------- */
  function api(body, timeoutMs) {
    var ctl = window.AbortController ? new AbortController() : null;
    var t = ctl ? setTimeout(function () { ctl.abort(); }, timeoutMs || 45000) : null;
    return fetch(API, { method: 'POST', body: JSON.stringify(body), signal: ctl ? ctl.signal : undefined, redirect: 'follow' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (t) clearTimeout(t);
        if (!j.ok) { var e = new Error(j.error || 'error'); e.server = true; throw e; }
        return j.data;
      }, function (e) { if (t) clearTimeout(t); throw e; });
  }

  /* ---------- IndexedDB queue (falls back to memory) ---------- */
  var db = null;
  function dbOpen() {
    return new Promise(function (res) {
      try {
        var rq = indexedDB.open('unitQueue', 1);
        rq.onupgradeneeded = function () { rq.result.createObjectStore('q', { keyPath: 'n', autoIncrement: true }); };
        rq.onsuccess = function () { db = rq.result; res(); };
        rq.onerror = function () { res(); };
      } catch (e) { res(); }
    });
  }
  function dbAll() {
    return new Promise(function (res) {
      if (!db) return res([]);
      try {
        var out = [], c = db.transaction('q').objectStore('q').openCursor();
        c.onsuccess = function () { var cur = c.result; if (cur) { out.push(cur.value); cur.continue(); } else res(out); };
        c.onerror = function () { res([]); };
      } catch (e) { res([]); }
    });
  }
  function dbPut(t) {
    return new Promise(function (res) {
      if (!db) { t.n = t.n || Date.now() + Math.random(); return res(t); }
      try {
        var rq = db.transaction('q', 'readwrite').objectStore('q').put(t);
        rq.onsuccess = function () { t.n = rq.result; res(t); };
        rq.onerror = function () { res(t); };
      } catch (e) { res(t); }
    });
  }
  function dbDel(n) {
    return new Promise(function (res) {
      if (!db) return res();
      try { var rq = db.transaction('q', 'readwrite').objectStore('q').delete(n); rq.onsuccess = rq.onerror = function () { res(); }; }
      catch (e) { res(); }
    });
  }
  function enqueue(t) {
    t.key = KEY; t.cid = t.cid || uid();
    queue.push(t);
    return dbPut(t).then(function () { render(); pump(); });
  }
  function dropTask(t) {
    queue = queue.filter(function (x) { return x !== t; });
    return dbDel(t.n);
  }

  /* ---------- what the screen shows = server data + changes still in the queue ---------- */
  function view(it) {
    var photos = (it.fixPhotos || []).map(function (f) { return { id: f, src: localSrc[f] || thumb(f, 400) }; });
    var status = it.status, pending = 0;
    queue.forEach(function (t) {
      if (t.id !== it.id) return;
      if (t.op === 'remove') photos = photos.filter(function (p) { return p.id !== t.fileId; });
      if (t.op === 'attach') { photos.push({ id: t.tmp, src: localSrc[t.tmp] || ('data:image/jpeg;base64,' + t.b64), uploading: true }); pending++; }
      if (t.op === 'submit') status = 'Review';
    });
    return { photos: photos, status: status, pending: pending };
  }

  /* ---------- the queue runner ---------- */
  function pump() {
    qbar();
    if (busy || !queue.length || !navigator.onLine) return;
    busy = true;
    var t = queue[0], body;
    if (t.op === 'attach') body = { a: 'site.attach', k: t.key, id: t.id, b64: t.b64, cid: t.cid };
    else if (t.op === 'remove') body = { a: 'site.remove', k: t.key, id: t.id, fileId: t.fileId };
    else body = { a: 'site.submit', k: t.key, id: t.id, note: t.note, cid: t.cid };
    api(body).then(function (res) {
      busy = false; lastErr = '';
      var it = findItem(t.id);
      if (t.op === 'attach') {
        localSrc[res.fileId] = localSrc[t.tmp] || ('data:image/jpeg;base64,' + t.b64);
        if (it) it.fixPhotos = res.fixPhotos;
      }
      if (t.op === 'remove' && it) it.fixPhotos = res.fixPhotos;
      if (t.op === 'submit' && it) it.status = 'Review';
      saveList();
      dropTask(t).then(function () { render(); if (!queue.length) refresh(true); pump(); });
    }, function (e) {
      busy = false;
      var msg = (e && e.message) || String(e);
      // permanent problems: the task can never succeed, drop it so the rest can go
      if (e && e.server && /ไม่พบ|Not allowed|ยืนยันส่งไปแล้ว|ปิดไปแล้ว|สูงสุด|ไม่ถูกต้อง|ยกเลิก|อย่างน้อย|not found/i.test(msg)) {
        toast('ส่งไม่สำเร็จ: ' + msg, true);
        dropTask(t).then(function () { render(); refresh(true); pump(); });
        return;
      }
      lastErr = msg; t.tries = (t.tries || 0) + 1; qbar();
      clearTimeout(retryTimer);
      retryTimer = setTimeout(pump, Math.min(60000, 4000 * t.tries));
    });
  }
  function qbar() {
    var b = $('qbar');
    if (!queue.length) { b.classList.add('hidden'); return; }
    var n = queue.filter(function (t) { return t.op === 'attach'; }).length;
    b.classList.remove('hidden');
    b.classList.toggle('err', !!lastErr || !navigator.onLine);
    b.textContent = !navigator.onLine ? '📵 ไม่มีสัญญาณ · จะส่ง ' + queue.length + ' รายการให้เองเมื่อออนไลน์'
      : lastErr ? '⚠ ส่งไม่สำเร็จ กำลังลองใหม่ (' + queue.length + ' รายการ)'
      : '⏳ กำลังส่ง ' + queue.length + ' รายการ' + (n ? ' (รูป ' + n + ')' : '') + ' · ทำงานต่อได้เลย';
  }
  window.addEventListener('online', function () { clearTimeout(retryTimer); pump(); refresh(true); });
  window.addEventListener('offline', qbar);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') { busy = false; pump(); refresh(true); }
  });

  /* ---------- list data ---------- */
  function findItem(id) {
    if (!data) return null;
    for (var i = 0; i < data.items.length; i++) if (data.items[i].id === id) return data.items[i];
    return null;
  }
  function saveList() { if (data) lsSet(LIST_KEY, JSON.stringify(data)); }
  function refresh(quiet) {
    if (!KEY || loading) return;
    loading = true;
    if (!quiet) $('refBtn').innerHTML = '<span class="spin">⟳</span>';
    api({ a: 'site.list', k: KEY }).then(function (d) {
      loading = false; $('refBtn').textContent = '⟳';
      data = d; saveList(); render();
      if (current) { var it = findItem(current.id); if (it) { current = it; renderDetail(); } else showList(); }
    }, function (e) {
      loading = false; $('refBtn').textContent = '⟳';
      if (e && e.server) { $('topMsg').innerHTML = '<div class="msg err">' + esc(e.message) + '</div>'; if (!data) $('sub').textContent = ''; }
      else if (!data) $('topMsg').innerHTML = '<div class="msg err">เชื่อมต่อไม่ได้ ลองกด ⟳ อีกครั้ง</div>';
      subLine();
    });
  }
  function subLine() {
    if (!data) return;
    var min = Math.round((Date.now() - data.at) / 60000);
    $('sub').textContent = (data.site || '') + ' · ' + (min < 1 ? 'อัปเดตเมื่อสักครู่' : 'อัปเดตเมื่อ ' + min + ' นาทีที่แล้ว');
  }
  setInterval(subLine, 30000);

  /* ---------- list screen ---------- */
  function badges(it, v) {
    if (v.status === 'Review') return '<span class="badge rev">รอผู้ตรวจตรวจรับ</span>';
    var b = '';
    if (v.status === 'Returned') b += '<span class="badge ret">↩️ ส่งกลับให้แก้ใหม่</span>';
    if (v.photos.length) b += '<span class="badge draft">📎 ร่างรูป ' + v.photos.length + ' รูป ยังไม่ยืนยัน</span>';
    if (it.daysLeft === null || it.daysLeft === undefined) b += '<span class="badge">ไม่มีกำหนด</span>';
    else if (it.daysLeft < 0) b += '<span class="badge over">⚠ เกินกำหนด ' + (-it.daysLeft) + ' วัน</span>';
    else if (it.daysLeft === 0) b += '<span class="badge soon">ครบกำหนดวันนี้</span>';
    else if (it.daysLeft <= 2) b += '<span class="badge soon">เหลือ ' + it.daysLeft + ' วัน</span>';
    else b += '<span class="badge">ครบ ' + esc(it.dueText) + '</span>';
    return b;
  }
  function cls(it, v) {
    if (v.status === 'Review') return 'rev';
    if (v.status === 'Returned') return 'ret';
    if (it.daysLeft !== null && it.daysLeft < 0) return 'over';
    if (it.daysLeft !== null && it.daysLeft <= 2) return 'soon';
    return '';
  }
  function card(it) {
    var v = view(it);
    return '<div class="card ' + cls(it, v) + '" data-id="' + esc(it.id) + '">' +
      '<div class="th">' + (it.photoId ? '<img loading="lazy" decoding="async" alt="" src="' + esc(thumb(it.photoId, 240)) + '">' : '') + '</div>' +
      '<div class="bd"><div class="top"><span>' + esc(it.category || '') + '</span><span>' + esc(it.id) + '</span></div>' +
      '<div class="title">' + esc(it.title) + '</div>' + badges(it, v) +
      '<div class="top" style="margin-top:4px"><span>แจ้งเมื่อ ' + esc(it.created) + '</span></div></div></div>';
  }
  function render() {
    qbar();
    if (!KEY) {
      $('sub').textContent = '';
      $('topMsg').innerHTML = '<div class="msg err">กรุณาเปิดจากลิงก์ที่ได้รับในกลุ่ม LINE</div>';
      return;
    }
    if (!data) { $('listTodo').innerHTML = '<div class="empty">กำลังโหลด...</div>'; return; }
    $('topMsg').innerHTML = '';
    subLine();
    var todo = [], rev = [];
    data.items.forEach(function (it) { (view(it).status === 'Review' ? rev : todo).push(it); });
    $('hTodo').classList.remove('hidden');
    $('hTodo').textContent = 'ต้องแก้ไข (' + todo.length + ')';
    $('listTodo').innerHTML = todo.map(card).join('') || '<div class="empty">🎉 ไม่มีงานที่ต้องแก้</div>';
    $('hRev').classList.toggle('hidden', !rev.length);
    $('hRev').textContent = 'ส่งแล้ว · รอผู้ตรวจตรวจรับ (' + rev.length + ')';
    $('listRev').innerHTML = rev.map(card).join('');
    if (current) renderDetail();
  }
  function onCardTap(ev) {
    var c = ev.target.closest('.card');
    if (c) openDetail(c.getAttribute('data-id'), true);
  }
  $('listTodo').addEventListener('click', onCardTap);
  $('listRev').addEventListener('click', onCardTap);

  /* ---------- detail screen ---------- */
  function openDetail(id, push) {
    current = findItem(id);
    if (!current) return;
    if (push) history.pushState({ id: id }, '', '#' + encodeURIComponent(id));
    $('pgList').classList.add('hidden'); $('pgDetail').classList.remove('hidden');
    $('backBtn').classList.remove('hidden'); $('refBtn').classList.add('hidden');
    $('dMsg').innerHTML = ''; $('fNote').value = '';
    var img = $('dPhoto');
    img.classList.add('hidden');
    if (current.photoId) {
      img.onload = function () { img.classList.remove('hidden'); };
      img.src = thumb(current.photoId, 1000);
      img.dataset.full = thumb(current.photoId, 2000);
    }
    renderDetail();
    window.scrollTo(0, 0);
  }
  $('dPhoto').addEventListener('click', function () { if (this.dataset.full) this.src = this.dataset.full; });

  function renderDetail() {
    var it = current, v = view(it);
    $('hdr').textContent = it.id;
    $('dTop').textContent = (it.category ? it.category + ' · ' : '') + 'แจ้งเมื่อ ' + it.created;
    $('dTitle').textContent = it.title;
    $('dBadges').innerHTML = badges(it, v);
    var ret = '';
    String(it.note || '').split('\n').forEach(function (l) { if (l.indexOf('ส่งกลับให้แก้ใหม่:') !== -1) ret = l; });
    $('dRet').classList.toggle('hidden', !(v.status === 'Returned' && ret));
    $('dRet').textContent = '↩️ ' + ret;
    $('dDetailWrap').classList.toggle('hidden', !it.detail);
    $('dDetail').textContent = it.detail || '';
    $('dNoteWrap').classList.toggle('hidden', !it.note);
    $('dNote').textContent = it.note || '';
    var isRev = v.status === 'Review';
    $('fixBox').classList.toggle('hidden', isRev);
    $('revBox').classList.toggle('hidden', !isRev);
    var html = v.photos.map(function (p) {
      return '<div class="t"><img alt="" src="' + esc(p.src) + '" onerror="this.onerror=null;this.style.opacity=.3">' +
        (isRev ? '' : '<button type="button" data-del="' + esc(p.id) + '" aria-label="ลบรูป">✕</button>') +
        (p.uploading ? '<div class="up">กำลังส่ง...</div>' : '') + '</div>';
    }).join('');
    if (isRev) $('revThumbs').innerHTML = html; else $('thumbs').innerHTML = html;
    $('pCount').textContent = '(' + v.photos.length + ' / ' + MAX_PHOTOS + ')';
    $('addRow').classList.toggle('hidden', v.photos.length >= MAX_PHOTOS);
    $('fBtn').disabled = v.photos.length === 0;
  }

  function showList() {
    current = null;
    $('pgDetail').classList.add('hidden'); $('pgList').classList.remove('hidden');
    $('backBtn').classList.add('hidden'); $('refBtn').classList.remove('hidden');
    $('hdr').textContent = 'งานที่ต้องแก้ไข';
    render();
  }
  $('backBtn').addEventListener('click', function () { if (history.state && history.state.id) history.back(); else showList(); });
  window.addEventListener('popstate', function (e) {
    if (e.state && e.state.id) openDetail(e.state.id, false); else showList();
  });
  $('refBtn').addEventListener('click', function () { refresh(false); pump(); });

  /* ---------- photos: resize on the phone, then queue the upload ---------- */
  function resizeFile(file, cb) {
    var url = URL.createObjectURL(file), img = new Image();
    img.onload = function () {
      var s = Math.min(1, MAX_SIDE / Math.max(img.width, img.height));
      var c = document.createElement('canvas');
      c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url); cb(c.toDataURL('image/jpeg', 0.75));
    };
    img.onerror = function () { URL.revokeObjectURL(url); cb(null); };
    img.src = url;
  }
  function addPhotos(input) {
    var files = Array.prototype.slice.call(input.files || []); input.value = '';
    if (!current || !files.length) return;
    var id = current.id, room = MAX_PHOTOS - view(current).photos.length;
    if (files.length > room) toast('แนบได้สูงสุด ' + MAX_PHOTOS + ' รูป ใช้ ' + Math.max(room, 0) + ' รูปแรกที่เลือก', true);
    files = files.slice(0, Math.max(room, 0));
    var i = 0;
    (function next() {
      if (i >= files.length) return;
      resizeFile(files[i++], function (url) {
        if (!url) return next();
        var tmp = 'tmp-' + uid();
        localSrc[tmp] = url;
        enqueue({ op: 'attach', id: id, tmp: tmp, b64: url.split(',')[1] }).then(next);
      });
    })();
  }
  $('fCam').addEventListener('change', function () { addPhotos(this); });
  $('fLib').addEventListener('change', function () { addPhotos(this); });

  $('thumbs').addEventListener('click', function (ev) {
    var b = ev.target.closest('button[data-del]');
    if (!b || !current) return;
    if (!confirm('ลบรูปนี้?')) return;
    var pid = b.getAttribute('data-del');
    // not sent yet: just cancel the upload
    var waiting = queue.filter(function (t) { return t.op === 'attach' && t.tmp === pid; })[0];
    if (waiting && waiting !== queue[0]) { dropTask(waiting).then(render); return; }
    if (waiting) { toast('รูปนี้กำลังส่งอยู่ ลบได้เมื่อส่งเสร็จ', true); return; }
    enqueue({ op: 'remove', id: current.id, fileId: pid });
  });

  $('fBtn').addEventListener('click', function () {
    var v = view(current);
    if (!v.photos.length) return toast('กรุณาแนบรูปหลังแก้อย่างน้อย 1 รูป', true);
    if (!confirm('ยืนยันส่งรูป ' + v.photos.length + ' รูปให้ผู้ตรวจ?\nยืนยันแล้วจะลบหรือเปลี่ยนรูปไม่ได้')) return;
    enqueue({ op: 'submit', id: current.id, note: $('fNote').value });
    if (history.state && history.state.id) history.back(); else showList();
    toast('✅ ส่งให้ผู้ตรวจแล้ว ขอบคุณครับ', false, 'listMsg');
  });

  function toast(text, bad, where) {
    var el = $(where || (current ? 'dMsg' : 'listMsg'));
    el.innerHTML = '<div class="msg ' + (bad ? 'err' : 'ok') + '">' + esc(text) + '</div>';
    setTimeout(function () { el.innerHTML = ''; }, 4000);
  }

  /* ---------- start: show saved data at once, then refresh ---------- */
  try { data = JSON.parse(lsGet(LIST_KEY) || 'null'); } catch (e) { data = null; }
  render();
  dbOpen().then(dbAll).then(function (rows) {
    queue = rows.filter(function (t) { return t.key === KEY; });
    render(); pump();
  });
  refresh(!!data);
  var hashId = decodeURIComponent((location.hash || '').slice(1));
  if (hashId && findItem(hashId)) { history.replaceState({ id: hashId }, '', location.href); openDetail(hashId, false); }

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () { navigator.serviceWorker.register('sw.js').catch(function () {}); });
  }
})();
