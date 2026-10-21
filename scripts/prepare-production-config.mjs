import {readFile,writeFile} from 'node:fs/promises';
const realm=JSON.parse(await readFile('infra/keycloak/realm.json','utf8'));
realm.clients=realm.clients.filter(c=>c.clientId!=='connect-demo');
const admin=realm.clients.find(c=>c.clientId==='connect-admin');
admin.redirectUris=['https://auth.eulab.cloud/admin/'];
admin.webOrigins=['https://auth.eulab.cloud'];
admin.attributes['post.logout.redirect.uris']='https://auth.eulab.cloud/admin/';
await writeFile('infra/keycloak/realm.production.json',JSON.stringify(realm,null,2)+'\n');
console.log('Configurazione produzione: auth.eulab.cloud, pannello /admin/, SSO /sso/. Nessun deploy.');
