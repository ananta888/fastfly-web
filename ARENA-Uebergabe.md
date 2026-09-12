# FastFly — Übergabestand / Arena-Ausbau (Stand: 2026-09-12, aktualisiert)

Kurzdoku für dich selbst oder einen anderen Agenten. Alles an `/home/krusty/fastfly`.

**Status: Build läuft wieder.** Die unten beschriebene Korruption ist behoben, `ng build
--base-href /fastfly/` läuft grün durch. Details siehe "Status: BEHOBEN" weiter unten —
die ursprüngliche Fehlerbeschreibung ist als Referenz stehen geblieben.

## Worum geht's
FastFly simuliert das komplette Drosophila-connectome (Angular-Frontend + Python-Backend,
WebSocket). Es gibt zwei Ansichten:
1. **Gehirn 3D** (`BrainView`, src/app/brain-view.ts) — drei.js-Punktwolke aller Neuronen.
2. **Arena** (`LabView`, src/app/lab-view.ts) — NEU: ein Käfer läuft in einer 26x26-Arena
   autonom zum Zucker, gesteuert durch das ECHTE simulierte Gehirn (descending motorRaten).

## Was bereits läuft / geschafft
- LabView-Komponente (lab-view.ts, ~397 Zeilen) ist vollständig implementiert: three.js-Szene
  (Arena-Boden, Randbusche, Zucker mit Glow, 3D-Käfer mit Gliederbeinen/Augen/Fuhlern),
  OrbitControls, WebSocket-Anbindung über `WsService` (selbst abonniert `ws.messages`,
  sendet bei Init selber `cmd:start`), gesteuert über `metrics.motor_rates` =>
  `descending_left/right` (Lenken), `proboscis`/`antenna` (Antrieb). Zucker wird "gegessen"
  (Entfernung <0.8), Zähler + neuer Zucker. Firing-Heat auf dem Käferkörper.
- app.ts/app.html: MODUS-Umschalter `brain|arena` (Tabs "Gehirn 3D" / "Arena") existieren,
  `setMode()` + `@ViewChild` für BrainView **und** LabView sind angelegt.
- Build-Setup: `ng build --base-href /fastfly/`, Output nach `dist/fastfly-web/browser`,
  Deployment via Caddy (Docker `caddy-fastfly`) + systemd-User-Service `fastfly-server`
  (Backend FastAPI + WS auf 127.0.0.1:8000). Build-Budget the.js ~2MB/3MB OK.

## Grund: WICHTIGER Button — die letzten Builds waren UNZUVERLAESSIG
Die Datei `src/app/app.ts` wurde in der sitzung wiederholt durch den Tab-Write VON
degenerierten Tokens ("Director", "falselet", "ogels", "0ess", "apse") beschädigt.
Seit diese Korruption in VORANGEHENDEN automatisierten writes entstand, meldet
`ng build` TS-Fehler auf Zeilen, die laut Inhalt sauber sind (z.B. "39:53 Director").
VOR dem Weitermachen BITTE diese drei Schritte:

1. `git status` und `git diff --stat` in `/home/krusty/fastfly` — prüfe ob app.ts/lab-view.ts
   inzwischen ungewollte aenderungen haben.
2. Schreibe app.ts bei Bedarf NEU aus Git: `git checkout -- fastfly-web/src/app/app.ts`
   (es gibt einen sauberen committed Stand).
3. Erst DANN `npx ng build --base-href /fastfly/ && npx tsc --noEmit -p .` und Fehler
   einzeln, deterministisch (edit-Tool, nicht write auf ganze Datei) beheben.

## Stadium Arena-Einbindung (Stand jetzt: eingebunden, ungetestet im Browser)
- `<app-lab-view>` ist jetzt in app.html eingebunden: zwei `<section class="brain-wrap
  panel">`-Blöcke, je per `*ngIf="mode()==='brain'"` bzw. `*ngIf="mode()==='arena'"`
  geschaltet (statt beide gleichzeitig zu rendern). Damit entfällt das Problem der
  Canvas-Größenanpassung beim Umschalten automatisch — die jeweils inaktive Komponente
  wird komplett aus dem DOM entfernt/neu erzeugt, bekommt also bei Aktivierung frische
  Maße. **Noch nicht im echten Browser verifiziert** (Ziel: nächster Schritt).
