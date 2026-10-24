import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
// Run after the production Compose build. No account pairing or external sends.
function docker(args){
 const result=spawnSync('docker',args,{encoding:'utf8',timeout:120_000,maxBuffer:4*1024*1024});
 assert.equal(result.status,0,result.stderr||result.error?.message||'Verifica Docker fallita');
 return result.stdout;
}
const prefix=process.argv[2]||'eulab-connect-production';
const inspectRuntime=String.raw`
import assert from 'node:assert/strict';
import {existsSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {createRequire} from 'node:module';
const target=process.env.VERIFY_TARGET;
assert.equal(process.getuid(),1000);
assert(existsSync('/connect/'+target+'.mjs'));
for(const path of ['/connect/apps','/connect/packages','/connect/scripts','/connect/tests','/connect/package.json','/connect/package-lock.json','/usr/local/bin/npm','/usr/local/bin/npx','/usr/local/bin/yarn'])assert(!existsSync(path),path);
function scan(dir){for(const entry of readdirSync(dir,{withFileTypes:true})){
 if(entry.isSymbolicLink())continue;
 const path=join(dir,entry.name);
 if(entry.isDirectory())scan(path);
 else assert(!/\.(ts|tsx|mts|cts|map)$/.test(entry.name),path);
}}
scan('/connect/node_modules');
const require=createRequire('/connect/check.mjs');
for(const name of ['typescript','tsx','esbuild','vite','@playwright/test','react','react-dom'])assert.throws(()=>require.resolve(name),name);
if(target==='migrate'){assert(existsSync('/connect/infra/postgres/010-team-delegation.sql'));assert(existsSync('/connect/infra/postgres/011-app-onboarding.sql'));}
else assert(!existsSync('/connect/infra'));
if(target==='runner'){
 scan('/opt/openwa/node_modules');
 for(const name of ['@eulab/openwaunlocked-core','@eulab/openwaunlocked-client','@eulab/openwaunlocked-driver-puppeteer','qrcode'])await import(name);
 const assets='/opt/openwa/node_modules/@eulab/openwaunlocked-core/dist/transport/assets/';
 for(const file of ['wapi.js','launch.js','patches.json','init_patch.js'])assert(existsSync(assets+file),file);
 const {spawnSync}=await import('node:child_process');
 const browser=spawnSync('/usr/bin/chromium',['--headless','--no-sandbox','--disable-dev-shm-usage','--dump-dom','about:blank'],{encoding:'utf8',timeout:30_000});
 assert.equal(browser.status,0,browser.stderr);assert(browser.stdout.includes('<html'));
}
console.log(target+': runtime e dipendenze OK');
`;
const sizes={};
for(const target of ['api','migrate','bootstrap','runner']){
 const image=prefix+'-'+target;
 const [info]=JSON.parse(docker(['image','inspect',image]));
 assert.equal(info.Config.User,'node');
 sizes[target]={image,bytes:info.Size,megabytes:Math.round(info.Size/1_000_000)};
 process.stdout.write(docker(['run','--rm','--network','none','--env','VERIFY_TARGET='+target,'--entrypoint','node',image,'--input-type=module','--eval',inspectRuntime]));
}
console.log(JSON.stringify(sizes,null,2));
