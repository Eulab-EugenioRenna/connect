# Consegna Connect — account applicativi delegati, Step 5

Richiesta di riferimento: ALORA `docs/connect-delegated-account-request-step-5.md` (25 ottobre 2026).

Candidata SDK **@eulab/connect 0.11.0**, compatibile con gli ingressi 0.10.0 esistenti. Nessuna pubblicazione npm o distribuzione operativa implicita. ALORA non viene modificata e resta sulla distribuzione approvata 0.10.0 finché non viene concordato l'aggiornamento.

## Contratto e confini

`POST /v1/users/mirror` conserva il ramo storico, compreso WordPress. Il nuovo campo facoltativo `application` richiede insieme segreto server dell'installazione e bearer dell'operatore. L'operatore deve essere un'identità aziendale, avere accesso e `team.manage` effettivo, ed essere mappato alla sorgente/azienda locale richiesta. Credenziali tecniche o EULAB Admin non sostituiscono questa delega.

Il contesto aggiuntivo contiene `sourceId`, `localTenantId`, nome/cognome, ruolo operativo, permessi locali e `roleIds`. Cliente/applicazione derivano dall'installazione autenticata. Sorgente approvata, binding installazione, binding azienda, mapping operatore e licenza devono essere coerenti e attivi. I ruoli sono scelti esplicitamente: tutte le loro funzioni, incluse quelle storiche, devono rientrare nella delega e nella licenza attuale. I permessi locali devono essere un sottoinsieme delle funzioni dei ruoli scelti. Nessuna copia automatica dei privilegi del chiamante; `owner` e ruoli di piattaforma non sono ruoli operativi ammessi per questo contratto.

La verifica squadra è condivisa in `TeamPolicy`, non duplicata nel mirror. I destinatari con funzioni fuori delega, anche non più attive, restano protetti. Identità di servizio, amministratori/tecnici provider e identità disabilitate non sono collegabili dal nuovo ramo.

Dopo creazione/recupero provider, una transazione scrive identità/membership se assenti, `local_links`, `app_local_users` e le sole assegnazioni richieste. Non modifica password preesistenti, revoche o sospensioni. La password iniziale è facoltativa e resta nel solo transito al provider. Se manca, il risultato indica `ssoSetupRequired: true`: il contratto non invia email di attivazione e non certifica un login completo finché l'utente non conclude le azioni provider.

## Unica facciata SDK

Usare la stessa istanza `ConnectApplication` già utilizzata per sessioni, SSO e autorizzazione. Il consumer persiste prima il profilo locale e conserva quell'ID anche dopo errori incerti.

```ts
import {ConnectApiError} from '@eulab/connect/application';

try {
  const result = await application.team.createUser(operatorSessionId, {
    localUser: {
      localUserId: profile.id,
      email: profile.email,
      firstName: profile.firstName,
      lastName: profile.lastName,
      role: 'collaborator',
      permissions: ['appointments.read.own'],
    },
    roleIds: selectedRoleIds,
    initialPassword, // facoltativa, solo per questa richiesta; mai in coda o log
  });
  // Finalizzare il collegamento locale usando questi ID autorevoli.
  // result: sourceId, appId, installationId, customerId, localTenantId,
  // localUserId, subject, roleIds, status, created, applicationAccess,
  // ssoSetupRequired; mai token, segreti o password.
} catch (error) {
  if (error instanceof ConnectApiError) {
    // error.status / error.code sono disponibili senza invalidare
    // la sessione per un semplice rifiuto di business.
    // Esito incerto: verifica e azione esplicita sullo stesso ID locale.
  }
  throw error;
}
```

`sourceId` proviene dalla configurazione e `localTenantId` dalla sessione già approvata. Il consumer non li ricostruisce e non fornisce segreti nel browser. Lo username provider è generato stabilmente dalla facciata; `localUser.username` resta facoltativo per consumer che ne abbiano già uno valido. Il metodo inoltra entrambe le credenziali e non ripete mutazioni automaticamente.

Tipi pubblici: `ApplicationTeamUserInput`, `ApplicationTeamUserResult`, `ConnectApiError`. Il client server espone anche `mirrorApplicationUser(accessToken, input)`; il consumer ordinario usa la facciata. Non è aggiunta un'API di creazione allo SDK browser.

