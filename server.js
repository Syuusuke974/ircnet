/**
 * IRCnet v3 — Serveur IRC complet
 * - Fix JOIN/channel list bug
 * - Gestion complète des canaux (fondateur/admin)
 * - Bot serveur configurable (filtres, welcome, règles, commandes)
 * - Zéro dépendance externe
 */
'use strict';

const http   = require('http');
const net    = require('net');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const PORT        = parseInt(process.env.PORT)     || 3000;
const IRC_PORT    = parseInt(process.env.IRC_PORT) || 6667;
const SERVER_NAME = process.env.SERVER_NAME        || 'irc.localnet';
const ADMIN_PASS  = process.env.ADMIN_PASS         || 'admin1234';
const BOT_NICK    = process.env.BOT_NICK           || 'IRCbot';

// ── Rank system ────────────────────────────────────────────────
const RANK_NUM = { owner:5, admin:4, op:3, halfop:2, voice:1, user:0 };
const RANK_PFX = { owner:'~', admin:'&', op:'@', halfop:'%', voice:'+', user:'' };

const STATUSES = {
  online:'En ligne', away:'Absent', busy:'Occupé', wc:'Toilettes',
  eating:'Mange', gaming:'Joue', sleep:'Dort', coding:'Code',
  brb:'Revient vite', custom:'Perso'
};

// ── State ──────────────────────────────────────────────────────
const users    = new Map(); // nick → User
const channels = new Map(); // name → Channel
const gbans    = new Map(); // nick → {until,reason,by}

// ── Bot configuration (modifiable at runtime) ──────────────────
const botConfig = {
  enabled: true,
  nick: BOT_NICK,
  prefix: '!',
  welcome: {
    enabled: true,
    message: `Bienvenue sur ${SERVER_NAME} ! Tapez !help pour les commandes disponibles.`,
    delay: 1500,
  },
  rules: [
    'Soyez respectueux envers tous les membres.',
    'Pas de spam ni de flood.',
    'Pas de contenu illégal ou offensant.',
    'Les décisions des opérateurs sont finales.',
  ],
  filters: {
    enabled: true,
    words: ['putain','merde','connard','salope','fdp','tg'],
    action: 'warn',   // 'warn' | 'delete' | 'mute'
    warnMsg: 'Attention : langage inapproprié détecté.',
    muteSeconds: 30,
  },
  autoOp: {
    enabled: false,
    nicks: [],        // nicks qui reçoivent automatiquement @op
  },
  floodProtect: {
    enabled: true,
    maxMessages: 5,   // messages max par fenêtre
    windowSeconds: 3,
    action: 'mute',   // 'warn' | 'mute' | 'kick'
    muteSeconds: 60,
  },
  commands: {
    help:  { enabled:true,  reply:'Commandes : !help !rules !info !stats !time !ping !uptime !who' },
    rules: { enabled:true,  reply:null }, // built dynamically
    info:  { enabled:true,  reply:`Serveur IRC ${SERVER_NAME} — IRCnet v3` },
    stats: { enabled:true,  reply:null }, // built dynamically
    time:  { enabled:true,  reply:null },
    ping:  { enabled:true,  reply:'Pong !' },
    uptime:{ enabled:true,  reply:null },
    who:   { enabled:true,  reply:null },
  },
};

const botStartTime = Date.now();
const floodTracker = new Map(); // nick → {count,since}

// ── User class ─────────────────────────────────────────────────
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
    this.warnCount   = 0;
  }
  hostmask() { return `${this.nick}!${this.username||'user'}@${SERVER_NAME}`; }
  isAdmin()  { return RANK_NUM[this.globalRank] >= RANK_NUM.admin; }
  statusDur() {
    const s = Math.floor((Date.now()-this.statusSince)/1000);
    if (s<60) return s+'s'; if (s<3600) return Math.floor(s/60)+'min';
    return Math.floor(s/3600)+'h'+Math.floor((s%3600)/60)+'min';
  }
}

// ── Channel class ──────────────────────────────────────────────
class Channel {
  constructor(name, ownerNick=null) {
    this.name       = name;
    this.topic      = '';
    this.users      = new Map();   // nick → rank
    this.password   = null;
    this.inviteOnly = false;
    this.invites    = new Set();
    this.bans       = new Set();
    this.muted      = new Map();   // nick → until timestamp (0=permanent)
    this.maxUsers   = 0;
    this.moderated  = false;
    this.created    = Date.now();
    this.description= '';
    if (ownerNick) this.users.set(ownerNick, 'owner');
  }
  rankOf(n)  { return this.users.get(n) || 'user'; }
  rankNum(n) { return RANK_NUM[this.rankOf(n)] || 0; }
  isOp(n)    { return RANK_NUM[this.rankOf(n)] >= RANK_NUM.op; }
  isHalfOp(n){ return RANK_NUM[this.rankOf(n)] >= RANK_NUM.halfop; }
  isMuted(n) {
    if (!this.muted.has(n)) return false;
    const until = this.muted.get(n);
    if (until !== 0 && Date.now() > until) { this.muted.delete(n); return false; }
    return true;
  }
  broadcast(msg, exclude=null) {
    for (const nick of this.users.keys()) {
      if (nick === exclude || nick === BOT_NICK) continue;
      const u = users.get(nick); if (u) u.send(msg);
    }
  }
  broadcastAll(msg) { this.broadcast(msg, null); }
  userList() {
    return [...this.users.entries()]
      .sort(([,a],[,b]) => RANK_NUM[b]-RANK_NUM[a])
      .map(([n,r]) => (RANK_PFX[r]||'')+n).join(' ');
  }
  toJSON() {
    return {
      name:       this.name,
      topic:      this.topic,
      description:this.description,
      users:      this.users.size,
      secured:    !!this.password,
      inviteOnly: this.inviteOnly,
      moderated:  this.moderated,
      maxUsers:   this.maxUsers,
      created:    this.created,
    };
  }
}

