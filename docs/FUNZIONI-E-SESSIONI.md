# Applicazioni, funzioni e sessioni

## Modello

- **Applicazione**: il prodotto software e la sua lista di funzioni. Una sola matrice condivisa dalle sue installazioni.
- **Installazione**: una copia dell’app per un cliente, dominio ed eventuale percorso. Identificativo, collegamenti agli utenti locali e WhatsApp appartengono all’installazione.
- **WordPress**: un tipo di integrazione dell’installazione. La scheda Siti WordPress è una vista filtrata, senza duplicare app e dati.
- **Permesso**: una funzione esposta dall’app. L’admin concede quelle funzioni attraverso licenza, abilitazioni e ruoli; non inventa un catalogo parallelo.

## Login del cliente nell’app

Il cliente apre l’app, esegue SSO e ritorna al callback della stessa app. Non accede al pannello amministrativo Connect. A ogni login `ConnectBrowser.init()` verifica la sessione e legge `/v1/access`: installazione, identità, appartenenza al cliente, collegamento locale esplicito, licenza e scadenza, funzioni acquistate/abilitate e ruoli. Il risultato contiene `canLogin`, motivazione, utente locale e lista `functions`. L’app adatta l’interfaccia e controlla nuovamente il permesso sul backend prima di ogni operazione protetta.

La sincronizzazione della matrice è indipendente dal login. Connect legge l’ultima matrice valida dal database; una fonte momentaneamente irraggiungibile non cancella le abilitazioni. `functionsStatus` distingue `ready`, `last_valid` e `pending`. Senza una prima matrice il cliente autorizzato entra comunque nell’app con le funzioni in preparazione. Nessuna funzione sconosciuta è concessa. Revoche effettive, licenze sospese e identità non autorizzate continuano a negare l’accesso. Un’indisponibilità del servizio di autenticazione non viene trasformata in un’autorizzazione.

## Matrice fornita dall’app

URL predefinito web: `https://app.example/.well-known/eulab-connect.json`, preceduto dall’eventuale percorso dell’installazione. WordPress espone `<home_url>/index.php?eulab_catalog=1`. L’URL viene impostato automaticamente creando l’installazione; l’admin può modificarlo nella finestra **Funzioni**, entro il dominio/percorso di un’installazione abilitata dell’app.

```json
{"schemaVersion":1,"appId":"mia-app","version":1,"functions":[
  {"key":"users.read","name":"Leggi utenze collegate"},
  {"key":"whatsapp.read","name":"Leggi conversazioni"},
  {"key":"whatsapp.send","name":"Invia messaggi"},
  {"key":"whatsapp.manage","name":"Gestisci connessione"}
]}
```

L’SDK genera la matrice con `defineFunctions` e la risposta con `functionsResponse`; il framework ospitante monta il GET. `ConnectServer.registerFunctions()` registra solo l’URL: Connect effettua il GET, non accetta la matrice inviata dal chiamante. WordPress genera la matrice automaticamente, estendibile con il filtro `eulab_connect_functions`; incrementare `EULAB_CONNECT_FUNCTIONS_VERSION` a ogni modifica. Il timer Connect controlla le fonti circa ogni minuto (massimo 20 app per scansione); **Rileggi funzioni** richiede un tentativo immediato.

GET limitato a JSON, 1 MiB e 5 secondi, senza redirect né credenziali. In produzione HTTPS pubblico; in collaudo locale solo origini mappate esplicitamente con `CATALOG_INTERNAL_ORIGINS_JSON`. Non esporre segreti nella matrice. Modifiche con uguale versione e versioni retrograde sono rifiutate, preservando l’ultima copia valida. La rimozione ritira la funzione e revoca assegnazioni/abilitazioni; la reintroduzione non le ripristina automaticamente. Le precedenti abilitazioni commerciali a gruppi vengono conservate per le esatte funzioni già dichiarate durante la migrazione al modello unico.

## Utenze e WhatsApp