## Ripetizione e recupero

La migrazione **014** aggiunge solo `app_local_users.mirror_fingerprint`: una ricevuta HMAC del profilo/contesto e dei ruoli iniziali, senza password. La prova provider esistente per installazione + ID locale + username viene conservata e affiancata dalla firma del contesto applicativo. Una risposta persa o un rollback SQL dopo creazione provider si recuperano con una nuova azione esplicita sullo stesso profilo; un'eventuale nuova password nella ripetizione non viene applicata.

Un collegamento storico senza ricevuta non viene adottato automaticamente. Un profilo/contesto incompatibile, mapping ambiguo o assegnazioni modificate successivamente richiedono revisione. Una ripetizione completata è priva di scritture e non ripristina ruoli, membership, identità o mapping sospesi. Le sospensioni e le revoche continuano a negare l'accesso.

Errori rilevanti:

| Codice | Significato / comportamento |
| --- | --- |
| `mirror_password_rejected` (400) | Policy password provider; correggere senza perdere la sessione operatore. |
| `mirror_identity_conflict` (409) | Identità occupata senza prova compatibile; nessuna unione per email. |
| `mirror_profile_conflict`, `mirror_mapping_conflict`, `mirror_review_required` (409) | Profilo, collegamento o assegnazioni da rivedere esplicitamente. |
| `mirror_mapping_disabled`, `mirror_identity_suspended`, `mirror_access_revoked` (409) | Nessuna riattivazione attraverso la creazione. |
| `mirror_provider_configuration_required` (503) | Configurare gli attributi riservati tramite bootstrap prima di creare identità. |
| `mirror_outcome_uncertain` (503 API / status 0 SDK per trasporto) | Nessun retry automatico; verificare/riprendere sullo stesso ID. |
| 401 autentico | La facciata elimina la sessione; refresh incerto, revoca e controlli SSO restano fail-closed. |

Anche gli errori di business nelle callback `application.services` ora preservano una sessione validata; la verifica/rotazione della sessione resta distinta dall'operazione applicativa. Un errore di commit dopo una mutazione remota resta un esito incerto.

## Prerequisiti di aggiornamento Connect

La consegna richiede API aggiornata, migrazione 014 e bootstrap aggiornato. Il bootstrap registra `eulab_mirror_proof`, `eulab_app_mirror_profile`, `eulab_onboarding_request` e `eulab_onboarding_source` nel profilo utenti Keycloak con lettura/modifica riservate agli amministratori. È ripetibile, conserva gli altri attributi e le policy esistenti e non abilita genericamente gli attributi non gestiti. Il mirror controlla la configurazione prima di una nuova creazione: provider che scartano la prova non possono produrre un falso successo recuperabile.

La migrazione 014 è additiva e idempotente attraverso il migrator. Per rollback del codice conservare la colonna, le ricevute, i mapping e le identità già creati; non eliminare dati o fare reset del database. Gli attributi provider possono restare configurati con il codice precedente. Backup e approvazione della distribuzione restano parte del normale aggiornamento operativo.

## Evidenze e limiti

I test API attraversano mirror → mapping → ruolo → login-context, casi negativi fra aziende/installazioni/sorgenti, assenza di credenziali/delega, permessi storici o non licenziati, identità protette, revoche/sospensioni, ripetizioni dopo modifica amministrativa e concorrenza. Il rollback finale SQL e la risposta provider persa sono iniettati; non sono promesse di transazione distribuita.

Il collaudo isolato usa PostgreSQL e Keycloak reali per password rifiutata senza identità, creazione, mapping/assegnazioni/login-context, login con la password originale, recupero dopo risposta persa o COMMIT SQL fallito, nessun reset in ripetizione e membership sospesa. L'autenticazione amministrativa/operatori dell'harness e il catalogo sono fixture dichiarate. La suite facciata mantiene prove separate di sessioni/store PostgreSQL, SSO PKCE/JWKS e rinnovo/revoca/logout; il percorso provider è HTTP, non un'accettazione browser ALORA.

