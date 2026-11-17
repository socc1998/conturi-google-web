'use strict';

/* ======================================================================
   Conturi Google (web) - Gmail + Drive pentru mai multe conturi.
   Pagina statica: nu exista server. Cheile de acces Google traiesc doar in
   memoria paginii (se pierd la inchidere). In browser se pastreaza doar
   lista adreselor de email.
   ====================================================================== */

const CFG = window.CONFIG || {};
const SCOPES = 'https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/drive';
const GM = 'https://gmail.googleapis.com/gmail/v1/users/me';
const DR = 'https://www.googleapis.com/drive/v3';
const FIELDS = 'nextPageToken,files(id,name,mimeType,size,modifiedTime,webViewLink,ownedByMe,owners(displayName,emailAddress),parents)';

// ---------------------------------------------------------------- utilitare

const $ = (s, r = document) => r.querySelector(s);
const enc = encodeURIComponent;

function h(tag, props, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'style') e.style.cssText = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'value' || k === 'checked' || k === 'selected' || k === 'disabled') e[k] = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    e.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return e;
}

const clean = (a) => a.flat().filter((x) => x != null && x !== false);
function fill(el, ...a) { el.replaceChildren(...clean(a)); }
function add(el, ...a) { el.append(...clean(a)); }

function sel(options, value, onchange) {
  const s = h('select', { onchange: (e) => onchange(e.target.value) });
  for (const [v, label] of options) s.append(h('option', { value: v, selected: v === value }, label));
  return s;
}

function loadJson(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch (e) { return fallback; }
}
function saveJson(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* ignora */ }
}

function accIdx(email) {
  let x = 0;
  for (const c of String(email).toLowerCase()) x = (x * 31 + c.charCodeAt(0)) | 0;
  return Math.abs(x) % 6;
}
function avatar(text, email, small) {
  return h('div', { class: `av a${accIdx(email)}${small ? ' sm' : ''}` }, (text || '?').trim().charAt(0).toUpperCase() || '?');
}

