'use strict';
/**
 * ╔══════════════════════════════════════════════════════════╗
 * ║          GeoFS MRP COMMAND — Discord ATC Bot            ║
 * ║  • Dual-source: GeoFS live API + Osprey V2             ║
 * ║  • GeoFS  → position, speed, altitude, heading        ║
 * ║  • Osprey → identity, past callsigns, history          ║
 * ║  • Per-guild multi-territory monitoring                ║
 * ║  • MRP-first contact display with discriminator       ║
 * ║  • Threat classification (MRP/TAGGED/UNKNOWN)         ║
 * ║  • IDENT cards, history tracking, patrol log          ║
 * ╚══════════════════════════════════════════════════════════╝
 *
 * ENV VARS:
 *   BOT_TOKEN        — Discord bot token  (required)
 *   BOT_APP_ID       — Discord app/client ID  (required)
 *   OSPREY_BASE      — Osprey V2 base (default: https://api.gms-admin.net/api/v2)
 *   GEOFS_API        — GeoFS live API  (default: https://mps.geo-fs.com/map)
 *   POLL_MS          — Poll interval ms (default: 12000)
 *   COOLDOWN_MIN     — Alert cooldown minutes (default: 45)
 *   DATA_DIR         — Config/data directory (default: ./data)
 */

// ── DEPS ─────────────────────────────────────────────────────────────────────
const path=require('path'),fs=require('fs');
const {
  Client,GatewayIntentBits,REST,Routes,
  EmbedBuilder,SlashCommandBuilder,PermissionFlagsBits,
  ButtonBuilder,ButtonStyle,ActionRowBuilder,
}=require('discord.js');
const PatrolLog=require('./patrol-log');

// ── ENV ──────────────────────────────────────────────────────────────────────
const TOKEN     = process.env.BOT_TOKEN    || '';
const APP_ID    = process.env.BOT_APP_ID   || '';
const OSPREY    = process.env.OSPREY_BASE  || 'https://api.gms-admin.net/api/v2';
const GEOFS_API = process.env.GEOFS_API    || 'https://mps.geo-fs.com/map';
const POLL_MS   = +process.env.POLL_MS     || 12_000;
const CDN_MIN   = +process.env.COOLDOWN_MIN|| 45;
const DATA_DIR  = process.env.DATA_DIR     || path.join(__dirname,'data');
const GRACE_MS  = 90_000;
const BOXES_PATH= path.join(__dirname,'aoboxes.json');

// ── MRP TAG LIST ─────────────────────────────────────────────────────────────
const MRP_TAGS=[
  'U','UTP','P','PMC','NKG-KG','SHL','NFS','AEF','RPAF','WANK','NIUF',
  'RNLAF','RNZAF','USAF','RAAF','TUAF','TASC','UAC','UAEAF','USSR',
  'BAF','PAF','JASDF','RAF','VKS','EVKS','PRC','MAC','BPYR','FFL',
];

// ── COLOURS ───────────────────────────────────────────────────────────────────
const COL={
  SCRAMBLE:0x0047AB, MRP:0x0077CC, UNKNOWN:0x1C3A5E,
  FRIENDLY:0x00509E, SITREP:0x003366, CLEAR:0x003153, IDENT:0x0057A8,
};

// ── TERRITORY BOXES ───────────────────────────────────────────────────────────
let BOXES=[];
try{
  const d=JSON.parse(fs.readFileSync(BOXES_PATH,'utf8'));
  BOXES=Array.isArray(d.aoBoxes)?d.aoBoxes:[];
  console.log(`[MRP] ${BOXES.length} territory boxes loaded.`);
}catch{ console.warn('[MRP] aoboxes.json not found.'); }

function boxesAt(lat,lon){
  return BOXES.filter(b=>lat>=b.minLat&&lat<=b.maxLat&&lon>=b.minLon&&lon<=b.maxLon).map(b=>b.name);
}
function resolveBox(q){
  const l=q.trim().toLowerCase();
  return BOXES.find(b=>b.name.toLowerCase()===l)?.name||null;
}

// ── PERSISTENCE ───────────────────────────────────────────────────────────────
function cfgPath(gid){ return path.join(DATA_DIR,`${gid}.json`); }
function defCfg(gid){
  return{guildId:gid,alertChannel:null,logChannel:null,pingRoles:[],
         territories:[],friendlyTags:[],ignoredCallsigns:[],
         cooldownMin:CDN_MIN,showAllPilots:false,
         alertMRP:true,alertTagged:true,alertUnknown:false};
}
function loadCfg(gid){
  try{ return JSON.parse(fs.readFileSync(cfgPath(gid),'utf8')); }
  catch{ return defCfg(gid); }
}
function saveCfg(c){
  fs.mkdirSync(DATA_DIR,{recursive:true});
  fs.writeFileSync(cfgPath(c.guildId),JSON.stringify(c,null,2)+'\n','utf8');
}
function allCfgs(){
  try{
    if(!fs.existsSync(DATA_DIR)) return[];
    return fs.readdirSync(DATA_DIR)
      .filter(f=>f.endsWith('.json')&&!f.startsWith('.')&&!f.startsWith('pilots_')&&!f.startsWith('patrolcfg_'))
      .map(f=>{try{return JSON.parse(fs.readFileSync(path.join(DATA_DIR,f),'utf8'));}catch{return null;}})
      .filter(Boolean);
  }catch{ return[]; }
}

// ── COOLDOWNS ────────────────────────────────────────────────────────────────
const CDL_FILE=path.join(DATA_DIR,'.cooldowns.json');
function loadCDL(){
  try{
    const raw=JSON.parse(fs.readFileSync(CDL_FILE,'utf8'));
    const m=new Map(),cut=Date.now()-24*3600_000;
    for(const[k,v] of Object.entries(raw)) if(v>cut) m.set(k,v);
    return m;
  }catch{ return new Map(); }
}
function saveCDL(m){
  try{fs.mkdirSync(DATA_DIR,{recursive:true});fs.writeFileSync(CDL_FILE,JSON.stringify(Object.fromEntries(m))+'\n');}catch{}
}
const CDL=loadCDL();
const startTs=Date.now();
function onCD(gid,key,min){ return Date.now()-(CDL.get(`${gid}:${key}`)||0)<min*60_000; }
function markCD(gid,key){ CDL.set(`${gid}:${key}`,Date.now()); saveCDL(CDL); }

