# Changelog

Nutzer-sichtbare Release Notes (Update-Dialog & GitHub Release).

Schreibregeln & Struktur: `docs/RELEASE.md` → Abschnitt **Release-Notes**.
Neue Einträge unter **`[Unreleased]`**; `npm run release` versioniert sie.
- **Beta:** Snapshot unter `## [x.y.z-beta.N]` — `[Unreleased]` bleibt erhalten.
- **Stable:** `[Unreleased]` wird nach `## [x.y.z]` verschoben.
Patch-Stable ohne Unreleased-Text: Notes der Vorgängerversion werden übernommen.

## [Unreleased]

### Neu

- Vorgänge ohne geplanten Server-Upload: Status „Nur lokal“ in der Liste — auf einen Blick erkennbar
- Unter Vorgänge: lokal erstellte Vorgänge später mit „Auf Server hochladen“ auf den Server kopieren
- Einstellungen → System → Danger Zone: lokale Vorgänge- und Backup-Ordner leeren — Einträge unter Vorgänge bleiben erhalten, Speicherplatz wird freigegeben

### Verbessert

- Mac: Nach einem App-Update Hinweis, wenn die Server-Verbindung fehlschlägt — Neustart des Mac behebt das oft (macOS blockiert manchmal Netzwerk nach Updates)
- Unter Vorgänge: Liste übersichtlicher — Status-Spalte breiter, volle Erstellzeit im Detail statt abgeschnitten in der Tabelle
- Unter Vorgänge: einheitliche Status-Chips (gleiche Höhe, klare Icons)
- Unter Vorgänge: klare Bezeichnungen für Server-Kopie und Cloud-Upload — auf einen Blick erkennbar, welcher Schritt gerade läuft
- Unter Vorgänge: Tooltips und Detail-Stepper erklären die einzelnen Schritte (Server → Freigabe → Cloud)
- Cloud-Status aktualisiert sich im Hintergrund — auch wenn der Vorgänge-Dialog geschlossen ist
- Nach erfolgreichem Server-Upload wird der Cloud-Status automatisch nachgezogen
- Veralteter Cloud-Status: Hinweis und Button „Status aktualisieren“ im Detail
- Ausgabeordner fehlt oder wurde absichtlich entfernt: eigener Status („Ordner fehlt“ / „Lokal entfernt“) statt hängendem Upload
- Unter Vorgänge → Medien: Datumsspalten kompakter und lesbarer
- Unter Vorgänge: Tooltips am Nachreichen-Button erklären, warum Nachreichen gerade nicht möglich ist (lokal, Upload läuft, Server offline, Upload deaktiviert)
- Nach App-Update: Fenster kommt automatisch wieder in den Vordergrund
- Video-Clip-Liste zeigt mehr Einträge ohne Scrollen (ca. 12 Zeilen)

### Behoben

- Update-Hinweis erscheint erst, wenn das Release vollständig bereitsteht — nicht mehr zu früh, wenn die Installationsdateien noch fehlen
- Nachreichen in die Cloud war bei deaktiviertem Upload oder ohne Serververbindung irreführend — Button ist gesperrt mit erklärendem Tooltip
- Cloud-Status blieb nach dem Upload auf „wartet“ oder „bestätigt“ hängen — aktualisiert sich jetzt ohne App-Neustart
- Nach Absturz während eines Uploads blieb der Status dauerhaft auf „Wird kopiert…“ — Nachholen ist wieder möglich




## [0.4.0-beta.4] - 2026-08-28

### Neu

- Vorgänge ohne geplanten Server-Upload: Status „Nur lokal“ in der Liste — auf einen Blick erkennbar
- Unter Vorgänge: lokal erstellte Vorgänge später mit „Auf Server hochladen“ auf den Server kopieren
- Einstellungen → System → Danger Zone: lokale Vorgänge- und Backup-Ordner leeren — Einträge unter Vorgänge bleiben erhalten, Speicherplatz wird freigegeben

### Verbessert

