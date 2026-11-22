# Runtime locale — Automazioni e schema 015

Aggiornamento eseguito l’11 novembre 2026 su istruzione esplicita dell’utente dal progetto ALORA: «vai tu su ../eulab connect». API, runner e migratore locali sono aggiornati insieme al contratto dello SDK 0.12.0-rc.2. **Nessun login reale, account, ruolo o password modificato; nessun messaggio reale inviato.** [Evidenze locali](verification/automations/runtime-015-local.json).

## Risultato

- Schema `015`, 15 migrazioni registrate; migratore eseguito due volte sul database locale.
- Nove percorsi automazioni esposti dall’OpenAPI effettiva, inclusi delega, verifica, stato per chiave, ritiro e recupero webhook.
- API e proxy su `http://localhost:8088/v1/health` rispondono; heartbeat del nuovo runner verificato.
- Lettura anonima delle deleghe negata con HTTP 401.
- Nessuna delega creata e nessun effetto pendente avviato. Gli invii storici `sent` e `uncertain` restano invariati.
- Keycloak, PostgreSQL, Redis, web, volume profili e container ALORA conservati. Il bootstrap amministrativo non viene eseguito.

Le immagini installate sono `connect-automations-candidate-{api,runner,migrate}:20261111`; ID e impronte dei bundle sono nelle evidenze. I tre bundle coincidono con quelli compilati sull’host. Le normali build Docker usano la cache disponibile; non sono dichiarate build senza cache.

## Correzione necessaria al confezionamento

Il controllo dell’immagine runner ha rilevato `@eulab/openwaunlocked-schema/src/license.ts`: il nome veniva scambiato per un documento di licenza e sfuggiva alla rimozione dei sorgenti. `scripts/prune-runtime-deps.mjs` esclude ora le estensioni TypeScript e source map dall’eccezione per i documenti legali. `LICENSE.md` e `NOTICE` sono conservati. La regressione aggiunta al test esistente riproduce il difetto prima della correzione e passa dopo.

Le immagini ricostruite superano lo scanner dei sorgenti, gli import effettivi di core/client/driver/qrcode, la presenza degli asset e l’avvio di Chromium su una pagina vuota senza rete. Questo controllo non collega un numero WhatsApp. Le modifiche preesistenti sono preservate; i soli file di implementazione modificati da questo intervento sono il filtro e il relativo test.

## Verifica, conservazione e ripristino

La suite generale passa **187 casi, zero fallimenti**, con cinque casi riservati a PostgreSQL. La suite isolata passa **24/24**, compresi quei cinque; migratore reale applicato due volte. API/runner e tipi SDK compilano. Il tarball SDK coincide con quello adottato da ALORA: SHA-256 `a76152931bf69b41d77aef679de1a623a607679cc0441b2d1e2016bf94acc44d`. Nessuna nuova pubblicazione.

Prima del passaggio è stato ripristinato un backup corrente in PostgreSQL su tmpfs e rete Docker interna, senza porte host né provider reali. Il migratore candidato preserva tutti i valori originari di **45 tabelle pubbliche e 337 colonne**, esclusa la tabella tecnica delle versioni. API e runner candidati, poi le immagini precedenti, si avviano sulla copia aggiornata. Un secondo database vuoto ripristina schema 014 e tutti i dati originari. Contenitori, rete e volume della prova sono rimossi.

Gli avvii aggiornano normalmente heartbeat e metadati del controllo catalogo: nel rehearsal questi campi sono confrontati separatamente, senza escludere il contenuto applicativo delle rispettive tabelle. Il ritorno alle immagini precedenti è verificato **prima di nuove scritture o effetti esterni**; non autorizza a sovrascrivere operazioni successive con un backup vecchio.

Nel passaggio reale locale API e runner sono stati fermati per acquisire un backup coordinato del database, dell’archivio profili e della configurazione privata. `pg_restore --list` verifica il dump; dopo la migrazione e prima dell’avvio tutti i valori pubblici originari coincidono. Dopo l’avvio il confronto registra soltanto il rinnovo dell’heartbeat. Nove tabelle critiche Keycloak, incluse identità, credenziali e associazioni ai ruoli, restano identiche. Le variabili dei servizi non cambiano.

Il volume profili sorgente contiene **zero file**: il controllo conserva contenuto, tipi, proprietari e modi, distinguendo il normale cambio di mtime della radice vuota quando Docker monta una nuova immagine. Non è una prova di recupero di un profilo autenticato preesistente non vuoto.

Backup ed evidenze private sono in `backups/automation-runtime-20261111/rollout-20261111T122016Z/`, con accesso ristretto. Le immagini precedenti restano nei tag `connect-before-automations-{api,runner,migrate}:20261111t122016z`. Nessun volume, immagine precedente o dato condiviso è rimosso.

## Accettazione ancora aperta

La compatibilità locale di API, runner e schema è ora verificata. Non è attestato un invio tramite dispositivo, il comportamento dei pulsanti su WhatsApp o una delega reale di una persona. ALORA ha ancora un’origine HTTP su localhost: il contratto del webhook richiede HTTPS sulla porta 443 e il runner rifiuta destinazioni private. Servono un’origine pubblica controllata, numero e destinatario esplicitamente autorizzati, poi una prova concordata con ricevute e transizioni reali.

Account e prove di sicurezza personale escluse dall’utente restano escluse. Nessuna modifica DNS/TLS, pairing, produzione o distribuzione npm è implicita nell’aggiornamento locale eseguito.


## Contenuto runtime delle immagini

Verifica successiva richiesta dall’utente: le immagini applicative finali devono contenere build ed eseguibili. API, runner, bootstrap e migratore passano `node scripts/verify-runtime-images.mjs eulab-connect`; gli asset della web non contengono TypeScript, source map o cartelle dei sorgenti. I bundle, le dipendenze operative, Chromium, SQL, configurazione e documenti legali necessari sono conservati. Gli stage di build contengono i sorgenti; i container applicativi avviano le immagini runtime. Nessun mount del repository è richiesto. Il successivo intervento in ALORA ha ripulito la sua API senza modificare i container Connect già conformi.
