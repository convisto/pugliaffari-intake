/**
 * Pugliaffari — Aankoopvragenlijst backend
 * ------------------------------------------------------------
 * Ontvangt de JSON-submission van vragenlijst.html en doet vier dingen:
 *   1. Schrijft een nieuwe rij weg in de Notion-database "Aankoopvragenlijst"
 *   2. Genereert een nette PDF van het volledige dossier
 *   3. Stuurt een bevestigingsmail naar de klant (volledige info + PDF-bijlage)
 *   4. Stuurt een lead-notificatie naar het interne team (ciao@pugliaffari.com) met de PDF
 *
 * Vereiste secrets/vars (zie README.md):
 *   RESEND_API_KEY       - API key van resend.com
 *   FROM_EMAIL           - geverifieerd verzendadres, bv. "Pugliaffari <aankoop@pugliaffari.com>"
 *   INTERNAL_EMAIL       - interne lead-notificaties (default ciao@pugliaffari.com)
 *   NOTION_TOKEN         - Notion internal integration token
 *   NOTION_DATABASE_ID   - ID van de "Aankoopvragenlijst" database
 *   ALLOWED_ORIGIN       - (optioneel) origin die mag posten, default "*"
 */

import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

const REQUIRED_FIELDS = ["firstName", "lastName", "email", "phone", "budget"];

export default {
  async fetch(request, env) {
    const origin = env.ALLOWED_ORIGIN || "*";
    const corsHeaders = {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
    if (request.method !== "POST") return json({ error: "Method not allowed" }, 405, corsHeaders);

    let data;
    try {
      data = await request.json();
    } catch (e) {
      return json({ error: "Invalid JSON" }, 400, corsHeaders);
    }

    // Honeypot — bots vullen dit onzichtbare veld in, stille "success" teruggeven
    if (data.website) return json({ ok: true }, 200, corsHeaders);

    for (const field of REQUIRED_FIELDS) {
      if (!data[field] || String(data[field]).trim() === "") {
        return json({ error: `Missing field: ${field}` }, 400, corsHeaders);
      }
    }

    const results = { notion: null, email: null };

    // 1. Notion
    try {
      results.notion = await writeToNotion(data, env);
    } catch (err) {
      results.notion = { error: String(err) };
    }

    // 2. PDF's (mogen falen zonder de submission te blokkeren):
    //    - klant: in de taal van de klant (uit de meegestuurde payload; fallback NL)
    //    - team:  Nederlands (met contactgegevens)
    //    - makelaar: Italiaans, GEANONIMISEERD (zonder naam/e-mail/telefoon)
    let clientPdf = null, teamNlPdf = null, brokerItPdf = null;
    try {
      clientPdf = (data.pdf && Array.isArray(data.pdf.sections) && data.pdf.sections.length)
        ? bytesToBase64(await buildPdfFromPayload(data.pdf))
        : bytesToBase64(await buildPdf(data, "nl"));
    } catch (err) { results.pdfClient = { error: String(err) }; }
    try { teamNlPdf = bytesToBase64(await buildPdf(data, "nl")); } catch (err) { results.pdf = { error: String(err) }; }
    try { brokerItPdf = bytesToBase64(await buildPdf(data, "it", { anonymize: true })); } catch (err) { results.pdfIt = { error: String(err) }; }

    // 3 + 4. E-mails
    try {
      results.email = await sendEmails(data, env, clientPdf, teamNlPdf, brokerItPdf);
    } catch (err) {
      results.email = { error: String(err) };
    }

    const notionFailed = results.notion && results.notion.error;
    const emailFailed = results.email && results.email.error;
    if (notionFailed && emailFailed) {
      return json({ error: "Both Notion and email failed", details: results }, 500, corsHeaders);
    }
    return json({ ok: true, details: results }, 200, corsHeaders);
  },
};

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function json(obj, status, extraHeaders) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...(extraHeaders || {}) },
  });
}

