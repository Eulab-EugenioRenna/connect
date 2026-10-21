# Installer PHP unico per WordPress

Il file da caricare sul server è **`plugins/wordpress/euconnect.php`** (copia anche in `dist/wordpress/euconnect.php`), scaricabile anche da **Applicazioni → Siti WordPress → Protezione plugin → Scarica installer PHP**. È un installer autonomo, non un secondo plugin WordPress. Contiene il pacchetto Connect, senza segreti.

1. In Connect aprire **Protezione plugin → Prepara installazione MU** e conservare la chiave dedicata visualizzata una sola volta.
2. Caricare `euconnect.php` nella cartella di WordPress, accanto a `wp-load.php`. Se WordPress si trova in `https://sito.example/wp3`, aprire `https://sito.example/wp3/euconnect.php`. La posizione nella stessa cartella consente al browser di inviare il cookie amministratore, che può essere limitato a `/wp3`. Il file usa la propria cartella, senza parametri `path` o altre query.
3. Accedere prima a quel WordPress come amministratore. Inserire nell’installer URL API HTTPS, ID installazione e chiave di protezione. Solo per la prima associazione inserire il codice monouso di Connect. Il form richiede una conferma POST con nonce WordPress; una visita GET non installa nulla.
4. Al completamento l’installer verifica entrambi i file MU e la configurazione, poi elimina automaticamente la propria copia caricata nella cartella WordPress. In caso di errore non si elimina. Se il server ne impedisce la cancellazione, mostra un avviso per la rimozione manuale.

WordPress viene individuato solo nella cartella di `euconnect.php`, dove devono esistere `wp-load.php` e `wp-includes/version.php`. Il file non usa la working directory del processo e non accetta percorsi esterni o argomenti CLI. Per CLI caricare comunque il file accanto a `wp-load.php`, impostare `EULAB_GUARDIAN_CONFIG` con il JSON privato (`apiUrl`, `installationId`, `secret` ed eventuale `pairingCode`) ed eseguire `php /percorso/wordpress/euconnect.php`. Non mettere credenziali negli argomenti o nell’URL.

La copia nei MU-plugin è il componente permanente; la copia caricata accanto a WordPress serve solo per l’installazione e si autoelimina.

## Cosa viene installato

In WordPress compare solo **EULab Connect** tra i MU-plugin. Il file principale `wp-content/mu-plugins/euconnect.php` conserva una copia verificata del codice e carica i propri file dalla sottocartella `eulab-connect`. La normale copia del plugin viene disattivata, preservando utenti, opzioni, associazione e altre sessioni. Il plugin non crea account tecnici né un pannello Impostazioni.

API e chiave locale di cifratura possono essere predisposte dall’installer, senza modificare `wp-config.php`. Se le costanti esistono già vengono conservate, così le credenziali precedenti continuano a essere leggibili. La configurazione MU è cifrata usando le chiavi locali WordPress. Per attivare SSO clienti e registrare il callback Keycloak restano necessarie le configurazioni SSO descritte in [Integrazioni](INTEGRAZIONI.md).

## Ripristino e stop

Il MU-plugin è caricato da WordPress e non si disattiva dalla normale lista plugin. Se vengono rimossi i file nella sua sottocartella, li ripristina con il pacchetto locale dopo un controllo positivo della policy centrale. I tentativi persistono sulle richieste al sito, con attese crescenti fino a 15 minuti dopo errori di scrittura; non vengono scaricati o eseguiti pacchetti remoti arbitrari.

Da Connect **Ferma integrazione e ripristino** sospende caricamento e reinstallazione. La policy viene controllata circa ogni 30 secondi, quando arrivano richieste. I tentativi, lo stato e l’ultimo contatto sono visibili nel pannello. La chiave dedicata non abilita utenze, WhatsApp o gestione amministrativa.

Se Connect è temporaneamente irraggiungibile, i file esistenti usano l’ultima policy verificata. Lo stato fermo resta fermo; i file mancanti vengono ripristinati solo con una nuova autorizzazione centrale. Le sessioni WordPress aperte attraverso Connect vengono chiuse al controllo di una policy ferma, mentre gli accessi nativi con password restano indipendenti. I blocchi shortcode Connect non espongono contenuti quando l’integrazione è sospesa.

Se viene eliminato anche il file principale MU `euconnect.php`, quel codice non può ricrearsi da solo: rieseguire l’installer. Un controllo continuo anche senza richieste al sito o contro la rimozione dell’intera cartella MU richiede un cron/agente esterno; il singolo installer non costituisce quel servizio.

## Collaudo locale

Eseguiti sul WordPress reale: installazione da browser, amministratore richiesto, controllo nonce, rifiuto parametri di percorso, conservazione dell’installer dopo errori e autoeliminazione dopo il successo, eliminazione/ripristino del file del plugin, stop centrale con mancato ripristino, rimozione completa del MU e reinstallazione da browser. Utenti rimasti cinque e credenziali di associazione preservate. Evidenze in `docs/verification/wordpress-mu/`. Nessuna installazione su hosting esterni.
