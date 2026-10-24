const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const asar = require('@electron/asar');
module.exports = async context => {
  const archive = path.join(context.appOutDir, 'resources', 'app.asar');
  const read = name => asar.extractFile(archive, path.join(...name.split('/'))).toString('utf8');
  const html = read('index.html');
  assert.ok(html.includes('Content-Security-Policy'), 'Packaged renderer must have CSP');
  assert.ok(html.includes('./dist/renderer-app.js'), 'Compiled renderer entry is missing');
  assert.ok(!/text\/babel|babel\.min\.js|cdn\.tailwindcss/.test(html), 'Runtime compiler or remote script found');
  for (const name of ['main.js','whatsapp-permissions.js','durable-json.js','ui-storage.js','preload.js','webview-translate-preload.js','cloud-translation.js','data-root-migration.js','shutdown-guard.js','shutdown-flow.js','dist/renderer-app.js','dist/tailwind.css']) assert.ok(read(name).length > 0, name);
  const sourcePackage = JSON.parse(fs.readFileSync(path.join(__dirname,'../package.json'),'utf8'));
  assert.equal(JSON.parse(read('package.json')).version, sourcePackage.version);
  console.log('[verify-packaged-app] production entry, compiled assets and CSP verified');
};
