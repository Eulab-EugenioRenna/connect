# Allineamento pratiche e SDK — 24 ottobre 2026

ALORA in sola lettura; candidata SDK locale 0.10.0. Nessun secondo intake, coda o pubblicazione.

| Caso verificato nel codice prima dell'intervento | Disponibile | Lacuna |
|---|---|---|
| App assente | submit crea pratica senza application; execute/prepare chiama ensureApplication | source registrata obbligatoria; app esistente scelta solo per appId della source |
| Cliente/installazione assenti | ensureCustomerAndInstallation crea sotto lock tenant | mancano selezioni amministrative nel piano |
| Cliente/installazione esistenti | riuso binding già autorizzato | pannello non permette scelta per pratica; rischio riabilitazione implicita binding |
| Persona nuova | credenziale AES-GCM, TTL, provider, checkpoint | da conservare |
| Persona esistente | conflitto email e plan.identities esplicito, nessun reset | da conservare; controllare revoche prima delle assegnazioni |
| Duplicati/execute ripetuto | chiavi, lock, checkpoint e terminali | da estendere ai nuovi oggetti selezionati |
| Password rifiutata | action projection comune, migrazione recuperabile e attivazione contact_admin | da conservare |
| Facciata | challenge, consenso, PKCE, cookie, callback, handoff, store/sessioni | richiede issuer/client e sourceSecret anche per il primo invio |
| Pannello | pratiche, provenienza, piano JSON, execute | mancano presenter tecnici, scelte app/cliente/installazione e conflitti metadati |

Scelta: credenziale tecnica amministrativa limitata a un deployment, senza creare app/source approvata. Gli endpoint sorgente esistenti possono autenticare questa credenziale e riservare la provenienza al primo utilizzo. Il sourceId dichiarato non è una prova: la proprietà del vincolo è la credenziale emessa. Le origini e l'eventuale app verificate sono attestazioni amministrative distinte dai metadati dichiarati. L'appId dichiarato resta provenienza; l'app approvata è un binding separato.

La configurazione SSO è consegnata soltanto al backend autenticato dal medesimo segreto tecnico dopo completamento, attraverso un endpoint di configurazione sotto app-onboarding. È conservata cifrata nello store SDK. Non viene recuperata con il solo deploymentId e non passa nei risultati UI.

## Contratto consolidato

La credenziale tecnica presenter è distinta dall’integrazione approvata. Il primo uso autenticato degli endpoint esistenti riserva solo la provenienza; sourceId e metadati dichiarati non provano proprietà. La riserva è protetta da lock sul sourceId, vincoli univoci e binding del presenter. Rotazione/scadenza/revoca non consentono sostituzioni del deployment. Il segreto è memorizzato come hash, restituito una volta; nessuna credenziale Admin nel consumer.

Il piano riusa le pratiche esistenti e contiene application/customer/installation con scelta `existing` o `create`. Una corrispondenza verificata univoca prepara la selezione; i conflitti con app dichiarata, nome e catalogo restano visibili. I nuovi presenter non creano oggetti con prepare: solo Esegui migrazione applica il piano. I checkpoint conservano gli oggetti creati; lock sulla sorgente riservano l’app approvata fra pratiche concorrenti. Cliente/installazione selezionati devono essere coerenti con app e binding; i vincoli bloccano riabilitazioni implicite di installazioni, binding, utenti locali o licenze sospesi. Identità esistenti richiedono subject esplicito, non unione email o modifica password.

Le credenziali transitorie conservano cifratura, TTL e cancellazione. La proiezione comune delle azioni continua a distinguere migration recuperabile da activation/contact_admin, pratiche in esecuzione/terminali e collegamenti espliciti. Nessuna nuova eccezione di recupero per activation.

La stessa facciata può iniziare senza issuer/client e senza source approvata: discovery, challenge, consenso, invio e attesa rimangono nel modulo. Gli esiti aggiunti sono administrative_required e configuration_required. Dopo completamento, il backend sincronizza la configurazione SSO con il proprio segreto tecnico: configurazione cifrata nel server Connect e nello store consumer, mai consegnata dalla facciata al browser. Un appId pianificato può adattare il catalogo, senza concedere accesso. Il client OIDC va comunque registrato correttamente nel provider dall’amministratore: non viene creato implicitamente dal piano.

