(() => {
  'use strict';
  if (window.__BILI_LIVE_HELPER_V1__) return;
  window.__BILI_LIVE_HELPER_V1__ = true;
  let working=false;
  let lastInput=0;
  let composing=false;
  let stopped=false;
  const userInput = e => { if (e.isTrusted) lastInput=Date.now(); };
  document.addEventListener('keydown',userInput,true);
  document.addEventListener('input',userInput,true);
  document.addEventListener('compositionstart',()=>{composing=true;},true);
  document.addEventListener('compositionend',()=>{composing=false;lastInput=Date.now();},true);
  window.addEventListener('pagehide',()=>{stopped=true;});
  window.addEventListener('pageshow',()=>{stopped=false;});

  function roomId() {
    return location.hostname==='live.bilibili.com' && location.protocol==='https:' ?
      location.pathname.match(/^\/(?:blanc\/)?([1-9]\d*)\/?$/)?.[1] || null : null;
  }
  function rendered(el) {
    if (!el || !el.isConnected) return false;
    const css=getComputedStyle(el);
    return css.display!=='none' && css.visibility!=='hidden' && el.getClientRects().length>0;
  }
  function editable(el) {
    return !!el && (el.matches?.('input,textarea,select') || el.isContentEditable);
  }
  function busy() {
    return composing || editable(document.activeElement) || Date.now()-lastInput<5000;
  }
  function controls() {
    const candidates=[...document.querySelectorAll('textarea.chat-input')].filter(rendered);
    const input=candidates.length===1 ? candidates[0] : null;
    const wrapper=input?.closest('.chat-input-ctnr');
    const buttons=[...(wrapper?.querySelectorAll('button.send-btn') || [])]
      .filter(x=>rendered(x) && x.textContent.trim()==='发送');
    const send=buttons.length===1 ? buttons[0] : null;
    const likes=[...document.querySelectorAll('.like-btn')].filter(rendered);
    return {input,send,like:likes.length===1 ? likes[0] : null};
  }
  function canChat(c) {
    return c.input && c.send && !c.input.disabled && !c.input.readOnly &&
      c.input.value==='' && !busy();
  }
  function offline() {
    // Conservative visible-player hint, not a server-side live-status assertion.
    const candidates=document.querySelectorAll('.player-ctnr .room-not-live, .player-ctnr .not-live, .live-player-mounter .not-live');
    return [...candidates].some(x=>rendered(x) && /休息|未开播|不在|结束/.test(x.textContent));
  }
  async function message(body) {
    try { return await chrome.runtime.sendMessage(body); }
    catch {
      // Extension reload invalidates this content script. Refresh the room to recover.
      stopped=true;
      console.warn('[B站直播助手] 扩展已重载或不可用，请刷新直播间。');
      return null;
    }
  }
  async function doLike(op,room) {
    const c=controls();
    if (!c.like || busy() || offline() || roomId()!==room) {
      await message({type:'report',room,token:op.token,executed:false});
      return;
    }
    let began=false;
    try {
      if (op.mode==='button') {
        began=true;
        c.like.click();
      } else {
        // Synthetic events have isTrusted=false; never claims a real hardware keypress.
        const target=document.body || document.documentElement;
        for (const type of ['keydown','keypress','keyup']) {
          const event=new KeyboardEvent(type,{key:'k',code:'KeyK',keyCode:75,which:75,
            charCode:type==='keypress' ? 107 : 0,bubbles:true,cancelable:true});
          began=true;
          target.dispatchEvent(event);
        }
      }
    } finally {
      await message({type:'report',room,token:op.token,executed:began});
    }
  }
  async function doChat(op,room) {
    const c=controls();
    if (roomId()!==room || !canChat(c) || offline()) {
      await message({type:'report',room,token:op.token,result:'弹幕已跳过：输入框忙或状态改变'});
      return;
    }
    try {
      const setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')?.set;
      if (!setter) throw new Error('原生输入接口不可用');
      setter.call(c.input,op.text);
      c.input.dispatchEvent(new Event('input',{bubbles:true}));
      c.input.dispatchEvent(new Event('change',{bubbles:true}));
      await new Promise(resolve=>setTimeout(resolve,100));
      // Never focus the editor, erase a user's draft, press Enter, or send a second time.
      if (roomId()!==room || busy() || c.input.value!==op.text || c.send.disabled ||
          c.send.getAttribute('aria-disabled')==='true' ||
          !c.send.isConnected || !c.input.isConnected || !rendered(c.send)) {
        await message({type:'report',room,token:op.token,
          result:`弹幕未提交：页面状态改变；请检查输入框中保留的${op.text}`});
        return;
      }
      c.send.click();
      await new Promise(resolve=>setTimeout(resolve,1000));
      const result=c.input.isConnected && c.input.value==='' ?
        `已尝试发送${op.text}，输入框已清空；平台是否入账未核验` :
        `已尝试发送${op.text}，但输入框未清空；请检查登录、禁言、限流或草稿，不自动重试`;
      await message({type:'report',room,token:op.token,result});
    } catch {
      await message({type:'report',room,token:op.token,
        result:'弹幕操作异常，结果未知；未补发，请检查页面'});
    }
  }
  async function tick() {
    if (stopped || working) return;
    const room=roomId();
    if (!room) return;
    const c=controls();
    // A numeric landing page alone is NOT a room. Run only in a frame with actual controls.
    if (!c.input || !c.send || !c.like) return;
    working=true;
    try {
      const res=await message({type:'tick',room,ready:true,busy:busy(),offline:offline(),
        canLike:!!c.like,canChat:!!canChat(c)});
      if (!res?.allowed || roomId()!==room) return;
      if (res.like) await doLike(res.like,room);
      if (res.chat) await doChat(res.chat,room);
    } catch (error) {
      console.warn('[B站直播助手] 本轮已停止，不盲目重试。',error?.name || 'Error');
    } finally { working=false; }
  }
  setInterval(tick,750);
  void tick();
})();
