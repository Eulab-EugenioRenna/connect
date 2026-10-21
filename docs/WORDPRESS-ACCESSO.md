# WordPress: associazione automatica e accesso dall’admin Connect

Flusso attivo nello stack locale: **Applicazioni → Siti WordPress → Utenti e accesso → filtri → Accedi come utente**. L’elenco è visibile solo agli Admin EULab e si filtra per nome, username, email e ruolo, con pagine da 20 utenti. Anche Installazioni apre lo stesso elenco. Per WordPress non compaiono le azioni manuali Associa/Codice associazione/Ruota credenziali; la configurazione iniziale resta nel file locale. La rotazione manuale è disponibile soltanto per le installazioni web/SDK.

Il plugin 0.3.0 non registra pagine nelle Impostazioni WordPress, non crea utenti o ruoli tecnici e non modifica utenti, ruoli o password esistenti. Gli accessi usano esclusivamente un account locale scelto dall’admin, con le sue capacità native. Non servono collegamenti SSO personali degli utenti WordPress per questo accesso amministrativo.

## Associazione senza pannello WordPress

La configurazione locale continua a richiedere `EULAB_CONNECT_API` e `EULAB_CONNECT_STORAGE_KEY` in `wp-config.php`. Il codice monouso generato in Connect viene inserito nel file **`plugins/wordpress/eulab-connect/pairing.local.php`** sul sito destinatario:

```php
<?php
if (!defined('ABSPATH')) exit;
if (!defined('EULAB_CONNECT_PAIRING_CODE')) {
    define('EULAB_CONNECT_PAIRING_CODE', 'CODICE_MONOUSO_GENERATO_DA_CONNECT');
}
```

In alternativa la stessa costante può essere definita nel `wp-config.php` locale. Nessun valore reale viene copiato nella documentazione. `pairing.local.php` è escluso da Git e dal contesto build Docker, perché è specifico dell’installazione; va consegnato solo al sito corretto.

Al primo avvio con un nuovo codice il plugin redime il codice per l’origine del proprio sito, cifra e salva le credenziali in WordPress e memorizza soltanto l’impronta del codice applicato. Le richieste successive non ripetono l’associazione. Un nuovo codice configurato riassocia la stessa installazione e ruota la credenziale server; sincronizzare le eventuali configurazioni server di collaudo che usano quella credenziale. I codici restano monouso e scadono dopo 10 minuti. Il codice del sito locale è stato già configurato e consumato correttamente.

Errori e retry: l’errore sintetico è nell’opzione locale `eulab_pairing_error` e nei log PHP senza codici/token; i tentativi falliti sono limitati a uno al minuto. Il plugin convalida la chiave di cifratura prima di consumare il codice. Non si perdono le credenziali già salvate se un nuovo tentativo fallisce.

## Elenco e sincronizzazione

WordPress rimane la fonte degli utenti. Il plugin invia solo ID, username, nome visualizzato, email e ruoli; nessuna password o sessione locale. Gli account tecnici precedenti sono esclusi e non possono autenticarsi. Non vengono eliminati o convertiti automaticamente.

La sincronizzazione usa lotti da 100 utenti. Connect rende visibile una generazione solo dopo il completamento, conservando l’elenco precedente durante l’invio. Modifiche agli utenti/ruoli accodano una nuova sincronizzazione. Il plugin controlla inoltre le richieste centrali tramite cron e rinnova periodicamente l’elenco. Nell’admin si vedono data dell’ultimo aggiornamento, stato e pulsante **Richiedi sincronizzazione**.

La richiesta centrale non finge un aggiornamento immediato: il sito deve eseguire i propri eventi cron. Per siti senza traffico configurare un cron di sistema, come previsto dal funzionamento di [WP-Cron](https://developer.wordpress.org/reference/functions/wp_schedule_single_event/).

## Accesso selezionato

Il ticket POST dura 60 secondi, è monouso e vincolato a installazione, operatore EULab e ID utente scelto. Per WordPress non si possono emettere ticket privi di selezione. Solo un Admin EULab può selezionare e aprire una sessione; il ruolo EULab Technician da solo non basta.

Alla ricezione il plugin verifica di nuovo che l’utente esista, appartenga al sito e non sia un vecchio account tecnico. Quindi apre una sessione di cinque minuti sullo stesso ID, senza crearne altri e senza aumentarne i permessi. Ogni richiesta di quella sessione ricontrolla l’autorizzazione centrale. L’audit registra operatore EULab, installazione, ID e username locale. Una nuova selezione chiude soltanto la precedente sessione di accesso EULab del browser, preservando le altre sessioni locali dell’utente.

## Migrazione e verifiche del 19 ottobre 2026

Migrazione additiva 003: directory esterna degli utenti e ID utente nei ticket; nessun reset. API e frontend aggiornati nello stack locale insieme al plugin, che è montato dal sorgente. Backup preventivi nei volumi PostgreSQL e MariaDB, cartelle `eulab-backups/2026-10-19-selected-user.*`.

- 24 test automatici passati, build TypeScript/Vite e configurazione Compose valide.
- Sintassi PHP verificata nel container WordPress.
- Browser reale con Keycloak, PostgreSQL e WordPress reali: elenco e filtri centrali; accessi come Marco, Giulia, Sara e Luca; ruoli administrator/editor/subscriber mantenuti; nessun account creato (5 prima, 5 dopo).
- Associazione automatica con codice locale verificata: configurazione presente, impronta applicata, nessun errore e nessun pannello Impostazioni registrato.
- Desktop e mobile ispezionati; modale senza overflow. Domini e relativi sottotitoli separati su righe distinte nelle tabelle.

Evidenze: `docs/verification/wordpress-selected-user/`. Il test attivo è `scripts/qa-wordpress-selected-user.mjs`; `qa-wordpress-access-as.mjs` richiama il nuovo flusso. Le prove precedenti con account tecnico e impersonificazione dal sito sono storiche e superate.

## Login SSO dal sito

In **Utenti e accesso → Collega SSO** l’amministratore sceglie l’identità centrale per un utente WordPress già esistente. L’azione abilita esplicitamente l’appartenenza al cliente senza assegnare automaticamente funzioni Connect o cambiare i ruoli locali. Collegamenti già esistenti verso altri utenti non vengono sostituiti implicitamente. Il codice di associazione del sito non effettua questa mappatura.

Sul sito locale l’identità Amministratore EULab è collegata a `giulia.bianchi`, come richiesto. Collaudo reale: `verification/wordpress-sso-linked/result.json`; login dal sito con ritorno alla home dell’app, cinque utenti invariati e stop centrale verificato.