- Unter Vorgänge: Liste übersichtlicher — Status-Spalte breiter, volle Erstellzeit im Detail statt abgeschnitten in der Tabelle
- Unter Vorgänge: einheitliche Status-Chips (gleiche Höhe, klare Icons)
- Unter Vorgänge: klare Bezeichnungen für Server-Kopie und Cloud-Upload — auf einen Blick erkennbar, welcher Schritt gerade läuft
- Unter Vorgänge: Tooltips und Detail-Stepper erklären die einzelnen Schritte (Server → Freigabe → Cloud)
- Cloud-Status aktualisiert sich im Hintergrund — auch wenn der Vorgänge-Dialog geschlossen ist
- Nach erfolgreichem Server-Upload wird der Cloud-Status automatisch nachgezogen
- Veralteter Cloud-Status: Hinweis und Button „Status aktualisieren“ im Detail
- Ausgabeordner fehlt oder wurde absichtlich entfernt: eigener Status („Ordner fehlt“ / „Lokal entfernt“) statt hängendem Upload
- Unter Vorgänge → Medien: Datumsspalten kompakter und lesbarer
- Unter Vorgänge: Tooltips am Nachreichen-Button erklären, warum Nachreichen gerade nicht möglich ist (lokal, Upload läuft, Server offline, Upload deaktiviert)
- Nach App-Update: Fenster kommt automatisch wieder in den Vordergrund
- Video-Clip-Liste zeigt mehr Einträge ohne Scrollen (ca. 12 Zeilen)

### Behoben

- Nachreichen in die Cloud war bei deaktiviertem Upload oder ohne Serververbindung irreführend — Button ist gesperrt mit erklärendem Tooltip
- Cloud-Status blieb nach dem Upload auf „wartet“ oder „bestätigt“ hängen — aktualisiert sich jetzt ohne App-Neustart
- Nach Absturz während eines Uploads blieb der Status dauerhaft auf „Wird kopiert…“ — Nachholen ist wieder möglich

## [0.4.0-beta.3] - 2026-08-28

### Neu

- Vorgänge ohne geplanten Server-Upload: Status „Nur lokal“ in der Liste — auf einen Blick erkennbar
- Unter Vorgänge: lokal erstellte Vorgänge später mit „Auf Server hochladen“ auf den Server kopieren
- Einstellungen → System → Danger Zone: lokale Vorgänge- und Backup-Ordner leeren — Einträge unter Vorgänge bleiben erhalten, Speicherplatz wird freigegeben

### Verbessert

- Unter Vorgänge: Liste übersichtlicher — Status-Spalte breiter, volle Erstellzeit im Detail statt abgeschnitten in der Tabelle
- Unter Vorgänge: einheitliche Status-Chips (gleiche Höhe, klare Icons)
- Unter Vorgänge: klare Bezeichnungen für Server-Kopie und Cloud-Upload — auf einen Blick erkennbar, welcher Schritt gerade läuft
- Unter Vorgänge: Tooltips und Detail-Stepper erklären die einzelnen Schritte (Server → Freigabe → Cloud)
- Cloud-Status aktualisiert sich im Hintergrund — auch wenn der Vorgänge-Dialog geschlossen ist
- Nach erfolgreichem Server-Upload wird der Cloud-Status automatisch nachgezogen
- Veralteter Cloud-Status: Hinweis und Button „Status aktualisieren“ im Detail
- Ausgabeordner fehlt oder wurde absichtlich entfernt: eigener Status („Ordner fehlt“ / „Lokal entfernt“) statt hängendem Upload
- Unter Vorgänge → Medien: Datumsspalten kompakter und lesbarer
- Unter Vorgänge: Tooltips am Nachreichen-Button erklären, warum Nachreichen gerade nicht möglich ist (lokal, Upload läuft, Server offline, Upload deaktiviert)
- Nach App-Update: Fenster kommt automatisch wieder in den Vordergrund
- Video-Clip-Liste zeigt mehr Einträge ohne Scrollen (ca. 12 Zeilen)

### Behoben

- Nachreichen in die Cloud war bei deaktiviertem Upload oder ohne Serververbindung irreführend — Button ist gesperrt mit erklärendem Tooltip
- Cloud-Status blieb nach dem Upload auf „wartet“ oder „bestätigt“ hängen — aktualisiert sich jetzt ohne App-Neustart
- Nach Absturz während eines Uploads blieb der Status dauerhaft auf „Wird kopiert…“ — Nachholen ist wieder möglich

## [0.4.0-beta.2] - 2026-08-28

### Neu

- Vorgänge ohne geplanten Server-Upload: Status „Nur lokal“ in der Liste — auf einen Blick erkennbar
- Unter Vorgänge: lokal erstellte Vorgänge später mit „Auf Server hochladen“ auf den Server kopieren

### Verbessert