// ── Helpers ────────────────────────────────────────────────────
function validNick(n) { return /^[a-zA-Z_\-\[\]\\^{}|`][a-zA-Z0-9_\-\[\]\\^{}|`]{0,29}$/.test(n); }
function validChan(n) { return /^#[^\s,:]{1,49}$/.test(n); }
function hashPass(p)  { return crypto.createHash('sha256').update(p+'ircnet_v3').digest('hex'); }
function nowStr()     { return new Date().toLocaleTimeString('fr-FR'); }

function num(code, nick, ...params) {
  const last = params.pop(), mid = params.join(' ');
  return { raw: `:${SERVER_NAME} ${code} ${nick||'*'} ${mid?mid+' ':''}:${last}` };
}
function msg(prefix, cmd, ...params) {
  const last = params.pop();
  return { raw: `:${prefix} ${cmd}${params.length?' '+params.join(' '):''} :${last}` };
}
function srvNotice(user, text) {
  user.send({ raw: `:${SERVER_NAME} NOTICE ${user.nick||'*'} :${text}` });
}

// broadcast a server-side system event to all clients in a channel
function chanEvent(ch, obj) {
  for (const nick of ch.users.keys()) {
    if (nick === BOT_NICK) continue;
    const u = users.get(nick); if (u) u.send(obj);
  }
}

// push full channel list update to all connected clients
function broadcastChanList() {
  const list = [...channels.values()].map(c => c.toJSON());
  const obj  = { type:'chanlist_update', channels:list };
  for (const u of users.values()) if (u.registered) u.send(obj);
}

// ── Status broadcast ───────────────────────────────────────────
function broadcastStatus(user) {
  const obj = { type:'status_update', nick:user.nick, status:user.status, statusMsg:user.statusMsg, statusSince:user.statusSince };
  user.send(obj);
  const seen = new Set([user.nick]);
  for (const cname of user.channels) {
    const ch = channels.get(cname); if (!ch) continue;
    for (const n of ch.users.keys()) {
      if (seen.has(n)) continue; seen.add(n);
      const u = users.get(n); if (u) u.send(obj);
    }
  }
}

// ══════════════════════════════════════════════════════════════
// BOT
// ══════════════════════════════════════════════════════════════
function botSay(chanName, text) {
  const ch = channels.get(chanName); if (!ch) return;
  const obj = { raw: `:${BOT_NICK}!bot@${SERVER_NAME} PRIVMSG ${chanName} :${text}` };
  ch.broadcast(obj);
}

function botSayPrivate(targetNick, text) {
  const u = users.get(targetNick); if (!u) return;
  u.send({ raw: `:${BOT_NICK}!bot@${SERVER_NAME} PRIVMSG ${targetNick} :${text}` });
}

function botJoin(chanName) {
  const ch = channels.get(chanName); if (!ch) return;
  ch.users.set(BOT_NICK, 'op');
  ch.broadcast(msg(`${BOT_NICK}!bot@${SERVER_NAME}`,'JOIN',chanName));
}

function botWelcome(user, chanName) {
  if (!botConfig.welcome.enabled) return;
  setTimeout(() => {
    botSayPrivate(user.nick, `👋 ${botConfig.welcome.message}`);
    const ch = channels.get(chanName); if (!ch) return;
    botSay(chanName, `👋 Bienvenue ${user.nick} sur ${chanName} !`);
  }, botConfig.welcome.delay);
}

// Flood detection
function checkFlood(nick, chanName) {
  if (!botConfig.floodProtect.enabled) return false;
  const now = Date.now();
  let ft = floodTracker.get(nick) || { count:0, since:now };
  if (now - ft.since > botConfig.floodProtect.windowSeconds*1000) { ft = {count:0,since:now}; }
  ft.count++;
  floodTracker.set(nick, ft);
  if (ft.count > botConfig.floodProtect.maxMessages) {
    floodTracker.set(nick, {count:0,since:now});
    const u = users.get(nick); const ch = channels.get(chanName);
    if (!u || !ch) return true;
    const action = botConfig.floodProtect.action;
    if (action === 'warn') {
      botSay(chanName, `⚠️ ${nick} : flood détecté, calmez-vous !`);
    } else if (action === 'mute') {
      const until = Date.now() + botConfig.floodProtect.muteSeconds*1000;
      ch.muted.set(nick, until);
      botSay(chanName, `🔇 ${nick} rendu muet ${botConfig.floodProtect.muteSeconds}s (flood)`);
      setTimeout(()=>{ ch.muted.delete(nick); botSay(chanName,`🔊 ${nick} peut à nouveau parler.`); }, botConfig.floodProtect.muteSeconds*1000);
    } else if (action === 'kick') {
      handleKICK({nick:BOT_NICK,globalRank:'admin',isAdmin:()=>true,hostmask:()=>BOT_NICK+'!bot@'+SERVER_NAME,channels:new Set()}, chanName, nick, 'Flood');
    }
    return true;
  }
  return false;
}

// Word filter
function checkFilter(user, chanName, text) {
  if (!botConfig.filters.enabled) return false;
  const lower = text.toLowerCase();
  const hit = botConfig.filters.words.find(w => lower.includes(w));
  if (!hit) return false;
  const ch = channels.get(chanName); if (!ch) return false;
  const action = botConfig.filters.action;
  user.warnCount = (user.warnCount||0)+1;
  if (action === 'warn' || action === 'delete') {
    botSay(chanName, `⚠️ ${user.nick} : ${botConfig.filters.warnMsg} (avertissement #${user.warnCount})`);
  }
  if (action === 'mute') {
    const until = Date.now() + botConfig.filters.muteSeconds*1000;
    ch.muted.set(user.nick, until);
    botSay(chanName, `🔇 ${user.nick} rendu muet ${botConfig.filters.muteSeconds}s (filtre)`);
    setTimeout(()=>{ ch.muted.delete(user.nick); }, botConfig.filters.muteSeconds*1000);
  }
  if (user.warnCount >= 3 && action !== 'mute') {
    handleKICK({nick:BOT_NICK,globalRank:'admin',isAdmin:()=>true,hostmask:()=>BOT_NICK+'!bot@'+SERVER_NAME,channels:new Set()},
      chanName, user.nick, `Expulsé : langage inapproprié répété (${user.warnCount} avertissements)`);
    user.warnCount = 0;
  }
  return action === 'delete';
}

// Bot commands
function handleBotCommand(user, chanName, text) {
  if (!botConfig.enabled) return;
  const t = text.trim();
  if (!t.startsWith(botConfig.prefix)) return;
  const parts = t.slice(botConfig.prefix.length).split(' ');
  const cmd = parts[0].toLowerCase();
  const args = parts.slice(1);

  switch(cmd) {
    case 'help':
      botSay(chanName, botConfig.commands.help.reply);
      break;
    case 'rules':
      botSay(chanName, '📋 Règles du serveur :');
      botConfig.rules.forEach((r,i) => botSay(chanName, `  ${i+1}. ${r}`));
      break;
    case 'info':
      botSay(chanName, botConfig.commands.info.reply);
      break;
    case 'stats':
      botSay(chanName, `📊 Serveur : ${users.size} connectés | ${channels.size} canaux | Bot actif : ${botConfig.enabled?'✅':'❌'}`);
      break;
    case 'time':
      botSay(chanName, `🕐 Heure serveur : ${nowStr()}`);
      break;
    case 'ping':
      botSay(chanName, `🏓 Pong ! (${user.nick})`);
      break;
    case 'uptime': {
      const s = Math.floor((Date.now()-botStartTime)/1000);
      const h = Math.floor(s/3600), m = Math.floor((s%3600)/60), sec = s%60;
      botSay(chanName, `⏱️ Uptime : ${h}h ${m}min ${sec}s`);
      break;
    }
    case 'who':
      if (channels.has(chanName)) {
        const ch = channels.get(chanName);
        const list = [...ch.users.keys()].filter(n=>n!==BOT_NICK).join(', ');
        botSay(chanName, `👥 Membres de ${chanName} (${ch.users.size-1}) : ${list}`);
      }
      break;
    // Admin bot commands
    case 'botset':
      if (!user.isAdmin() && channels.get(chanName)?.rankNum(user.nick) < RANK_NUM.op) {
        botSay(chanName, `❌ Réservé aux opérateurs.`); break;
      }
      handleBotSet(user, chanName, args);
      break;
    case 'filter':
      if (!user.isAdmin()) { botSay(chanName,'❌ Réservé aux admins.'); break; }
      if (args[0]==='add' && args[1]) {
        botConfig.filters.words.push(args[1].toLowerCase());
        botSay(chanName, `✅ Mot "${args[1]}" ajouté au filtre.`);
      } else if (args[0]==='remove' && args[1]) {
        botConfig.filters.words = botConfig.filters.words.filter(w=>w!==args[1].toLowerCase());
        botSay(chanName, `✅ Mot "${args[1]}" retiré du filtre.`);
      } else if (args[0]==='list') {
        botSay(chanName, `🔍 Mots filtrés : ${botConfig.filters.words.join(', ')||'(aucun)'}`);
      } else {
        botSay(chanName, 'Usage : !filter add mot | !filter remove mot | !filter list');
      }
      break;
    default:
      // Unknown bot command — silently ignore
      break;
  }
}

function handleBotSet(user, chanName, args) {
  if (!args[0]) { botSay(chanName,'Usage : !botset welcome on|off | !botset flood on|off | !botset filter on|off | !botset prefix <char> | !botset rule add|remove <texte>'); return; }
  switch(args[0]) {
    case 'welcome':
      botConfig.welcome.enabled = args[1]==='on';
      botSay(chanName, `✅ Messages de bienvenue : ${botConfig.welcome.enabled?'activés':'désactivés'}`);
      break;
    case 'flood':
      botConfig.floodProtect.enabled = args[1]==='on';
      botSay(chanName, `✅ Protection flood : ${botConfig.floodProtect.enabled?'activée':'désactivée'}`);
      break;
    case 'filter':
      botConfig.filters.enabled = args[1]==='on';
      botSay(chanName, `✅ Filtre de mots : ${botConfig.filters.enabled?'activé':'désactivé'}`);
      break;
    case 'prefix':
      if (args[1]) { botConfig.prefix = args[1]; botSay(chanName, `✅ Préfixe bot : ${args[1]}`); }
      break;
    case 'rule':
      if (args[1]==='add') {
        const r = args.slice(2).join(' ');
        botConfig.rules.push(r);
        botSay(chanName, `✅ Règle ajoutée : "${r}"`);
      } else if (args[1]==='remove') {
        const idx = parseInt(args[2])-1;
        if (idx>=0 && idx<botConfig.rules.length) {
          const removed = botConfig.rules.splice(idx,1)[0];
          botSay(chanName, `✅ Règle supprimée : "${removed}"`);
        }
      } else if (args[1]==='list') {
        botConfig.rules.forEach((r,i)=>botSay(chanName,`${i+1}. ${r}`));
      }
      break;
    case 'welcome_msg':
      botConfig.welcome.message = args.slice(1).join(' ');
      botSay(chanName, `✅ Message de bienvenue mis à jour.`);
      break;
    default:
      botSay(chanName, `Paramètre inconnu : ${args[0]}`);
  }
  // Broadcast updated bot config to admins
  for (const u of users.values()) {
    if (u.isAdmin()) u.send({ type:'bot_config', config:getBotPublicConfig() });
  }
}

function getBotPublicConfig() {
  return {
    enabled:      botConfig.enabled,
    nick:         botConfig.nick,
    prefix:       botConfig.prefix,
    welcome:      { ...botConfig.welcome },
    rules:        [...botConfig.rules],
    filters:      { enabled:botConfig.filters.enabled, words:[...botConfig.filters.words], action:botConfig.filters.action, muteSeconds:botConfig.filters.muteSeconds },
    floodProtect: { ...botConfig.floodProtect },
  };
}

// ══════════════════════════════════════════════════════════════
// IRC HANDLERS
// ══════════════════════════════════════════════════════════════

function handleNICK(user, newNick) {
  if (!newNick || !validNick(newNick)) { user.send(num('432',user.nick,'Erroneous nickname')); return; }
  if (users.has(newNick)) { user.send(num('433',user.nick,newNick,'Nickname is already in use')); return; }
  const old = user.nick;
  if (old) users.delete(old);
  user.nick = newNick;
  users.set(newNick, user);
  if (old) {
    const m = msg(user.hostmask(),'NICK',newNick);
    user.send(m);
    for (const cname of user.channels) {
      const ch = channels.get(cname); if (!ch) continue;
      const rank = ch.users.get(old)||'user';
      ch.users.delete(old); ch.users.set(newNick, rank);
      ch.broadcast(m, newNick);
      ch.broadcast({ type:'nick_change', old, neo:newNick, channel:cname }, newNick);
    }
  }
  tryRegister(user);
}

function handleUSER(user, username, realname) {
  if (user.registered) { user.send(num('462',user.nick,'Already registered')); return; }
  user.username = username||'user'; user.realname = realname||username||'user';
  tryRegister(user);
}

function tryRegister(user) {
  if (user.registered || !user.nick || !user.username) return;
  const b = gbans.get(user.nick);
  if (b && (!b.until || b.until > Date.now())) {
    user.send({ raw: `:${SERVER_NAME} ERROR :Banned: ${b.reason}` }); return;
  }
  user.registered = true;
  user.send(num('001',user.nick,`Welcome to ${SERVER_NAME}, ${user.nick}!`));
  user.send(num('002',user.nick,`Your host is ${SERVER_NAME} running IRCnet/3.0`));
  user.send(num('375',user.nick,`- ${SERVER_NAME} Message of the Day -`));
  user.send(num('372',user.nick,`- IRCnet v3 | Bot: ${BOT_NICK} | Rangs: ~&@%+`));
  user.send(num('372',user.nick,`- Commandes bot : !help !rules !stats !time`));
  user.send(num('376',user.nick,'End of MOTD'));
  // Send channel list + bot config
  user.send({ type:'chanlist_update', channels:[...channels.values()].map(c=>c.toJSON()) });
  user.send({ type:'server_info', serverName:SERVER_NAME, botNick:BOT_NICK, botPrefix:botConfig.prefix });
  if (user.isAdmin()) user.send({ type:'bot_config', config:getBotPublicConfig() });
  // Welcome PM from bot
  if (botConfig.welcome.enabled) {
    setTimeout(()=> botSayPrivate(user.nick, `👋 ${botConfig.welcome.message}`), 1500);
  }
}

function handleJOIN(user, chanName, password='') {
  if (!user.registered || !chanName) return;
  if (!validChan(chanName)) { user.send(num('403',user.nick,chanName,'No such channel')); return; }
  if (user.channels.has(chanName)) {
    // Already in channel — just switch focus on client side
    user.send({ type:'chan_focus', channel:chanName }); return;
  }

  let ch = channels.get(chanName);
  const isNew = !ch;

  if (isNew) {
    ch = new Channel(chanName, user.nick);
    channels.set(chanName, ch);
    botJoin(chanName);
  } else {
    // Access checks
    if (ch.bans.has(user.nick))             { user.send(num('474',user.nick,chanName,'You are banned')); return; }
    if (ch.inviteOnly && !ch.invites.has(user.nick) && !user.isAdmin()) { user.send(num('473',user.nick,chanName,'Invite only (+i)')); return; }
    if (ch.password && hashPass(password) !== ch.password) { user.send(num('475',user.nick,chanName,'Bad channel key (+k)')); return; }
    if (ch.maxUsers > 0 && ch.users.size >= ch.maxUsers) { user.send(num('471',user.nick,chanName,'Channel is full (+l)')); return; }
    if (!isNew) ch.users.set(user.nick, 'user');
  }

  user.channels.add(chanName);
  ch.invites.delete(user.nick);

  // Send JOIN to everyone in channel
  const joinMsg = msg(user.hostmask(),'JOIN',chanName);
  user.send(joinMsg);
  ch.broadcast(joinMsg, user.nick);

  // Notify others with extended info
  ch.broadcast({ type:'user_joined', channel:chanName, nick:user.nick,
    rank:ch.rankOf(user.nick), status:user.status, statusMsg:user.statusMsg }, user.nick);

  // Send topic + names to the joining user
  if (ch.topic) user.send(num('332',user.nick,chanName,ch.topic));
  else          user.send(num('331',user.nick,chanName,'No topic is set'));
  user.send(num('353',user.nick,'=',chanName,ch.userList()));
  user.send(num('366',user.nick,chanName,'End of /NAMES'));

  // Extended channel info
  user.send({ type:'chan_info', channel:chanName, secured:!!ch.password,
    inviteOnly:ch.inviteOnly, maxUsers:ch.maxUsers, moderated:ch.moderated,
    description:ch.description, isNew });

  // Send member statuses
  const ms = {};
  for (const [nick] of ch.users) {
    const u = nick===BOT_NICK ? null : users.get(nick);
    if (u) ms[nick] = { rank:ch.rankOf(nick), status:u.status, statusMsg:u.statusMsg, statusSince:u.statusSince };
  }
  user.send({ type:'member_statuses', channel:chanName, members:ms });

  // AutoOp
  if (botConfig.autoOp.enabled && botConfig.autoOp.nicks.includes(user.nick)) {
    ch.users.set(user.nick,'op');
    ch.broadcast(msg(`${BOT_NICK}!bot@${SERVER_NAME}`,'MODE',chanName,'+o',user.nick));
    ch.broadcast({ type:'rank_change', channel:chanName, actor:BOT_NICK, target:user.nick, rank:'op' });
  }

  // Broadcast updated channel list
  broadcastChanList();

  // Bot welcome in channel
  botWelcome(user, chanName);

  // Auto-op if new channel — re-confirm owner rank
  if (isNew) {
    setTimeout(()=>{
      botSay(chanName, `Canal ${chanName} créé. Vous êtes Fondateur (~). Tapez !help pour l'aide.`);
    }, 800);
  }
}

function handlePART(user, chanName, reason='Leaving') {
  const ch = channels.get(chanName);
  if (!ch || !ch.users.has(user.nick)) { user.send(num('442',user.nick,chanName,"You're not on that channel")); return; }
  const m = msg(user.hostmask(),'PART',chanName,reason);
  user.send(m); ch.broadcast(m, user.nick);
  ch.broadcast({ type:'user_left', channel:chanName, nick:user.nick, reason }, user.nick);
  ch.users.delete(user.nick); user.channels.delete(chanName);
  if (ch.users.size <= 1) { ch.users.delete(BOT_NICK); channels.delete(chanName); } // only bot left
  broadcastChanList();
}

function handlePRIVMSG(user, target, text) {
  if (!user.registered || !text) return;
  if (target === BOT_NICK) {
    // Direct message to bot
    handleBotCommand(user, null, text);
    return;
  }
  if (target.startsWith('#')) {
    const ch = channels.get(target);
    if (!ch) { user.send(num('403',user.nick,target,'No such channel')); return; }
    if (!ch.users.has(user.nick)) { user.send(num('404',user.nick,target,'Cannot send to channel')); return; }
    if (ch.isMuted(user.nick) && !ch.isOp(user.nick)) { srvNotice(user,'Vous êtes muet sur ce canal.'); return; }
    if (ch.moderated && RANK_NUM[ch.rankOf(user.nick)] < RANK_NUM.voice && !user.isAdmin()) { srvNotice(user,'Canal modéré — vous avez besoin du rang +voix.'); return; }

    // Bot commands
    if (text.startsWith(botConfig.prefix)) { handleBotCommand(user, target, text); return; }

    // Word filter
    if (checkFilter(user, target, text)) return; // filtered/deleted

    // Flood check
    if (checkFlood(user.nick, target)) return;

    ch.broadcast(msg(user.hostmask(),'PRIVMSG',target,text), user.nick);
  } else {
    const dest = users.get(target);
    if (!dest) { user.send(num('401',user.nick,target,'No such nick')); return; }
    dest.send(msg(user.hostmask(),'PRIVMSG',target,text));
    if (dest.away) user.send(msg(SERVER_NAME,'301',user.nick,target,dest.awayMsg));
  }
}

function handleSTATUS(user, code, statusMsg='') {
  if (!STATUSES[code]) { srvNotice(user,'Statuts : '+Object.keys(STATUSES).join(' ')); return; }
  user.status = code; user.statusMsg = statusMsg; user.statusSince = Date.now();
  user.away = code !== 'online'; user.awayMsg = statusMsg || STATUSES[code];
  broadcastStatus(user);
  srvNotice(user,`Statut → ${STATUSES[code]}${statusMsg?' ('+statusMsg+')':''}`);
}

function handleTOPIC(user, chanName, topic) {
  const ch = channels.get(chanName);
  if (!ch) { user.send(num('403',user.nick,chanName,'No such channel')); return; }
  if (topic === undefined) {
    user.send(ch.topic ? num('332',user.nick,chanName,ch.topic) : num('331',user.nick,chanName,'No topic'));
    return;
  }
  if (!ch.isHalfOp(user.nick) && !user.isAdmin()) { user.send(num('482',user.nick,chanName,"You're not an operator")); return; }
  ch.topic = topic;
  const m = msg(user.hostmask(),'TOPIC',chanName,topic);
  ch.broadcastAll(m);
  chanEvent(ch, { type:'topic_change', channel:chanName, topic, actor:user.nick });
  broadcastChanList();
}

function handleMODE(user, chanName, modeStr, ...args) {
  const ch = channels.get(chanName); if (!ch) return;
  if (!modeStr) {
    const ml = (ch.password?'k':'')+(ch.inviteOnly?'i':'')+(ch.moderated?'m':'')+(ch.maxUsers?'l '+ch.maxUsers:'');
    user.send(num('324',user.nick,chanName,'+'+(ml||''))); return;
  }
  if (!ch.isOp(user.nick) && !user.isAdmin()) { user.send(num('482',user.nick,chanName,"Not an operator")); return; }
  let sign='+', ai=0;
  for (const c of modeStr) {
    if (c==='+'||c==='-'){sign=c;continue;}
    const arg=args[ai];
    switch(c) {
      case 'i': ch.inviteOnly=sign==='+'; break;
      case 'm': ch.moderated=sign==='+'; break;
      case 'k': if(sign==='+'&&arg){ch.password=hashPass(arg);ai++;}else ch.password=null; break;
      case 'l': if(sign==='+'&&arg){ch.maxUsers=parseInt(arg)||0;ai++;}else ch.maxUsers=0; break;
      case 'b':
        if(arg){sign==='+'?ch.bans.add(arg):ch.bans.delete(arg);ai++;}
        else{for(const b of ch.bans)user.send(num('367',user.nick,chanName,b));user.send(num('368',user.nick,chanName,'End of ban list'));}
        break;
      case 'o': if(arg){setRank(user,ch,arg,sign==='+'?'op':'user');ai++;} break;
      case 'h': if(arg){setRank(user,ch,arg,sign==='+'?'halfop':'user');ai++;} break;
      case 'v': if(arg){setRank(user,ch,arg,sign==='+'?'voice':'user');ai++;} break;
      case 'a': if(arg&&(ch.rankOf(user.nick)==='owner'||user.isAdmin())){setRank(user,ch,arg,sign==='+'?'admin':'user');ai++;} break;
      case 'q': if(arg&&(user.isAdmin()||ch.rankOf(user.nick)==='owner')){setRank(user,ch,arg,sign==='+'?'owner':'user');ai++;} break;
    }
  }
  ch.broadcast(msg(user.hostmask(),'MODE',chanName,modeStr,...args.slice(0,ai)));
  chanEvent(ch,{ type:'mode_change', channel:chanName, actor:user.nick, mode:modeStr, args:args.slice(0,ai) });
  broadcastChanList();
}

function setRank(actor, ch, targetNick, newRank) {
  if (!ch.users.has(targetNick)) return;
  const actorRankNum = typeof actor.globalRank==='string' ? RANK_NUM[actor.globalRank] : 5;
  if (RANK_NUM[ch.rankOf(actor.nick||'')]<=RANK_NUM[ch.rankOf(targetNick)] && actorRankNum<RANK_NUM.admin) return;
  ch.users.set(targetNick, newRank);
  chanEvent(ch,{ type:'rank_change', channel:ch.name, actor:actor.nick||BOT_NICK, target:targetNick, rank:newRank });
  const tu = users.get(targetNick);
  if (tu) tu.send({ type:'your_rank', channel:ch.name, rank:newRank });
}

function handleKICK(user, chanName, target, reason='Expulsé') {
  const ch = channels.get(chanName); if (!ch) return;
  const isBot = user.nick===BOT_NICK;
  if (!isBot && !ch.isHalfOp(user.nick) && !user.isAdmin()) { user.send(num('482',user.nick,chanName,'Not operator')); return; }
  if (!ch.users.has(target)) return;
  if (!isBot && RANK_NUM[ch.rankOf(target)]>=RANK_NUM[ch.rankOf(user.nick||'')] && !user.isAdmin()) {
    srvNotice(user,'Impossible : rang insuffisant'); return;
  }
  const kickMsg = msg(user.hostmask(),'KICK',chanName,target,reason);
  ch.broadcastAll(kickMsg);
  chanEvent(ch,{ type:'user_kicked', channel:chanName, actor:user.nick||BOT_NICK, target, reason });
  const tu = users.get(target);
  if (tu) tu.channels.delete(chanName);
  ch.users.delete(target);
  if (ch.users.size<=1) { ch.users.delete(BOT_NICK); channels.delete(chanName); broadcastChanList(); }
}

function handleMUTE(user, chanName, target, durationSec=0) {
  const ch = channels.get(chanName); if (!ch) return;
  if (!ch.isHalfOp(user.nick) && !user.isAdmin()) { user.send(num('482',user.nick,chanName,'Not operator')); return; }
  const until = durationSec>0 ? Date.now()+durationSec*1000 : 0;
  ch.muted.set(target, until);
  chanEvent(ch,{ type:'user_muted', channel:chanName, actor:user.nick, target, duration:durationSec });
  if (durationSec>0) setTimeout(()=>{ ch.muted.delete(target); chanEvent(ch,{type:'user_unmuted',channel:chanName,target}); }, durationSec*1000);
}

function handleUNMUTE(user, chanName, target) {
  const ch = channels.get(chanName); if (!ch) return;
  if (!ch.isHalfOp(user.nick) && !user.isAdmin()) { user.send(num('482',user.nick,chanName,'Not operator')); return; }
  ch.muted.delete(target);
  chanEvent(ch,{ type:'user_unmuted', channel:chanName, actor:user.nick, target });
}

function handleMOVE(user, chanName, target, dest, reason='Déplacé') {
  const ch = channels.get(chanName); if (!ch) return;
  if (!ch.isOp(user.nick) && !user.isAdmin()) { user.send(num('482',user.nick,chanName,'Not operator')); return; }
  const tu = users.get(target); if (!tu) return;
  srvNotice(tu,`${user.nick} vous déplace vers ${dest} : ${reason}`);
  tu.send({ type:'forced_move', from:chanName, to:dest, reason, actor:user.nick });
  handlePART(tu,chanName,`Déplacé vers ${dest}`);
  handleJOIN(tu,dest);
}

function handleGBAN(user, target, minutes=0, reason='Banned') {
  if (!user.isAdmin()) { srvNotice(user,'Réservé aux admins'); return; }
  const until = minutes>0 ? Date.now()+minutes*60000 : 0;
  gbans.set(target,{ until, reason, by:user.nick, at:Date.now() });
  const tu = users.get(target);
  if (tu) {
    tu.send({ raw:`:${SERVER_NAME} ERROR :You are banned: ${reason}` });
    for (const c of [...tu.channels]) {
      const ch=channels.get(c);
      if (ch) { ch.users.delete(target); chanEvent(ch,{type:'user_banned',target,reason}); }
    }
    tu.channels.clear(); users.delete(target);
  }
  srvNotice(user,`${target} banni ${minutes?'pour '+minutes+'min':'définitivement'}: ${reason}`);
}

function handleGUNBAN(user, target) {
  if (!user.isAdmin()) { srvNotice(user,'Réservé aux admins'); return; }
  gbans.delete(target); srvNotice(user,`${target} débanni`);
}

function handleINVITE(user, target, chanName) {
  const ch = channels.get(chanName); if (!ch) return;
  if (!ch.isHalfOp(user.nick) && !user.isAdmin()) { user.send(num('482',user.nick,chanName,'Not operator')); return; }
  const tu = users.get(target); if (!tu) { user.send(num('401',user.nick,target,'No such nick')); return; }
  ch.invites.add(target);
  tu.send(msg(user.hostmask(),'INVITE',target,chanName));
  tu.send({ type:'invite', channel:chanName, from:user.nick });
  user.send(num('341',user.nick,target,chanName));
}

function handleOPER(user, pass) {
  if (hashPass(pass) === hashPass(ADMIN_PASS)) {
    user.globalRank = 'admin';
    user.send(num('381',user.nick,'You are now an IRC operator'));
    user.send({ type:'rank_update', rank:'admin' });
    user.send({ type:'bot_config', config:getBotPublicConfig() });
    srvNotice(user,'Bienvenue, Admin ! Commandes: /gban /gunban /move + !botset dans le bot');
  } else user.send(num('464',user.nick,'Password incorrect'));
}

function handleWHOIS(user, target) {
  const tu = users.get(target);
  if (!tu) { user.send(num('401',user.nick,target,'No such nick')); user.send(num('318',user.nick,target,'End of /WHOIS')); return; }
  user.send(num('311',user.nick,tu.nick,tu.username||'user',SERVER_NAME,tu.realname||tu.nick));
  user.send(num('312',user.nick,tu.nick,SERVER_NAME,'IRCnet/3.0'));
  if (tu.away) user.send(num('301',user.nick,tu.nick,tu.awayMsg));
  user.send({ type:'whois_ext', target:tu.nick, globalRank:tu.globalRank,
    status:tu.status, statusMsg:tu.statusMsg, statusLabel:STATUSES[tu.status]||tu.status,
    duration:tu.statusDur(),
    raw:`:${SERVER_NAME} NOTICE ${user.nick} :${tu.nick}: ${STATUSES[tu.status]||''} (${tu.statusDur()})${tu.statusMsg?' — '+tu.statusMsg:''}` });
  if (RANK_NUM[tu.globalRank]>=RANK_NUM.admin) user.send(num('313',user.nick,tu.nick,'is an IRC operator'));
  user.send(num('318',user.nick,target,'End of /WHOIS'));
}

// ── Admin channel management ────────────────────────────────────
function handleCHANADMIN(user, action, chanName, ...params) {
  if (!user.isAdmin() && !isChanOwner(user, chanName)) {
    srvNotice(user,'Réservé aux Fondateurs et Admins'); return;
  }
  switch(action) {
    case 'delete': {
      const ch = channels.get(chanName); if (!ch) { srvNotice(user,'Canal introuvable'); return; }
      // Kick everyone
      for (const nick of [...ch.users.keys()]) {
        if (nick===BOT_NICK) continue;
        const tu = users.get(nick);
        if (tu) { srvNotice(tu,`Le canal ${chanName} a été supprimé par ${user.nick}.`); tu.channels.delete(chanName); }
      }
      chanEvent(ch,{ type:'chan_deleted', channel:chanName, actor:user.nick });
      channels.delete(chanName);
      broadcastChanList();
      srvNotice(user,`Canal ${chanName} supprimé.`);
      break;
    }
    case 'rename': {
      const newName = params[0];
      if (!newName || !validChan(newName)) { srvNotice(user,'Nouveau nom invalide'); return; }
      const ch = channels.get(chanName); if (!ch) { srvNotice(user,'Canal introuvable'); return; }
      if (channels.has(newName)) { srvNotice(user,'Ce nom est déjà pris'); return; }
      ch.name = newName;
      channels.delete(chanName); channels.set(newName, ch);
      for (const nick of ch.users.keys()) {
        const tu = users.get(nick); if (tu) {
          tu.channels.delete(chanName); tu.channels.add(newName);
          srvNotice(tu,`Le canal ${chanName} a été renommé en ${newName}.`);
        }
      }
      chanEvent(ch,{ type:'chan_renamed', old:chanName, neo:newName, actor:user.nick });
      broadcastChanList();
      srvNotice(user,`Canal renommé en ${newName}.`);
      break;
    }
    case 'desc': {
      const ch = channels.get(chanName); if (!ch) { srvNotice(user,'Canal introuvable'); return; }
      ch.description = params.join(' ');
      chanEvent(ch,{ type:'chan_desc', channel:chanName, description:ch.description });
      broadcastChanList();
      srvNotice(user,'Description mise à jour.');
      break;
    }
    case 'settopic': {
      const ch = channels.get(chanName); if (!ch) { srvNotice(user,'Canal introuvable'); return; }
      ch.topic = params.join(' ');
      ch.broadcastAll(msg(user.hostmask(),'TOPIC',chanName,ch.topic));
      chanEvent(ch,{ type:'topic_change', channel:chanName, topic:ch.topic, actor:user.nick });
      broadcastChanList();
      break;
    }
    case 'setpass': {
      const ch = channels.get(chanName); if (!ch) { srvNotice(user,'Canal introuvable'); return; }
      ch.password = params[0] ? hashPass(params[0]) : null;
      srvNotice(user, params[0]?`Mot de passe de ${chanName} mis à jour.`:`Mot de passe de ${chanName} supprimé.`);
      broadcastChanList();
      break;
    }
    default: srvNotice(user,'Actions : delete | rename <newname> | desc <text> | settopic <text> | setpass [pass]');
  }
}

function isChanOwner(user, chanName) {
  const ch = channels.get(chanName);
  return ch && ch.rankOf(user.nick) === 'owner';
}

function handleQUIT(user, reason='Quit') {
  if (!user?.nick) return;
  const m = msg(user.hostmask(),'QUIT',reason);
  for (const cname of user.channels) {
    const ch = channels.get(cname); if (!ch) continue;
    ch.broadcast(m, user.nick);
    chanEvent(ch,{ type:'user_left', channel:cname, nick:user.nick, reason });
    ch.users.delete(user.nick);
    if (ch.users.size<=1) { ch.users.delete(BOT_NICK); channels.delete(cname); }
  }
  users.delete(user.nick);
  broadcastChanList();
}

function handleLIST(user) {
  user.send(num('321',user.nick,'Channel','Users Name'));
  for (const [name,ch] of channels) {
    const flags = (ch.password?'k':'')+(ch.inviteOnly?'i':'')+(ch.moderated?'m':'');
    user.send(num('322',user.nick,`${name}${flags?' [+'+flags+']':''}`,String(ch.users.size),ch.topic||''));
  }
  user.send(num('323',user.nick,'End of /LIST'));
}

// ── Dispatch ───────────────────────────────────────────────────
function dispatch(user, line) {
  line = line.trim(); if (!line) return;
  if (line.startsWith(':')) { line = line.slice(line.indexOf(' ')+1).trim(); }
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
    case 'AWAY':    if(params[0]){user.away=true;user.awayMsg=params[0];user.send(num('306',user.nick,'You are away'));}
                    else{user.away=false;user.awayMsg='';user.send(num('305',user.nick,'You are back'));} break;
    case 'LIST':    handleLIST(user); break;
    case 'WHOIS':   handleWHOIS(user,params[0]); break;
    case 'NAMES': { const ch=channels.get(params[0]); if(ch){user.send(num('353',user.nick,'=',params[0],ch.userList()));user.send(num('366',user.nick,params[0],'End of /NAMES'));} break; }
    case 'WHO': {
      const ch=channels.get(params[0]);
      if(ch) for(const[nick,rank] of ch.users){ const u=users.get(nick); if(u) user.send(num('352',user.nick,params[0],u.username||'u',SERVER_NAME,SERVER_NAME,nick,(u.away?'G':'H')+(RANK_PFX[rank]||''),`0 ${u.realname||nick}`)); }
      user.send(num('315',user.nick,params[0]||'*','End of /WHO')); break;
    }
    case 'PING': user.send({ raw:`:${SERVER_NAME} PONG ${SERVER_NAME} :${params[0]||SERVER_NAME}` }); break;
    case 'PONG': break;
    case 'QUIT': handleQUIT(user,params[0]); break;
    case 'CAP':  break;
    // Extended
    case 'STATUS':   handleSTATUS(user,params[0],params.slice(1).join(' ')||''); break;
    case 'MOVE':     handleMOVE(user,params[0],params[1],params[2],params.slice(3).join(' ')); break;
    case 'MUTE':     handleMUTE(user,params[0],params[1],parseInt(params[2])||0); break;
    case 'UNMUTE':   handleUNMUTE(user,params[0],params[1]); break;
    case 'GBAN':     handleGBAN(user,params[0],parseInt(params[1])||0,params.slice(2).join(' ')||'Banned'); break;
    case 'GUNBAN':   handleGUNBAN(user,params[0]); break;
    case 'CHANADMIN':handleCHANADMIN(user,params[0],params[1],...params.slice(2)); break;
    default: user.send(num('421',user.nick,cmd,'Unknown command'));
  }
}

