# Integrare Connect in un’app già in produzione

L’app conserva database, ID utenti, profili, dati, ruoli e password locali. Il cliente Connect è il tenant; il collegamento centrale usa sempre la coppia installazione + ID locale. Non serve cambiare gli ID esistenti o migrare il database applicativo in Connect.

## Migrazione da credenziali locali

Per ALORA e per le app con account locali che adottano il contratto assistito obbligatorio, il percorso di riferimento è [Attivazione assistita e migrazione](ATTIVAZIONE-MIGRAZIONE.md): il backend della sorgente registra prima app, ambiente, origini, catalogo e callback; l’utente vede solo **Invia richiesta** e non ha un accesso locale alternativo. La password verificata localmente resta cifrata con TTL esclusivamente per la pratica e viene cancellata alla conclusione.

Il percorso del mirror seguente resta disponibile per integrazioni esistenti che non usano la pratica assistita.

1. L’utente inserisce email e password nel form locale.
2. ALORA verifica le credenziali nel proprio database.
3. Il backend chiama Connect con la password appena verificata.
4. Connect crea l’identità nel provider e la collega all’utente locale.
5. Dopo il primo accesso Connect riuscito, l’app può usare Connect per gli accessi successivi conservando profilo e dati locali.

SDK server locale:

```ts
import {ConnectServer} from '@eulab/connect/server';
const connect = new ConnectServer({
  apiUrl: process.env.EULAB_CONNECT_URL!,
  installationId: process.env.EULAB_INSTALLATION_ID!,
  secret: process.env.EULAB_INSTALLATION_SECRET!,
});
// Chiamare solo dopo aver verificato localmente la password nel backend.
const mirrored = await connect.mirrorUser({
  localUserId: String(localUser.id),
  username: localUser.username,
  email: localUser.email,
  displayName: localUser.displayName,
  initialPassword: passwordAppenaVerificata, // solo per inizializzare una nuova identità
});
// mirrored.subject è l’identità centrale; l’ID dell’app rimane invariato.
```

`initialPassword` è disponibile esclusivamente alle richieste autenticate del backend dell’installazione (`X-Installation-Secret`). Non va inserita nel bundle browser, in un log, in un audit applicativo o in una coda. Deve provenire da una verifica locale appena conclusa: non è una password scelta dall’utente in questa chiamata e non viene conservata da Connect.

Comportamento del mirror:

- **Identità nuova**: la password viene impostata durante la creazione nel provider identità, che applica la propria policy. Non viene aggiunta l’azione obbligatoria `UPDATE_PASSWORD`; `ssoSetupRequired=false` quando il provider conferma la credenziale. Se la policy rifiuta la password, la creazione fallisce e l’app mantiene il proprio accesso locale.
- **Password assente**: resta il comportamento precedente. L’identità viene creata e attivata tramite Connect con `UPDATE_PASSWORD`; `ssoSetupRequired=true` segnala che serve configurare la password SSO.
- **Collegamento già presente**: la risposta è `already_linked` con lo stesso subject. Credenziali, profilo, permessi e revoche non vengono modificati o riletti.
- **Identità esistente non collegata**: nessuna associazione automatica per email e nessuna sovrascrittura della password. La richiesta restituisce conflitto e richiede un collegamento esplicito dall’admin Connect.
- **Timeout dopo la creazione**: il retry recupera l’identità già creata tramite la prova firmata del mirror e completa solo il collegamento. La password non viene reimpostata, anche se il retry ne contiene una diversa.
- **Nessuna assegnazione automatica**: il mirror non assegna ruoli, funzioni o licenze.

La password non compare in risposte, audit, log, errori o tabelle applicative Connect. La persistenza della credenziale resta responsabilità del provider identità. I test automatici usano un provider simulato: il collaudo reale deve dimostrare che la password del primo form funziona sul provider Connect, comprese policy password, MFA e azioni obbligatorie.

La funzione crea una normale identità cliente SSO, l’appartenenza al tenant dell’installazione e il collegamento all’utente locale. Le credenziali server rimangono nel backend. Il tenant non può essere scelto nel payload. Password/hash locali, ruoli amministratore, assegnazioni e privilegi dell’app non vengono importati o trasformati in ruoli globali Connect.

Richiamandola sullo stesso ID locale si ottiene lo stesso subject senza creare duplicati, sovrascrivere profili centrali o riattivare revoche amministrative. Anche un collegamento già selezionato dall’admin resta autorevole. `status` distingue `created`, `already_linked` e `recovered`. Un’identità creata nel provider prima di una risposta persa può essere recuperata al retry grazie alla prova firmata dal backend Connect.

Se username o email appartengono già a un altro account non viene fatta alcuna unione automatica: l’admin deve selezionare esplicitamente il collegamento. L’username deve essere valido per SSO (3–80 caratteri, lettere, numeri, punto, trattino o underscore); l’email deve essere valida. Per WordPress l’ID deve appartenere a un utente già presente nella directory sincronizzata.

La stessa installazione può essere usata per l’**amministrazione delegata della squadra** descritta in [funzioni e sessioni](FUNZIONI-E-SESSIONI.md): elenco utenze, ruoli applicativi e revoca del solo accesso all’app, sempre entro cliente, applicazione, licenza e delega del chiamante. Le operazioni di modifica richiedono la funzione `team.manage`; senza di essa l’app può solo leggere la squadra.

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

L’operazione di copia non esegue login e non cambia il meccanismo di autenticazione esistente. Se `initialPassword` è assente, la nuova identità non contiene la password locale: `ssoSetupRequired=true` segnala che serve la configurazione della password nella procedura SSO Connect/Keycloak (recupero password con SMTP configurato o procedura amministrativa dedicata). Se `initialPassword` è presente ed è accettata dalla policy del provider, l’identità nasce già con la credenziale verificata localmente e `ssoSetupRequired=false`. Questa chiamata non invia email. Per un collegamento già esistente il campo è `null`: lo stato delle credenziali non viene modificato o riletto.

Per autorizzare l’accesso tramite Connect restano necessari licenza attiva, appartenenza abilitata e collegamento locale; le singole funzioni richiedono anche abilitazioni e ruoli assegnati. La copia non acquista licenze né concede funzioni. Nel contratto assistito obbligatorio di ALORA, dopo l’approvazione l’accesso avviene esclusivamente con OIDC Authorization Code + PKCE; la schermata di migrazione non offre un login locale alternativo.

Per MFA con QR/codici email, dispositivi attendibili, SMTP, notifiche e il risultato strutturato del redirect SSO, vedi [Sicurezza, MFA e notifiche](SICUREZZA-MFA-NOTIFICHE.md). Le nuove funzioni richiedono migrazione 006 e attivazione del provider sul runtime.