- Unter Vorgänge: Liste übersichtlicher — Status-Spalte breiter, volle Erstellzeit im Detail statt abgeschnitten in der Tabelle
- Unter Vorgänge: einheitliche Status-Chips (gleiche Höhe, klare Icons)
- Unter Vorgänge: klare Bezeichnungen für Server-Kopie und Cloud-Upload — auf einen Blick erkennbar, welcher Schritt gerade läuft
- Unter Vorgänge: Tooltips und Detail-Stepper erklären die einzelnen Schritte (Server → Freigabe → Cloud)
- Cloud-Status aktualisiert sich im Hintergrund — auch wenn der Vorgänge-Dialog geschlossen ist
- Nach erfolgreichem Server-Upload wird der Cloud-Status automatisch nachgezogen
- Veralteter Cloud-Status: Hinweis und Button „Status aktualisieren“ im Detail
- Ausgabeordner fehlt oder wurde absichtlich entfernt: eigener Status („Ordner fehlt“ / „Lokal entfernt“) statt hängendem Upload
- Unter Vorgänge → Medien: Datumsspalten kompakter und lesbarer
- Unter Vorgänge: Tooltips am Nachreichen-Button erklären, warum Nachreichen gerade nicht möglich ist (lokal, Upload läuft, Server offline, Upload deaktiviert)
- Nach App-Update: Fenster kommt automatisch wieder in den Vordergrund

### Behoben

- Nachreichen in die Cloud war bei deaktiviertem Upload oder ohne Serververbindung irreführend — Button ist gesperrt mit erklärendem Tooltip
- Cloud-Status blieb nach dem Upload auf „wartet“ oder „bestätigt“ hängen — aktualisiert sich jetzt ohne App-Neustart
- Nach Absturz während eines Uploads blieb der Status dauerhaft auf „Wird kopiert…“ — Nachholen ist wieder möglich

## [0.4.0-beta.1] - 2026-08-28

### Verbessert

- Unter Vorgänge: Liste übersichtlicher — Status-Spalte breiter, volle Erstellzeit im Detail statt abgeschnitten in der Tabelle
- Unter Vorgänge: einheitliche Status-Chips (gleiche Höhe, klare Icons)
- Unter Vorgänge: klare Bezeichnungen für Server-Kopie und Cloud-Upload — auf einen Blick erkennbar, welcher Schritt gerade läuft
- Unter Vorgänge: Tooltips und Detail-Stepper erklären die einzelnen Schritte (Server → Freigabe → Cloud)
- Cloud-Status aktualisiert sich im Hintergrund — auch wenn der Vorgänge-Dialog geschlossen ist
- Nach erfolgreichem Server-Upload wird der Cloud-Status automatisch nachgezogen
- Veralteter Cloud-Status: Hinweis und Button „Status aktualisieren“ im Detail
- Ausgabeordner fehlt oder wurde absichtlich entfernt: eigener Status („Ordner fehlt“ / „Lokal entfernt“) statt hängendem Upload
- Unter Vorgänge → Medien: Datumsspalten kompakter und lesbarer

### Behoben

- Cloud-Status blieb nach dem Upload auf „wartet“ oder „bestätigt“ hängen — aktualisiert sich jetzt ohne App-Neustart
- Nach Absturz während eines Uploads blieb der Status dauerhaft auf „Wird kopiert…“ — Nachholen ist wieder möglich

## [0.3.9] - 2026-08-28

### Neu

- Vorgang lokal erstellen, wenn der Server nicht erreichbar ist — Upload bleibt ausstehend und kann später nachgeholt werden
- Unter Vorgänge: ausstehende Uploads einzeln oder gesammelt nachholen
- Badge in der Kopfzeile bei ausstehenden Uploads; Hinweis, wenn der Server wieder erreichbar ist
- Fehlende Dateien beim Upload-Nachholen: Ordner öffnen oder nur die vorhandenen Medien hochladen
- Zusätzliche Dateien im Ausgabeordner: mit hochladen (Lieferliste wird angepasst) oder überschüssige Dateien vor dem Upload löschen
- Gesammeltes Nachholen: bereite Vorgänge zuerst, bei Problemen nacheinander mit Rückfrage
- Einrichtungsassistent und Einstellungen: Upload- und Backup-Pfade von der Buchungssuche vorschlagen und übernehmen — Hinweis, wenn der eingestellte Pfad abweicht
- Server-Profile: optionale Backup-URL als zweites SMB-Ziel (eigene Zugangsdaten möglich)
- SD-Karten zusätzlich per SMB auf den Server sichern — Ziel kommt aus der Backup-URL des aktiven Server-Profils
- USB-Action-Cams: Import nur für freigegebene Modelle; unter Einstellungen → SD die Import-Methode wählbar
- Nach „Vorgang erstellen“ sofort weiterarbeiten — Upload läuft im Hintergrund (Fortschritt in der Leiste, weitere Uploads in der Warteschlange)
- Beim Beenden mit laufendem Upload: Rückfrage, ob der Upload abgebrochen werden soll
- Server-Backup in der Kopfzeile: Klick öffnet Details (Fortschritt, Geschwindigkeit) und Abbruch nur für das aktuelle Backup

