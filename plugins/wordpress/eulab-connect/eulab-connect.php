<?php
/**
 * Plugin Name: EULab Connect
 * Description: Associazione installazione, elenco utenti in Connect e accesso agli utenti locali selezionati dall’admin.
 * Version: 0.5.0
 * Requires PHP: 8.1
 */
if (!defined('ABSPATH')) exit;
if (defined('EULAB_CONNECT_MU_PATH') && __FILE__ !== EULAB_CONNECT_MU_PATH) return;
if (defined('EULAB_CONNECT_LOADED')) return;
define('EULAB_CONNECT_LOADED', true);
// Installation-local, one-time association code. Never a shared or permanent credential.
if (is_readable(__DIR__ . '/pairing.local.php')) require_once __DIR__ . '/pairing.local.php';
// Put EULAB_CONNECT_API and EULAB_CONNECT_STORAGE_KEY (32 random bytes, base64) in wp-config.php.
function eulab_connect_api() { return defined('EULAB_CONNECT_API') ? rtrim(EULAB_CONNECT_API, '/') : ''; }
function eulab_connect_encrypt($data) {
    if (!defined('EULAB_CONNECT_STORAGE_KEY') || !function_exists('sodium_crypto_secretbox')) throw new Exception('Configura una chiave locale di 32 byte e libsodium.');
    $key = base64_decode(EULAB_CONNECT_STORAGE_KEY, true);
    if (strlen($key ?: '') !== SODIUM_CRYPTO_SECRETBOX_KEYBYTES) throw new Exception('Chiave locale non valida.');
    $nonce = random_bytes(SODIUM_CRYPTO_SECRETBOX_NONCEBYTES);
    return base64_encode($nonce . sodium_crypto_secretbox(wp_json_encode($data), $nonce, $key));
}
function eulab_connect_credentials() {
    $encrypted = get_option('eulab_connect_credentials', '');
    if (!$encrypted || !defined('EULAB_CONNECT_STORAGE_KEY')) return null;
    $raw = base64_decode($encrypted, true); $key = base64_decode(EULAB_CONNECT_STORAGE_KEY, true);
    if (!$raw || strlen($key ?: '') !== SODIUM_CRYPTO_SECRETBOX_KEYBYTES) return null;
    $plain = sodium_crypto_secretbox_open(substr($raw, SODIUM_CRYPTO_SECRETBOX_NONCEBYTES), substr($raw, 0, SODIUM_CRYPTO_SECRETBOX_NONCEBYTES), $key);
    return $plain ? json_decode($plain, true) : null;
}
function eulab_connect_request($path, $body = null, $token = '') {
    $credentials = eulab_connect_credentials();
    if (!$credentials || !eulab_connect_api()) return new WP_Error('connect_unpaired', 'Installazione non associata.');
    $headers = ['Content-Type'=>'application/json', 'X-Installation-Id'=>$credentials['installationId'], 'X-Installation-Secret'=>$credentials['secret']];
    if ($token) $headers['Authorization'] = 'Bearer ' . $token;
    $response = wp_remote_request(eulab_connect_api() . $path, ['method'=>$body === null ? 'GET' : 'POST', 'headers'=>$headers, 'body'=>$body === null ? null : wp_json_encode($body), 'timeout'=>10, 'redirection'=>0, 'sslverify'=>true]);
    if (is_wp_error($response)) return $response;
    if (wp_remote_retrieve_response_code($response) !== 200 && wp_remote_retrieve_response_code($response) !== 201) return new WP_Error('connect_denied', 'Operazione Connect non consentita.');
    return json_decode(wp_remote_retrieve_body($response), true);
}
/** Check on every protected PHP action; UI hiding is insufficient. Token must come from a verified OIDC session. */
function eulab_connect_can($permission, $access_token) {
    $c = eulab_connect_credentials(); if (!$c || !$access_token) return false;
    $r = eulab_connect_request('/v1/authorize', ['installationId'=>$c['installationId'], 'permission'=>$permission], $access_token);
    return !is_wp_error($r) && !empty($r['allowed']);
}
function eulab_connect_require($permission, $access_token) {
    if (!eulab_connect_can($permission, $access_token)) wp_die('Licenza o permesso non disponibile.', 'Accesso negato', ['response'=>403]);
}
// No WordPress settings panel: association is automatic from the installation-local code.
function eulab_connect_bootstrap_pairing() {
    if (!defined('EULAB_CONNECT_PAIRING_CODE') || !EULAB_CONNECT_PAIRING_CODE || !eulab_connect_api()) return;
    $code = EULAB_CONNECT_PAIRING_CODE; $fingerprint = hash('sha256', $code);
    if (get_option('eulab_pairing_applied') === $fingerprint && eulab_connect_credentials()) return;
    if (get_transient('eulab_pairing_lock')) return;
    set_transient('eulab_pairing_lock', true, 60);
    try {
        eulab_connect_encrypt(['check'=>true]);
        $domain = wp_parse_url(home_url(), PHP_URL_SCHEME) . '://' . wp_parse_url(home_url(), PHP_URL_HOST);
        $port = wp_parse_url(home_url(), PHP_URL_PORT); if ($port) $domain .= ':' . $port;
        $response = wp_remote_post(eulab_connect_api() . '/v1/pairing/redeem', ['headers'=>['Content-Type'=>'application/json'],'body'=>wp_json_encode(['code'=>$code,'domain'=>$domain]),'timeout'=>10,'redirection'=>0,'sslverify'=>true]);
        if (is_wp_error($response) || wp_remote_retrieve_response_code($response) !== 201) throw new Exception('Codice scaduto, già usato o dominio non autorizzato. Genera un nuovo codice nell’admin Connect.');
        $credentials = json_decode(wp_remote_retrieve_body($response), true);
        if (empty($credentials['secret']) || empty($credentials['installationId'])) throw new Exception('Risposta di associazione incompleta.');
        update_option('eulab_connect_credentials', eulab_connect_encrypt($credentials), false);
        update_option('eulab_pairing_applied', $fingerprint, false);
        delete_option('eulab_pairing_error'); delete_transient('eulab_pairing_lock');
        eulab_connect_queue_user_sync(); eulab_connect_sync_user_batch();
    } catch (Throwable $error) {
        update_option('eulab_pairing_error', $error->getMessage(), false);
        error_log('EULab Connect: associazione automatica non completata. Verifica codice, dominio e configurazione locale.');
    }
}
add_action('init', 'eulab_connect_bootstrap_pairing', 2);
function eulab_connect_technical_session() {
    if (!is_user_logged_in()) return null;
    return WP_Session_Tokens::get_instance(get_current_user_id())->get(wp_get_session_token());
}
function eulab_connect_is_operator() {
    $session = eulab_connect_technical_session();
    if (empty($session['eulab_actor'])) return false;
    $token = eulab_connect_access_token();
    $context = $token ? eulab_connect_request('/v1/context', null, $token) : null;
    return !is_wp_error($context) && !empty($context['admin']) && ($context['subject'] ?? '') === $session['eulab_actor'];
}
function eulab_connect_technical_login($user, $token, $subject, $impersonated = false) {
    // Mark this single WordPress session, never the local user's account or password.
    $manager = WP_Session_Tokens::get_instance($user->ID);
    $session_token = $manager->create(time() + 300);
    $session = $manager->get($session_token);
    $session['eulab_actor'] = $subject; $session['eulab_impersonated'] = $impersonated;
    $manager->update($session_token, $session);
    wp_set_current_user($user->ID); wp_set_auth_cookie($user->ID, false, is_ssl(), $session_token);
    eulab_connect_store_token($token, true, $session_token);
}
add_action('admin_notices', function() {
    $session = eulab_connect_technical_session();
    if (!empty($session['eulab_actor'])) echo '<div class="notice notice-info"><p>Accesso EULab come <strong>' . esc_html(wp_get_current_user()->user_login) . '</strong>, con i permessi locali di questo utente. Per cambiare utente torna al pannello admin Connect.</p></div>';
});
// The ticket carries the exact local user selected in the central admin. No account is created.
add_action('init', function() {
    if (!isset($_GET['eulab_technical'])) return;
    nocache_headers(); header('Referrer-Policy: no-referrer');
    if ($_SERVER['REQUEST_METHOD'] !== 'POST' || empty($_POST['ticket'])) wp_die('Ticket utente richiesto.', '', ['response'=>403]);
    $r = eulab_connect_request('/v1/technical/redeem', ['ticket'=>sanitize_text_field(wp_unslash($_POST['ticket']))]);
    $credentials = eulab_connect_credentials();
    if (is_wp_error($r) || ($r['scope'] ?? '') !== 'eulab-wordpress-user' || ($r['installationId'] ?? '') !== ($credentials['installationId'] ?? '') || !preg_match('/^[1-9][0-9]{0,14}$/', (string)($r['localUserId'] ?? ''))) wp_die('Accesso utente non autorizzato.', '', ['response'=>403]);
    $user = get_user_by('id', (int)$r['localUserId']);
    if (!$user || !is_user_member_of_blog($user->ID) || get_user_meta($user->ID, 'eulab_technical_subject', true) || in_array('eulab_technician', $user->roles, true)) wp_die('L’utente selezionato non è più disponibile su questo sito. Aggiorna l’elenco in Connect.', '', ['response'=>403]);
    $verified = eulab_connect_request('/v1/technical/access-as', ['localUserId'=>(string)$user->ID,'localUsername'=>$user->user_login], $r['accessToken']);
    if (is_wp_error($verified) || ($verified['scope'] ?? '') !== 'eulab-access-as' || ($verified['subject'] ?? '') !== $r['subject']) wp_die('Accesso utente revocato.', '', ['response'=>403]);
    $previous = eulab_connect_technical_session();
    if (!empty($previous['eulab_actor'])) WP_Session_Tokens::get_instance(get_current_user_id())->destroy(wp_get_session_token());
    eulab_connect_technical_login($user, $r['accessToken'], $r['subject'], true);
    wp_safe_redirect(admin_url()); exit;
});
// Existing legacy technical accounts cannot sign in. They are not deleted or repurposed.
add_filter('wp_authenticate_user', function($user) { if (!is_wp_error($user) && (get_user_meta($user->ID, 'eulab_technical_subject', true) || in_array('eulab_technician', $user->roles, true))) return new WP_Error('legacy_technical_disabled','Seleziona un utente locale dal pannello admin Connect.'); return $user; });
// Optional customer SSO. Register the exact callback in Keycloak before enabling.
function eulab_connect_issuer() { return defined('EULAB_CONNECT_ISSUER') ? rtrim(EULAB_CONNECT_ISSUER, '/') : ''; }
function eulab_connect_internal_issuer() { return defined('EULAB_CONNECT_INTERNAL_ISSUER') ? rtrim(EULAB_CONNECT_INTERNAL_ISSUER, '/') : eulab_connect_issuer(); }
function eulab_connect_callback_url() { return add_query_arg('eulab_sso_callback', '1', home_url('/')); }
function eulab_connect_store_token($token, $technical = false, $session_token = '') {
    if (preg_match('/^[a-f0-9]{64}$/', $_COOKIE['eulab_session'] ?? '')) delete_transient('eulab_session_' . hash('sha256', $_COOKIE['eulab_session']));
    $opaque = bin2hex(random_bytes(32));
    set_transient('eulab_session_' . hash('sha256', $opaque), eulab_connect_encrypt(['token'=>$token,'technical'=>$technical,'userId'=>get_current_user_id(),'wpSessionHash'=>hash('sha256',$session_token ?: wp_get_session_token())]), 300);
    setcookie('eulab_session', $opaque, ['expires'=>time()+300,'path'=>'/','secure'=>is_ssl(),'httponly'=>true,'samesite'=>'Lax']);
    $_COOKIE['eulab_session'] = $opaque;
}
function eulab_connect_access_token() {
    $opaque = $_COOKIE['eulab_session'] ?? '';
    if (!preg_match('/^[a-f0-9]{64}$/', $opaque)) return '';
    $encrypted = get_transient('eulab_session_' . hash('sha256', $opaque));
    if (!$encrypted || !defined('EULAB_CONNECT_STORAGE_KEY')) return '';
    $raw = base64_decode($encrypted, true); $key = base64_decode(EULAB_CONNECT_STORAGE_KEY, true);
    if (!$raw || strlen($key ?: '') !== 32) return '';
    $plain = sodium_crypto_secretbox_open(substr($raw, 24), substr($raw, 0, 24), $key);
    $data = $plain ? json_decode($plain, true) : null;
    return (int)($data['userId'] ?? 0) === get_current_user_id() && hash_equals($data['wpSessionHash'] ?? '', hash('sha256',wp_get_session_token())) ? ($data['token'] ?? '') : '';
}
add_action('wp_logout', function() {
    $opaque = $_COOKIE['eulab_session'] ?? '';
    if (preg_match('/^[a-f0-9]{64}$/', $opaque)) delete_transient('eulab_session_' . hash('sha256', $opaque));
    setcookie('eulab_session', '', ['expires'=>1,'path'=>'/','secure'=>is_ssl(),'httponly'=>true,'samesite'=>'Lax']);
});
add_action('login_form', function() {
    if (defined('EULAB_CONNECT_SSO_ENABLED') && EULAB_CONNECT_SSO_ENABLED) echo '<p><a class="button" href="' . esc_url(add_query_arg('eulab_sso', '1', home_url('/'))) . '">Accedi con EULab SSO</a></p>';
});
add_action('init', function() {
    if (!defined('EULAB_CONNECT_SSO_ENABLED') || !EULAB_CONNECT_SSO_ENABLED || !eulab_connect_issuer()) return;
    if (isset($_GET['eulab_sso'])) {
        $state = bin2hex(random_bytes(32)); $verifier = bin2hex(random_bytes(48));
        set_transient('eulab_pkce_' . hash('sha256', $state), $verifier, 300);
        setcookie('eulab_pkce', $state, ['expires'=>time()+300,'path'=>'/','secure'=>is_ssl(),'httponly'=>true,'samesite'=>'Lax']);
        $challenge = rtrim(strtr(base64_encode(hash('sha256', $verifier, true)), '+/', '-_'), '=');
        $url = eulab_connect_issuer() . '/protocol/openid-connect/auth?' . http_build_query(['client_id'=>'connect-wordpress','redirect_uri'=>eulab_connect_callback_url(),'response_type'=>'code','scope'=>'openid profile','state'=>$state,'code_challenge'=>$challenge,'code_challenge_method'=>'S256']);
        wp_redirect($url); exit;
    }
    if (!isset($_GET['eulab_sso_callback'])) return;
    $state = sanitize_text_field(wp_unslash($_GET['state'] ?? ''));
    if (!preg_match('/^[a-f0-9]{64}$/', $state) || !hash_equals($_COOKIE['eulab_pkce'] ?? '', $state)) wp_die('Stato SSO non valido.');
    $verifier = get_transient('eulab_pkce_' . hash('sha256', $state)); delete_transient('eulab_pkce_' . hash('sha256', $state));
    setcookie('eulab_pkce', '', ['expires'=>1,'path'=>'/','secure'=>is_ssl(),'httponly'=>true,'samesite'=>'Lax']);
    if (!$verifier) wp_die('Richiesta SSO scaduta.');
    $response = wp_remote_post(eulab_connect_internal_issuer() . '/protocol/openid-connect/token', ['body'=>['grant_type'=>'authorization_code','client_id'=>'connect-wordpress','redirect_uri'=>eulab_connect_callback_url(),'code'=>sanitize_text_field(wp_unslash($_GET['code'] ?? '')),'code_verifier'=>$verifier], 'timeout'=>10, 'redirection'=>0]);
    if (is_wp_error($response) || wp_remote_retrieve_response_code($response) !== 200) wp_die('SSO non disponibile.');
    $tokens = json_decode(wp_remote_retrieve_body($response), true); $token = $tokens['access_token'] ?? '';
    $context = eulab_connect_request('/v1/context', null, $token);
    if (is_wp_error($context)) wp_die('Accesso SSO al sito non disponibile. Riprova o contatta l’amministratore.', '', ['response'=>503]);
    if (empty($context['localUserId']) || !ctype_digit((string)$context['localUserId'])) wp_die('Il tuo accesso a questo sito non è ancora configurato. L’amministratore deve collegare la tua identità SSO a un utente WordPress da Connect → Utenti e accesso → Collega SSO.', '', ['response'=>403]);
    if (empty($context['canLogin'])) wp_die('Il tuo accesso a questo sito è sospeso o non ancora abilitato. Contatta l’amministratore.', '', ['response'=>403]);
    $user = get_user_by('id', (int)$context['localUserId']);
    if (!$user || !is_user_member_of_blog($user->ID) || get_user_meta($user->ID, 'eulab_technical_subject', true)) wp_die('Collegamento locale non valido.');
    $manager = WP_Session_Tokens::get_instance($user->ID);
    $session_token = $manager->create(time()+300);
    $session = $manager->get($session_token); $session['eulab_customer_subject'] = $context['subject']; $manager->update($session_token, $session);
    wp_set_current_user($user->ID); wp_set_auth_cookie($user->ID, false, is_ssl(), $session_token); eulab_connect_store_token($token, false, $session_token);
    wp_safe_redirect(home_url('/')); exit;
});
// Central revocations apply to each Connect session, including customer SSO.
add_action('init', function() {
    if (!is_user_logged_in()) return;
    $session = eulab_connect_technical_session();
    if (!empty($session['eulab_customer_subject'])) {
        $token = eulab_connect_access_token();
        $context = $token ? eulab_connect_request('/v1/context', null, $token) : new WP_Error('expired');
        if (is_wp_error($context) || empty($context['canLogin']) || ($context['subject'] ?? '') !== $session['eulab_customer_subject'] || (string)($context['localUserId'] ?? '') !== (string)get_current_user_id()) {
            WP_Session_Tokens::get_instance(get_current_user_id())->destroy(wp_get_session_token()); wp_clear_auth_cookie(); wp_die('Sessione EULab scaduta o revocata.', '', ['response'=>403]);
        }
        return;
    }
    if (empty($session['eulab_actor']) && !get_user_meta(get_current_user_id(), 'eulab_technical_subject', true) && !in_array('eulab_technician', wp_get_current_user()->roles, true)) return;
    $token = eulab_connect_access_token();
    $context = $token ? eulab_connect_request('/v1/context', null, $token) : new WP_Error('expired');
    $legacy = get_user_meta(get_current_user_id(), 'eulab_technical_subject', true) || in_array('eulab_technician', wp_get_current_user()->roles, true);
    $allowed = !$legacy && !is_wp_error($context) && !empty($context['technician']) && ($context['subject'] ?? '') === ($session['eulab_actor'] ?? '');
    if (!empty($session['eulab_impersonated'])) $allowed = $allowed && !empty($context['admin']) && is_user_member_of_blog(get_current_user_id()) && !get_user_meta(get_current_user_id(), 'eulab_technical_subject', true) && !in_array('eulab_technician', wp_get_current_user()->roles, true);
    if (!$allowed) {
        WP_Session_Tokens::get_instance(get_current_user_id())->destroy(wp_get_session_token());
        wp_clear_auth_cookie(); wp_die('Sessione tecnica EULab scaduta o revocata.', '', ['response'=>403]);
    }
}, 20);

