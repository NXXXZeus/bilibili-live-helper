'use strict';
const $=id=>document.getElementById(id);
let prefs=null;
let loading=false;
async function request(body) {
  if (!globalThis.chrome?.runtime?.sendMessage) {
    throw new Error('请先在Chrome扩展页加载本文件夹，再点击工具栏插件图标；直接打开HTML不能控制直播间。');
  }
  const response=await chrome.runtime.sendMessage(body);
  if (!response || response.error) throw new Error(response?.error || '扩展未响应');
  return response;
}
function text(tag,value,className) {
  const el=document.createElement(tag);
  el.textContent=value;
  if (className) el.className=className;
  return el;
}
function fill(s) {
  prefs=s;
  $('likes').checked=s.likesEnabled;
  $('chat').checked=s.chatEnabled;
  $('chat-minutes').value=String(s.chatMinutes);
  $('chat-text').value=s.chatText;
  summary(s);
  $('like-mode').value=s.likeMode;
  $('like-scope').value=s.likeScope;
  $('room-scope').value=s.roomScope;
  $('room-ids').value=s.roomIds.join(', ');
  $('room-field').hidden=s.roomScope!=='selected';
  $('toggle').textContent=s.enabled?'暂停全部':'启用';
  $('toggle').classList.toggle('running',s.enabled);
}
function summary(s) {
  $('chat-summary').textContent=`40次点赞尝试 · 每${s.chatMinutes}分钟发送一次“${s.chatText}”。首次发送等待所选间隔。`;
}
function render(rooms) {
  $('rooms').replaceChildren();
  if (!rooms.length) {
    $('rooms').append(text('p','尚未识别到直播间。安装或重载扩展后，请刷新直播间；只有网址和控件同时匹配才会执行。','help'));
    return;
  }
  for (const s of rooms.sort((a,b)=>b.lastSeen-a.lastSeen)) {
    const card=text('article','','room');
    const head=text('div','','room-head');
    head.append(text('strong',`房间 ${s.room}`));
    const reset=text('button','重做40次'); reset.type='button';
    reset.addEventListener('click',async()=>{
      reset.disabled=true;
      try { await request({type:'reset',room:s.room}); $('feedback').textContent='已重置点赞尝试计数'; await refresh(); }
      catch(e) { $('feedback').textContent=e.message; }
      finally { reset.disabled=false; }
    });
    head.append(reset); card.append(head);
    card.append(text('p',s.status));
    const seconds=Math.max(0,Math.ceil((s.nextChat-Date.now())/1000));
    card.append(text('p',!prefs.enabled ? '已暂停；恢复时不会补发错过的多条弹幕' :
      (!prefs.chatEnabled ? '定时弹幕已关闭' : `下一次弹幕约 ${Math.floor(seconds/60)}分${seconds%60}秒后（忙时延后）`)));
    card.append(text('p',s.lastChat,'help'));
    if (s.events?.length) {
      const list=document.createElement('ul');
      for (const e of s.events.slice(0,3)) {
        const time=new Date(e.at).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
        list.append(text('li',`${time} ${e.text}`));
      }
      card.append(list);
    }
    $('rooms').append(card);
  }
}
async function refresh() {
  if (loading) return;
  loading=true;
  try {
    const res=await request({type:'status'});
    if (!prefs) fill(res.settings);
    else { prefs=res.settings; summary(prefs); }
    $('toggle').textContent=prefs.enabled?'暂停全部':'启用';
    $('toggle').classList.toggle('running',prefs.enabled);
    render(res.rooms);
  } catch(e) { $('feedback').textContent=e.message; }
  finally { loading=false; }
}
$('room-scope').addEventListener('change',()=>{$('room-field').hidden=$('room-scope').value!=='selected';});
$('settings-form').addEventListener('submit',async e=>{
  e.preventDefault();
  if (!prefs) return;
  const ids=$('room-ids').value.trim().split(/[\s,，;；]+/).filter(Boolean);
  if ($('room-scope').value==='selected' && (!ids.length || ids.some(x=>! /^[1-9]\d*$/.test(x)))) {
    $('feedback').textContent='请填写数字房间号；不要填写完整链接。';
    return;
  }
  const chatMinutes=Number($('chat-minutes').value);
  const chatText=$('chat-text').value;
  if (!Number.isInteger(chatMinutes) || chatMinutes < 1 || chatMinutes > 10) {
    $('feedback').textContent='请选择1到10分钟的发送间隔。'; return;
  }
  if (!chatText.trim() || [...chatText].length > 200 || /[\r\n\u0000-\u001f\u007f]/.test(chatText)) {
    $('feedback').textContent='弹幕内容不能为空、全空格或多行，最多200个字符。'; return;
  }
  $('save').disabled=true;
  try {
    const res=await request({type:'save',settings:{...prefs,
      likesEnabled:$('likes').checked,chatEnabled:$('chat').checked,chatMinutes,chatText,
      likeMode:$('like-mode').value,likeScope:$('like-scope').value,
      roomScope:$('room-scope').value,roomIds:ids}});
    fill(res.settings); $('feedback').textContent=res.chatChanged ?
      `已保存，从现在起重新等待${res.settings.chatMinutes}分钟；无需刷新直播间` : '已保存，下次检测生效';
    await refresh();
  } catch(error) { $('feedback').textContent=error.message; }
  finally { $('save').disabled=false; }
});
$('toggle').addEventListener('click',async()=>{
  if (!prefs) return;
  $('toggle').disabled=true;
  try {
    const res=await request({type:'save',settings:{...prefs,enabled:!prefs.enabled}});
    fill(res.settings); $('feedback').textContent=prefs.enabled?'已启用':'已暂停，正在进行的一次操作可能已提交'; await refresh();
  } catch(error) { $('feedback').textContent=error.message; }
  finally { $('toggle').disabled=false; }
});
void refresh();
setInterval(refresh,1000);