### Verbessert

- Kopfzeile passt sich schmaleren Fenstern an: Titel wird zu „ATS“, Encoder-Anzeige und Version weichen schrittweise — bis nur noch das Logo sichtbar ist (ohne abgeschnittene …)
- Server-Status aktualisiert sich im Hintergrund — Verbindungsprobleme fallen schneller auf
- Bezeichnungen vereinheitlicht: der Bereich heißt durchgängig „Vorgänge“ (statt teils „Historie“)
- Update-Dialog: Wechsel von Beta auf finale Version und Beta-Hinweise in den Einstellungen klarer formuliert
- DJI Foto-Timelapse: Begleitvideos landen nicht mehr im Backup und werden beim Leeren der Karte mit entfernt
- Vorschaubilder in der SD-Dateiauswahl werden zuverlässiger angezeigt
- Einrichtungsassistent: nach Übernahme der Pfade von der Buchungssuche direkt die Server-Profile prüfen und anpassen
- Einrichtungsassistent (Upload): Checkbox „Backup auf Server sichern“ unter dem Upload-Schalter
- Unter SD: Server-Backup-URL nur Anzeige — Bearbeitung über Einstellungen → Server am Profil
- Pfad-Vorschläge und Abweichungs-Hinweise: Primär und Backup übersichtlicher — aktueller und vorgeschlagener Pfad nebeneinander
- Einrichtungsassistent: einheitliche Bezeichnung „Server“ statt „AMS“ bei Suche und Verbindung
- Einrichtungsassistent: „Ich bin“ ist Pflicht; mit aktivem Upload muss vor dem Fortfahren eine Server-Verbindung stehen — der Verbinden-Button wird hervorgehoben
- Crew-Liste: neue Standard-Namen aus App-Updates erscheinen automatisch — selbst entfernte Namen bleiben weg
- Manuell abgebrochene Uploads zählen nicht mehr als ausstehend (kein Badge, kein Sammel-Nachholen) — unter Vorgänge weiterhin nachholbar
- Upload-Leiste: Warteschlange aufklappbar — wartende Vorgänge mit Gast und Crew sichtbar
- Upload-Leiste: laufender Upload zeigt Gast und Crew (wie die Warteschlange)
- Unter Vorgänge: Upload-Status kürzer und mit Tooltip (Ausstehend, Abgebrochen, Fehlgeschlagen, Upload)
- Unter Vorgänge: Status-Chips besser lesbar
- Upload-Abbruch räumt unvollständige Server-Ordner zuverlässiger auf — auch Reste nach Absturz beim nächsten Start

## [0.3.9-beta.5] - 2026-08-27

### Neu

- Vorgang lokal erstellen, wenn der Server nicht erreichbar ist — Upload bleibt ausstehend und kann später nachgeholt werden
- Unter Vorgänge: ausstehende Uploads einzeln oder gesammelt nachholen
- Badge in der Kopfzeile bei ausstehenden Uploads; Hinweis, wenn der Server wieder erreichbar ist
- Fehlende Dateien beim Upload-Nachholen: Ordner öffnen oder nur die vorhandenen Medien hochladen
- Zusätzliche Dateien im Ausgabeordner: mit hochladen (Lieferliste wird angepasst) oder überschüssige Dateien vor dem Upload löschen
- Gesammeltes Nachholen: bereite Vorgänge zuerst, bei Problemen nacheinander mit Rückfrage
- Einrichtungsassistent und Einstellungen: Upload- und Backup-Pfade von der Buchungssuche vorschlagen und übernehmen — Hinweis, wenn der eingestellte Pfad abweicht
- Server-Profile: optionale Backup-URL als zweites SMB-Ziel (eigene Zugangsdaten möglich)
- SD-Karten zusätzlich per SMB auf den Server sichern — Ziel kommt aus der Backup-URL des aktiven Server-Profils
- USB-Action-Cams: Import nur für freigegebene Modelle; unter Einstellungen → SD die Import-Methode wählbar
- Nach „Vorgang erstellen“ sofort weiterarbeiten — Upload läuft im Hintergrund (Fortschritt in der Leiste, weitere Uploads in der Warteschlange)
- Beim Beenden mit laufendem Upload: Rückfrage, ob der Upload abgebrochen werden soll
- Server-Backup in der Kopfzeile: Klick öffnet Details (Fortschritt, Geschwindigkeit) und Abbruch nur für das aktuelle Backup

