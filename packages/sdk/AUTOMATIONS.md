# Automazioni server — 0.12.0

Richiede Connect con schema **015** e API/runner aggiornati insieme. Contratto aggiuntivo: invii manuali, delega bot e `verifyWebhook` mantengono le firme esistenti. Nessuna pubblicazione npm implicita.

## Autorizzazione e credenziali

`ConnectServer.automations(accessToken?)` è disponibile solo nell’entrypoint `@eulab/connect/server`. Creazione e recupero richiedono credenziale dell’installazione e token personale corrente dell’autore. Il worker usa la credenziale della delega e quella dell’installazione, senza token UI o refresh token. Le route rifiutano chiamate con `Origin` o `Sec-Fetch-Site`, oltre a quelle prive dell’autenticazione server.

La delega registra autore verificato dal guard, installazione/app, finalità, canale, funzioni, archivio del numero WhatsApp, revisione, scadenza e revoca. Non assegna ruoli o permessi. Nessun `subject`, `admin` o token personale è accettato nel payload del job. Anche un amministratore deve possedere i diritti applicativi correnti: nessun bypass tecnico viene conservato nella delega.

Per `whatsapp` sono obbligatorie esattamente `whatsapp.manage` e `whatsapp.send`, oltre all’archivio appartenente all’installazione. Il controllo corrente comprende installazione/app, identità e membership abilitate, link locale, revoca applicativa, ruoli, catalogo, entitlement acquistato/abilitato, licenza attiva/non scaduta. Il provider identità viene letto tramite il servizio identità esistente: autore assente/disabilitato nega l’autorizzazione; indisponibilità nega l’effetto. Il token browser non viene conservato nella delega o nella sua outbox.

`application_notification` ed `email` richiedono deleghe **distinte**, con funzioni esistenti nel catalogo dell’app e prive del prefisso `whatsapp.`. Non ammettono `archiveId`. Il loro uso è autorizzabile con `verify`; gli effetti applicativi/email restano al consumer. Questo candidato non aggiunge un servizio di invio email delegato e non estende `POST /v1/notifications`.

Connect conserva la credenziale cifrata con la chiave dati esistente, più un hash per verificarla. `AutomationGrant` e `WebhookRegistration` contengono segreti: il consumer deve persisterli cifrati nel proprio store server, senza loggarli o restituirli al browser. `get`, `verify`, `revoke`, stato outbox, overview e liste webhook non restituiscono credenziali. Non passare segreti in URL o query string.

## Metodi SDK e route

Prefisso `R = /v1/installations/:installationId/automations`.

| SDK | HTTP | Autenticazione oltre alla credenziale installazione |
|---|---|---|
| `create(input, key)` | `POST R/delegations` | Token personale, `Idempotency-Key` |
| `recover(key)` | `GET R/delegations/by-key/:key` | Token personale dello stesso autore |
| `get(id, credential?)` | `GET R/delegations/:id` | Credenziale delega oppure token dello stesso autore |
| `verify(id, scope, credential?)` | `POST R/delegations/:id/verify` | Come `get` |
| `revoke(id, credential?)` | `DELETE R/delegations/:id` | Come `get`; ripetibile |
| `send(id, credential, input, key)` | `POST R/delegations/:id/messages` | `X-Connect-Delegation`, `Idempotency-Key` |
| `message(id, credential, key)` | `GET R/delegations/:id/messages/by-key/:key` | `X-Connect-Delegation` |
| `withdraw(id, credential, input, key)` | `POST R/delegations/:id/messages/by-key/:key/withdraw` | `X-Connect-Delegation`, stesso comando originale nel body |
| `webhooks.create(url, key)` | `POST R/webhooks` | Token personale con `whatsapp.manage`, `Idempotency-Key` |
| `webhooks.recover(key)` | `GET R/webhooks/by-key/:key` | Token personale dello stesso autore con `whatsapp.manage` |

Le chiavi sono obbligatorie, 8–128 caratteri `[A-Za-z0-9_-]`. Lo SDK non le genera e non ripete automaticamente le chiamate. `create` restituisce `{delegation, credential}`; `webhooks.create/recover` restituiscono `{id, url, enabled, secret}`. `verify` riceve `{purpose, channel, functions}` e restituisce `{allowed, reason}`. Errori di autenticazione, input, conflitto o indisponibilità restano errori HTTP/`ConnectApiError`.

