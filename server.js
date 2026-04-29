/**
 * IRCnet v2 — Serveur IRC WebSocket + TCP
 * Fonctionnalités : rangs, statuts, canaux sécurisés, sanctions complètes
 * Zéro dépendance externe — Node.js natif uniquement
 */
'use strict';

const http   = require('http');
const net    = require('net');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const WS_PORT     = process.env.PORT        || 3000;
const IRC_PORT    = process.env.IRC_PORT    || 6667;
const SERVER_NAME = process.env.SERVER_NAME || 'irc.localnet';
const ADMIN_PASS  = process.env.ADMIN_PASS  || 'admin1234';
const MOTD        = process.env.MOTD        || `Bienvenue sur ${SERVER_NAME} v2`;

const RANK        = { owner:5, admin:4, op:3, halfop:2, voice:1, user:0 };
const RANK_PREFIX = { owner:'~', admin:'&', op:'@', halfop:'%', voice:'+', user:'' };
const RANK_LABEL  = { owner:'Fondateur', admin:'Admin', op:'Opérateur', halfop:'Demi-op', voice:'Voix', user:'Utilisateur' };

const STATUSES = {
  online: { label:'En ligne',            emoji:'🟢', color:'#2ec79a' },
  away:   { label:'Absent',              emoji:'🟡', color:'#f0a726' },
  busy:   { label:'Occupé',              emoji:'🔴', color:'#f06060' },
  wc:     { label:'Aux toilettes',       emoji:'🚽', color:'#f0a726' },
  eating: { label:'En train de manger',  emoji:'🍽️',  color:'#f0a726' },
  gaming: { label:'En train de jouer',   emoji:'🎮', color:'#9b7ff4' },
  sleep:  { label:'Dort',               emoji:'💤', color:'#4a5978' },
  coding: { label:'Code en cours',       emoji:'💻', color:'#38bdf8' },
  brb:    { label:'Revient vite',        emoji:'⏱️',  color:'#f0a726' },
  custom: { label:'Statut personnalisé', emoji:'✏️',  color:'#e8edf8' },
};

const users    = new Map();
const channels = new Map();
const gbans    = new Map(); // nick → {until,reason,by}