function esc(str) {
  return String(str == null ? "" : str).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function truncate(str, n) {
  const s = String(str || "");
  return s.length > n ? s.slice(0, n) : s;
}

function val(v) {
  if (v === undefined || v === null) return "";
  if (Array.isArray(v)) return v.filter(Boolean).join(", ");
  return String(v).trim();
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/* Italiaanse vertaling (NL-canoniek -> IT) voor de tweede PDF naar makelaarpartners.
   Bevat sectietitels, veldlabels en de canonieke antwoordwaarden. Vrije tekst
   (namen, links, toelichtingen) blijft ongewijzigd. Onbekende sleutels vallen terug op NL. */
const WT_IT = {
  // sectietitels
  "Contact":"Contatto","Jouw zoektocht":"La tua ricerca","Budget":"Budget","Locatie":"Posizione","Het pand":"L'immobile","Leefstijl":"Stile di vita","Investering":"Investimento","Tot slot":"Per concludere",
  // veldlabels
  "Naam":"Nome","Telefoon":"Telefono","Voorkeurscontact":"Contatto preferito","Eerder in Puglia geweest":"Già stato in Puglia","Hoe gehoord van Pugliaffari":"Come ci ha conosciuti","Doel aankoop":"Scopo dell'acquisto","Belangrijkste reden":"Motivo principale","Fase aankoopproces":"Fase del processo d'acquisto","Tijdslijn aankoop":"Tempistica d'acquisto","Bezichtigingsreis":"Viaggio per le visite","Maximaal budget":"Budget massimo","Inclusief aankoopkosten":"Spese d'acquisto incluse","Financiering":"Finanziamento","Regio voorkeur":"Zone preferite","Bekende plaatsen":"Località conosciute","Belang afstand zee/vliegveld":"Importanza distanza mare/aeroporto","Type pand":"Tipo di immobile","Perceel grootte":"Dimensione del terreno","Voorzieningen":"Comfort","Staat van het pand":"Condizioni dell'immobile","Renovatiebegeleiding gewenst":"Assistenza ristrutturazione desiderata","Te vermijden":"Da evitare","Wie gebruikt de woning":"Chi usa la casa","Reist met":"Viaggia con","Gewenst aantal slaapkamers":"Numero di camere desiderato","Interesse verhuurbeheer":"Interesse gestione affitti","Belang verhuuropbrengst":"Importanza del rendimento","Al woningen gezien":"Immobili già visti","Droombeschrijving":"Descrizione del sogno","Opmerkingen":"Osservazioni",
  // waarden
  "Ja":"Sì","Nee":"No","Telefonisch":"Telefono",
  "Referral of mond-tot-mond":"Passaparola / referral","Instagram of social media":"Instagram / social","Anders":"Altro",
  "Permanente woning":"Residenza permanente","Vakantiehuis":"Casa vacanze","Investering of verhuur":"Investimento / affitto","Gemengd gebruik":"Uso misto",
  "Droom die we al jaren hebben":"Un sogno che abbiamo da anni","Vakantie met familie":"Vacanze in famiglia","Investering":"Investimento","Combinatie eigen gebruik en verhuur":"Combinazione di uso proprio e affitto","Emigreren":"Trasferirsi all'estero","Pensioen":"Pensione",
  "We orienteren ons nog":"Ci stiamo ancora orientando","We hebben al meerdere woningen bekeken":"Abbiamo già visto diversi immobili","We zijn klaar om snel een bod uit te brengen":"Siamo pronti a fare presto un'offerta","We hebben al eerder een woning misgelopen":"Ci è già sfuggito un immobile in passato",
  "Minder dan 3 maanden":"Meno di 3 mesi","3 tot 6 maanden":"3-6 mesi","6 tot 12 maanden":"6-12 mesi","Verkennend geen haast":"Esplorativo, senza fretta","Misschien":"Forse","Nog niet":"Non ancora",
  "We weten dit nog niet":"Non lo sappiamo ancora","Cash":"Contanti","Hypotheek":"Mutuo","Nog te bepalen":"Da definire",
  "Foggia en Tavoliere":"Foggia e Tavoliere","BAT - Barletta Andria Trani":"BAT - Barletta, Andria, Trani","Bari en kust":"Bari e costa","Taranto en Ionische kust":"Taranto e costa ionica","Brindisi en kust":"Brindisi e costa","Geen specifieke voorkeur":"Nessuna preferenza specifica",
  "Zeer belangrijk max 15 min":"Molto importante — max 15 min","Belangrijk max 30 min":"Importante — max 30 min","Niet doorslaggevend":"Non determinante",
  "Moderne villa":"Villa moderna","Stadswoning of palazzo":"Casa di città / palazzo","Boerderij met land":"Casale con terreno","Appartement":"Appartamento",
  "Geen voorkeur":"Nessuna preferenza","Tot 2.000 m2":"Fino a 2.000 m²","2.000 - 10.000 m2":"2.000 - 10.000 m²","Meer dan 10.000 m2":"Più di 10.000 m²",
  "Zwembad":"Piscina","Zeezicht":"Vista mare","Wandelafstand dorp":"Paese a piedi","Horeca dichtbij":"Ristoranti e bar vicini","Airconditioning":"Aria condizionata","Authentieke uitstraling":"Stile autentico","Moderne afwerking":"Finiture moderne","Groot perceel":"Terreno grande","Olijfgaard":"Uliveto","Gastenverblijf":"Dependance per ospiti","Geen directe buren":"Nessun vicino diretto",
  "Volledig gerenoveerd of instapklaar":"Completamente ristrutturato / pronto da abitare","Licht opknapwerk oke":"Piccoli lavori vanno bene","Volledig renovatieproject oke":"Un progetto di ristrutturazione completo va bene",
  "Alleen als Pugliaffari dit begeleidt":"Solo se se ne occupa Pugliaffari",
  "Drukke weg":"Strada trafficata","Afgelegen":"Isolato","Renovatie":"Ristrutturazione","Toeristisch":"Zona turistica","Veel onderhoud":"Molta manutenzione",
  "Alleen wij twee":"Solo noi due","Gezin":"Famiglia","Familie":"Famiglia allargata","Verhuur":"Affitto","Retreats":"Retreat",
  "Kinderen":"Bambini","Huisdieren":"Animali domestici",
  "Nog niet zeker":"Non ancora sicuro",
  "1 - Helemaal niet":"1 - Per niente","2 - Klein beetje":"2 - Un po'","3 - Redelijk":"3 - Abbastanza","4 - Belangrijk":"4 - Importante","5 - Doorslaggevend":"5 - Decisivo",
  // PDF-chrome
  "Aankoopdossier":"Dossier d'acquisto","Aankoopdossier ontvangen op":"Dossier d'acquisto ricevuto il",
  "Pugliaffari — Property management & investments · Puglia, Italië":"Pugliaffari — Property management & investments · Puglia, Italia",
};
function itT(s){ if(s==null) return s; return WT_IT[s]!=null ? WT_IT[s] : s; }

/**
 * Groepeert alle antwoorden per hoofdstuk. Wordt gebruikt door de PDF,
 * de klant-mail en de interne mail. Met `tr` (vertaalfunctie) worden
 * sectietitels, labels en canonieke antwoordwaarden vertaald; vrije tekst blijft.
 */
function buildSections(d, tr, opts) {
  tr = tr || function(s){ return s; };
  opts = opts || {};
  const A = function(arr){ return (Array.isArray(arr) ? arr : (arr ? [arr] : [])).map(function(v){ return tr(v); }); };
  const R = function(label, value){ return [tr(label), value]; };
  const fullName = `${d.firstName || ""} ${d.lastName || ""}`.trim();
  const reason = tr(val(d.reason)) + (d.reasonOther ? " — " + d.reasonOther : "");
  const amenities = A(d.amenities).concat(d.amenitiesOther ? [d.amenitiesOther] : []);
  const avoid = A(d.avoid).concat(d.avoidOther ? [d.avoidOther] : []);
  const seen = tr(val(d.seenHomes)) + (d.seenHomesLinks ? " — " + d.seenHomesLinks : "");
  return [
    { title: tr("Contact"), rows: (opts.anonymize ? [] : [
      R("Naam", fullName), R("E-mail", d.email), R("Telefoon", d.phone),
    ]).concat([
      R("Voorkeurscontact", tr(d.contactPreference)),
      R("Eerder in Puglia geweest", tr(d.visitedBefore ? "Ja" : "Nee")),
      R("Hoe gehoord van Pugliaffari", tr(d.source)),
    ]) },
    { title: tr("Jouw zoektocht"), rows: [
      R("Doel aankoop", tr(d.purpose)), R("Belangrijkste reden", reason),
      R("Fase aankoopproces", tr(d.processStage)), R("Tijdslijn aankoop", tr(d.timeline)),
      R("Bezichtigingsreis", tr(d.visitInterest)),
    ]},
    { title: tr("Budget"), rows: [
      R("Maximaal budget", d.budget ? "€ " + d.budget : ""), R("Inclusief aankoopkosten", tr(d.budgetIncludesCosts)),
      R("Financiering", tr(d.financing)),
    ]},
    { title: tr("Locatie"), rows: [
      R("Regio voorkeur", A(d.region)), R("Bekende plaatsen", d.knownPlaces),
      R("Belang afstand zee/vliegveld", tr(d.distanceImportance)),
    ]},
    { title: tr("Het pand"), rows: [
      R("Type pand", A(d.propertyType)), R("Perceel grootte", tr(d.landSize)),
      R("Voorzieningen", amenities), R("Staat van het pand", A(d.condition)),
      R("Renovatiebegeleiding gewenst", tr(d.renovationSupport)), R("Te vermijden", avoid),
    ]},
    { title: tr("Leefstijl"), rows: [
      R("Wie gebruikt de woning", A(d.mainUse)), R("Reist met", A(d.householdTravel)),
      R("Gewenst aantal slaapkamers", d.bedrooms),
    ]},
    { title: tr("Investering"), rows: [
      R("Interesse verhuurbeheer", tr(d.rentalManagement)),
      R("Belang verhuuropbrengst", tr(d.rentalYieldImportance)),
    ]},
    { title: tr("Tot slot"), rows: [
      R("Al woningen gezien", seen), R("Droombeschrijving", d.dreamDescription),
      R("Opmerkingen", d.remarks),
    ]},
  ];
}

/* ------------------------------------------------------------------ */
/* Notion                                                              */
/* ------------------------------------------------------------------ */

async function writeToNotion(data, env) {
  const databaseId = (env.NOTION_DATABASE_ID || "").replace(/-/g, "");
  const today = new Date().toISOString().split("T")[0];

  const properties = {
    "Naam": { title: [{ text: { content: `${data.firstName} ${data.lastName}`.trim() } }] },
    "Email": { email: data.email || null },
    "Telefoon": { phone_number: data.phone || null },
    "Ingevuld op": { date: { start: today } },
    "Status opvolging": { status: { name: "Niet gestart" } },
    "Eerder in Puglia geweest": { checkbox: !!data.visitedBefore },
  };

  const select = (prop, v) => { if (v) properties[prop] = { select: { name: v } }; };
  const multi = (prop, arr) => { if (Array.isArray(arr) && arr.length) properties[prop] = { multi_select: arr.map((v) => ({ name: v })) }; };
  const text = (prop, v) => { if (v) properties[prop] = { rich_text: [{ text: { content: truncate(v, 2000) } }] }; };
  const url = (prop, v) => { if (v) properties[prop] = { url: v }; };
  const num = (prop, v) => { if (v !== undefined && v !== null && v !== "") properties[prop] = { number: Number(v) }; };

  select("Voorkeurscontact", data.contactPreference);
  select("Hoe gehoord van Pugliaffari", data.source);
  select("Doel aankoop", data.purpose);
  select("Belangrijkste reden", data.reason);
  text("Reden toelichting", data.reasonOther);
  select("Fase aankoopproces", data.processStage);
  select("Tijdslijn aankoop", data.timeline);
  select("Bezichtigingsreis interesse", data.visitInterest);
  num("Budget", String(data.budget || "").replace(/\D/g, ""));
  select("Budget inclusief aankoopkosten", data.budgetIncludesCosts);
  select("Financiering", data.financing);
  multi("Regio voorkeur", data.region);
  text("Bekende plaatsen", data.knownPlaces);
  select("Belang afstand zee of vliegveld", data.distanceImportance);
  multi("Type pand", data.propertyType);
  select("Perceel grootte", data.landSize);
  multi("Voorzieningen belangrijk", data.amenities);
  text("Voorzieningen toelichting", data.amenitiesOther);
  multi("Staat van het pand", data.condition);
  select("Renovatiebegeleiding gewenst", data.renovationSupport);
  multi("Te vermijden", data.avoid);
  text("Te vermijden toelichting", data.avoidOther);
  multi("Wie gebruikt de woning", data.mainUse);
  multi("Reist met", data.householdTravel);
  num("Slaapkamers", data.bedrooms);
  select("Interesse verhuurbeheer", data.rentalManagement);
  select("Belang verhuuropbrengst", data.rentalYieldImportance);
  select("Al woningen gezien", data.seenHomes);
  text("Links gedeelde woningen", data.seenHomesLinks);
  text("Droomomschrijving", data.dreamDescription);
  text("Opmerkingen", data.remarks);
  url("Ingediend vanaf", data.submittedFrom);

  const res = await fetch("https://api.notion.com/v1/pages", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.NOTION_TOKEN}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ parent: { database_id: databaseId }, properties }),
  });

  const body = await res.json();
  if (!res.ok) throw new Error(`Notion API error ${res.status}: ${JSON.stringify(body)}`);
  return { pageId: body.id };
}

