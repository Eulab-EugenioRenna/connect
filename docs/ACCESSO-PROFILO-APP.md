# Accesso con il profilo locale dall’admin Connect

L’Admin EULab può entrare in un’installazione **non WordPress** con un profilo
locale già collegato. È lo stesso modello dell’accesso WordPress con utente
selezionato: nessun account tecnico, nessun account creato, ruoli e permessi
locali invariati.

## Flusso

1. L’identità centrale è collegata esplicitamente all’ID utente locale
   dell’installazione (**Identità e accessi → Collega utente locale**). Il
   collegamento WordPress non viene riusato: ogni installazione ha il proprio.
2. Da **Installazioni → Utenti e accesso** l’Admin sceglie il profilo e
   **Accedi come**. L’elenco mostra solo utenti collegati, con identità e
   appartenenza al cliente abilitate e senza revoca dell’accesso all’app.
3. Connect emette un ticket monouso valido 60 secondi, vincolato
   all’installazione, all’operatore EULab e all’ID utente scelto.
4. Il browser invia il ticket in POST a
   `<dominio><sottocartella>/eulab/connect/technical?installation=<id>` nel
   campo `ticket`. Il parametro `installation` identifica il binding locale
   prima del riscatto; non è mai usato come tenant e non sostituisce le
   credenziali server.
5. Il server dell’app chiama `ConnectServer.redeemTechnicalTicket(ticket)` con
   le proprie credenziali di installazione. La risposta contiene
   `scope: "eulab-access-as"`, `localUserId`, `localSubject`, `subject`
   dell’operatore e `accessToken` dell’operatore. `localSubject` è l’identità
   centrale collegata al profilo locale e permette all’app di verificare la
   coerenza con `User.connectSubject` quando presente.
6. L’app verifica che l’utente locale esista, sia attivo e appartenga al proprio
   tenant, quindi apre una sessione locale per quel profilo con le sue funzioni
   native. Non crea utenti, non modifica ruoli e non usa `accessToken` come
   token applicativo.

Il ticket viene ricontrollato al riscatto: se nel frattempo il collegamento è
stato rimosso, l’identità o l’appartenenza disabilitate o l’accesso all’app
revocato, il riscatto fallisce anche se il ticket non è scaduto.

## API

Elenco dei profili selezionabili, solo Admin EULab:

```http
GET /v1/installations/:id/access-users?search=<testo>&page=<n>
```

```json
{
  "installation": {
    "id": "…", "domain": "https://alora.example", "basePath": "",
    "integration": "web", "customerName": "ALORA Demo Studio",
    "appName": "ALORA"
  },
  "items": [{
    "localUserId": "f5e1f8aa-5055-477c-ae54-a01a8fe9ac15",
    "subject": "c7e37bff-0753-4fee-aedb-23d4b4cefacb",
    "displayName": "Demo Owner",
    "email": "owner@example.test",
    "roles": [{"id": "…", "name": "Titolare"}]
  }],
  "total": 1, "page": 1, "pageSize": 20
}
```

Per WordPress resta l’elenco dedicato
`/v1/installations/:id/wordpress/users`; questa rotta risponde `400` per le
installazioni WordPress.

Emissione del ticket:

```http
POST /v1/technical/tickets
{"installationId": "…", "localUserId": "f5e1f8aa-5055-477c-ae54-a01a8fe9ac15"}
```

Richiede il ruolo EULab Admin quando è presente `localUserId`. Un EULab
Technician può continuare a emettere solo l’accesso tecnico generico, senza
profilo.

Riscatto dal server dell’app:

```http
POST /v1/technical/redeem
{"ticket": "…"}
```

```json
{
  "subject": "operatore-eulab",
  "scope": "eulab-access-as",
  "installationId": "…",
  "localUserId": "f5e1f8aa-5055-477c-ae54-a01a8fe9ac15",
  "localSubject": "c7e37bff-0753-4fee-aedb-23d4b4cefacb",
  "accessToken": "…"
}
```

`scope` distingue i casi:

| scope | Significato |
| --- | --- |
| `eulab-wordpress-user` | Sessione WordPress per l’utente selezionato. |
| `eulab-access-as` | Profilo locale selezionato in un’installazione web/SDK. |
| `eulab-technical` | Accesso tecnico generico, senza profilo locale. |

## Responsabilità dell’applicazione

- Esporre una rotta server che accetta **solo** il campo `ticket` e consuma il
  ticket con le credenziali di installazione.
- Accettare `eulab-access-as` solo con `localUserId` presente e appartenente al
  proprio tenant; rifiutare scope o profili inattesi.
- Non usare `accessToken` come sessione dell’utente, non conservarlo nel browser
  e non ricavarne permessi applicativi.
- Tenere la sessione breve (riferimento WordPress: cinque minuti), ricontrollare
  a ogni richiesta che l’utente locale sia attivo e registrare l’audit locale con
  operatore, profilo e installazione.
- Le autorizzazioni applicative restano quelle dell’app. L’accesso non concede
  licenze, funzioni o ruoli Connect.

## Stato consumer

Il lato Connect è coperto da `tests/access-profile.test.mjs`.

ALORA è il primo consumer completo:

- la rotta browser `POST /eulab/connect/technical?installation=<id>` riscatta il
  ticket, ricontrolla l’operatore con `GET /v1/context`, crea un handoff monouso
  e reindirizza l’admin Angular su `#/login?alora_technical=<handoff>`;
- `POST /api/auth/connect/technical/exchange` consuma l’handoff una sola volta e
  apre una `LocalSession` breve, senza refresh, legata al profilo scelto;
- la sessione dura al massimo cinque minuti e comunque non oltre la scadenza del
  token operatore; a ogni richiesta ALORA ricontrolla l’operatore su Connect
  (cache massima di dieci secondi) e l’attività del profilo locale;
- il token operatore è cifrato a riposo, non viene mai restituito al browser e
  non è usato come token applicativo;
- il profilo mantiene il ruolo nativo: il titolare in access-as conserva tutte
  le funzioni implementate, gli altri ruoli restano soggetti ai propri permessi;
- l’audit locale registra richiesta e riscatto con operatore, installazione,
  profilo e `localSubject`, senza ticket o token.

La rotta convenzionale è pubblicata da nginx con un `location` esatto, separato
dal prefisso JSON `/api/`. Per le installazioni WordPress resta invariato il
flusso `/?eulab_technical=1` con l’utente WordPress selezionato.
