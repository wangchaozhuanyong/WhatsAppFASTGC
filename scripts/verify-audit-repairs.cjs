const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),vm=require('node:vm');
const Babel=require('@babel/standalone');
const {writeTextDurably,writeJsonDurably}=require('../durable-json');
const {createCloudTranslation}=require('../cloud-translation');
const {validateDataTarget,migrateDataRootSync,hashFile}=require('../data-root-migration');
const {settlePendingRequests}=require('../shutdown-flow');
const root=path.resolve(__dirname,'..'),generated=path.join(root,'generated');fs.mkdirSync(generated,{recursive:true});
const directory=fs.mkdtempSync(path.join(generated,'audit-fixture-'));
const source=fs.readFileSync(path.join(root,'main.js'),'utf8'),ast=Babel.packages.parser.parse(source,{sourceType:'script'});
const fn=name=>{const n=ast.program.body.find(n=>n.type==='FunctionDeclaration'&&n.id.name===name);assert.ok(n,name);return source.slice(n.start,n.end)};
const cases=[];
(async()=>{try{
 const file=path.join(directory,'config.json');writeJsonDurably(file,{old:true});
 const exdev={...fs,renameSync(){throw Object.assign(Error('encrypted directory'),{code:'EXDEV'})}};
 writeJsonDurably(file,{saved:true},{fsImpl:exdev});assert.equal(JSON.parse(fs.readFileSync(file)).saved,true);
 const before=fs.readFileSync(file);
 const broken={...exdev,copyFileSync(_from,to){fs.writeFileSync(to,'partial');throw Error('disk failed')}};
 assert.throws(()=>writeJsonDurably(file,{saved:false},{fsImpl:broken}),/disk failed/);assert.ok(fs.readFileSync(file).equals(before));
 assert.equal(fs.readdirSync(directory).some(n=>n.endsWith('.tmp')),false);
 assert.throws(()=>writeJsonDurably(file,undefined),/INVALID_JSON_VALUE/);
 cases.push('durable JSON: EXDEV, rollback and temporary-file cleanup');

 const ctx={fs,path,app:{getPath:()=>directory},ACCESS_CONTROL_FILE:'access.json',BOOTSTRAP_CONFIG_FILE:'bootstrap.json',UI_LOCALE_FILE:'locale.txt',SEAT_CONFIG_FILE:'seats.json',APP_STORAGE_DB_FILE:'data.sqlite',writeTextDurably,writeJsonDurably,normalizeSeatCount:n=>Math.max(1,Math.min(50,Number(n)||10)),isTranslationSettingsHost:()=>true,adminGrants:new Map(),getLocalIPv4Set:()=>new Set()};
 vm.createContext(ctx);
 for(const name of ['bootstrapConfigPath','normalizeDataRoot','readBootstrapConfigSync','readAccessControlRawSync','isIpAllowedByPolicy','isAdminAuthorized','writeSeatConfigSync','writeUiLocaleSync'])vm.runInContext(fn(name),ctx);
 assert.equal(ctx.readAccessControlRawSync().enabled,false);
 for(const content of ['{','null','[]','{"enabled":"false"}',JSON.stringify({adminPasswordHash:'x'.repeat(64)})]){
  fs.writeFileSync(path.join(directory,'access.json'),content);
  const policy=ctx.readAccessControlRawSync();assert.equal(policy.error,'ACCESS_CONFIG_UNREADABLE');assert.equal(ctx.isIpAllowedByPolicy(policy),false);assert.equal(ctx.isAdminAuthorized({sender:{id:1}}),false);
 }
 assert.equal(ctx.readBootstrapConfigSync().error,undefined);
 for(const content of ['{','null','[]',JSON.stringify({dataRoot:'relative-path'}),JSON.stringify({dataRoot:{}})]){
  fs.writeFileSync(path.join(directory,'bootstrap.json'),content);assert.equal(ctx.readBootstrapConfigSync().error,'BOOTSTRAP_CONFIG_UNREADABLE');
 }
 assert.equal(ctx.normalizeDataRoot('relative-path'),'');assert.equal(ctx.normalizeDataRoot({}), '');
 cases.push('corrupt access policy fails closed; corrupt/relative bootstrap paths rejected');
 assert.equal(ctx.writeSeatConfigSync({seatCount:12}).ok,true);const seats=fs.readFileSync(path.join(directory,'seats.json'));
 ctx.writeJsonDurably=()=>{throw Error('disk failed')};ctx.writeTextDurably=ctx.writeJsonDurably;
 assert.equal(ctx.writeSeatConfigSync({seatCount:24}).ok,false);assert.ok(fs.readFileSync(path.join(directory,'seats.json')).equals(seats));assert.throws(()=>ctx.writeUiLocaleSync('en'),/disk failed/);
 cases.push('seat and locale writes never report success on disk failure');

 let closed=0,clock=1000;class BrokenDatabase{exec(){throw Error('database busy')}close(){closed++}}
 Object.assign(ctx,{storageDb:null,storageDbReady:false,storageDbRetryAfter:0,Date:{now:()=>clock},require:()=>({DatabaseSync:BrokenDatabase}),writeDiagnosticLog(){}});
 vm.runInContext(fn('storageDbPath')+'\n'+fn('getStorageDb'),ctx);
 assert.equal(ctx.getStorageDb(),null);assert.equal(closed,1);assert.equal(ctx.getStorageDb(),null);assert.equal(closed,1);clock+=3001;assert.equal(ctx.getStorageDb(),null);assert.equal(closed,2);
 cases.push('failed SQLite initialization closes its handle and retries with backoff');

 const trust={path,__dirname:root,URL,pathToFileURL:require('node:url').pathToFileURL};vm.createContext(trust);
 vm.runInContext(fn('isTranslationSettingsHost')+'\n'+fn('isTrustedTranslationSender'),trust);
 const frame={url:'https://web.whatsapp.com/'};const event={senderFrame:frame,sender:{mainFrame:frame,getURL:()=>frame.url,getType:()=> 'webview'}};
 assert.equal(trust.isTrustedTranslationSender(event),true);frame.url='https://attacker.invalid/';assert.equal(trust.isTrustedTranslationSender(event),false);
 frame.url='http://web.whatsapp.com/';assert.equal(trust.isTrustedTranslationSender(event),false);frame.url='https://web.whatsapp.com/';event.senderFrame={url:frame.url};assert.equal(trust.isTrustedTranslationSender(event),false);assert.equal(trust.isTrustedTranslationSender(null),false);
 cases.push('translation/clipboard IPC restricted to trusted main frames; destroyed senders rejected');

 const html=fs.readFileSync(path.join(root,'index.html'),'utf8');const start=html.indexOf('const readStorageTextWithSqliteFirst =');const end=html.indexOf('/** 左侧「号码奖励管理」',start);
 let writes=0,errors=0,fail=false;const values=new Map();
 const render={appStorage:{getItem:k=>values.get(k)??null,setItem(k,v){if(fail)throw Error('disk failed');writes++;values.set(k,v)}},FASTGC_STORAGE_SNAPSHOT:{fastgc_global_inbox:'stale'},notifyStorageFailure:()=>errors++};
 vm.createContext(render);vm.runInContext(html.slice(start,end)+'\nglobalThis.read=readStorageTextWithSqliteFirst;globalThis.write=writeMigratedStorage',render);
 assert.equal(render.read('fastgc_global_inbox'),'');assert.equal(render.write('fastgc_global_inbox','[]'),true);assert.equal(writes,1);fail=true;assert.equal(render.write('fastgc_global_inbox','wrong'),false);assert.equal(render.read('fastgc_global_inbox'),'[]');assert.equal(errors,1);
 cases.push('one durable write per business change; failed writes and deleted values remain correct');
 const notices=[];const notificationContext={setTimeout:callback=>notices.push(callback),window:{alert(){}}};vm.createContext(notificationContext);
 const noticeStart=html.indexOf('let storageErrorShown = false;'),noticeEnd=html.indexOf('const appStorage =',noticeStart);
 vm.runInContext(html.slice(noticeStart,noticeEnd)+'\nnotifyStorageFailure();notifyStorageFailure();',notificationContext);assert.equal(notices.length,1);
 vm.runInContext('storageErrorShown=false;notifyStorageFailure()',notificationContext);assert.equal(notices.length,2);
 cases.push('repeated disk failures produce one notification until storage recovers');

 let timer,writeFails=true,cacheWrites=0;const cache={fastgcTranslatePersistWriteTimer:null,fastgcTranslatePersistDirty:true,fastgcTranslatePersistRetryMs:1200,fastgcTranslatePersistMap:new Map([['key',{text:'text',lastHitAt:1}]]),FASTGC_TRANSLATE_PERSIST_MAX:4000,fastgcTranslatePersistPath:()=>file,setTimeout(callback,ms){timer={callback,ms};return{unref(){}}},writeJsonDurably(){cacheWrites++;if(writeFails)throw Error('disk failed')},writeDiagnosticLog(){}};
 vm.createContext(cache);vm.runInContext(fn('fastgcTranslatePersistScheduleWrite'),cache);cache.fastgcTranslatePersistScheduleWrite();assert.equal(timer.ms,1200);timer.callback();assert.equal(cache.fastgcTranslatePersistDirty,true);assert.equal(timer.ms,2400);writeFails=false;timer.callback();assert.equal(cache.fastgcTranslatePersistDirty,false);assert.equal(cacheWrites,2);
 cases.push('cache write failure preserves dirty state and retries before clearing it');

 const from=path.join(directory,'source'),to=path.join(directory,'destination');fs.mkdirSync(from);fs.writeFileSync(path.join(from,'a.txt'),'preserved');const large=Buffer.alloc(1024*1024+17,93);fs.writeFileSync(path.join(from,'b.data'),large);fs.writeFileSync(path.join(from,'lockfile'),'ignore');
 assert.equal(hashFile(path.join(from,'b.data')),crypto.createHash('sha256').update(large).digest('hex'));
 assert.throws(()=>validateDataTarget(from,path.join(from,'nested')),/OVERLAP/);
 const outside=path.join(directory,'outside');fs.mkdirSync(outside);const link=path.join(directory,'target-link');fs.symlinkSync(outside,link,process.platform==='win32'?'junction':'dir');assert.throws(()=>validateDataTarget(from,link),/SYMLINK_DATA_TARGET/);fs.unlinkSync(link);
 const migrated=migrateDataRootSync(from,to);assert.equal(migrated.files,2);assert.equal(hashFile(path.join(to,'b.data')),hashFile(path.join(from,'b.data')));
 const rollback=path.join(directory,'rollback');fs.mkdirSync(rollback);const originalCopy=fs.copyFileSync;
 try{fs.copyFileSync=(a,b)=>{originalCopy(a,b);throw Error('copy interrupted')};assert.throws(()=>migrateDataRootSync(from,rollback),/copy interrupted/)}finally{fs.copyFileSync=originalCopy}
 assert.deepEqual(fs.readdirSync(rollback),[]);assert.equal(fs.readFileSync(path.join(from,'a.txt'),'utf8'),'preserved');
 cases.push('migration rejects junction targets, streams hashes, and removes only its partial files');

 const cloudDirectory=path.join(directory,'cloud');const service=createCloudTranslation({userDataDir:()=>cloudDirectory,safeStorage:{isEncryptionAvailable:()=>true,encryptString:s=>Buffer.from(s),decryptString:b=>b.toString()},fetchImpl:(_url,{signal})=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true}))});
 assert.equal(service.saveConfig({provider:'google-cloud-nmt',projectId:'fixture-project',apiKey:'fixture-key-0123456789abcdef',limit:450000}).ok,true);
 const request=service.translate('Hello','en','zh-CN');assert.equal(service.cancelPending(),1);assert.equal((await request).ok,false);assert.equal(service.cancelPending(),0);assert.equal(service.getStatus().used,5);
 assert.equal((await settlePendingRequests([Promise.reject(Error('aborted'))])).completed,true);assert.equal((await settlePendingRequests([new Promise(()=>{})],{timeoutMs:20})).completed,false);
 cases.push('shutdown aborts pending translation without refunding uncertain quota reservations');
 assert.ok(html.includes('result.saved !== items.length'));assert.ok(html.includes("appStorage.getItem(SQLITE_MIGRATION_MARK_KEY) === '1'"));assert.ok(html.includes("r.querySelector('[data-fastgc-error]').textContent = msg"));
 cases.push('migration results checked, redundant startup migration skipped, error text is not HTML');
 console.log(JSON.stringify({passed:true,cases}));
}finally{
 const resolved=fs.realpathSync(directory);if(path.dirname(resolved)!==fs.realpathSync(generated)||!path.basename(resolved).startsWith('audit-fixture-'))throw Error('Unsafe test cleanup');
 fs.rmSync(resolved,{recursive:true,force:true});
}})().catch(error=>{console.error(error);process.exitCode=1});
