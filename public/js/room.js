import * as pdfjsLib from '/vendor/pdfjs/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';

const $ = (id) => document.getElementById(id);
const code = location.pathname.split('/').filter(Boolean).pop().toLowerCase();
const passwordKey = `roomPassword:${code}`;

const state = {
  name: localStorage.getItem('displayName') || '',
  password: sessionStorage.getItem(passwordKey) || '',
  joined: false,
  pdfUrl: null,
  pdfDoc: null,
  pageFlip: null,
  pageRatio: 1 / 1.414, // width / height, replaced by the PDF's first page
  pageEls: [],
  pageImgs: [], // rendered <img> per page, kept when the book is rebuilt
  singlePage: false,
  rendered: new Set(),
  rendering: new Set(),
  follow: true,
  roomPage: 0, // the page the room is on, even while you read on your own
  remoteTarget: null, // page we are flipping to because someone else turned it
  remoteTimer: null,
  loadToken: 0,
};

const socket = io({ autoConnect: false });

/* ---------- Joining ---------- */

async function init() {
  $('roomCode').textContent = code;
  const res = await fetch(`/api/rooms/${encodeURIComponent(code)}`);
  if (!res.ok) {
    $('roomName').textContent = 'Room not found';
    $('empty').innerHTML = '<div class="empty-book">🌫️</div><h2>This room has vanished</h2><p>Rooms disappear an hour after everyone leaves. <a href="/">Open a new one</a>.</p>';
    document.querySelector('.actions').hidden = true;
    return;
  }
  const info = await res.json();
  $('roomName').textContent = info.name;
  $('joinRoomName').textContent = info.name;
  document.title = `${info.name} · Book Rooms`;

  if (!state.name || (info.hasPassword && !state.password)) {
    showJoinDialog(info.hasPassword);
  } else {
    socket.connect();
  }
}

function showJoinDialog(needsPassword, error = '') {
  $('joinName').value = state.name;
  $('joinPasswordField').hidden = !needsPassword;
  $('joinPassword').required = needsPassword;
  $('joinError').textContent = error;
  $('joinDialog').hidden = false;
  (state.name ? (needsPassword ? $('joinPassword') : $('joinName')) : $('joinName')).focus();
}

$('joinForm').addEventListener('submit', (e) => {
  e.preventDefault();
  state.name = $('joinName').value.trim();
  if (!state.name) return;
  localStorage.setItem('displayName', state.name);
  if (!$('joinPasswordField').hidden) state.password = $('joinPassword').value;
  $('joinDialog').hidden = true;
  if (socket.connected) join();
  else socket.connect();
});

function join() {
  socket.emit('join', { code, name: state.name, password: state.password }, (res) => {
    if (res.error) {
      if (res.needsPassword) {
        sessionStorage.removeItem(passwordKey);
        showJoinDialog(true, state.password ? 'Wrong password, try again.' : '');
      } else {
        toast(res.error);
      }
      return;
    }
    if (state.password) sessionStorage.setItem(passwordKey, state.password);
    state.joined = true;
    const room = res.room;
    renderMembers(room.members);
    $('messages').innerHTML = '';
    room.messages.forEach(addMessage);
    state.roomPage = room.page;
    if (room.pdf && room.pdf.url !== state.pdfUrl) openBook(room.pdf, room.page);
    else if (room.pdf && state.follow) goToPage(room.page);
  });
}

// Runs on the first connect and again after a dropped connection comes back.
socket.on('connect', join);
socket.on('disconnect', () => toast('Connection lost, reconnecting…'));

/* ---------- Room events ---------- */

socket.on('members', ({ members, joined, left }) => {
  renderMembers(members);
  if (joined) toast(`${joined} joined the room`);
  if (left) toast(`${left} left the room`);
});

socket.on('pdf', ({ pdf, page }) => {
  state.roomPage = page;
  toast(`${pdf.uploadedBy} opened “${pdf.name}”`);
  openBook(pdf, page);
});

socket.on('page', ({ page }) => {
  state.roomPage = page;
  if (state.follow) goToPage(page);
});

socket.on('chat', addMessage);

function renderMembers(members) {
  $('memberCount').textContent = members.length;
  $('members').innerHTML = '';
  for (const m of members) {
    const li = document.createElement('li');
    li.innerHTML = `<span class="avatar"></span><span class="member-name"></span>`;
    li.querySelector('.avatar').textContent = m.charAt(0).toUpperCase();
    li.querySelector('.member-name').textContent = m === state.name ? `${m} (you)` : m;
    $('members').appendChild(li);
  }
}

function addMessage(msg) {
  const li = document.createElement('li');
  const who = document.createElement('b');
  who.textContent = msg.name;
  li.append(who, document.createTextNode(` ${msg.text}`));
  $('messages').appendChild(li);
  $('messages').scrollTop = $('messages').scrollHeight;
}