### Verbessert

- Kopfzeile passt sich schmaleren Fenstern an: Titel wird zu „ATS“, Encoder-Anzeige und Version weichen schrittweise — bis nur noch das Logo sichtbar ist (ohne abgeschnittene …)
- Server-Status aktualisiert sich im Hintergrund — Verbindungsprobleme fallen schneller auf
- Bezeichnungen vereinheitlicht: der Bereich heißt durchgängig „Vorgänge“ (statt teils „Historie“)
- Update-Dialog: Wechsel von Beta auf finale Version und Beta-Hinweise in den Einstellungen klarer formuliert
- DJI Foto-Timelapse: Begleitvideos landen nicht mehr im Backup und werden beim Leeren der Karte mit entfernt
- Vorschaubilder in der SD-Dateiauswahl werden zuverlässiger angezeigt
- Einrichtungsassistent: nach Übernahme der Pfade von der Buchungssuche direkt die Server-Profile prüfen und anpassen
- Einrichtungsassistent (Upload): Checkbox „Backup auf Server sichern“ unter dem Upload-Schalter
- Unter SD: Server-Backup-URL nur Anzeige — Bearbeitung über Einstellungen → Server am Profil
- Pfad-Vorschläge und Abweichungs-Hinweise: Primär und Backup übersichtlicher — aktueller und vorgeschlagener Pfad nebeneinander
- Einrichtungsassistent: einheitliche Bezeichnung „Server“ statt „AMS“ bei Suche und Verbindung
- Einrichtungsassistent: „Ich bin“ ist Pflicht; mit aktivem Upload muss vor dem Fortfahren eine Server-Verbindung stehen — der Verbinden-Button wird hervorgehoben
- Crew-Liste: neue Standard-Namen aus App-Updates erscheinen automatisch — selbst entfernte Namen bleiben weg
- Manuell abgebrochene Uploads zählen nicht mehr als ausstehend (kein Badge, kein Sammel-Nachholen) — unter Vorgänge weiterhin nachholbar
- Upload-Leiste: Warteschlange aufklappbar — wartende Vorgänge mit Gast und Crew sichtbar
- Unter Vorgänge: Upload-Status kürzer und mit Tooltip (Ausstehend, Abgebrochen, Fehlgeschlagen, Upload)
- Upload-Abbruch räumt unvollständige Server-Ordner zuverlässiger auf

## [0.3.9-beta.4] - 2026-08-27

### Neu

- Vorgang lokal erstellen, wenn der Server nicht erreichbar ist — Upload bleibt ausstehend und kann später nachgeholt werden
- Unter Vorgänge: ausstehende Uploads einzeln oder gesammelt nachholen
- Badge in der Kopfzeile bei ausstehenden Uploads; Hinweis, wenn der Server wieder erreichbar ist
- Fehlende Dateien beim Upload-Nachholen: Ordner öffnen oder nur die vorhandenen Medien hochladen
- Zusätzliche Dateien im Ausgabeordner: mit hochladen (Lieferliste wird angepasst) oder überschüssige Dateien vor dem Upload löschen
- Gesammeltes Nachholen: bereite Vorgänge zuerst, bei Problemen nacheinander mit Rückfrage
- Einrichtungsassistent und Einstellungen: Upload- und Backup-Pfade von der Buchungssuche vorschlagen und übernehmen — Hinweis, wenn der eingestellte Pfad abweicht
- Server-Profile: optionale Backup-URL als zweites SMB-Ziel (eigene Zugangsdaten möglich)
- SD-Karten zusätzlich per SMB auf den Server sichern — Ziel kommt aus der Backup-URL des aktiven Server-Profils
- USB-Action-Cams: Import nur für freigegebene Modelle; unter Einstellungen → SD die Import-Methode wählbar
- Nach „Vorgang erstellen“ sofort weiterarbeiten — Upload läuft im Hintergrund (Fortschritt in der Leiste, weitere Uploads in der Warteschlange)
- Beim Beenden mit laufendem Upload: Rückfrage, ob der Upload abgebrochen werden soll
- Server-Backup in der Kopfzeile: Klick öffnet Details (Fortschritt, Geschwindigkeit) und Abbruch nur für das aktuelle Backup

