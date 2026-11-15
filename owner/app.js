/* Owner app (part 1): all open jobs, detail, review the units' fixes, follow up, close.
   Same idea as the unit app: shows saved data at once, refreshes in the background,
   and every server write goes through a queue kept in IndexedDB. */
(function () {
  'use strict';

  var API = 'https://script.google.com/macros/s/AKfycby-OI8fk6svAZTD5AZk4X-HM2ZLuqS8qP5tI5aZTuA4zFPXY9v9HxbQFMC9x5regFdN/exec';
  var MAX_SIDE = 1600;

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
  function todayYmd() { var d = new Date(); return d.getFullYear() + '-' + z(d.getMonth() + 1) + '-' + z(d.getDate()); }
  function dayDiff(a, b) {
    var pa = a.split('-'), pb = b.split('-');
    return Math.round((Date.UTC(+pb[0], +pb[1] - 1, +pb[2]) - Date.UTC(+pa[0], +pa[1] - 1, +pa[2])) / 86400000);
  }
  function noteStamp() { var d = new Date(); return z(d.getDate()) + '/' + z(d.getMonth() + 1) + ' ' + z(d.getHours()) + ':' + z(d.getMinutes()); }
  function dmy(ymd) { var p = ymd.split('-'); return p[2] + '/' + p[1] + '/' + p[0].slice(2); }

  /* ---------- owner link: ?o=TOKEN, kept on the phone ---------- */
  var TOK = new URLSearchParams(location.search).get('o') || lsGet('ownerTok') || '';
  if (TOK) lsSet('ownerTok', TOK);
  var LIST_KEY = 'ownerList';

  /* ---------- state ---------- */
  var data = null;              // {at, today, sites, items}
  var filt = { f: lsGet('ownerFilt') || 'all', site: lsGet('ownerSite') || '' };
  var navIds = [], navPos = 0;  // the list the detail page steps through
  var current = null;
  var queue = [], busy = false, lastErr = '', retryTimer = null, loading = false, again = false;
  var closePhoto = null;        // base64 of the photo chosen for "close"

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

  /* ---------- IndexedDB queue ---------- */
  var db = null;
  function dbOpen() {
    return new Promise(function (res) {
      try {
        var rq = indexedDB.open('ownerQueue', 1);
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
    t.cid = uid(); t.stamp = noteStamp();
    queue.push(t);
    render(); if (current) renderDetail();
    return dbPut(t).then(function () { pump(); });
  }
  function dropTask(t) { queue = queue.filter(function (x) { return x !== t; }); return dbDel(t.n); }

  /* ---------- what the screen shows = server data + changes still waiting in the queue ---------- */
  function view(it) {
    var v = { status: it.status, due: it.due, dueText: it.dueText, daysLeft: it.daysLeft,
              note: it.note, fixPhotos: (it.fixPhotos || []).slice(), pending: false };
    function addNote(s) { v.note = v.note ? v.note + '\n' + s : s; }
    queue.forEach(function (t) {
      if (t.id !== it.id) return;
      v.pending = true;
      if (t.op === 'accept') { v.status = 'Done'; addNote(t.stamp + ' ตรวจรับงานจากหน่วยงาน'); }
      if (t.op === 'close') { v.status = 'Done'; addNote(t.stamp + ' ' + (t.note ? 'ปิดงาน: ' + t.note : 'ปิดงาน')); }
      if (t.op === 'return') { v.status = 'Returned'; v.fixPhotos = []; addNote(t.stamp + ' ส่งกลับให้แก้ใหม่: ' + t.reason); }
      if (t.op === 'update') {
        if (t.status && (v.status === 'Open' || v.status === 'In progress')) v.status = t.status;
        if (t.due !== undefined) {
          v.due = t.due; v.dueText = t.due ? dmy(t.due) : ''; v.daysLeft = t.due ? dayDiff(todayYmd(), t.due) : null;
        }
        if (t.note) addNote(t.stamp + ' ' + t.note);
      }
    });
    return v;
  }

  /* ---------- queue runner ---------- */
  function pump() {
    qbar();
    if (busy || !queue.length || !navigator.onLine) return;
    busy = true;
    var t = queue[0];
    var body = { a: 'own.' + t.op, o: TOK, id: t.id, cid: t.cid };
    if (t.op === 'close') { body.note = t.note; body.b64 = t.b64 || ''; }
    if (t.op === 'return') body.reason = t.reason;
    if (t.op === 'update') { if (t.due !== undefined) body.due = t.due; if (t.status) body.status = t.status; body.note = t.note || ''; }
    api(body).then(function () {
      busy = false; lastErr = '';
      applyDone(t);
      dropTask(t).then(function () { render(); if (current) renderDetail(); if (!queue.length) refresh(true); pump(); });
    }, function (e) {
      busy = false;
      var msg = (e && e.message) || String(e);
      if (e && e.server && /ไม่พบ|ปิดไปแล้ว|ยังไม่ได้ส่ง|เหตุผล|ไม่ถูกต้อง|Unknown/i.test(msg)) {
        toast('ส่งไม่สำเร็จ (' + t.id + '): ' + msg, true, 'listMsg');
        dropTask(t).then(function () { render(); refresh(true); pump(); });
        return;
      }
      lastErr = msg; t.tries = (t.tries || 0) + 1; qbar();
      clearTimeout(retryTimer);
      retryTimer = setTimeout(pump, Math.min(60000, 4000 * t.tries));
    });
  }
  /** Bake a finished task into the saved list, so the screen does not jump back. */
  function applyDone(t) {
    var it = findItem(t.id);
    if (!it) return;
    var saved = queue; queue = [t];
    var v = view(it);
    queue = saved;
    it.status = v.status; it.due = v.due; it.dueText = v.dueText; it.daysLeft = v.daysLeft; it.note = v.note; it.fixPhotos = v.fixPhotos;
    if (it.status === 'Done') data.items = data.items.filter(function (x) { return x !== it; });
    saveList();
  }
  function qbar() {
    var b = $('qbar');
    if (!queue.length) { b.classList.add('hidden'); return; }
    b.classList.remove('hidden');
    b.classList.toggle('err', !!lastErr || !navigator.onLine);
    b.textContent = !navigator.onLine ? '📵 ไม่มีสัญญาณ · จะส่ง ' + queue.length + ' รายการให้เองเมื่อออนไลน์'
      : lastErr ? '⚠ ส่งไม่สำเร็จ กำลังลองใหม่ (' + queue.length + ' รายการ)'
      : '⏳ กำลังส่ง ' + queue.length + ' รายการ · ทำงานต่อได้เลย';
  }
  window.addEventListener('online', function () { clearTimeout(retryTimer); pump(); refresh(true); });
  window.addEventListener('offline', qbar);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') { busy = false; pump(); refresh(true); }
  });

  /* ---------- data ---------- */
  function findItem(id) {
    if (!data) return null;
    for (var i = 0; i < data.items.length; i++) if (data.items[i].id === id) return data.items[i];
    return null;
  }
  function saveList() { if (data) lsSet(LIST_KEY, JSON.stringify(data)); }
  function refresh(quiet) {
    if (!TOK) return;
    if (loading) { again = true; return; }   // a write finished meanwhile: load once more after this one
    loading = true; again = false;
    if (!quiet) $('refBtn').innerHTML = '<span class="spin">⟳</span>';
    api({ a: 'own.list', o: TOK }).then(function (d) {
      loading = false; $('refBtn').textContent = '⟳';
      if (again) return refresh(true);
      data = d; saveList(); $('topMsg').innerHTML = ''; render();
      if (current) {
        var it = findItem(current.id);
        if (it) { current = it; renderDetail(); }
      }
    }, function (e) {
      loading = false; $('refBtn').textContent = '⟳';
      if (again) return refresh(true);
      if (e && e.server) $('topMsg').innerHTML = '<div class="msg err-m">' + esc(e.message) + '</div>';
      else if (!data) $('topMsg').innerHTML = '<div class="msg err-m">เชื่อมต่อไม่ได้ ลองกด ⟳ อีกครั้ง</div>';
      subLine();
    });
  }
  function subLine() {
    if (!data) return;
    var min = Math.round((Date.now() - data.at) / 60000);
    $('sub').textContent = min < 1 ? 'อัปเดตเมื่อสักครู่' : 'อัปเดตเมื่อ ' + (min < 60 ? min + ' นาทีที่แล้ว' : Math.round(min / 60) + ' ชม.ที่แล้ว');
  }
  setInterval(subLine, 30000);

  /* ---------- list ---------- */
  function kind(v) {
    if (v.status === 'Review') return 'rev';
    if (v.status === 'Returned') return 'ret';
    if (v.daysLeft !== null && v.daysLeft < 0) return 'over';
    if (v.daysLeft !== null && v.daysLeft <= 2) return 'soon';
    return '';
  }
  function badges(it, v) {
    var b = '';
    if (v.pending) b += '<span class="badge wait">⏳ รอส่ง</span>';
    if (v.status === 'Review') return b + '<span class="badge rev">📥 รอตรวจรับ</span>';
    if (v.status === 'Returned') b += '<span class="badge ret">↩️ ส่งกลับแล้ว</span>';
    if (v.status === 'In progress') b += '<span class="badge prog">🔧 กำลังแก้</span>';
    if (v.daysLeft === null) b += '<span class="badge">ไม่มีกำหนด</span>';
    else if (v.daysLeft < 0) b += '<span class="badge over">⚠ เกินกำหนด ' + (-v.daysLeft) + ' วัน</span>';
    else if (v.daysLeft === 0) b += '<span class="badge soon">ครบกำหนดวันนี้</span>';
    else if (v.daysLeft <= 2) b += '<span class="badge soon">เหลือ ' + v.daysLeft + ' วัน</span>';
    else b += '<span class="badge">ครบ ' + esc(v.dueText) + '</span>';
    if (v.status !== 'Review' && v.fixPhotos.length) b += '<span class="badge">📎 รูปร่าง ' + v.fixPhotos.length + '</span>';
    return b;
  }
  function openItems() {
    if (!data) return [];
    return data.items.filter(function (it) { return view(it).status !== 'Done'; });
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
  function render() {
    subLine(); qbar();
    if (!TOK) {
      $('sub').textContent = '';
      $('topMsg').innerHTML = '<div class="msg err-m">กรุณาเปิดจากลิงก์ผู้ตรวจ (ลิงก์ที่มี ?o=...)</div>';
      return;
    }
    if (!data) { $('list').innerHTML = '<div class="empty">กำลังโหลด...</div>'; return; }
    // unit filter options
    var sel = $('fSite');
    if (sel.options.length !== data.sites.length + 1) {
      sel.innerHTML = '<option value="">ทุกหน่วยงาน</option>' + data.sites.map(function (s) {
        return '<option value="' + esc(s) + '">' + esc(s) + '</option>';
      }).join('');
    }
    sel.value = filt.site;
    var base = openItems().filter(function (it) { return !filt.site || it.site === filt.site; });
    $('cAll').textContent = base.length;
    $('cRev').textContent = base.filter(function (it) { return matches(it, 'rev'); }).length;
    $('cOver').textContent = base.filter(function (it) { return matches(it, 'over'); }).length;
    $('cSoon').textContent = base.filter(function (it) { return matches(it, 'soon'); }).length;
    Array.prototype.forEach.call(document.querySelectorAll('.chip'), function (c) { c.classList.toggle('on', c.getAttribute('data-f') === filt.f); });
    var list = visible();
    $('list').innerHTML = list.length ? list.map(card).join('') : '<div class="empty">✨ ไม่มีงานในกลุ่มนี้</div>';
  }
  function card(it) {
    var v = view(it);
    return '<div class="card ' + kind(v) + '" data-id="' + esc(it.id) + '">' +
      '<div class="th">' + (it.photoId ? '<img loading="lazy" decoding="async" alt="" src="' + esc(thumb(it.photoId, 240)) + '">' : '') + '</div>' +
      '<div class="bd"><div class="top"><span class="site">' + esc(it.site) + '</span><span>' + esc(it.id) + '</span></div>' +
      '<div class="title">' + esc(it.title || '(ไม่มีหัวข้อ)') + '</div>' + badges(it, v) +
      '<div class="d-meta" style="margin:2px 0 0;font-size:12.5px">' + (it.category ? esc(it.category) + ' · ' : '') + 'แจ้งเมื่อ ' + esc(it.created) + '</div>' +
      '</div></div>';
  }
  $('list').addEventListener('click', function (ev) {
    var c = ev.target.closest('.card');
    if (c) openDetail(c.getAttribute('data-id'), true);
  });
  $('chips').addEventListener('click', function (ev) {
    var c = ev.target.closest('.chip');
    if (!c) return;
    var f = c.getAttribute('data-f');
    filt.f = (filt.f === f && f !== 'all') ? 'all' : f;
    lsSet('ownerFilt', filt.f); render();
  });
  $('fSite').addEventListener('change', function () { filt.site = this.value; lsSet('ownerSite', filt.site); render(); });

  /* ---------- detail ---------- */
  function openDetail(id, push) {
    var it = findItem(id);
    if (!it) return;
    navIds = visible().map(function (x) { return x.id; });
    if (navIds.indexOf(id) === -1) navIds = [id];
    navPos = navIds.indexOf(id);
    show(it, push);
  }
  function show(it, push) {
    current = it;
    if (push) history.pushState({ id: it.id }, '', '#' + encodeURIComponent(it.id));
    else history.replaceState({ id: it.id }, '', '#' + encodeURIComponent(it.id));
    $('pgList').classList.add('hidden'); $('pgDetail').classList.remove('hidden');
    $('backBtn').classList.remove('hidden'); $('refBtn').classList.add('hidden');
    $('dMsg').innerHTML = ''; $('rReason').value = ''; $('mNote').value = ''; $('cNote').value = '';
    setClosePhoto(null);
    var img = $('dPhoto');
    img.classList.toggle('hidden', !it.photoId);
    img.removeAttribute('src');
    if (it.photoId) img.src = thumb(it.photoId, 1000);
    renderDetail();
    window.scrollTo(0, 0);
    // warm up the next and previous photos
    [navPos - 1, navPos + 1].forEach(function (p) {
      var x = findItem(navIds[p]);
      if (x && x.photoId) { var im = new Image(); im.src = thumb(x.photoId, 1000); }
    });
  }
  function renderDetail() {
    if (!current) return;
    var it = current, v = view(it);
    $('hdr').textContent = it.id + ' · ' + it.site;
    $('dPos').textContent = (navPos + 1) + ' / ' + navIds.length;
    $('dPrev').disabled = navPos <= 0; $('dNext').disabled = navPos >= navIds.length - 1;
    $('dTop').textContent = (it.category ? it.category + ' · ' : '') + 'แจ้งเมื่อ ' + it.created;
    $('dTitle').textContent = it.title || '(ไม่มีหัวข้อ)';
    $('dBadges').innerHTML = v.status === 'Done' ? '<span class="badge">🔒 ปิดงานแล้ว</span>' + (v.pending ? '<span class="badge wait">⏳ รอส่ง</span>' : '') : badges(it, v);
    $('dDetail').textContent = it.detail || '';
    $('dDetailWrap').classList.toggle('hidden', !it.detail);
    $('dNote').textContent = v.note || '';
    $('dNoteWrap').classList.toggle('hidden', !v.note);
    var done = v.status === 'Done', rev = v.status === 'Review';
    $('revBox').classList.toggle('hidden', !rev);
    $('revThumbs').innerHTML = rev ? v.fixPhotos.map(fixImg).join('') : '';
    var draft = !rev && !done && v.fixPhotos.length > 0;
    $('draftBox').classList.toggle('hidden', !draft);
    if (draft) {
      $('draftLbl').textContent = '📎 หน่วยงานแนบรูปไว้ ' + v.fixPhotos.length + ' รูป (ยังไม่กดยืนยันส่ง)';
      $('draftThumbs').innerHTML = v.fixPhotos.map(fixImg).join('');
    }
    $('manBox').classList.toggle('hidden', done);
    $('closeBox').classList.toggle('hidden', done);
    var canSeg = v.status === 'Open' || v.status === 'In progress';
    $('segWrap').classList.toggle('hidden', !canSeg);
    Array.prototype.forEach.call(document.querySelectorAll('.seg button'), function (b) {
      b.classList.toggle('on', b.getAttribute('data-s') === v.status);
    });
    if (document.activeElement !== $('mDue')) $('mDue').value = v.due || '';
  }
  function fixImg(id) { return '<img loading="lazy" alt="" data-full="' + esc(id) + '" src="' + esc(thumb(id, 400)) + '">'; }

  function step(d) {
    var p = navPos + d;
    while (p >= 0 && p < navIds.length) {
      var x = findItem(navIds[p]);
      if (x && view(x).status !== 'Done') { navPos = p; show(x, false); return true; }
      p += d;
    }
    return false;
  }
  $('dPrev').addEventListener('click', function () { step(-1); });
  $('dNext').addEventListener('click', function () { step(1); });
  // swipe left / right on the detail page
  var sx = 0, sy = 0;
  $('pgDetail').addEventListener('touchstart', function (e) { sx = e.touches[0].clientX; sy = e.touches[0].clientY; }, { passive: true });
  $('pgDetail').addEventListener('touchend', function (e) {
    var dx = e.changedTouches[0].clientX - sx, dy = e.changedTouches[0].clientY - sy;
    if (Math.abs(dx) > 70 && Math.abs(dy) < 50) step(dx < 0 ? 1 : -1);
  }, { passive: true });

  function showList() {
    current = null;
    $('pgDetail').classList.add('hidden'); $('pgList').classList.remove('hidden');
    $('backBtn').classList.add('hidden'); $('refBtn').classList.remove('hidden');
    $('hdr').textContent = 'สมุดตรวจงาน';
    render();
  }
  function backToList() { if (history.state && history.state.id) history.back(); else showList(); }
  $('backBtn').addEventListener('click', backToList);
  window.addEventListener('popstate', function (e) {
    if (e.state && e.state.id && findItem(e.state.id)) openDetail(e.state.id, false); else showList();
  });
  $('refBtn').addEventListener('click', function () { refresh(false); pump(); });

  /* full screen photo */
  function openViewer(src) { $('vImg').src = src; $('viewer').classList.remove('hidden'); }
  $('viewer').addEventListener('click', function () { $('viewer').classList.add('hidden'); $('vImg').removeAttribute('src'); });
  $('dPhoto').addEventListener('click', function () { if (current && current.photoId) openViewer(thumb(current.photoId, 2000)); });
  ['revThumbs', 'draftThumbs'].forEach(function (b) {
    $(b).addEventListener('click', function (ev) {
      var im = ev.target.closest('img[data-full]');
      if (im) openViewer(thumb(im.getAttribute('data-full'), 2000));
    });
  });

  /* after an action that finishes the job: go to the next one, or back to the list */
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

  /* follow up: status / due / note */
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

  /* close by myself, optional photo */
  function setClosePhoto(b64) {
    closePhoto = b64;
    $('cPrev').classList.toggle('hidden', !b64);
    if (b64) $('cImg').src = 'data:image/jpeg;base64,' + b64; else $('cImg').removeAttribute('src');
  }
  function resizeFile(file, cb) {
    var url = URL.createObjectURL(file), img = new Image();
    img.onload = function () {
      var s = Math.min(1, MAX_SIDE / Math.max(img.width, img.height));
      var c = document.createElement('canvas');
      c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url); cb(c.toDataURL('image/jpeg', 0.75).split(',')[1]);
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

  function toast(text, bad, where) {
    var el = $(where || (current ? 'dMsg' : 'listMsg'));
    el.innerHTML = '<div class="msg ' + (bad ? 'err-m' : 'ok-m') + '">' + esc(text) + '</div>';
    clearTimeout(el._t);
    el._t = setTimeout(function () { el.innerHTML = ''; }, 3500);
  }

  /* ---------- start: saved data at once, then refresh ---------- */
  try { data = JSON.parse(lsGet(LIST_KEY) || 'null'); } catch (e) { data = null; }
  render();
  var hashId = decodeURIComponent((location.hash || '').slice(1));
  if (hashId && findItem(hashId)) openDetail(hashId, false);
  dbOpen().then(dbAll).then(function (rows) {
    queue = rows; render(); if (current) renderDetail(); pump();
  });
  refresh(!!data);
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(function () {});
})();