```ts
import {ConnectServer} from '@eulab/connect/server';

// Eseguito esclusivamente nel backend. binding proviene dallo store server cifrato.
const connect = new ConnectServer({apiUrl, ...binding});
const grant = await connect.automations(currentAccessToken).create({
  purpose: 'appointments.reminder',
  channel: 'whatsapp',
  functions: ['whatsapp.manage', 'whatsapp.send'],
  archiveId,
  expiresAt: '2026-12-01T00:00:00Z',
}, persistedGrantKey);
// consumerVault è lo store cifrato del consumer, da implementare/riusare nel consumer.
await consumerVault.putEncrypted(grant.delegation.id, grant.credential);
// Al browser restituire solo stato, scadenza e motivo sicuro.
const ui = {id: grant.delegation.id, expiresAt: grant.delegation.expiresAt};

// Giorni dopo, anche con sessione UI scaduta:
const worker = connect.automations();
const credential = await consumerVault.readDecrypted(ui.id);
const accepted = await worker.send(ui.id, credential, {
  purpose: 'appointments.reminder', sessionId,
  payload: {kind: 'text', to: recipient, text: reminder},
}, persistedMessageKey);
const authoritative = await worker.message(ui.id, credential, persistedMessageKey);
```

Con la facciata esistente, creazione/recupero si eseguono dentro `application.services(sessionId, (client, token) => ...)`, salvando il segreto nel backend e proiettando solo campi sicuri. Il worker successivo usa il binding server e la credenziale cifrata salvata, senza riaprire quella sessione.

## Idempotenza, scadenza e outbox

Creazione: ricevuta unica per `(installazione, autore, chiave)` e hash del payload canonico. Replay identico o `recover` restituiscono la stessa credenziale senza rotazione; il recupero ricontrolla i diritti correnti. Cambiare finalità, archivio, scadenza o funzioni con la stessa chiave produce `409`. Le funzioni sono ordinate e deduplicate; l’ordine delle proprietà JSON non cambia la ricevuta. La scadenza iniziale deve essere futura ed entro 366 giorni. Una delega scaduta/revocata non si rinnova con la stessa chiave.

Invio: stessa outbox Connect, stessa unicità `(installazione, chiave)`. La ricevuta include delega, autore, sessione, finalità e payload. Replay discordante produce `409`, anche tra deleghe/canali/manuale/bot. Una risposta HTTP persa si recupera con `message` o con lo stesso `send`, senza cambiare chiave. La lettura della ricevuta originaria resta possibile dopo revoca/scadenza/disconnessione, mentre nuovi invii sono negati. L’accesso API richiede comunque una credenziale installazione ancora abilitata. Una nuova sessione sullo stesso archivio è ammessa con una nuova richiesta; una sessione di altro numero/installazione è rifiutata. Un invio già accettato sulla sessione precedente non viene trasferito automaticamente.

| Stato | Significato |
|---|---|
| `queued` | Accettato in outbox; nessuna prova di invio |
| `sending` | Tentativo acquisito una sola volta; esito ancora aperto |
| `sent` | Provider ha restituito un identificatore, commit outbox/evento riuscito; non prova consegna al dispositivo |
| `cancelled` | Ritiro esplicito o arresto prima dell’effetto per revoca/scadenza/sessione non valida |
| `failed` | Stato storico compatibile; il nuovo percorso non deduce un rifiuto certo da un timeout |
| `uncertain` | Esito ambiguo o worker interrotto; nessun reinvio automatico |

Il runner ricontrolla il grant corrente prima di acquisire il tentativo e immediatamente prima della chiamata provider. L’acquisizione serializza con la revoca; anche una revoca conclusa tra acquisizione e ultimo controllo impedisce l’effetto. Non è possibile annullare una chiamata già entrata nel provider o garantire atomicità distribuita tra SQL, provider identità e WhatsApp. Un crash prima/dopo l’effetto lascia `sending`, trasformato in `uncertain` all’avvio: si conserva l’incertezza anche se il messaggio potrebbe non essere mai partito. Un errore del provider identità prima dell’acquisizione lascia il comando in coda, senza effetto.