$('chatForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('chatInput').value.trim();
  if (!text) return;
  socket.emit('chat', text);
  $('chatInput').value = '';
});

/* ---------- Invite & upload ---------- */

$('inviteBtn').addEventListener('click', async () => {
  const link = `${location.origin}/room/${code}`;
  try {
    await navigator.clipboard.writeText(link);
    toast('Invite link copied. Send your owl to your friends!');
  } catch {
    prompt('Copy this invite link:', link);
  }
});

$('pdfInput').addEventListener('change', () => {
  const file = $('pdfInput').files[0];
  $('pdfInput').value = '';
  if (!file) return;
  const form = new FormData();
  form.append('pdf', file);
  const xhr = new XMLHttpRequest();
  xhr.open('POST', `/api/rooms/${code}/pdf`);
  xhr.setRequestHeader('x-room-password', encodeURIComponent(state.password));
  xhr.setRequestHeader('x-display-name', encodeURIComponent(state.name));
  xhr.upload.onprogress = (e) => {
    if (e.lengthComputable) showLoading(`Uploading… ${Math.round((e.loaded / e.total) * 100)}%`);
  };
  xhr.onload = () => {
    if (xhr.status !== 200) {
      hideLoading();
      let msg = 'Upload failed';
      try {
        msg = JSON.parse(xhr.responseText).error || msg;
      } catch {}
      toast(msg);
    }
    // On success the server broadcasts the new book to everyone, including us.
  };
  xhr.onerror = () => {
    hideLoading();
    toast('Upload failed, check your connection.');
  };
  showLoading('Uploading… 0%');
  xhr.send(form);
});

/* ---------- The book ---------- */

function showLoading(text) {
  $('loadingText').textContent = text;
  $('loading').hidden = false;
  $('empty').hidden = true;
}

function hideLoading() {
  $('loading').hidden = true;
  if (!state.pdfDoc) $('empty').hidden = false;
}

async function openBook(pdf, startPage) {
  const token = ++state.loadToken;
  state.pdfUrl = pdf.url;
  resetEmpty();
  showLoading(`Opening “${pdf.name}”…`);

  let doc;
  try {
    const data = await downloadBook(pdf, token);
    if (token !== state.loadToken) return;
    doc = await pdfjsLib.getDocument({ data, cMapUrl: '/vendor/pdfjs-cmaps/', cMapPacked: true }).promise;
  } catch (err) {
    console.error(err);
    if (token === state.loadToken) {
      state.pdfUrl = null;
      hideLoading();
      showOpenError(pdf, startPage);
    }
    return;
  }
  if (token !== state.loadToken) return doc.destroy(); // a newer book arrived meanwhile

  if (state.pdfDoc) state.pdfDoc.destroy();
  state.pdfDoc = doc;
  state.rendered.clear();
  state.rendering.clear();
  state.pageImgs = new Array(doc.numPages).fill(null);

  const first = await doc.getPage(1);
  const vp = first.getViewport({ scale: 1 });
  state.pageRatio = vp.width / vp.height;

  $('bookWrap').hidden = false;
  $('controls').hidden = false;
  $('empty').hidden = true;
  buildFlipbook(Math.min(startPage, doc.numPages - 1));
  hideLoading();
}

// One page at a time when that makes the page clearly bigger (phones, narrow
// windows), otherwise an open two-page spread.
function wantsSinglePage() {
  const { availW, availH } = stageSpace();
  const spreadPageW = Math.min(availW / 2, availH * state.pageRatio);
  const singlePageW = Math.min(availW, availH * state.pageRatio);
  return singlePageW > spreadPageW * 1.25;
}

function stageSpace() {
  const stage = document.querySelector('.stage');
  return {
    availW: stage.clientWidth - 24,
    availH: stage.clientHeight - $('controls').offsetHeight - 32,
  };
}