// ── WebSocket (natif) ──────────────────────────────────────────
function wsHandshake(req, socket) {
  const acc = crypto.createHash('sha1')
    .update(req.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+acc+'\r\n\r\n');
}
function parseWsFrame(buf) {
  if(buf.length<2)return null;
  const op=buf[0]&0x0f, masked=(buf[1]&0x80)!==0;
  let len=buf[1]&0x7f, off=2;
  if(len===126){len=buf.readUInt16BE(2);off=4;}else if(len===127){len=Number(buf.readBigUInt64BE(2));off=10;}
  if(buf.length<off+(masked?4:0)+len)return null;
  let payload;
  if(masked){const mask=buf.slice(off,off+4);off+=4;payload=Buffer.allocUnsafe(len);for(let i=0;i<len;i++)payload[i]=buf[off+i]^mask[i%4];}
  else payload=buf.slice(off,off+len);
  return{op,payload,total:off+len};
}

// ══════════════════════════════════════════════════════════════
// DCC / XDCC — IRCnet v3 extension
// ══════════════════════════════════════════════════════════════
const xdccPacks  = new Map(); // packId → XDCCPack
const dccOffers  = new Map(); // token  → offer
let   xdccNextId = 1;

class XDCCPack {
  constructor(owner, filename, size, mimetype, data, description) {
    this.id          = String(xdccNextId++);
    this.owner       = owner;
    this.filename    = filename;
    this.size        = size;
    this.mimetype    = mimetype;
    this.data        = data;       // Buffer
    this.description = description || '';
    this.gets        = 0;
    this.added       = Date.now();
  }
  toPublic() {
    return { id:this.id, owner:this.owner, filename:this.filename,
      size:this.size, mimetype:this.mimetype, description:this.description,
      gets:this.gets, added:this.added };
  }
}