Non usare una nuova chiave per aggirare `uncertain`. Il consumer deve mantenere la stessa chiave per lo stesso comando di dominio e gestire la riconciliazione esplicita. Le ricevute hanno la durata dei dati: l’eliminazione esplicita di archivio/installazione può eliminarle; non è una procedura di retry.

## Ritiro del singolo comando (0.12.0)

Il ritiro usa `connect.automations().withdraw(id, credential, originalInput, originalKey)` senza token browser. `originalInput` ha lo stesso tipo `DelegatedMessageInput` e la stessa normalizzazione di `send`: `{purpose, sessionId, payload}`. `originalKey` è la chiave dell’invio, presente nel path; non serve una seconda chiave di idempotenza. Le firme di `send`, `message`, `revoke` e delle API manuali/bot restano invariate.

```ts
const result = await connect.automations().withdraw(
  delegationId, credential, originalCommand, persistedMessageKey,
);
if (result.outcome === 'withdrawn') {
  // result.message.state è tipizzato come 'cancelled'.
  // Questa ricevuta impedisce anche un successivo replay di send.
} else if (result.outcome === 'effect_started') {
  // 'sending', 'sent' o 'uncertain': non dichiarare annullato l’effetto.
  // Leggere message con la stessa chiave; nessun nuovo tentativo automatico.
} else {
  // 'already_terminal': fallito o già cancellato per un altro motivo.
}
```

Il risultato è l’unione discriminata `DelegatedMessageWithdrawal`, con `{outcome, message}`. `message` contiene la stessa proiezione autorevole di `message()`, senza payload o credenziali.

| Stato trovato sotto lock | Esito | Transizione |
|---|---|---|
| Comando assente | `withdrawn` | Ricevuta preventiva nella stessa outbox: `cancelled`, `error='command_withdrawn'`; mai `queued` |
| `queued` | `withdrawn` | Stessa riga/ID passa a `cancelled`, `error='command_withdrawn'` |
| `cancelled` con `command_withdrawn` | `withdrawn` | Nessuna modifica; replay del ritiro già riuscito |
| `cancelled` per altro motivo oppure `failed` | `already_terminal` | Nessuna modifica; non è una nuova cancellazione |
| `sending`, `sent`, `uncertain` | `effect_started` | Nessuna modifica; l’effetto acquisito non viene dichiarato ritirato |

La ricevuta è vincolata a installazione, delega/autore, finalità, sessione, chiave e hash canonico del payload originale, identico a quello di `send`. Se la chiave è già occupata da un altro comando, delega o invio manuale, oppure i dati originali non coincidono, il ritiro restituisce `409` e non cambia la riga. Per una ricevuta ancora assente si verifica comunque che la delega sia WhatsApp, la finalità coincida e la sessione appartenga all’installazione e all’archivio autorizzati; non occorre una sessione attualmente connessa. Credenziali installazione ancora valide e possesso della credenziale delega restano obbligatori. Una delega estranea non è visibile (`404`), un binding di installazione discordante è rifiutato; le chiavi restano nel namespace della rispettiva installazione.

**Serializzazione:** ritiro, `send` e acquisizione runner prendono il medesimo lock della delega prima del lock della riga outbox. Un `send` che non ha ancora inserito/commesso mantiene già quel lock: il ritiro attende il commit/rollback e poi cancella la coda o riserva la ricevuta preventiva, purché il runner non abbia già acquisito il tentativo; in quel caso restituisce `effect_started`. Se il ritiro arriva prima, la riga `cancelled` viene commessa prima che il `send` possa proseguire; quest’ultimo legge la stessa ricevuta senza accodare. Il vincolo univoco `(installazione, chiave)` e il confronto del digest risolvono anche collisioni tra deleghe differenti. Il ritiro non si conclude con un `404` per il solo fatto che l’invio non è ancora visibile.

Non è richiesta una migrazione: il candidato riusa colonne, stato terminale e vincoli dello schema 015. Non viene aggiunta una seconda outbox o una coda di cancellazioni. Il replay del ritiro riuscito restituisce lo stesso ID/stato; una risposta persa dopo commit si recupera ripetendo `withdraw` o leggendo `message`, con la stessa chiave. La ricevuta non viene riaperta da `send`, anche dopo scadenza/revoca. La lettura dello stato corrente di un tentativo già acquisito può invece evolvere, ad esempio da `sending` a `sent`: il ritiro resta `effect_started`, senza congelare uno stato vecchio.