/* ------------------------------------------------------------------ */
/* PDF (pdf-lib)                                                       */
/* ------------------------------------------------------------------ */

function pdfSafe(str) {
  // pdf-lib StandardFonts gebruiken WinAnsi; vervang smart punctuation.
  return String(str == null ? "" : str)
    .replace(/[‘’′]/g, "'")
    .replace(/[“”″]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/…/g, "...")
    .replace(/[•●]/g, "-")
    .replace(/ /g, " ");
}

function wrapText(text, font, size, maxW) {
  const out = [];
  pdfSafe(text).split("\n").forEach((par) => {
    const words = par.split(/\s+/).filter(Boolean);
    let line = "";
    for (let w of words) {
      while (font.widthOfTextAtSize(w, size) > maxW) {
        let i = 1;
        while (i < w.length && font.widthOfTextAtSize(w.slice(0, i + 1), size) <= maxW) i++;
        if (line) { out.push(line); line = ""; }
        out.push(w.slice(0, i));
        w = w.slice(i);
      }
      const test = line ? line + " " + w : w;
      if (font.widthOfTextAtSize(test, size) > maxW && line) { out.push(line); line = w; }
      else line = test;
    }
    if (line) out.push(line);
    if (!words.length) out.push("");
  });
  return out.length ? out : [""];
}