function makeDCCToken() { return crypto.randomBytes(12).toString('hex'); }
setInterval(()=>{
  const now=Date.now();
  for(const[t,o] of dccOffers) if(now-o.created>5*60*1000) dccOffers.delete(t);
}, 60000);

function broadcastXDCC() {
  const packs=[...xdccPacks.values()].map(p=>p.toPublic());
  for(const u of users.values()) if(u.registered) u.send({type:'xdcc_list',packs});
}

function xdccNoticeUser(nick, text) {
  const u=users.get(nick); if(u) u.send({raw:`:XDCCbot!xdcc@${SERVER_NAME} NOTICE ${nick} :${text}`});
}

function xdccPackList(nick) {
  xdccNoticeUser(nick,'═══ Liste des packs XDCC ═══');
  if(!xdccPacks.size){ xdccNoticeUser(nick,'Aucun pack disponible.'); return; }
  for(const p of xdccPacks.values()){
    const sz=p.size<1024*1024?(p.size/1024).toFixed(1)+'KB':(p.size/1024/1024).toFixed(2)+'MB';
    xdccNoticeUser(nick,`#${p.id.padStart(3)} [${sz.padStart(8)}] ${p.filename}  ↳ ${p.description||'—'}  (${p.gets} DL)`);
  }
  xdccNoticeUser(nick,'═══ Fin de liste — !xdcc get #N pour télécharger ═══');
  const u=users.get(nick); if(u) u.send({type:'xdcc_list',packs:[...xdccPacks.values()].map(p=>p.toPublic())});
}

