const $ = (id) => document.getElementById(id);
const nameInput = $('displayName');
nameInput.value = localStorage.getItem('displayName') || '';

function requireName() {
  const name = nameInput.value.trim();
  if (!name) {
    showError('Please enter your name first.');
    nameInput.focus();
    return null;
  }
  localStorage.setItem('displayName', name);
  return name;
}

function showError(msg) {
  $('error').textContent = msg;
}

$('createBtn').addEventListener('click', async () => {
  if (!requireName()) return;
  const password = $('roomPassword').value;
  const res = await fetch('/api/rooms', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: $('roomName').value, password }),
  });
  const data = await res.json();
  if (!res.ok) return showError(data.error || 'Could not create the room.');
  // Remember the password so the creator is not asked for it again.
  if (password) sessionStorage.setItem(`roomPassword:${data.code}`, password);
  location.href = `/room/${data.code}`;
});

$('joinBtn').addEventListener('click', async () => {
  if (!requireName()) return;
  const raw = $('joinCode').value.trim();
  const code = (raw.match(/room\/([a-z0-9]+)/i) || [null, raw])[1].toLowerCase();
  if (!code) return showError('Enter a room code.');
  const res = await fetch(`/api/rooms/${encodeURIComponent(code)}`);
  if (!res.ok) return showError('That room does not exist (rooms close an hour after everyone leaves).');
  location.href = `/room/${code}`;
});

$('joinCode').addEventListener('keydown', (e) => e.key === 'Enter' && $('joinBtn').click());
