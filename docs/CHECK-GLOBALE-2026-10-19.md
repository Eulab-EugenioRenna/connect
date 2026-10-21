# Check globale del 19 ottobre 2026

## Risultati

| Ambito | Esito verificato |
| --- | --- |
| Test API/SDK/dominio | 66 totali: 64 passati, nessun fallimento, due saltati per socket vietati dal sandbox |
| Build | API, SDK 0.7.1, admin, demo, installer WordPress compilati |
| Env dev e prod | Chiavi, duplicati, permessi 0600 e inoltro SMTP all’API verificati con `npm run env:check` |
| Compose dev e prod | Configurazioni valide; produzione isolata, nessun servizio QA, Keycloak interno e avvio ottimizzato |
| SMTP locale | Connessione TLS e autenticazione riuscite dalla rete Docker, valori sincronizzati con Keycloak, nessuna email inviata |
| Preferenza MFA reale | Campo dichiarato nel profilo Keycloak; salvataggio verificato preservando nome, username e stato; account QA eliminato |
| Build web produzione | Asset generati e verificati sotto `/admin/`, in una directory temporanea separata |
| Script operativi | Sintassi JavaScript verificata su tutti gli script `.mjs` |
| Provider Java | Tutte le classi compilate con JDK 21 contro le librerie del Keycloak 26.3.3 in esecuzione; nucleo OTP verificato |
| Runtime locale | API e web ricostruiti e aggiornati; health/database OK, nuove route OpenAPI e nuova UI servite da Nginx |

Il browser QA verifica la build con API NestJS/PGlite reali in processo e OIDC simulato; [risultato](verification/ui-result.json). Include sicurezza per persona, elenco app, scelta del metodo email, revoca dispositivo e layout desktop/mobile. Non prova il login MFA sul Keycloak reale. [Schermata desktop](verification/security-user-desktop.png), [schermata mobile](verification/security-user-mobile.png).

## Modifiche e comandi allineati

- Campi SMTP aggiunti agli env locali e ai generatori senza sovrascrivere valori esistenti; credenziali non copiate da dev a prod.
- SDK: configurazione QR e verifica email nel login SSO, preferenza personale, stato e revoche per utente riservati agli admin.
- Admin: **Utenti e accessi → Sicurezza e preferenze**; impostazioni globali SSO/SMTP in **Impostazioni accesso**.
- Preferenze nel profilo Keycloak, preservando la rappresentazione completa dell’utente. Verifica dopo il salvataggio per rilevare eventuali campi scartati dal provider.
- Rimozione Authenticator e revoca dispositivi con audit, chiusura sessioni ed esiti parziali espliciti; credenziali password e account di servizio protetti.
- `dev:api`, `dev:runner`, `db:migrate` caricano `.env`; sviluppo fuori dai container richiede gli URL host documentati.
- Nuovi comandi `env:check`, `infra:check:prod`, `smtp:check`, `smtp:sync`, `security:profile`, `security:prepare`, `security:activate`.
- Guide aggiornate e punto di ingresso unico in [AMBIENTI-E-COMANDI.md](AMBIENTI-E-COMANDI.md).

## Limiti e attività operative ancora aperte

Il flusso attivo del realm locale è ancora `browser`. MFA completa (QR, OTP email, cookie trusted HTTPS, scadenza e revoca nel login) deve essere collaudata prima di selezionare il nuovo flusso per tutto il realm. La compilazione Maven tramite Docker è stata impedita dal credential helper del portachiavi macOS nel recupero dell’immagine Maven; la compilazione diretta contro tutte le librerie reali è invece riuscita. Il provider aggiornato non è stato installato nel container Keycloak in esecuzione.

La risoluzione SMTP dal processo host ha restituito `ENOTFOUND`; la stessa verifica dalla rete Docker è riuscita. L’autenticazione SMTP non dimostra la consegna di un messaggio: nessun invio è stato eseguito.

Produzione predisposta ma non distribuita: `.env.production` richiede ancora valori SMTP, IP privato Connect e CIDR NPM. Nessuna verifica DNS/TLS/login sul dominio pubblico è stata dichiarata completata. I container QA e i runner aggiuntivi esistenti sono stati conservati.

Il workspace non contiene `.git`: non sono disponibili diff, stato Git o commit da attestare. [Evidenze strutturate del controllo](verification/environments/result.json).