function xdccGet(nick, packId) {
  const u=users.get(nick); if(!u) return;
  const pack=xdccPacks.get(String(packId));
  if(!pack){ xdccNoticeUser(nick,`Pack #${packId} introuvable.`); return; }
  pack.gets++;
  const token=makeDCCToken();
  dccOffers.set(token,{token,type:'xdcc',from:'XDCCbot',to:nick,
    filename:pack.filename,size:pack.size,mimetype:pack.mimetype,data:pack.data,created:Date.now()});
  xdccNoticeUser(nick,`Envoi DCC: ${pack.filename} (${(pack.size/1024).toFixed(1)}KB) — acceptez le transfert.`);
  u.send({type:'dcc_offer',token,from:'XDCCbot',filename:pack.filename,size:pack.size,mimetype:pack.mimetype,packId:pack.id});
}

function xdccAdd(user, filename, size, mimetype, data, description) {
  const pack=new XDCCPack(user.nick,filename,size,mimetype,data,description);
  xdccPacks.set(pack.id,pack);
  srvNotice(user,`Pack XDCC #${pack.id} ajouté : ${filename}`);
  broadcastXDCC();
  return pack;
}

function xdccRemove(user, packId) {
  const pack=xdccPacks.get(String(packId));
  if(!pack){srvNotice(user,`Pack #${packId} introuvable.`);return;}
  if(pack.owner!==user.nick&&!user.isAdmin()){srvNotice(user,'Vous ne pouvez supprimer que vos propres packs.');return;}
  xdccPacks.delete(String(packId));
  srvNotice(user,`Pack #${packId} supprimé.`);
  broadcastXDCC();
}