// ── RATE LIMITER ──────────────────────────────────────────────────────────────
let tokens=4,lastRefill=Date.now();
function consume(){
  const now=Date.now(); tokens=Math.min(4,tokens+(now-lastRefill)/1000*4); lastRefill=now;
  if(tokens>=1){tokens--;return true;} return false;
}

// ── CONTACT HISTORY ───────────────────────────────────────────────────────────
const posHist=new Map(),contactSeen=new Map();
function pushPos(key,lat,lon){
  const h=posHist.get(key)||[]; h.push({lat,lon,ts:Date.now()});
  if(h.length>6) h.shift(); posHist.set(key,h);
  if(!contactSeen.has(key)) contactSeen.set(key,Date.now());
}
function avgSpd(key){
  const h=posHist.get(key)||[]; if(h.length<2) return null;
  let d=0,t=0;
  for(let i=1;i<h.length;i++){
    d+=distNM(h[i-1].lat,h[i-1].lon,h[i].lat,h[i].lon);
    t+=(h[i].ts-h[i-1].ts)/3_600_000;
  }
  return t>0?Math.round(d/t):null;
}
function estimatedVector(key,lat,lon,hdg){
  const spd=avgSpd(key)||200,dist=spd/60,r=Math.PI/180;
  return{
    lat:(lat+dist*Math.cos(hdg*r)/60).toFixed(4),
    lon:(lon+dist*Math.sin(hdg*r)/(60*Math.cos(lat*r))).toFixed(4),
  };
}

// ── MATH ─────────────────────────────────────────────────────────────────────
function distNM(a,b,c,d){
  const R=3440.065,dl=(c-a)*Math.PI/180,dn=(d-b)*Math.PI/180;
  const x=Math.sin(dl/2)**2+Math.cos(a*Math.PI/180)*Math.cos(c*Math.PI/180)*Math.sin(dn/2)**2;
  return R*2*Math.atan2(Math.sqrt(x),Math.sqrt(1-x));
}
function safeN(v,fb=NaN){ const n=Number(v); return isFinite(n)?n:fb; }
function fmtAlt(ft){ return isFinite(ft)?`${Math.round(ft/100)*100}ft`:'---'; }
function fmtSpd(kt){ return kt!=null?`${kt}kt`:'---'; }
function nowZ(){ return new Date().toISOString().replace('T',' ').slice(0,19)+' Z'; }
function fmtTs(ms){ return ms?`<t:${Math.floor(ms/1000)}:R>`:'---'; }

// ── TAG PARSING ───────────────────────────────────────────────────────────────
function parseTag(cs){
  const s=String(cs||'').toUpperCase();
  return(s.match(/\[([A-Z0-9-]{1,16})\]/)||s.match(/\(([A-Z0-9-]{1,16})\)/)||s.match(/^([A-Z]{2,8})[-_]/))?.[1]||null;
}
function isMRP(tag){ return tag&&MRP_TAGS.includes(tag.toUpperCase()); }
function classifyContact(cs,friendlyTags){
  const tag=parseTag(cs);
  if(!tag) return'UNKNOWN';
  if(friendlyTags?.some(f=>f.toUpperCase()===tag.toUpperCase())) return'FRIENDLY';
  if(isMRP(tag)) return'MRP';
  return'TAGGED';
}
function ckey(cs,acid){ return`${String(cs).toUpperCase()}:${acid||''}`; }

// ── OSPREY V2 CACHE ───────────────────────────────────────────────────────────
// Cache identity data from Osprey to enrich GeoFS contacts
// key = callsign.toUpperCase() → { acid, pastCallsigns, online, lastLogin }
const ospreyCache=new Map();
let ospreyLastFetch=0;
const OSPREY_CACHE_MS=60_000; // refresh Osprey identity cache every 60s

// ── API FETCHERS ──────────────────────────────────────────────────────────────

// GeoFS — real-time position data for ALL online pilots
async function fetchGeofs(){
  try{
    const r=await fetch(GEOFS_API,{signal:AbortSignal.timeout(10_000)});
    if(!r.ok) return[];
    const d=await r.json();
    const users=Array.isArray(d.users)?d.users:Array.isArray(d)?d:[];
    return users.map(u=>{
      if(!u||!Array.isArray(u.co)||u.co.length<2) return null;
      const[lat,lon,altM=0,hdg=0]=u.co;
      if(!isFinite(lat)||!isFinite(lon)) return null;
      const cs=String(u.cs||u.callsign||'').trim(); if(!cs) return null;
      return{
        cs, acid:String(u.id||u.acid||cs),
        aircraft:'GeoFS', src:'geofs',
        lat, lon, alt:altM*3.28084, hdg,
        spd:u.st?.as??u.st?.gs??null,
        pastCallsigns:[], online:true,
      };
    }).filter(Boolean);
  }catch(e){ console.warn('[MRP] GeoFS fetch:',e.message); return[]; }
}

// Osprey V2 — identity enrichment for MRP-tagged pilots
// Uses /users/search with MRP tag pattern
// Returns identity map, NOT position data
async function fetchOspreyIdentity(){
  if(Date.now()-ospreyLastFetch<OSPREY_CACHE_MS) return; // use cache
  try{
    // Build regex pattern matching all MRP tags in brackets/parens
    const tagPat=MRP_TAGS.map(t=>`\\[${t}\\]|\\(${t}\\)`).join('|');
    let page=1,fetched=0;
    while(true){
      const r=await fetch(
        `${OSPREY}/users/search?pattern=/${tagPat}/i&page=${page}&per_page=100`,
        {signal:AbortSignal.timeout(15_000)}
      );
      if(r.status===429){ await new Promise(r=>setTimeout(r,8_000)); continue; }
      if(!r.ok) break;
      const d=await r.json();
      const results=Array.isArray(d?.results)?d.results:[];
      for(const raw of results){
        const cs=String(raw?.currentCallsign??'').trim().toUpperCase();
        if(!cs) continue;
        ospreyCache.set(cs,{
          acid:       String(raw?.accountID??''),
          online:     raw?.Online===true,
          pastCallsigns: Array.isArray(raw?.pastCallsigns)?raw.pastCallsigns:[],
          // pull last login from events if present
          lastLogin:  raw?.events?.find?.(e=>e?.event?.type==='login')?.event?.timestamp||null,
        });
        fetched++;
      }
      const total=+(d?.count??Infinity);
      if(results.length<100||fetched>=total) break;
      page++;
    }
    ospreyLastFetch=Date.now();
    console.log(`[MRP] Osprey V2: ${ospreyCache.size} identities cached.`);
  }catch(e){ console.warn('[MRP] Osprey V2 fetch:',e.message); }
}