async function renderPdf(model) {
  const title = model.title, heading = model.heading, receivedLine = model.receivedLine, footer = model.footer;
  const sections = Array.isArray(model.sections) ? model.sections : [];
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const italic = await pdf.embedFont(StandardFonts.HelveticaOblique);

  const GREEN = rgb(0.114, 0.208, 0.157);
  const GOLD = rgb(0.788, 0.659, 0.298);
  const INK = rgb(0.137, 0.137, 0.106);
  const MUTED = rgb(0.43, 0.43, 0.39);
  const LINE = rgb(0.902, 0.878, 0.824);

  const W = 595.28, H = 841.89, M = 54;
  const labelW = 170, gap = 14;
  const valX = M + labelW + gap;
  const valW = W - M - valX;

  let page = pdf.addPage([W, H]);
  let y;

  function header() {
    page.drawRectangle({ x: 0, y: H - 96, width: W, height: 96, color: GREEN });
    page.drawText("PUGLIAFFARI", { x: M, y: H - 50, font: bold, size: 20, color: rgb(1, 1, 1) });
    page.drawText("PROPERTY MANAGEMENT & INVESTMENTS", { x: M, y: H - 66, font, size: 8, color: GOLD });
    const ttl = pdfSafe(title || "Aankoopdossier");
    page.drawText(ttl, { x: W - M - bold.widthOfTextAtSize(ttl, 16), y: H - 52, font: bold, size: 16, color: GOLD });
    y = H - 96 - 34;
  }
  function ensure(space) {
    if (y - space < M) { page = pdf.addPage([W, H]); y = H - M; }
  }

  header();

  // Kop (naam of leeg bij anonieme makelaar-PDF) + datumregel
  if (heading) { page.drawText(pdfSafe(heading), { x: M, y, font: bold, size: 15, color: INK }); y -= 16; }
  if (receivedLine) { page.drawText(pdfSafe(receivedLine), { x: M, y, font, size: 9.5, color: MUTED }); y -= 22; } else { y -= 6; }

  const size = 9.5, lh = 13;
  for (const sec of sections) {
    ensure(40);
    // sectietitel
    page.drawText(pdfSafe(sec.title), { x: M, y, font: bold, size: 11.5, color: GREEN });
    y -= 6;
    page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 1, color: GOLD });
    y -= 16;
    for (const [label, raw] of sec.rows) {
      const value = val(raw) || "—";
      const lines = wrapText(value, font, size, valW);
      const rowH = Math.max(lh, lines.length * lh);
      ensure(rowH + 4);
      page.drawText(pdfSafe(label), { x: M, y, font, size, color: MUTED });
      lines.forEach((ln, i) => {
        page.drawText(ln, { x: valX, y: y - i * lh, font: i === 0 ? bold : font, size, color: INK });
      });
      y -= rowH + 6;
      page.drawLine({ start: { x: M, y: y + 3 }, end: { x: W - M, y: y + 3 }, thickness: 0.5, color: LINE });
    }
    y -= 10;
  }

  // Footer op elke pagina
  const pages = pdf.getPages();
  pages.forEach((p, i) => {
    p.drawText(pdfSafe(footer || "Pugliaffari — Property management & investments · Puglia, Italië"),
      { x: M, y: 30, font: italic, size: 8, color: MUTED });
    const pg = `${i + 1} / ${pages.length}`;
    p.drawText(pg, { x: W - M - font.widthOfTextAtSize(pg, 8), y: 30, font, size: 8, color: MUTED });
  });

  return await pdf.save();
}