function dccSendToUser(user, targetNick, filename, size, mimetype, b64data) {
  const dest=users.get(targetNick);
  if(!dest){srvNotice(user,`Utilisateur ${targetNick} introuvable.`);return;}
  const data=Buffer.from(b64data,'base64');
  const token=makeDCCToken();
  dccOffers.set(token,{token,type:'dcc',from:user.nick,to:targetNick,filename,size,mimetype,data,created:Date.now()});
  dest.send({type:'dcc_offer',token,from:user.nick,filename,size,mimetype});
  if(dest.type==='irc') dest.send({raw:`:${user.hostmask()} PRIVMSG ${targetNick} :\x01DCC SEND ${filename} 0 0 ${size}\x01`});
  srvNotice(user,`Offre DCC envoyée à ${targetNick} : ${filename}`);
}

function handleCTCP(user, target, ctcpText) {
  if(ctcpText==='VERSION') user.send({raw:`:${SERVER_NAME} NOTICE ${user.nick} :\x01VERSION IRCnet/3.0\x01`});
  if(ctcpText==='PING') user.send({raw:`:${SERVER_NAME} NOTICE ${user.nick} :\x01PING\x01`});
  if(ctcpText.startsWith('DCC SEND ')){
    const m=ctcpText.slice(9).match(/^(\S+)\s+\d+\s+\d+\s+(\d+)/);
    if(m){const token=makeDCCToken();dccOffers.set(token,{token,type:'dcc',from:user.nick,to:target,filename:m[1],size:parseInt(m[2]),mimetype:'application/octet-stream',data:null,created:Date.now()});const d=users.get(target);if(d)d.send({type:'dcc_offer',token,from:user.nick,filename:m[1],size:parseInt(m[2]),mimetype:'application/octet-stream'});}
  }
  if(ctcpText==='XDCC LIST') xdccPackList(user.nick);
  if(ctcpText.startsWith('XDCC SEND ')||ctcpText.startsWith('XDCC GET ')){
    const id=ctcpText.split(' ')[2]?.replace('#','');
    if(id) xdccGet(user.nick,id);
  }
}

