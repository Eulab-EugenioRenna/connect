import {chromium} from '@playwright/test';
import http from 'node:http';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
process.loadEnvFile('.env');
const config=JSON.parse(await readFile('.guardian.qa.json','utf8')),output='docs/verification/wordpress-mu';
const url='http://localhost:8090/euconnect.php';
const server=http.createServer((req,res)=>{const up=http.request({hostname:'qa-wordpress',port:80,path:req.url,method:req.method,headers:{...req.headers,host:'localhost:8090'}},r=>{res.writeHead(r.statusCode,r.headers);r.pipe(res);});up.on('error',()=>{res.writeHead(502);res.end();});req.pipe(up);});
await new Promise(r=>server.listen(8090,'127.0.0.1',r));let browser;
try{
 browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox']});const p=await browser.newPage();
 assert.equal((await p.request.get(url)).status(),403);
 assert.equal((await p.request.get(url+'?path=/')).status(),400);
 assert.equal((await p.request.get(url+'?/wp3')).status(),400);
 await p.goto('http://localhost:8090/wp-login.php');await p.locator('#user_login').fill('marco.rossi');await p.locator('#user_pass').fill(process.env.QA_WP_PASSWORD);await p.locator('#wp-submit').click();await p.waitForURL('**/wp-admin/**');
 await p.goto(url);await p.getByRole('heading',{name:'Installa EULab Connect come MU-plugin'}).waitFor();assert.equal(await p.locator('[name=path]').count(),0);
 await p.screenshot({path:output+'/installer-browser.png',fullPage:true});
 assert.equal((await p.request.post(url,{form:{apiUrl:config.apiUrl,installationId:config.installationId,secret:config.secret}})).status(),403);
 const nonce=await p.locator('[name=_wpnonce]').inputValue();
 const denied=await p.request.post(url,{form:{_wpnonce:nonce,apiUrl:config.apiUrl,installationId:config.installationId,secret:'x'.repeat(48)}});assert((await denied.text()).includes('non ha autorizzato'));
 assert((await (await p.request.get(url)).text()).includes('Installa EULab Connect come MU-plugin'),'Installer conservato dopo un errore di autorizzazione');
 await p.locator('[name=apiUrl]').fill(config.apiUrl);await p.locator('[name=installationId]').fill(config.installationId);await p.locator('[name=secret]').fill(config.secret);await p.getByRole('button',{name:'Installa MU-plugin',exact:true}).click();
 await p.getByText('Installer eliminato automaticamente.',{exact:false}).waitFor();await p.screenshot({path:output+'/installer-success.png',fullPage:true});
 const installed=await p.request.get('http://localhost:8090/?eulab_qa_installer=1');assert.equal(installed.status(),200);assert.deepEqual(await installed.json(),{installerExists:false,muExists:true,pluginExists:true});assert(!(await (await p.request.get(url)).text()).includes('Installa EULab Connect come MU-plugin'),'L’installer eliminato non viene più eseguito');
 await p.goto('http://localhost:8090/wp-admin/plugins.php');assert.equal(await p.locator('tr[data-plugin="eulab-connect/eulab-connect.php"]').count(),0);
 await p.goto('http://localhost:8090/wp-admin/plugins.php?plugin_status=mustuse');assert.equal(await p.getByRole('row').filter({hasText:'EULab Connect'}).count(),1);await p.screenshot({path:output+'/only-connect-mu.png',fullPage:true});
 const checks=['WordPress rilevato nella cartella del file, senza parametri','Parametri path e vecchia query rifiutati','Amministratore WordPress e nonce richiesti','Installer conservato dopo autorizzazione negata','Installazione MU riuscita e installer autoeliminato (assenza del file verificata)','Unica voce Connect nei Plugin obbligatori'];
 await writeFile(output+'/browser.json',JSON.stringify({status:'passed',at:new Date().toISOString(),checks},null,2)+'\n');console.log(JSON.stringify({status:'passed',checks}));
}finally{if(browser)await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