// (Re)creates the StPageFlip book. Called when a book opens and when the
// layout switches between one page and two pages.
function buildFlipbook(startPage) {
  destroyFlipbook();
  state.singlePage = wantsSinglePage();

  // StPageFlip removes its root element on destroy, so build a fresh one each time.
  const bookEl = document.createElement('div');
  bookEl.className = 'book';
  $('bookWrap').replaceChildren(bookEl);

  const total = state.pdfDoc.numPages;
  state.pageEls = [];
  for (let i = 0; i < total; i++) {
    const page = document.createElement('div');
    page.className = 'page';
    // Front and back covers are stiff like a hardcover.
    if (i === 0 || (i === total - 1 && total % 2 === 0)) page.dataset.density = 'hard';
    page.innerHTML = `<div class="page-inner"><div class="page-placeholder">${i + 1}</div></div><div class="page-shade"></div>`;
    if (state.pageImgs[i]) page.querySelector('.page-inner').replaceChildren(state.pageImgs[i]);
    bookEl.appendChild(page);
    state.pageEls.push(page);
  }

  sizeBook();

  const baseW = 500;
  const pageFlip = new St.PageFlip(bookEl, {
    width: baseW,
    height: Math.round(baseW / state.pageRatio),
    size: 'stretch',
    // StPageFlip shows one page when the book is narrower than 2 x minWidth,
    // so a minWidth just over half the book forces single pages, and
    // usePortrait: false forces spreads.
    minWidth: state.singlePage ? singleMinWidth() : 100,
    maxWidth: 3000,
    minHeight: 100,
    maxHeight: 4000,
    showCover: true,
    usePortrait: state.singlePage,
    maxShadowOpacity: 0.5,
    mobileScrollSupport: false,
    flippingTime: 800,
    startPage,
  });
  bookEl.style.minWidth = '0';
  pageFlip.loadFromHTML(state.pageEls);
  state.pageFlip = pageFlip;

  pageFlip.on('flip', (e) => onLocalFlip(e.data));
  pageFlip.on('changeState', (e) => {
    if (e.data === 'flipping') playFlipSound();
  });

  updatePageInfo();
  renderAround(pageFlip.getCurrentPageIndex());
}

function singleMinWidth() {
  return Math.ceil($('bookWrap').clientWidth / 2) + 20;
}

function destroyFlipbook() {
  const pf = state.pageFlip;
  if (!pf) return;
  // StPageFlip forgets to remove its resize listener on destroy.
  window.removeEventListener('resize', pf.getUI().onResize);
  pf.destroy();
  state.pageFlip = null;
}

// Download the book ourselves (rather than letting PDF.js do it) so we can show
// progress and send the room password.
async function downloadBook(pdf, token) {
  const res = await fetch(pdf.url, { headers: { 'x-room-password': encodeURIComponent(state.password) } });
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  const total = Number(res.headers.get('content-length')) || 0;
  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    if (total && token === state.loadToken) {
      showLoading(`Opening “${pdf.name}”… ${Math.round((received / total) * 100)}%`);
    }
  }
  const data = new Uint8Array(received);
  let offset = 0;
  for (const c of chunks) {
    data.set(c, offset);
    offset += c.length;
  }
  return data;
}

function showOpenError(pdf, startPage) {
  $('empty').hidden = false;
  $('empty').innerHTML = `
    <div class="empty-book">⚠️</div>
    <h2>Could not open the book</h2>
    <p>If you use a download manager like IDM, it may have grabbed the file. Try again, or turn the download manager off for this site.</p>
    <button class="btn primary" id="retryBtn">Try again</button>`;
  $('retryBtn').addEventListener('click', () => {
    resetEmpty();
    openBook(pdf, state.follow ? state.roomPage : startPage);
  });
}

function resetEmpty() {
  $('empty').innerHTML = `
    <div class="empty-book">📚</div>
    <h2>The table is empty</h2>
    <p>Upload a PDF and it will appear as a book for everyone in the room.</p>`;
}

function onLocalFlip(page) {
  updatePageInfo();
  renderAround(page);
  if (state.remoteTarget !== null && Math.abs(page - state.remoteTarget) <= 1) {
    state.remoteTarget = null; // this flip came from someone else, don't echo it back
    return;
  }
  if (state.follow) {
    state.roomPage = page;
    socket.emit('page', page);
  }
}

function goToPage(page) {
  const pf = state.pageFlip;
  if (!pf) return;
  page = Math.max(0, Math.min(page, pf.getPageCount() - 1));
  const current = pf.getCurrentPageIndex();
  if (visiblePages().includes(page)) return;
  state.remoteTarget = page;
  clearTimeout(state.remoteTimer);
  state.remoteTimer = setTimeout(() => (state.remoteTarget = null), 2000);
  renderAround(page);
  // A short hop gets the full page-turn animation; a long jump, or a tab in the
  // background (where animations are paused), goes straight there.
  if (Math.abs(page - current) <= 4 && pf.getState() === 'read' && !document.hidden) {
    pf.flip(page, 'top');
  } else {
    pf.turnToPage(page);
    state.remoteTarget = null;
    updatePageInfo();
  }
}

// Indexes of the pages on screen: one page in portrait or on a cover, two in an open spread.
function visiblePages() {
  const pf = state.pageFlip;
  const i = pf.getCurrentPageIndex();
  const total = pf.getPageCount();
  if (pf.getOrientation() === 'portrait' || i === 0) return [i];
  const left = i % 2 === 1 ? i : i - 1;
  return left + 1 < total ? [left, left + 1] : [left];
}

