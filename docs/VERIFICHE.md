# Stato delle verifiche

Aggiornato il 21 ottobre 2026. Nessuna distribuzione sui server EULab.

## Integrazione OpenWAUnlocked del 20 ottobre 2026

Il runner usa `@eulab/openwaunlocked-core`, `@eulab/openwaunlocked-client` e `@eulab/openwaunlocked-driver-puppeteer` 1.0.0 dal registry npm. Verificati: 71 test automatici, build di Connect, configurazione Compose con entrambi i runner e costruzione/arresto del client con i pacchetti pubblicati, senza avviare WhatsApp o inviare messaggi. I test dell'adapter coprono QR, pulizia dopo errore di avvio, parametri di media/sondaggi, rifiuto di esiti senza ID e logout.

La configurazione locale npm aveva `legacy-peer-deps=true`: il lockfile del runner è stato rigenerato in Linux con la risoluzione peer standard. `apps/runner/.npmrc` fissa `legacy-peer-deps=false` anche per le installazioni locali.

I checkpoint OpenWAUnlocked risiedono in una directory separata; i precedenti profili vengono conservati. Per l'attivazione serve un nuovo pairing QR. I runner operativi non sono stati riavviati. Le prove storiche con OpenWA riportate sotto non certificano pairing, ripresa, storico o invii reali con OpenWAUnlocked. Pulsanti multipli e liste sono disponibili senza chiave provider. La UI mostra Coming soon per le chiamate. Passati i test browser in Chromium Linux con API Nest e database di test: compositore con sette tipi, scelte IVR cliccabili, simulazione vocale/DTMF, foto e descrizioni delle conversazioni, desktop e mobile. Screenshot in `verification/openwaunlocked/`. Primo avvio della configurazione di produzione verificato in un progetto Docker isolato: PostgreSQL/Redis nuovi, migrazioni 001–009 anche al secondo passaggio, Keycloak ottimizzata, discovery con issuer `/sso`, bootstrap admin, health attraverso Nginx, asset `/admin/` e heartbeat runner. Report: `verification/openwaunlocked/production-runtime.json`. Il collaudo ha corretto due errori reali di configurazione Keycloak: prefisso non persistito nella build e hostname pubblico privo di `/sso`. Nessun messaggio o chiamata reale durante queste prove. Gli esiti reali WhatsApp rimangono da verificare.

Le evidenze seguenti descrivono i collaudi precedenti.

| Ambito | Esito verificato | Evidenza e limiti |
|---|---|---|
| HTML approvato | Originale conservato | SHA-256 `f56e1242febae3768461b4284d5e815ce44124db6ddfa0493900644714214c3c` |
| Dashboard desktop/mobile | Test browser su asset compilati | `verification/ui-result.json`, schermate desktop/mobile; OIDC simulato in questa suite |
| Aggiungi app e siti WordPress | Passato anche nello stack reale | App, dominio, descrizione, fallback e associazione plugin: `verification/runtime-result.json` |
| SSO Keycloak e WordPress | Passato nello stack reale | PKCE, collegamento locale esplicito, login cliente e recupero locale |
| Accedi come WordPress | Passato su utenti locali indipendenti | `verification/wordpress-access-as-result.json`: due amministratori, blocco editor/autore/subscriber nel PHP, nonce CSRF, audit centrale, revoca e indipendenza delle sessioni locali |
| Accesso tecnico EULab | Passato con licenza cliente sospesa | Accesso diretto a wp-admin mediante ticket monouso |
| Enforcement PHP/backend | Passato nello stack reale | Sospensione licenza, revoca appartenenza, scollegamento identità e disabilitazione SSO bloccano l’operazione; nuova funzione inizialmente disabilitata |
| Utenti Admin/Cliente | Passato con Keycloak reale | Creazione dalla dashboard, stesso SSO, cambio tipo e revoca sessioni, autorevoca impedita: `verification/identities-result.json` |
| SDK | Compilato e usato dai test | Ingressi browser/server separati; manca accettazione su una diversa applicazione esterna |
| OpenWA | Associazione, persistenza e invio reale verificati | `verification/openwa-send-confirmed-result.json`: invio `sent`, ID provider e ricezione confermata dall’utente. Ripresa senza QR e storico disponibile: `verification/openwa-linked-fix-result.json`. Ricezione da un altro account e media ancora da collaudare |
| Pulsanti interattivi | Bloccati correttamente | Mancano chiave Insiders o superiore verificata e prova di visualizzazione/risposta su telefoni reali; nessun acquisto |
| Archivi e riconnessioni | Test SQL e riconnessione reale passati | Stesso archivio riutilizzato dopo riassociazione del numero alla stessa installazione; ripresa dopo ricreazione e riavvio runner senza QR. Isolamento tra installazioni coperto dai test SQL; manca collaudo telefonico su altro dominio |
| Idempotenza invii | Test SQL/API passati | Chiave e payload identici riusano il record; conflitto rifiutato; esiti incerti senza reinvio. Invio reale confermato sul telefono; manca crash durante invio reale |
| Webhook | Test automatici firma e sicurezza passati | Firma, alterazione, timestamp, indirizzi privati. Restano endpoint HTTPS esterno, timeout e ciclo consegne/retry reale |
| Runner distribuiti | Due runner Docker con heartbeat e lease reali | `verification/queues-result.json`: 36 inserimenti, 18 job unici, due worker, zero esecuzioni duplicate; coda QA sintetica, nessuna sessione WhatsApp misurata |
| Capacità 50–500 | Non verificata | Obiettivo da misurare con sessioni, CPU/RAM/browser, latenza e saturazione |
| Backup e ripristino | Passato su progetto e volumi separati | `verification/restore-result.json`: dump ripristinato e conteggi verificati, profilo estratto senza avviare runner ripristinati, database originale intatto |
| Rollback di versione | Runbook disponibile | Non ancora collaudato come switch completo tra release; nessuna down migration o cancellazione volumi |

