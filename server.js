// ──────────────────────────────────────────────────────────────
// Ballongarten — WebSocket-Server für 2-Spieler Ballon-Schlacht
// ──────────────────────────────────────────────────────────────
// Architektur:
//   • HTTP-Server liefert statische Dateien aus /public
//   • WebSocket-Upgrade unter /ws für Echtzeit-Kommunikation
//   • In-Memory-Räume (keine DB) — Spiele sind ephemer
//   • Öffentliches Matchmaking: jeder vergibt seinem Spiel einen Namen,
//     alle Menü-Clients bekommen live eine Liste offener Runden gepusht
//
// Protokoll (JSON-Messages via WS):
//   Client → Server:
//     { type:'hello' }                            → Liste anfordern (beim Menü)
//     { type:'create', name, gameName }           → erzeugt Raum
//     { type:'join', code, name }                 → tritt Raum bei
//     { type:'place', ships }                     → eigene Schiffe festlegen
//     { type:'shoot', x, y, weapon }              → auf Gegner schießen
//     { type:'emote', text }                      → Emote an Gegner
//   Server → Client:
//     { type:'list', games:[{code,gameName,host}] }
//     { type:'created', code, gameName }
//     { type:'joined', code, names, you, gameName }
//     { type:'opponent', names }
//     { type:'phase', phase, you?, names?, turn? }
//     { type:'placed' }
//     { type:'shot_result', x, y, result, weapon, by, ship?, deco? }
//     { type:'turn', yours }
//     { type:'game_over', winner }
//     { type:'opponent_left' }
//     { type:'error', error }

const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const PORT = process.env.PORT || 4010;
const PUBLIC = path.join(__dirname, 'public');

// MIME-Types für statische Auslieferung
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg'
};

// Einfacher statischer Dateiserver mit Pfad-Escape-Schutz
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p.endsWith('/')) p += 'index.html';
  const fp = path.normalize(path.join(PUBLIC, p));
  if (!fp.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    const ext = path.extname(fp).toLowerCase();
    // Service Worker + HTML nie cachen, Assets dürfen kurz gecacht werden
    const noCache = (ext === '.js' && /sw\.js$/.test(fp)) || ext === '.html';
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': noCache ? 'no-cache, no-store, must-revalidate' : 'public, max-age=600'
    });
    res.end(data);
  });
});

// ──────────────────── Raum-Verwaltung ────────────────────
const rooms = new Map();            // code → { players:[{ws,name,ships,decos,hits}], phase, turn, gameName }
const wsToRoom = new WeakMap();     // ws → { code, idx }
const browsing = new Set();         // WebSockets, die gerade im Menü sind (bekommen Live-Liste)

// Ohne verwechselbare Buchstaben (I/1/O/0) → 4 Zeichen
function code4() {
  const ALPH = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c = '';
  for (let i = 0; i < 4; i++) c += ALPH[Math.floor(Math.random() * ALPH.length)];
  return c;
}

function newRoom(gameName) {
  let c;
  do { c = code4(); } while (rooms.has(c));
  rooms.set(c, {
    players: [],
    phase: 'lobby',
    turn: 0,
    gameName: (gameName || 'Spiel').slice(0, 30),
    createdAt: Date.now()
  });
  return c;
}

