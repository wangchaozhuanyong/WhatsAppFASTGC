const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {createSeatEnvironmentStore}=require('../seat-environment');
const {installSeatFingerprint}=require('../seat-fingerprint');
const generated=path.resolve(__dirname,'../generated');fs.mkdirSync(generated,{recursive:true});const directory=fs.mkdtempSync(path.join(generated,'seat-env-test-'));
const sha=value=>crypto.createHash('sha256').update(Buffer.from(value.buffer||value)).digest('hex');
function realm(profile){
 const context={location:{protocol:'https:',hostname:'web.whatsapp.com'},profile,Buffer};vm.createContext(context);
 vm.runInContext(`
 class Context2D {constructor(canvas){this.canvas=canvas} getImageData(x,y,w,h){if(!w||!h)throw Error('IndexSizeError');return {width:w,height:h,data:this.canvas.pixels.slice(0,w*h*4)}} putImageData(image){this.canvas.pixels.set(image.data)} drawImage(other){this.canvas.pixels.set(other.pixels)}}
 class Canvas {constructor(){this.width=64;this.height=32;this.pixels=new Uint8ClampedArray(64*32*4).fill(128)}getContext(){return new Context2D(this)}toDataURL(){return Buffer.from(this.pixels).toString('hex')}toBlob(callback){callback({bytes:this.pixels.slice()})}}
 class GL {constructor(){this.RGBA=6408;this.UNSIGNED_BYTE=5121}readPixels(x,y,w,h,format,type,data){data.fill(128)}}
 class AudioBuffer {constructor(){this.numberOfChannels=1;this.samples=new Float32Array(4800)}getChannelData(){return this.samples}}
 class Offline {startRendering(){return Promise.resolve(new AudioBuffer)}}
 globalThis.CanvasRenderingContext2D=Context2D;globalThis.HTMLCanvasElement=Canvas;globalThis.WebGLRenderingContext=GL;globalThis.OfflineAudioContext=Offline;globalThis.document={createElement:()=>new Canvas};
 `,context);
 vm.runInContext('globalThis.install='+installSeatFingerprint.toString(),context);const status=vm.runInContext('install(profile)',context);
 return {context,status,evaluate:code=>vm.runInContext(code,context)};
}
(async()=>{try{
 const store=createSeatEnvironmentStore({userDataDir:()=>directory}),a=store.profile('fastgc-wa-seat-1'),b=store.profile('fastgc-wa-seat-3-'+'a'.repeat(32));
 assert.notEqual(a.id,b.id);assert.notDeepEqual(a.seed,b.seed);assert.deepEqual(createSeatEnvironmentStore({userDataDir:()=>directory}).profile('fastgc-wa-seat-1'),a);
 for(const p of ['fastgc-wa','fastgc-wa-seat-51','../fastgc-wa-seat-1','fastgc-wa-seat-0','fastgc-wa-seat-3-bad'])assert.throws(()=>store.profile(p),/INVALID_SEAT_PARTITION/);
 const x=realm(a),y=realm(b);assert.equal(x.status.features.canvas,true);assert.equal(x.status.features.webgl,true);assert.equal(x.status.features.offlineAudio,true);
 const get=env=>env.evaluate(`(()=>{const canvas=new HTMLCanvasElement(),before=Buffer.from(canvas.pixels).toString('hex'),read=canvas.getContext('2d').getImageData(0,0,64,32).data,encoded=canvas.toDataURL();let blob;canvas.toBlob(value=>blob=value);return {before,after:Buffer.from(canvas.pixels).toString('hex'),readHex:Buffer.from(read).toString('hex'),encoded,blobHex:Buffer.from(blob.bytes).toString('hex')}})()`);
 const first=get(x);assert.equal(first.before,first.after);assert.equal(first.encoded,first.readHex);assert.equal(first.blobHex,first.readHex);assert.notEqual(first.encoded,get(y).encoded);assert.equal(first.encoded,get(x).encoded);
 x.evaluate('install(profile)');assert.equal(first.encoded,get(x).encoded);assert.equal(first.encoded,get(realm(a)).encoded);
 const gl=env=>env.evaluate(`(()=>{const gl=new WebGLRenderingContext(),pixels=new Uint8Array(64*32*4);gl.readPixels(0,0,64,32,gl.RGBA,gl.UNSIGNED_BYTE,pixels);return Buffer.from(pixels).toString('hex')})()`);assert.notEqual(gl(x),gl(y));assert.equal(gl(x),gl(realm(a)));
 const audio=env=>env.evaluate(`new OfflineAudioContext().startRendering().then(buffer=>Buffer.from(buffer.getChannelData(0).buffer).toString('hex'))`);assert.notEqual(await audio(x),await audio(y));assert.equal(await audio(x),await audio(realm(a)));
 const file=path.join(directory,'fastgc-seat-environments.json'),saved=fs.readFileSync(file);fs.writeFileSync(file,'broken');assert.throws(()=>createSeatEnvironmentStore({userDataDir:()=>directory}).profile('fastgc-wa-seat-1'),/CONFIG_UNREADABLE/);assert.equal(fs.readFileSync(file,'utf8'),'broken');fs.writeFileSync(file,saved);
 const badDir=path.join(directory,'unwritable');fs.mkdirSync(badDir);assert.throws(()=>createSeatEnvironmentStore({userDataDir:()=>badDir,writeJson(){throw Error('disk failure')}}).profile('fastgc-wa-seat-1'),/disk failure/);
 const main=fs.readFileSync(path.resolve(__dirname,'../main.js'),'utf8'),preload=fs.readFileSync(path.resolve(__dirname,'../webview-translate-preload.js'),'utf8');assert.ok(main.includes("if (!isTrustedTranslationSender(event) || event.senderFrame !== event.sender.mainFrame) throw"));assert.ok(preload.includes('contextBridge.executeInMainWorld'));assert.ok(preload.includes('process.isMainFrame'));
 const compiled=fs.readFileSync(path.resolve(__dirname,'../dist/webview-translate-preload.js'),'utf8'),exposed=new Set();let installed=0;
 vm.runInNewContext(compiled,{process:{isMainFrame:true},location:{protocol:'https:',hostname:'web.whatsapp.com'},require(name){assert.equal(name,'electron','Sandbox preload must not require local modules');return {contextBridge:{exposeInMainWorld:name=>exposed.add(name),executeInMainWorld({func,args}){assert.equal(typeof func,'function');assert.deepEqual(Array.from(args[0].profile||args[0].seed),a.seed);installed++;return{ok:true,features:{canvas:true,webgl:true,offlineAudio:true}}}},ipcRenderer:{sendSync:()=>({ok:true,profile:a}),send(){},invoke(){}}}}});
 assert.equal(installed,1);for(const name of ['__fastgcTranslateBridge','__fastgcHostBridge','__fastgcClipboardBridge'])assert.ok(exposed.has(name));
 console.log(JSON.stringify({passed:true,seatSeedsDistinct:true,persistentAcrossRestart:true,canvasReadEncodeAndBlobConsistent:true,canvasBackingStoreUnchanged:true,webglReadsDistinct:true,offlineAudioDistinct:true,repeatedInstallDoesNotAccumulateNoise:true,corruptStateDoesNotRotateIdentity:true,saveFailureDoesNotClaimSuccess:true,hardwareCaptured:false,realMessagesSent:0}));
}finally{const target=fs.realpathSync(directory);if(path.dirname(target)!==fs.realpathSync(generated)||!path.basename(target).startsWith('seat-env-test-'))throw Error('Unsafe fixture cleanup');fs.rmSync(target,{recursive:true,force:true});}})().catch(error=>{console.error(error);process.exitCode=1});
