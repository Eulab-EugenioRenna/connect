import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,appendFile,mkdir,writeFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
if(!process.argv.includes('--reset-qa-site-users'))throw new Error('Usare --reset-qa-site-users esclusivamente per il sito Docker QA localhost:8090');
process.loadEnvFile('.env');
const exec=promisify(execFile),compose=['compose','-f','compose.yaml','-f','infra/compose.qa.yaml'];
const values={QA_SITE_GIULIA_PASSWORD:randomBytes(24).toString('hex'),QA_SITE_SARA_PASSWORD:randomBytes(24).toString('hex'),QA_SITE_PAOLO_PASSWORD:randomBytes(24).toString('hex')};
const env=await readFile('.env','utf8'),missing=Object.entries(values).filter(([key])=>!new RegExp(`^${key}=`, 'm').test(env));
if(missing.length){await appendFile('.env','\n# Utenti indipendenti del solo sito WordPress QA\n'+missing.map(([key,value])=>`${key}=${value}`).join('\n')+'\n');for(const [key,value]of missing)process.env[key]=value;}
const backup='backups/wordpress-users-'+new Date().toISOString().replace(/[:.]/g,'-');await mkdir(backup,{recursive:true,mode:0o700});
const dump=await exec('docker',[...compose,'exec','-T','qa-db','sh','-c','MYSQL_PWD="$MARIADB_ROOT_PASSWORD" exec mariadb-dump -u root --single-transaction wordpress'],{maxBuffer:20*1024*1024});
await writeFile(backup+'/wordpress.sql',dump.stdout,{mode:0o600});
const php=`define('WP_INSTALLING',true);require '/var/www/html/wp-load.php';require_once ABSPATH.'wp-admin/includes/user.php';
if(home_url()!=='http://localhost:8090'||is_multisite())throw new Exception('Il reset è limitato al sito locale di collaudo');
$specs=[['marco.rossi','Marco Rossi','administrator','QA_WP_PASSWORD'],['giulia.bianchi','Giulia Bianchi','administrator','QA_SITE_GIULIA_PASSWORD'],['sara.verdi','Sara Verdi','editor','QA_SITE_SARA_PASSWORD'],['paolo.ferri','Paolo Ferri','author','QA_SITE_PAOLO_PASSWORD'],['luca.neri','Luca Neri','subscriber','QA_WP_CUSTOMER_PASSWORD']];
$keep=[];$result=[];foreach($specs as [$login,$name,$role,$password]){$user=get_user_by('login',$login);$id=$user?$user->ID:0;$id=wp_insert_user(['ID'=>$id,'user_login'=>$login,'display_name'=>$name,'user_email'=>$login.'@example.test','user_pass'=>getenv($password),'role'=>$role]);if(is_wp_error($id))throw new Exception($id->get_error_message());$keep[]=$id;$result[]=['id'=>$id,'username'=>$login,'name'=>$name,'role'=>$role];}
foreach(get_users(['fields'=>'ID']) as $id){if(!in_array((int)$id,$keep,true))wp_delete_user($id,$keep[0]);}
echo json_encode(['site'=>home_url(),'users'=>$result,'passwordsChangedOnlyOnQaSite'=>true,'postsReassignedTo'=>$keep[0]]);`;
const result=await exec('docker',[...compose,'exec','-T',...['QA_WP_PASSWORD','QA_WP_CUSTOMER_PASSWORD',...Object.keys(values)].flatMap(k=>['-e',k]),'qa-wordpress','php','-r',php],{env:process.env});
const fixture=JSON.parse(result.stdout);
// Clear only explicit local links for this QA installation. Never alter Keycloak users.
const cleanup=`import pg from 'pg';const db=new pg.Pool({connectionString:process.env.DATABASE_URL});const id=process.env.QA_INSTALLATION_ID;try{await db.query('BEGIN');const r=await db.query("DELETE FROM local_links WHERE installation_id=$1 AND EXISTS(SELECT 1 FROM installations WHERE id=$1 AND domain='http://localhost:8090') RETURNING local_user_id",[id]);await db.query("INSERT INTO audit(actor,action,target,detail) VALUES('qa-reset','wordpress.qa.users.reset',$1,$2)",[id,JSON.stringify({removedLocalLinks:r.rowCount,preservedCentralIdentities:true})]);await db.query('COMMIT');}catch(e){await db.query('ROLLBACK');throw e;}finally{await db.end();}`;
await exec('docker',[...compose,'exec','-T','-e','QA_INSTALLATION_ID','api','node','--input-type=module','-e',cleanup],{env:process.env});
await writeFile('docs/verification/wordpress-users.json',JSON.stringify({...fixture,backup,centralIdentitiesUnchanged:true,localSsoLinks:0},null,2)+'\n');
console.log(JSON.stringify({status:'passed',site:fixture.site,users:fixture.users,backup,centralIdentitiesUnchanged:true}));
