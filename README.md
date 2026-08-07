# Pugliaffari — Aankoopvragenlijst: setup

Deze onderdelen horen bij elkaar:

- `index.html` — de vragenlijst zelf
- `assets/` — de Pugliaffari boom-mark, de boom-watermark en de kaart van Puglia die de pagina gebruikt
  (`pugliaffari-mark.svg`, `watermark-tree.svg`, `puglia-map.svg`). Het woordmerk "PUGLIAFFARI —
  Property management & investments" staat als echte (groene) tekst in de header,
  zodat het altijd scherp en leesbaar is. **Deze map moet mee-gehost worden naast
  `index.html`** — bij hosting op Netlify/GitHub gaat dat vanzelf mee.
- `worker/` — de serverless backend die e-mails verstuurt en naar Notion schrijft
- Notion database **"Aankoopvragenlijst"** — al aangemaakt in de Pugliaffari HQ workspace
  → https://app.notion.com/p/729f5e4c70a54fd980f1015752a766ec

De HTML-pagina kan zelf geen mail versturen of in Notion schrijven (dat vereist geheime
API-sleutels die nooit in een publieke pagina mogen staan). Daarom is er een kleine
serverless functie (Cloudflare Worker) die dat namens de pagina doet. Je moet deze **eenmalig**
deployen — daarna werkt alles automatisch.

Reken op **15–20 minuten** de eerste keer.

---

## Stap 1 — Notion: integratie-token aanmaken

1. Ga naar https://www.notion.so/my-integrations → **New integration**.
2. Naam: bv. "Vragenlijst Backend". Workspace: Pugliaffari HQ.
3. Kopieer de **Internal Integration Token** (begint met `ntn_` of `secret_`). Bewaar dit veilig — dit is `NOTION_TOKEN`.
4. Open de database **Aankoopvragenlijst**: https://app.notion.com/p/729f5e4c70a54fd980f1015752a766ec
5. Rechtsboven **···** → **Connections** → voeg je nieuwe integratie ("Vragenlijst Backend") toe. Zonder deze stap krijgt de Worker een 403-fout.

De database ID (nodig in stap 4) is: **`729f5e4c70a54fd980f1015752a766ec`**

> **Let op — nieuwe kolom:** de vragenlijst heeft nu een vrij "Opmerkingen"-veld. Voeg in de
> Notion-database een kolom **`Opmerkingen`** van het type **Tekst** toe, anders wordt dat ene
> veld niet weggeschreven. Alle andere kolommen bestaan al. (De Worker stuurt alleen kolommen die
> je in de database hebt; een ontbrekende kolom geeft een fout, dus controleer dit even.)

---

## Stap 2 — Resend: e-mail versturen

