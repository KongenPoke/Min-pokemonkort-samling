# Kortpermen

Pokémon-samling med venner. Hver bruger har sin egen samling, alle kan se hinandens, og priserne kommer fra Cardmarket via [TCGdex](https://tcgdex.dev).

## Sådan hænger det sammen

- **Hjemmesiden** (`index.html`, `app.js`, `style.css`) er ren HTML/JS uden build-trin og kører på GitHub Pages.
- **Supabase** (projekt `kortpermen`, region eu-north-1) står for login og data:
  - `profiles`: brugernavn pr. bruger (oprettes automatisk ved signup)
  - `collection`: kort og antal pr. bruger
  - `wishlist`: ønskeliste (bruges i fase 3)
  - `cards` og `price_history`: kortdata og ét prisbillede pr. kort pr. dag
  - `latest_prices` og `user_stats`: visninger oven på tabellerne
- **Prisopsamling**: Edge Functionen `snapshot-prices` kører hver time (pg_cron, minut 17) og henter dagens pris for alle kort, som nogen har eller ønsker sig. Kort, der allerede har en pris for i dag, springes over.

## Sikkerhed

Row Level Security er slået til på alle tabeller. Indloggede kan læse alles samlinger, men kun rette i deres egen. Priser og kortdata kan kun skrives af serveren. Nøglen i `app.js` er den offentlige publishable key og må gerne ligge i koden.