// Osprey V2 — get single pilot by ACID (for /ident enrichment)
async function fetchOspreyByAcid(acid){
  if(!acid) return null;
  try{
    const r=await fetch(`${OSPREY}/users/?acid=${acid}`,{signal:AbortSignal.timeout(8_000)});
    if(!r.ok) return null;
    const d=await r.json();
    return{
      acid:       String(d?.accountID??acid),
      online:     d?.Online===true,
      pastCallsigns: Array.isArray(d?.pastCallsigns)?d.pastCallsigns:[],
      events:     Array.isArray(d?.events)?d.events:[],
      lastLogin:  d?.events?.find?.(e=>e?.event?.type==='login')?.event?.timestamp||null,
      createdAt:  d?.events?.find?.(e=>e?.event?.type==='account_created')?.event?.timestamp||null,
    };
  }catch(e){ console.warn('[MRP] Osprey byAcid:',e.message); return null; }
}

// Osprey V2 — search by exact callsign (for /ident when no ACID known)
async function fetchOspreyByCallsign(cs){
  try{
    const r=await fetch(
      `${OSPREY}/users/search?exact_callsign=${encodeURIComponent(cs)}`,
      {signal:AbortSignal.timeout(8_000)}
    );
    if(!r.ok) return null;
    const d=await r.json();
    const result=Array.isArray(d?.results)?d.results[0]:null;
    if(!result) return null;
    return{
      acid:         String(result?.accountID??''),
      online:       result?.Online===true,
      pastCallsigns:Array.isArray(result?.pastCallsigns)?result.pastCallsigns:[],
      lastLogin:    null,
      createdAt:    null,
    };
  }catch(e){ console.warn('[MRP] Osprey byCS:',e.message); return null; }
}

// Merge GeoFS (position) + Osprey cache (identity)
// GeoFS is authoritative for position
// Osprey enriches with acid, pastCallsigns, history
async function fetchAll(){
  // Refresh Osprey identity cache in background (non-blocking)
  fetchOspreyIdentity().catch(()=>{});

  const geo=await fetchGeofs();
  const map=new Map();

  for(const c of geo){
    // Try to enrich with Osprey cache
    const osp=ospreyCache.get(c.cs.toUpperCase());
    if(osp){
      c.acid        = c.acid||osp.acid;
      c.pastCallsigns= osp.pastCallsigns;
      c.lastLogin   = osp.lastLogin;
      c.src         = 'geofs+osprey';
    }
    map.set(c.cs.toUpperCase(),c);
  }

  // Also add Osprey-only online pilots (seen by Osprey but not GeoFS yet)
  for(const[cs,osp] of ospreyCache){
    if(!osp.online) continue;
    if(map.has(cs)) continue; // already have from GeoFS
    map.set(cs,{
      cs, acid:osp.acid,
      aircraft:'Unknown', src:'osprey',
      lat:NaN, lon:NaN, alt:0, hdg:0, spd:null,
      pastCallsigns:osp.pastCallsigns,
      lastLogin:osp.lastLogin,
      online:true,
    });
  }

  return[...map.values()];
}

// ── EMBED BUILDERS ────────────────────────────────────────────────────────────
function buildIdentEmbed(c,cfg,territories,ospreyData=null){
  const tag=parseTag(c.cs),cls=classifyContact(c.cs,cfg.friendlyTags);
  const colMap={MRP:COL.MRP,TAGGED:COL.SCRAMBLE,UNKNOWN:COL.UNKNOWN,FRIENDLY:COL.FRIENDLY};
  const clsIcon={MRP:'🔵',TAGGED:'🔴',UNKNOWN:'⚫',FRIENDLY:'🟢'};
  const spd=c.spd??avgSpd(ckey(c.cs,c.acid));
  const seenTs=contactSeen.get(ckey(c.cs,c.acid));
  const hasPos=isFinite(c.lat)&&isFinite(c.lon);

  // merge osprey enrichment
  const pastCS=[...(c.pastCallsigns||[]),(ospreyData?.pastCallsigns||[])].flat();
  const uniquePast=[...new Set(pastCS)].filter(p=>p.toUpperCase()!==c.cs.toUpperCase());
  const acid=c.acid||ospreyData?.acid||null;
  const lastLogin=c.lastLogin||ospreyData?.lastLogin||null;
  const createdAt=ospreyData?.createdAt||null;
  const src=ospreyData?'GeoFS + Osprey V2':c.src==='geofs+osprey'?'GeoFS + Osprey V2':'GeoFS Live';

  const e=new EmbedBuilder()
    .setColor(colMap[cls]||COL.UNKNOWN)
    .setTitle(`${clsIcon[cls]} IDENT — ${c.cs}`)
    .setDescription(
      cls==='MRP'  ?`**MRP CONTACT** — \`[${tag}]\` group detected in monitored airspace`:
      cls==='TAGGED'?`**TAGGED CONTACT** — \`[${tag}]\` in monitored airspace`:
                    `**UNTAGGED CONTACT** — no group identifier`
    )
    .addFields(
      {name:'◈ IDENTIFICATION',value:[
        `**Callsign:** \`${c.cs}\``,
        tag?`**Tag:** \`[${tag}]\``:'**Tag:** `NONE`',
        `**Class:** ${clsIcon[cls]} ${cls}`,
        acid?`**ACID:** \`${acid}\``:'**ACID:** `unknown`',
        `**Source:** ${src}`,
        uniquePast.length?`**Known aliases:** ${uniquePast.slice(0,5).map(p=>`\`${p}\``).join(', ')}${uniquePast.length>5?` +${uniquePast.length-5} more`:''}`:null,
      ].filter(Boolean).join('\n'),inline:true},
      {name:'✈ FLIGHT DATA',value:[
        `**Aircraft:** ${c.aircraft||'Unknown'}`,
        `**Altitude:** ${fmtAlt(c.alt)}`,
        `**Speed:** ${fmtSpd(spd)}`,
        `**Heading:** ${isFinite(c.hdg)?`${Math.round(c.hdg)}°`:'---'}`,
        `**First seen:** ${fmtTs(seenTs)}`,
        lastLogin?`**Last Osprey login:** <t:${Math.floor(new Date(lastLogin).getTime()/1000)}:R>`:null,
        createdAt?`**Account created:** <t:${Math.floor(new Date(createdAt).getTime()/1000)}:D>`:null,
      ].filter(Boolean).join('\n'),inline:true},
      hasPos?{name:'📍 POSITION',value:[
        `**Coords:** \`${c.lat.toFixed(4)}°, ${c.lon.toFixed(4)}°\``,
        `**Territory:** ${territories.length?territories.join(', '):'Unknown'}`,
        `**Est. 1-min pos:** \`${estimatedVector(ckey(c.cs,acid||''),c.lat,c.lon,c.hdg||0).lat}°, ${estimatedVector(ckey(c.cs,acid||''),c.lat,c.lon,c.hdg||0).lon}°\``,
      ].join('\n'),inline:false}:
      {name:'📍 POSITION',value:'Position unavailable — Osprey-only contact',inline:false},
    )
    .setFooter({text:`MRP COMMAND · ${nowZ()} · ${src}`})
    .setTimestamp();
  return e;
}

