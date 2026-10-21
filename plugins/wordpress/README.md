# WordPress: file da distribuire

Per l’installazione MU in produzione si carica **solo `euconnect.php`**. È autonomo: contiene il codice del plugin e non richiede di caricare questa cartella intera.

Caricarlo accanto a `wp-load.php` e aprirlo da browser dopo il login come amministratore WordPress:

- WordPress in `https://domain.com/wp3` → `https://domain.com/wp3/euconnect.php`.
- WordPress nella radice → `https://domain.com/euconnect.php`.

L’installer usa esclusivamente la propria cartella (`./`, risolta con `__DIR__`), senza accettare percorsi o parametri. `/wp3` è solo un esempio di posizione. Dopo la verifica dei file MU e della configurazione si autoelimina. Se l’installazione fallisce rimane disponibile per riprovare; se mancano i permessi per eliminarlo, mostra un avviso esplicito.

## File del repository

- `euconnect.php`: installer generato e pronto da caricare.
- `eulab-connect/eulab-connect.php`: sorgente del plugin, usato dalla build e dalle installazioni ordinarie esistenti. Non occorre caricarlo separatamente per installare tramite `euconnect.php`.
- L’eventuale `eulab-connect/pairing.local.php` è configurazione privata del collaudo locale, esclusa dalla build. Non copiarla su altri siti.

I template dell’installer sono in `scripts/wordpress-installer/`. I file QA sono in `tests/wordpress/` e non sono inclusi nell’installer.

Rigenerazione: `node scripts/build-wordpress-installer.mjs` oppure `npm run build`.

La build produce copie dello stesso installer in `plugins/wordpress/euconnect.php`, `dist/wordpress/euconnect.php` e `dist/web/downloads/euconnect.php`.

Requisiti: PHP 8.1+, libsodium, chiavi WordPress valide, directory MU scrivibile e collegamento HTTPS a Connect. L’installer richiede amministratore WordPress, nonce e chiave di protezione emessa da Connect. L’SSO richiede anche configurazione Keycloak e collegamento esplicito dell’utente locale.

Collaudato sullo stack locale; la distribuzione su hosting di produzione e le relative impostazioni HTTPS/SSO vanno verificate sul server di destinazione. Vedi `docs/WORDPRESS-INSTALLER.md`.
