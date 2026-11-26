# MK2-Protokoll- und Hardware-Abnahme, 2026-11-26

Stand: Release-Kandidat 0.4.8 auf Basis 0.4.7, einschließlich der Fixes aus
Issues #97 bis #103. Referenz: *Interfacing with VE.Bus products – MK2 Protocol
3.14* (22.06.2017).

## 1. Ergebnis und Abgrenzung

Die produktiv exponierten Lese- und Steuerpfade wurden erneut gegen das
Handbuch, Unit-/Receiver-Tests und die reale Ein-Geräte-Anlage geprüft. Dabei
wurden weitere Fehler gefunden und korrigiert.

**Das ist keine Aussage, dass jede Funktion des 34-seitigen Handbuchs
implementiert oder an realer Hardware ausgeführt wurde.** Mehrphasenbetrieb,
Snapshots, Virtual Switch, BOL, Reset und weitere Sonderfunktionen sind
bewusst außer Scope. Charger-only, Off und force_state wurden aus
Sicherheitsgründen nicht als positiver Live-Test durchgeführt.

Hardware und Sicherheitsrandbedingungen:

- MultiPlus 12/3000/120-16, Produkt 1909, Firmware **1909209**;
- MK2-USB Firmware **1130136**, VE.Bus-Modus/Adresse 0;
- pi4, `/dev/ttyUSB-Serial-1`, Pollintervall 5 s, Response-Timeout 5000 ms;
- AC-Ausgang ohne Last, Netzeingang und Batterie angeschlossen;
- konfiguriertes und flüchtiges AC-Limit **5 A**;
- **DisableCharge=true während sämtlicher Tests**, Ladestrom 0 A;
- keine 230-V-Arbeiten und keine N/PE-Änderungen.

## 2. Validierungsübersicht

| Ebene | Ergebnis |
|---|---|
| TypeScript-Tests (Mocha) | **279 bestanden, 0 fehlgeschlagen** |
| Paketvalidierung | **61 bestanden, 0 fehlgeschlagen** |
| `npm run check`, `npm run lint`, `npm run build` | bestanden |
| Unabhängige statische Protokollreview | durchgeführt; Befunde in #101–#103 bearbeitet |
| Read-only-Live-Matrix | **154/154 bestanden** |
| Reversible Live-Schreib-/Readback-Schritte | **20 bestanden, 0 fehlgeschlagen** |
| Live übersprungen | **1: Charger-only bei DisableCharge=true** |
| Transportfehler in der finalen Matrix | **0 Timeouts, 0 Protokoll-, 0 Sync-, 0 Prüfsummenfehler** |

Die Tests und Live-Matrix liefen mit demselben Entwicklungsbuild. Die installierte
Version 0.4.7 wurde dafür nicht überschrieben; der Build lag temporär unter
`/tmp/mk2-dev-final/build`. Der Adapter wurde für die exklusive serielle Nutzung
gestoppt und nach jedem Lauf automatisch wieder gestartet.

## 3. Read-only-Live-Matrix

Reproduktion: `scripts/live-mk2-protocol-matrix.js`. Das Skript sendet keine
S-Kommandos und keine Setting-, RAM-, Reset- oder Zustands-Schreibzugriffe.

Abgedeckt:

- passive Synchronisierung und aktive Versionsabfrage `V`;
- drei Runden mit `A`, `W0E`, `W05/W06`, Skalierungen über `W36`, `L`, `F5`,
  `F0` und `F1`;
- RAM-Metadaten für IDs 0–19 und `W30` für jede als unterstützt gemeldete ID;
- Setting-Metadaten für IDs 0–65 und `W31` für jede als unterstützt gemeldete ID;
- Rohframes, Antwortzeiten und Fehlerzähler vor/nach jedem Schritt.

Ergebnis: **154 Tests, 154 bestanden**. Die zuvor fehlerhaften RAM-IDs 10, 17,
18 und 19 lieferten jeweils den exakten value-free Frame `03ff578e19` und
wurden korrekt als `supported=false` behandelt. Es folgte für diese IDs kein
W30-Read.

## 4. Reversible Live-Schreibabnahme

Reproduktion: `scripts/live-mk2-write-acceptance.js`. Das Skript verweigert den
Start bei jedem abweichenden Sicherheitszustand und stellt im `finally`-Block
DisableCharge, konfiguriertes Limit, Switch On und flüchtiges Limit unabhängig
voneinander wieder her.

| Gruppe | Live geprüft | Ergebnis |
|---|---|---|
| Flüchtiges Limit | `set_assist` 4 A und zurück zu 5 A | bestanden |
| Konfiguriertes Limit | `IMainsLimitAC1` 4 A und zurück zu 5 A | bestanden, Readback |
| Inverter-Modus | `grid_mode=2`, Hauptzustand 40, Switch 2 | bestanden |
| Direkter Switch | `switch_state=2` in Inverter, danach `switch_state=3` | bestanden |
| Zero-Grid | `grid_mode=1`, 0-A-Setpoint, Hauptzustand 40 | bestanden |
| Grid-Wiederherstellung | `grid_mode=0`, Hauptzustand 80, Switch 3, 5 A | bestanden |
| Direktes 0 A | `set_assist(0)` mit echtem Invert-Readback | bestanden |
| Limit-Wiederherstellung | `set_assist(5)` | bestanden |
| Same-Value-Flags | DisableCharge, WeakACInput, DisableAES, AssistEnabled, DynamicCurrentLimiter | bestanden; EEPROM-Vermeidung |
| Same-Value-Settings | IBatBulk 120 A, Absorption 14,20 V, Float 13,40 V | bestanden; EEPROM-Vermeidung |
| Abschluss | erneut `grid_mode=0` und exakter Sicherheitszustand | bestanden |

