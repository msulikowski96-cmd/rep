# Taxi – zamówienia online

Prosta aplikacja webowa: klienci zamawiają przejazd, Ty obsługujesz zamówienia w panelu. Bez zależności – wystarczy Node.js 18+.

## Uruchomienie

```bash
ADMIN_PASSWORD='twoje-haslo' npm start
```

- Strona klienta: http://localhost:3000
- Panel kierowcy: http://localhost:3000/admin (hasło z `ADMIN_PASSWORD`)

## Co potrafi

**Klient:** formularz zamówienia (adresy, od razu lub na godzinę, liczba pasażerów, uwagi), kod zamówienia, sprawdzanie statusu i ceny, anulowanie.
**Kierowca:** lista zamówień z filtrami, dzwonienie jednym kliknięciem, potwierdzanie/odrzucanie, wpisanie ceny i wiadomości do klienta, odświeżanie co 15 s.

## Ustawienia

Nazwa firmy, telefon i taryfa są w `config.json`. Zamówienia zapisują się w `data/orders.json` (zmienna `DATA_FILE`, `PORT` zmienia port).

## Wdrożenie

Działa na każdym hostingu z Node.js (Render, Railway, VPS). Ustaw `ADMIN_PASSWORD`, wystaw za HTTPS i zadbaj o trwały dysk dla katalogu `data/`.

## Testy

```bash
npm test
```
