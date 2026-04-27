/**
 * IRCnet - Serveur IRC WebSocket
 * Aucune dépendance externe - Node.js natif uniquement
 * Compatible déploiement : Render, Railway, Fly.io, VPS
 *
 * Protocole : JSON over WebSocket (client web) + TCP IRC standard (clients IRC)
 */

'use strict';

const http = require('http');
const net  = require('net');
const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');

const WS_PORT  = process.env.PORT || 3000;
const IRC_PORT = process.env.IRC_PORT || 6667;
const SERVER_NAME = process.env.SERVER_NAME || 'irc.localnet';
const MOTD = process.env.MOTD || `Bienvenue sur ${SERVER_NAME} — Serveur IRC maison`;

// ─────────────────────────────────────────────
// State
// ─────────────────────────────────────────────
const users    = new Map(); // nick → User
const channels = new Map(); // #name → Channel

class User {
  constructor(id, send, type = 'ws') {
    this.id       = id;
    this.nick     = null;
    this.username = null;
    this.realname = null;
    this.type     = type;   // 'ws' | 'irc'
    this.send     = send;   // fn(msg)
    this.channels = new Set();
    this.away     = false;
    this.awayMsg  = '';
    this.registered = false;
    this.modes    = new Set();
    this.connectedAt = Date.now();
  }
  hostmask() {
    return `${this.nick}!${this.username || 'user'}@${SERVER_NAME}`;
  }
}

class Channel {
  constructor(name) {
    this.name    = name;
    this.topic   = '';
    this.users   = new Set(); // nick set
    this.modes   = new Set(['n','t']);
    this.ops     = new Set();
    this.created = Date.now();
  }
  broadcast(msg, excludeNick = null) {
    for (const nick of this.users) {
      if (nick === excludeNick) continue;
      const u = users.get(nick);
      if (u) u.send(msg);
    }
  }
  userList() {
    return [...this.users].map(n => {
      return (this.ops.has(n) ? '@' : '') + n;
    }).join(' ');
  }
}

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────
function validNick(n) {
  return /^[a-zA-Z_\-\[\]\\^{}|`][a-zA-Z0-9_\-\[\]\\^{}|`]{0,29}$/.test(n);
}
function validChan(n) {
  return /^#[^\s,:]{1,49}$/.test(n);
}

// ─────────────────────────────────────────────
// IRC numeric replies (JSON format for WS, string for TCP)
// ─────────────────────────────────────────────
function numeric(code, nick, ...params) {
  const target = nick || '*';
  const last   = params.pop();
  const middle = params.join(' ');
  return {
    type: 'numeric', code,
    raw: `:${SERVER_NAME} ${code} ${target} ${middle ? middle + ' ' : ''}:${last}`
  };
}

// ─────────────────────────────────────────────
// Message builders
// ─────────────────────────────────────────────
function mkMsg(prefix, cmd, ...params) {
  const last = params.pop();
  return { type: 'irc', prefix, cmd, params, last,
    raw: `:${prefix} ${cmd}${params.length ? ' ' + params.join(' ') : ''} :${last}` };
}

// ─────────────────────────────────────────────
// Command handlers
// ─────────────────────────────────────────────
function handleNICK(user, newNick) {
  if (!validNick(newNick)) {
    user.send(numeric('432', user.nick, 'Erroneous nickname'));
    return;
  }
  if (users.has(newNick)) {
    user.send(numeric('433', user.nick, `${newNick}`, 'Nickname is already in use'));
    return;
  }
  const oldNick = user.nick;
  if (oldNick) users.delete(oldNick);
  user.nick = newNick;
  users.set(newNick, user);

  if (oldNick) {
    // Notify all shared channels
    const msg = mkMsg(user.hostmask(), 'NICK', newNick);
    user.send(msg);
    for (const cname of user.channels) {
      const ch = channels.get(cname);
      if (ch) ch.broadcast(msg, newNick);
    }
  }
  tryRegister(user);
}

function handleUSER(user, username, realname) {
  if (user.registered) { user.send(numeric('462', user.nick, 'Already registered')); return; }
  user.username = username;
  user.realname = realname;
  tryRegister(user);
}

function tryRegister(user) {
  if (user.registered || !user.nick || !user.username) return;
  user.registered = true;
  user.send(numeric('001', user.nick, `Welcome to ${SERVER_NAME}, ${user.nick}!`));
  user.send(numeric('002', user.nick, `Your host is ${SERVER_NAME} running IRCnet/1.0`));
  user.send(numeric('003', user.nick, `This server was created today`));
  user.send(numeric('375', user.nick, `- ${SERVER_NAME} Message of the Day -`));
  user.send(numeric('372', user.nick, `- ${MOTD}`));
  user.send(numeric('376', user.nick, `End of MOTD`));
}