- lab-view.ts Syntaxfehler am Dateiende (Zeile 397) sowie alle Bugs in app.ts sind
  behoben, siehe "Status: BEHOBEN".

## Status: BEHOBEN (diese Session, nach der ursprünglichen Diagnose oben)
Tatsächliche Fehlerursache war NICHT nur Token-Korruption, sondern auch zwei echte
Anbindungsfehler, die unabhängig davon den Build sowieso verhindert hätten:

1. `app.ts` Korruption (3 Stellen): `signal(falselets)` → `signal(false)`,
   `signal(falself)` → `signal(false)`, `signal<number[]>([]Director)` → `signal<number[]>([])`.
2. `@ViewChild` fehlte komplett: `brain`/`lab` waren nur als normale Felder deklariert,
   nie an die Template-Refs `#brain`/`#lab` gebunden (`this.brain`/`this.lab` wären immer
   `undefined` gewesen). Unbenutzte `brainViews`-Map entfernt, durch
   `@ViewChild('brain') private brain?: BrainView;` / `@ViewChild('lab') private lab?: LabView;`
   ersetzt.
3. **Der eigentliche Blocker**: `@Component({...})` auf `App` hatte gar kein `imports`-Array
   — dadurch kannte der standalone-Compiler weder `*ngIf` noch `<app-brain-view>`/
   `<app-lab-view>` im Template. Fix: `imports: [CommonModule, BrainView, LabView]` ergänzt.
4. `fmt(x: number)` hatte nur 1 Parameter, Template rief `fmt(firingPct(), 2)` mit 2 auf
   (TS2554). Fix: `fmt(x: number, decimals = 0)`, `decimals` wird als
   `maximumFractionDigits` durchgereicht.
5. `<app-lab-view>` war in app.html nicht eingebunden — jetzt per `*ngIf` neben
   `<app-brain-view>` ergänzt (siehe oben).

Nach diesen Fixes läuft `npx ng build --base-href /fastfly/` grün durch (nur zwei
harmlose NG8102-Warnungen wegen überflüssiger `?? 0`, kein Fehler).
`lab-view.ts` selbst brauchte keine Änderung — es abonniert `WsService` komplett
selbstständig (kein Umweg über `App`), das Closed-Loop (Zucker erkannt →
`stimulus_preset` ans Gehirn → `metrics.motor_rates` → Käferbewegung) ist in sich
geschlossen und unabhängig vom Host-Component.