// Publish an external user directory, never passwords or WordPress session material.
// A generation is made visible in Connect only after all batches have arrived.
function eulab_connect_queue_user_sync() {
    update_option('eulab_users_dirty', true, false);
    if (!wp_next_scheduled('eulab_connect_sync_users')) wp_schedule_single_event(time() + 1, 'eulab_connect_sync_users');
}
function eulab_connect_sync_user_batch() {
    if (!eulab_connect_credentials() || get_transient('eulab_users_sync_lock')) return;
    set_transient('eulab_users_sync_lock', true, 30);
    try {
        $job = get_option('eulab_users_sync_job');
        if (!$job) { $job = ['generation'=>wp_generate_uuid4(),'page'=>1]; update_option('eulab_users_sync_job', $job, false); delete_option('eulab_users_dirty'); }
        $query = new WP_User_Query(['blog_id'=>get_current_blog_id(),'number'=>100,'paged'=>$job['page'],'orderby'=>'ID','order'=>'ASC','count_total'=>false,
            'role__not_in'=>['eulab_technician'],'meta_query'=>[['key'=>'eulab_technical_subject','compare'=>'NOT EXISTS']]]);
        $users = [];
        foreach ($query->get_results() as $user) $users[] = ['id'=>(string)$user->ID,'username'=>$user->user_login,'displayName'=>$user->display_name,'email'=>$user->user_email,'roles'=>array_values($user->roles)];
        $complete = count($users) < 100;
        $result = eulab_connect_request('/v1/wordpress/users/sync', ['generation'=>$job['generation'],'start'=>$job['page'] === 1,'complete'=>$complete,'users'=>$users]);
        if (is_wp_error($result)) {
            delete_option('eulab_users_sync_job');
            update_option('eulab_users_sync_error', 'Sincronizzazione non completata: verrà riprovata. Verifica collegamento e versione delle API.', false);
            if (!wp_next_scheduled('eulab_connect_sync_users')) wp_schedule_single_event(time()+60, 'eulab_connect_sync_users');
            return;
        }
        delete_option('eulab_users_sync_error');
        if ($complete) { delete_option('eulab_users_sync_job'); update_option('eulab_users_synced_at', gmdate('c'), false); }
        else { $job['page']++; update_option('eulab_users_sync_job', $job, false); }
        if (!$complete || get_option('eulab_users_dirty')) if (!wp_next_scheduled('eulab_connect_sync_users')) wp_schedule_single_event(time()+1, 'eulab_connect_sync_users');
    } finally { delete_transient('eulab_users_sync_lock'); }
}
add_action('eulab_connect_sync_users', 'eulab_connect_sync_user_batch');
foreach (['user_register','profile_update','deleted_user','set_user_role','add_user_to_blog','remove_user_from_blog'] as $hook) add_action($hook, 'eulab_connect_queue_user_sync', 20, 0);
add_action('eulab_connect_poll_users', function() {
    if (!eulab_connect_credentials()) return;
    eulab_connect_register_functions();
    $status = eulab_connect_request('/v1/wordpress/sync-status');
    $last = strtotime(get_option('eulab_users_synced_at', '')) ?: 0;
    if ((!is_wp_error($status) && !empty($status['requested'])) || time()-$last > 3600) eulab_connect_queue_user_sync();
});
add_action('init', function() {
    if (eulab_connect_credentials() && !wp_next_scheduled('eulab_connect_poll_users')) wp_schedule_single_event(time()+60, 'eulab_connect_poll_users');
});
register_deactivation_hook(__FILE__, function() { wp_clear_scheduled_hook('eulab_connect_poll_users'); wp_clear_scheduled_hook('eulab_connect_sync_users'); });