function updatePageInfo() {
  const pf = state.pageFlip;
  if (!pf) return;
  const total = pf.getPageCount();
  const shown = visiblePages();
  const first = shown[0];
  const last = shown[shown.length - 1];
  $('pageInfo').textContent =
    shown.length === 2 ? `Pages ${first + 1}–${last + 1} of ${total}` : `Page ${first + 1} of ${total}`;
  $('prevBtn').disabled = first === 0;
  $('nextBtn').disabled = last >= total - 1;
}

// Render the pages around the reader first, so turning feels instant.
function renderAround(center) {
  if (!state.pdfDoc) return;
  const total = state.pdfDoc.numPages;
  for (let d = 0; d <= 6; d++) {
    for (const i of [center + d, center - d]) {
      if (i >= 0 && i < total) renderPage(i);
    }
  }
}

async function renderPage(index) {
  if (state.rendered.has(index) || state.rendering.has(index)) return;
  state.rendering.add(index);
  const doc = state.pdfDoc;
  try {
    const page = await doc.getPage(index + 1);
    const base = page.getViewport({ scale: 1 });
    const shownWidth = $('bookWrap').clientWidth / (state.singlePage ? 1 : 2);
    const targetWidth = Math.min(2000, Math.max(900, shownWidth * (window.devicePixelRatio || 1)));
    const viewport = page.getViewport({ scale: targetWidth / base.width });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    if (doc !== state.pdfDoc) return;
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.92));
    const img = new Image();
    img.className = 'page-img';
    img.alt = `Page ${index + 1}`;
    img.src = URL.createObjectURL(blob);
    img.draggable = false;
    state.pageImgs[index] = img;
    state.pageEls[index].querySelector('.page-inner').replaceChildren(img);
    state.rendered.add(index);
    page.cleanup();
  } catch (err) {
    console.error(`Failed to render page ${index + 1}`, err);
  } finally {
    state.rendering.delete(index);
  }
}

// Fit the book inside the stage: as big as possible without overflowing it.
function sizeBook() {
  const { availW, availH } = stageSpace();
  const ratio = state.pageRatio * (state.singlePage ? 1 : 2);
  const width = Math.min(availW, availH * ratio);
  $('bookWrap').style.width = `${Math.floor(Math.max(120, width))}px`;
}

let resizeTimer;
function onResize() {
  if (!state.pageFlip) return;
  sizeBook();
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    const pf = state.pageFlip;
    if (!pf || pf.getState() !== 'read') return;
    const layoutChanged = wantsSinglePage() !== state.singlePage;
    // A single-page book that grew past 2 x minWidth would open into a spread.
    const outgrown = state.singlePage && $('bookWrap').clientWidth >= pf.getSettings().minWidth * 2;
    if (layoutChanged || outgrown) {
      buildFlipbook(state.pageFlip.getCurrentPageIndex());
    }
  }, 150);
}

window.addEventListener('resize', onResize);

$('prevBtn').addEventListener('click', () => state.pageFlip?.flipPrev());
$('nextBtn').addEventListener('click', () => state.pageFlip?.flipNext());

document.addEventListener('keydown', (e) => {
  if (!state.pageFlip || e.target.matches('input, textarea')) return;
  if (e.key === 'ArrowRight' || e.key === 'PageDown') state.pageFlip.flipNext();
  if (e.key === 'ArrowLeft' || e.key === 'PageUp') state.pageFlip.flipPrev();
});

$('followToggle').addEventListener('change', (e) => {
  state.follow = e.target.checked;
  if (state.follow) {
    goToPage(state.roomPage);
    toast('Reading together again');
  } else {
    toast('Reading on your own. Your page turns stay private.');
  }
});

/* ---------- Little extras ---------- */

$('sidebarToggle').addEventListener('click', () => document.body.classList.toggle('sidebar-open'));
document.querySelector('.stage').addEventListener('click', () => document.body.classList.remove('sidebar-open'));

let toastTimer;
function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
}

// A soft paper swish made from filtered noise, so there is no audio file to ship.
let audioCtx;
function playFlipSound() {
  try {
    audioCtx ||= new AudioContext();
    const len = audioCtx.sampleRate * 0.35;
    const buffer = audioCtx.createBuffer(1, len, audioCtx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < len; i++) {
      const t = i / len;
      data[i] = (Math.random() * 2 - 1) * Math.sin(Math.PI * t) ** 2 * (1 - t);
    }
    const src = audioCtx.createBufferSource();
    src.buffer = buffer;
    const filter = audioCtx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 2500;
    filter.Q.value = 0.6;
    const gain = audioCtx.createGain();
    gain.gain.value = 0.25;
    src.connect(filter).connect(gain).connect(audioCtx.destination);
    src.start();
  } catch {}
}

init();
