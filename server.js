#!/usr/bin/env node
/* ============================================================================
   NIGHT OPS — multiplayer server
   Zero dependencies. Serves the game and relays player state over WebSocket.
   Anyone who opens the link joins. No codes, no accounts.
   ============================================================================ */
const http = require("http");
const fs   = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 8080;
const ROOT = __dirname;
const GAME = path.join(ROOT, "index.html");

/* ---------------------------------------------------------------- HTTP ---- */
const server = http.createServer((req, res) => {
  const url = (req.url || "/").split("?")[0];
  if (url === "/health") { res.writeHead(200); return res.end("ok"); }
  let file = url === "/" ? GAME : path.join(ROOT, path.normalize(url).replace(/^(\.\.[/\\])+/, ""));
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end("not found"); }
    const ext = path.extname(file).toLowerCase();
    const type = { ".html":"text/html; charset=utf-8", ".js":"text/javascript",
                   ".css":"text/css", ".jpg":"image/jpeg", ".png":"image/png" }[ext] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-cache" });
    res.end(buf);
  });
});

/* ------------------------------------------------- minimal WS server ------ */
const MAGIC = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const clients = new Map();        // id -> {sock, name, role, state, alive}
let nextId = 1;

/* ------------------------------------------------------------------ round --
   One round runs for everybody. Join mid-round and you're in that round —
   no lobby, no waiting. When it ends everyone resets together.            */
let ROUND_MS = 8 * 60 * 1000;     // set from the join screen
const HIDE_MS = 15 * 1000;        // head start before the seeker may hunt
const INTERMISSION_MS = 16 * 1000;
const round = {
  id: 1, phase: "waiting", startedAt: 0, huntAt: 0, endsAt: 0, nextAt: 0,
  winner: null, tanks: [0, 0, 0], out: {}, seekerAt: null
};
function countRoles() {
  let seekers = 0, hiders = 0, aliveHiders = 0;
  for (const [id, c] of clients) {
    if (c.role === "seeker") seekers++;
    else if (c.role === "hider") { hiders++; if (!round.out[id]) aliveHiders++; }
  }
  return { seekers, hiders, aliveHiders };
}
function roundPacket() {
  const { seekers, hiders, aliveHiders } = countRoles();
  return {
    t: "round", id: round.id, phase: round.phase, winner: round.winner,
    tanks: round.tanks, out: round.out,
    msLeft: round.phase === "running" ? Math.max(0, round.endsAt - Date.now())
          : round.phase === "hide"    ? Math.max(0, round.huntAt - Date.now())
          : round.phase === "over"    ? Math.max(0, round.nextAt - Date.now()) : 0,
    roundMs: ROUND_MS, seekerAt: round.seekerAt, seekers, hiders, aliveHiders
  };
}
function pushRound() { broadcast(roundPacket()); }
function startRound() {
  round.id++; round.phase = "hide"; round.winner = null;
  round.startedAt = Date.now();
  round.huntAt = round.startedAt + HIDE_MS;
  round.endsAt = round.huntAt + ROUND_MS;
  round.tanks = [0, 0, 0]; round.out = {}; round.seekerAt = null;
  console.log(`  >> round ${round.id} — 15s to hide`);
  pushRound();
}
function endRound(winner) {
  if (round.phase !== "running") return;
  round.phase = "over"; round.winner = winner;
  round.nextAt = Date.now() + INTERMISSION_MS;
  console.log(`  >> round ${round.id} over — ${winner} win`);
  broadcast({ t: "finale", winner });
  pushRound();
}
setInterval(() => {
  const { seekers, hiders, aliveHiders } = countRoles();
  if (round.phase === "waiting") {
    if (seekers >= 1 && hiders >= 1) startRound();
  } else if (round.phase === "hide") {
    if (Date.now() >= round.huntAt) {
      round.phase = "running";
      // fire the starting shot from wherever the seeker is standing
      for (const [, c] of clients)
        if (c.role === "seeker" && c.state) { round.seekerAt = [c.state.x, c.state.y]; break; }
      console.log(`  >> round ${round.id} — HUNT ON`);
      broadcast({ t: "hunt", at: round.seekerAt });
      pushRound();
    } else if (seekers === 0 || hiders === 0) { round.phase = "waiting"; pushRound(); }
  } else if (round.phase === "running") {
    if (Date.now() >= round.endsAt) endRound("hiders");
    else if (hiders > 0 && aliveHiders === 0) endRound("seekers");
    else if (hiders === 0 || seekers === 0) { round.phase = "waiting"; pushRound(); }
  } else if (round.phase === "over") {
    if (Date.now() >= round.nextAt) {
      if (seekers >= 1 && hiders >= 1) startRound();
      else { round.phase = "waiting"; pushRound(); }
    }
  }
}, 1000);
setInterval(() => { if (clients.size) pushRound(); }, 2000);

