import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import {createHash} from 'node:crypto';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ID = 'inq:2026-09-07T12:00:00Z:12345678-1234-4123-8123-123456789012';
const LABEL = 'AW-18417846877/JnV2CM2B2-0cEN2UqM5E';
const accepted = {ok:true, accepted:true, stored:true, inquiry_id:ID};
const flush = () => new Promise(resolve => setImmediate(resolve));
const PAGES = [
  {path:'index.html', conversion:false},
  {path:'bonded-warehousing/index.html', conversion:true},
  {path:'3pl-warehousing/index.html', conversion:true},
];

async function browser(page, replies = [], config = {}) {
  const html = await readFile(path.join(ROOT, page), 'utf8');
  const asset = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"[^>]*>/g)]
    .map(match => match[1]).find(src => src.startsWith('/assets/inquiry-form.'));
  assert.ok(asset, 'page must load its actual shared form script');
  const code = await readFile(path.join(ROOT, asset), 'utf8');
  assert.equal(path.basename(asset), 'inquiry-form.'+createHash('sha256').update(code).digest('hex').slice(0,12)+'.js', 'referenced asset filename must identify its actual bytes');
  const values = new Map(config.receipt ? [['perfect-imports:inquiry-receipt:v1',JSON.stringify(config.receipt)]] : []);
  if(config.attribution)values.set('perfect-imports:inquiry-attribution:v1', JSON.stringify(config.attribution));
  const formTag = html.match(/<form\b[^>]*action="\/api\/inquiry"[^>]*>/)?.[0] || '';
  const sendTo = formTag.match(/data-conversion-send-to="([^"]+)"/)?.[1] || null;
  const events=[], redirects=[], requests=[], timers=new Map(), handlers={};
  let nextTimer=0;
  const status={textContent:''}, button={disabled:false};
  const nodes={
    'inquiry-confirmation':{textContent:'Contact Perfect Imports'},
    'inquiry-confirmation-copy':{textContent:'For questions about your enquiry, email me directly at'},
    'inquiry-receipt-state':{textContent:'Enquiries'}
  };
  const form={
    action:'https://example.test/api/inquiry',
    querySelector(selector){return selector==='[role="status"]'?(config.missingStatus?null:status):button;},
    getAttribute(name){return name==='data-conversion-send-to'?sendTo:null;},
    addEventListener(name,callback){(handlers[name] ??= []).push(callback);}
  };
  const sessionStorage={
    getItem(key){if(config.storageBlocked)throw new Error('blocked');return values.get(key)??null;},
    setItem(key,value){if(config.storageBlocked)throw new Error('blocked');values.set(key,value);},
    removeItem(key){if(config.storageBlocked)throw new Error('blocked');values.delete(key);}
  };
  const window={sessionStorage,location:{href:'https://example.test/'+(config.search??'?utm_source=fixture'),hostname:'example.test',search:config.search??'?utm_source=fixture',assign(value){redirects.push(value);}},
    piInquiryAttribution:{apply(data){if(config.attributionThrows)throw new Error('unavailable');data.set('utm_source','fixture');}},
    gtag(...args){events.push(args);if(config.gtagThrows)throw new Error('unavailable');if(config.syncCallbacks)args[2].event_callback();}
  };
  const context=vm.createContext({window,URL,URLSearchParams,document:{referrer:'',querySelector(){return page.startsWith('thanks')?null:form;},
    getElementById(id){return page.startsWith('thanks')?nodes[id]:({'inquiry-form':form,'inquiry-status':status}[id]??null);},
    querySelectorAll(){return page.startsWith('thanks')?[]:[form];}
  },FormData:class extends Map{constructor(){super([['email','buyer@example.com'],['message','Synthetic enquiry']]);}},
  AbortController,setTimeout(callback,ms){const key=++nextTimer;timers.set(key,{callback,ms});return key;},
  clearTimeout(key){timers.delete(key);},Date,Number,JSON,
  fetch(url,options){
    requests.push({url,options});
    const reply=replies.shift();
    if(reply instanceof Error)return Promise.reject(reply);
    if(typeof reply==='function')return reply();
    return Promise.resolve({ok:reply?.httpOk??true,json:()=>reply?.jsonError?Promise.reject(new Error('bad JSON')):Promise.resolve(reply?.body)});
  }});
  {
    const dataLayer=[];
    dataLayer.push=function(entry){if(entry && entry[0]==='event')events.push(Array.from(entry));return Array.prototype.push.call(this,entry);};
    context.dataLayer=dataLayer;window.dataLayer=dataLayer;
    // Execute every page's actual inline scripts before its deferred form asset.
    // An added submit handler must remain visible alongside the shared handler.
    for(const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)){
      if(!/\bsrc=|application\/ld\+json/.test(match[1]))vm.runInContext(match[2],context,{filename:page+':inline'});
    }
  }
  vm.runInContext(code,context,{filename:asset});
  if(config.attributionThrows)window.piInquiryAttribution.apply=function(){throw new Error('synthetic attribution failure');};
  return {events,redirects,requests,status,button,nodes,timers,handlers,
    async submit(){for(const callback of handlers.submit??[])callback({preventDefault(){}});await flush();await flush();},
    async runTimers(ms){for(const [id,timer]of timers){if(timer.ms===ms){timers.delete(id);timer.callback();}}await flush();}
  };
}