Guida e esempio: [INTEGRATION.md](../packages/sdk/INTEGRATION.md), [Workshop](../packages/sdk/examples/workshop/README.md). Il consumer conserva i propri ID, hash e profili; gli utenti Connect-only ricevono un profilo locale senza password provider.

## Risultati finali e livelli di evidenza

| Verifica | Esito e confini |
|---|---|
| Suite completa | 109/109 passati, zero skip/fallimenti; API reali su harness/PGlite, provider simulato nei test ordinari |
| Casi intake | App assente, verificata/autoselezionata, manuale e conflittuale; persona nuova/esistente; cliente/installazione selezionati o nuovi; ownership, rotazione/scadenza, duplicati e execute ripetuto; sospensioni e revoche |
| Regressioni precedenti | Password scadute, terminali, recupero migrazione, activation contact_admin, replay/handoff, rinnovi concorrenti, isolamento aziende e compatibilità sorgenti registrate |
| PostgreSQL Docker temporaneo | Migrator Connect 001–013 eseguito due volte; store SDK condiviso con Pool indipendenti; dieci casi facciata (il caso crash/commit iniettato è solo nello store deterministico) |
| Keycloak temporaneo reale | Rifiuto policy password, cancellazione/no identità, recupero con nuova prova/consenso/password, approvazione/configurazione, SSO PKCE/JWKS, refresh/revoca/logout; Connect DB PGlite e autenticazione admin/catalogo di test |
| Seconda app | Workshop installato dal tarball fuori checkout, con credenziale tecnica e senza configurazione OIDC iniziale; configurazione approvata e SSO reale, profili/hash locali conservati |
| Browser | Chromium Docker sul pannello reale con handler API/PGlite e provider simulato; selettori, salvataggio senza creazioni, execute, 390/1440px e nessuna eccezione/overflow |
| Build/pacchetto | Build API/SDK/web/demo, compose config, offline install, export ESM e dichiarazioni TypeScript passati |
| Docker operativo di sviluppo | Aggiornato su richiesta: backup privato, migrazione 013 (comando ripetuto senza duplicazioni), API/web ricreati; schema 013/13, health200 e hash bundle/asset verificati; provider e runner non ricreati |

Report locali ignorati da Git: `docs/verification/sdk-0.10.0-real.json`, `onboarding-panel.json` e screenshot, `onboarding-development-update.json`. Il backup è in `backups/` con permessi 0600; il report indica il percorso, non contiene segreti.

Candidata **0.10.0**, non pubblicata: `dist/releases/sdk/eulab-connect-0.10.0.tgz`.
SHA-256: `938a998004345cf650cbeb1881cf3f33df465ce3e806848a3ed436044abc56a1`.

## Limiti residui

Il percorso sull’installazione ALORA effettiva resta da collaudare con il suo backend, sorgente proprietaria, catalogo HTTPS, callback/provider e licenze reali. ALORA resta invariato. Il collaudo Keycloak temporaneo attraversa il login via HTTP, non il browser provider; il test grafico riguarda il pannello e non certifica MFA o SSO pubblico. Nessuna accettazione produzione, pubblicazione npm, commit o push.

La migrazione 013 è additiva e applicata dal migrator sotto lock; SQL grezzo non va rieseguito direttamente. Per un rollback del codice conservare le colonne aggiuntive e usare le immagini precedenti riportate nel report; non rimuovere dati/schema per tornare indietro. Il ripristino completo richiede una finestra di fermo e il backup verificato dal normale processo operativo: qui è stato verificato il salvataggio, non eseguito un restore distruttivo. Il client/provider e la consegna del segreto tecnico al backend restano attività amministrative esplicite. Il provisioning su database diversi richiede operationId idempotente e riconciliazione, senza promessa di transazione distribuita.


## Adozione ALORA e revisione di standardizzazione — 24 ottobre

Dopo la consegna sopra, ALORA ha adottato il tarball con checksum `938a998004345cf650cbeb1881cf3f33df465ce3e806848a3ed436044abc56a1`. Il consumer usa presenter + configuration.sync nella stessa facciata; il servizio enrollment/intake locale e la relativa proposta sono stati rimossi. Gli endpoint richieste e il pannello restano quelli descritti in questa guida.

