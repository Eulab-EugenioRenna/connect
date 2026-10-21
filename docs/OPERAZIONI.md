# Esercizio, backup e ripristino

Lo stack Compose è per il collaudo locale. Prima della pubblicazione sui server EULab: hostname HTTPS esatti per Keycloak e dashboard, reverse proxy TLS, `keycloak start --optimized` con immagine costruita per PostgreSQL, SMTP, segreti e policy di rete. `start-dev` non è una configurazione di produzione. Nessuna distribuzione è stata eseguita.

## Avvio

```
npm ci
node scripts/init-env.mjs
docker compose config --quiet
docker compose up -d --build
```

Dashboard: http://localhost:8088. Keycloak: http://localhost:8080. OpenAPI: http://localhost:8088/v1/docs. PostgreSQL, Redis e OpenWA non pubblicano porte host. I profili OpenWA risiedono nel volume del runner; il runner ha egress per WhatsApp. OpenWAUnlocked core, client e driver Puppeteer sono fissati a 1.0.0 con lockfile separato in `apps/runner/package-lock.json`; la build usa `npm ci`. Salvare anche immagini e digest prima del rilascio. Chromium e gli strumenti di compressione sono installati dal repository Debian: il lock npm non fissa questi pacchetti di sistema.

Leggere le credenziali bootstrap **localmente da `.env`**, senza incollarle in chat. Per configurare il primo utente Admin eseguire dal progetto, dopo l’avvio di Keycloak:

```sh
docker compose run --rm --no-deps --user 0:0 -v "$PWD/.env:/connect/.env" -v "$PWD/scripts/setup-admin.mjs:/connect/setup-admin.mjs:ro" api node setup-admin.mjs
docker compose up -d --no-build api web
```

