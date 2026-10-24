import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
await build({entryPoints:[path.join(root,'webview-translate-preload.js')],outfile:path.join(root,'dist/webview-translate-preload.js'),bundle:true,platform:'node',format:'cjs',target:'node22',external:['electron'],legalComments:'none'});
console.log('Seat preload bundled for sandbox-compatible local modules');