function handleJOIN(user, chanName) {
  if (!user.registered) return;
  if (!validChan(chanName)) {
    user.send(numeric('403', user.nick, chanName, 'No such channel'));
    return;
  }
  if (user.channels.has(chanName)) return;

  let ch = channels.get(chanName);
  const isNew = !ch;
  if (!ch) { ch = new Channel(chanName); channels.set(chanName, ch); }

  ch.users.add(user.nick);
  user.channels.add(chanName);
  if (isNew) ch.ops.add(user.nick);

  const joinMsg = mkMsg(user.hostmask(), 'JOIN', chanName);
  user.send(joinMsg);
  ch.broadcast(joinMsg, user.nick);

  if (ch.topic) {
    user.send(numeric('332', user.nick, chanName, ch.topic));
  } else {
    user.send(numeric('331', user.nick, chanName, 'No topic is set'));
  }
  user.send(numeric('353', user.nick, '=', chanName, ch.userList()));
  user.send(numeric('366', user.nick, chanName, 'End of /NAMES list'));
}

function handlePART(user, chanName, reason = 'Leaving') {
  if (!user.registered) return;
  const ch = channels.get(chanName);
  if (!ch || !ch.users.has(user.nick)) {
    user.send(numeric('442', user.nick, chanName, "You're not on that channel"));
    return;
  }
  const msg = mkMsg(user.hostmask(), 'PART', chanName, reason);
  user.send(msg);
  ch.broadcast(msg, user.nick);
  ch.users.delete(user.nick);
  user.channels.delete(chanName);
  if (ch.users.size === 0) channels.delete(chanName);
}

function handlePRIVMSG(user, target, text) {
  if (!user.registered) return;
  const msg = mkMsg(user.hostmask(), 'PRIVMSG', target, text);
  if (target.startsWith('#')) {
    const ch = channels.get(target);
    if (!ch) { user.send(numeric('403', user.nick, target, 'No such channel')); return; }
    if (!ch.users.has(user.nick)) { user.send(numeric('404', user.nick, target, 'Cannot send to channel')); return; }
    ch.broadcast(msg, user.nick);
  } else {
    const dest = users.get(target);
    if (!dest) { user.send(numeric('401', user.nick, target, 'No such nick')); return; }
    dest.send(msg);
    if (dest.away) user.send(mkMsg(SERVER_NAME, '301', user.nick, target, dest.awayMsg));
  }
}

function handleTOPIC(user, chanName, topic) {
  if (!user.registered) return;
  const ch = channels.get(chanName);
  if (!ch) { user.send(numeric('403', user.nick, chanName, 'No such channel')); return; }
  if (!ch.users.has(user.nick)) { user.send(numeric('442', user.nick, chanName, "You're not on that channel")); return; }
  if (topic === undefined) {
    user.send(ch.topic
      ? numeric('332', user.nick, chanName, ch.topic)
      : numeric('331', user.nick, chanName, 'No topic is set'));
    return;
  }
  if (ch.modes.has('t') && !ch.ops.has(user.nick)) {
    user.send(numeric('482', user.nick, chanName, "You're not channel operator"));
    return;
  }
  ch.topic = topic;
  const msg = mkMsg(user.hostmask(), 'TOPIC', chanName, topic);
  ch.broadcast(msg);
  user.send(msg);
}

function handleKICK(user, chanName, target, reason = 'Kicked') {
  const ch = channels.get(chanName);
  if (!ch || !ch.ops.has(user.nick)) return;
  const tu = users.get(target);
  if (!tu || !ch.users.has(target)) return;
  const msg = mkMsg(user.hostmask(), 'KICK', chanName, target, reason);
  ch.broadcast(msg);
  user.send(msg);
  ch.users.delete(target);
  tu.channels.delete(chanName);
}

function handleOP(user, chanName, target) {
  const ch = channels.get(chanName);
  if (!ch || !ch.ops.has(user.nick)) return;
  ch.ops.add(target);
  const msg = mkMsg(user.hostmask(), 'MODE', chanName, '+o', target);
  ch.broadcast(msg);
  user.send(msg);
}

function handleAWAY(user, msg) {
  if (msg) {
    user.away = true;
    user.awayMsg = msg;
    user.send(numeric('306', user.nick, 'You have been marked as being away'));
  } else {
    user.away = false;
    user.awayMsg = '';
    user.send(numeric('305', user.nick, 'You are no longer marked as away'));
  }
}

