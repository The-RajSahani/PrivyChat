(() => {
  'use strict';

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const MSG_MAX = 2000;

  const S = {
    user: null, room: null,
    members: new Map(), msgs: [], ids: new Set(), hasMore: false,
    sb: null, channel: null, tokenTimer: null, memberTimer: null, connectedBefore: false,
  };

  // ---------- helpers ----------
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function hue(name) {
    let h = 0;
    for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360;
    return h;
  }
  function avatar(name, extra) {
    const a = el('div', 'avatar' + (extra ? ' ' + extra : ''), (name[0] || '?').toUpperCase());
    a.style.setProperty('--h', hue(name));
    return a;
  }
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast.t);
    toast.t = setTimeout(() => t.classList.remove('show'), 3500);
  }
  async function copy(text) {
    try { await navigator.clipboard.writeText(text); toast('Room Code copied'); }
    catch { toast('Copy failed. Select the code and copy it manually.'); }
  }

  async function api(path, { method = 'GET', body } = {}) {
    let res;
    try {
      res = await fetch('/api' + path, {
        method, credentials: 'same-origin',
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch { throw new Error('Network error'); }
    let data = null;
    try { data = await res.json(); } catch { /* empty body */ }
    if (!res.ok) {
      if (res.status === 401 && S.user) {
        teardown();
        show('login');
        $('#form-login .form-error').textContent = 'Authentication required';
      }
      const err = new Error((data && data.error) || 'Server error');
      err.status = res.status;
      throw err;
    }
    return data;
  }

  // ---------- views ----------
  function show(view) {
    const chat = view === 'chat';
    $('#auth').hidden = chat;
    $('#app').hidden = !chat;
    $$('[data-view]').forEach((s) => { s.hidden = s.dataset.view !== view; });
    $$('.form-error').forEach((p) => { p.textContent = ''; });
    if (!chat) {
      const first = $(`[data-view="${view}"] input`);
      if (first) first.focus({ preventScroll: true });
    }
  }
  $$('[data-nav]').forEach((b) => b.addEventListener('click', () => show(b.dataset.nav)));
  $$('.code-input').forEach((i) => i.addEventListener('input', () => {
    i.value = i.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  }));

  async function submit(e, fn) {
    e.preventDefault();
    const form = e.currentTarget;
    const err = $('.form-error', form);
    const btn = $('button[type="submit"]', form);
    err.textContent = '';
    btn.disabled = true;
    try { await fn(Object.fromEntries(new FormData(form)), form); }
    catch (ex) { err.textContent = ex.message; }
    finally { btn.disabled = false; }
  }
  function checkConfirm(f) {
    if (f.password !== f.confirmPassword) throw new Error('Password confirmation does not match');
  }

  $('#form-create').addEventListener('submit', (e) => submit(e, async (f, form) => {
    checkConfirm(f);
    const d = await api('/rooms', { method: 'POST', body: { username: f.username, password: f.password, confirmPassword: f.confirmPassword } });
    $('#new-code').textContent = d.roomCode;
    form.reset();
    show('created');
  }));
  $('#copy-new').addEventListener('click', () => copy($('#new-code').textContent));
  $('#enter-new').addEventListener('click', () => enterChat().catch((e) => toast(e.message)));

  $('#form-join').addEventListener('submit', (e) => submit(e, async (f, form) => {
    if (!/^[A-Z0-9]{6}$/.test(f.roomCode)) throw new Error('Invalid Room Code');
    checkConfirm(f);
    await api('/auth/join', { method: 'POST', body: f });
    form.reset();
    await enterChat();
  }));

  $('#form-login').addEventListener('submit', (e) => submit(e, async (f, form) => {
    if (!/^[A-Z0-9]{6}$/.test(f.roomCode)) throw new Error('Invalid Room Code');
    await api('/auth/login', { method: 'POST', body: { roomCode: f.roomCode, username: f.username, password: f.password } });
    form.reset();
    await enterChat();
  }));

  // ---------- chat lifecycle ----------
  async function enterChat() {
    const me = await api('/auth/me');
    S.user = me.user;
    S.room = me.room;
    $('#room-code').textContent = $('#head-code').textContent = S.room.roomCode;
    $('#me-name').textContent = S.user.username;
    const old = $('#me-avatar');
    const fresh = avatar(S.user.username);
    fresh.id = 'me-avatar';
    old.replaceWith(fresh);
    show('chat');
    setConn('connecting');
    await Promise.all([loadMembers(), loadMessages(true)]);
    startRealtime().catch(() => setConn('offline'));
    S.memberTimer = setInterval(() => { if (!document.hidden) loadMembers().catch(() => {}); }, 15000);
    $('#input').focus({ preventScroll: true });
  }

  function teardown() {
    clearTimeout(S.tokenTimer);
    clearInterval(S.memberTimer);
    try {
      if (S.sb && S.channel) S.sb.removeChannel(S.channel);
      if (S.sb) S.sb.realtime.disconnect();
    } catch { /* ignore */ }
    S.sb = S.channel = null;
    S.user = S.room = null;
    S.connectedBefore = false;
    S.members.clear();
    S.msgs = [];
    S.ids.clear();
    S.hasMore = false;
    $('#messages').replaceChildren();
    $('#member-list').replaceChildren();
    $('#input').value = '';
    closeDrawer();
  }

  $('#logout').addEventListener('click', async () => {
    try { await api('/auth/logout', { method: 'POST' }); } catch { /* cookie may already be gone */ }
    teardown();
    show('login');
  });
  $('#copy-room').addEventListener('click', () => copy(S.room.roomCode));

  // ---------- members ----------
  async function loadMembers() {
    const d = await api('/members');
    S.members = new Map(d.members.map((m) => [m.id, m]));
    const ul = $('#member-list');
    ul.replaceChildren(...d.members.map((m) => {
      const li = el('li', 'member');
      li.append(avatar(m.username), el('span', 'name', m.username));
      if (m.id === S.user.id) li.append(el('span', 'tag', 'You'));
      return li;
    }));
    $('#member-count').textContent = d.members.length;
  }

  // ---------- messages ----------
  async function loadMessages(initial, before) {
    const qs = new URLSearchParams({ limit: '100' });
    if (before) qs.set('before', before);
    const d = await api('/messages?' + qs);
    if (initial || before) S.hasMore = d.messages.length === 100;
    addMsgs(d.messages, { stick: initial });
  }

  function addMsgs(list, { stick = false, keepScroll = null } = {}) {
    let added = false;
    for (const m of list) {
      if (S.ids.has(m.id)) continue;
      S.ids.add(m.id);
      S.msgs.push(m);
      added = true;
    }
    if (!added && !stick) return;
    S.msgs.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    renderMessages(stick, keepScroll);
  }

  function dayLabel(d) {
    const today = new Date();
    const y = new Date(); y.setDate(today.getDate() - 1);
    if (d.toDateString() === today.toDateString()) return 'Today';
    if (d.toDateString() === y.toDateString()) return 'Yesterday';
    return d.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
  }

  function renderMessages(stick, keepScroll) {
    const box = $('#messages');
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 140;
    const frag = document.createDocumentFragment();

    if (S.hasMore) {
      const b = el('button', 'btn btn-glass small more', 'Load earlier messages');
      b.type = 'button';
      b.addEventListener('click', async () => {
        b.disabled = true;
        const prevHeight = box.scrollHeight;
        try { await loadMessages(false, S.msgs[0].createdAt); }
        catch (e) { toast(e.message); b.disabled = false; return; }
        box.scrollTop = box.scrollHeight - prevHeight;
      });
      frag.append(b);
    }
    if (!S.msgs.length) frag.append(el('p', 'empty', 'No messages yet. Say hello.'));

    let lastDay = '', lastMember = null;
    for (const m of S.msgs) {
      const d = new Date(m.createdAt);
      if (d.toDateString() !== lastDay) {
        lastDay = d.toDateString();
        lastMember = null;
        frag.append(el('div', 'day', dayLabel(d)));
      }
      const mine = m.memberId === S.user.id;
      const name = m.username || (S.members.get(m.memberId) || {}).username || 'Member';
      const row = el('article', 'msg' + (mine ? ' mine' : ''));
      row.style.setProperty('--h', hue(name));
      if (!mine && lastMember !== m.memberId) row.append(el('span', 'who', name));
      row.append(el('div', 'bubble', m.message));
      const t = el('time', null, d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
      t.dateTime = d.toISOString();
      row.append(t);
      frag.append(row);
      lastMember = m.memberId;
    }
    box.replaceChildren(frag);
    if (stick || nearBottom) box.scrollTop = box.scrollHeight;
  }

  // ---------- composer ----------
  const input = $('#input');
  function autosize() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 140) + 'px';
  }
  input.addEventListener('input', autosize);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      $('#composer').requestSubmit();
    }
  });
  $('#composer').addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return toast('Message cannot be empty');
    if (text.length > MSG_MAX) return toast(`Message must be ${MSG_MAX} characters or fewer`);
    input.value = '';
    autosize();
    try {
      const d = await api('/messages', { method: 'POST', body: { message: text } });
      addMsgs([d.message], { stick: true });
    } catch (ex) {
      if (S.user && !input.value) { input.value = text; autosize(); }
      if (S.user) toast(ex.message);
    }
    if (S.user) input.focus({ preventScroll: true });
  });

  // ---------- realtime ----------
  function setConn(state) {
    const c = $('#conn');
    c.dataset.state = state;
    $('em', c).textContent = state === 'live' ? 'Live' : state === 'offline' ? 'Reconnecting' : 'Connecting';
  }

  async function fetchRealtimeToken() {
    const d = await api('/realtime-token');
    S.sb.realtime.setAuth(d.token);
    clearTimeout(S.tokenTimer);
    S.tokenTimer = setTimeout(() => fetchRealtimeToken().catch(() => setConn('offline')), Math.max(60, d.expiresIn - 300) * 1000);
  }

  async function startRealtime() {
    if (!window.supabase) throw new Error('Realtime library failed to load');
    const cfg = await api('/config');
    S.sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    await fetchRealtimeToken();
    const roomId = S.room.id;
    S.channel = S.sb
      .channel('room-' + roomId)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter: `room_id=eq.${roomId}` },
        (p) => onIncoming(p.new))
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          setConn('live');
          if (S.connectedBefore) loadMessages(false).catch(() => {}); // fill any gap after a reconnect
          S.connectedBefore = true;
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          setConn('offline');
        }
      });
  }

  async function onIncoming(row) {
    if (!S.user || S.ids.has(row.id)) return;
    if (!S.members.has(row.member_id)) await loadMembers().catch(() => {});
    const m = S.members.get(row.member_id);
    addMsgs([{ id: row.id, memberId: row.member_id, username: m ? m.username : null, message: row.message, createdAt: row.created_at }]);
  }

  // ---------- drawer ----------
  const app = $('#app'), burger = $('#burger');
  function setDrawer(open) {
    app.classList.toggle('drawer-open', open);
    burger.setAttribute('aria-expanded', String(open));
    burger.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
  }
  function closeDrawer() { setDrawer(false); }
  burger.addEventListener('click', () => setDrawer(!app.classList.contains('drawer-open')));
  $('#scrim').addEventListener('click', closeDrawer);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });
  window.matchMedia('(min-width: 861px)').addEventListener('change', closeDrawer);

  // ---------- boot ----------
  enterChat().catch(() => show('landing'));
})();