// ── HTTP + static files ────────────────────────────────────────
function getFile(relPath) {
  const bases=[path.join(__dirname,'public'),path.join(process.cwd(),'public'),process.cwd()];
  for(const b of bases){try{return fs.readFileSync(path.join(b,relPath));}catch{}}
  return null;
}

const MIME_MAP={'.html':'text/html; charset=utf-8','.css':'text/css','.js':'text/javascript','.ico':'image/x-icon','.png':'image/png','.svg':'image/svg+xml'};
function corsHdr(res){res.setHeader('Access-Control-Allow-Origin','*');res.setHeader('Access-Control-Allow-Headers','Content-Type');}

const httpServer = http.createServer((req, res) => {
  const rawUrl = req.url;
  const url    = rawUrl.split('?')[0];
  const qs     = new URLSearchParams(rawUrl.includes('?')?rawUrl.slice(rawUrl.indexOf('?')+1):'');

  if(url==='/health'){corsHdr(res);res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({status:'ok',users:users.size,channels:channels.size,bot:botConfig.enabled,xdccPacks:xdccPacks.size}));return;}
  if(url==='/api/channels'){corsHdr(res);res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify([...channels.values()].map(c=>c.toJSON())));return;}
  if(url==='/api/bot'){corsHdr(res);res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(getBotPublicConfig()));return;}
  if(url==='/api/xdcc'){corsHdr(res);res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify([...xdccPacks.values()].map(p=>p.toPublic())));return;}

  // DCC file download
  if(url==='/dcc/download'){
    const token=qs.get('token');
    const offer=token?dccOffers.get(token):null;
    if(!offer||!offer.data){res.writeHead(404);res.end('Offer not found');return;}
    corsHdr(res);
    res.writeHead(200,{'Content-Type':offer.mimetype||'application/octet-stream','Content-Disposition':`attachment; filename="${encodeURIComponent(offer.filename)}"`, 'Content-Length':offer.data.length});
    res.end(offer.data);
    dccOffers.delete(token);
    return;
  }

  // DCC/XDCC file upload (POST JSON with base64 data)
  if(url==='/dcc/upload'&&req.method==='POST'){
    let body='';
    req.on('data',d=>{body+=d.toString();if(body.length>60*1024*1024)req.destroy();});
    req.on('end',()=>{
      try{
        const j=JSON.parse(body);
        const user=users.get(j.nick);
        if(!user){res.writeHead(403);res.end('Not connected');return;}
        if(j.target){
          dccSendToUser(user,j.target,j.filename,j.size||0,j.mimetype||'application/octet-stream',j.data);
        } else {
          xdccAdd(user,j.filename,j.size||0,j.mimetype||'application/octet-stream',Buffer.from(j.data,'base64'),j.description||'');
        }
        corsHdr(res);res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({ok:true}));
      }catch(e){res.writeHead(400);res.end('Bad request: '+e.message);}
    });
    return;
  }

  // Static files
  const filePath=(url==='/'||url==='/index.html')?'index.html':url.slice(1);
  const data=getFile(filePath);
  if(data){res.writeHead(200,{'Content-Type':MIME_MAP[path.extname(filePath)]||'text/plain'});res.end(data);}
  else{res.writeHead(404);res.end('Not found');}
});

