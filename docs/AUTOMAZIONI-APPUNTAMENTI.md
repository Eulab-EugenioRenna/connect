# Supporto Connect per automazioni appuntamenti ALORA

**Aggiornamento dell’11 novembre:** API, runner e schema 015 sono ora [installati e verificati nel runtime locale](LOCAL-AUTOMATIONS-RUNTIME-015.md), su successiva istruzione esplicita dell’utente. Account e messaggi reali restano esclusi. Le sezioni di consegna seguenti conservano il checkpoint del 10 novembre precedente al passaggio.

Consegna locale del 10 novembre 2026, su richiesta `barber/docs/connect-automation-delegation-request.md`. Codice, documentazione e prove isolate; nessuna modifica al repository ALORA, ad account/configurazioni reali o al Connect operativo. Nessun messaggio reale, pubblicazione npm o deployment.

## Contratto consegnato

Contratto API/SDK completo, parametri, sicurezza e ripresa: [AUTOMATIONS.md](../packages/sdk/AUTOMATIONS.md). Entry point: `ConnectServer.automations()`, candidato `@eulab/connect@0.12.0-rc.2`.

| Area | Implementazione |
|---|---|
| Delega | API `automations/delegations`; autore autenticato, app/installazione, finalità, canale/funzioni, archivio WhatsApp, revisione, scadenza/revoca; credenziale cifrata recuperabile |
| Diritti correnti | Policy Connect senza bypass admin; lettura corrente autore nel provider identità; nuova verifica prima dell’effetto |
| Sessione UI | Necessaria per consenso iniziale/recupero; non usata dal worker |
| Canali | WhatsApp richiede gestione+invio; notifiche applicative/email hanno grant separati e funzioni del catalogo; nessun effetto email implicito |
| Invio/stato/ritiro | Ritiro idempotente del singolo comando, anche prima del commit di invio, senza revocare la delega condivisa. Outbox Connect esistente; chiave stabile, conflitti espliciti, stato autorevole anche dopo risposta persa; incertezza senza reinvio |
| Webhook | Endpoint/segreto recuperabili per autore/installazione/chiave; nessuna rotazione o riabilitazione al replay |
| Risposte | Envelope firmato con sessione, archivio, verso, partecipanti, provider ID e tempi; evento durevole distinto per selezione interattiva |
| Compatibilità | Route manuali e bot esistenti mantenuti; verificatore SDK HMAC riusato |

Il servizio identità esistente deve poter leggere l’autore tramite la propria configurazione server. Questo lavoro non abilita né modifica tale configurazione reale. L’indisponibilità blocca l’autorizzazione; non viene sostituita con un’identità di amministratore.

## Ritiro del singolo comando

