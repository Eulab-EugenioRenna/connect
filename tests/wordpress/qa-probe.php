<?php
// Loaded only by the explicitly separate local QA Compose overlay.
if (!defined('ABSPATH')) exit;
add_action('init', function() {
    if (isset($_GET['eulab_qa_installer'])) {
        if (!current_user_can('manage_options')) wp_send_json(['allowed'=>false],403);
        wp_send_json(['installerExists'=>is_file(ABSPATH.'euconnect.php'),'muExists'=>is_file(WPMU_PLUGIN_DIR.'/euconnect.php'),'pluginExists'=>is_file(WPMU_PLUGIN_DIR.'/eulab-connect/eulab-connect.php')]);
    }
    if (isset($_GET['eulab_qa_identity'])) {
        if (!is_user_logged_in()) wp_send_json(['authenticated'=>false],401);
        $user = wp_get_current_user(); $session = eulab_connect_technical_session();
        wp_send_json(['id'=>$user->ID,'username'=>$user->user_login,'roles'=>$user->roles,'technical'=>!empty($session['eulab_actor']),'impersonated'=>!empty($session['eulab_impersonated']),'totalUsers'=>count_users()['total_users'],'canManageOptions'=>current_user_can('manage_options')]);
    }
    if (!isset($_GET['eulab_qa_permission'])) return;
    if (!is_user_logged_in()) wp_send_json(['allowed'=>false],401);
    $permission = sanitize_text_field(wp_unslash($_GET['eulab_qa_permission']));
    if (!in_array($permission,['whatsapp.send','reports.read'],true)) wp_send_json(['allowed'=>false],400);
    $allowed = eulab_connect_can($permission,eulab_connect_access_token());
    wp_send_json(['allowed'=>$allowed],$allowed?200:403);
},30);