function fmtDate(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString('ro-RO', { hour: '2-digit', minute: '2-digit' });
  const opts = d.getFullYear() === now.getFullYear() ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' };
  return d.toLocaleDateString('ro-RO', opts);
}
function fmtSize(n) {
  n = Number(n);
  if (!n) return '';
  if (n < 1024) return n + ' B';
  if (n < 1048576) return Math.round(n / 1024) + ' KB';
  if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
  return (n / 1073741824).toFixed(1) + ' GB';
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('on'), 5000);
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const k = i++;
      try { out[k] = await fn(items[k]); } catch (e) { out[k] = null; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

// ----------------------------------------------------------- stare globala

const S = {
  tab: 'email',
  accounts: loadJson('accounts', []),
  tokens: {},
  inbox: [],
  inboxQuery: '',
  inboxLoading: false,
  inboxStale: false,
  opened: null,
  drive: {
    account: null, stack: [], query: '', type: 'all', owner: 'any', when: 'any',
    allDrives: false, items: [], loading: false, stale: false,
  },
};
if (S.accounts.length) S.drive.account = S.accounts[0];

function saveAccounts() { saveJson('accounts', S.accounts); }
function hasToken(email) { const t = S.tokens[email]; return !!(t && t.exp > Date.now()); }
function setToken(email, r) {
  S.tokens[email] = { token: r.access_token, exp: Date.now() + (Number(r.expires_in) || 3600) * 1000 - 60000 };
  S.inboxStale = true; // un cont nou conectat => reincarca la urmatoarea afisare
  S.drive.stale = true;
}
function clientIdMissing() { return !CFG.CLIENT_ID || String(CFG.CLIENT_ID).startsWith('PUNE'); }

// ----------------------------------------------------------- autentificare

function popupMsg(e) {
  const t = e && e.type;
  if (t === 'popup_failed_to_open') return 'Browserul a blocat fereastra Google. Permite ferestrele pop-up pentru această pagină.';
  if (t === 'popup_closed') return 'Ai închis fereastra Google înainte să termini.';
  return 'Conectarea a eșuat.';
}

function requestToken(hint, prompt) {
  return new Promise((resolve, reject) => {
    if (!window.google || !google.accounts || !google.accounts.oauth2) {
      return reject(new Error('Biblioteca Google nu s-a încărcat. Reîncarcă pagina.'));
    }
    if (clientIdMissing()) return reject(new Error('Lipsește Client ID în config.js.'));
    const cfg = {
      client_id: CFG.CLIENT_ID,
      scope: SCOPES,
      prompt: prompt || '',
      callback: (r) => (r.error ? reject(new Error(r.error_description || r.error)) : resolve(r)),
      error_callback: (e) => reject(new Error(popupMsg(e))),
    };
    if (hint) cfg.hint = hint;
    google.accounts.oauth2.initTokenClient(cfg).requestAccessToken();
  });
}

async function http(url, tok, opts = {}) {
  const headers = { Authorization: 'Bearer ' + tok };
  if (opts.json) headers['Content-Type'] = 'application/json';
  if (opts.headers) Object.assign(headers, opts.headers);
  const r = await fetch(url, {
    method: opts.method || 'GET',
    headers,
    body: opts.json ? JSON.stringify(opts.json) : opts.body,
  });
  const text = await r.text();
  if (!r.ok) {
    let m = '';
    try { m = JSON.parse(text).error.message; } catch (e) { /* ignora */ }
    const err = new Error(`Eroare ${r.status}` + (m ? ': ' + m : ''));
    err.status = r.status;
    throw err;
  }
  return text ? JSON.parse(text) : {};
}

async function token(email) {
  if (hasToken(email)) return S.tokens[email].token;
  const r = await requestToken(email, '');
  setToken(email, r);
  renderSide();
  return r.access_token;
}

async function gapi(email, url, opts) {
  const tok = await token(email);
  try {
    return await http(url, tok, opts);
  } catch (e) {
    if (e.status === 401) {
      delete S.tokens[email];
      return http(url, await token(email), opts);
    }
    throw e;
  }
}

async function addAccount() {
  try {
    const r = await requestToken(null, 'select_account');
    const p = await http(GM + '/profile', r.access_token);
    const email = String(p.emailAddress).toLowerCase();
    setToken(email, r);
    if (!S.accounts.includes(email)) {
      S.accounts.push(email);
      saveAccounts();
    }
    if (!S.drive.account) S.drive.account = email;
    toast('Cont conectat: ' + email);
    showTab(S.tab);
  } catch (e) {
    toast(e.message);
  }
}

async function connect(email, quiet) {
  try {
    const r = await requestToken(email, '');
    const p = await http(GM + '/profile', r.access_token);
    if (String(p.emailAddress).toLowerCase() !== email) {
      toast(`Ai ales ${p.emailAddress}, nu ${email}. Încearcă din nou.`);
      return false;
    }
    setToken(email, r);
    renderSide();
    return true;
  } catch (e) {
    if (!quiet) toast(e.message);
    return false;
  }
}

// La deschiderea paginii incearca sa conecteze singur conturile (fara intrebari, daca ai
// dat deja permisiunile). Daca browserul blocheaza ferestrele pop-up, se opreste in liniste
// si ramane butonul „Conecteaza toate”.
async function autoConnect() {
  if (clientIdMissing() || !S.accounts.length) return;
  for (let i = 0; i < 50 && !(window.google && google.accounts && google.accounts.oauth2); i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  for (const a of S.accounts) {
    if (hasToken(a)) continue;
    if (!(await connect(a, true))) break;
  }
  showTab(S.tab);
}

async function connectAll() {
  for (const a of S.accounts) {
    if (!hasToken(a)) {
      const ok = await connect(a);
      if (!ok) break;
    }
  }
  showTab(S.tab);
}

function removeAccount(email) {
  S.accounts = S.accounts.filter((a) => a !== email);
  delete S.tokens[email];
  saveAccounts();
  S.inbox = S.inbox.filter((m) => m.account !== email);
  if (S.drive.account === email) { S.drive.account = S.accounts[0] || null; S.drive.stack = []; S.drive.items = []; }
  showTab(S.tab);
}

// ------------------------------------------------------------ ferestre

function closeModal() { $('#overlay').replaceChildren(); }

function openModal(title, content, buttons) {
  const foot = h('div', { class: 'foot' }, buttons || []);
  const box = h('div', { class: 'modal', role: 'dialog', 'aria-label': title }, h('h3', {}, title), content, foot);
  const ov = $('#overlay');
  ov.replaceChildren(box);
  ov.onmousedown = (e) => { if (e.target === ov) closeModal(); };
  return box;
}

function confirmBox(title, text, okLabel, danger) {
  return new Promise((resolve) => {
    openModal(title, h('p', {}, text), [
      h('button', { class: 'btn', onclick: () => { closeModal(); resolve(false); } }, 'Renunță'),
      h('button', { class: 'btn ' + (danger ? 'dan' : 'pri'), onclick: () => { closeModal(); resolve(true); } }, okLabel),
    ]);
  });
}

function promptBox(title, label, initial, okLabel) {
  return new Promise((resolve) => {
    const inp = h('input', { type: 'text', value: initial || '' });
    const done = (v) => { closeModal(); resolve(v); };
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(inp.value.trim()); });
    openModal(title, h('div', { class: 'field' }, h('label', {}, label), inp), [
      h('button', { class: 'btn', onclick: () => done(null) }, 'Renunță'),
      h('button', { class: 'btn pri', onclick: () => done(inp.value.trim()) }, okLabel),
    ]);
    inp.focus();
  });
}

function openMenu(anchor, items) {
  document.querySelectorAll('.menu').forEach((m) => m.remove());
  const r = anchor.getBoundingClientRect();
  const m = h('div', { class: 'menu', style: `top:${Math.min(r.bottom + 4, window.innerHeight - items.length * 40 - 16)}px;left:${Math.max(8, r.right - 180)}px` });
  for (const [label, fn] of items) {
    m.append(h('button', { onclick: () => { m.remove(); fn(); } }, label));
  }
  document.body.append(m);
  setTimeout(() => {
    const off = (e) => { if (!m.contains(e.target)) { m.remove(); document.removeEventListener('mousedown', off); } };
    document.addEventListener('mousedown', off);
  });
}

document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeModal(); document.querySelectorAll('.menu').forEach((m) => m.remove()); } });

// ------------------------------------------------------------ bara laterala

function renderSide() {
  const side = $('#side');
  const nav = (key, label) => h('button', { class: S.tab === key ? 'on' : '', onclick: () => showTab(key) }, label);
  const disconnected = S.accounts.filter((a) => !hasToken(a));
  fill(side,
    h('div', { class: 'brand' }, 'Conturi Google'),
    h('div', { class: 'nav' }, nav('email', 'Email'), nav('drive', 'Drive'), nav('accounts', 'Conturi')),
    h('div', { class: 'sidehead' }, 'Conturi'),
    S.accounts.length === 0 ? h('div', { class: 'muted', style: 'padding:6px 12px;font-size:13px' }, 'Niciun cont adăugat.') : null,
    S.accounts.map((a) => h('div', {
      class: 'chip', title: hasToken(a) ? 'Conectat' : 'Apasă ca să te conectezi',
      onclick: async () => { if (!hasToken(a)) { if (await connect(a)) showTab(S.tab); } },
    }, avatar(a, a, true), h('div', { class: 'em' }, a), h('span', { class: 'dot' + (hasToken(a) ? ' ok' : '') }))),
    disconnected.length ? h('button', { class: 'btn', style: 'margin:10px 4px 0', onclick: connectAll }, 'Conectează toate') : null,
    h('div', { class: 'side-foot' }, 'Datele nu trec prin niciun server. Cheile Google rămân doar în această pagină.'),
  );
}