// Bouwt een PDF vanuit de ruwe data in een bepaalde taal (nl of it). opts.anonymize verbergt naam/contact.
async function buildPdf(d, langCode, opts) {
  opts = opts || {};
  const tr = (langCode === "it") ? itT : function (s) { return s; };
  const sections = buildSections(d, tr, opts);
  const dateStr = new Date().toLocaleDateString(langCode === "it" ? "it-IT" : "nl-BE", { day: "2-digit", month: "long", year: "numeric" });
  const heading = opts.anonymize ? "" : (`${d.firstName || ""} ${d.lastName || ""}`.trim() || "—");
  return renderPdf({
    title: tr("Aankoopdossier"),
    heading,
    receivedLine: tr("Aankoopdossier ontvangen op") + " " + dateStr,
    footer: tr("Pugliaffari — Property management & investments · Puglia, Italië"),
    sections,
  });
}

// Bouwt de klant-PDF vanuit de door de front-end meegestuurde, reeds vertaalde inhoud.
async function buildPdfFromPayload(p) {
  return renderPdf({
    title: p.title || "Aankoopdossier",
    heading: p.heading || "",
    receivedLine: p.receivedLine || "",
    footer: p.footer || "",
    sections: Array.isArray(p.sections) ? p.sections : [],
  });
}

