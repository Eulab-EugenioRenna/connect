import {copyFile,mkdir} from 'node:fs/promises';
for(const directory of ['apps/web/public/brand','infra/keycloak/themes/eulab/login/resources/img']){
 await mkdir(directory,{recursive:true});await copyFile('assets/brand/logo.svg',directory+'/logo.svg');
}
console.log('Logo condiviso aggiornato per admin e SSO.');