Ritiro e lettura sono operazioni di proprietà, permesse anche dopo scadenza/revoca della delega e senza interrogare il provider identità o ampliare i diritti. Nuovi invii restano soggetti ai controlli correnti. Una revoca che aveva già cancellato la riga produce `already_terminal`; un comando ancora assente può essere riservato come ritirato anche con grant scaduto/revocato. Il ritiro non revoca la delega condivisa e non modifica le altre prenotazioni.

Nessuna cancellazione dal dispositivo, nessuna rotazione di credenziali e nessun annullamento di una chiamata già entrata nel provider. L’aggiornamento della prenotazione ALORA e il ritiro Connect non condividono una transazione: ALORA deve mantenere visibili gli esiti `effect_started` e `uncertain`, senza inventare un nuovo invio. Le ricevute durano quanto i dati dell’archivio/installazione, secondo il confine di conservazione già previsto; l’eliminazione esplicita dello storico non è una procedura di retry.

## Webhook recuperabili

Le nuove route usano `webhook_endpoints` esistente. Creazione concorrente o risposta persa dopo commit: ripetere la stessa chiave/URL o usare `recover`, con stesso autore e installazione. ID e segreto restano invariati. URL diverso con stessa chiave: `409`. Un endpoint disabilitato rimane disabilitato anche al replay. Gli endpoint storici/manuali non vengono adottati né duplicati da un recupero: senza ricevuta la nuova route restituisce `404`. L’API manuale storica resta disponibile.

Il trasporto mantiene HTTPS/443, controllo DNS e rifiuto di indirizzi privati. Un test loopback non dimostra raggiungibilità pubblica; non abilitare localhost nel runner per collaudare il consumer.

## Eventi firmati e risposte interattive

Envelope aggiuntivo compatibile: `{id, kind, createdAt, installationId, sessionId, payload}`. Il runner conserva `x-eulab-event-id`, `x-eulab-timestamp`, `x-eulab-signature`; HMAC-SHA256 su `timestamp.rawBody`. Riutilizzare `verifyWebhook(secret, rawBody, timestamp, signature)` esistente, con tolleranza di cinque minuti. Verificare il corpo originale prima del parsing; la firma non deduplica e non autorizza un’azione ALORA.

`message.received` conserva il nome storico e può indicare anche un messaggio proprio: controllare sempre `direction` e `fromMe`. Il payload tipizzato `WhatsAppMessageEventPayload` include:

- `messageId`, `providerId`, `chatId`, `sessionId`, `messageSessionId`, `archiveId`;
- `direction` (`in`, `out`, `unknown`), `fromMe`, `senderId`, `recipientId`;
- `occurredAt`, `observedAt`, `timestampSource` (`provider`, `connect`, `unknown`), `source`, `addressingVerified`;
- `kind`, `body.text`, `body.selectedButtonId` e contenuti interattivi supportati; il corpo storico resta compatibile.

`sessionId` identifica la connessione che ha osservato l’evento; `messageSessionId` quella della prima archiviazione del messaggio. `archiveId` identifica il numero attraverso le riconnessioni. Callback di sessioni chiuse/estranee sono scartate. Un’origine o timestamp incompleto è esplicito e il consumer deve negare azioni automatiche se non verificabile.

La selezione normalizzata produce **`message.interactive_response`**, con una ricevuta durevole unica `(messageId, kind)` nella stessa transazione di messaggio/evento/consegne. Funziona anche se `message.received` aveva già deduplicato lo stesso provider ID; callback duplicate o contraddittorie non producono altre selezioni. Se la normalizzazione arriva per prima, vengono emessi i due eventi distinti. L’ordine di consegna non è garantito. Le ricevute degli eventi ordinari storici vengono adottate dalla migrazione senza alterare l’evento originale.

Il consumer deve persistere la deduplica per event ID, verificare installazione/sessione/archivio, verso in ingresso, mittente/destinatario, timestamp e correlazione del pulsante al proprio piano/revisione/scadenza. Per selezioni usare `message.interactive_response`; non applicare lo stesso comando anche da `message.received`. Il provider non conosce conto, agenda o appuntamento ALORA. I formati SDK `WhatsAppPayload.kind='interactive'`, pulsanti reply/list e `InteractiveResponse` esistenti sono riusati.