function buildScrambleEmbed(c,cfg,territories){
  const tag=parseTag(c.cs),cls=classifyContact(c.cs,cfg.friendlyTags);
  const spd=c.spd??avgSpd(ckey(c.cs,c.acid));
  const colMap={MRP:COL.MRP,TAGGED:COL.SCRAMBLE,UNKNOWN:COL.UNKNOWN,FRIENDLY:COL.FRIENDLY};
  const titleMap={
    MRP:'🚨 MRP CONTACT — SCRAMBLE',TAGGED:'⚠️ TAGGED CONTACT ALERT',
    UNKNOWN:'📡 UNIDENTIFIED CONTACT',FRIENDLY:'ℹ️ FRIENDLY MOVEMENT',
  };
  return new EmbedBuilder()
    .setColor(colMap[cls]||COL.SCRAMBLE)
    .setTitle(titleMap[cls]||'⚠️ CONTACT ALERT')
    .setDescription([
      cls==='MRP'?`> **MRP PILOT DETECTED** — \`[${tag}]\` group`:'',
      `**${c.cs}** in **${territories.join(' / ')}**`,
    ].filter(Boolean).join('\n'))
    .addFields(
      {name:'Contact',value:[`\`${c.cs}\``,tag?`Tag: \`[${tag}]\``:null,c.acid?`ACID: \`${c.acid}\``:null].filter(Boolean).join('\n'),inline:true},
      {name:'Flight',value:[`Alt: **${fmtAlt(c.alt)}**`,`Spd: **${fmtSpd(spd)}**`,`Hdg: **${isFinite(c.hdg)?Math.round(c.hdg)+'°':'---'}**`].join('\n'),inline:true},
      {name:'Position',value:isFinite(c.lat)?`\`${c.lat.toFixed(4)}, ${c.lon.toFixed(4)}\`\n${territories.join(', ')}`:'Unknown',inline:true},
    )
    .setFooter({text:`MRP COMMAND · ${nowZ()}`})
    .setTimestamp();
}

// ── MONITORING LOOP ───────────────────────────────────────────────────────────
async function monitorCycle(){
  const contacts=await fetchAll();
  if(!contacts.length) return;
  const cfgs=allCfgs().filter(c=>c.alertChannel&&c.territories.length);
  if(!cfgs.length) return;

  for(const c of contacts){
    const{cs,acid,lat,lon}=c;
    if(!cs||!isFinite(lat)||!isFinite(lon)) continue;
    const key=ckey(cs,acid);
    pushPos(key,lat,lon);
    const here=boxesAt(lat,lon);
    if(!here.length) continue;

    for(const cfg of cfgs){
      const matched=cfg.territories.filter(t=>here.some(h=>h.toLowerCase()===t.toLowerCase()));
      if(!matched.length) continue;
      const cls=classifyContact(cs,cfg.friendlyTags);
      if(cls==='FRIENDLY') continue;
      if(cls==='MRP'    &&!cfg.alertMRP)    continue;
      if(cls==='TAGGED' &&!cfg.alertTagged) continue;
      if(cls==='UNKNOWN'&&!cfg.alertUnknown)continue;
      if(cfg.ignoredCallsigns.some(i=>i.toUpperCase()===cs.toUpperCase())) continue;
      if(onCD(cfg.guildId,key,cfg.cooldownMin??CDN_MIN)) continue;
      if(Date.now()-startTs<GRACE_MS){ markCD(cfg.guildId,key); continue; }
      if(!consume()) continue;
      markCD(cfg.guildId,key);
      await sendAlert(cfg,c,matched,cls).catch(e=>console.error('[MRP] alert err:',e.message));
    }
  }
}

async function sendAlert(cfg,c,territories,cls){
  if(!bot) return;
  const ch=await bot.channels.fetch(cfg.alertChannel).catch(()=>null);
  if(!ch?.isTextBased()) return;
  const ping=cfg.pingRoles.map(r=>`<@&${r}>`).join(' ');
  const embed=cls==='MRP'?buildIdentEmbed(c,cfg,territories):buildScrambleEmbed(c,cfg,territories);
  const row=new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`ident:${c.acid||c.cs}`).setLabel('FULL IDENT').setStyle(ButtonStyle.Primary).setEmoji('🔍'),
    new ButtonBuilder().setCustomId(`ignore:${c.cs}`).setLabel('IGNORE').setStyle(ButtonStyle.Secondary).setEmoji('🔇'),
    new ButtonBuilder().setCustomId(`friendly:${parseTag(c.cs)||c.cs}`).setLabel('MARK FRIENDLY').setStyle(ButtonStyle.Success).setEmoji('✅'),
  );
  await ch.send({content:ping||undefined,embeds:[embed],components:[row]});
  if(cfg.logChannel&&cfg.logChannel!==cfg.alertChannel){
    const lch=await bot.channels.fetch(cfg.logChannel).catch(()=>null);
    if(lch?.isTextBased()){
      const tag=parseTag(c.cs);
      await lch.send({content:`\`${nowZ()}\` **${c.cs}**${tag?` [${tag}]`:''} | ${cls} | ${territories.join('/')} | ${fmtAlt(c.alt)} | ${fmtSpd(c.spd)}`});
    }
  }
}

