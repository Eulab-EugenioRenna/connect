<?php
// Explicitly local QA only; private credentials never appear in output.
define('WP_ENVIRONMENT_TYPE','local');
$config=json_decode(file_get_contents('/run/eulab-guardian.json'),true);
putenv('EULAB_GUARDIAN_CONFIG='.json_encode($config));
require_once '/var/www/html/wp-load.php';
if (!get_option('eulab_qa_mu_baseline')) update_option('eulab_qa_mu_baseline',['credentialHash'=>hash('sha256',serialize(get_option('eulab_connect_credentials'))),'users'=>count_users()['total_users']],false);
copy('/artifacts/euconnect.php','/var/www/html/euconnect.php');
$argv=['/var/www/html/euconnect.php'];
require '/var/www/html/euconnect.php';
foreach (['/var/www/html/wp-content/mu-plugins','/var/www/html/wp-content/mu-plugins/euconnect.php','/var/www/html/wp-content/mu-plugins/eulab-connect','/var/www/html/wp-content/mu-plugins/eulab-connect/eulab-connect.php'] as $p) { chown($p,33); chgrp($p,33); }