/* ------------------------------------------------------------------ */
/* Email (Resend)                                                      */
/* ------------------------------------------------------------------ */

async function sendEmails(data, env, clientPdf, teamNlPdf, brokerItPdf) {
  const fromEmail = env.FROM_EMAIL || "Pugliaffari <onboarding@resend.dev>";
  const internalTo = (env.INTERNAL_EMAIL || "ciao@pugliaffari.com").split(",").map(function(s){ return s.trim(); }).filter(Boolean);
  const fullName = `${data.firstName} ${data.lastName}`.trim();
  const sections = buildSections(data); // Nederlands — voor de interne (team) e-mail
  const clientLang = (data.lang && CLIENT_MAIL[data.lang]) ? data.lang : "nl";
  // Klant-e-mail in eigen taal: gebruik de reeds vertaalde secties uit de payload (fallback NL)
  const clientSections = (data.pdf && Array.isArray(data.pdf.sections) && data.pdf.sections.length) ? data.pdf.sections : sections;

  const safeName = (fullName || "Pugliaffari").replace(/[^\w\- ]/g, "").trim().replace(/\s+/g, "-");
  // Klant: dossier in eigen taal. Team: NL-dossier + geanonimiseerde IT-versie voor de makelaars.
  const clientAttachments = clientPdf ? [{ filename: `Aankoopdossier-${safeName}.pdf`, content: clientPdf }] : undefined;
  const teamNlAtt = teamNlPdf ? { filename: `Aankoopdossier-${safeName}-NL.pdf`, content: teamNlPdf } : null;
  const brokerAtt = brokerItPdf ? { filename: `Ricerca-immobiliare-IT.pdf`, content: brokerItPdf } : null;
  const internalList = [teamNlAtt, brokerAtt].filter(Boolean);
  const internalAttachments = internalList.length ? internalList : undefined;

  const [clientRes, internalRes] = await Promise.all([
    resendSend(env, {
      from: fromEmail,
      to: data.email,
      reply_to: internalTo,
      subject: (CLIENT_MAIL[clientLang] || CLIENT_MAIL.nl).subject,
      html: clientEmailHtml(data, fullName, clientSections, clientLang),
      attachments: clientAttachments,
    }),
    resendSend(env, {
      from: fromEmail,
      to: internalTo,
      reply_to: data.email || undefined,
      subject: `Nieuwe aankoop-lead: ${fullName || data.email}`,
      html: internalEmailHtml(data, fullName, sections),
      attachments: internalAttachments,
    }),
  ]);

  return { client: clientRes, internal: internalRes };
}

