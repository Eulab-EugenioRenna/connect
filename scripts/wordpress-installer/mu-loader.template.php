<?php
/** Plugin Name: EULab Connect
 * Description: Integrazione e ripristino controllati dall’amministrazione Connect.
 */
if (!defined('ABSPATH')) exit;
define('EULAB_CONNECT_MU_PATH', __DIR__ . '/eulab-connect/eulab-connect.php');
// Only the MU installation is operational; avoid an inactive duplicate in Plugins.
add_filter('all_plugins',function($plugins){unset($plugins['eulab-connect/eulab-connect.php']);return $plugins;});
// The build embeds the plugin here, independent from its repairable directory.
$eulab_payload = '__EULAB_PLUGIN_BASE64__';
$eulab_hash = '__EULAB_PLUGIN_SHA256__';
(function($payload, $digest) {
    $encrypted = get_option('eulab_mu_guardian', '');
    if (!$encrypted || !defined('AUTH_KEY') || !defined('SECURE_AUTH_KEY') || !function_exists('sodium_crypto_secretbox_open')) return;
    $raw = base64_decode($encrypted, true);
    if (!$raw || strlen($raw) < 25) return;
    $json = sodium_crypto_secretbox_open(substr($raw,24),substr($raw,0,24),hash('sha256',AUTH_KEY . "\0" . SECURE_AUTH_KEY,true));
    $config = $json ? json_decode($json,true) : null;
    if (!$config) return;
    if (!defined('EULAB_CONNECT_API')) define('EULAB_CONNECT_API',$config['apiUrl']);
    if (!defined('EULAB_CONNECT_STORAGE_KEY') && !empty($config['storageKey'])) define('EULAB_CONNECT_STORAGE_KEY',$config['storageKey']);
    $path = __DIR__ . '/eulab-connect/eulab-connect.php';
    $policy = get_option('eulab_mu_policy', ['enabled'=>false]);
    $report = function($status, $error = '') use ($config) {
        $r = wp_remote_post(rtrim($config['apiUrl'],'/') . '/v1/wordpress-guardians/' . rawurlencode($config['installationId']) . '/check', ['timeout'=>5,'redirection'=>0,'headers'=>['Content-Type'=>'application/json','X-Guardian-Secret'=>$config['secret']],'body'=>wp_json_encode(['status'=>$status,'error'=>substr($error,0,500)])]);
        if (is_wp_error($r) || wp_remote_retrieve_response_code($r)!==201) return null;
        $body=json_decode(wp_remote_retrieve_body($r),true);
        return is_array($body)&&isset($body['enabled']) ? ['enabled'=>(bool)$body['enabled'],'checkedAt'=>time()] : null;
    };
    $fresh = false;
    if (!get_transient('eulab_mu_next_check')) {
        $latest=$report(empty($policy['enabled'])?'paused':(is_file($path)?'active':'missing'));
        set_transient('eulab_mu_next_check',1,30);
        if ($latest) { $policy=$latest; update_option('eulab_mu_policy',$policy,false); $fresh=true; }
    }
    // Paused stays paused during an outage. Existing files may use the last known policy;
    // a missing file is restored only after a fresh authorization from Connect.
    if (empty($policy['enabled'])) {
        add_shortcode('eulab_function', function() { return ''; });
        if (!function_exists('eulab_connect_can')) { function eulab_connect_can($permission, $token = '') { return false; } }
        if (!function_exists('eulab_connect_require')) { function eulab_connect_require($permission, $token = '') { wp_die('Integrazione Connect sospesa dall’amministratore.', '', ['response'=>403]); } }
        add_action('init', function() {
            if (!is_user_logged_in()) return;
            $manager=WP_Session_Tokens::get_instance(get_current_user_id());
            $session=$manager->get(wp_get_session_token());
            if (!empty($session['eulab_actor']) || !empty($session['eulab_customer_subject'])) { $manager->destroy(wp_get_session_token()); wp_clear_auth_cookie(); wp_set_current_user(0); }
        },0);
        return;
    }
    if (!is_file($path) && $fresh && !get_transient('eulab_mu_retry')) {
        try {
            $code=base64_decode($payload,true);
            if (!$code || !hash_equals($digest,hash('sha256',$code))) throw new Exception('Pacchetto locale non valido');
            if (!wp_mkdir_p(dirname($path))) throw new Exception('Directory MU non scrivibile');
            $tmp=tempnam(dirname($path),'.eulab-');
            if (!$tmp || file_put_contents($tmp,$code,LOCK_EX)!==strlen($code) || !rename($tmp,$path)) { if($tmp)@unlink($tmp); throw new Exception('Ripristino file non riuscito'); }
            chmod($path,0644); if(function_exists('opcache_invalidate'))opcache_invalidate($path,true); delete_option('eulab_mu_failures'); $report('repaired');
        } catch (Throwable $e) {
            $failures=(int)get_option('eulab_mu_failures',0)+1; update_option('eulab_mu_failures',$failures,false);
            set_transient('eulab_mu_retry',1,min(900,15*(2**min($failures,6)))); $report('error',$e->getMessage()); return;
        }
    }
    if (is_file($path) && !defined('EULAB_CONNECT_LOADED')) require_once $path;
})($eulab_payload,$eulab_hash);
unset($eulab_payload,$eulab_hash);