`ConnectServer.automations().withdraw(id, credential, originalInput, originalKey)` aggiunge il ritiro richiesto da ALORA. Mantiene le firme esistenti e richiede credenziale installazione/delega, senza token browser. Contratto completo e matrice degli esiti in [AUTOMATIONS.md](../packages/sdk/AUTOMATIONS.md#ritiro-del-singolo-comando-0120-rc2).

Se trova `queued`, conserva la stessa riga come `cancelled`; se l’invio non è ancora presente, crea una ricevuta preventiva `cancelled` con lo stesso hash del comando. Il lock già condiviso con `send` e runner serializza entrambe le direzioni della corsa tra invio e ritiro, anche prima del commit. Un `send` tardivo restituisce la ricevuta terminale. Le collisioni di payload/finalità/sessione/delega producono conflitto senza alterare il comando occupante. I tentativi `sending`/`sent`/`uncertain` restituiscono `effect_started`; gli stati già terminali per altri motivi restituiscono `already_terminal`. Nessun messaggio viene cancellato dal dispositivo e nessuna credenziale viene ruotata.

Non è richiesta una nuova migrazione: l’estensione usa schema 015, stato `cancelled` e vincolo univoco dell’outbox esistente. La proprietà della ricevuta consente lettura/ritiro dopo revoca o scadenza; non autorizza nuovi invii. L’annullamento della prenotazione e una chiamata già entrata nel provider restano operazioni senza atomicità distribuita.

## Migrazione e conservazione

[015-automation-delegations.sql](../infra/postgres/015-automation-delegations.sql) è registrata nel migratore. Aggiunge `automation_delegations`, riferimenti nullable nell’outbox, ricevute nullable nei webhook e `wa_message_event_receipts`. Nessuna riscrittura di campi originari, ruoli o licenze. Le ricevute dei vecchi eventi ordinari vengono ricostruite con gli ID già esistenti.

Il rehearsal usa dati sintetici in PostgreSQL 17.6 temporaneo, su tmpfs e porta loopback casuale. Confronta le colonne originarie di tutte le **46 tabelle** precedenti, incluse righe manuali/bot, token cifrato storico, webhook/segreto, evento e consegna. Esegue `pg_dump -Fc`, verifica `pg_restore --list`, ripristina in un secondo database sintetico, applica la migrazione due volte e confronta tutte le proiezioni originarie. Gli hash prima/dopo devono coincidere. Il migratore applicativo viene inoltre eseguito due volte in uno schema sintetico vuoto, con verifica `15:015`.

Artefatti locali riproducibili in `dist/verification/automations/`:

- `migration-preservation.json`: hash, numero di tabelle/righe e differenze;
- `synthetic-schema014.dump` e `.list`: solo fixture sintetiche, backup leggibile;
- `postgres-tests.tap` e `isolated-run.json`: prove PostgreSQL, arresti worker e cleanup;
- `full-suite.tap`: suite completa di regressione, quando copiata dal collaudo.

Non è stato acquisito o migrato un backup del database operativo. Il rehearsal prova la conservazione delle fixture e dei campi dello schema precedente, senza attestare dati reali o tempi di migrazione in produzione.

## Prove riproducibili

```sh
npx tsc -p apps/api/tsconfig.json
npx tsc -p packages/sdk/tsconfig.json
npm test
node scripts/test-automation-isolated.mjs
npm run package:sdk
```

Lo script isolato non legge `.env`: crea e rimuove soltanto un container PostgreSQL con nome casuale `connect-automation-test-*`, senza volumi persistenti o provider WhatsApp. Le identità sono JWT/introspection sintetici; il provider identità di lettura è uno stub esplicito. Non usare gli script `test:sdk:real`, SMTP o deployment per ripetere questo collaudo.

Copertura aggiunta: creazioni/recuperi concorrenti, hash canonico e conflitti, scope incrociato, scadenza/revoca, autore locale/SSO disabilitato o eliminato, membership/ruolo/funzione/link/revoca applicativa, entitlement e licenza, installazione sospesa, sessione UI revocata con delega valida, doppia acquisizione worker, risposta HTTP persa dopo commit di delega/webhook/enqueue, commit SQL con risposta persa dopo invio, interruzione reale del worker prima/dopo effetto, revoca tra claim ed effetto, assenza segreti da proiezioni/audit, verifica firma su corpo originale, replay/altro tenant, risposta ordinaria seguita da selezione sullo stesso provider ID, duplicati, messaggi propri, provenienza incompleta e rotazione connessione.

Le nuove prove di [automation-withdrawal.test.mjs](../tests/automation-withdrawal.test.mjs) coprono ritiro puntuale, tombstone assente, replay tardivo, conflitti/cross-installazione, scadenza/revoca, tutti gli stati post-acquisizione e perdita delle risposte di invio/ritiro. Su PostgreSQL osservano il lock effettivamente atteso da una richiesta concorrente e verificano entrambe le transazioni non ancora commesse, oltre alla corsa con il runner e al suo arresto sulla soglia prima dell’effetto.

## Risultati della verifica locale

| Verifica | Esito |
|---|---|
| Suite completa `npm test` | 192 casi: 187 passati, 0 falliti, 5 riservati a PostgreSQL |
| Suite PostgreSQL isolata | 24/24 passati, inclusi i cinque casi riservati: revoca durante lettura identità, arresto reale del worker e tre corse di ritiro/invio/runner |
| Compilazione API/runner e SDK | Passata |
| Migrazione 015, riapplicazione e ripristino | Campi/righe originari invariati nelle 46 tabelle; backup leggibile; migratore eseguito due volte |
| SDK candidato | Installazione offline, import ESM, metodi runtime e tipi TypeScript verificati; nessuna pubblicazione |

Pacchetto locale: `dist/releases/sdk/eulab-connect-0.12.0-rc.2.tgz`. Versione `0.12.0-rc.2`; checksum e lista dei file in `dist/releases/sdk/manifest.json` e `SHA256SUMS`. I cinque casi PostgreSQL sono esplicitamente saltati in PGlite perché richiedono connessioni/processi indipendenti; sono eseguiti nella suite isolata.

## Limiti residui

- Provider e identità sono sintetici. Pairing, resa dei pulsanti/list, ricezione sul dispositivo, consegna WhatsApp, raggiungibilità pubblica del webhook e accettazione ALORA restano prove separate.
- `sent` indica risposta provider e persistenza, senza attestare consegna al destinatario. `uncertain` richiede riconciliazione esplicita; una nuova chiave non è una procedura di recupero.
- Revoche intervenute dopo l’ultimo controllo e una chiamata già entrata nel provider non possono annullare l’effetto esterno. SQL, provider identità e WhatsApp non condividono una transazione.
- Notifiche applicative/email hanno deleghe/verifiche separate; i relativi effetti restano al consumer. Non è stata estesa l’API amministrativa delle notifiche a job delegati.
- Le chiavi di cifratura e le credenziali installazione restano nello store server esistente; il consumer deve cifrare il grant/segreto webhook nel proprio store e proiettare solo stato/scadenza/motivo al browser.
- Scheduling, policy/template e correlazione al dominio appuntamenti restano ad ALORA. Nessuna automazione operativa è stata attivata.