for (const {path:page, conversion} of PAGES) {
  test(page+': rejects false/malformed/HTTP-failed acceptance without events or redirect', async()=>{
    for(const reply of [
      {body:{ok:true}}, {body:{ok:true,inquiry_id:ID}},
      {body:{...accepted,stored:false}}, {body:{...accepted,stored:null}},
      {body:{ok:false,accepted:false,stored:true,inquiry_id:ID}},
      {body:{...accepted,accepted:'true'}}, {body:{...accepted,ok:'true'}},
      {httpOk:false,body:accepted},{body:{...accepted,inquiry_id:'x'.repeat(65)}},
      {body:{...accepted,inquiry_id:123}},{jsonError:true},new Error('network')
    ]) {
      const ui=await browser(page,[reply]);await ui.submit();
      assert.equal(ui.events.length,0);assert.equal(ui.redirects.length,0);
      assert.equal(ui.button.disabled,false);assert.match(ui.status.textContent,/could not confirm/);
    }
  });
  test(page+': accepted receipt fires existing events once with bounded ID, including repeated submit',async()=>{
    const ui=await browser(page,[{body:accepted}]);await ui.submit();await ui.submit();await ui.runTimers(2000);
    assert.equal(ui.requests.length,1);assert.equal(ui.redirects.length,1);
    assert.equal(ui.events.filter(row=>row[1]==='generate_lead').length,1);
    assert.equal(ui.events.filter(row=>row[1]==='conversion').length,conversion?1:0);
    if(conversion)assert.equal(ui.events.find(row=>row[1]==='conversion')[2].send_to,LABEL);
    for(const row of ui.events){assert.equal(row[2].transaction_id,ID);assert.ok(row[2].transaction_id.length<=64);}
    assert.equal(ui.requests[0].options.body.get('utm_source'),'fixture');
  });
  test(page+': in-flight double submit suppressed and manual retry after failure retains details',async()=>{
    let finish;
    const first=new Promise(resolve=>{finish=resolve;});
    const ui=await browser(page,[()=>first,{body:accepted}]);
    await ui.submit();await ui.submit();assert.equal(ui.requests.length,1);
    finish({ok:false,json:async()=>({ok:false,accepted:false,stored:false,error:'Try again'})});await flush();await flush();
    assert.equal(ui.button.disabled,false);await ui.submit();
    assert.equal(ui.requests.length,2);assert.equal(ui.requests[1].options.body.get('message'),'Synthetic enquiry');
  });
  test(page+': blocked storage or analytics never converts accepted record to an error',async()=>{
    const blocked=await browser(page,[{body:accepted}],{storageBlocked:true});await blocked.submit();await blocked.runTimers(2000);
    assert.match(blocked.status.textContent,/has been received/);assert.equal(blocked.redirects.length,0);assert.equal(blocked.button.disabled,true);
    const broken=await browser(page,[{body:accepted}],{gtagThrows:true});await broken.submit();await broken.runTimers(2000);
    assert.match(broken.status.textContent,/has been received/);assert.equal(broken.redirects.length,1);
  });
  test(page+': navigation waits for all event callbacks or the bounded fallback',async()=>{
    const ui=await browser(page,[{body:accepted}]);await ui.submit();
    assert.equal(ui.redirects.length,0);
    for(let i=0;i<ui.events.length;i++){
      assert.equal(ui.events[i][2].event_timeout,2000);
      ui.events[i][2].event_callback();ui.events[i][2].event_callback();
      assert.equal(ui.redirects.length,i===ui.events.length-1?1:0);
    }
    await ui.runTimers(2000);assert.equal(ui.redirects.length,1);
    const sync=await browser(page,[{body:accepted}],{syncCallbacks:true});await sync.submit();
    assert.equal(sync.events.length,conversion?2:1);assert.equal(sync.redirects.length,1);
  });
  test(page+': fresh click ID replaces earlier organic attribution',async()=>{
    const ui=await browser(page,[{body:accepted}],{
      attribution:{channel:'organic',utm_source:'google',utm_medium:'organic',landing_path:'https://example.test/old'},
      search:'?gclid=fresh-synthetic-click&utm_source=google&utm_medium=cpc'
    });await ui.submit();
    const sent=ui.requests[0].options.body;
    assert.equal(sent.get('gclid'),'fresh-synthetic-click');assert.equal(sent.get('channel'),'paid-search');
    assert.equal(sent.get('utm_medium'),'cpc');assert.equal(sent.get('landing_path'),'https://example.test/');
  });
  test(page+': missing status element leaves native submission available',async()=>{
    const ui=await browser(page,[],{missingStatus:true});assert.equal(ui.handlers.submit,undefined);assert.equal(ui.button.disabled,false);
  });
  test(page+': optional attribution preparation failure stays visible and retryable',async()=>{
    const ui=await browser(page,[],{attributionThrows:true});await ui.submit();
    assert.equal(ui.requests.length,0);assert.equal(ui.button.disabled,false);assert.match(ui.status.textContent,/could not prepare/);
  });
}

test('thanks direct visit, reload, expired and malformed receipts never fire a lead event',async()=>{
  for(const receipt of [undefined,{id:ID,at:Date.now()-31*60*1000},{id:'x'.repeat(65),at:Date.now()},{id:ID,at:Date.now()+60000}]) {
    const ui=await browser('thanks/index.html',[],{receipt});
    assert.equal(ui.events.length,0);assert.equal(ui.nodes['inquiry-confirmation'].textContent,'Contact Perfect Imports');
  }
  for(let attempt=0;attempt<2;attempt++){
    const ui=await browser('thanks/index.html',[],{receipt:{id:ID,at:Date.now()-100}});
    assert.match(ui.nodes['inquiry-confirmation'].textContent,/have your enquiry/);assert.equal(ui.events.length,0);
  }
});
