<?php
/** EULab Connect: install beside wp-load.php, open without parameters. PHP >=8.1. */
$is_cli = PHP_SAPI==='cli';
if ((!$is_cli && (($_SERVER['QUERY_STRING'] ?? '')!=='' || isset($_POST['path']))) || ($is_cli && count($argv ?? [])>1)) {
    http_response_code(400); exit('Questo installer non accetta percorsi o parametri. Carica euconnect.php accanto a wp-load.php e aprilo direttamente.');
}
$path=__DIR__;
if (!is_file($path.'/wp-load.php') || !is_file($path.'/wp-includes/version.php')) { http_response_code(400); exit('WordPress non trovato nella cartella corrente. Carica euconnect.php accanto a wp-load.php.'); }
require_once $path.'/wp-load.php';
if (!$is_cli && !current_user_can('activate_plugins')) { http_response_code(403); exit('Accedi prima a questo WordPress come amministratore, poi riapri euconnect.php.'); }
if (!defined('AUTH_KEY') || !defined('SECURE_AUTH_KEY') || !function_exists('sodium_crypto_secretbox')) exit('Sono necessarie le chiavi WordPress e libsodium.');
if (!$is_cli && ($_SERVER['REQUEST_METHOD'] ?? '')!=='POST') {
    header('Cache-Control: no-store'); header('Content-Type: text/html; charset=utf-8');
    echo '<h1>Installa EULab Connect come MU-plugin</h1><p>WordPress individuato nella cartella corrente. Dopo l’installazione questo file si eliminerà automaticamente.</p><form method="post">';
    wp_nonce_field('eulab_mu_install');
    foreach (['apiUrl'=>'URL API Connect','installationId'=>'ID installazione','secret'=>'Chiave protezione generata da Connect','pairingCode'=>'Codice associazione (solo prima installazione)'] as $key=>$label) echo '<p><label>'.esc_html($label).' <input name="'.esc_attr($key).'" type="'.($key==='secret'||$key==='pairingCode'?'password':'text').'" '.($key==='pairingCode'?'':'required').'></label></p>';
    echo '<button>Installa MU-plugin</button></form>'; exit;
}
if (!$is_cli) check_admin_referer('eulab_mu_install');
$config=$is_cli ? json_decode(getenv('EULAB_GUARDIAN_CONFIG') ?: '{}',true) : $_POST;
$api=rtrim($config['apiUrl'] ?? '','/'); $id=$config['installationId'] ?? ''; $secret=$config['secret'] ?? '';
$url=wp_parse_url($api);
$local=defined('WP_ENVIRONMENT_TYPE') && WP_ENVIRONMENT_TYPE==='local';
if (!$url || isset($url['user']) || isset($url['pass']) || isset($url['query']) || isset($url['fragment']) || (($url['scheme'] ?? '')!=='https' && !($local && ($url['scheme'] ?? '')==='http')) || !preg_match('/^[a-f0-9-]{36}$/',$id) || strlen($secret)<32) exit('Configurazione Connect non valida: usare HTTPS e la chiave dedicata al ripristino.');
$check=wp_remote_post($api.'/v1/wordpress-guardians/'.$id.'/check',['timeout'=>10,'redirection'=>0,'headers'=>['Content-Type'=>'application/json','X-Guardian-Secret'=>$secret],'body'=>wp_json_encode(['status'=>'missing','error'=>''])]);
if (is_wp_error($check) || wp_remote_retrieve_response_code($check)!==201) exit('Connect non ha autorizzato questa installazione. Nessun file modificato.');
$policy=json_decode(wp_remote_retrieve_body($check),true);
if (empty($policy['enabled'])) exit('Il ripristino è fermo da admin. Riattivarlo prima di installare.');
$loader=base64_decode('__EULAB_LOADER_BASE64__',true);
$pluginCode=base64_decode('__EULAB_PLUGIN_BASE64__',true);
$pluginHash='__EULAB_PLUGIN_SHA256__';
$mu=defined('WPMU_PLUGIN_DIR') ? WPMU_PLUGIN_DIR : WP_CONTENT_DIR.'/mu-plugins';
$writeAtomic=function($file,$contents) {
    if (!wp_mkdir_p(dirname($file))) throw new Exception('Directory MU non scrivibile.');
    $tmp=tempnam(dirname($file),'.eulab-install-');
    if (!$tmp || file_put_contents($tmp,$contents,LOCK_EX)!==strlen($contents) || !rename($tmp,$file)) {if($tmp)@unlink($tmp);throw new Exception('Scrittura dei file MU non riuscita.');}
    chmod($file,0644);
    if(function_exists('opcache_invalidate'))opcache_invalidate($file,true);
    if (!is_readable($file) || !hash_equals(hash('sha256',$contents),hash_file('sha256',$file))) throw new Exception('Verifica dei file MU non riuscita.');
};
try {
    if (!$loader || !$pluginCode || !hash_equals($pluginHash,hash('sha256',$pluginCode))) throw new Exception('Pacchetto Connect non valido.');
    $writeAtomic($mu.'/eulab-connect/eulab-connect.php',$pluginCode);
    if (!empty($config['pairingCode'])) $writeAtomic($mu.'/eulab-connect/pairing.local.php',"<?php\nif (!defined('ABSPATH')) exit;\nif (!defined('EULAB_CONNECT_PAIRING_CODE')) define('EULAB_CONNECT_PAIRING_CODE',".var_export($config['pairingCode'],true).");\n");
    $nonce=random_bytes(24);$data=['apiUrl'=>$api,'installationId'=>$id,'secret'=>$secret,'storageKey'=>defined('EULAB_CONNECT_STORAGE_KEY') ? EULAB_CONNECT_STORAGE_KEY : base64_encode(random_bytes(32))];
    $encrypted=base64_encode($nonce.sodium_crypto_secretbox(wp_json_encode($data),$nonce,hash('sha256',AUTH_KEY."\0".SECURE_AUTH_KEY,true)));
    update_option('eulab_mu_guardian',$encrypted,false);
    update_option('eulab_mu_policy',['enabled'=>true,'checkedAt'=>time()],false);
    if (get_option('eulab_mu_guardian')!==$encrypted || empty(get_option('eulab_mu_policy')['enabled'])) throw new Exception('Salvataggio della configurazione non riuscito.');
    $writeAtomic($mu.'/euconnect.php',$loader);
    require_once ABSPATH.'wp-admin/includes/plugin.php';
    deactivate_plugins('eulab-connect/eulab-connect.php',true);
    delete_transient('eulab_mu_next_check');delete_transient('eulab_mu_retry');
} catch (Throwable $error) {
    http_response_code(500);exit('Installazione non completata. '.$error->getMessage().' Il file installer è stato conservato per riprovare.');
}
// Delete only this uploaded installer, after both MU files and configuration were verified.
header('Cache-Control: no-store');
if (function_exists('opcache_invalidate')) opcache_invalidate(__FILE__,true);
if (!@unlink(__FILE__)) {
    echo 'EULab Connect installato nei MU-plugin. Non è stato possibile autoeliminare euconnect.php: rimuovi manualmente il file installer dalla cartella di WordPress.';
} else {
    echo 'EULab Connect installato nei MU-plugin. Installer eliminato automaticamente.';
}