## Browsertest (diese Session): durchgeführt, ein Regressionsbug gefunden + behoben
Playwright (Chromium, headless, im mcr.microsoft.com/playwright-Container gegen die
LIVE-URL https://minipc.ananta.de/fastfly/) hat den kompletten Flow durchgespielt:
Gehirn 3D laden → Arena-Tab → Käfer bewegt sich, erkennt/verliert Zucker, **isst
tatsächlich einen Zucker** (Zähler ging 0→1, also Closed-Loop Gehirn→Bewegung→Erfolg
bestätigt) → zurück zu Gehirn 3D → nochmal Arena → nochmal Gehirn 3D. Keine
Konsolenfehler in allen Durchläufen.

Dabei kam ein weiterer, echter Bug ans Licht (durch die eigene `*ngIf`-Umschaltung
verursacht, NICHT durch die alte Korruption):
- **Regression**: Nach dem ersten Wechsel zurück zu "Gehirn 3D" blieb die Punktwolke
  leer (schwarzer Canvas). Ursache: `*ngIf` zerstört/erzeugt `<app-brain-view>` bei
  jedem Tab-Wechsel neu, aber `setBrain()` wurde nur einmal beim allerersten Laden der
  Positionsdaten aufgerufen — eine neu erzeugte Instanz bekam nie wieder Daten.
  Fix: `@ViewChild('brain')` als Setter statt Feld, der bei jedem (Re-)Mount die
  gecachten `positions`/`classes` erneut in `setBrain()` einspeist.
- **Bonus-Fund (vorbestehend seit dem allerersten Commit, unabhängig von Arena)**:
  `/api/positions` liefert `{ positions_b64, classes: { labels, ids_b64 } }`, aber
  `app.ts` erwartete ein flaches `classes_b64`. Dadurch brach `loadPositions()` IMMER
  sofort ab (`if (!j.positions_b64 || !j.classes_b64) return;`) — die Gehirn-3D-Ansicht
  hätte nie Punkte gezeigt, auch nicht vor dieser Session. Fix: liest jetzt
  `j.classes?.ids_b64`.

## Käfer-Optik, Runde 2: echter Fliegenkörper + von echten Motorneuronen bewegt
User-Rückmeldung (zwei Nachrichten): (1) der Käfer sah im Vergleich zu anderen
Beispielen zu wenig nach Fliege aus, die Beine reagierten nicht wie bei einer
echten Fliege; (2) in den Vergleichsbeispielen hatte das Gehirn einen sinnvollen
Fliegenkörper bekommen und diesen sichtbar so bewegt, wie es für eine Fliege
typisch ist — also nicht nur Optik, sondern die Bewegung sollte wirklich vom
simulierten Gehirn kommen.

**Runde 1** (Tripod-Gait + Flügel) war schon committet, blieb aber aus der
Standard-Vogelperspektive ein erkennbarer, aber wenig überzeugender Blob.

**Runde 2 — was tatsächlich neu ist:**

1. **Motor-Signale recherchiert statt geraten.** Live per WebSocket geprüft,
   welche `motor_rates`-Gruppen das Backend überhaupt sendet (siehe
   `sim_engine.py`, `_body_motor` kommt direkt aus den echten Connectome-
   Annotationen). Ergebnis: 8 echte Gruppen, nicht nur die 4 bisher genutzten:
   `descending_center, descending_left, descending_right, motor_antenna,
   motor_eye, motor_neck, motor_pharynx, motor_proboscis`.
   **Wichtiger Befund**: echte Bein-Motorneuronen gibt es in diesem Datensatz
   NICHT — FlyWire/hemibrain deckt nur das Gehirn ab, nicht das Bauchmark
   (VNC/MANC), das bei einer echten Fliege die einzelnen Beine ansteuert. Eine
   1:1-"jedes Bein hat sein eigenes Hirn-Signal"-Umsetzung ist mit diesen Daten
   schlicht nicht ehrlich möglich — das wurde dem User so erklärt statt es zu
   verschweigen oder vorzutäuschen.
2. **Antrieb korrigiert**: `drive` (Laufgeschwindigkeit) kam vorher aus
   `motor_proboscis`/`motor_antenna` (Fress-/Riech-Schaltkreise, keine
   Locomotion!) plus einer festen Konstante `0.9`. Jetzt: `descending_center`
   (das tatsächliche generelle Lauf-Antriebssignal, empirisch abgetastet:
   Baseline ~0.23–0.27, schwankt leicht von selbst) ist der Haupttreiber
   (`dc * 3.6`), proboscis/antenna liefern nur noch den zusätzlichen "sieht
   Zucker, wird hektisch"-Kick obendrauf.
3. **Neue echte Kopplungen** in `onMetrics()`/`loop()`:
   - `descending_left/right`-Differenz (`turnSkew`) verzerrt jetzt zusätzlich
     zur Kursänderung auch die Bein-Schwungamplitude zwischen linker/rechter
     Seite (Außenbeine treten beim Abbiegen weiter aus — echtes
     Hexapod-Lenkprinzip).
   - `motor_neck` dreht den Kopf unabhängig vom Körper leicht hin und her
     ("Umschauen").
   - `motor_pharynx` fährt einen neuen Rüssel (`this.proboscis`,
     Cylinder-Mesh) sichtbar aus, wenn der Fress-Reflex feuert.
   - `firing_rate` (`brainHeat`) beeinflusst jetzt zusätzlich Schrittfrequenz
     und einen kleinen Zufalls-Jitter der Beinamplitude, damit der Gang
     sichtbar auf Spikes reagiert statt stur zu loopen.
4. **Körper neu gebaut**: Thorax (klein, `gloss`-Material, vorne) + Abdomen
   (länglich, tapered, `glow`-Material mit dem Firing-Heat) statt einer
   einzelnen abgeflachten Kugel. Rote Facettenaugen statt weißer Punkte.
5. **Beine jetzt zweigliedrig** (Hüfte/Coxa-Femur-Pivot + Knie/Tibia-Pivot
   als Kind-Pivot), Tripod-Gait biegt jetzt sichtbar das Knie während der
   Schwungphase mit ein, nicht nur ein starrer Hüftschwung wie in Runde 1.
6. **Kamera folgt jetzt dem Käfer**: vorher fest auf den Arena-Ursprung
   gerichtet (Distanz ~21, der Käfer war oft klein/weit weg); jetzt läuft in
   `loop()` ein Delta-Follow (`camera.position` und `controls.target` werden
   um genau die Strecke verschoben, die der Käfer diesen Frame gelaufen ist),
   sodass die Nutzer-Zoom/Dreh-Einstellung erhalten bleibt, aber der Käfer
   nie aus dem Bild läuft. Start-Distanz spürbar näher (vorher (11,13,14),
   jetzt (4.2,3.4,5.2) relativ zum Käfer).

**Verifiziert** per Playwright/Chromium gegen die Live-URL: Käfer bleibt im
Bild, Beine/Knie sichtbar unterschiedlich pro Frame, Augen/Kopf/Abdomen klar
als getrennte Formen erkennbar (siehe Screenshots, an den User geschickt),
Zucker wurde während des Tests wieder gegessen, keine Konsolenfehler.

**Ehrlicher Rest-Stand**: Flügel sind aus den meisten Blickwinkeln weiterhin
kaum sichtbar (dünne PlaneGeometry, im typischen Betrachtungswinkel fast von
der Kante gesehen) — wurden nicht weiter verfolgt, da die Beine/Körperform
den größeren Unterschied gemacht haben. Halteren fehlen weiterhin.

## WICHTIG — Betriebshinweis: `ng build` deployed hier DIREKT live!
Der laufende Docker-Container `caddy-fastfly` bindet `fastfly-web/dist/fastfly-web/browser`
per Bind-Mount (kein Copy!) direkt als `/srv/fastfly` ein und läuft mit `network_mode:
host`, erreichbar unter https://minipc.ananta.de/fastfly/. Das heißt: **jeder lokale
`ng build --base-href /fastfly/` aktualisiert sofort die live erreichbare Seite**,
ganz ohne Deploy-Schritt oder Neustart. Es gab beim Testen bereits echten externen
Traffic (andere Client-IP in den systemd-Logs) — die App ist also nicht nur eine lokale
Spielwiese. Vor jedem Build-Experiment daran denken; ein kaputter Build ist sofort
live sichtbar.

## Naechste Schritte (Reihenfolge)
1. ~~Clean build~~ — erledigt, läuft grün.
2. ~~app.html: `<app-lab-view>` einhängen~~ — erledigt.
3. ~~Manueller Klicktest im Browser~~ — erledigt (Playwright/Chromium gegen die Live-URL),
   Regression gefunden + behoben, Closed-Loop (Zucker essen) bestätigt.
4. Käfer-Optik weiter verbessern (Körperform, Kamera-Default) — optional, siehe oben.
5. E2E: curl auf `/fastfly/` (200, bestätigt), `/fastfly/api/positions` (200, bestätigt,
   Shape passt jetzt), WS-Handshake — implizit über den Playwright-Test bestätigt
   ("GEHIRN AKTIV"-Chip lief durchgehend).
6. Tests: `ng test` laeuft? (wenn vorhanden), drei.js-Logik per WsService-mock verifizieren.
7. Committen (app.ts, app.html, lab-view.ts) — bisher nur lokal geändert (und damit schon
   live deployed, siehe Betriebshinweis oben), noch kein Commit dieser Session.

## Wichtige Pfade
- Backend/WS-Nachrichten: `fastfly/app_server.py` (init/state/metrics, motor_rates,
  descending_left/right/proboscis/antenna, stim: stimulus_preset/noise etc.)
- Frontend: `fastfly-web/src/app/{app,brain-view,lab-view,ws.service}.ts` + app.html/css
- Doku/Notes zu WS-Protokoll lag in den fruehessen Komponenten-Kommentaren.

## Vorsicht
- **Niemals die ganze app.ts/lab-view.ts per `write`-Tool neu schrieben (degenerierte
  Tokens!).** Nur kleinteilige Edit-Tool-Aenderungen und nach jedem Schritt Build+Diff.
- App baut nur mit `--base-href /fastfly/` (kann ohne basehref-Flag HTML-Relativpfade
  brechen).
- Bei jeder neuen standalone-Component in app.ts/lab-view.ts das `imports`-Array im
  `@Component`-Decorator prüfen — fehlt es, gibt's TS2554/NG8-Fehler, die wie
  Dateikorruption aussehen, es aber nicht sind (siehe "Status: BEHOBEN", Punkt 3).