Nessuna pratica operativa, account cliente reale, distribuzione in produzione o checkout ALORA viene modificato da questi collaudi. Lo Step 5 ALORA resta aperto fino alla distribuzione concordata dell'estensione, alla sua integrazione e al collaudo C1 e dei casi applicabili in `docs/team-step-5-acceptance.md` dell'applicazione.

### Esito finale della candidata

- Suite completa: **159 passati, 0 falliti, 0 saltati**. Ultimi controlli mirati su configurazione provider e percorso positivo: 3/3.
- Build API/SDK/web/demo, bundle runtime, compose config, installazione offline/ESM/tipi del tarball: passati.
- Migrator 001–014 eseguito due volte su PostgreSQL temporaneo; collaudo Keycloak/PostgreSQL e consumer indipendente passati, container temporanei rimossi.
- Tarball: `dist/releases/sdk/eulab-connect-0.11.0.tgz`. SHA-256: `b75d3c46ba8fbcf17dc522083f172abc3d07928c2f697d0f0c8ba182b6b749d5`.
- Rapporti locali ignorati da Git: `docs/verification/delegated-accounts-0.11.0.json`, `sdk-0.11.0-real.json` e log della suite/build.
- Nessun commit, pubblicazione npm, aggiornamento dello stack operativo Connect o modifica ALORA effettuati in questa consegna. Nessuna accettazione manuale ALORA/produzione implicita.

### Aggiornamento Connect locale — 26 ottobre 2026

Eseguito su richiesta dopo l'adozione della candidata in ALORA: backup completo PostgreSQL/Keycloak con permessi 0600, indice archivio leggibile con pg_restore; immagini precedenti conservate per il rollback del codice. Nessun restore distruttivo effettuato.

Schema operativo passato da `013|13` a `014|14`, con due esecuzioni del migrator e verifica della colonna `mirror_fingerprint`. Bootstrap aggiornato eseguito; i quattro attributi di prova provider risultano multivalore e riservati agli amministratori. API ricreata; hash dei bundle API/bootstrap/migrate conformi agli artefatti locali, health OK e nuovo campo `application` visibile nel contratto OpenAPI del mirror.

Confronto prima/dopo su 19 tabelle applicative e identitarie: nessuna variazione dei dati preesistenti (la colonna additiva è esclusa dal confronto). Verificati anche utenti, credenziali e ruoli provider. Audit, registro migrazioni e configurazione del profilo provider hanno le scritture previste dall'aggiornamento.

La build Docker ordinaria è rimasta bloccata dall'errore del portachiavi `(-50)`; per questo aggiornamento locale sono stati usati i bundle appena compilati sulle immagini runtime già installate, senza nuove dipendenze. Non è una certificazione di una ricostruzione Docker pulita.

Rapporto locale: `docs/verification/connect-schema014-update.json`, con percorso/checksum backup, immagini di rollback e verifiche. ALORA, web/runner/provider operativi e volumi non sono stati ricreati. Nessuna pubblicazione npm o distribuzione in produzione. L'accettazione funzionale C1 e il collaudo manuale ALORA restano da eseguire.

### Contesti di sessione SaaS — 26 ottobre 2026

Rilevato nel consumer ALORA un 429 su `app-onboarding/login-context`: i controlli ordinari delle sessioni consumavano la quota condivisa di onboarding. La sorgente viene sempre autenticata, ma le lookup valide hanno ora un budget distinto di 600/minuto per sorgente/IP/email normalizzata; solo l’hash dell’email entra nella chiave del limiter. Credenziali errate e operazioni ordinarie di onboarding conservano i rispettivi limiti di 120/minuto. I controlli su binding, identità, revoche e licenza restano invariati. Test di regressione in `tests/onboarding-context-rate.test.ts`: utenti separati, normalizzazione, limite individuale, abuso con credenziali errate e quota onboarding originale.

Suite finale 168/168, TypeScript e build immagine API passati. Aggiornata soltanto l’API dello stack locale; nessuna migrazione o pubblicazione SDK richiesta. Probe consumer reale: 681 lookup SDK/HTTP accettate, 601ª lookup del singolo contesto negata, altro contesto ancora disponibile. Due rientri browser ALORA con sessione provider già attiva passati senza logout. Evidenza consumer in `../barber/docs/verification/team-presets-passwords.json` sotto `sessionAccessReliability`. Nessun rilascio di produzione implicito.
