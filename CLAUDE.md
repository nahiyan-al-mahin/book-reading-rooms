# Book Rooms

Shared PDF reading rooms with a page-flip book UI.

- Run: `npm install`, then `npm start` (http://localhost:3000). `npm run dev` restarts on server changes.
- No build step and no bundler: the frontend in `public/` is plain HTML/CSS/JS. Browser libraries are served from `node_modules` by Express under `/vendor/...` (see `server.js`).
- `pdfjs-dist` is pinned to 4.x on purpose: 6.x uses browser APIs that current Chromium does not have yet, and pages fail to render.
- Rooms live in memory in `server.js` (`rooms` Map). Socket events: `join` (with ack), `page`, `chat`, server-sent `members`, `pdf`, `page`, `chat`.
- Page sync logic lives in `public/js/room.js` (`onLocalFlip`, `goToPage`). `remoteTarget` stops a page turn received from someone else from being sent back.