Insgesamt **20 erfolgreiche Schreib-/Readback-Schritte**. Ein Grid-Übergang
benötigte rund 10 s bis zum bestätigten Hauptzustand 80; die Bestätigung
erfolgte nicht mehr allein anhand des früheren Panel-Registers.

### Charger-only: negativer Befund, kein positiver Test

Ein separater Versuch mit `switch_state=1` bei weiterhin zwingendem
`DisableCharge=true` wurde vom MultiPlus nicht als Charger-only übernommen. Der
Adapter meldete nach dem Readback korrekt einen Fehler statt eines falschen
Erfolgs. Der Charger wurde **nicht** aktiviert, um diesen Test positiv
abzuschließen. Charger-only gilt daher hier als unit-getestet, aber **nicht als
erfolgreich live getestet**.

## 5. In dieser Runde behobene Befunde

| Issue | Befund und Korrektur |
|---|---|
| #97 | Exakte value-free 0x8E-RAM-Antworten bedeuten „unsupported“; kein anschließender W30-Read. |
| #98 | W0E und F5 werden nach S gemeinsam gelesen; begrenzte Wartezeit statt Readback zum falschen Zeitpunkt; kein wiederholtes S. |
| #99 | Übereinstimmende plausible F5-Kandidaten übernehmen ihren gemeinsamen neuen Switch-State statt eines veralteten Cache-Werts. |
| #100 | Direktes `switch_state(2)` verwendet das erforderliche 0-A-Setpoint statt `0xFFFF`; On stellt das konfigurierte/aktuelle positive Limit wieder her. Auch vorbereitende Long-Winmon-Setting-Writes bewahren einen bestätigten Zero-Grid-Setpoint; ein mehrdeutiges Minimum wird ohne bekannten Setpoint sicher abgelehnt. |
| #101 | Alle 0-A-Pfade prüfen PowerAssist und den echten Invert-Hauptzustand; Grid verlangt 7/8/9. Switch-, Main- und verzögertes Limit-Readback werden gemeinsam bestätigt, auch bei direkten Switch-Writes. Fehlendes/mehrdeutiges Readback ist kein Erfolg. Verlorene S-ACKs und Post-Write-Fehler werden nicht automatisch wiederholt. Grid-Readback bleibt unter der Queue-TTL; positive Werte unter 0,05 A werden nicht zu 0 A gerundet. |
| #102 | AC-/DC-Werte hängen nur von ihrer eigenen Skalierung ab. DMC-Limitbytes werden ignoriert. Bei mehrdeutigem F5-Register bleiben unbewiesene Detailbits null. Die 0x8E-Ausnahme prüft die exakte Framelänge. |
| #103 | `force_state` prüft Firmware/Unsupported-Antworten und den tatsächlichen Ziel-Substate ohne erneutes Schreiben. Die Control-Reconciliation bildet 7/6/3 korrekt auf 1/2/3 ab. **Nur unit-getestet.** |

## 6. Nur unit-getestet oder bewusst nicht live ausgeführt

| Funktion | Status |
|---|---|
| `force_state` Equalise/Absorption/Float | Unit-getestet inklusive verzögerter Antwort und Fehlerfällen; nicht live, Charger bleibt aus. Bekannte Firmware < Revision 400 wird abgelehnt. |
| `switch_state=1` Charger-only | Unit-getestet; Live-Versuch bei DisableCharge=true nicht vom Gerät übernommen; keine Charger-Aktivierung für einen Positivtest. |
| `switch_state=4` Off | Kein Live-Test in dieser Abnahme. Post-Write-Readbackfehler sind so klassifiziert, dass die Queue kein erneutes Off sendet. |
| DMC-dedicated, fehlende Skalierungen, malformed/truncated Frames | Gezielte Unit-/Receiver-Tests; diese Hardware lieferte im Normallauf keine solchen Fehlerbilder. |
| Tatsächliche Flag-Änderungen | In diesem Lauf nur Same-Value-/EEPROM-Vermeidung; Encoding und echte Änderungen sind unit-getestet. Keine unnötigen EEPROM-Schreibzugriffe. |

## 7. Bewusst nicht implementiert / außer Scope

Diese Punkte sind **nicht als bestanden** zu verstehen:

- AC-Info F2/F3/F4 und Mehrphasen-/Mehrgeräteverwaltung;
- RAM-Snapshots F6/W38 und optimierte Mehrfach-RAM-Reads;
- Virtual-Switch-Settings und nicht exponierte RAM-Telemetrie als eigene States;
- S Variante 1, X/Y/Z-Rotation, Panel-Forwarding und automatischer Panel-State;
- nicht validierte LED-Append-Layouts (werden sicher abgelehnt);
- MK2-/VE.Bus-Reset R/F8, BOL F9, direkte RAM-Schreibzugriffe W32 und WriteViaID W37;
- MK3-Hardware (gemeinsames Protokoll, aber nicht Teil dieser Hardwareabnahme).

## 8. Endzustand nach den Tests

Nach der finalen Matrix und dem automatischen Adapterstart:

- Adapter `alive=true`, `info.connection=true`;
- `state.state=80` (Bypass), `switch.state=3` (On);
- `assist.limit=5`, `setting.IMainsLimitAC1=5`;
- `setting.flag.DisableCharge=true`, Ladestrom 0 A;
- Timeouts, Protokoll-, Sync- und Prüfsummenfehler jeweils 0;
- `diag.last_error` leer.