function banner() {
  if (clientIdMissing()) {
    return h('div', { class: 'banner warn' }, 'Pagina nu e configurată încă (lipsește Client ID în config.js).');
  }
  const n = S.accounts.filter((a) => !hasToken(a)).length;
  if (!n) return null;
  return h('div', { class: 'banner' },
    h('span', { style: 'flex:1' }, n === 1 ? 'Un cont nu este conectat în această sesiune.' : `${n} conturi nu sunt conectate în această sesiune.`),
    h('button', { class: 'btn pri', onclick: connectAll }, 'Conectează'));
}

function showTab(t) {
  S.tab = t;
  closeModal();
  renderSide();
  const m = $('#main');
  m.replaceChildren();
  m.ondragover = m.ondrop = m.ondragleave = null;
  if (t === 'email') buildEmail(m);
  else if (t === 'drive') buildDrive(m);
  else buildAccounts(m);
}

// ================================================================== EMAIL

const MAIL = { listEl: null, paneEl: null };

function headerMap(payload) {
  const o = {};
  for (const x of (payload && payload.headers) || []) o[x.name.toLowerCase()] = x.value;
  return o;
}

function senderName(from) {
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]*)>\s*$/.exec(from || '');
  if (m) return m[1].trim() || m[2];
  return (from || '').trim();
}
function senderAddr(from) {
  const m = /<([^>]*)>/.exec(from || '');
  return (m ? m[1] : from || '').trim();
}

function toMsg(account, m) {
  const hd = headerMap(m.payload);
  return {
    account, id: m.id, threadId: m.threadId,
    from: hd['from'] || '', subject: hd['subject'] || '(fără subiect)',
    date: Number(m.internalDate) || 0, snippet: m.snippet || '',
    unread: (m.labelIds || []).includes('UNREAD'),
  };
}

async function listInboxFor(email, q) {
  let url = `${GM}/messages?maxResults=25` + (q ? `&q=${enc(q)}` : '&labelIds=INBOX');
  const l = await gapi(email, url);
  const ids = (l.messages || []).map((m) => m.id);
  const metas = await pool(ids, 8, (id) => gapi(email,
    `${GM}/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`));
  return metas.filter(Boolean).map((m) => toMsg(email, m));
}

async function refreshInbox() {
  S.inboxLoading = true;
  S.inboxStale = false;
  paintInbox();
  const accs = S.accounts.filter(hasToken);
  const res = await Promise.allSettled(accs.map((a) => listInboxFor(a, S.inboxQuery)));
  const all = [];
  let err = null;
  for (const r of res) { if (r.status === 'fulfilled') all.push(...r.value); else err = err || r.reason; }
  all.sort((a, b) => b.date - a.date);
  S.inbox = all.slice(0, 150);
  S.inboxLoading = false;
  if (err) toast(err.message);
  paintInbox();
  if (S.inboxStale && S.tab === 'email') refreshInbox(); // s-a conectat un cont cat timp se incarca
}

function buildEmail(m) {
  const search = h('input', {
    type: 'search', placeholder: 'Caută în toate conturile…', value: S.inboxQuery,
    onkeydown: (e) => { if (e.key === 'Enter') { S.inboxQuery = e.target.value.trim(); S.opened = null; refreshInbox(); paintPane(); } },
  });
  MAIL.listEl = h('div', { class: 'list' });
  MAIL.paneEl = h('div', { class: 'pane' });
  add(m,
    h('div', { class: 'top' },
      h('h1', {}, 'Email'),
      h('div', { class: 'grow' }, search),
      h('button', { class: 'btn', onclick: () => refreshInbox() }, 'Reîncarcă'),
      h('button', { class: 'btn pri', onclick: () => composeNew() }, 'Mesaj nou')),
    banner(),
    h('div', { class: 'split' }, MAIL.listEl, MAIL.paneEl),
  );
  paintInbox();
  paintPane();
  if ((S.inboxStale || !S.inbox.length) && S.accounts.some(hasToken) && !S.inboxLoading) refreshInbox();
}

function paintInbox() {
  const el = MAIL.listEl;
  if (!el || S.tab !== 'email') return;
  el.replaceChildren();
  if (!S.accounts.length) { el.append(h('div', { class: 'empty' }, 'Adaugă un cont la „Conturi”.')); return; }
  if (S.inboxLoading) el.append(h('div', { class: 'empty' }, 'Se încarcă…'));
  else if (!S.inbox.length) el.append(h('div', { class: 'empty' }, S.accounts.some(hasToken) ? 'Niciun mesaj.' : 'Conectează conturile ca să vezi mesajele.'));
  for (const msg of S.inbox) {
    const cur = S.opened && S.opened.msg.id === msg.id && S.opened.msg.account === msg.account;
    el.append(h('div', { class: 'msg' + (msg.unread ? ' unread' : '') + (cur ? ' sel' : ''), onclick: () => openMessage(msg) },
      avatar(senderName(msg.from), msg.account),
      h('div', { class: 'mid' },
        h('div', { class: 'row1' }, h('span', { class: 'who' }, senderName(msg.from)), h('span', { class: 'when' }, fmtDate(msg.date))),
        h('div', { class: 'sub' }, msg.subject),
        h('div', { class: 'snip' }, msg.snippet),
        h('div', { class: `acc tx${accIdx(msg.account)}` }, msg.account))));
  }
}