function handleLIST(user) {
  for (const [name, ch] of channels) {
    user.send(numeric('322', user.nick, name, String(ch.users.size), ch.topic || ''));
  }
  user.send(numeric('323', user.nick, 'End of /LIST'));
}

function handleWHO(user, target) {
  if (target && target.startsWith('#')) {
    const ch = channels.get(target);
    if (ch) {
      for (const nick of ch.users) {
        const u = users.get(nick);
        if (u) {
          const flags = u.away ? 'G' : 'H';
          const op    = ch.ops.has(nick) ? '@' : '';
          user.send(numeric('352', user.nick, target, u.username||'user', SERVER_NAME, SERVER_NAME, nick, flags+op, `0 ${u.realname||nick}`));
        }
      }
    }
  }
  user.send(numeric('315', user.nick, target||'*', 'End of /WHO list'));
}

function handleQUIT(user, reason = 'Quit') {
  const msg = mkMsg(user.hostmask(), 'QUIT', reason);
  for (const cname of user.channels) {
    const ch = channels.get(cname);
    if (ch) {
      ch.broadcast(msg, user.nick);
      ch.users.delete(user.nick);
      if (ch.users.size === 0) channels.delete(cname);
    }
  }
  if (user.nick) users.delete(user.nick);
}

function handlePING(user, token) {
  user.send({ type: 'pong', raw: `:${SERVER_NAME} PONG ${SERVER_NAME} :${token}` });
}

// ─────────────────────────────────────────────
// Parse incoming command (from WS or TCP)
// ─────────────────────────────────────────────
function dispatch(user, line) {
  line = line.trim();
  if (!line) return;

  // Parse IRC line
  let prefix = '';
  if (line.startsWith(':')) {
    const sp = line.indexOf(' ');
    prefix = line.slice(1, sp);
    line   = line.slice(sp + 1).trim();
  }

  const parts = line.match(/^(\S+)((?:\s+[^:]\S*)*)?(?:\s+:(.*))?$/);
  if (!parts) return;

  const cmd    = parts[1].toUpperCase();
  const middle = (parts[2] || '').trim().split(/\s+/).filter(Boolean);
  const trailing = parts[3];
  const params = trailing !== undefined ? [...middle, trailing] : middle;

  switch (cmd) {
    case 'NICK':  handleNICK(user, params[0]); break;
    case 'USER':  handleUSER(user, params[0], params[3] || params[0]); break;
    case 'JOIN':  handleJOIN(user, params[0]); break;
    case 'PART':  handlePART(user, params[0], params[1]); break;
    case 'PRIVMSG': handlePRIVMSG(user, params[0], params[1]); break;
    case 'TOPIC': handleTOPIC(user, params[0], params[1]); break;
    case 'KICK':  handleKICK(user, params[0], params[1], params[2]); break;
    case 'MODE':
      if (params[2] === '+o') handleOP(user, params[0], params[2]);
      else user.send(numeric('324', user.nick, params[0], '+n'));
      break;
    case 'AWAY':  handleAWAY(user, params[0]); break;
    case 'LIST':  handleLIST(user); break;
    case 'WHO':   handleWHO(user, params[0]); break;
    case 'WHOIS': {
      const tu = users.get(params[0]);
      if (tu) {
        user.send(numeric('311', user.nick, tu.nick, tu.username||'user', SERVER_NAME, tu.realname||tu.nick));
        user.send(numeric('312', user.nick, tu.nick, SERVER_NAME, 'IRCnet server'));
        if (tu.away) user.send(numeric('301', user.nick, tu.nick, tu.awayMsg));
      } else {
        user.send(numeric('401', user.nick, params[0], 'No such nick'));
      }
      user.send(numeric('318', user.nick, params[0]||'*', 'End of /WHOIS list'));
      break;
    }
    case 'NAMES': {
      const ch = channels.get(params[0]);
      if (ch) {
        user.send(numeric('353', user.nick, '=', params[0], ch.userList()));
        user.send(numeric('366', user.nick, params[0], 'End of /NAMES list'));
      }
      break;
    }
    case 'PING': handlePING(user, params[0] || SERVER_NAME); break;
    case 'PONG': break;
    case 'QUIT': handleQUIT(user, params[0]); break;
    case 'CAP':  break; // ignore capability negotiation for now
    default:
      user.send(numeric('421', user.nick, cmd, 'Unknown command'));
  }
}

// ─────────────────────────────────────────────
// WebSocket server (native implementation)
// ─────────────────────────────────────────────
function wsHandshake(req, socket) {
  const key = req.headers['sec-websocket-key'];
  const accept = crypto
    .createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');

  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
}