### Verbessert

- Kopfzeile passt sich schmaleren Fenstern an: Titel wird zu „ATS“, Encoder-Anzeige und Version weichen schrittweise — bis nur noch das Logo sichtbar ist (ohne abgeschnittene …)
- Server-Status aktualisiert sich im Hintergrund — Verbindungsprobleme fallen schneller auf
- Bezeichnungen vereinheitlicht: der Bereich heißt durchgängig „Vorgänge“ (statt teils „Historie“)
- Update-Dialog: Wechsel von Beta auf finale Version und Beta-Hinweise in den Einstellungen klarer formuliert
- DJI Foto-Timelapse: Begleitvideos landen nicht mehr im Backup und werden beim Leeren der Karte mit entfernt
- Vorschaubilder in der SD-Dateiauswahl werden zuverlässiger angezeigt
- Einrichtungsassistent: nach Übernahme der Pfade von der Buchungssuche direkt die Server-Profile prüfen und anpassen
- Einrichtungsassistent (Upload): Checkbox „Backup auf Server sichern“ unter dem Upload-Schalter
- Unter SD: Server-Backup-URL nur Anzeige — Bearbeitung über Einstellungen → Server am Profil
- Pfad-Vorschläge und Abweichungs-Hinweise: Primär und Backup übersichtlicher — aktueller und vorgeschlagener Pfad nebeneinander
- Einrichtungsassistent: einheitliche Bezeichnung „Server“ statt „AMS“ bei Suche und Verbindung
- Einrichtungsassistent: „Ich bin“ ist Pflicht; mit aktivem Upload muss vor dem Fortfahren eine Server-Verbindung stehen — der Verbinden-Button wird hervorgehoben
- Crew-Liste: neue Standard-Namen aus App-Updates erscheinen automatisch — selbst entfernte Namen bleiben weg
- Manuell abgebrochene Uploads zählen nicht mehr als ausstehend (kein Badge, kein Sammel-Nachholen) — unter Vorgänge weiterhin nachholbar

## [0.3.9-beta.3] - 2026-08-27

### Neu

- Vorgang lokal erstellen, wenn der Server nicht erreichbar ist — Upload bleibt ausstehend und kann später nachgeholt werden
- Unter Vorgänge: ausstehende Uploads einzeln oder gesammelt nachholen
- Badge in der Kopfzeile bei ausstehenden Uploads; Hinweis, wenn der Server wieder erreichbar ist
- Fehlende Dateien beim Upload-Nachholen: Ordner öffnen oder nur die vorhandenen Medien hochladen
- Zusätzliche Dateien im Ausgabeordner: mit hochladen (Lieferliste wird angepasst) oder überschüssige Dateien vor dem Upload löschen
- Gesammeltes Nachholen: bereite Vorgänge zuerst, bei Problemen nacheinander mit Rückfrage
- Einrichtungsassistent und Einstellungen: Upload- und Backup-Pfade von der Buchungssuche vorschlagen und übernehmen — Hinweis, wenn der eingestellte Pfad abweicht
- Server-Profile: optionale Backup-URL als zweites SMB-Ziel (eigene Zugangsdaten möglich)
- SD-Karten zusätzlich per SMB auf den Server sichern — Ziel kommt aus der Backup-URL des aktiven Server-Profils
- USB-Action-Cams: Import nur für freigegebene Modelle; unter Einstellungen → SD die Import-Methode wählbar

### Verbessert