class User {
  constructor(id, send, type='ws') {
    this.id          = id;
    this.nick        = null;
    this.username    = null;
    this.realname    = null;
    this.type        = type;
    this.send        = send;
    this.channels    = new Set();
    this.status      = 'online';
    this.statusMsg   = '';
    this.statusSince = Date.now();
    this.away        = false;
    this.awayMsg     = '';
    this.registered  = false;
    this.globalRank  = 'user';
    this.connectedAt = Date.now();
  }
  hostmask()       { return `${this.nick}!${this.username||'user'}@${SERVER_NAME}`; }
  isAdmin()        { return RANK[this.globalRank] >= RANK.admin; }
  statusInfo()     { return STATUSES[this.status] || STATUSES.online; }
  statusDuration() {
    const s = Math.floor((Date.now()-this.statusSince)/1000);
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s/60)}min`;
    return `${Math.floor(s/3600)}h${Math.floor((s%3600)/60)}min`;
  }
}

class Channel {
  constructor(name, owner=null) {
    this.name       = name;
    this.topic      = '';
    this.users      = new Map(); // nick → rank
    this.created    = Date.now();
    this.password   = null;
    this.inviteOnly = false;
    this.invites    = new Set();
    this.bans       = new Set();
    this.muted      = new Set();
    this.maxUsers   = 0;
    this.modes      = new Set(['n','t']);
    if (owner) this.users.set(owner, 'owner');
  }
  rankOf(nick)   { return this.users.get(nick) || 'user'; }
  rankNum(nick)  { return RANK[this.rankOf(nick)] || 0; }
  prefix(nick)   { return RANK_PREFIX[this.rankOf(nick)] || ''; }
  isOp(nick)     { return RANK[this.rankOf(nick)] >= RANK.op; }
  isHalfOp(nick) { return RANK[this.rankOf(nick)] >= RANK.halfop; }
  broadcast(msg, excludeNick=null) {
    for (const nick of this.users.keys()) {
      if (nick === excludeNick) continue;
      const u = users.get(nick); if (u) u.send(msg);
    }
  }
  broadcastAll(msg) { this.broadcast(msg, null); }
  userList() {
    return [...this.users.entries()]
      .sort((a,b) => RANK[b[1]]-RANK[a[1]])
      .map(([n,r]) => (RANK_PREFIX[r]||'')+n).join(' ');
  }
}

function validNick(n) { return /^[a-zA-Z_\-\[\]\\^{}|`][a-zA-Z0-9_\-\[\]\\^{}|`]{0,29}$/.test(n); }
function validChan(n) { return /^#[^\s,:]{1,49}$/.test(n); }
function hashPass(p)  { return crypto.createHash('sha256').update(p+'irc_salt_2024').digest('hex'); }

function numeric(code, nick, ...params) {
  const last = params.pop();
  const mid  = params.join(' ');
  return { type:'numeric', code, raw:`:${SERVER_NAME} ${code} ${nick||'*'} ${mid?mid+' ':''}:${last}` };
}
function mkMsg(prefix, cmd, ...params) {
  const last = params.pop();
  return { type:'irc', raw:`:${prefix} ${cmd}${params.length?' '+params.join(' '):''} :${last}` };
}
function sysNotice(user, text) {
  user.send({ type:'system', raw:`:${SERVER_NAME} NOTICE ${user.nick||'*'} :${text}` });
}

function broadcastStatus(user) {
  const obj = { type:'status_update', nick:user.nick, status:user.status, statusMsg:user.statusMsg, statusSince:user.statusSince };
  const seen = new Set([user.nick]);
  user.send(obj);
  for (const cname of user.channels) {
    const ch = channels.get(cname);
    if (!ch) continue;
    for (const nick of ch.users.keys()) {
      if (seen.has(nick)) continue;
      seen.add(nick);
      const u = users.get(nick); if (u) u.send(obj);
    }
  }
}

// ── Handlers ──────────────────────────────────────────────────────────────────

function handleNICK(user, newNick) {
  if (!newNick || !validNick(newNick)) { user.send(numeric('432',user.nick,'Erroneous nickname')); return; }
  if (users.has(newNick)) { user.send(numeric('433',user.nick,newNick,'Nickname is already in use')); return; }
  const old = user.nick;
  if (old) users.delete(old);
  user.nick = newNick;
  users.set(newNick, user);
  if (old) {
    const msg = mkMsg(old+'!'+(user.username||'u')+'@'+SERVER_NAME, 'NICK', newNick);
    user.send(msg);
    for (const cname of user.channels) {
      const ch = channels.get(cname);
      if (!ch) continue;
      const rank = ch.users.get(old)||'user';
      ch.users.delete(old); ch.users.set(newNick, rank);
      ch.broadcast(msg, newNick);
      ch.broadcast({ type:'nick_change', old, neo:newNick, channel:cname }, newNick);
    }
  }
  tryRegister(user);
}

function handleUSER(user, username, realname) {
  if (user.registered) { user.send(numeric('462',user.nick,'Already registered')); return; }
  user.username = username; user.realname = realname;
  tryRegister(user);
}

function tryRegister(user) {
  if (user.registered || !user.nick || !user.username) return;
  const b = gbans.get(user.nick);
  if (b && (!b.until || b.until > Date.now())) {
    user.send({ type:'error', raw:`:${SERVER_NAME} ERROR :Banned: ${b.reason}` }); return;
  }
  user.registered = true;
  user.send(numeric('001',user.nick,`Welcome to ${SERVER_NAME}, ${user.nick}!`));
  user.send(numeric('002',user.nick,`Your host is ${SERVER_NAME} running IRCnet/2.0`));
  user.send(numeric('375',user.nick,`- ${SERVER_NAME} Message of the Day -`));
  user.send(numeric('372',user.nick,`- ${MOTD}`));
  user.send(numeric('372',user.nick,`- Rangs: ~Fondateur &Admin @Op %Demi-op +Voix`));
  user.send(numeric('372',user.nick,`- Commandes: /status /rank /move /mute /invite /gban`));
  user.send(numeric('376',user.nick,'End of MOTD'));
  user.send({ type:'statuses_list', statuses:STATUSES });
  user.send({ type:'ranks_list', ranks:RANK_LABEL });
}

function handleJOIN(user, chanName, password='') {
  if (!user.registered || !chanName) return;
  if (!validChan(chanName)) { user.send(numeric('403',user.nick,chanName,'No such channel')); return; }
  if (user.channels.has(chanName)) return;

  let ch = channels.get(chanName);
  const isNew = !ch;
  if (!ch) {
    ch = new Channel(chanName, user.nick);
    channels.set(chanName, ch);
  } else {
    if (ch.bans.has(user.nick))             { user.send(numeric('474',user.nick,chanName,'You are banned (+b)')); return; }
    if (ch.inviteOnly && !ch.invites.has(user.nick)) { user.send(numeric('473',user.nick,chanName,'Invite only (+i)')); return; }
    if (ch.password && hashPass(password) !== ch.password) { user.send(numeric('475',user.nick,chanName,'Bad channel key (+k)')); return; }
    if (ch.maxUsers && ch.users.size >= ch.maxUsers) { user.send(numeric('471',user.nick,chanName,'Channel is full (+l)')); return; }
    ch.users.set(user.nick, 'user');
  }
  user.channels.add(chanName);
  ch.invites.delete(user.nick);

  const joinIrc = mkMsg(user.hostmask(), 'JOIN', chanName);
  user.send(joinIrc);
  ch.broadcast(joinIrc, user.nick);
  ch.broadcast({ type:'user_joined', channel:chanName, nick:user.nick, rank:ch.rankOf(user.nick), status:user.status, statusMsg:user.statusMsg }, user.nick);

  user.send(ch.topic ? numeric('332',user.nick,chanName,ch.topic) : numeric('331',user.nick,chanName,'No topic'));
  user.send(numeric('353',user.nick,'=',chanName,ch.userList()));
  user.send(numeric('366',user.nick,chanName,'End of /NAMES'));
  user.send({ type:'chan_info', channel:chanName, secured:!!ch.password, inviteOnly:ch.inviteOnly, maxUsers:ch.maxUsers });

  // Statuts des membres
  const ms = {};
  for (const [nick,rank] of ch.users) {
    const u = users.get(nick);
    if (u) ms[nick] = { rank, status:u.status, statusMsg:u.statusMsg, statusSince:u.statusSince };
  }
  user.send({ type:'member_statuses', channel:chanName, members:ms });
}

function handlePART(user, chanName, reason='Leaving') {
  const ch = channels.get(chanName);
  if (!ch || !ch.users.has(user.nick)) { user.send(numeric('442',user.nick,chanName,"You're not on that channel")); return; }
  const msg = mkMsg(user.hostmask(), 'PART', chanName, reason);
  user.send(msg); ch.broadcast(msg, user.nick);
  ch.broadcast({ type:'user_left', channel:chanName, nick:user.nick, reason }, user.nick);
  ch.users.delete(user.nick); user.channels.delete(chanName);
  if (ch.users.size === 0) channels.delete(chanName);
}

function handlePRIVMSG(user, target, text) {
  if (!user.registered || !text) return;
  if (target.startsWith('#')) {
    const ch = channels.get(target);
    if (!ch) { user.send(numeric('403',user.nick,target,'No such channel')); return; }
    if (!ch.users.has(user.nick)) { user.send(numeric('404',user.nick,target,'Cannot send')); return; }
    if (ch.muted.has(user.nick) && !ch.isOp(user.nick)) { sysNotice(user,'Vous êtes muet sur ce canal'); return; }
    ch.broadcast(mkMsg(user.hostmask(),'PRIVMSG',target,text), user.nick);
  } else {
    const dest = users.get(target);
    if (!dest) { user.send(numeric('401',user.nick,target,'No such nick')); return; }
    dest.send(mkMsg(user.hostmask(),'PRIVMSG',target,text));
    if (dest.away) user.send(mkMsg(SERVER_NAME,'301',user.nick,target,dest.awayMsg));
  }
}

function handleSTATUS(user, code, msg='') {
  if (!STATUSES[code]) { sysNotice(user,'Statuts valides : '+Object.keys(STATUSES).join(', ')); return; }
  user.status = code; user.statusMsg = msg; user.statusSince = Date.now();
  user.away = (code !== 'online'); user.awayMsg = msg || STATUSES[code].label;
  broadcastStatus(user);
  sysNotice(user,`Statut → ${STATUSES[code].emoji} ${STATUSES[code].label}${msg?' ('+msg+')':''}`);
}

function handleTOPIC(user, chanName, topic) {
  const ch = channels.get(chanName);
  if (!ch) { user.send(numeric('403',user.nick,chanName,'No such channel')); return; }
  if (topic === undefined) { user.send(ch.topic ? numeric('332',user.nick,chanName,ch.topic) : numeric('331',user.nick,chanName,'No topic')); return; }
  if (ch.modes.has('t') && !ch.isHalfOp(user.nick) && !user.isAdmin()) { user.send(numeric('482',user.nick,chanName,"Not an operator")); return; }
  ch.topic = topic;
  const m = mkMsg(user.hostmask(),'TOPIC',chanName,topic);
  ch.broadcastAll(m);
  ch.broadcast({ type:'topic_change', channel:chanName, topic, actor:user.nick }, null);
}

function handleMODE(user, chanName, modeStr, ...args) {
  const ch = channels.get(chanName);
  if (!ch) return;
  const canSet = ch.isOp(user.nick) || user.isAdmin();

  if (!modeStr) {
    const ml = [...ch.modes].join('')+(ch.password?'k':'')+(ch.inviteOnly?'i':'')+(ch.maxUsers?'l':'');
    user.send(numeric('324',user.nick,chanName,'+'+ml)); return;
  }
  if (!canSet) { user.send(numeric('482',user.nick,chanName,"Not an operator")); return; }

  let sign='+', ai=0;
  for (const c of modeStr) {
    if (c==='+' || c==='-') { sign=c; continue; }
    const arg = args[ai];
    switch(c) {
      case 'n': sign==='+'?ch.modes.add('n'):ch.modes.delete('n'); break;
      case 't': sign==='+'?ch.modes.add('t'):ch.modes.delete('t'); break;
      case 'i': ch.inviteOnly=sign==='+'; break;
      case 'm': sign==='+'?ch.modes.add('m'):ch.modes.delete('m'); break;
      case 'k':
        if (sign==='+' && arg) { ch.password=hashPass(arg); ai++; }
        else ch.password=null;
        break;
      case 'l':
        if (sign==='+' && arg) { ch.maxUsers=parseInt(arg)||0; ai++; }
        else ch.maxUsers=0;
        break;
      case 'b':
        if (arg) { sign==='+'?ch.bans.add(arg):ch.bans.delete(arg); ai++; }
        else { for (const b of ch.bans) user.send(numeric('367',user.nick,chanName,b)); user.send(numeric('368',user.nick,chanName,'End of ban list')); }
        break;
      case 'o': if (arg) { setRank(user,ch,arg,sign==='+'?'op':'user'); ai++; } break;
      case 'h': if (arg) { setRank(user,ch,arg,sign==='+'?'halfop':'user'); ai++; } break;
      case 'v': if (arg) { setRank(user,ch,arg,sign==='+'?'voice':'user'); ai++; } break;
      case 'a': if (arg&&(ch.rankOf(user.nick)==='owner'||user.isAdmin())) { setRank(user,ch,arg,sign==='+'?'admin':'user'); ai++; } break;
      case 'q': if (arg&&(user.isAdmin()||ch.rankOf(user.nick)==='owner')) { setRank(user,ch,arg,sign==='+'?'owner':'user'); ai++; } break;
    }
  }
  ch.broadcast(mkMsg(user.hostmask(),'MODE',chanName,modeStr,...args.slice(0,ai)));
  ch.broadcast({ type:'mode_change', channel:chanName, actor:user.nick, mode:modeStr, args:args.slice(0,ai) }, null);
}

function setRank(actor, ch, targetNick, newRank) {
  if (!ch.users.has(targetNick)) return;
  if (RANK[ch.rankOf(actor.nick)] <= RANK[ch.rankOf(targetNick)] && !actor.isAdmin()) return;
  ch.users.set(targetNick, newRank);
  const tu = users.get(targetNick);
  const label = RANK_LABEL[newRank];
  ch.broadcastAll({ type:'rank_change', channel:ch.name, actor:actor.nick, target:targetNick, rank:newRank, rankLabel:label,
    raw:`:${actor.hostmask()} MODE ${ch.name} +${newRank} ${targetNick}` });
  if (tu) tu.send({ type:'your_rank', channel:ch.name, rank:newRank, rankLabel:label });
}

function handleKICK(user, chanName, target, reason='Expulsé') {
  const ch = channels.get(chanName);
  if (!ch) return;
  if (!ch.isHalfOp(user.nick) && !user.isAdmin()) { user.send(numeric('482',user.nick,chanName,"Not operator")); return; }
  if (!ch.users.has(target)) { user.send(numeric('441',user.nick,target,chanName,"They aren't on that channel")); return; }
  if (RANK[ch.rankOf(target)] >= RANK[ch.rankOf(user.nick)] && !user.isAdmin()) { sysNotice(user,'Impossible d\'expulser quelqu\'un de rang supérieur'); return; }
  ch.broadcastAll(mkMsg(user.hostmask(),'KICK',chanName,target,reason));
  ch.broadcastAll({ type:'user_kicked', channel:chanName, actor:user.nick, target, reason });
  const tu = users.get(target);
  if (tu) tu.channels.delete(chanName);
  ch.users.delete(target);
  if (ch.users.size === 0) channels.delete(chanName);
}

function handleMOVE(user, chanName, target, destChan, reason='Déplacé par un opérateur') {
  const ch = channels.get(chanName);
  if (!ch || (!ch.isOp(user.nick) && !user.isAdmin())) { user.send(numeric('482',user.nick,chanName,"Not operator")); return; }
  if (!ch.users.has(target)) return;
  if (RANK[ch.rankOf(target)] >= RANK[ch.rankOf(user.nick)] && !user.isAdmin()) { sysNotice(user,'Rang insuffisant'); return; }
  const tu = users.get(target);
  if (!tu) return;
  sysNotice(tu, `${user.nick} vous déplace vers ${destChan} : ${reason}`);
  tu.send({ type:'forced_move', from:chanName, to:destChan, reason, actor:user.nick });
  handlePART(tu, chanName, `Déplacé vers ${destChan}`);
  handleJOIN(tu, destChan);
  sysNotice(user, `${target} déplacé vers ${destChan}`);
}

function handleMUTE(user, chanName, target, duration=0) {
  const ch = channels.get(chanName);
  if (!ch || (!ch.isHalfOp(user.nick) && !user.isAdmin())) { user.send(numeric('482',user.nick,chanName,"Not operator")); return; }
  ch.muted.add(target);
  ch.broadcastAll({ type:'user_muted', channel:chanName, actor:user.nick, target, duration,
    raw:`:${SERVER_NAME} NOTICE ${chanName} :${target} a été rendu muet par ${user.nick}` });
  if (duration > 0) setTimeout(() => { ch.muted.delete(target); ch.broadcastAll({ type:'user_unmuted', channel:chanName, target }); }, duration*1000);
}

function handleUNMUTE(user, chanName, target) {
  const ch = channels.get(chanName);
  if (!ch || (!ch.isHalfOp(user.nick) && !user.isAdmin())) { user.send(numeric('482',user.nick,chanName,"Not operator")); return; }
  ch.muted.delete(target);
  ch.broadcastAll({ type:'user_unmuted', channel:chanName, actor:user.nick, target,
    raw:`:${SERVER_NAME} NOTICE ${chanName} :${target} peut à nouveau parler` });
}

function handleGBAN(user, target, duration=0, reason='Banned') {
  if (!user.isAdmin()) { sysNotice(user,'Réservé aux admins'); return; }
  const until = duration>0 ? Date.now()+duration*60000 : 0;
  gbans.set(target, { until, reason, by:user.nick, at:Date.now() });
  const tu = users.get(target);
  if (tu) {
    tu.send({ type:'error', raw:`:${SERVER_NAME} ERROR :You are banned: ${reason}` });
    for (const c of [...tu.channels]) { const ch=channels.get(c); if (ch) { ch.users.delete(target); ch.broadcastAll({ type:'user_banned', target, reason }); } }
    tu.channels.clear(); users.delete(target);
  }
  sysNotice(user, `${target} banni ${duration?'pour '+duration+'min':'définitivement'} : ${reason}`);
}

function handleGUNBAN(user, target) {
  if (!user.isAdmin()) { sysNotice(user,'Réservé aux admins'); return; }
  gbans.delete(target); sysNotice(user, `${target} débanni`);
}

function handleINVITE(user, target, chanName) {
  const ch = channels.get(chanName);
  if (!ch) { user.send(numeric('403',user.nick,chanName,'No such channel')); return; }
  if (!ch.isHalfOp(user.nick)&&!user.isAdmin()) { user.send(numeric('482',user.nick,chanName,"Not operator")); return; }
  const tu = users.get(target);
  if (!tu) { user.send(numeric('401',user.nick,target,'No such nick')); return; }
  ch.invites.add(target);
  tu.send(mkMsg(user.hostmask(),'INVITE',target,chanName));
  tu.send({ type:'invite', channel:chanName, from:user.nick });
  user.send(numeric('341',user.nick,target,chanName));
}

function handleOPER(user, pass) {
  if (hashPass(pass) === hashPass(ADMIN_PASS)) {
    user.globalRank = 'admin';
    user.send(numeric('381',user.nick,'You are now an IRC operator'));
    user.send({ type:'rank_update', rank:'admin' });
    sysNotice(user,'Bienvenue, Admin ! Commandes: /gban /gunban /move');
  } else user.send(numeric('464',user.nick,'Password incorrect'));
}

function handleWHOIS(user, target) {
  const tu = users.get(target);
  if (!tu) { user.send(numeric('401',user.nick,target,'No such nick')); user.send(numeric('318',user.nick,target,'End of /WHOIS')); return; }
  user.send(numeric('311',user.nick,tu.nick,tu.username||'user',SERVER_NAME,tu.realname||tu.nick));
  user.send(numeric('312',user.nick,tu.nick,SERVER_NAME,'IRCnet/2.0'));
  const si = tu.statusInfo();
  user.send({ type:'whois_ext', target:tu.nick, globalRank:tu.globalRank, status:tu.status, statusMsg:tu.statusMsg, statusLabel:si.label, statusEmoji:si.emoji, duration:tu.statusDuration(),
    raw:`:${SERVER_NAME} NOTICE ${user.nick} :${tu.nick}: ${si.emoji} ${si.label} (${tu.statusDuration()})${tu.statusMsg?' — '+tu.statusMsg:''}` });
  if (RANK[tu.globalRank]>=RANK.admin) user.send(numeric('313',user.nick,tu.nick,'is an IRC operator'));
  user.send(numeric('317',user.nick,tu.nick,Math.floor((Date.now()-tu.connectedAt)/1000),'seconds idle'));
  user.send(numeric('318',user.nick,target,'End of /WHOIS'));
}

function handleQUIT(user, reason='Quit') {
  if (!user || !user.nick) return;
  const msg = mkMsg(user.hostmask(),'QUIT',reason);
  const left = { type:'user_left', nick:user.nick, reason };
  for (const cname of user.channels) {
    const ch = channels.get(cname);
    if (!ch) continue;
    ch.broadcast(msg, user.nick); ch.broadcast(left, user.nick);
    ch.users.delete(user.nick);
    if (ch.users.size===0) channels.delete(cname);
  }
  users.delete(user.nick);
}

function handleLIST(user) {
  user.send(numeric('321',user.nick,'Channel','Users  Name'));
  for (const [name,ch] of channels) {
    const flags = (ch.password?'k':'')+(ch.inviteOnly?'i':'');
    user.send(numeric('322',user.nick,`${name} [${flags||'open'}]`,String(ch.users.size),ch.topic||''));
  }
  user.send(numeric('323',user.nick,'End of /LIST'));
}

function dispatch(user, line) {
  line = line.trim(); if (!line) return;
  if (line.startsWith(':')) { const sp=line.indexOf(' '); line=line.slice(sp+1).trim(); }
  const parts = line.match(/^(\S+)((?:\s+[^:]\S*)*)?(?:\s+:(.*))?$/);
  if (!parts) return;
  const cmd      = parts[1].toUpperCase();
  const middle   = (parts[2]||'').trim().split(/\s+/).filter(Boolean);
  const trailing = parts[3];
  const params   = trailing!==undefined ? [...middle,trailing] : middle;

  switch(cmd) {
    case 'NICK':    handleNICK(user,params[0]); break;
    case 'USER':    handleUSER(user,params[0],params[3]||params[0]); break;
    case 'JOIN':    handleJOIN(user,params[0],params[1]||''); break;
    case 'PART':    handlePART(user,params[0],params[1]); break;
    case 'PRIVMSG': handlePRIVMSG(user,params[0],params[1]); break;
    case 'TOPIC':   handleTOPIC(user,params[0],params[1]); break;
    case 'KICK':    handleKICK(user,params[0],params[1],params[2]); break;
    case 'INVITE':  handleINVITE(user,params[0],params[1]); break;
    case 'MODE':    handleMODE(user,params[0],params[1],...params.slice(2)); break;
    case 'OPER':    handleOPER(user,params[0]); break;
    case 'AWAY':
      if (params[0]) { user.away=true; user.awayMsg=params[0]; user.send(numeric('306',user.nick,'You are away')); }
      else { user.away=false; user.awayMsg=''; user.send(numeric('305',user.nick,'You are back')); }
      break;
    case 'LIST':    handleLIST(user); break;
    case 'WHOIS':   handleWHOIS(user,params[0]); break;
    case 'NAMES': {
      const ch=channels.get(params[0]);
      if (ch) { user.send(numeric('353',user.nick,'=',params[0],ch.userList())); user.send(numeric('366',user.nick,params[0],'End of /NAMES')); }
      break;
    }
    case 'WHO': {
      const ch=channels.get(params[0]);
      if (ch) for (const [nick,rank] of ch.users) {
        const u=users.get(nick);
        if (u) user.send(numeric('352',user.nick,params[0],u.username||'u',SERVER_NAME,SERVER_NAME,nick,(u.away?'G':'H')+(RANK_PREFIX[rank]||''),`0 ${u.realname||nick}`));
      }
      user.send(numeric('315',user.nick,params[0]||'*','End of /WHO'));
      break;
    }
    case 'PING':   user.send({ type:'pong', raw:`:${SERVER_NAME} PONG ${SERVER_NAME} :${params[0]||SERVER_NAME}` }); break;
    case 'PONG':   break;
    case 'QUIT':   handleQUIT(user,params[0]); break;
    case 'CAP':    break;
    // Commandes étendues
    case 'STATUS': handleSTATUS(user,params[0],params.slice(1).join(' ')); break;
    case 'MOVE':   handleMOVE(user,params[0],params[1],params[2],params[3]); break;
    case 'MUTE':   handleMUTE(user,params[0],params[1],parseInt(params[2])||0); break;
    case 'UNMUTE': handleUNMUTE(user,params[0],params[1]); break;
    case 'GBAN':   handleGBAN(user,params[0],parseInt(params[1])||0,params.slice(2).join(' ')||'Banned'); break;
    case 'GUNBAN': handleGUNBAN(user,params[0]); break;
    default:       user.send(numeric('421',user.nick,cmd,'Unknown command'));
  }
}

// ── WebSocket natif ────────────────────────────────────────────────────────────
function wsHandshake(req, socket) {
  const acc = crypto.createHash('sha1').update(req.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+acc+'\r\n\r\n');
}
function parseWsFrame(buf) {
  if (buf.length<2) return null;
  const op=buf[0]&0x0f, masked=(buf[1]&0x80)!==0;
  let len=buf[1]&0x7f, off=2;
  if (len===126){len=buf.readUInt16BE(2);off=4;} else if (len===127){len=Number(buf.readBigUInt64BE(2));off=10;}
  if (buf.length<off+(masked?4:0)+len) return null;
  let payload;
  if (masked){const mask=buf.slice(off,off+4);off+=4;payload=Buffer.allocUnsafe(len);for(let i=0;i<len;i++)payload[i]=buf[off+i]^mask[i%4];}
  else payload=buf.slice(off,off+len);
  return { op, payload, total:off+len };
}
function buildWsFrame(data) {
  const p=Buffer.from(data,'utf8'),len=p.length;
  let h;
  if (len<126){h=Buffer.alloc(2);h[0]=0x81;h[1]=len;}
  else if (len<65536){h=Buffer.alloc(4);h[0]=0x81;h[1]=126;h.writeUInt16BE(len,2);}
  else{h=Buffer.alloc(10);h[0]=0x81;h[1]=127;h.writeBigUInt64BE(BigInt(len),2);}
  return Buffer.concat([h,p]);
}

function getClientHtml() {
  const candidates = [
    path.join(__dirname,'public','index.html'),
    path.join(process.cwd(),'public','index.html'),
    path.join(process.cwd(),'index.html'),
  ];
  for (const p of candidates) { try { return fs.readFileSync(p,'utf8'); } catch {} }
  return '<h1>Placez public/index.html</h1>';
}

const httpServer = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url==='/health') { res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({status:'ok',users:users.size,channels:channels.size})); return; }
  if (url==='/api/channels') {
    const list=[...channels.entries()].map(([name,ch])=>({name,users:ch.users.size,topic:ch.topic,secured:!!ch.password,inviteOnly:ch.inviteOnly}));
    res.writeHead(200,{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'}); res.end(JSON.stringify(list)); return;
  }
  if (url==='/'||url==='/index.html'||!url.includes('.')) { res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'}); res.end(getClientHtml()); return; }
  const MIME={'.css':'text/css','.js':'text/javascript','.ico':'image/x-icon','.png':'image/png','.svg':'image/svg+xml'};
  for (const base of [path.join(__dirname,'public'),path.join(process.cwd(),'public')]) {
    try { const data=fs.readFileSync(base+url); res.writeHead(200,{'Content-Type':MIME[path.extname(url)]||'text/plain'}); res.end(data); return; } catch {}
  }
  res.writeHead(404); res.end('Not found');
});

httpServer.on('upgrade',(req,socket)=>{
  if (req.url!=='/ws'){socket.destroy();return;}
  wsHandshake(req,socket);
  let buf=Buffer.alloc(0);
  const user=new User(crypto.randomUUID().slice(0,8),obj=>{try{socket.write(buildWsFrame(JSON.stringify(obj)));}catch{}},'ws');
  socket.on('data',chunk=>{
    buf=Buffer.concat([buf,chunk]);
    while(true){const f=parseWsFrame(buf);if(!f)break;buf=buf.slice(f.total);
      if(f.op===0x8){socket.write(Buffer.from([0x88,0]));socket.destroy();break;}
      if(f.op===0x1||f.op===0x0){const t=f.payload.toString('utf8');try{const o=JSON.parse(t);dispatch(user,o.raw||t);}catch{dispatch(user,t);}}}
  });
  socket.on('close',()=>handleQUIT(user,'Connection closed'));
  socket.on('error',()=>handleQUIT(user,'Socket error'));
});

httpServer.listen(WS_PORT,()=>{
  console.log(`\n  IRCnet v2`);
  console.log(`  ├─ Web : http://localhost:${WS_PORT}`);
  console.log(`  ├─ WS  : ws://localhost:${WS_PORT}/ws`);
  console.log(`  └─ IRC : irc://localhost:${IRC_PORT}`);
  console.log(`  OPER pass : ${ADMIN_PASS}\n`);
});

const ircServer = net.createServer(socket=>{
  const user=new User(crypto.randomUUID().slice(0,8),o=>{try{socket.write((o.raw||'')+'\r\n');}catch{}},'irc');
  try{socket.write(`:${SERVER_NAME} NOTICE Auth :*** IRCnet v2\r\n`);}catch{}
  let buf='';
  socket.on('data',d=>{buf+=d.toString('utf8');const lines=buf.split('\r\n');buf=lines.pop();for(const l of lines)if(l.trim())dispatch(user,l);});
  socket.on('close',()=>handleQUIT(user,'Connection closed'));
  socket.on('error',()=>handleQUIT(user,'Socket error'));
  const pi=setInterval(()=>{try{socket.write(`:${SERVER_NAME} PING :${SERVER_NAME}\r\n`);}catch{clearInterval(pi);}},90000);
  socket.on('close',()=>clearInterval(pi));
});
ircServer.listen(IRC_PORT,()=>console.log(`  TCP IRC :${IRC_PORT}`));

process.on('SIGTERM',()=>{httpServer.close();ircServer.close();process.exit(0);});
process.on('SIGINT', ()=>{httpServer.close();ircServer.close();process.exit(0);});