function wsSend(sock, str) {
  const payload = Buffer.from(str, "utf8");
  const len = payload.length;
  let head;
  if (len < 126) { head = Buffer.alloc(2); head[1] = len; }
  else if (len < 65536) { head = Buffer.alloc(4); head[1] = 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
  head[0] = 0x81;
  try { sock.write(Buffer.concat([head, payload])); } catch (e) {}
}
function broadcast(obj, exceptId) {
  const s = JSON.stringify(obj);
  for (const [id, c] of clients) if (id !== exceptId) wsSend(c.sock, s);
}

server.on("upgrade", (req, sock) => {
  const key = req.headers["sec-websocket-key"];
  if (!key) return sock.destroy();
  const accept = crypto.createHash("sha1").update(key + MAGIC).digest("base64");
  sock.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
    "Upgrade: websocket\r\nConnection: Upgrade\r\n" +
    "Sec-WebSocket-Accept: " + accept + "\r\n\r\n");
  sock.setNoDelay(true);

  const id = nextId++;
  clients.set(id, { sock, name: "P" + id, role: null, state: null });
  console.log(`+ player ${id} joined  (${clients.size} online)`);

  // tell the newcomer who they are and who's already here
  wsSend(sock, JSON.stringify({
    t: "welcome", id,
    taken: [...clients].filter(([i]) => i !== id).map(([i, c]) => ({ id: i, name: c.name, role: c.role }))
  }));
  wsSend(sock, JSON.stringify(roundPacket()));      // drop straight into the live round
  broadcast({ t: "join", id, name: "P" + id }, id);

  let buf = Buffer.alloc(0);
  sock.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const op = buf[0] & 0x0f, masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      const need = off + (masked ? 4 : 0) + len;
      if (buf.length < need) return;
      let mask = null;
      if (masked) { mask = buf.slice(off, off + 4); off += 4; }
      const data = buf.slice(off, off + len);
      if (mask) for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4];
      buf = buf.slice(need);

      if (op === 0x8) { sock.end(); return; }           // close
      if (op === 0x9) { wsSend(sock, ""); continue; }   // ping
      if (op !== 0x1) continue;

      let msg; try { msg = JSON.parse(data.toString("utf8")); } catch (e) { continue; }
      const me = clients.get(id); if (!me) return;

      if (msg.t === "role") {
        me.role = msg.role; me.name = (msg.name || me.name).slice(0, 14);
        me.rig = msg.rig || "rancher";
        if (msg.roundMin && round.phase === "waiting") {
          ROUND_MS = Math.max(60, Math.min(1800, msg.roundMin * 60)) * 1000;
          console.log(`  round length set to ${msg.roundMin} min`);
        }
        console.log(`  player ${id} -> ${me.role} (${me.name})`);
        broadcast({ t: "role", id, role: me.role, name: me.name });
        pushRound();
      } else if (msg.t === "s") {
        me.state = msg;
        msg.id = id;
        broadcast(msg, id);                              // relay movement
      } else if (msg.t === "v") {
        /* voice. Seeker-side transmissions go to everyone (hiders can hear the
           seeker's radio). Hider transmissions stay inside the hider team. */
        const mine = me.role === "seeker" || me.role === "kubota" ? "seek" : "hide";
        const out = JSON.stringify({ t: "v", id, role: me.role, team: mine, d: msg.d });
        for (const [oid, c] of clients) {
          if (oid === id) continue;
          const theirs = c.role === "seeker" || c.role === "kubota" ? "seek" : "hide";
          if (mine === "seek" || theirs === "hide") wsSend(c.sock, out);
        }
      } else if (msg.t === "ptt") {
        const mine = me.role === "seeker" || me.role === "kubota" ? "seek" : "hide";
        const out = JSON.stringify({ t: "ptt", id, on: !!msg.on, name: me.name, role: me.role, team: mine });
        for (const [oid, c] of clients) {
          if (oid === id) continue;
          const theirs = c.role === "seeker" || c.role === "kubota" ? "seek" : "hide";
          if (mine === "seek" || theirs === "hide") wsSend(c.sock, out);
        }
      } else if (msg.t === "tag") {
        /* a hider is out for the rest of THIS round */
        const target = clients.get(msg.target);
        if (round.phase === "running" && target && target.role === "hider" && !round.out[msg.target]) {
          round.out[msg.target] = true;
          broadcast({ t: "tag", id, target: msg.target, name: target.name });
          const { hiders, aliveHiders } = countRoles();
          if (hiders > 0 && aliveHiders === 0) endRound("seekers"); else pushRound();
        }
      } else if (msg.t === "tank") {
        /* shared fuel progress — every hider on the farm works the same three tanks */
        if (round.phase === "running" && me.role === "hider") {
          const i = msg.i | 0;
          if (i >= 0 && i < 3 && typeof msg.v === "number") {
            round.tanks[i] = Math.max(round.tanks[i], Math.min(1, msg.v));
            pushRound();
          }
        }
      } else if (msg.t === "extract") {
        if (round.phase === "running" && me.role === "hider" &&
            round.tanks.every(v => v >= 1) && !round.out[id]) endRound("hiders");
      } else if (msg.t === "shot") {
        /* tracer + report for everyone else. No authority here — a shot that
           actually lands arrives separately as a tag or a down. */
        msg.id = id; broadcast(msg, id);
      } else if (msg.t === "hit") {
        /* one player put rounds into another. The shooter reports it; the
           victim's own client decides what that does to them. */
        const target = clients.get(msg.target);
        if (target) wsSend(target.sock, JSON.stringify(
          { t: "hit", id, dmg: msg.dmg | 0, name: me.name }));
      } else if (msg.t === "down") {
        /* a hider put one in the seeker: he's stopped for a few seconds */
        const target = clients.get(msg.target);
        if (round.phase === "running" && target && target.role === "seeker" && me.role === "hider") {
          broadcast({ t: "down", id, target: msg.target });
        }
      } else if (msg.t === "spot" || msg.t === "chat") {
        msg.id = id; broadcast(msg, id);
      }
    }
  });

  const bye = () => {
    if (!clients.has(id)) return;
    clients.delete(id);
    delete round.out[id];
    console.log(`- player ${id} left    (${clients.size} online)`);
    broadcast({ t: "leave", id });
    pushRound();
  };
  sock.on("close", bye);
  sock.on("error", bye);
});

/* keep sockets warm */
setInterval(() => { for (const [, c] of clients) wsSend(c.sock, JSON.stringify({ t: "ping" })); }, 25000);

server.listen(PORT, () => {
  console.log("");
  console.log("  NIGHT OPS server running");
  console.log("  local:  http://localhost:" + PORT);
  console.log("  (share the public link printed by the tunnel below)");
  console.log("");
});