`/v1/users` espone solo utenze abilitate, appartenenti al cliente e collegate esplicitamente all’installazione. Richiede `users.read`. Nessuna password, elenco globale o segreto. `permissions()` restituisce il contesto; `can(key)` guida la UI; `watchAccess()` aggiorna periodicamente; `requireFunction(token,key)` protegge le operazioni server. I metodi `whatsapp()` richiedono i rispettivi permessi a ogni operazione.

WordPress non crea utenti. Il login SSO cliente apre l’utente locale collegato e torna al sito. L’accesso amministrativo “Accedi come” richiede una selezione dall’elenco Connect, conserva i privilegi nativi e non modifica le altre sessioni dell’utente. Le sessioni WordPress aperte attraverso Connect vengono ricontrollate a ogni richiesta; le sessioni native con password rimangono indipendenti.

## Amministrazione delegata della squadra

Le API `/v1/team` consentono al titolare di gestire i collaboratori della propria installazione senza acquisire privilegi globali. Richiedono un token utente e `X-Installation-Id`; cliente e applicazione derivano sempre dall’installazione autenticata e non sono accettati nel corpo della richiesta.

| Metodo e percorso | Operazione |
|---|---|
| `GET /v1/team` | Riepilogo di funzioni, delega, ruoli e utenze |
| `GET /v1/team/users` | Utenze collegate all’installazione, con ruoli e stato della revoca |
| `GET /v1/team/functions` | Funzioni attive e incluse nella licenza, con `delegable` |
| `GET /v1/team/roles` | Ruoli dell’applicazione per il cliente |
| `POST /v1/team/roles` | Crea un ruolo con un sottoinsieme della propria delega |
| `PUT /v1/team/roles/:id` | Aggiorna nome e funzioni del ruolo |
| `DELETE /v1/team/roles/:id` | Elimina il ruolo e le relative assegnazioni |
| `PUT /v1/team/users/:subject/roles` | Sostituisce le assegnazioni del collaboratore |
| `DELETE /v1/team/users/:subject` | Revoca l’accesso del collaboratore alla sola applicazione |
| `POST /v1/team/users/:subject/restore` | Riattiva l’accesso quando esistono già ruoli assegnati |

Regole applicate dal server:

- Il chiamante deve poter accedere all’applicazione. Le operazioni di modifica richiedono sempre `team.manage` nella delega effettiva: un’app che non dichiara la funzione nella matrice resta in sola lettura. Per la lettura, se `team.manage` è dichiarata il chiamante deve possederla; altrimenti basta una delega effettiva non vuota.
- Si possono creare o assegnare solo funzioni attive, acquistate e abilitate nella licenza e presenti nella delega del chiamante. Ruoli o utenti che contengono funzioni fuori dalla propria delega non sono modificabili, revocabili o rimpiazzabili, nemmeno sostituendo le assegnazioni con ruoli più limitati.
- Non si possono concedere ruoli realm EULab Admin o tecnico, né agire su altre aziende o applicazioni. La revoca non disabilita l’identità globale e non tocca le altre app.
- La revoca rimuove le assegnazioni della coppia cliente/applicazione e registra `app_access_revocations`. Appartenenza al cliente, collegamento locale, identità e accessi alle altre applicazioni restano invariati. `PUT` delle assegnazioni o `restore` revocano esplicitamente il blocco.
- Le restrizioni operative dell’app, per esempio “solo i propri appuntamenti”, restano nell’app e si sommano alle autorizzazioni Connect.

SDK server: `teamOverview`, `teamUsers`, `teamRoles`, `teamFunctions`, `createTeamRole`, `updateTeamRole`, `deleteTeamRole`, `setTeamUserRoles`, `revokeTeamUser`, `restoreTeamUser`. Gli stessi metodi sono disponibili nel browser SDK, sempre con il token dell’utente e senza segreti installazione.

## Sessioni SSO

**Identità e accessi → Sessioni attive** mostra utente, IP, inizio, ultima attività, client SSO e sessione corrente. Si può chiudere una sessione o tutte quelle di un utente, con conferma. La ricerca filtra l’elenco e viene segnalato un eventuale limite di 500 sessioni per client SSO.