// ── SLASH COMMANDS ────────────────────────────────────────────────────────────
const CMDS=[
  new SlashCommandBuilder().setName('territory').setDescription('Manage monitored territories')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand(s=>s.setName('add').setDescription('Add a territory')
      .addStringOption(o=>o.setName('name').setDescription('Territory name').setRequired(true).setAutocomplete(true)))
    .addSubcommand(s=>s.setName('remove').setDescription('Remove a territory')
      .addStringOption(o=>o.setName('name').setDescription('Territory name').setRequired(true).setAutocomplete(true)))
    .addSubcommand(s=>s.setName('list').setDescription('List territories')),

  new SlashCommandBuilder().setName('config').setDescription('Bot configuration')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand(s=>s.setName('alert_channel').setDescription('Set alert channel')
      .addChannelOption(o=>o.setName('channel').setDescription('Channel').setRequired(true)))
    .addSubcommand(s=>s.setName('log_channel').setDescription('Set log channel')
      .addChannelOption(o=>o.setName('channel').setDescription('Channel').setRequired(true)))
    .addSubcommand(s=>s.setName('role').setDescription('Add/remove ping role')
      .addRoleOption(o=>o.setName('role').setDescription('Role').setRequired(true))
      .addStringOption(o=>o.setName('action').setDescription('add or remove').setRequired(false)
        .addChoices({name:'add',value:'add'},{name:'remove',value:'remove'})))
    .addSubcommand(s=>s.setName('friendly').setDescription('Mark tag as friendly')
      .addStringOption(o=>o.setName('tag').setDescription('Tag e.g. USAF').setRequired(true))
      .addStringOption(o=>o.setName('action').setDescription('add or remove').setRequired(false)
        .addChoices({name:'add',value:'add'},{name:'remove',value:'remove'})))
    .addSubcommand(s=>s.setName('cooldown').setDescription('Alert cooldown minutes')
      .addIntegerOption(o=>o.setName('minutes').setDescription('Minutes').setRequired(true).setMinValue(1).setMaxValue(1440)))
    .addSubcommand(s=>s.setName('alerts').setDescription('Toggle alert types')
      .addStringOption(o=>o.setName('type').setDescription('Type').setRequired(true)
        .addChoices({name:'MRP',value:'mrp'},{name:'Tagged',value:'tagged'},{name:'Unknown',value:'unknown'}))
      .addBooleanOption(o=>o.setName('enabled').setDescription('Enable').setRequired(true)))
    .addSubcommand(s=>s.setName('view').setDescription('Show config')),

  new SlashCommandBuilder().setName('ignore').setDescription('Ignore callsigns')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand(s=>s.setName('add').setDescription('Add callsign')
      .addStringOption(o=>o.setName('callsign').setDescription('Callsign').setRequired(true)))
    .addSubcommand(s=>s.setName('remove').setDescription('Remove callsign')
      .addStringOption(o=>o.setName('callsign').setDescription('Callsign').setRequired(true)))
    .addSubcommand(s=>s.setName('list').setDescription('List ignored')),

  new SlashCommandBuilder().setName('radar').setDescription('Live radar snapshot')
    .addStringOption(o=>o.setName('filter').setDescription('Filter type').setRequired(false)
      .addChoices({name:'All',value:'all'},{name:'MRP only',value:'mrp'},
                  {name:'Tagged',value:'tagged'},{name:'Unknown',value:'unknown'})),

  new SlashCommandBuilder().setName('ident').setDescription('Full IDENT card for a callsign')
    .addStringOption(o=>o.setName('callsign').setDescription('Callsign').setRequired(true)),

  new SlashCommandBuilder().setName('sitrep').setDescription('Full situation report'),

  new SlashCommandBuilder().setName('history').setDescription('Recently tracked contacts')
    .addIntegerOption(o=>o.setName('minutes').setDescription('Look back minutes (default 30)').setRequired(false).setMinValue(1).setMaxValue(720)),
].map(c=>c.toJSON());

// ── COMMAND HANDLERS ──────────────────────────────────────────────────────────
async function handleTerritory(i){
  const sub=i.options.getSubcommand(),gid=i.guildId;
  const cfg=loadCfg(gid); cfg.guildId=gid;
  if(sub==='add'){
    const raw=i.options.getString('name',true).trim();
    const r=resolveBox(raw);
    if(!r) return i.reply({content:`❌ Territory **${raw}** not found.`,ephemeral:true});
    if(cfg.territories.some(t=>t.toLowerCase()===r.toLowerCase()))
      return i.reply({content:`**${r}** is already monitored.`,ephemeral:true});
    cfg.territories.push(r); saveCfg(cfg);
    return i.reply({embeds:[new EmbedBuilder().setColor(COL.FRIENDLY)
      .setTitle('✅ Territory Added').setDescription(`Now monitoring **${r}**\nTotal: **${cfg.territories.length}**`)]});
  }
  if(sub==='remove'){
    const raw=i.options.getString('name',true).trim(),before=cfg.territories.length;
    cfg.territories=cfg.territories.filter(t=>t.toLowerCase()!==raw.toLowerCase());
    if(cfg.territories.length===before) return i.reply({content:`**${raw}** wasn't in your list.`,ephemeral:true});
    saveCfg(cfg);
    return i.reply({content:`Removed **${raw}**.`});
  }
  if(sub==='list'){
    return i.reply({embeds:[new EmbedBuilder().setColor(COL.SITREP)
      .setTitle('◈ MONITORED TERRITORIES')
      .setDescription(cfg.territories.length
        ?cfg.territories.map((t,n)=>`\`${String(n+1).padStart(2,'0')}\` ${t}`).join('\n')
        :'No territories configured.')
      .setFooter({text:`${cfg.territories.length} territories · ${nowZ()}`})],ephemeral:true});
  }
}

