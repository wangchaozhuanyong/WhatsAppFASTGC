import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import babel from '@babel/standalone';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
const html=read('index.html'),main=read('main.js'),preload=read('preload.js');
const marker='<script type="text/babel">';
const renderer=html.slice(html.indexOf(marker)+marker.length,html.lastIndexOf('</script>'));
const parse=source=>babel.packages.parser.parse(source,{sourceType:'script',plugins:['jsx']});
const rendererAst=parse(renderer),mainAst=parse(main),preloadAst=parse(preload);
const retiredChannels=new Set(['fastgc:member-detail','fastgc:exchange-rates','fastgc:orders-latest-trade','fastgc:orders-recent-completed','app:get-api-secret','app:set-api-secret']);
const retiredMethods=new Set(['getMemberDetail','getExchangeRates','getOrdersLatestTrade','getRecentCompletedOrders','getApiSecret','setApiSecret']);
const channels=new Set(),methods=new Set();
babel.packages.traverse.default(mainAst,{CallExpression(p){if(p.node.callee.object?.name==='ipcMain'&&p.node.callee.property?.name==='handle')channels.add(p.node.arguments[0]?.value);}});
babel.packages.traverse.default(preloadAst,{ObjectMethod(p){methods.add(p.node.key.name);}});
for(const key of retiredChannels)assert.equal(channels.has(key),false,`removed IPC ${key}`);
for(const key of retiredMethods)assert.equal(methods.has(key),false,`removed bridge ${key}`);
for(const key of ['fastgc:google-translate','fastgc:wa-js-bundle','app:get-seat-config','app:get-update-feed'])assert.equal(channels.has(key),true,`preserved IPC ${key}`);
for(const key of ['readWaJsBundle','storageMigrateBatch','getAccessControl','getDataRoot'])assert.equal(methods.has(key),true,`preserved bridge ${key}`);
for(const name of ['CrmExhaustiveForm','lookupFastgcMember','collectBizFormDataFromActivePage','buildBizFormCollectScript','memberDetail','apiConfig'])assert.equal(new RegExp(`\\b${name}\\b`).test(renderer),false,`removed UI/background logic ${name}`);
assert.equal(html.includes('会员资料'),false);
assert.equal(html.includes('API Token'),false);
assert.equal(main.includes('/members/detail'),false);
assert.equal(main.includes('https://fastgc.cc'),false);
assert.match(renderer,/<RightScriptLibrary onFill=\{copyToClipboard\} onSend=\{sendScriptToWhatsApp\}/);

const browserGlobals=new Set(['localStorage','React','window','FastGcWaShared','document','clearTimeout','setTimeout','Image','console','URL','cancelIdleCallback','requestIdleCallback','requestAnimationFrame','cancelAnimationFrame','fetch','ResizeObserver','Node','FileReader','Blob','setInterval','clearInterval','sessionStorage','confirm','navigator','ReactDOM']);
const unresolved=new Set();
babel.packages.traverse.default(rendererAst,{ReferencedIdentifier(p){const name=p.node.name;if(!p.scope.hasBinding(name)&&!browserGlobals.has(name))unresolved.add(name);}});
assert.deepEqual([...unresolved],[],'no dangling renderer references after removal');

// 执行真实迁移片段，验证只删除旧会员配置，话术、会话和席位设置保持原值。
const cleanup=rendererAst.program.body.find(n=>n.type==='TryStatement'&&renderer.slice(n.start,n.end).includes('fastgc_api_config'));
assert.ok(cleanup);
const untouched=['fastgc_script_quick','content_manager_data','fastgc_global_inbox','fastgc_seat_layout_v2','wa-session-marker'];
const retired=['fastgc_api_config','fastgc_crm_right_panel_width_px','fastgc_crm_right_panel_collapsed'];
const storage=new Map([...untouched,...retired].map(key=>[key,`saved-${key}`]));
vm.runInNewContext(renderer.slice(cleanup.start,cleanup.end),{appStorage:{removeItem:key=>storage.delete(key)}});
for(const key of retired)assert.equal(storage.has(key),false);
for(const key of untouched)assert.equal(storage.get(key),`saved-${key}`);

let fileCleanup;
babel.packages.traverse.default(mainAst,{TryStatement(p){if(main.slice(p.node.start,p.node.end).includes('fastgc_api_secret.bin'))fileCleanup=p.node;}});
assert.ok(fileCleanup);
const removed=[];
vm.runInNewContext(main.slice(fileCleanup.start,fileCleanup.end),{app:{getPath:name=>{assert.equal(name,'userData');return '/existing-user-data';}},path,fs:{rmSync:(file,options)=>removed.push({file,options})}});
assert.equal(removed.length,1);
assert.equal(removed[0].file,path.join('/existing-user-data','fastgc_api_secret.bin'));
assert.equal(removed[0].options.recursive,undefined,'no recursive session/data deletion');
console.log('PASS: member UI, timers, APIs and credentials bridge removed; scripts/translation/seats retained; migrations preserve unrelated data; no dangling renderer references.');
