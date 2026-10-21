import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
process.loadEnvFile('.env');
const exec=promisify(execFile);
const compose=['compose','-f','compose.yaml','-f','infra/compose.qa.yaml'];
const php=`define('WP_INSTALLING',true);require '/var/www/html/wp-load.php';require_once ABSPATH.'wp-admin/includes/upgrade.php';require_once ABSPATH.'wp-admin/includes/plugin.php';if(!is_blog_installed()){wp_install('EULab QA','marco.rossi','qa@example.test',true,'',getenv('QA_WP_PASSWORD'));}if(!get_user_by('login','luca.neri')){wp_insert_user(['user_login'=>'luca.neri','user_pass'=>getenv('QA_WP_CUSTOMER_PASSWORD'),'display_name'=>'Luca Neri','role'=>'subscriber']);}update_option('home','http://localhost:8090');update_option('siteurl','http://localhost:8090');$result=activate_plugin('eulab-connect/eulab-connect.php');if(is_wp_error($result)){fwrite(STDERR,$result->get_error_message());exit(1);}echo json_encode(['installed'=>is_blog_installed(),'recoveryUserId'=>get_user_by('login','marco.rossi')->ID,'pluginActive'=>is_plugin_active('eulab-connect/eulab-connect.php')]);`;
const result=await exec('docker',[...compose,'exec','-T','-e','QA_WP_PASSWORD','-e','QA_WP_CUSTOMER_PASSWORD','qa-wordpress','php','-r',php],{env:process.env});
console.log(result.stdout);