function b64urlToText(s) {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return new TextDecoder('utf-8').decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

function bodyOf(payload) {
  let plain = '', html = '';
  const attachments = [];
  (function walk(p) {
    if (!p) return;
    const mt = p.mimeType || '';
    if (p.filename) attachments.push(p.filename);
    if (p.body && p.body.data && !p.filename) {
      const txt = b64urlToText(p.body.data);
      if (mt === 'text/plain') plain += txt;
      else if (mt === 'text/html') html += txt;
    }
    (p.parts || []).forEach(walk);
  })(payload);
  let text = plain;
  if (!text.trim() && html) {
    const d = new DOMParser().parseFromString(html, 'text/html');
    d.querySelectorAll('script,style,head').forEach((n) => n.remove());
    d.querySelectorAll('br').forEach((b) => b.replaceWith('\n'));
    d.querySelectorAll('p,div,tr,li,h1,h2,h3').forEach((n) => n.append('\n'));
    text = (d.body ? d.body.textContent : '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }
  return { text: text.trim(), attachments };
}

async function openMessage(msg) {
  S.opened = { msg, loading: true };
  paintInbox();
  paintPane();
  try {
    const f = await gapi(msg.account, `${GM}/messages/${msg.id}?format=full`);
    const hd = headerMap(f.payload);
    const b = bodyOf(f.payload);
    if (!S.opened || S.opened.msg.id !== msg.id) return;
    S.opened = {
      msg, loading: false, text: b.text, attachments: b.attachments,
      to: hd['to'] || '', cc: hd['cc'] || '', replyTo: hd['reply-to'] || '',
      messageId: hd['message-id'] || '', references: hd['references'] || '',
    };
    if (msg.unread) {
      msg.unread = false;
      gapi(msg.account, `${GM}/messages/${msg.id}/modify`, { method: 'POST', json: { removeLabelIds: ['UNREAD'] } }).catch(() => {});
    }
  } catch (e) {
    toast(e.message);
    S.opened = null;
  }
  paintInbox();
  paintPane();
}

function paintPane() {
  const el = MAIL.paneEl;
  if (!el || S.tab !== 'email') return;
  el.replaceChildren();
  const o = S.opened;
  if (!o) { el.append(h('div', { class: 'empty' }, 'Alege un mesaj din listă.')); return; }
  const m = o.msg;
  if (o.loading) { el.append(h('div', { class: 'empty' }, 'Se încarcă mesajul…')); return; }
  el.append(
    h('div', { class: 'mh' },
      h('h2', {}, m.subject),
      h('div', { class: 'meta' },
        h('div', {}, 'De la: ', m.from),
        o.to ? h('div', {}, 'Către: ', o.to) : null,
        o.cc ? h('div', {}, 'Cc: ', o.cc) : null,
        h('div', {}, new Date(m.date).toLocaleString('ro-RO'), ' · ', h('span', { class: `tx${accIdx(m.account)}` }, m.account)),
        o.attachments.length ? h('div', {}, 'Atașamente: ', o.attachments.join(', '), ' (le deschizi în Gmail)') : null)),
    h('div', { class: 'actions' },
      h('button', { class: 'btn pri', onclick: () => composeReply(o) }, 'Răspunde'),
      h('button', { class: 'btn', onclick: () => archiveMsg(m) }, 'Arhivează'),
      h('button', { class: 'btn dan', onclick: () => trashMsg(m) }, 'Mută în coș'),
      h('a', { class: 'btn', style: 'text-decoration:none', target: '_blank', rel: 'noopener', href: `https://mail.google.com/mail/u/${enc(m.account)}/#all/${m.threadId}` }, 'Deschide în Gmail')),
    h('pre', { class: 'body' }, o.text || '(mesaj fără text)'));
}

function dropFromInbox(m) {
  S.inbox = S.inbox.filter((x) => !(x.id === m.id && x.account === m.account));
  S.opened = null;
  paintInbox();
  paintPane();
}
async function archiveMsg(m) {
  try {
    await gapi(m.account, `${GM}/messages/${m.id}/modify`, { method: 'POST', json: { removeLabelIds: ['INBOX'] } });
    dropFromInbox(m);
    toast('Mesaj arhivat.');
  } catch (e) { toast(e.message); }
}
async function trashMsg(m) {
  if (!(await confirmBox('Muți mesajul în coș?', 'Îl poți recupera din Gmail în următoarele 30 de zile.', 'Mută în coș', true))) return;
  try {
    await gapi(m.account, `${GM}/messages/${m.id}/trash`, { method: 'POST' });
    dropFromInbox(m);
    toast('Mesaj mutat în coș.');
  } catch (e) { toast(e.message); }
}

// ---- trimitere

function utf8Bytes(s) { return new TextEncoder().encode(s); }
function bytesToB64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
function b64url(bytes) { return bytesToB64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function encHeader(s) { return /^[\x20-\x7e]*$/.test(s) ? s : '=?UTF-8?B?' + bytesToB64(utf8Bytes(s)) + '?='; }

function buildMime(d) {
  const lines = [
    `From: ${d.from}`, `To: ${d.to}`, `Subject: ${encHeader(d.subject)}`, 'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64',
  ];
  if (d.inReplyTo) lines.push(`In-Reply-To: ${d.inReplyTo}`);
  if (d.references) lines.push(`References: ${d.references}`);
  const body = bytesToB64(utf8Bytes(d.body)).replace(/(.{76})/g, '$1\r\n');
  return lines.join('\r\n') + '\r\n\r\n' + body;
}

function composeNew() {
  const from = (S.opened && S.opened.msg.account) || S.accounts.find(hasToken) || S.accounts[0];
  if (!from) { toast('Adaugă mai întâi un cont.'); return; }
  openCompose({ from, to: '', subject: '', body: '' });
}

function composeReply(o) {
  const m = o.msg;
  const to = senderAddr(o.replyTo || m.from);
  const subject = /^re:/i.test(m.subject) ? m.subject : 'Re: ' + m.subject;
  const quoted = (o.text || '').split('\n').map((l) => '> ' + l).join('\n');
  const when = new Date(m.date).toLocaleString('ro-RO');
  openCompose({
    from: m.account, to, subject,
    body: `\n\nPe ${when}, ${m.from} a scris:\n${quoted}`,
    threadId: m.threadId, inReplyTo: o.messageId,
    references: (o.references ? o.references + ' ' : '') + o.messageId,
  });
}

function openCompose(d) {
  const from = sel(S.accounts.map((a) => [a, a]), d.from, (v) => { d.from = v; });
  const to = h('input', { type: 'text', value: d.to, placeholder: 'adresa@exemplu.ro' });
  const subj = h('input', { type: 'text', value: d.subject });
  const body = h('textarea', { value: d.body });
  const sendBtn = h('button', {
    class: 'btn pri',
    onclick: async () => {
      if (!to.value.trim()) { toast('Scrie destinatarul.'); return; }
      sendBtn.disabled = true;
      try {
        const raw = b64url(utf8Bytes(buildMime({
          from: d.from, to: to.value.trim(), subject: subj.value, body: body.value,
          inReplyTo: d.inReplyTo, references: d.references,
        })));
        await gapi(d.from, `${GM}/messages/send`, { method: 'POST', json: d.threadId ? { raw, threadId: d.threadId } : { raw } });
        closeModal();
        toast('Mesaj trimis.');
      } catch (e) {
        sendBtn.disabled = false;
        toast(e.message);
      }
    },
  }, 'Trimite');
  openModal(d.threadId ? 'Răspuns' : 'Mesaj nou', h('div', {},
    h('div', { class: 'field' }, h('label', {}, 'De la'), from),
    h('div', { class: 'field' }, h('label', {}, 'Către'), to),
    h('div', { class: 'field' }, h('label', {}, 'Subiect'), subj),
    h('div', { class: 'field' }, h('label', {}, 'Mesaj'), body)),
  [h('button', { class: 'btn', onclick: closeModal }, 'Renunță'), sendBtn]);
  (d.to ? body : to).focus();
}

// ================================================================== DRIVE

const FOLDER = 'application/vnd.google-apps.folder';
const GA = 'application/vnd.google-apps.';
const OX = 'application/vnd.openxmlformats-officedocument.';
const TYPES = {
  all: { label: 'Toate tipurile' },
  folder: { label: 'Foldere', q: [`mimeType='${FOLDER}'`] },
  doc: { label: 'Documente (Docs, Word)', q: [`mimeType='${GA}document'`, `mimeType='${OX}wordprocessingml.document'`, "mimeType='application/msword'"] },
  sheet: { label: 'Foi de calcul (Sheets, Excel)', q: [`mimeType='${GA}spreadsheet'`, `mimeType='${OX}spreadsheetml.sheet'`, "mimeType='application/vnd.ms-excel'"] },
  slides: { label: 'Prezentări', q: [`mimeType='${GA}presentation'`, `mimeType='${OX}presentationml.presentation'`] },
  form: { label: 'Formulare (Forms)', q: [`mimeType='${GA}form'`] },
  pdf: { label: 'PDF', q: ["mimeType='application/pdf'"] },
  image: { label: 'Imagini', q: ["mimeType contains 'image/'"] },
  av: { label: 'Audio și video', q: ["mimeType contains 'audio/'", "mimeType contains 'video/'"] },
};
const OWNERS = [['any', 'Proprietar: oricare'], ['mine', 'Ale mele'], ['shared', 'Partajate cu mine']];
const WHENS = [['any', 'Oricând'], ['7', 'Ultimele 7 zile'], ['30', 'Ultimele 30 de zile'], ['365', 'Ultimul an']];

function kindOf(mime) {
  mime = mime || '';
  if (mime === FOLDER) return ['folder', 'DIR'];
  if (mime === GA + 'document' || mime.includes('wordprocessingml') || mime === 'application/msword') return ['doc', 'DOC'];
  if (mime === GA + 'spreadsheet' || mime.includes('spreadsheetml') || mime === 'application/vnd.ms-excel') return ['sheet', 'XLS'];
  if (mime === GA + 'presentation' || mime.includes('presentationml')) return ['slides', 'PPT'];
  if (mime === GA + 'form') return ['form', 'FRM'];
  if (mime === 'application/pdf') return ['pdf', 'PDF'];
  if (mime.startsWith('image/')) return ['image', 'IMG'];
  if (mime.startsWith('audio/') || mime.startsWith('video/')) return ['av', 'A/V'];
  return ['other', 'FIȘ'];
}

const qs = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
const DRV = { crumbEl: null, bodyEl: null, searchEl: null };

function isGlobal() {
  const d = S.drive;
  return !!(d.query || d.type !== 'all' || d.owner !== 'any' || d.when !== 'any');
}

function searchQuery() {
  const d = S.drive;
  const parts = ['trashed=false'];
  if (d.query) parts.push(`(name contains '${qs(d.query)}' or fullText contains '${qs(d.query)}')`);
  if (d.type !== 'all') parts.push('(' + TYPES[d.type].q.join(' or ') + ')');
  if (d.owner === 'mine') parts.push("'me' in owners");
  if (d.owner === 'shared') parts.push('sharedWithMe=true');
  if (d.when !== 'any') parts.push(`modifiedTime > '${new Date(Date.now() - Number(d.when) * 864e5).toISOString()}'`);
  return parts.join(' and ');
}

async function driveSearchFor(email) {
  const d = S.drive;
  let url = `${DR}/files?q=${enc(searchQuery())}&fields=${enc(FIELDS)}&pageSize=100&supportsAllDrives=true&includeItemsFromAllDrives=true`;
  if (d.allDrives) url += '&corpora=allDrives';
  if (!d.query) url += '&orderBy=' + enc('modifiedTime desc'); // orderBy nu merge impreuna cu fullText
  const r = await gapi(email, url);
  return (r.files || []).map((f) => ({ ...f, account: email }));
}

async function driveListFor(email, parent) {
  const q = `'${qs(parent)}' in parents and trashed=false`;
  const url = `${DR}/files?q=${enc(q)}&fields=${enc(FIELDS)}&pageSize=200&orderBy=${enc('folder,name')}&supportsAllDrives=true&includeItemsFromAllDrives=true`;
  const r = await gapi(email, url);
  return (r.files || []).map((f) => ({ ...f, account: email }));
}

function mergeDuplicates(files) {
  const map = new Map();
  for (const f of files) {
    const prev = map.get(f.id);
    if (prev) prev.accounts.push(f.account);
    else map.set(f.id, { ...f, accounts: [f.account] });
  }
  return [...map.values()];
}

async function loadDrive() {
  const d = S.drive;
  d.loading = true;
  d.stale = false;
  paintDrive();
  try {
    if (isGlobal()) {
      const accs = S.accounts.filter(hasToken);
      const res = await Promise.allSettled(accs.map(driveSearchFor));
      const all = [];
      let err = null;
      for (const r of res) { if (r.status === 'fulfilled') all.push(...r.value); else err = err || r.reason; }
      d.items = mergeDuplicates(all).sort((a, b) => String(b.modifiedTime).localeCompare(String(a.modifiedTime)));
      if (err) toast(err.message);
    } else if (d.account && hasToken(d.account)) {
      const parent = d.stack.length ? d.stack[d.stack.length - 1].id : 'root';
      d.items = (await driveListFor(d.account, parent)).map((f) => ({ ...f, accounts: [f.account] }));
    } else {
      d.items = [];
    }
  } catch (e) {
    toast(e.message);
    d.items = [];
  }
  d.loading = false;
  paintDrive();
  if (d.stale && S.tab === 'drive') loadDrive();
}

function resetFilters() {
  Object.assign(S.drive, { query: '', type: 'all', owner: 'any', when: 'any' });
  showTab('drive');
}

function buildDrive(m) {
  const d = S.drive;
  const search = h('input', {
    type: 'search', placeholder: 'Caută în toate conturile…', value: d.query,
    onkeydown: (e) => { if (e.key === 'Enter') { d.query = e.target.value.trim(); loadDrive(); } },
  });
  DRV.searchEl = search;
  DRV.crumbEl = h('div', { class: 'crumb' });
  DRV.bodyEl = h('div', { class: 'tablewrap' });
  const fileInput = h('input', { type: 'file', multiple: true, style: 'display:none', onchange: (e) => { uploadFiles([...e.target.files]); e.target.value = ''; } });

  add(m,
    h('div', { class: 'top' },
      h('h1', {}, 'Drive'),
      h('div', { class: 'grow' }, search),
      h('button', { class: 'btn', onclick: () => { d.query = search.value.trim(); loadDrive(); } }, 'Caută'),
      h('button', { class: 'btn', onclick: newFolder }, 'Folder nou'),
      h('button', { class: 'btn pri', onclick: () => { if (blockedUpload()) return; fileInput.click(); } }, 'Încarcă'),
      fileInput),
    h('div', { class: 'filters' },
      sel(S.accounts.map((a) => [a, a]), d.account, (v) => { d.account = v; d.stack = []; loadDrive(); }),
      sel(Object.entries(TYPES).map(([k, v]) => [k, v.label]), d.type, (v) => { d.type = v; loadDrive(); }),
      sel(OWNERS, d.owner, (v) => { d.owner = v; loadDrive(); }),
      sel(WHENS, d.when, (v) => { d.when = v; loadDrive(); }),
      h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: d.allDrives, onchange: (e) => { d.allDrives = e.target.checked; if (isGlobal()) loadDrive(); } }), 'Include Drive-urile partajate'),
      h('button', { class: 'btn', onclick: resetFilters }, 'Resetează')),
    banner(),
    DRV.crumbEl,
    DRV.bodyEl,
  );
  m.ondragover = (e) => { e.preventDefault(); m.classList.add('dropping'); };
  m.ondragleave = () => m.classList.remove('dropping');
  m.ondrop = (e) => { e.preventDefault(); m.classList.remove('dropping'); uploadFiles([...e.dataTransfer.files]); };
  paintDrive();
  if ((d.stale || !d.items.length) && !d.loading && S.accounts.some(hasToken)) loadDrive();
}

function paintDrive() {
  if (!DRV.bodyEl || S.tab !== 'drive') return;
  const d = S.drive;
  const crumb = DRV.crumbEl;
  crumb.replaceChildren();
  if (isGlobal()) {
    crumb.append(h('span', {}, `Rezultate din toate conturile conectate (${d.items.length})`));
  } else {
    crumb.append(h('a', { onclick: () => { d.stack = []; loadDrive(); } }, 'Drive-ul meu'), h('span', {}, `(${d.account || 'niciun cont'})`));
    d.stack.forEach((s, i) => {
      crumb.append(h('span', {}, '›'), h('a', { onclick: () => { d.stack = d.stack.slice(0, i + 1); loadDrive(); } }, s.name));
    });
  }
  const body = DRV.bodyEl;
  body.replaceChildren();
  if (!S.accounts.length) { body.append(h('div', { class: 'empty' }, 'Adaugă un cont la „Conturi”.')); return; }
  if (d.loading) { body.append(h('div', { class: 'empty' }, 'Se încarcă…')); return; }
  if (!d.items.length) {
    body.append(h('div', { class: 'empty' }, S.accounts.some(hasToken) ? 'Niciun fișier.' : 'Conectează conturile ca să vezi fișierele.'));
    return;
  }
  const rows = d.items.map((f) => {
    const [kind, tag] = kindOf(f.mimeType);
    const isDir = f.mimeType === FOLDER;
    const owner = f.owners && f.owners[0];
    const who = f.ownedByMe ? 'Eu' : owner ? (owner.displayName || owner.emailAddress) : '';
    const menuBtn = h('button', { class: 'btn', style: 'padding:4px 10px', 'aria-label': 'Acțiuni' }, '⋮');
    menuBtn.addEventListener('click', () => openMenu(menuBtn, [
      ['Deschide', () => window.open(f.webViewLink, '_blank', 'noopener')],
      ['Partajează…', () => shareDialog(f)],
      ['Mută…', () => moveDialog(f)],
      ['Mută în coș', () => trashFile(f)],
    ]));
    return h('tr', { class: 'f' },
      h('td', {}, h('div', { class: 'nm' }, h('div', { class: `ic ${kind}` }, tag),
        h('div', { class: 't', onclick: () => (isDir ? enterFolder(f) : window.open(f.webViewLink, '_blank', 'noopener')) }, f.name))),
      h('td', { class: 'mut' }, f.accounts.map((a) => h('div', { class: `tx${accIdx(a)}` }, a))),
      h('td', { class: 'mut' }, f.ownedByMe ? 'Eu' : who ? 'Partajat de ' + who : ''),
      h('td', { class: 'mut' }, f.modifiedTime ? fmtDate(Date.parse(f.modifiedTime)) : ''),
      h('td', { class: 'mut' }, isDir ? '' : fmtSize(f.size)),
      h('td', { style: 'text-align:right' }, menuBtn));
  });
  body.append(h('table', {},
    h('thead', {}, h('tr', {}, ['Nume', 'Cont', 'Proprietar', 'Modificat', 'Mărime', ''].map((t) => h('th', {}, t)))),
    h('tbody', {}, rows)));
}

function enterFolder(f) {
  const d = S.drive;
  if (isGlobal()) {
    Object.assign(d, { query: '', type: 'all', owner: 'any', when: 'any', account: f.accounts[0], stack: [{ id: f.id, name: f.name }] });
    showTab('drive');
    loadDrive();
  } else {
    d.stack = [...d.stack, { id: f.id, name: f.name }];
    loadDrive();
  }
}

function currentParent() { const s = S.drive.stack; return s.length ? s[s.length - 1].id : 'root'; }

function blockedUpload() {
  if (isGlobal()) { toast('Șterge căutarea și filtrele (Resetează), apoi alege folderul în care încarci.'); return true; }
  if (!S.drive.account || !hasToken(S.drive.account)) { toast('Conectează contul ales mai întâi.'); return true; }
  return false;
}

async function uploadOne(email, file, parent) {
  const meta = { name: file.name, parents: [parent] };
  const boundary = 'b' + Math.random().toString(36).slice(2);
  const body = new Blob([
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n`,
    `--${boundary}\r\nContent-Type: ${file.type || 'application/octet-stream'}\r\n\r\n`, file, `\r\n--${boundary}--`,
  ]);
  const tok = await token(email);
  return http(`https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,name`, tok, {
    method: 'POST', body, headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
  });
}

async function uploadFiles(files) {
  if (!files.length || S.tab !== 'drive' || blockedUpload()) return;
  const email = S.drive.account, parent = currentParent();
  let ok = 0;
  for (const f of files) {
    toast(`Se încarcă ${f.name}… (${ok + 1}/${files.length})`);
    try { await uploadOne(email, f, parent); ok++; } catch (e) { toast(`${f.name}: ${e.message}`); }
  }
  if (ok) toast(ok === 1 ? 'Fișier încărcat.' : `${ok} fișiere încărcate.`);
  loadDrive();
}

async function newFolder() {
  if (blockedUpload()) return;
  const name = await promptBox('Folder nou', 'Nume', '', 'Creează');
  if (!name) return;
  try {
    await gapi(S.drive.account, `${DR}/files?supportsAllDrives=true&fields=id`, { method: 'POST', json: { name, mimeType: FOLDER, parents: [currentParent()] } });
    toast('Folder creat.');
    loadDrive();
  } catch (e) { toast(e.message); }
}

async function trashFile(f) {
  if (!(await confirmBox('Muți în coș?', `„${f.name}” va fi mutat în coșul Drive.`, 'Mută în coș', true))) return;
  try {
    await gapi(f.accounts[0], `${DR}/files/${f.id}?supportsAllDrives=true`, { method: 'PATCH', json: { trashed: true } });
    S.drive.items = S.drive.items.filter((x) => x.id !== f.id);
    paintDrive();
    toast('Mutat în coș.');
  } catch (e) { toast(e.message); }
}

function shareDialog(f) {
  const email = h('input', { type: 'email', placeholder: 'adresa@exemplu.ro' });
  const role = sel([['reader', 'Cititor'], ['commenter', 'Comentator'], ['writer', 'Editor']], 'reader', () => {});
  const notify = h('input', { type: 'checkbox', checked: true });
  openModal(`Partajează „${f.name}”`, h('div', {},
    h('div', { class: 'field' }, h('label', {}, 'Adresa persoanei'), email),
    h('div', { class: 'field' }, h('label', {}, 'Drepturi'), role),
    h('label', { class: 'chk', style: 'display:flex;gap:6px;align-items:center' }, notify, 'Trimite notificare pe email')),
  [h('button', { class: 'btn', onclick: closeModal }, 'Renunță'),
    h('button', {
      class: 'btn pri',
      onclick: async () => {
        if (!email.value.trim()) { toast('Scrie adresa.'); return; }
        try {
          await gapi(f.accounts[0], `${DR}/files/${f.id}/permissions?supportsAllDrives=true&sendNotificationEmail=${notify.checked}`, {
            method: 'POST', json: { type: 'user', role: role.value, emailAddress: email.value.trim() },
          });
          closeModal();
          toast('Partajat cu ' + email.value.trim());
        } catch (e) { toast(e.message); }
      },
    }, 'Partajează')]);
  email.focus();
}

async function moveDialog(f) {
  const acc = f.accounts[0];
  let stack = [];
  const list = h('div', { class: 'pick' });
  const where = h('div', { class: 'muted', style: 'margin-bottom:8px;font-size:13px' });
  async function paint() {
    where.textContent = `Destinație (${acc}): Drive-ul meu` + stack.map((s) => ' › ' + s.name).join('');
    list.replaceChildren(h('div', { class: 'muted' }, 'Se încarcă…'));
    try {
      const parent = stack.length ? stack[stack.length - 1].id : 'root';
      const q = `'${qs(parent)}' in parents and mimeType='${FOLDER}' and trashed=false`;
      const r = await gapi(acc, `${DR}/files?q=${enc(q)}&fields=${enc('files(id,name)')}&orderBy=name&pageSize=200&supportsAllDrives=true&includeItemsFromAllDrives=true`);
      list.replaceChildren();
      if (stack.length) list.append(h('div', { onclick: () => { stack.pop(); paint(); } }, '↑ Înapoi'));
      for (const x of r.files || []) list.append(h('div', { onclick: () => { stack.push({ id: x.id, name: x.name }); paint(); } }, x.name));
      if (!(r.files || []).length) list.append(h('div', { class: 'muted' }, 'Niciun subfolder.'));
    } catch (e) { list.replaceChildren(h('div', { class: 'muted' }, e.message)); }
  }
  openModal(`Mută „${f.name}”`, h('div', {}, where, list, h('div', { class: 'muted', style: 'font-size:12px' }, 'Mutarea se face în același cont.')),
    [h('button', { class: 'btn', onclick: closeModal }, 'Renunță'),
      h('button', {
        class: 'btn pri',
        onclick: async () => {
          try {
            const cur = await gapi(acc, `${DR}/files/${f.id}?fields=parents&supportsAllDrives=true`);
            const dest = stack.length ? stack[stack.length - 1].id : 'root';
            const rootId = dest === 'root' ? (await gapi(acc, `${DR}/files/root?fields=id`)).id : dest;
            const remove = (cur.parents || []).join(',');
            await gapi(acc, `${DR}/files/${f.id}?addParents=${enc(rootId)}&removeParents=${enc(remove)}&supportsAllDrives=true`, { method: 'PATCH', json: {} });
            closeModal();
            toast('Mutat.');
            loadDrive();
          } catch (e) { toast(e.message); }
        },
      }, 'Mută aici')]);
  paint();
}

// ================================================================= CONTURI

function buildAccounts(m) {
  m.append(h('div', { class: 'top' }, h('h1', {}, 'Conturi'),
    h('div', { class: 'grow' }),
    h('button', { class: 'btn pri', onclick: addAccount }, 'Adaugă cont Google')));
  const b = banner();
  if (b) m.append(b);
  const card = h('div', { class: 'card' });
  if (!S.accounts.length) card.append(h('div', { class: 'muted' }, 'Niciun cont adăugat încă. Apasă „Adaugă cont Google”.'));
  for (const a of S.accounts) {
    card.append(h('div', { class: 'accrow' }, avatar(a, a), h('div', { class: 'em' }, a),
      h('span', { class: 'muted', style: 'font-size:13px' }, hasToken(a) ? 'Conectat' : 'Neconectat'),
      hasToken(a) ? null : h('button', { class: 'btn', onclick: async () => { if (await connect(a)) showTab('accounts'); } }, 'Conectează'),
      h('button', {
        class: 'btn dan',
        onclick: async () => { if (await confirmBox('Elimini contul din pagină?', `${a} nu va mai apărea aici. Contul Google nu este șters.`, 'Elimină', true)) removeAccount(a); },
      }, 'Elimină')));
  }
  m.append(card, h('div', { class: 'card muted', style: 'font-size:13px' },
    h('p', { style: 'margin-top:0' }, 'Lista conturilor se păstrează în acest browser. Cheile de acces Google durează aproximativ o oră și rămân doar în pagină: după închiderea paginii sau după expirare apeși din nou „Conectează”.'),
    h('p', { style: 'margin-bottom:0' }, 'Un cont se poate conecta doar dacă adresa lui a fost adăugată ca „test user” în proiectul Google Cloud.')));
}

// ================================================================== START

renderSide();
showTab('email');
autoConnect();