È stato emesso un presenter tecnico per il Docker ALORA e consegnato nel solo `.env` consumer. Non sono stati approvati app/origini, riservate sorgenti tramite SDK, inviate pratiche o eseguite migrazioni per questo collaudo. Il collegamento backend usa il Nginx ALORA esistente con TLS locale e CA privata attendibile dal processo Node; non è una certificazione del catalogo o dell’issuer pubblico.

L’utente ha riservato a sé il collaudo del processo. L’adozione consumer ha eseguito installazione e compilazione/configurazione, non nuove suite o prove login/pratiche. I 109 test e i livelli di evidenza della consegna Connect restano quelli riportati sopra, non sono stati rieseguiti durante questa adozione.

La revisione statica conferma che il motore non dipende da modelli/ID ALORA: il consumer fornisce configurazione, store, adattamento HTTP e verifyLegacy/provision/restrict. I token opachi LocalSession sono compatibilità della UI legacy ALORA e non un requisito da copiare nelle prossime app.

Vincoli ancora espliciti per una nuova app: Node >=22, store conforme (PostgreSQL pronto), callback e appOrigin coerenti nella stessa origine; endpoint provider in forma Keycloak; quattro ruoli locali interoperabili owner/manager/reception/collaborator. Il flusso è riutilizzabile nel perimetro Connect, ma non è certificato universale per ogni provider OIDC o modello utenti. App con ruoli locali diversi richiedono un adattamento di dominio dichiarato oppure un’evoluzione coordinata di schema/API/SDK, non un cast silenzioso o una mappatura che allarghi i privilegi.

La chiusura dello Step 4 richiede ancora il percorso manuale ALORA: credenziali legacy → modale → richiesta reale → piano amministrativo → configurazione/catalogo/provider → esecuzione → sincronizzazione backend → SSO e restrizioni locali. Aggiornare questa guida con l’esito effettivo, distinguendo controlli statici, provider, browser e produzione.


Riepilogo revisione: un solo contratto app-onboarding e una sola facciata per prima richiesta, attesa e SSO; il consumer adatta dominio/HTTP. Il pacchetto e i Docker consumer sono allineati al checksum della candidata e usano installazione da lockfile. È standardizzazione del contratto/codice, non accettazione funzionale ALORA: quest’ultima è riservata all’utente. Nessun passaggio deve richiedere di copiare nel consumer protocolli, gestione credenziali transitorie o macchina degli stati delle pratiche.

## Revisione pannello — 24 ottobre

Un’unica area contiene lista filtrabile, pratica selezionata e piano. Creazioni tecniche/sorgenti/collegamenti sono chiusi sotto Creazioni rapide; provenienza, SSO, JSON avanzato e chiusura si aprono su richiesta. App, cliente e installazione hanno gruppi crea/collega. Persone nuove usano la migrazione; un pulsante carica gli utenti Connect da selezionare esplicitamente, senza associazione per email. Licenza, funzioni e ruoli/permessi si compilano con campi dedicati, senza JSON obbligatorio. Non sono state introdotte API o concessioni automatiche.

Typecheck e build web passati; browser Chromium Docker con handler reali/PGlite e provider simulato verifica creazioni rapide, compilazione piano/permessi senza JSON, nessuna creazione prima dell’esecuzione, completamento e viewport 390/1440px. Aggiornato solo il servizio web di sviluppo, asset confrontati per SHA-256 e health API200; nessuna nuova migrazione o modifica ALORA. Report: `docs/verification/onboarding-panel.json`, `onboarding-ui-update.json`. Il tarball SDK resta invariato.

### Autocompilazione del piano

Il pannello propone dati già ricevuti: nuova app se l’ID dichiarato è assente, nuovo cliente se non c’è un omonimo da verificare, origine installazione univoca, nome ruolo e permessi locali. Un’app esistente è preselezionata solo se verificata; nomi/email non diventano collegamenti automatici. Le scelte salvate, incluse restrizioni e permessi vuoti, sono conservate. Terminali/in esecuzione non ricevono proposte nuove. Il piano resta locale fino a Salva piano e le modifiche non salvate bloccano verifica/esecuzione.

