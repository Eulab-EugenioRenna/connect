import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const plugin=await readFile('plugins/wordpress/eulab-connect/eulab-connect.php');
const loader=(await readFile('scripts/wordpress-installer/mu-loader.template.php','utf8')).replace('__EULAB_PLUGIN_BASE64__',plugin.toString('base64')).replace('__EULAB_PLUGIN_SHA256__',createHash('sha256').update(plugin).digest('hex'));
const installer=(await readFile('scripts/wordpress-installer/installer.template.php','utf8')).replace('__EULAB_LOADER_BASE64__',Buffer.from(loader).toString('base64')).replace('__EULAB_PLUGIN_BASE64__',plugin.toString('base64')).replace('__EULAB_PLUGIN_SHA256__',createHash('sha256').update(plugin).digest('hex'));
await mkdir('dist/wordpress',{recursive:true});await mkdir('dist/web/downloads',{recursive:true});await writeFile('dist/web/downloads/euconnect.php',installer);await writeFile('dist/wordpress/euconnect.php',installer);await writeFile('plugins/wordpress/euconnect.php',installer);await writeFile('dist/wordpress/mu-loader.php',loader);
console.log('Installer WordPress generato: plugins/wordpress/euconnect.php (copia anche in dist/wordpress)');