- Kopfzeile passt sich schmaleren Fenstern an: Titel wird zu „ATS“, Encoder-Anzeige und Version weichen schrittweise — bis nur noch das Logo sichtbar ist (ohne abgeschnittene …)
- Server-Status aktualisiert sich im Hintergrund — Verbindungsprobleme fallen schneller auf
- Bezeichnungen vereinheitlicht: der Bereich heißt durchgängig „Vorgänge“ (statt teils „Historie“)
- Update-Dialog: Wechsel von Beta auf finale Version und Beta-Hinweise in den Einstellungen klarer formuliert
- DJI Foto-Timelapse: Begleitvideos landen nicht mehr im Backup und werden beim Leeren der Karte mit entfernt
- Vorschaubilder in der SD-Dateiauswahl werden zuverlässiger angezeigt
- Einrichtungsassistent: nach Übernahme der Pfade von der Buchungssuche direkt die Server-Profile prüfen und anpassen
- Einrichtungsassistent (Upload): Checkbox „Backup auf Server sichern“ unter dem Upload-Schalter
- Unter SD: Server-Backup-URL nur Anzeige — Bearbeitung über Einstellungen → Server am Profil
- Pfad-Vorschläge und Abweichungs-Hinweise: Primär und Backup übersichtlicher — aktueller und vorgeschlagener Pfad nebeneinander
- Einrichtungsassistent: einheitliche Bezeichnung „Server“ statt „AMS“ bei Suche und Verbindung
- Einrichtungsassistent: „Ich bin“ ist Pflicht; mit aktivem Upload muss vor dem Fortfahren eine Server-Verbindung stehen — der Verbinden-Button wird hervorgehoben

## [0.3.9-beta.2] - 2026-08-26

### Neu

- Vorgang lokal erstellen, wenn der Server nicht erreichbar ist — Upload bleibt ausstehend und kann später nachgeholt werden
- Unter Vorgänge: ausstehende Uploads einzeln oder gesammelt nachholen
- Badge in der Kopfzeile bei ausstehenden Uploads; Hinweis, wenn der Server wieder erreichbar ist
- Fehlende Dateien beim Upload-Nachholen: Ordner öffnen oder nur die vorhandenen Medien hochladen
- Zusätzliche Dateien im Ausgabeordner: mit hochladen (Lieferliste wird angepasst) oder überschüssige Dateien vor dem Upload löschen
- Gesammeltes Nachholen: bereite Vorgänge zuerst, bei Problemen nacheinander mit Rückfrage

### Verbessert

- Kopfzeile passt sich schmaleren Fenstern an: Titel wird zu „ATS“, Encoder-Anzeige und Version weichen schrittweise — bis nur noch das Logo sichtbar ist (ohne abgeschnittene …)
- Server-Status aktualisiert sich im Hintergrund — Verbindungsprobleme fallen schneller auf
- Bezeichnungen vereinheitlicht: der Bereich heißt durchgängig „Vorgänge“ (statt teils „Historie“)
- Update-Dialog: Wechsel von Beta auf finale Version und Beta-Hinweise in den Einstellungen klarer formuliert

## [0.3.9-beta.1] - 2026-08-26

### Neu

- Vorgang lokal erstellen, wenn der Server nicht erreichbar ist — Upload bleibt ausstehend und kann später nachgeholt werden
- Unter Vorgänge: ausstehende Uploads einzeln oder gesammelt nachholen
- Badge in der Kopfzeile bei ausstehenden Uploads; Hinweis, wenn der Server wieder erreichbar ist
- Fehlende Dateien beim Upload-Nachholen: Ordner öffnen oder nur die vorhandenen Medien hochladen
- Zusätzliche Dateien im Ausgabeordner: mit hochladen (Lieferliste wird angepasst) oder überschüssige Dateien vor dem Upload löschen
- Gesammeltes Nachholen: bereite Vorgänge zuerst, bei Problemen nacheinander mit Rückfrage

### Verbessert

- Server-Status aktualisiert sich im Hintergrund — Verbindungsprobleme fallen schneller auf
- Bezeichnungen vereinheitlicht: der Bereich heißt durchgängig „Vorgänge“ (statt teils „Historie“)
- Update-Dialog: Wechsel von Beta auf finale Version und Beta-Hinweise in den Einstellungen klarer formuliert

## [0.3.8] - 2026-08-26

### Neu

- Vor „Vorgang erstellen“ Hinweis, wenn der Ausgabeordner schon Dateien enthält — mit Option, den Ordner zu ersetzen und neu zu erstellen

### Verbessert

- Beim erneuten Erstellen landen keine alten Fotos oder Videos mehr still mit im Upload

## [0.3.7] - 2026-08-25

### Neu

- Optional Beta-Updates in den Einstellungen: Vorabversionen beim Start und bei „Nach Updates suchen“ einbeziehen

### Verbessert

- Update-Dialog kennzeichnet Beta-Versionen und warnt vor möglichen Fehlern
- Fotos-Tab: Übersicht und Detailpanel auf breiten Bildschirmen besser aufeinander abgestimmt — die Miniatur-Ansicht nutzt die volle Höhe neben den Details

