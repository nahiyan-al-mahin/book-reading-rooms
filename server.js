// Book Rooms server: serves the static site, handles PDF uploads and keeps
// every reader in a room on the same page through Socket.IO.
const path = require('path');
const fs = require('fs');
const http = require('http');
const express = require('express');
const multer = require('multer');
const { Server } = require('socket.io');
const { customAlphabet } = require('nanoid');

const PORT = process.env.PORT || 3000;
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 500);
const MAX_RANGE_BYTES = 16 * 1024 * 1024; // largest piece of a book sent in one message
const EMPTY_ROOM_TTL_MS = 60 * 60 * 1000; // delete a room 1 hour after the last person leaves
const UPLOAD_DIR = path.join(__dirname, 'uploads');

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const makeRoomCode = customAlphabet('abcdefghjkmnpqrstuvwxyz23456789', 6);
const makeFileId = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 16);

// code -> { code, name, password, pdf: {url, name} | null, page, members: Map<socketId, name>, messages: [], cleanupTimer }
const rooms = new Map();

function publicRoom(room) {
  return {
    code: room.code,
    name: room.name,
    hasPassword: Boolean(room.password),
    pdf: room.pdf,
    page: room.page,
    members: [...room.members.values()],
    messages: room.messages,
  };
}

function deleteRoom(code) {
  rooms.delete(code);
  fs.rm(path.join(UPLOAD_DIR, code), { recursive: true, force: true }, () => {});
}

function safeDecode(str) {
  try {
    return decodeURIComponent(str || '');
  } catch {
    return '';
  }
}

function clean(str, max) {
  return String(str || '').trim().slice(0, max);
}

const app = express();
app.use(express.json());

app.use(express.static(path.join(__dirname, 'public')));
app.use('/vendor/pdfjs', express.static(path.join(__dirname, 'node_modules/pdfjs-dist/build')));
app.use('/vendor/pdfjs-cmaps', express.static(path.join(__dirname, 'node_modules/pdfjs-dist/cmaps')));
app.use('/vendor/page-flip', express.static(path.join(__dirname, 'node_modules/page-flip/dist/js')));

app.get('/room/:code', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'room.html'));
});

app.post('/api/rooms', (req, res) => {
  const name = clean(req.body.name, 60) || 'Reading room';
  const password = clean(req.body.password, 60);
  let code;
  do code = makeRoomCode(); while (rooms.has(code));
  const room = { code, name, password, pdf: null, page: 0, members: new Map(), messages: [], cleanupTimer: null };
  // Remove it if nobody ever joins.
  room.cleanupTimer = setTimeout(() => deleteRoom(code), EMPTY_ROOM_TTL_MS);
  rooms.set(code, room);
  res.json({ code });
});

app.get('/api/rooms/:code', (req, res) => {
  const room = rooms.get(req.params.code.toLowerCase());
  if (!room) return res.status(404).json({ error: 'Room not found' });
  res.json({ code: room.code, name: room.name, hasPassword: Boolean(room.password), maxUploadMb: MAX_UPLOAD_MB });
});

const upload = multer({
  storage: multer.diskStorage({
    destination(req, file, cb) {
      const dir = path.join(UPLOAD_DIR, req.room.code);
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename(req, file, cb) {
      // No .pdf extension on disk or in the URL, see the /book route below.
      cb(null, makeFileId());
    },
  }),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 },
  fileFilter(req, file, cb) {
    const isPdf = file.mimetype === 'application/pdf' || /\.pdf$/i.test(file.originalname);
    cb(isPdf ? null : new Error('Only PDF files can be uploaded'), isPdf);
  },
});

app.post(
  '/api/rooms/:code/pdf',
  (req, res, next) => {
    const room = rooms.get(req.params.code.toLowerCase());
    if (!room) return res.status(404).json({ error: 'Room not found' });
    if (room.password && safeDecode(req.get('x-room-password')) !== room.password) {
      return res.status(403).json({ error: 'Wrong room password' });
    }
    req.room = room;
    next();
  },
  (req, res) => {
    upload.single('pdf')(req, res, (err) => {
      if (err && err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: `That PDF is too big. The limit is ${MAX_UPLOAD_MB} MB.` });
      }
      if (err) return res.status(400).json({ error: err.message });
      if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
      const room = req.room;
      const old = room.pdf;
      room.pdf = {
        file: req.file.filename,
        size: req.file.size,
        name: clean(req.file.originalname, 120),
        uploadedBy: clean(safeDecode(req.get('x-display-name')), 30) || 'Someone',
      };
      room.page = 0;
      if (old) fs.rm(path.join(UPLOAD_DIR, room.code, old.file), { force: true }, () => {});
      io.to(room.code).emit('pdf', { pdf: room.pdf, page: 0 });
      res.json({ pdf: room.pdf });
    });
  }
);

const server = http.createServer(app);
const io = new Server(server);

io.on('connection', (socket) => {
  let room = null;
  let name = null;

  socket.on('join', (data, ack) => {
    if (typeof ack !== 'function') return;
    const target = rooms.get(clean(data && data.code, 20).toLowerCase());
    if (!target) return ack({ error: 'Room not found' });
    if (target.password && data.password !== target.password) return ack({ error: 'Wrong password', needsPassword: true });
    if (room) return ack({ error: 'Already in a room' });

    room = target;
    name = clean(data.name, 30) || 'Reader';
    clearTimeout(room.cleanupTimer);
    room.members.set(socket.id, name);
    socket.join(room.code);
    ack({ room: publicRoom(room) });
    socket.to(room.code).emit('members', { members: [...room.members.values()], joined: name });
  });

  socket.on('page', (page) => {
    if (!room || !Number.isInteger(page) || page < 0) return;
    if (page === room.page) return;
    room.page = page;
    socket.to(room.code).emit('page', { page, by: name });
  });

  // The book's bytes, sent over the live connection in pieces as PDF.js asks
  // for them. Using the socket instead of a normal download means download
  // managers such as IDM can't intercept the file, and readers only fetch the
  // parts of a big book they actually look at.
  socket.on('book-range', async (req, ack) => {
    if (typeof ack !== 'function') return;
    if (!room || !room.pdf || !req || req.file !== room.pdf.file) return ack({ error: 'Book not found' });
    const begin = Math.max(0, Math.floor(req.begin));
    const end = Math.min(room.pdf.size, Math.floor(req.end));
    if (!(end > begin) || end - begin > MAX_RANGE_BYTES) return ack({ error: 'Bad range' });
    let fh;
    try {
      fh = await fs.promises.open(path.join(UPLOAD_DIR, room.code, room.pdf.file), 'r');
      const buf = Buffer.alloc(end - begin);
      const { bytesRead } = await fh.read(buf, 0, buf.length, begin);
      ack({ data: buf.subarray(0, bytesRead) });
    } catch (err) {
      ack({ error: 'Could not read the book' });
    } finally {
      fh?.close();
    }
  });

  socket.on('chat', (text) => {
    if (!room) return;
    text = clean(text, 500);
    if (!text) return;
    const msg = { name, text, at: Date.now() };
    room.messages.push(msg);
    if (room.messages.length > 100) room.messages.shift();
    io.to(room.code).emit('chat', msg);
  });

  socket.on('disconnect', () => {
    if (!room) return;
    room.members.delete(socket.id);
    io.to(room.code).emit('members', { members: [...room.members.values()], left: name });
    if (room.members.size === 0) {
      const code = room.code;
      room.cleanupTimer = setTimeout(() => deleteRoom(code), EMPTY_ROOM_TTL_MS);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Book Rooms running at http://localhost:${PORT}`);
});