function send(ws, msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

// Öffentliche Liste aller Räume, die noch einen Platz frei haben
function openGames() {
  const out = [];
  for (const [code, r] of rooms) {
    if (r.phase === 'lobby' && r.players.length < 2) {
      out.push({ code, gameName: r.gameName, host: r.players[0]?.name || '' });
    }
  }
  // Neueste zuerst
  return out.sort((a, b) => (rooms.get(b.code).createdAt - rooms.get(a.code).createdAt));
}

// Liste an alle Browser-Clients im Menü pushen
function broadcastList() {
  const list = openGames();
  const payload = JSON.stringify({ type: 'list', games: list });
  for (const ws of browsing) {
    if (ws.readyState === WebSocket.OPEN) ws.send(payload);
  }
}

// Deko-Kandidaten, die zufällig in leeren Zellen verteilt werden
const DECO_KINDS = ['pool', 'lounger', 'ball', 'gnome', 'cake', 'umbrella', 'bouncy', 'dog'];

// Platziert 5–7 Deko-Objekte in Zellen, die keine Schiffe enthalten
function generateDecorations(ships) {
  const used = new Set();
  for (const s of ships) for (const c of s.cells) used.add(`${c.x},${c.y}`);
  const free = [];
  for (let y = 0; y < 10; y++) for (let x = 0; x < 10; x++) {
    if (!used.has(`${x},${y}`)) free.push({ x, y });
  }
  const n = 5 + Math.floor(Math.random() * 3);
  const out = [];
  for (let i = 0; i < n && free.length; i++) {
    const idx = Math.floor(Math.random() * free.length);
    const c = free.splice(idx, 1)[0];
    out.push({ x: c.x, y: c.y, kind: DECO_KINDS[Math.floor(Math.random() * DECO_KINDS.length)] });
  }
  return out;
}

// Validiert Schiffssetzung: 4 Schiffe (5,4,3,2), gerade Linien, innerhalb 10×10,
// keine Überlappung. Dient als Anti-Cheat/Sanity.
function validateShips(ships) {
  if (!Array.isArray(ships) || ships.length !== 4) return false;
  const expected = { 5: 1, 4: 1, 3: 1, 2: 1 };
  const counts = {};
  const grid = Array(10).fill(null).map(() => Array(10).fill(false));
  for (const s of ships) {
    if (!s || !Array.isArray(s.cells)) return false;
    counts[s.cells.length] = (counts[s.cells.length] || 0) + 1;
    if (s.cells.length < 2 || s.cells.length > 5) return false;
    // Gerade Linie: entweder alle x gleich oder alle y gleich; und zusammenhängend
    const xs = s.cells.map(c => c.x), ys = s.cells.map(c => c.y);
    const allSameX = xs.every(x => x === xs[0]);
    const allSameY = ys.every(y => y === ys[0]);
    if (!allSameX && !allSameY) return false;
    const sorted = [...s.cells].sort((a, b) => (a.x - b.x) || (a.y - b.y));
    for (let i = 1; i < sorted.length; i++) {
      const dx = sorted[i].x - sorted[i-1].x;
      const dy = sorted[i].y - sorted[i-1].y;
      if (!((dx === 1 && dy === 0) || (dx === 0 && dy === 1))) return false;
    }
    for (const c of s.cells) {
      if (c.x < 0 || c.x > 9 || c.y < 0 || c.y > 9) return false;
      if (grid[c.y][c.x]) return false;
      grid[c.y][c.x] = true;
    }
  }
  for (const k of Object.keys(expected)) if (counts[k] !== expected[k]) return false;
  return true;
}

// ──────────────────── WebSocket-Handling ────────────────────
const wss = new WebSocket.Server({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname !== '/ws') { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

wss.on('connection', (ws) => {
  // Keep-Alive via Ping alle 25s, damit idle Proxy-Verbindungen nicht sterben
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  // Beim Verbinden landet der Client erstmal im "Menü-Pool" und bekommt sofort die Liste
  browsing.add(ws);
  send(ws, { type: 'list', games: openGames() });

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    const bind = wsToRoom.get(ws);
    const room = bind ? rooms.get(bind.code) : null;

    if (msg.type === 'hello') {
      // Client will explizit die Liste
      browsing.add(ws);
      send(ws, { type: 'list', games: openGames() });
    }

    else if (msg.type === 'create') {
      const gameName = (msg.gameName || '').trim() || 'Spiel';
      const code = newRoom(gameName);
      const r = rooms.get(code);
      r.players.push({ ws, name: (msg.name || 'Spieler 1').slice(0, 20), ships: null, decos: null });
      wsToRoom.set(ws, { code, idx: 0 });
      browsing.delete(ws); // nicht mehr im Menü
      send(ws, { type: 'created', code, gameName: r.gameName });
      broadcastList(); // andere sehen die neue Runde
    }

    else if (msg.type === 'join') {
      const r = rooms.get((msg.code || '').toUpperCase());
      if (!r) return send(ws, { type: 'error', error: 'Spiel nicht verfügbar' });
      if (r.players.length >= 2) return send(ws, { type: 'error', error: 'Raum ist voll' });
      r.players.push({ ws, name: (msg.name || 'Spieler 2').slice(0, 20), ships: null, decos: null });
      wsToRoom.set(ws, { code: msg.code.toUpperCase(), idx: 1 });
      browsing.delete(ws);
      const names = r.players.map(p => p.name);
      send(ws, { type: 'joined', code: msg.code.toUpperCase(), names, you: 1, gameName: r.gameName });
      send(r.players[0].ws, { type: 'opponent', names });
      // Platzierungsphase beginnt
      r.phase = 'placement';
      for (let i = 0; i < 2; i++) {
        send(r.players[i].ws, { type: 'phase', phase: 'placement', you: i, names });
      }
      broadcastList(); // Raum ist voll → aus Liste raus
    }

    else if (msg.type === 'place') {
      if (!room) return;
      if (!validateShips(msg.ships)) return send(ws, { type: 'error', error: 'Ungültige Schiffsaufstellung' });
      const me = room.players[bind.idx];
      me.ships = msg.ships.map(s => ({ ...s, hits: new Array(s.cells.length).fill(false) }));
      me.decos = generateDecorations(me.ships);
      send(ws, { type: 'placed' });
      if (room.players.length === 2 && room.players.every(p => p.ships)) {
        room.phase = 'battle';
        room.turn = Math.floor(Math.random() * 2);
        for (let i = 0; i < 2; i++) {
          send(room.players[i].ws, {
            type: 'phase', phase: 'battle',
            yours: room.turn === i,
            myDecos: room.players[i].decos    // eigene Deko zum Anzeigen
          });
        }
      }
    }

    else if (msg.type === 'shoot') {
      if (!room || room.phase !== 'battle') return;
      if (room.turn !== bind.idx) return;        // nicht dein Zug
      const opp = room.players[1 - bind.idx];
      const { x, y, weapon } = msg;
      if (x < 0 || x > 9 || y < 0 || y > 9) return;
      // Schon mal hier geschossen? Dann ignorieren
      if (!opp._shot) opp._shot = new Set();
      const key = `${x},${y}`;
      if (opp._shot.has(key)) return;
      opp._shot.add(key);

      // Treffer suchen (Schiff?)
      let result = 'miss';
      let sunkShip = null;
      for (const s of opp.ships) {
        for (let j = 0; j < s.cells.length; j++) {
          if (s.cells[j].x === x && s.cells[j].y === y) {
            s.hits[j] = true;
            result = s.hits.every(h => h) ? 'sunk' : 'hit';
            if (result === 'sunk') sunkShip = { cells: s.cells, color: s.color };
            break;
          }
        }
        if (result !== 'miss') break;
      }

      // Deko getroffen? (nur für Animation, zählt nicht)
      let hitDeco = null;
      if (result === 'miss') {
        const d = opp.decos.find(d => d.x === x && d.y === y);
        if (d) hitDeco = d.kind;
      }

      // Beide Spieler über Ergebnis informieren
      const payload = { type: 'shot_result', x, y, result, weapon: weapon || 'stone', ship: sunkShip, deco: hitDeco };
      send(ws, { ...payload, by: 'me' });
      send(opp.ws, { ...payload, by: 'opponent' });

      // Alles versenkt?
      const allSunk = opp.ships.every(s => s.hits.every(h => h));
      if (allSunk) {
        room.phase = 'over';
        for (let i = 0; i < 2; i++) {
          send(room.players[i].ws, {
            type: 'game_over',
            winner: bind.idx === i ? 'you' : 'opponent',
            revealShips: opp.ships.map(s => ({ cells: s.cells, color: s.color }))
          });
        }
      } else {
        // Klassisch abwechselnd — unabhängig vom Treffer
        room.turn = 1 - room.turn;
        for (let i = 0; i < 2; i++) {
          send(room.players[i].ws, { type: 'turn', yours: room.turn === i });
        }
      }
    }

    else if (msg.type === 'emote') {
      if (!room) return;
      const opp = room.players[1 - bind.idx];
      if (opp) send(opp.ws, { type: 'emote', text: String(msg.text || '').slice(0, 40) });
    }
  });

  ws.on('close', () => {
    browsing.delete(ws);
    const bind = wsToRoom.get(ws);
    if (!bind) return;
    const r = rooms.get(bind.code);
    if (!r) return;
    const other = r.players.find(p => p.ws !== ws);
    if (other) send(other.ws, { type: 'opponent_left' });
    rooms.delete(bind.code);
    broadcastList(); // Raum ist weg → Liste aktualisieren
  });
});

// Keep-Alive Ping — inaktive Sockets abräumen
setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) { ws.terminate(); return; }
    ws.isAlive = false;
    ws.ping();
  });
}, 25000);

// Alte Räume (>2h) aufräumen — falls Spieler hängen bleiben
setInterval(() => {
  const now = Date.now();
  let removed = false;
  for (const [code, r] of rooms) {
    if (now - r.createdAt > 2 * 60 * 60 * 1000) { rooms.delete(code); removed = true; }
  }
  if (removed) broadcastList();
}, 10 * 60 * 1000);

server.listen(PORT, () => {
  console.log(`Ballongarten läuft auf Port ${PORT}`);
});