## [0.3.6] - 2026-08-25

### Verbessert

- Upload zum Server schneller bei vielen Fotos (mehrere Dateien gleichzeitig)
- Fortschritt beim Upload zeigt übertragene Datenmenge und Geschwindigkeit statt Dateinamen
- Abgebrochene Uploads werden zuverlässiger erkannt und in der Historie korrekt angezeigt

## [0.3.5] - 2026-08-25

### Neu

- Server-Profile in den Einstellungen: mehrere Upload-Ziele speichern und per Klick umschalten
- Vor „Vorgang erstellen“ Hinweis, wenn ungewöhnlich wenig Videos oder Fotos für das gebuchte Produkt importiert sind

### Geändert

- Optionaler mpv-Player entfernt — Vorschau und Cutter nutzen wieder nur HTML5 (kleineres Bundle, flüssigeres Playback)
- Statuszeile: „Überwachung“ heißt jetzt „SD-Überwachung“

### Verbessert

- Buchungssuche zeigt den verbundenen Dienstnamen in Status und Tooltip
- Abgebrochene Uploads in der Historie werden korrekt als abgeschlossen erkannt

### Behoben

- Hinweise und „Vorgang erstellen“-Bereitschaft springen beim Wechsel des Eingabemodus nicht mehr falsch

## [0.3.4] - 2026-08-24

### Neu

- Optional mpv-Player für den Zuschnitt: flüssigeres Spulen und Springen (Video-Einstellungen; ohne mpv bleibt HTML5)
- Fortschritt beim „Vorgang erstellen“ als Schritt-Leiste (Ordner, Video, Fotos, Upload …)

### Verbessert

- Vorschaubilder der Clips in der Videoliste laden schneller und ruhiger
- QR-Erkennung bei Actioncam-Aufnahmen zuverlässiger (unscharfe Frames überspringen, schwierige Fälle gründlicher prüfen)
- Server- und Upload-Status in Kopfzeile und Abschluss klarer
- Große Foto-Imports sortieren schneller
- Mayo in der Standard-Crew als Tandemmaster und Videospringer

### Behoben

- Stabilere Anzeige und Übergabe beim Upload bzw. Abschluss nach dem Erstellen

## [0.3.2] - 2026-08-22

### Verbessert

- Beim manuellen Eintrag per Kunden- und Booking-ID: klarere Hinweise, wann noch etwas fehlt
- Der „Vorgang erstellen“-Button und die Hinweise erscheinen erst, wenn die IDs vollständig sind

### Behoben

- Kunden-ID und Booking-ID müssen im ID-Modus ausgefüllt sein (mindestens 4 Ziffern)
- Weniger verwirrende Meldungen während der automatischen Kundendaten-Ladung

## [0.3.1] - 2026-08-21

### Verbessert

- Fotos importieren läuft ruhiger und zeigt, was gerade passiert
- Viele Fotos auf einmal gehen schneller
- Medien auf demselben Laufwerk landen schneller im Arbeitsordner
- Leeren und Zurücksetzen: kurze Rückmeldung, die App bleibt bedienbar
- Beim Start siehst du, wenn der Cache bereinigt wird
- In der Log-Konsole bleibt deine Log-Stufe gespeichert
- Update-Hinweise sind übersichtlicher lesbar

### Behoben

- Der Fortschrittsbalken bleibt beim Wechsel der Schritte nicht mehr „hängen“

## [0.3.0] - 2026-08-20

### Neu

- USB-Action-Cams (z. B. GoPro / DJI / Insta360): Medien per Kabel importieren (Windows & Mac)
- Aus der Historie fehlende Dateien nachreichen (mit Kategorie und Vorschau)
- Kunden per Buchungs-/Kunden-ID laden — Name und Medien wie nach QR-Scan
- App-Sprache wählbar: Deutsch, English, Español (México)
- Video-Einstellungen: Profil wählen und Bestätigung vor erneutem Kodieren
- Fotos: Übersicht und große Detailansicht nebeneinander

### Schneller & flüssiger

- Import, Vorschaubilder und Video-Vorschau spürbar schneller
- Weniger unnötiges Neuberechnen, wenn schon eine passende Vorschau da ist
- Beim Foto-Import zuerst QR-Erkennung, danach Vorschaubilder

### Hinweis

- USB-Kameras unter Linux folgen in einem späteren Update