// The app declares one list of functions. Connect alone assigns them to customers/users.
function eulab_connect_function_matrix() {
    $credentials = eulab_connect_credentials();
    $app_id = $credentials['appId'] ?? get_option('eulab_connect_app_id', '');
    if (!$app_id && $credentials) {
        $context = eulab_connect_request('/v1/context');
        if (!is_wp_error($context) && !empty($context['app_id'])) { $app_id = $context['app_id']; update_option('eulab_connect_app_id', $app_id, false); }
    }
    if (!$app_id) return new WP_Error('app_not_registered', 'Applicazione non associata.');
    $functions = apply_filters('eulab_connect_functions', [
        ['key'=>'users.read','name'=>'Leggi utenze collegate'],
        ['key'=>'whatsapp.read','name'=>'Leggi conversazioni WhatsApp'],
        ['key'=>'whatsapp.send','name'=>'Invia messaggi WhatsApp'],
        ['key'=>'whatsapp.manage','name'=>'Gestisci connessione WhatsApp'],
    ]);
    $seen = []; $normalized = [];
    foreach ($functions as $function) {
        if (is_string($function)) $function = ['key'=>$function,'name'=>$function];
        if (!is_array($function) || !preg_match('/^[a-z][a-z0-9_.:-]{0,79}$/', $function['key'] ?? '') || empty($function['name']) || isset($seen[$function['key']])) return new WP_Error('invalid_functions', 'Lista funzioni non valida.');
        $seen[$function['key']] = true; $normalized[] = $function;
    }
    $version = defined('EULAB_CONNECT_FUNCTIONS_VERSION') ? (int)EULAB_CONNECT_FUNCTIONS_VERSION : 1;
    return ['schemaVersion'=>1,'appId'=>$app_id,'version'=>$version,'functions'=>$normalized];
}
function eulab_connect_functions_url() { return add_query_arg('eulab_catalog', '1', home_url('/index.php')); }
add_action('init', function() {
    if (!isset($_GET['eulab_catalog'])) return;
    if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'GET') wp_send_json(['error'=>'GET richiesto'], 405);
    $matrix = eulab_connect_function_matrix();
    if (is_wp_error($matrix)) wp_send_json(['error'=>$matrix->get_error_message()], 503);
    header('Cache-Control: no-cache'); header('X-Content-Type-Options: nosniff');
    wp_send_json($matrix, 200);
}, 0);
function eulab_connect_register_functions() {
    if (!eulab_connect_credentials()) return;
    $matrix = eulab_connect_function_matrix(); if (is_wp_error($matrix)) return;
    $fingerprint = hash('sha256', wp_json_encode($matrix) . eulab_connect_functions_url());
    if (get_option('eulab_functions_registered') === $fingerprint) return;
    // Send only the URL. Connect must GET and validate the declaration from the app.
    $result = eulab_connect_request('/v1/catalog-source', ['url'=>eulab_connect_functions_url()]);
    if (!is_wp_error($result) && !empty($result['ok'])) { update_option('eulab_functions_registered', $fingerprint, false); delete_option('eulab_functions_error'); }
    else update_option('eulab_functions_error', 'Connect non ha ancora acquisito la lista funzioni. Verifica URL e disponibilità del servizio.', false);
}
function eulab_connect_access($access_token = '') {
    $token = $access_token ?: eulab_connect_access_token();
    if (!$token) return ['canLogin'=>false,'functions'=>[],'reason'=>'authentication_required'];
    $result = eulab_connect_request('/v1/access', null, $token);
    return is_wp_error($result) ? ['canLogin'=>false,'functions'=>[],'reason'=>'connect_unavailable'] : $result;
}
function eulab_connect_allowed_functions($access_token = '') { return array_column(eulab_connect_access($access_token)['functions'] ?? [], 'key'); }
add_shortcode('eulab_function', function($attributes, $content = '') {
    $attributes = shortcode_atts(['key'=>''], $attributes);
    return in_array($attributes['key'], eulab_connect_allowed_functions(), true) ? do_shortcode($content) : '';
});
