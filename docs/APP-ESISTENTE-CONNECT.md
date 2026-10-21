# Integrare Connect in un’app già in produzione

L’app conserva database, ID utenti, profili, dati, ruoli e password locali. Il cliente Connect è il tenant; il collegamento centrale usa sempre la coppia installazione + ID locale. Non serve cambiare gli ID esistenti o migrare il database applicativo in Connect.

## Copia dell’identità dal backend

SDK server locale 0.5.1:

```ts
import {ConnectServer} from '@eulab/connect/server';
const connect = new ConnectServer({
  apiUrl: process.env.EULAB_CONNECT_URL!,
  installationId: process.env.EULAB_INSTALLATION_ID!,
  secret: process.env.EULAB_INSTALLATION_SECRET!,
});
// L’app autentica già il proprio utente o esegue una procedura amministrativa.
const mirrored = await connect.mirrorUser({
  localUserId: String(localUser.id),
  username: localUser.username,
  email: localUser.email,
  displayName: localUser.displayName,
});
// mirrored.subject è l’identità centrale; l’ID dell’app rimane invariato.
```

La funzione crea una normale identità cliente SSO, l’appartenenza al tenant dell’installazione e il collegamento all’utente locale. Le credenziali server rimangono nel backend. Il tenant non può essere scelto nel payload. Password/hash locali, ruoli amministratore, assegnazioni e privilegi dell’app non vengono importati o trasformati in ruoli globali Connect.

Richiamandola sullo stesso ID locale si ottiene lo stesso subject senza creare duplicati, sovrascrivere profili centrali o riattivare revoche amministrative. Anche un collegamento già selezionato dall’admin resta autorevole. `status` distingue `created`, `already_linked` e `recovered`. Un’identità creata nel provider prima di una risposta persa può essere recuperata al retry grazie alla prova firmata dal backend Connect.

Se username o email appartengono già a un altro account non viene fatta alcuna unione automatica: l’admin deve selezionare esplicitamente il collegamento. L’username deve essere valido per SSO (3–80 caratteri, lettere, numeri, punto, trattino o underscore); l’email deve essere valida. Per WordPress l’ID deve appartenere a un utente già presente nella directory sincronizzata.

## Accesso Connect separato

Il login di produzione continua a funzionare. L’app aggiunge un pulsante **Accedi con Connect**, con il flusso SSO già previsto da `ConnectBrowser.login()` e `init()`. Dopo il callback:

```ts
if (await connectBrowser.init()) {
  const access = connectBrowser.access!;
  // L’app usa access.localUserId per aprire l’utente e il profilo già esistenti.
  // Il backend verifica a sua volta il token e il contesto Connect prima di
  // aprire la sessione applicativa: il valore dal browser non è una prova d’identità.
}
```

L’operazione di copia non esegue login e non cambia il meccanismo di autenticazione esistente. La nuova identità non contiene la password locale: `ssoSetupRequired=true` segnala che serve la configurazione della password nella procedura SSO Connect/Keycloak (recupero password con SMTP configurato o procedura amministrativa dedicata). Questa chiamata non invia email. Per un collegamento già esistente il campo è `null`: lo stato delle credenziali non viene modificato o riletto.

Per autorizzare l’accesso tramite Connect restano necessari licenza attiva, appartenenza abilitata e collegamento locale; le singole funzioni richiedono anche abilitazioni e ruoli assegnati. La copia non acquista licenze né concede funzioni. Finché il percorso SSO non è completato e verificato, il login nativo dell’app rimane disponibile.

Per MFA con QR/codici email, dispositivi attendibili, SMTP, notifiche e il risultato strutturato del redirect SSO, vedi [Sicurezza, MFA e notifiche](SICUREZZA-MFA-NOTIFICHE.md). Le nuove funzioni richiedono migrazione 006 e attivazione del provider sul runtime.