Le funzioni della licenza sono proposte tramite la relazione permesso→funzione del catalogo già disponibile dell’app selezionata; i nomi dei permessi non vengono scambiati per funzioni. Se il catalogo non è disponibile occorre completare la licenza dopo la verifica. Issuer/client/secret non possono essere dedotti dalle credenziali legacy: i campi SSO restano facoltativi e spiegati. Cinque regressioni della proposta e collaudo browser passati; web Docker aggiornato, asset verificati e API health200. Nessuna modifica API/schema/SDK/ALORA. Report: `onboarding-autofill-update.json`.

## Risoluzione guidata — 24 ottobre

`Risolvi pratica` apre un riepilogo senza salvare o concedere accessi: recupera la matrice completa del deployment e propone app, azienda cliente e installazione nuove o collegate. Per ogni persona l'amministratore sceglie creazione oppure collegamento a un subject esistente; l'email non crea un'associazione. I nuovi ruoli ricevono tutti i permessi della matrice, con relativa licenza; restrizioni amministrative già salvate sono conservate.

Solo `Conferma e applica migrazione` invia il piano scelto all'endpoint amministrativo `POST /v1/onboarding/practices/:id/resolve`. La sequenza configura un client SSO dedicato al deployment (se manca una configurazione esplicita), salva il piano cifrando il segreto, poi riusa esecuzione, lock, checkpoint e controlli di revoca esistenti. Non modifica password di identità collegate, non riattiva oggetti sospesi e non unisce aziende per nome. Anteprima: `GET /v1/onboarding/practices/:id/resolution`.

Per cataloghi di sviluppo sul loopback dell'host, `CATALOG_INTERNAL_ORIGINS_JSON` viene passato all'API: il mapping locale esplicito conserva i controlli sulle destinazioni pubbliche. Non è un'autorizzazione generale ai cataloghi privati dichiarati dai consumer.

Verifica della risoluzione guidata: suite completa 119/119; i quattro incroci app nuova/esistente × persona nuova/esistente attraversano anteprima senza effetti, scelta del subject, conferma, recupero completo dei permessi e replay senza duplicati. Chromium Docker verifica apertura, annullamento e conferma con completamento su API/PGlite temporanei e provider simulato, a 390/1440px. API e web locali aggiornati usando le immagini runtime già installate e nuovi bundle (nessuna nuova dipendenza): la build ordinaria era bloccata dal portachiavi Docker. Hash dei bundle/asset e health verificati. Il mapping locale consente la lettura dei 22 permessi ALORA. La pratica operativa resta pending, senza piano salvato o migrazione applicata: le scelte e la conferma spettano all'amministratore. La creazione del client SSO del nuovo percorso è verificata col provider simulato, non ancora con il provider operativo.

### Correzione trasporto OIDC del consumer Docker — 24 ottobre 2026

La candidata locale SDK 0.10.0 aggiunge `oidcTransportOrigin` per le chiamate server al provider (token, JWKS, revoca/logout, discovery). URL browser e validazione issuer/audience restano canonici; il valore è un’origine configurata soltanto nel backend, con le stesse restrizioni HTTPS/loopback dello SDK. ALORA usa il proprio gateway TLS locale, evitando che localhost nel container punti al container stesso. Nessuna modifica alle pratiche, alle API Connect o allo schema 013.

Tarball ricostruito, SHA-256 `2e07f936a8d52b9ff47862dcd674e0afa39fe0a4c9919ffa37d4cd9380cc294d`; manifest e consumer aggiornati. Compilazione SDK/API e lint ALORA passati; discovery dal container HTTP 200 con issuer canonico. Non sono stati ripetuti test funzionali o login: l’accettazione operativa resta dell’utente. Nessuna pubblicazione npm.

## Conferma manuale dell’utente — 24 ottobre 2026

Dopo il riallineamento del client OIDC (audience connect-api e scope basic), l’utente ha confermato che l’accesso all’admin ALORA funziona. È una verifica manuale sull’installazione Docker locale: non equivale al collaudo di rinnovo, revoca, permessi, MFA o produzione. Nessuna migrazione o sessione utente è stata eseguita automaticamente per questa verifica.