`npm test` usa lo schema SQL reale su PGlite, API NestJS in processo e JWT firmati con provider OIDC simulato. Risultati in `verification/automatic-results.txt`. Questi test sono distinti dalle prove reali PostgreSQL/Keycloak/WordPress.

Le restrizioni iniziali del sandbox sono state superate eseguendo il collaudo Docker con le autorizzazioni richieste. Il browser Linux nel container Playwright funziona; il Chromium macOS resta inutilizzabile in questo ambiente. I segreti rimangono in `.env`, mai nei report. I dati QA sono separatamente riconoscibili e non sono dati commerciali di produzione.

OpenWA 4.76.0 si fermava durante l’inizializzazione del WhatsApp Web corrente. È stato sostituito con OpenWA 5.6.6, sempre dietro l’adapter EULab; sono stati aggiunti driver, lockfile, conversione QR e strumenti di compressione richiesti dalla persistenza. Una build riuscita non dimostra pairing o compatibilità delle singole funzioni.

## Prove che richiedono il telefono

Il collaudo del 19 ottobre ha completato l’associazione e un invio reale: l’utente ha confermato sul telefono la ricezione di «Test EULab: collegamento verificato». Il primo tentativo è rimasto incerto; il secondo è stato autorizzato esplicitamente e ha ottenuto stato `sent` e ID provider. Gli invii incerti precedenti restano tali, senza reinvio automatico. Il test riguarda un messaggio al proprio numero: la ricezione in Connect da un diverso account non è ancora provata.

OpenWA gira come libreria nei container `runner` e `runner-2`, insieme a Chromium; non esiste un servizio Docker separato chiamato OpenWA. Entrambi i runner usano l’immagine corretta. Sono stati risolti il rifiuto di un campo opzionale `undefined` durante la persistenza cifrata, il mancato mantenimento del profilo nativo Chromium, i lock obsoleti dopo ricreazione del container e la serializzazione delle chat durante lo storico. La patch del validatore resta vincolata a versione e checksum e continua a rifiutare campi sconosciuti valorizzati. Il report `verification/openwa-linked-result.json` descrive i problemi iniziali, superati dalle prove successive. I test automatici finali sono 19/19 e la build Docker del runner è passata.

Il riavvio e la ricreazione del runner hanno ripreso la sessione senza un nuovo QR, conservando l’archivio e il checkpoint cifrato. La sincronizzazione dello storico disponibile è stata completata prima dell’invio; l’esito dell’ultima ripresa è registrato in `verification/openwa-linked-fix-result.json`.

Restano da collaudare con destinatari autorizzati: ricezione da altro account, immagini, documenti, audio, video e sondaggi; isolamento tra domini su telefoni reali; unicità tra runner, perdita di lease e crash durante invio reale. I pulsanti interattivi richiedono inoltre licenza verificata e prova di risposta su telefoni reali.

La sincronizzazione deve indicare avanzamento e limiti dello storico reso disponibile da WhatsApp. Nessun test può garantire il recupero di messaggi o media che WhatsApp non rende più disponibili. Per i pulsanti servono inoltre licenza verificata e prova di risposta su telefoni reali.

## Utenti del sito WordPress QA

Su richiesta esplicita sono stati reimpostati i soli utenti dell’installazione `http://localhost:8090`, dopo dump MariaDB privato. Sono presenti `marco.rossi` e `giulia.bianchi` (amministratori), `sara.verdi` (editor), `paolo.ferri` (autore) e `luca.neri` (subscriber). Le password rimangono in `.env`. Gli utenti centrali Keycloak non sono stati modificati dal reset e i collegamenti SSO locali precedenti sono stati rimossi. Gli account tecnici temporanei, necessari all’ingresso EULab, sono esclusi dall’elenco degli utenti selezionabili. Lo script distruttivo di reset richiede il flag esplicito `--reset-qa-site-users`, controlla il dominio QA e conserva i contenuti riassegnandoli a Marco.

## Revisione admin del 19 ottobre 2026

Le verifiche e gli screenshot storici sopra si riferiscono alla versione precedente. La nuova revisione è implementata e verificata con test/API in processo, build e validazione Compose; browser e Docker operativo sono bloccati dai permessi dell’ambiente. Consultare [stato e attivazione](ADMIN-2026-10-19.md). Nessun nuovo collaudo Keycloak/WhatsApp reale viene dedotto dalle evidenze precedenti.

## Flusso WordPress aggiornato, collaudato nello stack locale

La revisione corrente sostituisce gli account tecnici con selezione e filtri nell’admin Connect. Associazione automatica dal codice hardcoded locale, pagina Impostazioni rimossa, 24 test passati e prova browser reale su ruoli diversi senza creare utenti. API, web e runner aggiornati dopo migrazioni 002–003; bootstrap SSO idempotente rieseguito. Evidenze e limiti: [WORDPRESS-ACCESSO.md](WORDPRESS-ACCESSO.md). I test storici con pagina utenti nel plugin sono superati. Il precedente blocco Docker è stato risolto usando i comandi Compose consentiti; il browser di collaudo viene eseguito nel container con Chromium.