Lo script genera i campi mancanti `EULAB_ADMIN_USERNAME`, `EULAB_ADMIN_EMAIL`, `EULAB_ADMIN_NAME`, `EULAB_ADMIN_PASSWORD` e `OIDC_IDENTITY_ADMIN_SECRET` in `.env`; si possono configurare i primi quattro prima di eseguirlo. Non sovrascrive la password di utenti esistenti e non promuove automaticamente un omonimo Cliente. Il client server `connect-identity-admin` è riservato al realm `eulab`, con `view-users`, `query-users`, `manage-users`, `view-realm`; il segreto resta nel backend. Dalla dashboard **Identità e accessi** si gestiscono creazione, nome, email, abilitazione e tipo Admin/Cliente. Il bootstrap admin del master realm non è automaticamente un amministratore applicativo. Registrazione pubblica disabilitata. [L’import Keycloak supporta i placeholder di ambiente](https://www.keycloak.org/server/importExport). Il secret del client confidenziale `connect-api` viene importato dall’ambiente. Il realm viene importato solo se assente: le successive modifiche al JSON non aggiornano un realm esistente. In quel caso usare console/amministrazione Keycloak, senza cancellare dati.

Il bootstrap SQL è versionato e protetto da lock PostgreSQL. Non viene mai eseguito un reset. Keycloak usa lo schema `keycloak`, Connect lo schema `public` nello stesso PostgreSQL.

## Tema di accesso EULab

Il tema `infra/keycloak/themes/eulab/login` estende il tema nativo `keycloak` della versione 26.3.3: personalizza marchio, palette, tipografia, messaggi italiano/inglese e footer. I template dei form, la validazione, il recupero password, OTP e gli script di autenticazione restano ereditati da Keycloak. La console master mantiene il suo tema. [Documentazione ufficiale sui temi](https://www.keycloak.org/ui-customization/themes).

Compose monta il tema in sola lettura. Per una nuova installazione `realm.json` lo seleziona automaticamente. Per un realm già esistente:

```sh
docker compose up -d --no-deps keycloak
node scripts/setup-login-theme.mjs
```

Attendere che Keycloak risponda prima dello script. Lo script legge le credenziali bootstrap da `.env` e aggiorna solo tema login, nome visualizzato e lingue del realm `eulab`; non reimporta il realm e non modifica utenti o password. Usa `PUBLIC_KEYCLOAK_URL` (o `QA_KEYCLOAK_URL` per il collaudo), con fallback `http://localhost:8080`.

Per verificare il servizio locale: `node scripts/qa-login-theme.mjs` (richiede Chromium Playwright; `CHROMIUM_PATH` permette un eseguibile alternativo). Controlla desktop/mobile, recupero password senza inviare email, credenziali errate su un nome utente inesistente, cambio lingua e login dell’admin esistente. Salva screenshot e risultato in `docs/verification/keycloak-*`. Per eseguirlo in un container sulla rete Compose impostare `QA_DOCKER=true`: lo script apre proxy locali verso `web` e `keycloak`.

Rollback grafico: nella console Keycloak, realm `eulab` → Realm settings → Themes → Login theme, selezionare il tema precedente. Dopo modifiche a CSS o messaggi riavviare solo Keycloak per rinnovare le cache, quindi avviare una nuova richiesta di login. Non cancellare il database. In caso di aggiornamento Keycloak ricontrollare markup, selettori CSS e flussi secondari prima del rilascio.

## Più runner

```
docker compose -f compose.yaml -f infra/compose.runner-2.yaml config --quiet
docker compose -f compose.yaml -f infra/compose.runner-2.yaml up -d --build
```

Ogni runner ha ID e volume propri. La capacità predefinita di due browser per runner è un limite configurato, non un valore misurato. Una lease Redis identifica il processo proprietario di ogni runner e sessione; il rinnovo fallito interrompe i client. Il database impone l’unicità del numero e dell’installazione nelle sessioni aperte. I job sono instradati sulla coda del runner assegnato.

Un riavvio riapre le sessioni del medesimo runner dal suo volume. Un host perso richiede ripristino del volume e riavvio con il medesimo ID, dopo aver accertato la morte del vecchio proprietario e la scadenza della lease. Il trasferimento automatico di profili tra host non è implementato. Non usare `--scale runner=N` con ID e volume condivisi.

## Persistenza e verifica OpenWA

Ogni sessione salva il checkpoint cifrato in `/profiles/<sessione>/openwaunlocked/<sessione>.data.json`. OpenWAUnlocked avvia un profilo browser temporaneo e ripristina l'autenticazione dal checkpoint; il runner non forza un `userDataDir` persistente. Conservare il volume e la chiave protetta separatamente.

Le directory precedenti `v5` e `chromium-v5` rimangono nel volume, senza conversione o cancellazione automatica. Alla prima attivazione di OpenWAUnlocked è necessario un nuovo pairing QR. Gli archivi delle conversazioni in PostgreSQL restano associati a installazione e numero.

La build installa i pacchetti npm pubblicati senza modificare gli asset del provider. La patch locale per OpenWA 5.6.6 è stata rimossa. Il runner non richiede `OPENWA_LICENSE_KEY`; pulsanti e liste sono disponibili, con esiti provider non confermati mantenuti in stato incerto. Il collaudo reale non è dedotto dalla build.

Dopo aver costruito l’immagine runner, aggiornare anche il secondo servizio:

```sh
docker compose build runner
docker compose -f compose.yaml -f infra/compose.runner-2.yaml up -d --no-deps runner runner-2
```

`node scripts/qa-openwa-linked.mjs` esegue per impostazione predefinita controlli di sola lettura sulla sessione già associata, storico e dashboard con Keycloak reale. Usa `QA_INSTALLATION_ID` e le credenziali locali in `.env`; `CHROMIUM_PATH` seleziona Chromium, `QA_DOCKER=true` abilita i proxy nella rete Compose. Salva `docs/verification/openwa-linked-fix-result.json` e uno screenshot mascherato. Il flag opzionale `--send-self` invia un messaggio WhatsApp reale: usarlo solo dopo consenso esplicito del destinatario con `--suffix=<ultime quattro cifre>` e `--test-id=<chiave idempotenza>`. Non ripetere automaticamente un invio incerto.

## Backup coerente

`node scripts/backup.mjs` ferma temporaneamente web, API, runner e Keycloak; esegue `pg_dump -Fc` e snapshot dei profili di ogni container runner presente nel progetto Compose, registra SHA-256, poi riavvia i servizi. Lo script individua e ferma anche i runner aggiuntivi tramite i container del progetto; il manifest elenca i volumi inclusi. Se ci sono runner su altri host, fermarli e includere i loro volumi nella stessa finestra prima di considerare coerente il backup distribuito. I file contengono dati personali e autenticazioni: directory locale privata, trasferimento cifrato e retention da configurare sul server.

Il backup non copia `.env`: conservare separatamente e in modo protetto la chiave `DATA_ENCRYPTION_KEY`, le credenziali DB/Redis/Keycloak e la configurazione. Senza la stessa chiave non si possono leggere i segreti webhook e i token cifrati.

`node scripts/restore-check.mjs backups/<snapshot>` verifica checksum e indice del dump. **Non prova un ripristino**.

## Prova di ripristino

1. Verificare checksum. Preparare un progetto Compose separato, hostname, porte e volumi distinti; impedire egress WhatsApp e webhook durante la verifica, per non creare un secondo proprietario del numero o effetti esterni.
2. Avviare soltanto PostgreSQL nel progetto separato. Importare il dump in un database vuoto con `pg_restore --exit-on-error`, senza `--clean` sul database in uso.
3. Ripristinare ogni profilo nel corrispondente volume spento. Installare le configurazioni e chiavi conservate separatamente.
4. Controllare conteggi, vincoli, audit, archivi per installazione/numero, identità e realm. Riclassificare gli invii `sending` come `uncertain`; **non rimettere automaticamente in coda invii già accettati dal provider**. La ricostruzione Redis deriva da outbox/consegne SQL.
5. Provare login e revoche con hostname di collaudo e callback dedicate. Prima di un vero subentro fermare i vecchi runner, verificare le lease e autorizzare egress solo ai nuovi proprietari.
6. Registrare durata, RPO e RTO effettivi. L’ultimo ripristino isolato locale ha impiegato 2044 ms per importazione e controlli riportati in `verification/restore-result.json`; non misura il RTO di produzione o l’intera riattivazione del servizio.

## Rollback

Prima di ogni rilascio conservare immagini con digest, backup coerente e configurazione. Un rollback applicativo riavvia le immagini precedenti sullo schema compatibile; nessuna down migration automatica. Se lo schema non è retrocompatibile, fermare gli scrittori e ripristinare in volumi separati prima dello switch. Mantenere i vecchi volumi per il recupero. Non usare `docker compose down -v` per aggiornare o riparare lo stack.