// ── WebSocket ──────────────────────────────────────────────────
httpServer.on('upgrade',(req,socket)=>{
  if(req.url!=='/ws'){socket.destroy();return;}
  wsHandshake(req,socket);
  let buf=Buffer.alloc(0);
  const user=new User(crypto.randomUUID().slice(0,8),obj=>{try{socket.write(buildWsFrame(JSON.stringify(obj)));}catch{}},'ws');

  socket.on('data',chunk=>{
    buf=Buffer.concat([buf,chunk]);
    while(true){
      const f=parseWsFrame(buf);if(!f)break;buf=buf.slice(f.total);
      if(f.op===0x8){socket.write(Buffer.from([0x88,0]));socket.destroy();break;}
      if(f.op!==0x1&&f.op!==0x0) continue;
      const t=f.payload.toString('utf8');
      try{
        const o=JSON.parse(t);
        // DCC/XDCC extended events
        if(o.type==='dcc_send'){
          dccSendToUser(user,o.target,o.filename,o.size,o.mimetype,o.data);
        } else if(o.type==='dcc_accept'){
          const offer=dccOffers.get(o.token);
          if(offer) user.send({type:'dcc_download',token:o.token,filename:offer.filename,mimetype:offer.mimetype});
          else user.send({type:'dcc_error',message:'Offre expirée.'});
        } else if(o.type==='dcc_reject'){
          const offer=dccOffers.get(o.token);
          if(offer){dccOffers.delete(o.token);const s=users.get(offer.from);if(s)srvNotice(s,`${user.nick} a refusé votre envoi DCC (${offer.filename}).`);}
        } else if(o.type==='xdcc_add'){
          xdccAdd(user,o.filename,o.size,o.mimetype,Buffer.from(o.data,'base64'),o.description||'');
        } else if(o.type==='xdcc_remove'){
          xdccRemove(user,o.packId);
        } else if(o.type==='xdcc_get'){
          xdccGet(user.nick,o.packId);
        } else if(o.type==='xdcc_list'){
          user.send({type:'xdcc_list',packs:[...xdccPacks.values()].map(p=>p.toPublic())});
        } else {
          // IRC dispatch — check CTCP
          const raw=o.raw||t;
          const ctcpM=raw.match(/^(?::\S+ )?PRIVMSG (\S+) :\x01(.+)\x01$/i);
          if(ctcpM){handleCTCP(user,ctcpM[1],ctcpM[2]);}
          else{dispatch(user,raw);}
        }
      }catch{dispatch(user,t);}
    }
  });
  socket.on('close',()=>handleQUIT(user,'Connection closed'));
  socket.on('error',()=>handleQUIT(user,'Socket error'));
});

httpServer.listen(PORT,()=>{
  console.log(`\n  IRCnet v3 + DCC/XDCC`);
  console.log(`  ├─ Web  : http://localhost:${PORT}`);
  console.log(`  ├─ WS   : ws://localhost:${PORT}/ws`);
  console.log(`  ├─ IRC  : irc://localhost:${IRC_PORT}`);
  console.log(`  ├─ Bot  : ${BOT_NICK}`);
  console.log(`  ├─ DCC  : POST /dcc/upload  GET /dcc/download?token=`);
  console.log(`  ├─ XDCC : GET /api/xdcc`);
  console.log(`  └─ OPER : ${ADMIN_PASS}\n`);
});

// ── TCP IRC server ─────────────────────────────────────────────
const ircServer = net.createServer(socket=>{
  const user=new User(crypto.randomUUID().slice(0,8),o=>{try{socket.write((o.raw||'')+'\r\n');}catch{}},'irc');
  try{socket.write(`:${SERVER_NAME} NOTICE Auth :*** IRCnet v3 + DCC/XDCC\r\n`);}catch{}
  let buf='';
  socket.on('data',d=>{
    buf+=d.toString('utf8');
    const lines=buf.split('\r\n');buf=lines.pop();
    for(const l of lines){
      if(!l.trim()) continue;
      const ctcpM=l.match(/^(?::\S+ )?PRIVMSG (\S+) :\x01(.+)\x01$/i);
      if(ctcpM) handleCTCP(user,ctcpM[1],ctcpM[2]);
      else {
        // XDCC text commands: /msg XDCCbot xdcc list
        const xm=l.match(/^(?::\S+ )?PRIVMSG XDCCbot :xdcc (\w+)(?: #?(\S+))?/i);
        if(xm){const sub=xm[1].toLowerCase();if(sub==='list')xdccPackList(user.nick);else xdccGet(user.nick,xm[2]||'1');}
        else dispatch(user,l);
      }
    }
  });
  socket.on('close',()=>handleQUIT(user,'Connection closed'));
  socket.on('error',()=>handleQUIT(user,'Socket error'));
  const pi=setInterval(()=>{try{socket.write(`:${SERVER_NAME} PING :${SERVER_NAME}\r\n`);}catch{clearInterval(pi);}},90000);
  socket.on('close',()=>clearInterval(pi));
});
ircServer.listen(IRC_PORT,()=>console.log(`  TCP IRC :${IRC_PORT}`));

process.on('SIGTERM',()=>{httpServer.close();ircServer.close();process.exit(0);});
process.on('SIGINT', ()=>{httpServer.close();ircServer.close();process.exit(0);});
