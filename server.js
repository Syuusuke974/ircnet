/**
 * IRCnet v3 — Serveur IRC WebSocket
 * Compatible Render.com, Railway, Fly.io
 * Zéro dépendance externe
 */
'use strict';

const http   = require('http');
const net    = require('net');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const PORT        = parseInt(process.env.PORT) || 3000;
const SERVER_NAME = (process.env.SERVER_NAME || 'irc.localnet').replace(/^https?:\/\//,'').replace(/\/$/,'');
const ADMIN_PASS  = process.env.ADMIN_PASS || 'admin1234';
const BOT_NICK    = process.env.BOT_NICK   || 'IRCbot';
const IRC_ENABLED = process.env.IRC_TCP !== 'false'; // disable TCP IRC on Render

console.log(`[boot] PORT=${PORT} SERVER_NAME=${SERVER_NAME} NODE=${process.version}`);

// ── Rank system ───────────────────────────────────────────────
const RANK_NUM = { owner:5, admin:4, op:3, halfop:2, voice:1, user:0 };
const RANK_PFX = { owner:'~', admin:'&', op:'@', halfop:'%', voice:'+', user:'' };
const STATUSES = {
  online:'En ligne', away:'Absent', busy:'Occupé', wc:'Toilettes',
  eating:'Mange', gaming:'Joue', sleep:'Dort', coding:'Code',
  brb:'Revient vite', custom:'Perso'
};

// ── State ─────────────────────────────────────────────────────
const users    = new Map();
const channels = new Map();
const gbans    = new Map();

// ── Bot config ────────────────────────────────────────────────
const botConfig = {
  enabled: true, nick: BOT_NICK, prefix: '!',
  welcome: { enabled:true, message:`Bienvenue sur ${SERVER_NAME} ! Tapez !help.`, delay:1500 },
  rules: ['Soyez respectueux.','Pas de spam.','Pas de contenu illégal.'],
  filters: { enabled:true, words:['putain','merde','connard','salope','fdp'], action:'warn', warnMsg:'Langage inapproprié.', muteSeconds:30 },
  autoOp: { enabled:false, nicks:[] },
  floodProtect: { enabled:true, maxMessages:5, windowSeconds:3, action:'mute', muteSeconds:60 },
  commands: { help:{enabled:true}, rules:{enabled:true}, info:{enabled:true}, stats:{enabled:true}, time:{enabled:true}, ping:{enabled:true}, uptime:{enabled:true}, who:{enabled:true} },
};
const botStart = Date.now();
const floodTracker = new Map();

// ── Classes ───────────────────────────────────────────────────
class User {
  constructor(id, send, type='ws') {
    this.id=id; this.nick=null; this.username=null; this.realname=null;
    this.type=type; this.send=send; this.channels=new Set();
    this.status='online'; this.statusMsg=''; this.statusSince=Date.now();
    this.away=false; this.awayMsg=''; this.registered=false;
    this.globalRank='user'; this.connectedAt=Date.now(); this.warnCount=0;
  }
  hostmask(){ return `${this.nick}!${this.username||'user'}@${SERVER_NAME}`; }
  isAdmin(){ return RANK_NUM[this.globalRank]>=RANK_NUM.admin; }
  statusDur(){ const s=Math.floor((Date.now()-this.statusSince)/1000); if(s<60)return s+'s'; if(s<3600)return Math.floor(s/60)+'min'; return Math.floor(s/3600)+'h'+Math.floor((s%3600)/60)+'min'; }
}

class Channel {
  constructor(name, ownerNick=null) {
    this.name=name; this.topic=''; this.users=new Map();
    this.password=null; this.inviteOnly=false; this.invites=new Set();
    this.bans=new Set(); this.muted=new Map(); this.maxUsers=0;
    this.moderated=false; this.created=Date.now(); this.description='';
    if(ownerNick) this.users.set(ownerNick,'owner');
  }
  rankOf(n){ return this.users.get(n)||'user'; }
  rankNum(n){ return RANK_NUM[this.rankOf(n)]||0; }
  isOp(n){ return RANK_NUM[this.rankOf(n)]>=RANK_NUM.op; }
  isHalfOp(n){ return RANK_NUM[this.rankOf(n)]>=RANK_NUM.halfop; }
  isMuted(n){ if(!this.muted.has(n))return false; const u=this.muted.get(n); if(u!==0&&Date.now()>u){this.muted.delete(n);return false;} return true; }
  broadcast(msg,exclude=null){ for(const nick of this.users.keys()){if(nick===exclude||nick===BOT_NICK)continue;const u=users.get(nick);if(u)u.send(msg);} }
  broadcastAll(msg){ this.broadcast(msg,null); }
  userList(){ return [...this.users.entries()].sort(([,a],[,b])=>RANK_NUM[b]-RANK_NUM[a]).map(([n,r])=>(RANK_PFX[r]||'')+n).join(' '); }
  toJSON(){ return {name:this.name,topic:this.topic,description:this.description,users:this.users.size,secured:!!this.password,inviteOnly:this.inviteOnly,moderated:this.moderated,maxUsers:this.maxUsers,created:this.created}; }
}

// ── Helpers ───────────────────────────────────────────────────
function validNick(n){ return n&&/^[a-zA-Z_\-\[\]\\^{}|`][a-zA-Z0-9_\-\[\]\\^{}|`]{0,29}$/.test(n); }
function validChan(n){ return n&&n.startsWith('#')&&n.length>=2&&n.length<=50&&!/[\s,:\x00\x07]/.test(n); }
function hashPass(p){ return crypto.createHash('sha256').update(p+'ircnet_v3').digest('hex'); }
function nowStr(){ return new Date().toLocaleTimeString('fr-FR'); }
function num(code,nick,...params){ const last=params.pop(),mid=params.join(' '); return {raw:`:${SERVER_NAME} ${code} ${nick||'*'} ${mid?mid+' ':''}:${last}`}; }
function msg(prefix,cmd,...params){ const last=params.pop(); return {raw:`:${prefix} ${cmd}${params.length?' '+params.join(' '):''} :${last}`}; }
function srvNotice(user,text){ user.send({raw:`:${SERVER_NAME} NOTICE ${user.nick||'*'} :${text}`}); }
function chanEvent(ch,obj){ for(const nick of ch.users.keys()){if(nick===BOT_NICK)continue;const u=users.get(nick);if(u)u.send(obj);} }
function broadcastChanList(){ const list=[...channels.values()].map(c=>c.toJSON()); for(const u of users.values())if(u.registered)u.send({type:'chanlist_update',channels:list}); }
function broadcastStatus(user){ const obj={type:'status_update',nick:user.nick,status:user.status,statusMsg:user.statusMsg,statusSince:user.statusSince}; user.send(obj); const seen=new Set([user.nick]); for(const cname of user.channels){const ch=channels.get(cname);if(!ch)continue;for(const n of ch.users.keys()){if(seen.has(n))continue;seen.add(n);const u=users.get(n);if(u)u.send(obj);}} }

// ── Bot ───────────────────────────────────────────────────────
function botSay(ch,text){ const c=channels.get(ch);if(!c)return;c.broadcast({raw:`:${BOT_NICK}!bot@${SERVER_NAME} PRIVMSG ${ch} :${text}`}); }
function botSayPM(nick,text){ const u=users.get(nick);if(!u)return;u.send({raw:`:${BOT_NICK}!bot@${SERVER_NAME} PRIVMSG ${nick} :${text}`}); }
function botJoin(ch){ const c=channels.get(ch);if(!c)return;c.users.set(BOT_NICK,'op');c.broadcast(msg(`${BOT_NICK}!bot@${SERVER_NAME}`,'JOIN',ch)); }
function botWelcome(user,ch){ if(!botConfig.welcome.enabled)return;setTimeout(()=>{botSayPM(user.nick,`👋 ${botConfig.welcome.message}`);botSay(ch,`👋 Bienvenue ${user.nick} !`);},botConfig.welcome.delay); }

function checkFlood(nick,ch){ if(!botConfig.floodProtect.enabled)return false;const now=Date.now();let ft=floodTracker.get(nick)||{count:0,since:now};if(now-ft.since>botConfig.floodProtect.windowSeconds*1000)ft={count:0,since:now};ft.count++;floodTracker.set(nick,ft);if(ft.count>botConfig.floodProtect.maxMessages){floodTracker.set(nick,{count:0,since:now});const u=users.get(nick);const c=channels.get(ch);if(!u||!c)return true;const a=botConfig.floodProtect.action;if(a==='warn'){botSay(ch,`⚠️ ${nick} : flood détecté !`);}else if(a==='mute'){const until=Date.now()+botConfig.floodProtect.muteSeconds*1000;c.muted.set(nick,until);botSay(ch,`🔇 ${nick} muet ${botConfig.floodProtect.muteSeconds}s (flood)`);setTimeout(()=>{c.muted.delete(nick);botSay(ch,`🔊 ${nick} peut à nouveau parler.`);},botConfig.floodProtect.muteSeconds*1000);}else if(a==='kick'){handleKICK({nick:BOT_NICK,globalRank:'admin',isAdmin:()=>true,hostmask:()=>BOT_NICK+'!bot@'+SERVER_NAME,channels:new Set()},ch,nick,'Flood');}return true;}return false; }

function checkFilter(user,ch,text){ if(!botConfig.filters.enabled)return false;const lower=text.toLowerCase();const hit=botConfig.filters.words.find(w=>lower.includes(w));if(!hit)return false;const c=channels.get(ch);if(!c)return false;const a=botConfig.filters.action;user.warnCount=(user.warnCount||0)+1;if(a==='warn'||a==='delete'){botSay(ch,`⚠️ ${user.nick} : ${botConfig.filters.warnMsg} (#${user.warnCount})`);}if(a==='mute'){const until=Date.now()+botConfig.filters.muteSeconds*1000;c.muted.set(user.nick,until);botSay(ch,`🔇 ${user.nick} muet ${botConfig.filters.muteSeconds}s (filtre)`);setTimeout(()=>{c.muted.delete(user.nick);},botConfig.filters.muteSeconds*1000);}if(user.warnCount>=3&&a!=='mute'){handleKICK({nick:BOT_NICK,globalRank:'admin',isAdmin:()=>true,hostmask:()=>BOT_NICK+'!bot@'+SERVER_NAME,channels:new Set()},ch,user.nick,`Langage inapproprié (${user.warnCount}x)`);user.warnCount=0;}return a==='delete'; }

function handleBotCmd(user,ch,text){ if(!botConfig.enabled)return;const t=text.trim();if(!t.startsWith(botConfig.prefix))return;const parts=t.slice(botConfig.prefix.length).split(' ');const cmd=parts[0].toLowerCase();const args=parts.slice(1);
switch(cmd){
  case 'help': botSay(ch,'Commandes : !help !rules !info !stats !time !ping !uptime !who !botset !filter'); break;
  case 'rules': botSay(ch,'📋 Règles :'); botConfig.rules.forEach((r,i)=>botSay(ch,`  ${i+1}. ${r}`)); break;
  case 'info': botSay(ch,`ℹ️ Serveur IRC ${SERVER_NAME} — IRCnet v3`); break;
  case 'stats': botSay(ch,`📊 ${users.size} connectés | ${channels.size} canaux | Bot: ${botConfig.enabled?'✅':'❌'}`); break;
  case 'time': botSay(ch,`🕐 ${nowStr()}`); break;
  case 'ping': botSay(ch,`🏓 Pong ! (${user.nick})`); break;
  case 'uptime': { const s=Math.floor((Date.now()-botStart)/1000); botSay(ch,`⏱️ ${Math.floor(s/3600)}h ${Math.floor((s%3600)/60)}min ${s%60}s`); break; }
  case 'who': { const c=channels.get(ch); if(c){const l=[...c.users.keys()].filter(n=>n!==BOT_NICK).join(', ');botSay(ch,`👥 ${l}`);} break; }
  case 'botset': handleBotSet(user,ch,args); break;
  case 'filter':
    if(!user.isAdmin()&&channels.get(ch)?.rankNum(user.nick)<RANK_NUM.op){botSay(ch,'❌ Réservé aux opérateurs.');break;}
    if(args[0]==='add'&&args[1]){botConfig.filters.words.push(args[1].toLowerCase());botSay(ch,`✅ Mot "${args[1]}" ajouté.`);}
    else if(args[0]==='remove'&&args[1]){botConfig.filters.words=botConfig.filters.words.filter(w=>w!==args[1].toLowerCase());botSay(ch,`✅ Mot "${args[1]}" retiré.`);}
    else if(args[0]==='list'){botSay(ch,`🔍 Filtrés : ${botConfig.filters.words.join(', ')||'(aucun)'}`);}
    else botSay(ch,'Usage : !filter add|remove|list');
    break;
  default: break;
}
}

function handleBotSet(user,ch,args){
  if(!user.isAdmin()&&channels.get(ch)?.rankNum(user.nick)<RANK_NUM.op){botSay(ch,'❌ Réservé aux opérateurs.');return;}
  switch(args[0]){
    case 'welcome': botConfig.welcome.enabled=args[1]==='on'; botSay(ch,`✅ Bienvenue: ${botConfig.welcome.enabled?'on':'off'}`); break;
    case 'flood': botConfig.floodProtect.enabled=args[1]==='on'; botSay(ch,`✅ Flood: ${botConfig.floodProtect.enabled?'on':'off'}`); break;
    case 'filter': botConfig.filters.enabled=args[1]==='on'; botSay(ch,`✅ Filtre: ${botConfig.filters.enabled?'on':'off'}`); break;
    case 'prefix': if(args[1]){botConfig.prefix=args[1];botSay(ch,`✅ Préfixe: ${args[1]}`);} break;
    case 'rule':
      if(args[1]==='add'){const r=args.slice(2).join(' ');botConfig.rules.push(r);botSay(ch,`✅ Règle ajoutée.`);}
      else if(args[1]==='remove'){const i=parseInt(args[2])-1;if(i>=0&&i<botConfig.rules.length){botConfig.rules.splice(i,1);botSay(ch,`✅ Règle supprimée.`);}}
      else if(args[1]==='list'){botConfig.rules.forEach((r,i)=>botSay(ch,`${i+1}. ${r}`));}
      break;
    case 'welcome_msg': botConfig.welcome.message=args.slice(1).join(' '); botSay(ch,'✅ Message mis à jour.'); break;
    default: botSay(ch,'Params: welcome|flood|filter|prefix|rule|welcome_msg');
  }
  for(const u of users.values())if(u.isAdmin())u.send({type:'bot_config',config:getBotCfg()});
}

function getBotCfg(){ return {enabled:botConfig.enabled,nick:botConfig.nick,prefix:botConfig.prefix,welcome:{...botConfig.welcome},rules:[...botConfig.rules],filters:{enabled:botConfig.filters.enabled,words:[...botConfig.filters.words],action:botConfig.filters.action,muteSeconds:botConfig.filters.muteSeconds},floodProtect:{...botConfig.floodProtect}}; }

// ── IRC Handlers ──────────────────────────────────────────────
function handleNICK(user,newNick){ if(!newNick||!validNick(newNick)){user.send(num('432',user.nick,'Erroneous nickname'));return;} if(users.has(newNick)){user.send(num('433',user.nick,newNick,'Nickname is already in use'));return;} const old=user.nick;if(old)users.delete(old);user.nick=newNick;users.set(newNick,user);if(old){const m=msg(user.hostmask(),'NICK',newNick);user.send(m);for(const cn of user.channels){const c=channels.get(cn);if(!c)continue;const rk=c.users.get(old)||'user';c.users.delete(old);c.users.set(newNick,rk);c.broadcast(m,newNick);c.broadcast({type:'nick_change',old,neo:newNick,channel:cn},newNick);}}tryRegister(user); }

function handleUSER(user,username,realname){ if(user.registered){user.send(num('462',user.nick,'Already registered'));return;} user.username=username||'user';user.realname=realname||username||'user';tryRegister(user); }

function tryRegister(user){ if(user.registered||!user.nick||!user.username)return;const b=gbans.get(user.nick);if(b&&(!b.until||b.until>Date.now())){user.send({raw:`:${SERVER_NAME} ERROR :Banned: ${b.reason}`});return;} user.registered=true;user.send(num('001',user.nick,`Welcome to ${SERVER_NAME}, ${user.nick}!`));user.send(num('002',user.nick,`Your host is ${SERVER_NAME}`));user.send(num('375',user.nick,`- ${SERVER_NAME} Message of the Day -`));user.send(num('372',user.nick,`- IRCnet v3 | Bot: ${BOT_NICK} | Prefix: ${botConfig.prefix}`));user.send(num('376',user.nick,'End of MOTD'));user.send({type:'chanlist_update',channels:[...channels.values()].map(c=>c.toJSON())});user.send({type:'server_info',serverName:SERVER_NAME,botNick:BOT_NICK,botPrefix:botConfig.prefix});if(user.isAdmin())user.send({type:'bot_config',config:getBotCfg()});if(botConfig.welcome.enabled)setTimeout(()=>botSayPM(user.nick,`👋 ${botConfig.welcome.message}`),1500); }

function handleJOIN(user,chanName,password=''){ if(!user.registered||!chanName)return;if(!validChan(chanName)){user.send(num('403',user.nick,chanName,'No such channel'));return;} if(user.channels.has(chanName)){user.send({type:'chan_focus',channel:chanName});return;} let ch=channels.get(chanName);const isNew=!ch;if(isNew){ch=new Channel(chanName,user.nick);channels.set(chanName,ch);botJoin(chanName);}else{if(ch.bans.has(user.nick)){user.send(num('474',user.nick,chanName,'You are banned'));return;}if(ch.inviteOnly&&!ch.invites.has(user.nick)&&!user.isAdmin()){user.send(num('473',user.nick,chanName,'Invite only'));return;}if(ch.password&&hashPass(password)!==ch.password){user.send(num('475',user.nick,chanName,'Bad channel key'));return;}if(ch.maxUsers>0&&ch.users.size>=ch.maxUsers){user.send(num('471',user.nick,chanName,'Channel is full'));return;}ch.users.set(user.nick,'user');}
user.channels.add(chanName);ch.invites.delete(user.nick);const joinMsg=msg(user.hostmask(),'JOIN',chanName);user.send(joinMsg);ch.broadcast(joinMsg,user.nick);ch.broadcast({type:'user_joined',channel:chanName,nick:user.nick,rank:ch.rankOf(user.nick),status:user.status,statusMsg:user.statusMsg},user.nick);if(ch.topic)user.send(num('332',user.nick,chanName,ch.topic));else user.send(num('331',user.nick,chanName,'No topic'));user.send(num('353',user.nick,'=',chanName,ch.userList()));user.send(num('366',user.nick,chanName,'End of /NAMES'));user.send({type:'chan_info',channel:chanName,secured:!!ch.password,inviteOnly:ch.inviteOnly,maxUsers:ch.maxUsers,moderated:ch.moderated,description:ch.description,isNew});const ms={};for(const[nick]of ch.users){const u=nick===BOT_NICK?null:users.get(nick);if(u)ms[nick]={rank:ch.rankOf(nick),status:u.status,statusMsg:u.statusMsg,statusSince:u.statusSince};}user.send({type:'member_statuses',channel:chanName,members:ms});if(botConfig.autoOp.enabled&&botConfig.autoOp.nicks.includes(user.nick)){ch.users.set(user.nick,'op');ch.broadcast(msg(`${BOT_NICK}!bot@${SERVER_NAME}`,'MODE',chanName,'+o',user.nick));ch.broadcast({type:'rank_change',channel:chanName,actor:BOT_NICK,target:user.nick,rank:'op'});}broadcastChanList();botWelcome(user,chanName);if(isNew)setTimeout(()=>botSay(chanName,`Canal ${chanName} créé. Vous êtes Fondateur (~). Tapez !help.`),800); }

function handlePART(user,chanName,reason='Leaving'){ const ch=channels.get(chanName);if(!ch||!ch.users.has(user.nick)){user.send(num('442',user.nick,chanName,"You're not on that channel"));return;} const m=msg(user.hostmask(),'PART',chanName,reason);user.send(m);ch.broadcast(m,user.nick);ch.broadcast({type:'user_left',channel:chanName,nick:user.nick,reason},user.nick);ch.users.delete(user.nick);user.channels.delete(chanName);if(ch.users.size<=1){ch.users.delete(BOT_NICK);channels.delete(chanName);}broadcastChanList(); }

function handlePRIVMSG(user,target,text){ if(!user.registered||!text)return;if(target===BOT_NICK){handleBotCmd(user,null,text);return;} if(target.startsWith('#')){const ch=channels.get(target);if(!ch){user.send(num('403',user.nick,target,'No such channel'));return;}if(!ch.users.has(user.nick)){user.send(num('404',user.nick,target,'Cannot send'));return;}if(ch.isMuted(user.nick)&&!ch.isOp(user.nick)){srvNotice(user,'Vous êtes muet.');return;}if(ch.moderated&&RANK_NUM[ch.rankOf(user.nick)]<RANK_NUM.voice&&!user.isAdmin()){srvNotice(user,'Canal modéré.');return;}if(text.startsWith(botConfig.prefix)){handleBotCmd(user,target,text);return;}if(checkFilter(user,target,text))return;if(checkFlood(user.nick,target))return;ch.broadcast(msg(user.hostmask(),'PRIVMSG',target,text),user.nick);}else{const dest=users.get(target);if(!dest){user.send(num('401',user.nick,target,'No such nick'));return;}dest.send(msg(user.hostmask(),'PRIVMSG',target,text));if(dest.away)user.send(msg(SERVER_NAME,'301',user.nick,target,dest.awayMsg));} }

function handleSTATUS(user,code,statusMsg){ if(!STATUSES[code]){srvNotice(user,'Statuts : '+Object.keys(STATUSES).join(' '));return;}user.status=code;user.statusMsg=statusMsg;user.statusSince=Date.now();user.away=code!=='online';user.awayMsg=statusMsg||STATUSES[code];broadcastStatus(user);srvNotice(user,`Statut → ${STATUSES[code]}`); }

function handleTOPIC(user,chanName,topic){ const ch=channels.get(chanName);if(!ch){user.send(num('403',user.nick,chanName,'No such channel'));return;}if(topic===undefined){user.send(ch.topic?num('332',user.nick,chanName,ch.topic):num('331',user.nick,chanName,'No topic'));return;}if(!ch.isHalfOp(user.nick)&&!user.isAdmin()){user.send(num('482',user.nick,chanName,"Not operator"));return;}ch.topic=topic;const m=msg(user.hostmask(),'TOPIC',chanName,topic);ch.broadcastAll(m);chanEvent(ch,{type:'topic_change',channel:chanName,topic,actor:user.nick});broadcastChanList(); }

function handleMODE(user,chanName,modeStr,...args){ const ch=channels.get(chanName);if(!ch)return;if(!modeStr){user.send(num('324',user.nick,chanName,'+'+(ch.password?'k':'')+(ch.inviteOnly?'i':'')+(ch.moderated?'m':'')));return;}if(!ch.isOp(user.nick)&&!user.isAdmin()){user.send(num('482',user.nick,chanName,"Not operator"));return;}let sign='+',ai=0;for(const c of modeStr){if(c==='+'||c==='-'){sign=c;continue;}const arg=args[ai];switch(c){case 'i':ch.inviteOnly=sign==='+';break;case 'm':ch.moderated=sign==='+';break;case 'k':if(sign==='+'&&arg){ch.password=hashPass(arg);ai++;}else ch.password=null;break;case 'l':if(sign==='+'&&arg){ch.maxUsers=parseInt(arg)||0;ai++;}else ch.maxUsers=0;break;case 'b':if(arg){sign==='+'?ch.bans.add(arg):ch.bans.delete(arg);ai++;}else{for(const b of ch.bans)user.send(num('367',user.nick,chanName,b));user.send(num('368',user.nick,chanName,'End of ban list'));}break;case 'o':if(arg){setRank(user,ch,arg,sign==='+'?'op':'user');ai++;}break;case 'h':if(arg){setRank(user,ch,arg,sign==='+'?'halfop':'user');ai++;}break;case 'v':if(arg){setRank(user,ch,arg,sign==='+'?'voice':'user');ai++;}break;case 'a':if(arg&&(ch.rankOf(user.nick)==='owner'||user.isAdmin())){setRank(user,ch,arg,sign==='+'?'admin':'user');ai++;}break;case 'q':if(arg&&(user.isAdmin()||ch.rankOf(user.nick)==='owner')){setRank(user,ch,arg,sign==='+'?'owner':'user');ai++;}break;}}ch.broadcast(msg(user.hostmask(),'MODE',chanName,modeStr,...args.slice(0,ai)));chanEvent(ch,{type:'mode_change',channel:chanName,actor:user.nick,mode:modeStr,args:args.slice(0,ai)});broadcastChanList(); }

function setRank(actor,ch,targetNick,newRank){ if(!ch.users.has(targetNick))return;const an=RANK_NUM[typeof actor.globalRank==='string'?actor.globalRank:'user']||0;if(RANK_NUM[ch.rankOf(actor.nick||'')]<=RANK_NUM[ch.rankOf(targetNick)]&&an<RANK_NUM.admin)return;ch.users.set(targetNick,newRank);chanEvent(ch,{type:'rank_change',channel:ch.name,actor:actor.nick||BOT_NICK,target:targetNick,rank:newRank});const tu=users.get(targetNick);if(tu)tu.send({type:'your_rank',channel:ch.name,rank:newRank}); }

function handleKICK(user,chanName,target,reason='Expulsé'){ const ch=channels.get(chanName);if(!ch)return;const isBot=user.nick===BOT_NICK;if(!isBot&&!ch.isHalfOp(user.nick)&&!user.isAdmin()){user.send(num('482',user.nick,chanName,'Not operator'));return;}if(!ch.users.has(target))return;if(!isBot&&RANK_NUM[ch.rankOf(target)]>=RANK_NUM[ch.rankOf(user.nick||'')]&&!user.isAdmin()){srvNotice(user,'Rang insuffisant');return;}const kickMsg=msg(user.hostmask(),'KICK',chanName,target,reason);ch.broadcastAll(kickMsg);chanEvent(ch,{type:'user_kicked',channel:chanName,actor:user.nick||BOT_NICK,target,reason});const tu=users.get(target);if(tu)tu.channels.delete(chanName);ch.users.delete(target);if(ch.users.size<=1){ch.users.delete(BOT_NICK);channels.delete(chanName);}broadcastChanList(); }

function handleMUTE(user,chanName,target,dur=0){ const ch=channels.get(chanName);if(!ch)return;if(!ch.isHalfOp(user.nick)&&!user.isAdmin()){user.send(num('482',user.nick,chanName,'Not operator'));return;}const until=dur>0?Date.now()+dur*1000:0;ch.muted.set(target,until);chanEvent(ch,{type:'user_muted',channel:chanName,actor:user.nick,target,duration:dur});if(dur>0)setTimeout(()=>{ch.muted.delete(target);chanEvent(ch,{type:'user_unmuted',channel:chanName,target});},dur*1000); }

function handleUNMUTE(user,chanName,target){ const ch=channels.get(chanName);if(!ch)return;if(!ch.isHalfOp(user.nick)&&!user.isAdmin()){user.send(num('482',user.nick,chanName,'Not operator'));return;}ch.muted.delete(target);chanEvent(ch,{type:'user_unmuted',channel:chanName,actor:user.nick,target}); }

function handleMOVE(user,chanName,target,dest,reason='Déplacé'){ const ch=channels.get(chanName);if(!ch)return;if(!ch.isOp(user.nick)&&!user.isAdmin()){user.send(num('482',user.nick,chanName,'Not operator'));return;}const tu=users.get(target);if(!tu)return;srvNotice(tu,`${user.nick} vous déplace vers ${dest} : ${reason}`);tu.send({type:'forced_move',from:chanName,to:dest,reason,actor:user.nick});handlePART(tu,chanName,`Déplacé vers ${dest}`);handleJOIN(tu,dest); }

function handleGBAN(user,target,minutes=0,reason='Banned'){ if(!user.isAdmin()){srvNotice(user,'Réservé aux admins');return;}const until=minutes>0?Date.now()+minutes*60000:0;gbans.set(target,{until,reason,by:user.nick,at:Date.now()});const tu=users.get(target);if(tu){tu.send({raw:`:${SERVER_NAME} ERROR :Banned: ${reason}`});for(const c of[...tu.channels]){const ch=channels.get(c);if(ch){ch.users.delete(target);chanEvent(ch,{type:'user_banned',target,reason});}}tu.channels.clear();users.delete(target);}srvNotice(user,`${target} banni.`); }

function handleGUNBAN(user,target){ if(!user.isAdmin()){srvNotice(user,'Réservé aux admins');return;}gbans.delete(target);srvNotice(user,`${target} débanni`); }

function handleINVITE(user,target,chanName){ const ch=channels.get(chanName);if(!ch)return;if(!ch.isHalfOp(user.nick)&&!user.isAdmin()){user.send(num('482',user.nick,chanName,'Not operator'));return;}const tu=users.get(target);if(!tu){user.send(num('401',user.nick,target,'No such nick'));return;}ch.invites.add(target);tu.send(msg(user.hostmask(),'INVITE',target,chanName));tu.send({type:'invite',channel:chanName,from:user.nick});user.send(num('341',user.nick,target,chanName)); }

function handleOPER(user,pass){ if(hashPass(pass)===hashPass(ADMIN_PASS)){user.globalRank='admin';user.send(num('381',user.nick,'You are now IRC operator'));user.send({type:'rank_update',rank:'admin'});user.send({type:'bot_config',config:getBotCfg()});}else user.send(num('464',user.nick,'Password incorrect')); }

function handleWHOIS(user,target){ const tu=users.get(target);if(!tu){user.send(num('401',user.nick,target,'No such nick'));user.send(num('318',user.nick,target,'End of /WHOIS'));return;}user.send(num('311',user.nick,tu.nick,tu.username||'user',SERVER_NAME,tu.realname||tu.nick));user.send(num('312',user.nick,tu.nick,SERVER_NAME,'IRCnet/3.0'));if(tu.away)user.send(num('301',user.nick,tu.nick,tu.awayMsg));user.send({type:'whois_ext',target:tu.nick,globalRank:tu.globalRank,status:tu.status,statusMsg:tu.statusMsg,statusLabel:STATUSES[tu.status]||tu.status,duration:tu.statusDur()});user.send(num('318',user.nick,target,'End of /WHOIS')); }

function handleCHANADMIN(user,action,chanName,...params){ if(!user.isAdmin()&&channels.get(chanName)?.rankOf(user.nick)!=='owner'){srvNotice(user,'Réservé aux Fondateurs et Admins');return;}switch(action){case 'delete':{const ch=channels.get(chanName);if(!ch){srvNotice(user,'Canal introuvable');return;}for(const nick of[...ch.users.keys()]){if(nick===BOT_NICK)continue;const tu=users.get(nick);if(tu){srvNotice(tu,`Canal ${chanName} supprimé.`);tu.channels.delete(chanName);}}chanEvent(ch,{type:'chan_deleted',channel:chanName,actor:user.nick});channels.delete(chanName);broadcastChanList();srvNotice(user,`${chanName} supprimé.`);break;}case 'rename':{const nn=params[0];if(!nn||!validChan(nn)){srvNotice(user,'Nouveau nom invalide');return;}const ch=channels.get(chanName);if(!ch){srvNotice(user,'Introuvable');return;}if(channels.has(nn)){srvNotice(user,'Nom déjà pris');return;}ch.name=nn;channels.delete(chanName);channels.set(nn,ch);for(const nick of ch.users.keys()){const tu=users.get(nick);if(tu){tu.channels.delete(chanName);tu.channels.add(nn);}}chanEvent(ch,{type:'chan_renamed',old:chanName,neo:nn,actor:user.nick});broadcastChanList();srvNotice(user,`Renommé en ${nn}.`);break;}case 'settopic':{const ch=channels.get(chanName);if(!ch)return;ch.topic=params.join(' ');ch.broadcastAll(msg(user.hostmask(),'TOPIC',chanName,ch.topic));chanEvent(ch,{type:'topic_change',channel:chanName,topic:ch.topic,actor:user.nick});broadcastChanList();break;}case 'setpass':{const ch=channels.get(chanName);if(!ch)return;ch.password=params[0]?hashPass(params[0]):null;srvNotice(user,params[0]?`Mdp défini.`:`Mdp supprimé.`);broadcastChanList();break;}default:srvNotice(user,'Actions: delete|rename|settopic|setpass');} }

function handleQUIT(user,reason='Quit'){ if(!user?.nick)return;const m=msg(user.hostmask(),'QUIT',reason);for(const cn of user.channels){const ch=channels.get(cn);if(!ch)continue;ch.broadcast(m,user.nick);chanEvent(ch,{type:'user_left',channel:cn,nick:user.nick,reason});ch.users.delete(user.nick);if(ch.users.size<=1){ch.users.delete(BOT_NICK);channels.delete(cn);}}users.delete(user.nick);broadcastChanList(); }

function handleLIST(user){ user.send(num('321',user.nick,'Channel','Users Name'));for(const[name,ch]of channels){const f=(ch.password?'k':'')+(ch.inviteOnly?'i':'')+(ch.moderated?'m':'');user.send(num('322',user.nick,`${name}${f?' [+'+f+']':''}`,String(ch.users.size),ch.topic||''));}user.send(num('323',user.nick,'End of /LIST')); }

// ── Dispatch ──────────────────────────────────────────────────
function dispatch(user,line){ line=line.trim();if(!line)return;if(line.startsWith(':'))line=line.slice(line.indexOf(' ')+1).trim();const parts=line.match(/^(\S+)((?:\s+[^:]\S*)*)?(?:\s+:(.*))?$/);if(!parts)return;const cmd=parts[1].toUpperCase();const middle=(parts[2]||'').trim().split(/\s+/).filter(Boolean);const trailing=parts[3];const params=trailing!==undefined?[...middle,trailing]:middle;
switch(cmd){
  case 'NICK':handleNICK(user,params[0]);break;
  case 'USER':handleUSER(user,params[0],params[3]||params[0]);break;
  case 'JOIN':handleJOIN(user,params[0],params[1]||'');break;
  case 'PART':handlePART(user,params[0],params[1]);break;
  case 'PRIVMSG':handlePRIVMSG(user,params[0],params[1]);break;
  case 'TOPIC':handleTOPIC(user,params[0],params[1]);break;
  case 'KICK':handleKICK(user,params[0],params[1],params[2]);break;
  case 'INVITE':handleINVITE(user,params[0],params[1]);break;
  case 'MODE':handleMODE(user,params[0],params[1],...params.slice(2));break;
  case 'OPER':handleOPER(user,params[0]);break;
  case 'AWAY':if(params[0]){user.away=true;user.awayMsg=params[0];user.send(num('306',user.nick,'You are away'));}else{user.away=false;user.awayMsg='';user.send(num('305',user.nick,'You are back'));}break;
  case 'LIST':handleLIST(user);break;
  case 'WHOIS':handleWHOIS(user,params[0]);break;
  case 'NAMES':{const ch=channels.get(params[0]);if(ch){user.send(num('353',user.nick,'=',params[0],ch.userList()));user.send(num('366',user.nick,params[0],'End of /NAMES'));}break;}
  case 'WHO':{const ch=channels.get(params[0]);if(ch)for(const[nick,rank]of ch.users){const u=users.get(nick);if(u)user.send(num('352',user.nick,params[0],u.username||'u',SERVER_NAME,SERVER_NAME,nick,(u.away?'G':'H')+(RANK_PFX[rank]||''),`0 ${u.realname||nick}`));}user.send(num('315',user.nick,params[0]||'*','End of /WHO'));break;}
  case 'PING':user.send({raw:`:${SERVER_NAME} PONG ${SERVER_NAME} :${params[0]||SERVER_NAME}`});break;
  case 'PONG':break;
  case 'QUIT':handleQUIT(user,params[0]);break;
  case 'CAP':break;
  case 'STATUS':handleSTATUS(user,params[0],params.slice(1).join(' ')||'');break;
  case 'MOVE':handleMOVE(user,params[0],params[1],params[2],params.slice(3).join(' '));break;
  case 'MUTE':handleMUTE(user,params[0],params[1],parseInt(params[2])||0);break;
  case 'UNMUTE':handleUNMUTE(user,params[0],params[1]);break;
  case 'GBAN':handleGBAN(user,params[0],parseInt(params[1])||0,params.slice(2).join(' ')||'Banned');break;
  case 'GUNBAN':handleGUNBAN(user,params[0]);break;
  case 'CHANADMIN':handleCHANADMIN(user,params[0],params[1],...params.slice(2));break;
  default:user.send(num('421',user.nick,cmd,'Unknown command'));
}
}

// ── DCC / XDCC ────────────────────────────────────────────────
// ── Persistence ──────────────────────────────────────────────
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const PACKS_DIR = path.join(DATA_DIR, 'packs');
const META_FILE = path.join(DATA_DIR, 'xdcc_meta.json');

// Create directories if needed
[DATA_DIR, PACKS_DIR].forEach(d => { try { fs.mkdirSync(d, { recursive:true }); } catch{} });

function saveMeta() {
  const meta = [...xdccPacks.values()].map(p => ({
    id: p.id, owner: p.owner, filename: p.filename,
    size: p.size, mimetype: p.mimetype, description: p.description,
    gets: p.gets, added: p.added,
    file: path.join(PACKS_DIR, p.id + '_' + p.filename.replace(/[^a-zA-Z0-9._-]/g, '_'))
  }));
  try { fs.writeFileSync(META_FILE, JSON.stringify({nextId: xdccNextId, packs: meta}, null, 2)); }
  catch(e) { console.warn('[xdcc] saveMeta error:', e.message); }
}

function loadPacks() {
  try {
    if (!fs.existsSync(META_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(META_FILE, 'utf8'));
    xdccNextId = raw.nextId || 1;
    for (const m of (raw.packs || [])) {
      try {
        const data = fs.readFileSync(m.file);
        const pack = new XDCCPack(m.owner, m.filename, m.size, m.mimetype, data, m.description);
        pack.id   = m.id;
        pack.gets = m.gets || 0;
        pack.added= m.added || Date.now();
        xdccPacks.set(pack.id, pack);
      } catch(e) { console.warn('[xdcc] Could not load pack', m.id, ':', e.message); }
    }
    console.log(`[xdcc] Loaded ${xdccPacks.size} pack(s) from disk`);
  } catch(e) { console.warn('[xdcc] loadPacks error:', e.message); }
}

// Auto-save every 5 minutes
setInterval(saveMeta, 5 * 60 * 1000);

// ── DCC / XDCC ────────────────────────────────────────────────
const xdccPacks=new Map();const dccOffers=new Map();let xdccNextId=1;
class XDCCPack{constructor(owner,filename,size,mimetype,data,description){this.id=String(xdccNextId++);this.owner=owner;this.filename=filename;this.size=size;this.mimetype=mimetype;this.data=data;this.description=description||'';this.gets=0;this.added=Date.now();}toPublic(){return{id:this.id,owner:this.owner,filename:this.filename,size:this.size,mimetype:this.mimetype,description:this.description,gets:this.gets,added:this.added};}}
function mkToken(){return crypto.randomBytes(12).toString('hex');}
setInterval(()=>{const now=Date.now();for(const[t,o]of dccOffers)if(now-o.created>5*60*1000)dccOffers.delete(t);},60000);
function bcastXDCC(){const p=[...xdccPacks.values()].map(p=>p.toPublic());for(const u of users.values())if(u.registered)u.send({type:'xdcc_list',packs:p});}
function xdccNotice(nick,text){const u=users.get(nick);if(u)u.send({raw:`:XDCCbot!xdcc@${SERVER_NAME} NOTICE ${nick} :${text}`});}
function xdccList(nick){xdccNotice(nick,'═══ Packs XDCC ═══');if(!xdccPacks.size){xdccNotice(nick,'Aucun pack.');return;}for(const p of xdccPacks.values()){const sz=p.size<1048576?(p.size/1024).toFixed(1)+'KB':(p.size/1048576).toFixed(2)+'MB';xdccNotice(nick,`#${p.id.padStart(3)} [${sz.padStart(8)}] ${p.filename} — ${p.description||'—'} (${p.gets} DL)`);}const u=users.get(nick);if(u)u.send({type:'xdcc_list',packs:[...xdccPacks.values()].map(p=>p.toPublic())});}
function xdccGet(nick,packId){const u=users.get(nick);if(!u)return;const pack=xdccPacks.get(String(packId));if(!pack){xdccNotice(nick,`Pack #${packId} introuvable.`);return;}pack.gets++;const token=mkToken();dccOffers.set(token,{token,type:'xdcc',from:'XDCCbot',to:nick,filename:pack.filename,size:pack.size,mimetype:pack.mimetype,data:pack.data,created:Date.now()});xdccNotice(nick,`Envoi: ${pack.filename} — acceptez le transfert DCC.`);u.send({type:'dcc_offer',token,from:'XDCCbot',filename:pack.filename,size:pack.size,mimetype:pack.mimetype,packId:pack.id});}
function xdccAdd(user,filename,size,mimetype,data,description){
  const pack=new XDCCPack(user.nick,filename,size,mimetype,data,description);
  xdccPacks.set(pack.id,pack);
  // Save to disk
  try {
    const safeName = filename.replace(/[^a-zA-Z0-9._-]/g,'_');
    const filePath = path.join(PACKS_DIR, pack.id + '_' + safeName);
    fs.writeFileSync(filePath, data);
    saveMeta();
    console.log(`[xdcc] Pack #${pack.id} saved: ${filePath} (${(data.length/1024).toFixed(1)}KB)`);
  } catch(e) { console.warn('[xdcc] Save error:', e.message); }
  srvNotice(user,`Pack XDCC #${pack.id} ajouté et sauvegardé.`);
  bcastXDCC();
  return pack;
}
function xdccRemove(user,packId){
  const pack=xdccPacks.get(String(packId));
  if(!pack){srvNotice(user,`Pack #${packId} introuvable.`);return;}
  if(pack.owner!==user.nick&&!user.isAdmin()){srvNotice(user,'Permission refusée.');return;}
  // Delete file from disk
  try {
    const safeName = pack.filename.replace(/[^a-zA-Z0-9._-]/g,'_');
    const filePath = path.join(PACKS_DIR, pack.id + '_' + safeName);
    if(fs.existsSync(filePath)) fs.unlinkSync(filePath);
    console.log(`[xdcc] Pack #${pack.id} deleted from disk`);
  } catch(e) { console.warn('[xdcc] Delete error:', e.message); }
  xdccPacks.delete(String(packId));
  saveMeta();
  srvNotice(user,`Pack #${packId} supprimé.`);
  bcastXDCC();
}
function dccSend(user,targetNick,filename,size,mimetype,b64data){const dest=users.get(targetNick);if(!dest){srvNotice(user,`${targetNick} introuvable.`);return;}const data=Buffer.from(b64data,'base64');const token=mkToken();dccOffers.set(token,{token,type:'dcc',from:user.nick,to:targetNick,filename,size,mimetype,data,created:Date.now()});dest.send({type:'dcc_offer',token,from:user.nick,filename,size,mimetype});if(dest.type==='irc')dest.send({raw:`:${user.hostmask()} PRIVMSG ${targetNick} :\x01DCC SEND ${filename} 0 0 ${size}\x01`});srvNotice(user,`Offre DCC envoyée à ${targetNick}.`);}
function handleCTCP(user,target,ctcpText){if(ctcpText==='VERSION')user.send({raw:`:${SERVER_NAME} NOTICE ${user.nick} :\x01VERSION IRCnet/3.0\x01`});if(ctcpText==='XDCC LIST')xdccList(user.nick);if(ctcpText.startsWith('XDCC SEND ')||ctcpText.startsWith('XDCC GET ')){const id=ctcpText.split(' ')[2]?.replace('#','');if(id)xdccGet(user.nick,id);}}

// ── WebSocket (natif) ─────────────────────────────────────────
function wsHandshake(req,socket){const acc=crypto.createHash('sha1').update(req.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+acc+'\r\n\r\n');}
function parseWsFrame(buf){if(buf.length<2)return null;const op=buf[0]&0x0f,masked=(buf[1]&0x80)!==0;let len=buf[1]&0x7f,off=2;if(len===126){len=buf.readUInt16BE(2);off=4;}else if(len===127){len=Number(buf.readBigUInt64BE(2));off=10;}if(buf.length<off+(masked?4:0)+len)return null;let payload;if(masked){const mask=buf.slice(off,off+4);off+=4;payload=Buffer.allocUnsafe(len);for(let i=0;i<len;i++)payload[i]=buf[off+i]^mask[i%4];}else payload=buf.slice(off,off+len);return{op,payload,total:off+len};}
function buildWsFrame(data){const p=Buffer.from(data,'utf8'),len=p.length;let h;if(len<126){h=Buffer.alloc(2);h[0]=0x81;h[1]=len;}else if(len<65536){h=Buffer.alloc(4);h[0]=0x81;h[1]=126;h.writeUInt16BE(len,2);}else{h=Buffer.alloc(10);h[0]=0x81;h[1]=127;h.writeBigUInt64BE(BigInt(len),2);}return Buffer.concat([h,p]);}

// ── HTTP ──────────────────────────────────────────────────────
function getFile(rel){const bases=[path.join(__dirname,'public'),path.join(process.cwd(),'public'),process.cwd()];for(const b of bases){try{return fs.readFileSync(path.join(b,rel));}catch{}}return null;}
const MIME={'.html':'text/html; charset=utf-8','.css':'text/css','.js':'text/javascript','.ico':'image/x-icon','.png':'image/png'};
function corsH(res){res.setHeader('Access-Control-Allow-Origin','*');}

const httpServer=http.createServer((req,res)=>{
  const rawUrl=req.url;const url=rawUrl.split('?')[0];const qs=new URLSearchParams(rawUrl.includes('?')?rawUrl.slice(rawUrl.indexOf('?')+1):'');
  // CORS preflight
  if(req.method==='OPTIONS'){corsH(res);res.writeHead(204);res.end();return;}
  if(url==='/health'){corsH(res);res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({status:'ok',users:users.size,channels:channels.size,xdccPacks:xdccPacks.size,dataDir:DATA_DIR,uptime:Math.floor((Date.now()-botStart)/1000)}));return;}
  if(url==='/api/channels'){corsH(res);res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify([...channels.values()].map(c=>c.toJSON())));return;}
  if(url==='/api/bot'){corsH(res);res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(getBotCfg()));return;}
  if(url==='/api/xdcc'){corsH(res);res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify([...xdccPacks.values()].map(p=>p.toPublic())));return;}
  // XDCC stream/download by pack ID (supports Range for video seeking)
  if(url.startsWith('/xdcc/stream/')||url.startsWith('/xdcc/dl/')){
    const packId=url.split('/')[3];
    const pack=xdccPacks.get(String(packId));
    if(!pack||!pack.data){res.writeHead(404);res.end('Pack not found');return;}
    const data=pack.data;
    const total=data.length;
    const isDownload=url.startsWith('/xdcc/dl/');
    const rangeHeader=req.headers['range'];
    corsH(res);
    res.setHeader('Accept-Ranges','bytes');
    res.setHeader('Content-Type',pack.mimetype||'application/octet-stream');
    if(isDownload){
      res.setHeader('Content-Disposition',`attachment; filename="${encodeURIComponent(pack.filename)}"`);
    } else {
      res.setHeader('Content-Disposition',`inline; filename="${encodeURIComponent(pack.filename)}"`);
    }
    if(rangeHeader){
      const parts=rangeHeader.replace(/bytes=/,'').split('-');
      const start=parseInt(parts[0],10);
      const end=parts[1]?parseInt(parts[1],10):total-1;
      const chunkSize=end-start+1;
      res.writeHead(206,{
        'Content-Range':`bytes ${start}-${end}/${total}`,
        'Content-Length':chunkSize,
      });
      res.end(data.slice(start,end+1));
    } else {
      res.setHeader('Content-Length',total);
      res.writeHead(200);
      res.end(data);
    }
    return;
  }

  if(url==='/dcc/download'){const token=qs.get('token');const offer=token?dccOffers.get(token):null;if(!offer||!offer.data){res.writeHead(404);res.end('Not found');return;}corsH(res);res.writeHead(200,{'Content-Type':offer.mimetype||'application/octet-stream','Content-Disposition':`attachment; filename="${encodeURIComponent(offer.filename)}"`, 'Content-Length':offer.data.length});res.end(offer.data);dccOffers.delete(token);return;}
  if(url==='/dcc/upload'&&req.method==='POST'){let body='';req.on('data',d=>{body+=d.toString();if(body.length>60*1024*1024)req.destroy();});req.on('end',()=>{try{const j=JSON.parse(body);const user=users.get(j.nick);if(!user){res.writeHead(403);res.end('Not connected');return;}if(j.target){dccSend(user,j.target,j.filename,j.size||0,j.mimetype||'application/octet-stream',j.data);}else{xdccAdd(user,j.filename,j.size||0,j.mimetype||'application/octet-stream',Buffer.from(j.data,'base64'),j.description||'');}corsH(res);res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({ok:true}));}catch(e){res.writeHead(400);res.end('Bad request');}});return;}
  const filePath=(url==='/'||url==='/index.html')?'index.html':url.slice(1);
  const data=getFile(filePath);
  if(data){res.writeHead(200,{'Content-Type':MIME[path.extname(filePath)]||'text/plain'});res.end(data);}
  else{res.writeHead(404);res.end('Not found');}
});