async function handleConfig(i){
  const sub=i.options.getSubcommand(),gid=i.guildId;
  const cfg=loadCfg(gid); cfg.guildId=gid;
  if(sub==='alert_channel'){ const ch=i.options.getChannel('channel',true); cfg.alertChannel=ch.id; saveCfg(cfg); return i.reply({content:`✅ Alerts → <#${ch.id}>`}); }
  if(sub==='log_channel'){   const ch=i.options.getChannel('channel',true); cfg.logChannel=ch.id;   saveCfg(cfg); return i.reply({content:`✅ Log → <#${ch.id}>`}); }
  if(sub==='role'){
    const role=i.options.getRole('role',true),act=i.options.getString('action')||'add';
    if(act==='remove') cfg.pingRoles=cfg.pingRoles.filter(r=>r!==role.id);
    else if(!cfg.pingRoles.includes(role.id)) cfg.pingRoles.push(role.id);
    saveCfg(cfg);
    return i.reply({content:`✅ <@&${role.id}> ${act==='remove'?'removed':'added'}.`});
  }
  if(sub==='friendly'){
    const tag=i.options.getString('tag',true).trim().toUpperCase(),act=i.options.getString('action')||'add';
    if(act==='remove') cfg.friendlyTags=cfg.friendlyTags.filter(t=>t.toUpperCase()!==tag);
    else if(!cfg.friendlyTags.some(t=>t.toUpperCase()===tag)) cfg.friendlyTags.push(tag);
    saveCfg(cfg);
    return i.reply({content:`✅ \`[${tag}]\` ${act==='remove'?'removed':'marked friendly'}.`});
  }
  if(sub==='cooldown'){ const m=i.options.getInteger('minutes',true); cfg.cooldownMin=m; saveCfg(cfg); return i.reply({content:`✅ Cooldown: **${m} min**.`}); }
  if(sub==='alerts'){
    const type=i.options.getString('type',true),en=i.options.getBoolean('enabled',true);
    if(type==='mrp') cfg.alertMRP=en; if(type==='tagged') cfg.alertTagged=en; if(type==='unknown') cfg.alertUnknown=en;
    saveCfg(cfg);
    return i.reply({content:`✅ **${{mrp:'MRP',tagged:'Tagged',unknown:'Unknown'}[type]}** alerts: ${en?'🟢 ON':'🔴 OFF'}`});
  }
  if(sub==='view'){
    return i.reply({embeds:[new EmbedBuilder().setColor(COL.SITREP)
      .setTitle('⚙️ SERVER CONFIG')
      .addFields(
        {name:'Channels',value:`Alert: ${cfg.alertChannel?`<#${cfg.alertChannel}>`:'⚠️ NOT SET'}\nLog: ${cfg.logChannel?`<#${cfg.logChannel}>`:'none'}`,inline:true},
        {name:'Roles',value:cfg.pingRoles.length?cfg.pingRoles.map(r=>`<@&${r}>`).join('\n'):'none',inline:true},
        {name:'Cooldown',value:`${cfg.cooldownMin??CDN_MIN} min`,inline:true},
        {name:'Territories',value:cfg.territories.length?cfg.territories.join(', '):'⚠️ none',inline:false},
        {name:'Friendly Tags',value:cfg.friendlyTags.length?cfg.friendlyTags.map(t=>`\`[${t}]\``).join(' '):'none',inline:true},
        {name:'Alert Types',value:`MRP: ${cfg.alertMRP!==false?'✅':'❌'} · Tagged: ${cfg.alertTagged!==false?'✅':'❌'} · Unknown: ${cfg.alertUnknown?'✅':'❌'}`,inline:true},
        {name:'Ignored',value:cfg.ignoredCallsigns.length?cfg.ignoredCallsigns.map(c=>`\`${c}\``).join(', '):'none',inline:false},
      ).setFooter({text:nowZ()})],ephemeral:true});
  }
}

async function handleIgnore(i){
  const sub=i.options.getSubcommand(),gid=i.guildId;
  const cfg=loadCfg(gid); cfg.guildId=gid;
  if(sub==='add'){
    const cs=i.options.getString('callsign',true).trim().toUpperCase();
    if(!cfg.ignoredCallsigns.includes(cs)) cfg.ignoredCallsigns.push(cs);
    saveCfg(cfg); return i.reply({content:`🔇 \`${cs}\` ignored.`});
  }
  if(sub==='remove'){
    const cs=i.options.getString('callsign',true).trim().toUpperCase();
    cfg.ignoredCallsigns=cfg.ignoredCallsigns.filter(c=>c!==cs);
    saveCfg(cfg); return i.reply({content:`✅ \`${cs}\` unignored.`});
  }
  if(sub==='list') return i.reply({content:cfg.ignoredCallsigns.length?`**Ignored:**\n${cfg.ignoredCallsigns.map(c=>`• \`${c}\``).join('\n')}`:'None ignored.',ephemeral:true});
}

async function handleRadar(i){
  await i.deferReply();
  const gid=i.guildId,filter=i.options.getString('filter')||'all';
  const cfg=loadCfg(gid);
  if(!cfg.territories.length) return i.editReply({content:'⚠️ No territories configured.'});
  const contacts=await fetchAll();
  const hits=contacts.filter(c=>{
    if(!c.cs||!isFinite(c.lat)) return false;
    if(cfg.ignoredCallsigns.some(ic=>ic.toUpperCase()===c.cs.toUpperCase())) return false;
    const here=boxesAt(c.lat,c.lon);
    if(!cfg.territories.some(t=>here.some(h=>h.toLowerCase()===t.toLowerCase()))) return false;
    const cls=classifyContact(c.cs,cfg.friendlyTags);
    if(cls==='FRIENDLY') return false;
    if(filter==='mrp')     return cls==='MRP';
    if(filter==='tagged')  return cls==='TAGGED';
    if(filter==='unknown') return cls==='UNKNOWN';
    return true;
  });
  const order={MRP:0,TAGGED:1,UNKNOWN:2};
  hits.sort((a,b)=>(order[classifyContact(a.cs,cfg.friendlyTags)]||2)-(order[classifyContact(b.cs,cfg.friendlyTags)]||2));
  if(!hits.length){
    return i.editReply({embeds:[new EmbedBuilder().setColor(COL.CLEAR)
      .setTitle('📡 RADAR — CLEAR').setDescription(`No contacts.\n*${cfg.territories.join(', ')}*`).setFooter({text:nowZ()})]});
  }
  const mrpHits=hits.filter(c=>classifyContact(c.cs,cfg.friendlyTags)==='MRP');
  const otherHits=hits.filter(c=>classifyContact(c.cs,cfg.friendlyTags)!=='MRP');
  const embeds=[];
  for(const c of mrpHits.slice(0,4)){
    const here=boxesAt(c.lat,c.lon).filter(t=>cfg.territories.some(w=>w.toLowerCase()===t.toLowerCase()));
    embeds.push(buildIdentEmbed(c,cfg,here));
  }
  if(otherHits.length||mrpHits.length>4){
    const remaining=[...mrpHits.slice(4),...otherHits];
    const lines=remaining.map(c=>{
      const tag=parseTag(c.cs),cls=classifyContact(c.cs,cfg.friendlyTags);
      const icon={MRP:'🔵',TAGGED:'🔴',UNKNOWN:'⚫'}[cls]||'⚫';
      const here=boxesAt(c.lat,c.lon).filter(t=>cfg.territories.some(w=>w.toLowerCase()===t.toLowerCase()));
      return`${icon} \`${c.cs}\`${tag?` [${tag}]`:''} | ${here.join('/')||'?'} | ${fmtAlt(c.alt)} | ${fmtSpd(c.spd)}`;
    });
    embeds.push(new EmbedBuilder().setColor(COL.SITREP)
      .setTitle(`📡 RADAR — ${hits.length} CONTACT${hits.length!==1?'S':''}`)
      .setDescription(lines.join('\n').slice(0,4096)||'—')
      .addFields({name:'Summary',value:`🔵 MRP: **${mrpHits.length}** · 🔴 Tagged: **${otherHits.filter(c=>classifyContact(c.cs,cfg.friendlyTags)==='TAGGED').length}** · ⚫ Unknown: **${otherHits.filter(c=>classifyContact(c.cs,cfg.friendlyTags)==='UNKNOWN').length}**`,inline:false})
      .setFooter({text:`${hits.length} total · ${nowZ()}`}));
  }
  return i.editReply({embeds:embeds.slice(0,10)});
}

