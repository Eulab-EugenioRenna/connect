# Sorgente ALORA di sviluppo per SDK 0.10.0

Questa consegna non modifica `/Users/eugeniorenna/barber`. ALORA ha segnalato l’adozione di SDK 0.10.0; questo intervento non modifica né certifica la sua configurazione operativa.

Aggiornamento consumer del 24 ottobre: ALORA ha ora adottato questa candidata (SHA-256 `2e07f936a8d52b9ff47862dcd674e0afa39fe0a4c9919ffa37d4cd9380cc294d`). È configurato un presenter tecnico dedicato, senza approvare app/clienti o inviare pratiche. Il vecchio intake consumer è rimosso. I nomi consumer attuali sono `ALORA_CONNECT_PRESENTER_ID`, `ALORA_CONNECT_PRESENTER_SECRET`, `ALORA_CONNECT_SOURCE_ID`, `ALORA_CONNECT_APP_ID`, `ALORA_CONNECT_API_URL`, `ALORA_CONNECT_CALLBACK_URL`, `ALORA_AUTH_RETURN_URL`, `ALORA_CONNECT_ENCRYPTION_KEY`; issuer/client sono facoltativi prima dell’approvazione. Per il procedimento utente vedere `/Users/eugeniorenna/barber/docs/auth-flow-step-4.md`. Il collaudo è riservato all’utente; le sezioni successive conservano anche la ricetta compatibile precedente.

Per una nuova integrazione lo schema 013 offre una credenziale tecnica presenter emessa dall’amministrazione senza app/sorgente approvata. Il backend usa gli stessi metadati sotto `presenter.deployment`; la pratica permette la scelta amministrativa e `configuration.sync()` acquisisce SSO dopo completamento. Non convertire automaticamente la sorgente ALORA già associata: un nuovo presenter non può assumerne il sourceId. Rotazione e aggiornamento vanno effettuati sulla credenziale proprietaria. Vedere [guida completa](../packages/sdk/INTEGRATION.md).

Il percorso compatibile per una sorgente già registrata rimane:

```json
{
  "id": "alora-development",
  "appId": "alora",
  "name": "ALORA sviluppo",
  "environment": "development",
  "origins": ["http://localhost:5174"],
  "catalogUrl": "http://localhost:5174/.well-known/eulab-connect.json",
  "oidcCallbacks": ["http://localhost:5174/auth/connect/callback"],
  "deploymentIdentity": "alora-local-development"
}
```

I valori sono una ricetta, **non una registrazione effettuata né una conferma delle porte del consumer**. Allinearli all’origine e alle route effettive di ALORA. Il catalog reader operativo applica la propria policy HTTPS/SSRF: una URL locale HTTP qui dichiarata non prova che il catalogo sia scaricabile. Per un collaudo operativo configurare un endpoint HTTPS di sviluppo raggiungibile e ammesso dalla policy, con catalogo e callback/origini coerenti. Non aggirare la policy usando l’iniezione catalogo dei test.

Backend ALORA attuale da configurare in `.env` locale:

| Variabile consumer attuale | Valore/ruolo |
|---|---|
| `ALORA_CONNECT_SOURCE_ID` | ID della sorgente registrata |
| `ALORA_CONNECT_BOOTSTRAP_SECRET` | Segreto restituito una volta dall’amministrazione sorgente |
| `ALORA_CONNECT_APP_ID` | App ID esatto autorizzato |
| `ALORA_CONNECT_API_URL` | API Connect raggiungibile dal backend (HTTPS fuori loopback) |
| `ALORA_CONNECT_ISSUER` | Issuer canonico del realm di sviluppo |
| `ALORA_CONNECT_CLIENT_ID` | Client OIDC dedicato con Authorization Code + PKCE S256 |
| `ALORA_CONNECT_CALLBACK_URL` | Callback esatta registrata nel client e nella sorgente |
| `ALORA_AUTH_RETURN_URL` | Route UI interna per l’esito del login |
| `ALORA_CONNECT_ENCRYPTION_KEY` | Chiave server casuale, 64 cifre esadecimali |

Per la facciata futura: gli stessi valori diventano sourceId/sourceSecret/appId/apiUrl/issuer/clientId/redirectUri/encryptionKey; aggiungere appOrigin, eventuale clientSecret confidential, store PostgreSQL condiviso e gli adattatori locali. Non generare o distribuire segreti tramite questa guida.

Nel provider registrare callback precisa e audience access token `connect-api`; azioni MFA/password obbligatorie devono restare gestite dal provider. Nel Connect amministrativo collegare sorgente/installazione, assegnare esplicitamente tenant ID e user ID ALORA al subject verificato, concedere licenza/funzioni/ruoli. Un’identità esistente con la stessa email richiede collegamento amministrativo; nessuna creazione/associazione automatica.

Prerequisiti Connect: schema 011 più 012 per il recupero password, credenziali servizio identità configurate, chiave migrazione server, TTL credenziale, catalogo raggiungibile, fonte abilitata. Credenziali sorgente, installazione e provider restano backend. Il controllo SDK read-only non sostituisce il collaudo utente OIDC, licenze, collegamenti e HTTPS catalogo reali.

Il tarball locale `dist/releases/sdk/eulab-connect-0.10.0.tgz` è installabile senza pubblicazione. Prima di cambiare ALORA rieseguire in quel repository i suoi collaudi equivalenti, inclusi hash/profili locali preservati, nessuna sessione durante attesa, recupero password e isolamento dei saloni. Nessuno di questi collaudi consumer viene dichiarato eseguito da questa consegna.
