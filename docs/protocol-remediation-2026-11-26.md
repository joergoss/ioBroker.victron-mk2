# MK2-Protokoll- und Hardwareabnahme nach dem v0.4.8-Audit

Stand: 2026-11-26 · Code-Commit für die Hardwaretests:
`77f4a35e88e8f8ca3fcb414a2141f09581238aa3` · Referenz:
*Interfacing with VE.Bus products – MK2 Protocol 3.14* (22.06.2017).

## 1. Umfang

Die 18 Befunde des erneuten v0.4.8-Audits (#105–#122) wurden zusammen mit den
nachfolgenden unabhängigen Review-Befunden bearbeitet. Schwerpunkte:

- nachweisbare Switch-/Limitzustände und exakte Raw-Readbacks für S-Kommandos;
- 0-A-/Minimum-Unterscheidung einschließlich Cold Start und Reconnect;
- nebenwirkungsfreie Long-Winmon-Setting-Writes ohne EEPROM-Flags-Byte;
- vollständige W36-Metadaten, eindeutige Short-/Long-Behandlung und Trailer;
- W0E-, F0/F1-, F5- und LED-Dekodierung;
- Setting-Pre-reads, permanente Ablehnungen und Same-Value-Reconciliation;
- Off-Queue-Snapshots, Retry-Erhalt, Default-Metadaten sowie Serial-/DB-
  Shutdown-Cancellation.

Mehrdeutige Zustände führen bewusst zu einer Ablehnung statt zu einem
optimistischen `ack=true`. Bei W36 wird genau die byteweise nicht
unterscheidbare Short-Pair-/Long+Trailer-Form (`len=8`, Offset-Low `0x8F`)
abgelehnt und nicht gecacht; eindeutige Long-Antworten mit Trailer werden
weiterhin akzeptiert.

## 2. Lokale Verifikation

Finaler Stand vor der Dokumentation:

| Prüfung | Ergebnis |
|---|---|
| TypeScript-Tests (Mocha) | **316 bestanden, 0 fehlgeschlagen** |
| Paketvalidierung | **61 bestanden, 0 fehlgeschlagen** |
| `npm run check` / `npm run lint` / `npm run build` | bestanden |
| Adapter-Integrationstest | **1 bestanden** |
| `node --check scripts/live-mk2-write-acceptance.js` | bestanden |
| `git diff --check` | sauber |

Die Regressionstests verwenden Protokollbeispiele und zuvor reproduzierte
Fehler als unabhängige Orakel. Sie decken unter anderem fehlende/mehrdeutige
F5-Register, Raw-41 statt Raw-40, Cold-0-A ohne vorherigen Adapter-Write,
W36-Split-Frames, `0x8F` als Nutzdatenbyte, Long+Trailer, verspätete externe
LED-Blöcke, langsame Serial-Opens und blockierte DB-Writes nach Unload ab.

Ein Netzwerk-Timeout beim einmaligen Abruf der ioBroker-Schemas wurde durch
einen Retry behoben; die Paketvalidierung lief anschließend vollständig.

## 3. Hardware und Sicherheitsbedingungen

- MultiPlus 12/3000/120-16, Produkt/Firmware **1909209**;
- MK2-USB Firmware **1130136**, VE.Bus-Modus/Adresse 0;
- pi4, `/dev/ttyUSB-Serial-1`, Response-Timeout 5000 ms;
- Start ausschließlich bei Hauptzustand **80 (Bypass)**, Switch **3 (On)**;
- konfiguriertes und effektives AC-Limit **5 A**;
- **DisableCharge=true**, PowerAssist an, Ladestrom **0 A**;
- Absorption **14,20 V**, Float **13,40 V**, Bulk **120 A**;
- AC-Ausgang ohne Last, keine 230-V-Arbeiten und keine N/PE-Änderungen.

Der produktive Adapter blieb unverändert. Alle Tests liefen aus einem separaten
Build unter `/tmp/mk2-audit-v048` im ioBroker-Container. Der Adapter wurde für
exklusiven seriellen Zugriff gestoppt und durch einen Remote-Trap nach jedem
Lauf wieder gestartet. Schreibtests besitzen zusätzlich eine unabhängige
Wiederherstellung im `finally`-Block.

## 4. Read-only-Live-Matrix

Reproduktion: `scripts/live-mk2-protocol-matrix.js`.

Ergebnis auf `77f4a35`: **154 Tests, 154 bestanden, 0 fehlgeschlagen**.

Abgedeckt sind passive und aktive Versionsabfrage, drei Runden mit A, W0E,
W05/W06, W36-Skalierungen, L, F5, F0 und F1 sowie RAM-Metadaten/-Werte für IDs
0–19 und Setting-Metadaten/-Werte für IDs 0–65.

- Timeouts: **0**
- Protokollfehler: **0**
- Sync-Fehler: **0**
- Prüfsummenfehler: **0**

Die realen F5-Frames melden an den beiden bekannten Kandidatenpositionen
`0x32` und `0x77`; beide bedeuten Switch On. Damit ist auch der generische
Common-Bits-Pfad vor einer erneuten Firmwareidentifikation abgedeckt.

Bericht auf dem Testsystem: `/tmp/mk2-audit-v048-readonly.json`.

## 5. Reversible Live-Schreibabnahme

Reproduktion: `scripts/live-mk2-write-acceptance.js` mit
`MK2_VALIDATE_EEPROM_FREE=1`.

Ergebnis auf `77f4a35`: **21 erfolgreiche Schreib-/Readback-Schritte,
0 fehlgeschlagene Schritte**. Charger-only wurde weiterhin nicht aktiviert und
als einziger Schritt übersprungen.

| Gruppe | Live geprüft | Ergebnis |
|---|---|---|
| Flüchtiges Limit | `set_assist` 4 A und zurück zu 5 A | bestanden |
| Konfiguriertes Limit | `IMainsLimitAC1` 4 A und zurück zu 5 A | bestanden |
| EEPROM-freier Kompatibilitätsframe | erzwungener `prepareSettingWrite`; S mit Reserved/FlagsExt0 und **ohne EEPROM-Flags-Byte** | bestanden; ACK und anschließender Setting-Write |
| Inverter-Modus | `grid_mode=2`, Hauptzustand 40, Switch 2 | bestanden |
| Direkter Switch | Switch 2, danach Switch 3 | bestanden |
| Zero-Grid / Grid | `grid_mode=1`, danach `grid_mode=0` und Hauptzustand 80 | bestanden |
| Direktes 0 A | `set_assist(0)` mit echtem Invert-Readback | bestanden |
| Cold 0 A | nur im Prozess gelöschter Setpoint-Cache, danach `set_assist(3.1)` | Switch 3 **und Hauptzustand 80** bestanden |
| Limit-Wiederherstellung | `set_assist(5)` | bestanden |
| Same-Value-Flags | DisableCharge, WeakACInput, DisableAES, AssistEnabled, DynamicCurrentLimiter | bestanden; EEPROM-Vermeidung |
| Same-Value-Settings | IBatBulk 120 A, Absorption 14,20 V, Float 13,40 V | bestanden; EEPROM-Vermeidung |
| Abschluss | erneut `grid_mode=0` und exakter Sicherheitszustand | bestanden |

Der EEPROM-freie S-Frame hat auf dem seriellen Frame elf Bytes inklusive
Längenbyte und Checksumme. Er enthält Reserved und FlagsExt0=1, aber kein
EEPROM-Flags-Byte. Der anschließende AC1-Setting-Write wurde gelesen und
bestätigt, ohne Switch oder temporäres Limit zu verändern.

Bericht auf dem Testsystem: `/tmp/mk2-audit-v048-write.json`.

## 6. Korrigierter Zwischenfehler

Ein erster Schreiblauf zeigte bei `set_assist(0)` → positivem Limit, dass die
reale 1909209-Hardware von Switch 2 zu **Switch 3 (On)** wechselt. Die zunächst
neu eingeführte Erwartung, Switch 2 müsse erhalten bleiben, war daher falsch.
Sie wurde durch Commit `f9811ad` korrigiert und der Hardware-Fake entsprechend
angepasst. Der `finally`-Block stellte auch beim abgebrochenen Lauf 5 A/On/
DisableCharge wieder her. Erst die anschließend vollständig bestandenen Läufe
wurden als Abnahme verwendet.

Weitere unabhängige Reviews führten zu Fixes für Off-Queue-Races, späte
DB-Writes, W36 Short/Long- und Trailer-Mehrdeutigkeit, Cold-0-A, verspätete
LED-Blöcke, langsame Serial-Opens und PollLoop-Settlement. Auch der Erhalt
unverarbeiteter Power-on-Retries nach einem F5-Fehler wurde ergänzt und getestet.

## 7. Nicht getestet / bewusst nicht ausgeführt

- kein echtes Off und kein Charger-Aktivierungstest;
- kein `force_state` und kein Equalise;
- kein Umschalten der MK2-EEPROM-Flags und kein Test von Block-XMT;
- kein hardwareseitig aktivierter LED-Append-Modus (nur Receiver-/Fake-Tests);
- keine Mehrphasen-/Mehrgeräteverwaltung, Snapshots, Virtual Switch, BOL oder
  Reset-Funktionen;
- kein produktives Deployment, Release oder Merge.

## 8. Endzustand

Nach dem letzten Schreiblauf und dem automatischen Adapterstart:

- Adapter `running`;
- `state.state=80`, `switch.state=3`;
- `assist.limit=5`, `setting.IMainsLimitAC1=5`;
- `setting.flag.DisableCharge=true`, Ladestrom 0 A;
- `restoration.ok=true` im JSON-Bericht.