We gebruiken [Resend](https://resend.com) (gratis tier: 3.000 mails/maand, geen creditcard nodig om te starten).

1. Maak een account op resend.com.
2. **Domains** → voeg `pugliaffari.com` toe → volg de instructies om 2–3 DNS-records (SPF/DKIM) toe te voegen bij je domeinregistrar. Zonder geverifieerd domein kan je alleen naar je eigen Resend-accountmail versturen, niet naar klanten.
3. Zodra het domein geverifieerd is: **API Keys** → **Create API Key** → kopieer de key. Dit is `RESEND_API_KEY`.
4. Kies een verzendadres, bv. `aankoop@pugliaffari.com`. Dit wordt `FROM_EMAIL` (formaat: `Pugliaffari <aankoop@pugliaffari.com>`).

*Tip: tot het domein geverifieerd is kan je testen met `FROM_EMAIL = "Pugliaffari <onboarding@resend.dev>"`, maar dan komen mails alleen aan bij het e-mailadres waarmee je bij Resend bent ingelogd.*

---

## Stap 3 — Cloudflare Worker deployen

Je hebt een gratis Cloudflare-account nodig (workers.dev subdomein volstaat, geen eigen domein nodig).

```bash
npm install -g wrangler
cd worker
npm install             # installeert de dependencies (o.a. pdf-lib voor de PDF-generatie)
wrangler login          # opent browser, log in / maak gratis account aan

# Geheimen instellen (wrangler vraagt de waarde interactief, niets wordt gelogd):
wrangler secret put RESEND_API_KEY
wrangler secret put NOTION_TOKEN

# Niet-geheime variabelen: open wrangler.toml en zet onderaan (of via wrangler secret put, kan ook):
#   NOTION_DATABASE_ID = "729f5e4c70a54fd980f1015752a766ec"
#   FROM_EMAIL = "Pugliaffari <aankoop@pugliaffari.com>"
#   INTERNAL_EMAIL = "ciao@pugliaffari.com"

wrangler deploy
```

Na `wrangler deploy` krijg je een URL zoals:

```
https://pugliaffari-vragenlijst.<jouw-subdomein>.workers.dev
```

Dat is je `SUBMIT_ENDPOINT`.

---

## Stap 4 — Endpoint koppelen in de vragenlijst

Open `index.html`, zoek de regel (helemaal onderaan, in het `<script>`-blok):

```js
const SUBMIT_ENDPOINT = "https://YOUR-WORKER-SUBDOMAIN.workers.dev/submit";
```

Vervang door je eigen Worker-URL uit stap 3 (het `/submit` achtervoegsel mag blijven staan of weg — de Worker reageert op elk pad).

Sla op. Het bestand is nu klaar om te hosten of rechtstreeks als link/bijlage te delen.

---

## Stap 5 — Testen

1. Open `index.html` in de browser, loop de vragenlijst door met testgegevens (gebruik je eigen e-mailadres).
2. Verstuur. Je zou moeten zien:
   - Een bevestigingsmail op het ingevulde klant-e-mailadres.
   - Een lead-notificatie op `ciao@pugliaffari.com`.
   - Een nieuwe rij in de Notion-database **Aankoopvragenlijst**.
3. Bij problemen: `wrangler tail` in de `worker/`-map toont live logs van de Worker terwijl je test.

Veelvoorkomende fouten:

| Foutmelding | Oorzaak |
|---|---|
| Notion 403/`unauthorized` | Integratie niet gekoppeld aan de database (stap 1.5) |
| Notion 404 | Verkeerde `NOTION_DATABASE_ID` |
| Resend 403 | Domein nog niet geverifieerd, of `FROM_EMAIL` komt niet overeen met geverifieerd domein |
| Formulier toont "Er ging iets mis" | `SUBMIT_ENDPOINT` nog niet aangepast, of CORS/`ALLOWED_ORIGIN` te strikt ingesteld |

---

## Optioneel: eigen domein voor de Worker

Standaard draait de Worker op een `*.workers.dev` adres. Wil je liever iets als
`vragenlijst-api.pugliaffari.com`? Dat kan via **Workers & Pages → je Worker → Triggers →
Custom Domains** in het Cloudflare dashboard, als `pugliaffari.com` als DNS-zone bij Cloudflare
draait.

## Opmerking over privacy/GDPR

Deze vragenlijst verzamelt persoonsgegevens (naam, e-mail, telefoon, voorkeuren). Er staat nu een
**verplicht toestemmingsvinkje** op de laatste stap: versturen kan pas nadat de bezoeker akkoord
gaat. Overweeg daarnaast een link naar een volwaardige privacyverklaring op pugliaffari.com toe te
voegen (pas de tekst bij het vinkje in `index.html` aan zodra die pagina bestaat).

---

## Wat er in deze versie is verbeterd

Design & merk:
- Officiële Pugliaffari boom-mark in de header, met het woordmerk als scherpe groene tekst (leesbaar op crème).
- Sierlijke ornament-flourish op de intro, de tussenschermen en het slotscherm.
- Subtiele olijfboom-watermark op de tussen- en slotschermen.
- Fijnere interactie-details: druk-feedback op knoppen/opties, `text-wrap` voor nette regels.

Functionaliteit:
- **Automatisch opslaan** in de browser — bij terugkomst kan de bezoeker verdergaan waar die was.
- **Bewerkbaar overzicht**: elk hoofdstuk heeft een "Wijzig"-knop die naar de juiste stap springt
  en daarna terugkeert naar het overzicht.
- **Toetsenbord**: Enter gaat naar de volgende stap.
- **Live validatie**: foutmeldingen verdwijnen zodra een veld correct is; bij een fout springt de
  focus naar het eerste ontbrekende veld.
- **Verplicht toestemmingsvinkje** vóór verzenden (zie GDPR hierboven).
- **Toegankelijkheid**: labels gekoppeld aan velden, groepen als radiogroup/group, voortgangsbalk
  als progressbar, live-aankondigingen voor schermlezers.
- **Interactieve kaart van Puglia** bij de regiostap: gebieden lichten op de kaart op wanneer je ze
  aanvinkt (en omgekeerd), klikbaar en toetsenbord-toegankelijk.
- Vrij **"Opmerkingen"-veld** op de laatste stap.
- **Vijftalig** (Nederlands / Italiaans / Engels / Duits / Frans). De bezoeker kiest de taal op een
  **taalkeuze-startscherm** (met vlaggen) vóór de vragenlijst begint. Alleen de weergegeven tekst
  vertaalt; de antwoordwaarden die naar Notion/e-mail gaan blijven canoniek Nederlands.
- **PDF's per ontvanger** bij afronden:
  - de **klant** krijgt het dossier in **zijn/haar eigen taal** (de front-end stuurt de vertaalde
    inhoud mee; de Worker rendert die);
  - het **team** krijgt het dossier in het **Nederlands** (met contactgegevens);
  - het **team** krijgt óók een **Italiaanse versie zónder naam/contactgegevens** (`Ricerca-immobiliare-IT.pdf`)
    om door te sturen naar de makelaarpartners.
  De **klant-bevestigingsmail** (onderwerp, begroeting, tekst én het overzicht) is óók in de taal van de klant.

Bij afronden (in de `worker/`-backend):
- Er wordt een **nette PDF** van het volledige dossier gegenereerd (pdf-lib, in Pugliaffari-huisstijl).
- De **klant** krijgt een bevestigingsmail met het **volledige overzicht** én de (Nederlandse) PDF als bijlage.
- Het **team** (`ciao@pugliaffari.com`) krijgt een lead-notificatie met hetzelfde overzicht + **twee PDF's**:
  het Nederlandse dossier én een **Italiaanse vertaling** (`…-IT.pdf`) om door te sturen naar makelaarpartners.
- **Alle data** wordt naar Notion weggeschreven (vergeet de nieuwe `Opmerkingen`-kolom niet, zie stap 1).
