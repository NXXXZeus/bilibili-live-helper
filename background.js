'use strict';
// No cookies, private APIs, debugger, remote code or account tokens are used.
const DEFAULTS = Object.freeze({enabled:true, likesEnabled:true, chatEnabled:true,
  likeMode:'keyboard', roomScope:'all', roomIds:[], likeScope:'visit',
  chatMinutes:2, chatText:'🫡'});
function chatInterval(prefs) { return prefs.chatMinutes * 60000; }
function chatError(raw) {
  if (raw?.chatMinutes !== undefined &&
      (!Number.isInteger(raw.chatMinutes) || raw.chatMinutes < 1 || raw.chatMinutes > 10)) {
    return '发送间隔只能选择1到10分钟的整数。';
  }
  if (raw?.chatText !== undefined && (typeof raw.chatText !== 'string' ||
      !raw.chatText.trim() || [...raw.chatText].length > 200 || /[\r\n\u0000-\u001f\u007f]/.test(raw.chatText))) {
    return '弹幕内容不能为空、全空格或多行，最多200个字符（表情按Unicode码点计）。';
  }
  return null;
}
const LIKE_INTERVAL = 650;
const LEASE_MS = 25000;
const VISIT_GAP = 90000;
let queue = Promise.resolve();

function parseRoom(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' || u.hostname !== 'live.bilibili.com') return null;
    return u.pathname.match(/^\/(?:blanc\/)?([1-9]\d*)\/?$/)?.[1] || null;
  } catch { return null; }
}
function dayKey(now) {
  return new Date(now + 8 * 3600000).toISOString().slice(0, 10); // China UTC+8
}
function sanitizeSettings(raw) {
  const s = {...DEFAULTS};
  for (const k of ['enabled','likesEnabled','chatEnabled']) {
    if (typeof raw?.[k] === 'boolean') s[k] = raw[k];
  }
  s.likeMode = raw?.likeMode === 'button' ? 'button' : 'keyboard';
  s.roomScope = raw?.roomScope === 'selected' ? 'selected' : 'all';
  s.likeScope = raw?.likeScope === 'daily' ? 'daily' : 'visit';
  s.roomIds = [...new Set((Array.isArray(raw?.roomIds) ? raw.roomIds : [])
    .map(String).filter(x => /^[1-9]\d*$/.test(x)))].slice(0, 100);
  if (Number.isInteger(raw?.chatMinutes) && raw.chatMinutes >= 1 && raw.chatMinutes <= 10) {
    s.chatMinutes=raw.chatMinutes;
  }
  if (typeof raw?.chatText === 'string' && raw.chatText.trim() &&
      [...raw.chatText].length <= 200 && !/[\r\n\u0000-\u001f\u007f]/.test(raw.chatText)) {
    s.chatText=raw.chatText; // Preserve literal content and spaces; never silently truncate.
  }
  return s;
}
async function settings() {
  const data = await chrome.storage.local.get('settings');
  return sanitizeSettings(data.settings);
}
function freshState(now, prefs) {
  return {count:0, lastSeen:now, day:dayKey(now), owner:null, leaseUntil:0,
    nextLike:now, nextChat:now+chatInterval(prefs), status:'等待直播间控件',
    lastChat:'尚未发送', events:[], outstanding:{}};
}
function log(s, text, now) {
  s.events.unshift({at:now, text});
  s.events = s.events.slice(0, 12);
}
function id() { return crypto.randomUUID(); }
function isExtensionUI(sender) {
  return !sender.tab && typeof sender.url === 'string' &&
    sender.url.startsWith(chrome.runtime.getURL(''));
}
async function handle(msg, sender) {
  const prefs = await settings();
  const now = Date.now();
  if (isExtensionUI(sender)) {
    if (msg.type === 'settings') return {settings:prefs};
    if (msg.type === 'save') {
      const error=chatError(msg.settings);
      if (error) return {ok:false,error};
      const next = sanitizeSettings(msg.settings);
      await chrome.storage.local.set({settings:next});
      const chatChanged=next.chatMinutes!==prefs.chatMinutes || next.chatText!==prefs.chatText;
      if (chatChanged) {
        const data=await chrome.storage.session.get('rooms');
        const rooms=data.rooms || {};
        for (const s of Object.values(rooms)) {
          s.nextChat=now+chatInterval(next);
          log(s,`弹幕设置已更新，从保存起重新等待${next.chatMinutes}分钟`,now);
        }
        await chrome.storage.session.set({rooms});
      }
      return {ok:true, settings:next,chatChanged};
    }
    const data = await chrome.storage.session.get('rooms');
    const rooms = data.rooms || {};
    if (msg.type === 'status') {
      return {settings:prefs, rooms:Object.entries(rooms)
        .filter(([,s]) => now - s.lastSeen < 180000)
        .map(([room,s]) => ({room,count:s.count,status:s.status,nextChat:s.nextChat,
          lastChat:s.lastChat,events:s.events,lastSeen:s.lastSeen}))};
    }
    if (msg.type === 'reset' && /^[1-9]\d*$/.test(String(msg.room))) {
      const room = String(msg.room);
      if (rooms[room]) {
        const s = rooms[room];
        if (Object.keys(s.outstanding || {}).length) {
          return {ok:false,error:'操作尚未结束，请稍后重试'};
        }
        s.count=0; s.nextLike=now; log(s,'手动重置点赞计数',now);
        await chrome.storage.session.set({rooms});
      }
      return {ok:true};
    }
    return {ok:false,error:'未知操作'};
  }
  const room = parseRoom(sender.url);
  if (!room || !Number.isInteger(sender.tab?.id) || msg.room !== room) {
    return {allowed:false,reason:'不是受支持的直播间页面'};
  }
  const frameOwner = `${sender.tab.id}:${sender.frameId || 0}`;
  const who = `${frameOwner}:${sender.documentId || ''}`;
  const data = await chrome.storage.session.get('rooms');
  const rooms = data.rooms || {};
  let s = rooms[room] || freshState(now, prefs);
  s.outstanding ||= {};
  // Reserved attempts survive reload. Expired reservations are not replayed.
  for (const [token,op] of Object.entries(s.outstanding)) {
    if (now-op.at > 30000) {
      log(s,`${op.kind === 'like' ? '点赞' : '弹幕'}反馈超时，结果未知；不补发`,now);
      delete s.outstanding[token];
    }
  }
  if (msg.type === 'report') {
    const op = s.outstanding[msg.token];
    if (op && op.owner === who) {
      delete s.outstanding[msg.token];
      if (op.kind === 'like') {
        if (msg.executed === false) s.count = Math.max(0,s.count-1);
        s.status = msg.executed === false ? '点赞已跳过，等待输入结束' :
          `已进行 ${s.count}/40 次点赞尝试（未核验平台入账）`;
        if (s.count === 40 || msg.executed === false) log(s,s.status,now);
      } else {
        s.lastChat = String(msg.result || '发送结果未知').slice(0,140);
        log(s,s.lastChat,now);
      }
      rooms[room]=s;
      await chrome.storage.session.set({rooms});
    }
    return {ok:true};
  }
  if (msg.type !== 'tick') return {allowed:false,reason:'未知操作'};
  if (!prefs.enabled || (prefs.roomScope === 'selected' && !prefs.roomIds.includes(room))) {
    return {allowed:false,reason:!prefs.enabled ? '已暂停' : '不在指定房间范围'};
  }
  if (msg.ready !== true) return {allowed:false,reason:'等待直播间控件'};
  // A long timer gap in the SAME document is not a new visit (background throttling).
  if (now-s.lastSeen > VISIT_GAP && prefs.likeScope === 'visit' && s.owner !== who) {
    s=freshState(now, prefs);
  }
  if (s.day !== dayKey(now) && prefs.likeScope === 'daily') {
    s.count=0; s.day=dayKey(now); s.nextLike=now;
  }
  s.lastSeen=now;
  if (s.owner && s.owner !== who && !s.owner.startsWith(frameOwner+':') && s.leaseUntil > now) {
    rooms[room]=s;
    await chrome.storage.session.set({rooms});
    return {allowed:false,reason:'同房间另一标签页正在执行'};
  }
  s.owner=who; s.leaseUntil=now+LEASE_MS;
  s.status = msg.busy ? '输入中：自动操作暂缓' :
    (msg.offline ? '检测到休息提示：自动操作暂缓' :
      `点赞尝试 ${s.count}/40；等待下一次弹幕`);
  const response = {allowed:true,settings:prefs,room,count:s.count,nextChat:s.nextChat};
  if (!msg.busy && !msg.offline) {
    if (prefs.likesEnabled && msg.canLike === true && s.count < 40 && now >= s.nextLike &&
        !Object.values(s.outstanding).some(x=>x.kind==='like')) {
      const token=id();
      s.count++; s.nextLike=now+LIKE_INTERVAL;
      s.outstanding[token]={kind:'like',owner:who,at:now};
      response.like={token,mode:prefs.likeMode};
    }
    if (prefs.chatEnabled && msg.canChat === true && now >= s.nextChat &&
        !Object.values(s.outstanding).some(x=>x.kind==='chat')) {
      const token=id();
      // Schedule before clicking: one reservation globally, no catch-up burst.
      s.nextChat=now+chatInterval(prefs);
      s.outstanding[token]={kind:'chat',owner:who,at:now};
      response.chat={token,text:prefs.chatText};
    }
  }
  rooms[room]=s;
  // Session-only state; never records chat contents or account identifiers.
  for (const [key,value] of Object.entries(rooms)) {
    if (now-value.lastSeen > 86400000) delete rooms[key];
  }
  await chrome.storage.session.set({rooms});
  response.count=s.count; response.nextChat=s.nextChat;
  return response;
}
chrome.runtime.onMessage.addListener((msg,sender,sendResponse)=>{
  if (!msg || typeof msg.type !== 'string') return false;
  // Serialize read-modify-write operations across frames, tabs and popup.
  const operation = queue.then(()=>handle(msg,sender));
  queue=operation.catch(()=>{});
  operation.then(sendResponse).catch(()=>sendResponse({allowed:false,error:'扩展状态暂不可用'}));
  return true;
});
chrome.runtime.onInstalled.addListener(async ()=>{
  const data=await chrome.storage.local.get('settings');
  if (!data.settings) await chrome.storage.local.set({settings:{...DEFAULTS}});
});