// ── WebSocket upgrade ─────────────────────────────────────────
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
      if(f.op!==0x1&&f.op!==0x0)continue;
      const t=f.payload.toString('utf8');
      try{
        const o=JSON.parse(t);
        if(o.type==='dcc_send'){dccSend(user,o.target,o.filename,o.size,o.mimetype,o.data);}
        else if(o.type==='dcc_accept'){const offer=dccOffers.get(o.token);if(offer)user.send({type:'dcc_download',token:o.token,filename:offer.filename,mimetype:offer.mimetype});else user.send({type:'dcc_error',message:'Offre expirée.'});}
        else if(o.type==='dcc_reject'){const offer=dccOffers.get(o.token);if(offer){dccOffers.delete(o.token);const s=users.get(offer.from);if(s)srvNotice(s,`${user.nick} a refusé votre envoi DCC.`);}}
        else if(o.type==='xdcc_add'){xdccAdd(user,o.filename,o.size,o.mimetype,Buffer.from(o.data,'base64'),o.description||'');}
        else if(o.type==='xdcc_remove'){xdccRemove(user,o.packId);}
        else if(o.type==='xdcc_get'){xdccGet(user.nick,o.packId);}
        else if(o.type==='xdcc_list'){user.send({type:'xdcc_list',packs:[...xdccPacks.values()].map(p=>p.toPublic())});}
        else{const raw=o.raw||t;const ctcpM=raw.match(/^(?::\S+ )?PRIVMSG (\S+) :\x01(.+)\x01$/i);if(ctcpM)handleCTCP(user,ctcpM[1],ctcpM[2]);else dispatch(user,raw);}
      }catch{if(t&&!t.startsWith('{'))dispatch(user,t);}
    }
  });
  socket.on('close',()=>handleQUIT(user,'Connection closed'));
  socket.on('error',()=>handleQUIT(user,'Socket error'));
});

