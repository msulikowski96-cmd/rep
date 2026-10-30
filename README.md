# Taxi – aplikacja do zamawiania przejazdów

Dwie aplikacje webowe (działają jak aplikacje mobilne, można je dodać do ekranu głównego telefonu):

| | Adres | Dla kogo |
|---|---|---|
| **Aplikacja klienta** | `/` | klienci zamawiają przejazd |
| **Aplikacja kierowcy** | `/driver` | Ty – odbierasz i prowadzisz kursy |

Bez zależności npm – wystarczy Node.js 18+. Mapy to OpenStreetMap, adresy i trasy – Nominatim i OSRM (bez kluczy API).

## Uruchomienie

```bash
ADMIN_PASSWORD='twoje-haslo' npm start
```

Otwórz `http://localhost:3000` (klient) i `http://localhost:3000/driver` (kierowca).

## Jak to działa

**Klient:** aplikacja ustala jego lokalizację, wpisuje adres docelowy (podpowiedzi), widzi trasę na mapie i cenę, zamawia „teraz" albo na wybraną godzinę. Potem śledzi status i widzi Twój samochód na mapie: szukam kierowcy → jedzie do Ciebie → czeka na miejscu → w drodze → koniec.

**Kierowca:** przełącznik Online/Offline (wtedy udostępniasz pozycję), sygnał dźwiękowy i wibracja przy nowym zamówieniu, Przyjmij/Odrzuć, kroki kursu (dojechałem → rozpocznij → zakończ z potwierdzeniem kwoty), nawigacja Google Maps jednym kliknięciem, telefon do klienta, zarobek dzisiaj i historia.

## Ustawienia (`config.json`)
Nazwa firmy, telefon, Twoje imię/samochód/numer rejestracyjny (widzi je klient), taryfa (opłata startowa, cena za km, minimalna cena), środek mapy, kraj wyszukiwania adresów.

Zamówienia zapisują się w `data/rides.json` (`DATA_FILE` zmienia lokalizację, `PORT` – port).

## Wdrożenie
Wymaga hostingu z Node.js, **HTTPS** (bez niego telefon nie udostępni lokalizacji!) i trwałego dysku na `data/`. Ustaw `ADMIN_PASSWORD`.
Uwaga: darmowe serwery OSM (kafelki, Nominatim, OSRM) są przeznaczone do małego ruchu; przy większym ruchu warto przejść na płatnego dostawcę map.

## Testy
```bash
npm test
```