async function handleIdent(i){
  await i.deferReply();
  const cs=i.options.getString('callsign',true).trim().toUpperCase();
  const cfg=loadCfg(i.guildId);
  const contacts=await fetchAll();
  const c=contacts.find(x=>x.cs.toUpperCase()===cs);
  if(!c) return i.editReply({content:`❌ **${cs}** not found online.`});
  const here=boxesAt(c.lat,c.lon);
  pushPos(ckey(c.cs,c.acid),c.lat,c.lon);
  // Fetch fresh Osprey data for this specific pilot
  const osp=c.acid?await fetchOspreyByAcid(c.acid):await fetchOspreyByCallsign(cs);
  return i.editReply({embeds:[buildIdentEmbed(c,cfg,here,osp)]});
}

async function handleSitrep(i){
  await i.deferReply();
  const cfg=loadCfg(i.guildId);
  if(!cfg.territories.length) return i.editReply({content:'⚠️ No territories configured.'});
  const contacts=await fetchAll();
  const byT=new Map();
  for(const c of contacts){
    if(!c.cs||!isFinite(c.lat)) continue;
    const here=boxesAt(c.lat,c.lon);
    const matched=cfg.territories.filter(t=>here.some(h=>h.toLowerCase()===t.toLowerCase()));
    for(const t of matched){ if(!byT.has(t)) byT.set(t,[]); byT.get(t).push(c); }
  }
  const e=new EmbedBuilder().setColor(COL.SITREP).setTitle('◈ SITUATION REPORT').setTimestamp();
  let tMRP=0,tTag=0,tUnk=0;
  for(const[territory,cs2] of byT){
    const mrp=cs2.filter(c=>classifyContact(c.cs,cfg.friendlyTags)==='MRP');
    const tagged=cs2.filter(c=>classifyContact(c.cs,cfg.friendlyTags)==='TAGGED');
    const unk=cs2.filter(c=>classifyContact(c.cs,cfg.friendlyTags)==='UNKNOWN');
    const fri=cs2.filter(c=>classifyContact(c.cs,cfg.friendlyTags)==='FRIENDLY');
    tMRP+=mrp.length; tTag+=tagged.length; tUnk+=unk.length;
    const lines=[
      mrp.length   ?`🔵 **MRP (${mrp.length}):** ${mrp.slice(0,5).map(c=>`\`${c.cs}\``).join(', ')}${mrp.length>5?` +${mrp.length-5}`:''}`:null,
      tagged.length?`🔴 **Tagged (${tagged.length}):** ${tagged.slice(0,5).map(c=>`\`${c.cs}\``).join(', ')}${tagged.length>5?` +${tagged.length-5}`:''}`:null,
      unk.length   ?`⚫ **Unknown (${unk.length}):** ${unk.slice(0,3).map(c=>`\`${c.cs}\``).join(', ')}${unk.length>3?` +${unk.length-3}`:''}`:null,
      fri.length   ?`🟢 **Friendly (${fri.length})**`:null,
    ].filter(Boolean);
    if(lines.length) e.addFields({name:`📍 ${territory}`,value:lines.join('\n'),inline:false});
  }
  e.addFields({name:'TOTAL',value:`🔵 MRP: **${tMRP}** · 🔴 Tagged: **${tTag}** · ⚫ Unknown: **${tUnk}**`,inline:false});
  e.setFooter({text:`MRP COMMAND · ${nowZ()}`});
  return i.editReply({embeds:[e]});
}

async function handleHistory(i){
  await i.deferReply({ephemeral:true});
  const mins=i.options.getInteger('minutes')||30;
  const cutoff=Date.now()-mins*60_000,cfg=loadCfg(i.guildId);
  const lines=[];
  for(const[key,ts] of contactSeen){
    if(ts<cutoff) continue;
    const cs=key.split(':')[0],tag=parseTag(cs),cls=classifyContact(cs,cfg.friendlyTags);
    const icon={MRP:'🔵',TAGGED:'🔴',UNKNOWN:'⚫',FRIENDLY:'🟢'}[cls]||'⚫';
    lines.push(`${icon} \`${cs}\`${tag?` [${tag}]`:''} — first seen ${fmtTs(ts)}`);
  }
  lines.sort();
  return i.editReply({embeds:[new EmbedBuilder().setColor(COL.SITREP)
    .setTitle(`📋 HISTORY — Last ${mins} min`)
    .setDescription(lines.length?lines.slice(0,40).join('\n'):'No contacts.')
    .setFooter({text:`${lines.length} contacts · ${nowZ()}`})]});
}

