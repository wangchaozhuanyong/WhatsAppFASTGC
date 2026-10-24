import fs from 'node:fs';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import crypto from 'node:crypto';
const sourceRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const profile=process.env.FASTGC_FUNCTIONAL_PROFILE,port=Number(process.env.FASTGC_FUNCTIONAL_CDP_PORT);
if(!profile||!/^functional-profile-/.test(path.basename(profile))||!Number.isInteger(port)||port<1024||port>65535)throw Error('Set explicit isolated FASTGC_FUNCTIONAL_PROFILE and loopback FASTGC_FUNCTIONAL_CDP_PORT');
const require=createRequire(sourceRoot+'/package.json'),Babel=require('@babel/standalone');
const html=fs.readFileSync(sourceRoot+'/index.html','utf8');
const marker='<script type="text/babel">',start=html.indexOf(marker)+marker.length;
const jsx=html.slice(start,html.indexOf('</script>',start));
const ast=Babel.packages.parser.parse(jsx,{sourceType:'script',plugins:['jsx']});
const names=['normalizeCustomLinkUrl','normalizeScriptImport','LinkManagerModal','RightScriptLibrary','ContentManagerDrawer','PhoneRewardsDrawer','PhoneImportModal','SeatSetupModal','writeSeatLayout'];
const snippets=names.map(name=>{const node=ast.program.body.find(n=>n.type==='FunctionDeclaration'&&n.id.name===name||n.type==='VariableDeclaration'&&n.declarations.some(d=>d.id.name===name));if(!node)throw Error(name);return jsx.slice(node.start,node.end)}).join('\n');
const compiled=Babel.transform(snippets,{presets:['react'],sourceType:'script'}).code;
const targets=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const target=targets.find(t=>t.type==='page'&&t.url.includes('index.html'));if(!target)throw Error('Missing fixture host');
const socket=new WebSocket(target.webSocketDebuggerUrl);await new Promise((r,j)=>{socket.onopen=r;socket.onerror=j});
const expression=`(async()=>{
 const diag=await window.fastgcBridge.getDiagnosticsSnapshot();
 if(diag.userDataPath.replace(/\\\\/g,'/').toLowerCase()!==${JSON.stringify(path.resolve(profile).replaceAll('\\','/').toLowerCase())})throw Error('Not isolated profile '+diag.userDataPath);
 const assert=(v,m)=>{if(!v)throw Error(m)},cases=[],wait=()=>new Promise(r=>{const c=new MessageChannel();c.port1.onmessage=()=>{c.port1.close();c.port2.close();ReactDOM.flushSync(()=>{});r()};c.port2.postMessage(0)});
 const originalWriter=writeMigratedStorage,originalScriptWriter=writeScriptQuick;
 let failWrites=false,writeCount=0;
 const components=(()=>{
  const writeMigratedStorage=(...args)=>{writeCount++;return !failWrites&&originalWriter(...args)};
  const writeScriptQuick=(...args)=>!failWrites&&originalScriptWriter(...args);
  ${compiled}
  return {${names.join(',')}};
 })();
 const fixture=document.createElement('div');document.body.appendChild(fixture);
 const root=ReactDOM.createRoot(fixture),ctx={t:k=>k,lang:'zh'};
 const mount=async(name,props={})=>{ReactDOM.flushSync(()=>root.render(React.createElement(LanguageContext.Provider,{value:ctx},React.createElement(components[name],{...props,key:name+Math.random()}))));await wait()};
 const p=node=>node[Object.keys(node).find(k=>k.startsWith('__reactProps$'))];
 const event={preventDefault(){},stopPropagation(){},target:{value:''}};
 const click=async(node,kind='onClick')=>{assert(node,'Missing '+kind+' target');let result;ReactDOM.flushSync(()=>{result=p(node)[kind]({...event,target:node})});await result;await wait()};
 const button=key=>[...fixture.querySelectorAll('button')].find(b=>b.textContent.trim()===key||b.title===key);
 const input=async(node,value)=>{assert(node,'Missing input');ReactDOM.flushSync(()=>p(node).onChange({target:{value}}));await wait()};
 const data=key=>JSON.parse(window.fastgcBridge.storageGetSync(key).value||'null');
 try {
  assert(components.normalizeCustomLinkUrl('example.com')==='https://example.com/','URL normalization');
  for(const url of ['javascript:alert(1)','file:///C:/','data:text/html,test','https://','https://user:password@example.com'])assert(!components.normalizeCustomLinkUrl(url),'Reject invalid URL');
  let links=[];
  function Links(){const [value,setValue]=React.useState([]);return React.createElement(components.LinkManagerModal,{links:value,setLinks:n=>{links=n;setValue(n)},onClose(){}})}
  ReactDOM.flushSync(()=>root.render(React.createElement(LanguageContext.Provider,{value:ctx},React.createElement(Links))));await wait();
  await input(fixture.querySelectorAll('input')[0],'Fixture');await input(fixture.querySelectorAll('input')[1],'javascript:alert(1)');await click(button('linkConfirmAdd'));
  assert(links.length===0&&fixture.querySelector('[role=alert]'),'Invalid URL feedback');
  await input(fixture.querySelectorAll('input')[1],'example.com');failWrites=true;await click(button('linkConfirmAdd'));assert(links.length===0&&fixture.querySelectorAll('input')[0].value==='Fixture','Link failure retains form');failWrites=false;
  await click(button('linkConfirmAdd'));assert(links.length===1&&data(CUSTOM_LINKS_STORAGE_KEY).length===1,'Link add persists');
  await click(button('linkEdit'));await input(fixture.querySelectorAll('input')[0],'Edited');await click(button('linkSaveEdit'));assert(data(CUSTOM_LINKS_STORAGE_KEY)[0].name==='Edited','Link edit');
  await click(button('deleteRecord'));assert(data(CUSTOM_LINKS_STORAGE_KEY).length===0,'Link delete');cases.push('custom links: validation, add/edit/delete, durable storage, failed-save form retention');

  writeScriptQuick('zh',[]);writeScriptQuick('en',[]);let sends=[],fills=[];
  await mount('RightScriptLibrary',{libraryId:'zh',onSend:async text=>sends.push(text),onFill:text=>fills.push(text)});
  await click(button('addBtn'));await input(fixture.querySelector('input[type=text]'),'中文测试');await input(fixture.querySelector('textarea'),'隔离中文');
  const save=()=>button('saveBtn')||button('save')||[...fixture.querySelectorAll('button')].find(b=>/save/i.test(b.textContent));
  failWrites=true;await click(save());assert(fixture.querySelector('textarea')&&readScriptQuick('zh').length===0,'Script failed save retains modal');failWrites=false;await click(save());
  assert(readScriptQuick('zh')[0].content==='隔离中文'&&readScriptQuick('en').length===0,'Independent script libraries');
  const row=()=>[...fixture.querySelectorAll('button')].find(b=>p(b).onDoubleClick&&b.textContent.includes('中文测试'));
  await click(row());assert(sends.length===0,'Single click must not send');
  await Promise.all([click(row(),'onDoubleClick'),click(row(),'onDoubleClick')]);assert(sends.length===1,'Double-click dedup');
  await click(fixture.querySelector('button[aria-label=copy]'));assert(fills.length===1&&sends.length===1,'Copy must not send');
  await mount('RightScriptLibrary',{libraryId:'en',onSend:async text=>sends.push(text),onFill:text=>fills.push(text)});assert(!fixture.textContent.includes('隔离中文'),'English must not show Chinese scripts');
  await click(button('addBtn'));await input(fixture.querySelector('input[type=text]'),'English');await input(fixture.querySelector('textarea'),'Fixture English');await click(save());assert(readScriptQuick('en').length===1&&readScriptQuick('zh').length===1,'English create independence');
  await click(button('quickScriptEdit'));await input(fixture.querySelector('textarea'),'Edited English');await click(save());assert(readScriptQuick('en')[0].content==='Edited English','Script edit persists');
  const importInput=fixture.querySelector('input[type=file]');const dt=new DataTransfer();dt.items.add(new File(['[null]'],'bad.json',{type:'application/json'}));await p(importInput).onChange({target:{files:dt.files,value:''}});for(let n=0;n<1000&&!fixture.textContent.includes('scriptImportError');n++)await wait();assert(fixture.textContent.includes('scriptImportError'),'Import error visible');
  await click(button('deleteRecord'));await click(button('confirmBtn'));assert(readScriptQuick('en').length===0,'Script delete persists');cases.push('two script libraries: add/edit/delete, isolation, single/double click, send dedup, copy, failed save, invalid import feedback');

  let importCalls=[];await mount('PhoneImportModal',{onClose(){},onImport:rows=>importCalls.push(rows)});await input(fixture.querySelector('textarea'),'08012345678 2348012345678 +2348012345678');
  await click(button('confirmImport'));
  assert(importCalls.length===1&&importCalls[0].every(row=>row.normalized==='2348012345678'),'Phone international prefix normalization');
  const seed=[{id:'existing',phone:'+2348012345678',normalized:'2348012345678',claimed:false,added:false}];
  originalWriter(PHONE_REWARDS_STORAGE_KEY,JSON.stringify(seed));writeCount=0;await mount('PhoneRewardsDrawer',{onClose(){}});assert(writeCount===0&&data(PHONE_REWARDS_STORAGE_KEY).length===1,'Opening phone library must never write empty data');
  const claim=()=>[...fixture.querySelectorAll('tbody button')].find(b=>!b.title&&b.textContent.trim());
  failWrites=true;await click(claim());assert(data(PHONE_REWARDS_STORAGE_KEY)[0].claimed===false,'Failed phone toggle does not change saved value');failWrites=false;await click(claim());assert(data(PHONE_REWARDS_STORAGE_KEY)[0].claimed,'Claim toggle saves');
  await click(button('batchImport'));await input(fixture.querySelector('textarea'),'08012345678 08099999999 08099999999');
  await click(button('confirmImport'));
  assert(data(PHONE_REWARDS_STORAGE_KEY).length===2,'Within-batch and existing phone duplicates rejected');
  await mount('PhoneRewardsDrawer',{onClose(){}});assert(fixture.textContent.includes('+2348099999999'),'Phone reopen persists');cases.push('phone rewards: prefix, no empty mount write, dedup within/across imports, status toggle, failure rollback, reopen');

  originalWriter(CONTENT_MANAGER_STORAGE_KEY,JSON.stringify({categories:[{id:'cat',name:'Fixture category'}],records:[{id:'row',categoryId:'cat',titleZh:'中文标题',content:'English content',contentZh:'中文正文'}]}));
  let contentSends=[];await mount('ContentManagerDrawer',{onClose(){},onCopy(){},onSend:async text=>contentSends.push(text)});
  assert(fixture.textContent.includes('中文标题'),'Content loads');
  const title=[...fixture.querySelectorAll('td div')].find(n=>p(n)?.onDoubleClick&&n.textContent.includes('中文标题'));
  if(title&&p(title).onDoubleClick){await click(title,'onDoubleClick');assert(contentSends[0]==='中文正文','Content language route');}
  const del=[...fixture.querySelectorAll('tbody button')].at(-1);
  assert(del,'Content delete action');await click(del);failWrites=true;await click(button('confirmBtn'));assert(data(CONTENT_MANAGER_STORAGE_KEY).records.length===1&&fixture.textContent.includes('中文标题'),'Content failed delete retains UI');failWrites=false;
  await click(del);await click(button('confirmBtn'));assert(data(CONTENT_MANAGER_STORAGE_KEY).records.length===0,'Content delete durable');
  await click(button('addContent'));await input(fixture.querySelectorAll('input')[1],'New Chinese title');await input(fixture.querySelectorAll('input')[2],'New English title');await input(fixture.querySelectorAll('textarea')[0],'New English body');await input(fixture.querySelectorAll('textarea')[1],'新中文正文');
  failWrites=true;await click(button('saveContent'));assert(fixture.querySelector('textarea')&&data(CONTENT_MANAGER_STORAGE_KEY).records.length===0,'Content failed save retains form');failWrites=false;await click(button('saveContent'));assert(data(CONTENT_MANAGER_STORAGE_KEY).records.length===1,'Content add persists');
  await click([...fixture.querySelectorAll('tbody button')].at(-2));await input(fixture.querySelector('textarea'),'Edited content');await click(button('saveContent'));assert(data(CONTENT_MANAGER_STORAGE_KEY).records[0].content==='Edited content','Content edit persists');
  await click([...fixture.querySelectorAll('tbody button')].at(-1));await click(button('confirmBtn'));
  await click(button('categoryManageTitle'));await input(fixture.querySelector('input[placeholder=categoryPlaceholder]'),'Added category');await click(button('confirmCreate'));assert(data(CONTENT_MANAGER_STORAGE_KEY).categories.length===2,'Category add');
  const categoryInputs=[...fixture.querySelectorAll('input')].filter(n=>n.placeholder!=='searchContentPlaceholder'&&n.placeholder!=='categoryPlaceholder');await input(categoryInputs.at(-1),'Renamed category');assert(data(CONTENT_MANAGER_STORAGE_KEY).categories.at(-1).name==='Renamed category','Category rename');
  await click([...fixture.querySelectorAll('button[title=deleteRecord]')].at(-1));await click(button('confirmBtn'));assert(data(CONTENT_MANAGER_STORAGE_KEY).categories.length===1&&data(CONTENT_MANAGER_STORAGE_KEY).records.length===0,'Category delete');
  cases.push('content and categories: add/edit/delete, language route with send mock, failed-save form retention and durable save');
  let appliedLayout=null,seatEditorClosed=0;await mount('SeatSetupModal',{layout:readSeatLayout(),onClose:()=>seatEditorClosed++,onApplyLayout:next=>{if(failWrites)return false;appliedLayout=components.writeSeatLayout(next);return Boolean(appliedLayout)}});
  const oldLayout=readSeatLayout();await click([...fixture.querySelectorAll('button')].find(b=>b.textContent.includes('seatAdd')));
  await input(fixture.querySelector('input'),'Renamed fixture seat');
  const selected=fixture.querySelector('select');await input(selected,'1');
  const saveLayout=()=>[...fixture.querySelectorAll('button')].find(b=>b.textContent.trim()==='保存修改');
  failWrites=true;await click(saveLayout());assert(seatEditorClosed===0&&!appliedLayout,'Seat failed save retains editor');failWrites=false;await click(saveLayout());
  assert(seatEditorClosed===1&&appliedLayout.pinnedSeatId==='1'&&new Set([...appliedLayout.freeOrder,appliedLayout.pinnedSeatId]).size===oldLayout.freeOrder.length+2,'Seat add/pin without duplicates');
  assert(readSeatLayout().meta[oldLayout.freeOrder[0]].label==='Renamed fixture seat','Seat rename persists');
  writeSeatLayout(oldLayout);cases.push('seat editor: add, rename, fixed/free exchange, failed-save editor retention and durable save');
  const bridge=window.fastgcBridge;
  const originalSeats=await bridge.getSeatConfig();
  assert((await bridge.setSeatConfig({seatCount:15})).ok&&(await bridge.getSeatConfig()).seatCount===15,'Seat count persists');
  assert((await bridge.setSeatConfig({seatCount:100})).ok&&(await bridge.getSeatConfig()).seatCount<=50,'Seat count bounded');await bridge.setSeatConfig(originalSeats);
  assert((await bridge.setUiLocale('en')).ok&&(await bridge.getUiLocale())==='en','Locale save/read');assert((await bridge.setUiLocale('zh')).ok,'Locale restore');
  cases.push('seat configuration: save/read and maximum; locale: English save/read and restore');
  const initialPolicy=await bridge.getAccessControl();assert(!initialPolicy.hasPassword&&!initialPolicy.enabled,'Fresh fixture must not have policy');
  assert((await bridge.setAccessControl({enabled:false,allowIps:[],newPassword:'fixture-password',clearPassword:false})).ok,'Create admin password');
  assert((await bridge.getAccessControl()).hasPassword,'Password state retained');
  assert(!(await bridge.setAccessControl({enabled:false,allowIps:[],clearPassword:true})).ok,'Admin save requires unlock');
  assert(!(await bridge.verifyAccessPassword('wrong-fixture')).verified,'Wrong password rejected');assert((await bridge.verifyAccessPassword('fixture-password')).verified,'Correct password unlocks');
  assert((await bridge.setAccessControl({enabled:false,allowIps:[],clearPassword:true})).ok&&!(await bridge.getAccessControl()).hasPassword,'Password clear after unlock');
  cases.push('admin permissions: create password, locked mutation rejection, wrong/correct unlock, clear and readback');
  const cleanup=await bridge.clearTranslateCache();assert(cleanup.ok,'Fixture cache clear');const diagnostics=await bridge.getDiagnosticsSnapshot();assert(diagnostics.ok&&diagnostics.sqliteAvailable&&diagnostics.translateCacheEntries===0,'Diagnostics refresh');
  const feed=await bridge.getUpdateFeed();if(!feed.url&&!feed.feedUrl){assert((await bridge.checkUpdatesNow()).reason==='no_feed','Missing update feed feedback');}
  cases.push('cache cleanup and diagnostic readback; unconfigured update check returns no_feed');
  return {passed:true,profile:diag.userDataPath,cases,actualMessagesSent:0,actualCallsPlaced:0,componentsFromSource:true,sourceSnapshot:'current-primary-source'};
 }finally{root.unmount();fixture.remove()}
})()`;
try{
 const result=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Functional test timeout')),60000);socket.onmessage=({data})=>{const m=JSON.parse(data);if(m.id===1){clearTimeout(timer);resolve(m)}};socket.send(JSON.stringify({id:1,method:'Runtime.evaluate',params:{expression,returnByValue:true,awaitPromise:true}}));});
 if(result.result?.exceptionDetails)throw Error(JSON.stringify(result.result.exceptionDetails));if(result.error)throw Error(JSON.stringify(result.error));
 const value=result.result.result.value;if(!value?.passed)throw Error(JSON.stringify(value));value.sourceSha256=crypto.createHash('sha256').update(html).digest('hex');fs.mkdirSync(path.join(sourceRoot,'generated'),{recursive:true});fs.writeFileSync(process.env.FASTGC_FUNCTIONAL_EVIDENCE||path.join(sourceRoot,'generated/functional-ui-evidence.json'),JSON.stringify(value,null,2));console.log(JSON.stringify(value,null,2));
}finally{socket.close()}