async function resendSend(env, payload) {
  const clean = {};
  for (const k in payload) if (payload[k] !== undefined) clean[k] = payload[k];
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(clean),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`Resend API error ${res.status}: ${JSON.stringify(body)}`);
  return body;
}

function sectionsTableHtml(sections) {
  return sections.map((sec) => {
    const rows = sec.rows.map(([k, v]) => {
      const value = val(v) || "—";
      return `<tr><td style="padding:7px 12px;color:#75756B;border-bottom:1px solid #E6E0D2;vertical-align:top;width:42%;">${esc(k)}</td><td style="padding:7px 12px;border-bottom:1px solid #E6E0D2;color:#26261F;">${esc(value)}</td></tr>`;
    }).join("");
    return `<h3 style="font-family:Georgia,serif;color:#1D3528;font-size:15px;margin:22px 0 6px;border-bottom:2px solid #E7EDE8;padding-bottom:4px;">${esc(sec.title)}</h3>
      <table style="border-collapse:collapse;width:100%;font-size:13px;">${rows}</table>`;
  }).join("");
}

/* Meertalige teksten voor de klant-bevestigingsmail. {name} wordt vervangen. */
const CLIENT_MAIL = {
  nl: { subject:"Uw aankoopdossier bij Pugliaffari is ontvangen", greeting:"Beste {name},", fallbackName:"toekomstige eigenaar",
    p1:"Bedankt voor het invullen van je aankoopdossier bij <strong>Pugliaffari</strong>. We hebben je wensen goed ontvangen. Ons team neemt je dossier nu in behandeling en neemt <strong>binnen 48 uur</strong> persoonlijk contact met je op met een eerste selectie van panden die aansluiten bij je wensen.",
    p2:"Ter bevestiging vind je hieronder én in de bijgevoegde PDF een overzicht van wat je hebt doorgegeven:",
    p3:"Klopt er iets niet of wil je nog iets toevoegen? Antwoord gerust op deze e-mail of schrijf naar", signoff:"A presto,", team:"Team Pugliaffari", footer:"Pugliaffari — Property management & investments · Puglia, Italië" },
  it: { subject:"Il tuo dossier d'acquisto presso Pugliaffari è stato ricevuto", greeting:"Gentile {name},", fallbackName:"futuro proprietario",
    p1:"Grazie per aver compilato il tuo dossier d'acquisto presso <strong>Pugliaffari</strong>. Abbiamo ricevuto correttamente le tue preferenze. Il nostro team prende ora in carico il tuo dossier e ti contatterà personalmente <strong>entro 48 ore</strong> con una prima selezione di immobili in linea con i tuoi desideri.",
    p2:"Per conferma trovi qui sotto e nel PDF allegato una panoramica di quanto hai indicato:",
    p3:"C'è qualcosa che non va o vuoi aggiungere qualcosa? Rispondi pure a questa e-mail o scrivi a", signoff:"A presto,", team:"Il team di Pugliaffari", footer:"Pugliaffari — Property management & investments · Puglia, Italia" },
  en: { subject:"Your purchase file at Pugliaffari has been received", greeting:"Dear {name},", fallbackName:"future owner",
    p1:"Thank you for completing your purchase file at <strong>Pugliaffari</strong>. We've received your wishes. Our team is now reviewing your file and will personally contact you <strong>within 48 hours</strong> with a first selection of properties that match your wishes.",
    p2:"For your confirmation, you'll find an overview of what you provided below and in the attached PDF:",
    p3:"Is something not right, or would you like to add anything? Feel free to reply to this email or write to", signoff:"A presto,", team:"The Pugliaffari team", footer:"Pugliaffari — Property management & investments · Puglia, Italy" },
  de: { subject:"Ihr Kaufdossier bei Pugliaffari ist eingegangen", greeting:"Hallo {name},", fallbackName:"zukünftiger Eigentümer",
    p1:"Vielen Dank für das Ausfüllen deines Kaufdossiers bei <strong>Pugliaffari</strong>. Wir haben deine Wünsche gut erhalten. Unser Team bearbeitet dein Dossier nun und meldet sich <strong>innerhalb von 48 Stunden</strong> persönlich bei dir mit einer ersten Auswahl an Immobilien, die zu deinen Wünschen passen.",
    p2:"Zur Bestätigung findest du unten und im beigefügten PDF eine Übersicht deiner Angaben:",
    p3:"Stimmt etwas nicht oder möchtest du etwas ergänzen? Antworte gerne auf diese E-Mail oder schreib an", signoff:"A presto,", team:"Dein Pugliaffari-Team", footer:"Pugliaffari — Property management & investments · Apulien, Italien" },
  fr: { subject:"Votre dossier d'achat chez Pugliaffari a bien été reçu", greeting:"Bonjour {name},", fallbackName:"futur propriétaire",
    p1:"Merci d'avoir complété votre dossier d'achat chez <strong>Pugliaffari</strong>. Nous avons bien reçu vos souhaits. Notre équipe traite maintenant votre dossier et vous contactera personnellement <strong>sous 48 heures</strong> avec une première sélection de biens correspondant à vos souhaits.",
    p2:"Pour confirmation, vous trouverez ci-dessous et dans le PDF joint un récapitulatif de vos indications :",
    p3:"Quelque chose ne va pas ou souhaitez-vous ajouter quelque chose ? Répondez à cet e-mail ou écrivez à", signoff:"A presto,", team:"L'équipe Pugliaffari", footer:"Pugliaffari — Property management & investments · Pouilles, Italie" },
};