// ── BUTTON HANDLER ────────────────────────────────────────────────────────────
async function handleButton(i){
  const[action,value]=i.customId.split(':');
  const cfg=loadCfg(i.guildId); cfg.guildId=i.guildId;
  if(action==='ident'){
    await i.deferReply({ephemeral:true});
    const contacts=await fetchAll();
    const c=contacts.find(x=>x.acid===value||x.cs.toUpperCase()===value.toUpperCase());
    if(!c) return i.editReply({content:'❌ Contact not found online.'});
    const here=boxesAt(c.lat,c.lon);
    const osp=c.acid?await fetchOspreyByAcid(c.acid):await fetchOspreyByCallsign(value);
    return i.editReply({embeds:[buildIdentEmbed(c,cfg,here,osp)]});
  }
  if(action==='ignore'){
    const cs=value.toUpperCase();
    if(!cfg.ignoredCallsigns.includes(cs)) cfg.ignoredCallsigns.push(cs);
    saveCfg(cfg); return i.reply({content:`🔇 \`${cs}\` ignored.`,ephemeral:true});
  }
  if(action==='friendly'){
    const tag=value.toUpperCase();
    if(!cfg.friendlyTags.some(t=>t.toUpperCase()===tag)) cfg.friendlyTags.push(tag);
    saveCfg(cfg); return i.reply({content:`✅ \`[${tag}]\` marked friendly.`,ephemeral:true});
  }
}

// ── AUTOCOMPLETE ──────────────────────────────────────────────────────────────
async function handleAC(i){
  if(i.commandName!=='territory') return i.respond([]);
  const sub=i.options.getSubcommand(),q=i.options.getFocused().trim().toLowerCase();
  if(sub==='add') return i.respond(BOXES.map(b=>b.name).filter(n=>!q||n.toLowerCase().includes(q)).slice(0,25).map(n=>({name:n,value:n})));
  if(sub==='remove'){ const cfg=loadCfg(i.guildId); return i.respond(cfg.territories.filter(c=>!q||c.toLowerCase().includes(q)).slice(0,25).map(c=>({name:c,value:c}))); }
  return i.respond([]);
}

// ── BOT SETUP ─────────────────────────────────────────────────────────────────
let bot=null;

async function registerCmds(){
  const rest=new REST({version:'10'}).setToken(TOKEN);
  const allCmds=[...CMDS,...PatrolLog.CMDS];
  console.log(`[MRP] Registering ${allCmds.length} commands...`);
  await rest.put(Routes.applicationCommands(APP_ID),{body:allCmds});
  console.log('[MRP] Commands registered.');
}

async function main(){
  if(!TOKEN||!APP_ID){ console.error('[MRP] BOT_TOKEN and BOT_APP_ID required.'); process.exit(1); }
  bot=new Client({intents:[GatewayIntentBits.Guilds]});

  bot.once('ready',async()=>{
    console.log(`[MRP] Online as ${bot.user?.tag}`);
    bot.user?.setPresence({status:'online',activities:[{name:'GeoFS airspace | /radar',type:3}]});
    await registerCmds().catch(e=>console.error('[MRP] Cmd reg failed:',e.message));
    PatrolLog.init(bot,DATA_DIR);
    // Pre-warm Osprey identity cache
    fetchOspreyIdentity().catch(()=>{});
    void monitorCycle().catch(e=>console.warn('[MRP] Initial poll:',e.message));
    setInterval(()=>monitorCycle().catch(e=>console.warn('[MRP] Poll:',e.message)),POLL_MS).unref();
  });

  bot.on('interactionCreate',async i=>{
    if(i.isAutocomplete()) return void await handleAC(i).catch(()=>i.respond([]).catch(()=>{}));
    if(i.isButton()) return void await handleButton(i).catch(e=>{
      console.error('[MRP] Button:',e.message);
      i.reply({content:'❌ Error.',ephemeral:true}).catch(()=>{});
    });
    if(!i.isChatInputCommand()) return;
    if(await PatrolLog.handleInteraction(i).catch(()=>false)) return;
    try{
      switch(i.commandName){
        case'territory': return void await handleTerritory(i);
        case'config':    return void await handleConfig(i);
        case'ignore':    return void await handleIgnore(i);
        case'radar':     return void await handleRadar(i);
        case'ident':     return void await handleIdent(i);
        case'sitrep':    return void await handleSitrep(i);
        case'history':   return void await handleHistory(i);
      }
    }catch(e){
      console.error('[MRP] Cmd error:',e.message);
      const fn=i.replied||i.deferred?i.followUp.bind(i):i.reply.bind(i);
      await fn({content:`❌ ${e.message||'Unknown error'}`,ephemeral:true}).catch(()=>{});
    }
  });

  bot.on('error',e=>console.error('[MRP] Discord error:',e.message));
  process.on('SIGINT', ()=>{console.log('\n[MRP] Shutdown.');process.exit(0);});
  process.on('SIGTERM',()=>{console.log('\n[MRP] Shutdown.');process.exit(0);});
  await bot.login(TOKEN);
}

main().catch(e=>{console.error('[MRP] Fatal:',e.message||e);process.exit(1);});
