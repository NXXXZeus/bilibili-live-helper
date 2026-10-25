'use strict';
// Offline deterministic tests. No real Bilibili interactions, network or account access.
const fs=require('node:fs');
const vm=require('node:vm');
const assert=require('node:assert/strict');
const path=require('node:path');
const {webcrypto}=require('node:crypto');
const clone=x=>structuredClone(x);
const passed=[];
async function test(name,run) { await run(); passed.push(name); console.log('PASS '+name); }
function background() {
  let now=Date.UTC(2026,9,25,8);
  const stores={local:{},session:{}};
  let onMessage;
  const area=name=>({get:async key=>({[key]:clone(stores[name][key])}),
    set:async data=>Object.assign(stores[name],clone(data))});
  class Clock extends Date { constructor(...args){super(...(args.length?args:[now]));} static now(){return now;} }
  const chrome={storage:{local:area('local'),session:area('session')},runtime:{
    getURL:p=>'chrome-extension://test/'+p,
    onMessage:{addListener:f=>onMessage=f},onInstalled:{addListener:()=>{}}}};
  const context=vm.createContext({chrome,Date:Clock,URL,crypto:webcrypto,console});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'background.js'),'utf8'),context);
  const sender=(tab=1,frame=0,room='1883358196',documentId='doc-a')=>({tab:{id:tab},frameId:frame,documentId,
    url:`https://live.bilibili.com/blanc/${room}?liteVersion=true`});
  const ui={url:'chrome-extension://test/popup.html'};
  const send=(msg,s=sender())=>new Promise(resolve=>onMessage(msg,s,resolve));
  const tick=(extra={},s=sender())=>send({type:'tick',room:'1883358196',ready:true,
    busy:false,offline:false,canLike:true,canChat:true,...extra},s);
  const report=(op,kind='like',s=sender())=>send({type:'report',room:'1883358196',
    token:op.token,executed:true,result:kind==='chat'?'mock submitted':undefined},s);
  return {stores,context,send,tick,report,sender,ui,advance:ms=>now+=ms,now:()=>now};
}
function content(options={}) {
  let now=100000;
  let interval;
  const reports=[];
  const keys=[];
  let likeClicks=0,sendClicks=0;
  let resolveResponse;
  let requestCount=0;
  const events={};
  const winEvents={};
  class E {constructor(type,init={}){this.type=type;this.isTrusted=false;Object.assign(this,init);}}
  class Area {
    constructor(){this._value=options.draft||'';this.isConnected=true;this.disabled=false;this.readOnly=false;}
    get value(){return this._value;} set value(v){this._value=String(v);}
    getClientRects(){return [{}];}
    matches(selector){return selector.includes('textarea');}
    closest(){return {querySelectorAll:()=>[send]};}
    dispatchEvent(e){if(e.type==='input')send.disabled=this.value==='';return true;}
  }
  const input=new Area();
  const send={textContent:'发送',disabled:input.value==='',isConnected:true,
    getClientRects:()=>[{}],getAttribute:()=>null,
    click:()=>{sendClicks++; if(options.clear!==false)input.value='';}};
  const like={isConnected:true,getClientRects:()=>[{}],click:()=>likeClicks++};
  const body={matches:()=>false,dispatchEvent:e=>{keys.push(e);return true;}};
  const doc={body,documentElement:body,activeElement:options.focus?input:body,
    addEventListener:(type,f)=>{events[type]=f;},
    querySelectorAll:selector=>selector==='textarea.chat-input' ?
      (options.missing ? [] : [input]) : selector==='.like-btn' ? [like] : []};
  const runtime={sendMessage:async msg=>{
    if(msg.type==='tick'){requestCount++;return new Promise(r=>{resolveResponse=r;});}
    reports.push(msg);return {ok:true};
  }};
  class Clock extends Date { static now(){return now;} }
  const location={hostname:'live.bilibili.com',protocol:'https:',
    pathname:options.pathname||'/blanc/1883358196'};
  const context=vm.createContext({window:{addEventListener:(type,f)=>winEvents[type]=f},
    document:doc,location,chrome:{runtime},getComputedStyle:()=>({display:'block',visibility:'visible'}),
    Event:E,KeyboardEvent:E,HTMLTextAreaElement:Area,Date:Clock,
    setInterval:f=>{interval=f;},setTimeout:(f)=>{queueMicrotask(f);},console});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'content.js'),'utf8'),context);
  return {input,send,like,doc,events,winEvents,keys,reports,location,
    resolve:response=>resolveResponse?.(response),tick:()=>interval(),
    counts:()=>({like:likeClicks,send:sendClicks,requests:requestCount}),advance:ms=>now+=ms,
    state:()=>context.window};
}
const flush=()=>new Promise(resolve=>setImmediate(resolve));
(async()=>{
  const manifest=JSON.parse(fs.readFileSync(path.join(__dirname,'manifest.json'),'utf8'));
  await test('MV3清单、仅storage权限、域名限定、赛事iframe支持',async()=>{
    assert.equal(manifest.manifest_version,3);
    assert.deepEqual(manifest.permissions,['storage']);
    assert.deepEqual(manifest.host_permissions,['https://live.bilibili.com/*']);
    assert.equal(manifest.content_scripts[0].all_frames,true);
    for(const f of ['background.js','content.js','popup.html','popup.css','popup.js'])assert(fs.existsSync(path.join(__dirname,f)));
  });
  await test('普通房间和blanc识别，非直播页/外站拒绝',async()=>{
    const b=background();
    for(const url of ['https://live.bilibili.com/1883358196','https://live.bilibili.com/blanc/1883358196?liteVersion=true']){
      assert.equal((await b.tick({}, {tab:{id:1},frameId:0,url})).allowed,true);
    }
    for(const url of ['https://live.bilibili.com/','https://live.bilibili.com/p/1883358196','https://example.com/1883358196','http://live.bilibili.com/1883358196']){
      assert.equal((await b.tick({}, {tab:{id:2},frameId:0,url})).allowed,false);
    }
  });
  await test('严格40次点赞上限且首条弹幕不早于2分钟',async()=>{
    const b=background();let likes=0;
    for(let i=0;i<60;i++){
      const r=await b.tick();
      if(r.like){likes++;await b.report(r.like);assert.equal(r.like.mode,'keyboard');}
      assert(!r.chat);b.advance(750);
    }
    assert.equal(likes,40);assert.equal(b.stores.session.rooms['1883358196'].count,40);
  });
  await test('并发标签/iframe去重，单条弹幕预约',async()=>{
    const b=background();
    const results=await Promise.all([b.tick({},b.sender(1,0)),b.tick({},b.sender(1,4)),b.tick({},b.sender(2,0))]);
    assert.equal(results.filter(x=>x.like).length,1);
    await b.report(results.find(x=>x.like).like);
    // Keep owner heartbeat: five minutes passing does not imply leaving the room.
    for(let i=0;i<5;i++){b.advance(60000);await b.tick({busy:true});}
    const chats=await Promise.all([b.tick(),b.tick({},b.sender(2,0))]);
    assert.equal(chats.filter(x=>x.chat).length,1);
    assert.equal(chats.find(x=>x.chat).chat.text,'🫡');
    await b.report(chats.find(x=>x.chat).chat,'chat');
    assert(!(await b.tick()).chat);
  });
  await test('每2分钟最多一条，休眠后不补发多条',async()=>{
    const b=background();await b.send({type:'save',settings:{enabled:true,likeScope:'daily'}},b.ui);
    await b.tick();b.advance(119999);
    assert(!(await b.tick()).chat); // First message must not fire before 120 seconds.
    b.advance(1);
    const r=await b.tick();assert(r.chat);assert.equal(r.chat.text,'🫡');
    assert.equal([...r.chat.text].length,1);assert.equal(r.chat.text.codePointAt(0),0x1FAE1);
    await b.report(r.chat,'chat');
    b.advance(119999);assert(!(await b.tick()).chat);
    b.advance(1);const r2=await b.tick();assert(r2.chat);await b.report(r2.chat,'chat');
    b.advance(3600000);const r3=await b.tick();assert(r3.chat);await b.report(r3.chat,'chat');
    assert(!(await b.tick()).chat);
  });
  await test('打字/离线提示时暂缓，禁用/指定房间生效',async()=>{
    const b=background();
    assert(!(await b.tick({busy:true})).like);
    assert(!(await b.tick({offline:true})).like);
    await b.send({type:'save',settings:{enabled:false}},b.ui);assert.equal((await b.tick()).allowed,false);
    await b.send({type:'save',settings:{enabled:true,roomScope:'selected',roomIds:['123']}},b.ui);
    assert.equal((await b.tick()).allowed,false);
    await b.send({type:'save',settings:{enabled:true,roomScope:'selected',roomIds:['1883358196'],likeMode:'button'}},b.ui);
    assert.equal((await b.tick()).like.mode,'button');
  });
  await test('预约未反馈不重复，错误标签不可确认，跳过会归还点赞计数',async()=>{
    const b=background();const r=await b.tick();b.advance(1000);
    assert(!(await b.tick()).like);
    await b.report(r.like,'like',b.sender(2));assert.equal(b.stores.session.rooms['1883358196'].count,1);
    await b.send({type:'report',room:'1883358196',token:r.like.token,executed:false});
    assert.equal(b.stores.session.rooms['1883358196'].count,0);
    const again=await b.tick();assert(again.like);await b.report(again.like);
  });
  await test('刷新短间隔不重复40次，新文档离开超过90秒按新访问处理',async()=>{
    const b=background();const r=await b.tick();await b.report(r.like);
    const freshSender=b.sender(1,0,'1883358196','doc-b');
    b.advance(1000);const next=await b.tick({},freshSender);assert.equal(next.count,2);await b.report(next.like,'like',freshSender);
    b.advance(90001);const fresh=await b.tick({},b.sender(1,0,'1883358196','doc-c'));assert.equal(fresh.count,1);
  });
  await test('同一文档后台延迟超过90秒不重置40次',async()=>{
    const b=background();const r=await b.tick();await b.report(r.like);
    b.advance(3600000);const next=await b.tick();assert.equal(next.count,2);
    assert(next.chat);assert.equal(next.chat.text,'🫡');
  });
  await test('每日模式北京时间跨日归零，配置不会读取凭据',async()=>{
    const b=background();await b.send({type:'save',settings:{enabled:true,likeScope:'daily'}},b.ui);
    const r=await b.tick();await b.report(r.like);b.advance(86400000);
    assert.equal((await b.tick()).count,1);
    const code=fs.readFileSync(path.join(__dirname,'background.js'),'utf8')+fs.readFileSync(path.join(__dirname,'content.js'),'utf8');
    assert(!/fetch\s*\(|XMLHttpRequest|document\.cookie|chrome\.debugger|chrome\.cookies/.test(code));
  });
  await test('K模式每次keydown/keypress/keyup完整，按键75且不输入弹幕',async()=>{
    const c=content();c.resolve({allowed:true,like:{token:'a',mode:'keyboard'}});await flush();
    assert.deepEqual(c.keys.map(e=>e.type),['keydown','keypress','keyup']);
    assert(c.keys.every(e=>e.key==='k'&&e.code==='KeyK'&&e.keyCode===75&&e.isTrusted===false));
    assert.equal(c.counts().like,0);assert.equal(c.input.value,'');assert.equal(c.reports[0].executed,true);
  });
  await test('按钮模式一次点击且不触发K键',async()=>{
    const c=content();c.resolve({allowed:true,like:{token:'a',mode:'button'}});await flush();
    assert.equal(c.counts().like,1);assert.equal(c.keys.length,0);
  });
  await test('空输入框发送🫡一次：先input唤醒disabled按钮，再click',async()=>{
    const c=content();assert.equal(c.send.disabled,true);
    c.resolve({allowed:true,chat:{token:'c',text:'🫡'}});await flush();
    assert.equal(c.counts().send,1);assert.equal(c.input.value,'');
    assert(c.reports.some(x=>x.result.includes('输入框已清空')));
  });
  await test('草稿不覆盖、聚焦输入不点赞、用户中途打字不提交',async()=>{
    const draft=content({draft:'自己的草稿'});draft.resolve({allowed:true,chat:{token:'c',text:'🫡'}});await flush();
    assert.equal(draft.input.value,'自己的草稿');assert.equal(draft.counts().send,0);
    const focused=content({focus:true});focused.resolve({allowed:true,like:{token:'a',mode:'keyboard'}});await flush();
    assert.equal(focused.keys.length,0);assert.equal(focused.reports[0].executed,false);
    const c=content();c.events.input({isTrusted:true});c.resolve({allowed:true,chat:{token:'c',text:'🫡'}});await flush();
    assert.equal(c.counts().send,0);assert.equal(c.input.value,'');
  });
  await test('发送失败保留🫡、不自动重试、报告结果未知',async()=>{
    const c=content({clear:false});c.resolve({allowed:true,chat:{token:'c',text:'🫡'}});await flush();
    assert.equal(c.counts().send,1);assert.equal(c.input.value,'🫡');
    assert(c.reports.some(x=>x.result.includes('未清空')));
    void c.tick();c.resolve({allowed:true,chat:{token:'d',text:'🫡'}});await flush();assert.equal(c.counts().send,1);
  });
  await test('专题外层无控件不运行、首页不运行、未获租约不操作',async()=>{
    const missing=content({missing:true});assert.equal(missing.counts().requests,0);
    const home=content({pathname:'/'});assert.equal(home.counts().requests,0);
    const c=content();c.resolve({allowed:false,like:{token:'a',mode:'button'},chat:{token:'c',text:'🫡'}});await flush();
    assert.equal(c.counts().like,0);assert.equal(c.counts().send,0);
  });
  await test('单帧互斥、页面离开停止和bfcache恢复',async()=>{
    const c=content();void c.tick();assert.equal(c.counts().requests,1);
    c.resolve({allowed:false});await flush();
    c.winEvents.pagehide();void c.tick();assert.equal(c.counts().requests,1);
    c.winEvents.pageshow();void c.tick();assert.equal(c.counts().requests,2);
    c.resolve({allowed:false});await flush();
  });
  await test('1到10分钟全部选项：首次和后续严格按设置计时',async()=>{
    for(let minutes=1;minutes<=10;minutes++) {
      const b=background();
      await b.send({type:'save',settings:{enabled:true,likesEnabled:false,chatMinutes:minutes,chatText:'加油🫡'}},b.ui);
      await b.tick();b.advance(minutes*60000-1);assert(!(await b.tick()).chat);
      b.advance(1);const first=await b.tick();assert.equal(first.chat.text,'加油🫡');await b.report(first.chat,'chat');
      b.advance(minutes*60000-1);assert(!(await b.tick()).chat);
      b.advance(1);const next=await b.tick();assert.equal(next.chat.text,'加油🫡');await b.report(next.chat,'chat');
      assert(!(await b.tick()).chat);
    }
  });
  await test('拒绝非法间隔、空白、多行和超长内容；不改变已有设置',async()=>{
    const b=background();
    await b.send({type:'save',settings:{enabled:true,chatMinutes:3,chatText:'原内容'}},b.ui);
    for(const bad of [0,11,1.5,'2',null]) {
      assert((await b.send({type:'save',settings:{chatMinutes:bad,chatText:'新内容'}},b.ui)).error);
    }
    for(const bad of ['', '   ', '\n', '第一行\n第二行', 'x'.repeat(201), null]) {
      assert((await b.send({type:'save',settings:{chatMinutes:2,chatText:bad}},b.ui)).error);
    }
    const s=(await b.send({type:'settings'},b.ui)).settings;
    assert.equal(s.chatMinutes,3);assert.equal(s.chatText,'原内容');
    assert(!(await b.send({type:'save',settings:{chatMinutes:10,chatText:'🫡'.repeat(200)}},b.ui)).error);
  });
  await test('旧设置自动补默认2分钟与表情，保留暂停、房间和点赞方式',async()=>{
    const b=background();
    b.stores.local.settings={enabled:false,likesEnabled:false,chatEnabled:false,likeMode:'button',
      roomScope:'selected',roomIds:['1883358196'],likeScope:'daily'};
    const s=(await b.send({type:'settings'},b.ui)).settings;
    assert.equal(s.chatMinutes,2);assert.equal(s.chatText,'🫡');assert.equal(s.enabled,false);
    assert.equal(s.likesEnabled,false);assert.equal(s.likeMode,'button');assert.equal(s.roomScope,'selected');
    assert.deepEqual(Array.from(s.roomIds),['1883358196']);
  });
  await test('运行中改内容和间隔重新计时，不重置点赞；重复保存和暂停不重置',async()=>{
    const b=background();const op=await b.tick();await b.report(op.like);
    b.advance(10000);
    const current=(await b.send({type:'settings'},b.ui)).settings;
    const res=await b.send({type:'save',settings:{...current,chatMinutes:4,chatText:'  加油 🫡  '}},b.ui);
    assert.equal(res.chatChanged,true);
    assert.equal(b.stores.session.rooms['1883358196'].count,1);
    assert.equal(b.stores.session.rooms['1883358196'].nextChat,b.now()+240000);
    const due=b.stores.session.rooms['1883358196'].nextChat;
    assert.equal((await b.send({type:'save',settings:res.settings},b.ui)).chatChanged,false);
    assert.equal(b.stores.session.rooms['1883358196'].nextChat,due);
    await b.send({type:'save',settings:{...res.settings,enabled:false}},b.ui);
    assert.equal(b.stores.session.rooms['1883358196'].nextChat,due);
    await b.send({type:'save',settings:res.settings},b.ui);
    b.advance(239999);assert(!(await b.tick()).chat);b.advance(1);
    assert.equal((await b.tick()).chat.text,'  加油 🫡  ');
  });
  await test('自定义文字、表情与特殊字符按原样作为文本输入，不执行HTML',async()=>{
    for(const value of ['加油🫡','  原样保留空格  ','<b>原样文字</b>','🫡'.repeat(200)]) {
      const c=content({clear:false});
      c.resolve({allowed:true,chat:{token:'x',text:value}});await flush();
      assert.equal(c.input.value,value);assert.equal(c.counts().send,1);
    }
    const html=fs.readFileSync(path.join(__dirname,'popup.html'),'utf8');
    const select=html.match(/<select id="chat-minutes"[\s\S]*?<\/select>/)[0];
    const options=[...select.matchAll(/<option value="(\d+)"/g)].map(x=>Number(x[1]));
    assert.deepEqual(options,[1,2,3,4,5,6,7,8,9,10]);
    assert(html.includes('id="chat-text" type="text"'));
    assert(!fs.readFileSync(path.join(__dirname,'popup.js'),'utf8').includes('innerHTML'));
  });
  await test('弹窗设置可加载、编辑保存、重新打开回读且轮询不覆盖未保存内容',async()=>{
    const b=background();
    class Node {
      constructor(){this.value='';this.textContent='';this.checked=false;this.handlers={};this.children=[];
        this.classList={toggle:()=>{}};}
      addEventListener(type,f){this.handlers[type]=f;}
      append(...nodes){this.children.push(...nodes);}
      replaceChildren(...nodes){this.children=nodes;}
    }
    function popup() {
      const ids=['likes','chat','chat-minutes','chat-text','chat-summary','like-mode','like-scope',
        'room-scope','room-ids','room-field','toggle','rooms','feedback','save','settings-form'];
      const nodes=Object.fromEntries(ids.map(x=>[x,new Node()]));
      let poll;
      const context=vm.createContext({document:{getElementById:id=>nodes[id],createElement:()=>new Node()},
        chrome:{runtime:{sendMessage:msg=>b.send(msg,b.ui)}},Date,console,setInterval:f=>{poll=f;}});
      vm.runInContext(fs.readFileSync(path.join(__dirname,'popup.js'),'utf8'),context);
      return {nodes,poll:()=>poll()};
    }
    const p=popup();await flush();
    assert.equal(p.nodes['chat-minutes'].value,'2');assert.equal(p.nodes['chat-text'].value,'🫡');
    p.nodes['chat-minutes'].value='7';p.nodes['chat-text'].value='自定义加油';
    await p.poll();assert.equal(p.nodes['chat-text'].value,'自定义加油');
    await p.nodes['settings-form'].handlers.submit({preventDefault:()=>{}});
    const s=(await b.send({type:'settings'},b.ui)).settings;
    assert.equal(s.chatMinutes,7);assert.equal(s.chatText,'自定义加油');
    const reopened=popup();await flush();
    assert.equal(reopened.nodes['chat-minutes'].value,'7');assert.equal(reopened.nodes['chat-text'].value,'自定义加油');
    p.nodes['chat-text'].value=' ';
    await p.nodes['settings-form'].handlers.submit({preventDefault:()=>{}});
    assert(p.nodes.feedback.textContent.includes('不能为空'));
    assert.equal((await b.send({type:'settings'},b.ui)).settings.chatText,'自定义加油');
  });
  const result={passed:true,suites:passed.length,tests:passed,
    scope:'Offline VM tests with mocked Chrome storage/runtime/DOM/timers. Not a real extension load or Bilibili receipt test.'};
  fs.writeFileSync(path.join(__dirname,'测试结果.json'),JSON.stringify(result,null,2)+'\n','utf8');
  console.log(`ALL ${passed.length} TESTS PASSED`);
})().catch(e=>{console.error(e);process.exitCode=1;});