function clientEmailHtml(d, fullName, sections, lang) {
  const c = CLIENT_MAIL[lang] || CLIENT_MAIL.nl;
  const name = fullName || c.fallbackName;
  return `
  <div style="font-family:Georgia,serif;background:#FBF8F2;padding:32px;color:#26261F;">
    <div style="max-width:600px;margin:0 auto;background:#fff;border-radius:14px;padding:36px;border:1px solid #E6E0D2;">
      <div style="text-align:center;margin-bottom:6px;font-family:Arial,sans-serif;letter-spacing:0.18em;font-size:12px;color:#8A6A24;">PUGLIAFFARI</div>
      <h2 style="color:#1D3528;margin:0 0 14px;text-align:center;">${esc(c.greeting.replace("{name}", name))}</h2>
      <p style="line-height:1.6;">${c.p1}</p>
      <p style="line-height:1.6;">${esc(c.p2)}</p>
      ${sectionsTableHtml(sections)}
      <p style="margin-top:26px;line-height:1.6;">${esc(c.p3)} <a href="mailto:ciao@pugliaffari.com" style="color:#8A6A24;">ciao@pugliaffari.com</a>.</p>
      <p style="margin-top:22px;">${esc(c.signoff)}<br><strong style="color:#1D3528;">${esc(c.team)}</strong></p>
    </div>
    <div style="text-align:center;color:#9A998C;font-size:11px;margin-top:16px;font-family:Arial,sans-serif;">${esc(c.footer)}</div>
  </div>`;
}

function internalEmailHtml(d, fullName, sections) {
  return `
  <div style="font-family:Arial,sans-serif;padding:24px;color:#26261F;">
    <h2 style="color:#1D3528;margin:0 0 4px;">Nieuwe aankoop-lead: ${esc(fullName || d.email)}</h2>
    <p style="color:#75756B;font-size:13px;margin:0 0 8px;">${esc(d.email || "")}${d.phone ? " · " + esc(d.phone) : ""} · Voorkeur: ${esc(d.contactPreference || "—")}</p>
    <p style="color:#75756B;font-size:13px;margin:0 0 12px;">In de bijlage: het volledige dossier (Nederlands) én een Italiaanse versie <strong>zonder naam en contactgegevens</strong> (<em>Ricerca-immobiliare-IT.pdf</em>) om door te sturen naar de makelaarpartners.</p>
    <div style="max-width:640px;">${sectionsTableHtml(sections)}</div>
  </div>`;
}