API e SDK espongono anche al cliente le proprie sessioni, sempre dall’app: `sessions()`, `logoutSession(id)`, `logoutAllSessions()`. Il server verifica la proprietà della sessione in Keycloak. I client non possono elencare o disconnettere altri utenti. Le sessioni offline non sono incluse.

Il salvataggio della licenza offre **Disconnetti tutte le sessioni SSO degli utenti collegati**. Sono selezionati solo i subject collegati al cliente/app tramite ruoli o utenti locali; la chiusura SSO riguarda anche le altre app di quegli utenti. Il piano viene salvato prima della revoca esterna e il risultato distingue utenti disconnessi e tentativi non riusciti. I nuovi permessi valgono comunque al controllo successivo, anche senza forzare il logout. Operazioni tracciate nel registro.

## Consumer ALORA: amministrazione delegata (25 ottobre 2026)

ALORA ha introdotto il pannello Accessi squadra usando ConnectApplication.services e i metodi team dello SDK npm pubblico 0.10.0. Il catalogo ALORA passa alla versione 2 con team.manage: richiede sincronizzazione e abilitazione esplicita in licenza, ruolo e delega; nessuna concessione automatica è stata eseguita. Restano autorevoli i controlli /v1/team del server Connect, inclusa la lettura quando l’app dichiara team.manage. Azienda e installazione provengono dalla sessione del backend ALORA. Prove del nuovo consumer: mock isolati e compilazioni; nessuna accettazione del pannello sull’installazione reale. Non è richiesta una nuova API o versione SDK per queste operazioni.

ALORA applica ora anche restrizioni operative locali e associazioni esplicite ai professionisti, entro ruoli, licenza e delega ottenuti dal pannello team. Sono scritture sul dominio ALORA, senza modificare assegnazioni Connect. Il consumer distingue errori dell’operazione da errori di sessione usando un risultato esplicito nella callback ConnectApplication.services: la facciata 0.10.0 invalida la sessione quando la callback lancia un’eccezione. I rifiuti di policy/conflitti vengono rilanciati soltanto dopo il ritorno dello SDK; la validazione della sessione resta autorevole nello SDK. Non è stata pubblicata una nuova versione per questo adattamento consumer.

ALORA pubblica ora il catalogo versione 3 con dashboard.personal.values.read (24 funzioni totali): nuova concessione negata finché non abilitata in Connect e nella policy locale. La dashboard personale e gli aggiornamenti di esecuzione sono limitati al professionista autenticato e non modificano il protocollo SDK. Per la creazione delegata completa, il mirror attuale scrive local_links ma non app_local_users richiesto dal login-context: richiesta tecnica consumer in `/Users/eugeniorenna/barber/docs/connect-delegated-account-request-step-5.md`. Non è stato implementato un secondo onboarding e lo SDK pubblico resta 0.10.0.

### ALORA: associazione operativa del titolare (25 ottobre 2026)

ALORA consente al titolare di associare il proprio account a un professionista con un comando locale dedicato. Usa la stessa facciata e teamOverview dello SDK pubblico 0.10.0, verifica canManage, stato attivo e corrispondenza esplicita localUserId/subject/installationId; non scrive ruoli, identità, credenziali o licenze Connect. La relazione operativa resta nel dominio dell’applicazione e non sostituisce il provisioning centrale. L’accesso ai dati personali resta entro le funzioni Connect e le restrizioni locali. Il contratto di creazione delegata descritto nella richiesta tecnica ALORA resta da completare; queste prove locali non attestano la sua disponibilità. Suite ALORA 165 test; associazioni/rollback verificati su PostgreSQL sintetico, nessuna nuova prova utente o concessione reale.

ALORA, aggiornamento Step 5: la funzione appointments.read.own include la consultazione dei turni configurati del proprio professionista e delle date di chiusura aziendali nel periodo. Il consumer applica tenant, utente e professionista attivo nelle query; non espone note interne né turni altrui e non richiede nuovi metodi SDK. Prova PostgreSQL sintetica e suite ALORA 167 test passate; nessun nuovo collaudo SSO o utente reale.
