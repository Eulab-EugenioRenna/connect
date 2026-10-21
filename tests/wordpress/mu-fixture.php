<?php
require_once '/var/www/html/wp-load.php';
$path=WPMU_PLUGIN_DIR.'/eulab-connect/eulab-connect.php';
$phase=$argv[1] ?? 'assert';
if ($phase==='expose-installer') {copy('/artifacts/euconnect.php',ABSPATH.'euconnect.php');echo 'Installer esposto temporaneamente per QA browser.';}
elseif($phase==='remove-installer') {if(is_file(ABSPATH.'euconnect.php'))unlink(ABSPATH.'euconnect.php');echo 'Installer pubblico rimosso.';}
elseif ($phase==='delete-plugin') {if(is_file($path))unlink($path);delete_transient('eulab_mu_next_check');echo 'File plugin MU eliminato per il collaudo.';}
elseif($phase==='delete-loader') {if(is_file(WPMU_PLUGIN_DIR.'/euconnect.php'))unlink(WPMU_PLUGIN_DIR.'/euconnect.php');if(is_file($path))unlink($path);echo 'Loader e file plugin rimossi per il collaudo.';}
elseif($phase==='clear-policy') {delete_transient('eulab_mu_next_check');echo 'Controllo policy richiesto.';}
else {$baseline=get_option('eulab_qa_mu_baseline');$valid=$baseline && $baseline['users']===count_users()['total_users'] && hash_equals($baseline['credentialHash'],hash('sha256',serialize(get_option('eulab_connect_credentials'))));if(!$valid)throw new Exception('Utenti o associazione modificati');echo json_encode(['users'=>count_users()['total_users'],'credentialsPreserved'=>$valid,'muFile'=>is_file($path),'loaded'=>function_exists('eulab_connect_credentials'),'ordinaryActive'=>in_array('eulab-connect/eulab-connect.php',get_option('active_plugins',[]),true)]);}
