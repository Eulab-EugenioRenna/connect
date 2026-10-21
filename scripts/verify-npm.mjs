import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../',import.meta.url)),artifacts=join(root,'dist/releases/npm');
const records=JSON.parse(await readFile(join(artifacts,'manifest.json'),'utf8'));
function run(command,args,cwd=root,env=process.env){
 const result=spawnSync(command,args,{cwd,env,encoding:'utf8',timeout:300_000,maxBuffer:8*1024*1024});
 assert.equal(result.status,0,result.error?.message||result.stderr||result.stdout);
 if(result.stdout)console.log(result.stdout.trim());
}
for(const record of records){
 const bytes=await readFile(join(artifacts,record.filename));
 assert.equal(bytes.length,record.bytes,record.filename);
 assert.equal(createHash('sha256').update(bytes).digest('hex'),record.sha256,record.filename);
}
run(process.execPath,['openwaunlocked/tools/release/smoke-eulab-npm.mjs'],root,{...process.env,EULAB_NPM_ARTIFACTS:artifacts});
const directory=await mkdtemp(join(tmpdir(),'connect-sdk-consumer-'));
try{
 const sdk=records.find(record=>record.name==='@eulab/connect');assert(sdk);
 await writeFile(join(directory,'package.json'),JSON.stringify({private:true,type:'module'}));
 run('npm',['install','--offline','--ignore-scripts','--no-audit','--no-fund',join(artifacts,sdk.filename)],directory);
 await writeFile(join(directory,'smoke.mjs'),`
import assert from 'node:assert/strict';
import {ConnectBrowser} from '@eulab/connect/browser';
import {ConnectServer,verifyWebhook} from '@eulab/connect/server';
assert.equal(typeof ConnectBrowser,'function');assert.equal(typeof verifyWebhook,'function');
const server=new ConnectServer({apiUrl:'http://localhost',installationId:'test',secret:'test'});
assert.equal(typeof server.whatsapp('test').subscribe,'function');
console.log('Connect SDK: export ESM browser/server e client WhatsApp OK');
`);
 run(process.execPath,['smoke.mjs'],directory);
 await writeFile(join(directory,'types.mts'),`
import {ConnectBrowser,type BrowserConfig} from '@eulab/connect/browser';
import {ConnectServer,verifyWebhook} from '@eulab/connect/server';
const config:BrowserConfig={apiUrl:'http://localhost',issuer:'http://localhost',clientId:'test',redirectUri:'http://localhost'};
new ConnectBrowser(config);new ConnectServer({apiUrl:config.apiUrl,installationId:'test',secret:'test'});
verifyWebhook('secret','body','123','signature');
`);
 run(process.execPath,[join(root,'node_modules/typescript/bin/tsc'),'--noEmit','--strict','--target','ES2022','--module','NodeNext','--moduleResolution','NodeNext','types.mts'],directory);
 console.log(`Checksum ${records.length}/${records.length} e tipi TypeScript del Connect SDK OK. Nessuna richiesta a Connect o WhatsApp.`);
}finally{await rm(directory,{recursive:true,force:true});}
