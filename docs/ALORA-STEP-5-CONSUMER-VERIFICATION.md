# ALORA — verifica del consumer SDK 0.11.0

Collaudo autorizzato del 26 ottobre 2026 sul Docker ALORA effettivo, con Connect
schema 014 e Keycloak reali. La candidata installata dal tarball è 0.11.0,
SHA-256 `b75d3c46ba8fbcf17dc522083f172abc3d07928c2f697d0f0c8ba182b6b749d5`.
Il consumer eseguito è ALORA commit `d0fe107`. Nessuna pubblicazione npm,
distribuzione di produzione o modifica ai sorgenti Connect durante questa prova.

## Contratto esercitato

ALORA usa la stessa `ConnectApplication` per sign-in, callback, sessioni,
autorizzazione e `application.team.createUser`. Il profilo locale inattivo e il
suo ID sono persistiti prima della chiamata; solo la risposta autorevole conclude
il collegamento. Non è aggiunto un endpoint di provisioning Connect alternativo.

Verificati dal browser ALORA:

- Creazione di ruolo entro delega e account con password iniziale; mapping
  applicativo esplicito e accesso personale con la stessa password sul provider.
  L'hash locale è indipendente dalla password provider; connectAcceptedAt rimane
  nullo fino al login personale verificato.
- Il manager ristretto riceve sei 403 per creazione/modifica/eliminazione di ruoli
  e assegnazione/revoca/restore di un destinatario fuori delega. Sessione conservata,
  ruoli e accesso del target invariati.
- La policy locale ALORA nega ulteriori operazioni concesse da Connect. Zero
  permessi locali blocca l'operatività e indirizza ad Accesso da configurare.
- Revoca dalla UI ALORA: la sessione destinatario già aperta è negata. Assegnazione
  esplicita successiva riabilita il login conservando l'identità.
- Risposta ALORA→browser interrotta dopo creazione reale: nessun retry automatico;
  la ripresa esplicita sullo stesso ID non duplica l'account e non sostituisce la
  password, verificata con un nuovo login reale.
- Agenda personale, isolamento delle assegnazioni e delle aziende, valori
  autorizzati: il servizio proprio contribuisce 123,45 €, mentre servizio altrui e
  riga prodotto non contribuiscono. Ricavi aziendali negati al collaboratore.

Il prerequisito inizialmente mancante era l'entitlement team.manage, pur presente
nel ruolo Titolare. Dopo abilitazione manuale dell'utente, licenza e delega effettive
sono verificate. Il collaudo non ha concesso privilegi agli account esistenti.
Il ruolo ALORA è un limite operativo aggiuntivo; il solo nome Titolare non supera
licenza o delega Connect.

## Dati e riconciliazione

Tre identità di prova e tre ruoli temporanei rimossi tramite le API amministrative
Connect esistenti; verificata la loro assenza anche dal provider e dai mapping.
ALORA rimuove soltanto le proprie fixture (account/intenti/sessioni, professionisti,
clienti, servizi, appuntamenti, conto e azienda esterna di prova), invalidando le
cache interessate. Audit conservato.

Entrambi i backup sono stati ripristinati in database isolati e poi eliminati.
Confrontate 14 tabelle operative/sicurezza ALORA e 15 Connect: contenuti riconciliati,
con esclusione esplicita di User.updatedAt e dei soli timestamp catalog_checked_at /
catalog_synced_at. Nessuna differenza su identità preesistenti, ruoli, assegnazioni,
licenza, entitlement, mapping e catalogo. Audit e sessioni runtime sono fuori dal
confronto. I record transitori dello store SDK restano soggetti alla normale TTL;
non viene eseguito un reset globale delle sessioni.

## Confini

Appuntamenti/conti di prova sono inseriti come fixture operative; il motore di
prenotazione non è esercitato. Il recupero simula perdita della risposta browser,
non un commit remoto incerto. In questa prova consumer non sono eseguiti rifiuto
password provider, setup senza password, MFA, riassegnazione concorrente o il caso
del medesimo utente su una seconda app. Restano distinti i test del produttore.
Le 190 prove automatiche citate dal consumer appartengono ad ALORA, non a Connect.

La pagina personale è osservata a quattro larghezze e il telefono è ispezionato;
non è accettazione su dispositivi fisici/PWA nativa. Lo Step 5 ALORA resta aperto
per i sottocasi nella checklist e accettazione operativa, senza claim di produzione.

[Evidenza strutturata consumer](../../barber/docs/verification/team-real-consumer.json)
· [Checklist aggiornata](../../barber/docs/team-step-5-acceptance.md)
· [Contratto produttore](DELEGATED-ACCOUNTS-STEP-5.md).