function parseWsFrame(buf) {
  if (buf.length < 2) return null;
  const fin    = (buf[0] & 0x80) !== 0;
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let len      = buf[1] & 0x7f;
  let offset   = 2;

  if (len === 126) { len = buf.readUInt16BE(2); offset = 4; }
  else if (len === 127) { len = Number(buf.readBigUInt64BE(2)); offset = 10; }

  if (buf.length < offset + (masked ? 4 : 0) + len) return null;

  let payload;
  if (masked) {
    const mask = buf.slice(offset, offset + 4);
    offset += 4;
    payload = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i++) payload[i] = buf[offset + i] ^ mask[i % 4];
  } else {
    payload = buf.slice(offset, offset + len);
  }
  return { opcode, payload, total: offset + len };
}

function buildWsFrame(data) {
  const payload = Buffer.from(data, 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x81; header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81; header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81; header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

function buildWsClose() {
  const buf = Buffer.alloc(2);
  buf[0] = 0x88; buf[1] = 0x00;
  return buf;
}

// ─────────────────────────────────────────────
// HTTP server (static files + WS upgrade)
// ─────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css',
  '.js':   'text/javascript',
  '.ico':  'image/x-icon',
  '.png':  'image/png',
  '.svg':  'image/svg+xml',
};

const httpServer = http.createServer((req, res) => {
  let filePath = path.join(__dirname,
    req.url === '/' ? 'index.html' : req.url.replace(/^\//, ''));

  const ext = path.extname(filePath);
  const mime = MIME[ext] || 'text/plain';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404); res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  });
});

httpServer.on('upgrade', (req, socket, head) => {
  if (req.url !== '/ws') { socket.destroy(); return; }

  wsHandshake(req, socket);

  const uid  = crypto.randomUUID().slice(0, 8);
  let   buf  = Buffer.alloc(0);

  function sendToClient(msgObj) {
    try {
      socket.write(buildWsFrame(JSON.stringify(msgObj)));
    } catch (e) {}
  }

  const user = new User(uid, sendToClient, 'ws');

  socket.on('data', chunk => {
    buf = Buffer.concat([buf, chunk]);
    while (true) {
      const frame = parseWsFrame(buf);
      if (!frame) break;
      buf = buf.slice(frame.total);
      if (frame.opcode === 0x8) { socket.write(buildWsClose()); socket.destroy(); break; }
      if (frame.opcode === 0x1 || frame.opcode === 0x0) {
        const text = frame.payload.toString('utf8');
        // Client sends JSON commands OR raw IRC lines
        try {
          const obj = JSON.parse(text);
          dispatch(user, obj.raw || text);
        } catch {
          dispatch(user, text);
        }
      }
    }
  });

  socket.on('close', () => handleQUIT(user, 'Connection closed'));
  socket.on('error', () => handleQUIT(user, 'Socket error'));
});

httpServer.listen(WS_PORT, () => {
  console.log(`\n  IRCnet server running`);
  console.log(`  ├─ Web client : http://localhost:${WS_PORT}`);
  console.log(`  ├─ WebSocket  : ws://localhost:${WS_PORT}/ws`);
  console.log(`  └─ IRC (TCP)  : irc://localhost:${IRC_PORT}\n`);
});

// ─────────────────────────────────────────────
// Raw TCP IRC server (for real IRC clients)
// ─────────────────────────────────────────────
const ircServer = net.createServer(socket => {
  const uid = crypto.randomUUID().slice(0, 8);

  function sendRaw(msgObj) {
    try { socket.write((msgObj.raw || '') + '\r\n'); } catch (e) {}
  }

  const user = new User(uid, sendRaw, 'irc');
  sendRaw({ raw: `:${SERVER_NAME} NOTICE Auth :*** Looking up your hostname...` });

  let buf = '';
  socket.on('data', data => {
    buf += data.toString('utf8');
    const lines = buf.split('\r\n');
    buf = lines.pop();
    for (const line of lines) {
      if (line.trim()) dispatch(user, line);
    }
  });
  socket.on('close', () => handleQUIT(user, 'Connection closed'));
  socket.on('error', () => handleQUIT(user, 'Socket error'));

  // Ping keepalive
  const pingInterval = setInterval(() => {
    try { socket.write(`:${SERVER_NAME} PING :${SERVER_NAME}\r\n`); }
    catch { clearInterval(pingInterval); }
  }, 90000);
  socket.on('close', () => clearInterval(pingInterval));
});

ircServer.listen(IRC_PORT, () => {
  console.log(`  TCP IRC server listening on port ${IRC_PORT}`);
});

// Graceful shutdown
process.on('SIGTERM', () => { httpServer.close(); ircServer.close(); process.exit(0); });
process.on('SIGINT',  () => { httpServer.close(); ircServer.close(); process.exit(0); });