// ── Start ─────────────────────────────────────────────────────
// Load persisted packs
loadPacks();

httpServer.listen(PORT,'0.0.0.0',()=>{
  console.log(`[ready] IRCnet v3 listening on 0.0.0.0:${PORT}`);
  console.log(`[ready] SERVER_NAME=${SERVER_NAME}`);
  console.log(`[ready] Bot=${BOT_NICK} prefix=${botConfig.prefix}`);
  console.log(`[ready] ADMIN_PASS set=${ADMIN_PASS!=='admin1234'}`);
});
httpServer.on('error',err=>{console.error('[error] HTTP server error:',err.message);process.exit(1);});

// ── TCP IRC (optionnel) ───────────────────────────────────────
if(IRC_ENABLED){
  const IRC_PORT=parseInt(process.env.IRC_PORT)||6667;
  const ircServer=net.createServer(socket=>{
    const user=new User(crypto.randomUUID().slice(0,8),o=>{try{socket.write((o.raw||'')+'\r\n');}catch{}},'irc');
    try{socket.write(`:${SERVER_NAME} NOTICE Auth :*** IRCnet v3\r\n`);}catch{}
    let buf='';
    socket.on('data',d=>{buf+=d.toString('utf8');const lines=buf.split('\r\n');buf=lines.pop();for(const l of lines)if(l.trim()){const ctcpM=l.match(/^(?::\S+ )?PRIVMSG (\S+) :\x01(.+)\x01$/i);if(ctcpM)handleCTCP(user,ctcpM[1],ctcpM[2]);else dispatch(user,l);}});
    socket.on('close',()=>handleQUIT(user,'Connection closed'));
    socket.on('error',()=>handleQUIT(user,'Socket error'));
    const pi=setInterval(()=>{try{socket.write(`:${SERVER_NAME} PING :${SERVER_NAME}\r\n`);}catch{clearInterval(pi);}},90000);
    socket.on('close',()=>clearInterval(pi));
  });
  ircServer.on('error',err=>console.warn('[warn] IRC TCP error:',err.message));
  ircServer.listen(IRC_PORT,'0.0.0.0',()=>console.log(`[ready] IRC TCP on :${IRC_PORT}`));
}

process.on('SIGTERM',()=>{httpServer.close();process.exit(0);});
process.on('SIGINT',()=>{httpServer.close();process.exit(0);});
process.on('uncaughtException',err=>{console.error('[crash]',err.message,err.stack);});
process.on('unhandledRejection',err=>{console.error('[reject]',err);});
