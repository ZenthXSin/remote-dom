import {build} from 'esbuild';
import {mkdir,copyFile,readFile,writeFile} from 'node:fs/promises';
await mkdir('dist/public',{recursive:true});
const theme=await readFile('src/ui/theme.css','utf8');
async function page(source,target){await writeFile(target,(await readFile(source,'utf8')).replace('/* APP_THEME */',theme));}
await Promise.all([
  build({entryPoints:['src/server/main.ts'],bundle:true,packages:'external',platform:'node',format:'esm',outfile:'dist/server/main.js',sourcemap:true}),
  build({entryPoints:['src/gateway/main.ts'],bundle:true,packages:'external',platform:'node',format:'esm',outfile:'dist/gateway/main.js'}),
  build({entryPoints:['src/control/main.ts'],bundle:true,packages:'external',platform:'node',format:'esm',outfile:'dist/control/main.js'}),
  build({entryPoints:['src/control/relay-main.ts'],bundle:true,packages:'external',platform:'node',format:'esm',outfile:'dist/control/relay-main.js'}),
  build({entryPoints:['src/control/migrate-browser.ts'],bundle:true,packages:'external',platform:'node',format:'esm',outfile:'dist/control/migrate-browser.js'}),
  build({entryPoints:['src/control/account-client.ts'],bundle:true,platform:'browser',format:'iife',outfile:'dist/public/account.js'}),
  page('src/control/account.html','dist/public/account.html'),
  build({entryPoints:['src/gateway/runlocal-preview.ts'],bundle:true,packages:'external',platform:'node',format:'esm',outfile:'dist/gateway/runlocal-preview.js'}),
  build({entryPoints:['src/server/live-upgrade.ts'],bundle:true,packages:'external',platform:'node',format:'cjs',outfile:'dist/server/live-upgrade.cjs'}),
  build({entryPoints:['src/server/device-profile.ts'],bundle:true,packages:'external',platform:'node',format:'esm',outfile:'dist/server/device-profile.js'}),
  build({entryPoints:['src/server/container-environment.ts'],bundle:true,packages:'external',platform:'node',format:'esm',outfile:'dist/server/container-environment.js'}),
  build({entryPoints:['src/remote/capture.ts'],bundle:true,platform:'browser',format:'iife',outfile:'dist/capture.js'}),
  build({entryPoints:['src/client/app.ts'],bundle:true,platform:'browser',format:'iife',outfile:'dist/public/app.js'}),
  build({entryPoints:['src/client/frame.ts'],bundle:true,platform:'browser',format:'iife',outfile:'dist/public/frame.js'}),
  page('src/client/index.html','dist/public/index.html')
]);
console.log('Built server, isolated-world capture, trusted renderer and control UI.');
