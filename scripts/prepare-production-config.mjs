import {readFile,writeFile} from 'node:fs/promises';
const realm=JSON.parse(await readFile('infra/keycloak/realm.json','utf8'));
realm.clients=realm.clients.filter(c=>c.clientId!=='connect-demo');
const admin=realm.clients.find(c=>c.clientId==='connect-admin');
admin.redirectUris=['https://connect.eulab.cloud/admin/'];
admin.webOrigins=['https://connect.eulab.cloud'];
admin.attributes['post.logout.redirect.uris']='https://connect.eulab.cloud/admin/';
await writeFile('infra/keycloak/realm.production.json',JSON.stringify(realm,null,2)+'\n');
console.log('Configurazione produzione: pannello connect.eulab.cloud/admin/, SSO auth.eulab.cloud/sso/. Nessun deploy.');
