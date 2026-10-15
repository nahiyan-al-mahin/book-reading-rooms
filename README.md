# 📖 Book Rooms

Read PDFs together with friends. Create a room, share the invite link, upload any PDF, and everyone sees it as a real book with page-curl animations. When someone turns a page, it turns for everyone in the room.

## Features

- **Rooms with invite links**: each room gets a short code and a link like `http://localhost:3000/room/ab12cd`. Rooms can have an optional password.
- **Upload any PDF**: anyone in the room can upload; it opens for everyone at once.
- **Real book effect**: two-page spreads with a hard cover, drag a page corner or click to turn, plus a soft page-turn sound. On phones and narrow windows it switches to one big page at a time.
- **Wizarding theme** with a dark mode (night sky and floating candles) and a light mode (parchment). The **Lumos / Nox** button switches between them and remembers your choice.
- **Read together**: page turns are synced live. Untick **Read together** to browse on your own, tick it again to jump back to where the room is.
- **People list and chat** in the side panel.
- Arrow keys turn pages.

## Tech stack

| Part | What it uses |
| --- | --- |
| Server | Node.js + Express (serves the site and the API) |
| Live sync | Socket.IO |
| PDF uploads | Multer, files saved in `uploads/` |
| PDF rendering | PDF.js (`pdfjs-dist`) |
| Book effect | StPageFlip (`page-flip`) |
| Frontend | Plain HTML, CSS and JavaScript, no build step |

The browser libraries are served straight from `node_modules`, so there is no bundler and no CDN.

## Run it on Windows

1. Install **Node.js 20 or newer** from https://nodejs.org (the LTS version is fine).
2. Open PowerShell or Command Prompt and clone the project, for example into `H:\Projects`:

   ```powershell
   cd H:\Projects
   git clone https://github.com/<your-username>/<repo-name>.git
   cd <repo-name>
   ```

3. Install the packages and start the server:

   ```powershell
   npm install
   npm start
   ```

4. Open http://localhost:3000 in your browser.

To test with friends on the same Wi-Fi, find your PC's IP with `ipconfig` (for example `192.168.1.20`) and have them open `http://192.168.1.20:3000`. Windows may ask you to allow Node.js through the firewall the first time.

While developing, `npm run dev` restarts the server automatically when you change `server.js`. Changes to files in `public/` only need a browser refresh.

### Settings

You can set these environment variables before `npm start`:

- `PORT`: port to listen on (default `3000`)
- `MAX_UPLOAD_MB`: largest PDF allowed (default `500`)

In PowerShell: `$env:PORT=4000; npm start`

## How it works

```
server.js            Express + Socket.IO server: rooms, uploads, page sync, chat
public/index.html    Home page: enter your name, create or join a room
public/room.html     The reading room
public/js/home.js    Create / join logic
public/js/room.js    Joins the room, renders the PDF into the book, syncs page turns
public/css/style.css All styles
uploads/             Uploaded PDFs (created automatically, not committed)
```

- Rooms are kept **in memory**. Restarting the server clears them. A room and its PDF are deleted one hour after the last person leaves.
- The room remembers the current page, so people who join late open the book at the same page.
- Big PDFs open quickly: the book is sent over the live Socket.IO connection in 1 MB pieces, only for the pages people look at, and pages are rendered on demand. Not using a normal download also stops download managers like IDM from grabbing the file.

## Ideas for next steps

- Save rooms in SQLite so they survive a restart.
- Store PDFs in Cloudflare R2 or S3 instead of local disk.
- Show everyone's cursor or a "pointer" to highlight a spot on the page.
- Deploy to Render or Railway (both support WebSockets): the start command is `npm start`.
