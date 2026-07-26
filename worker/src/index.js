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

    // 2. PDF (mag falen zonder de submission te blokkeren)
    let pdfBase64 = null;
    try {
      const bytes = await buildPdf(data);
      pdfBase64 = bytesToBase64(bytes);
    } catch (err) {
      results.pdf = { error: String(err) };
    }

    // 3 + 4. E-mails
    try {
      results.email = await sendEmails(data, env, pdfBase64);
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

/**
 * Groepeert alle antwoorden per hoofdstuk. Wordt gebruikt door de PDF,
 * de klant-mail en de interne mail, zodat overal exact dezelfde data staat.
 */
function buildSections(d) {
  const fullName = `${d.firstName || ""} ${d.lastName || ""}`.trim();
  const reason = val(d.reason) + (d.reasonOther ? " — " + d.reasonOther : "");
  const amenities = (d.amenities || []).concat(d.amenitiesOther ? [d.amenitiesOther] : []);
  const avoid = (d.avoid || []).concat(d.avoidOther ? [d.avoidOther] : []);
  const seen = val(d.seenHomes) + (d.seenHomesLinks ? " — " + d.seenHomesLinks : "");
  return [
    { title: "Contact", rows: [
      ["Naam", fullName], ["E-mail", d.email], ["Telefoon", d.phone],
      ["Voorkeurscontact", d.contactPreference],
      ["Eerder in Puglia geweest", d.visitedBefore ? "Ja" : "Nee"],
      ["Hoe gehoord van Pugliaffari", d.source],
    ]},
    { title: "Jouw zoektocht", rows: [
      ["Doel aankoop", d.purpose], ["Belangrijkste reden", reason],
      ["Fase aankoopproces", d.processStage], ["Tijdslijn aankoop", d.timeline],
      ["Bezichtigingsreis", d.visitInterest],
    ]},
    { title: "Budget", rows: [
      ["Budget", d.budget], ["Inclusief aankoopkosten", d.budgetIncludesCosts],
      ["Financiering", d.financing],
    ]},
    { title: "Locatie", rows: [
      ["Regio voorkeur", d.region], ["Bekende plaatsen", d.knownPlaces],
      ["Belang afstand zee/vliegveld", d.distanceImportance],
    ]},
    { title: "Het pand", rows: [
      ["Type pand", d.propertyType], ["Perceel grootte", d.landSize],
      ["Voorzieningen", amenities], ["Staat van het pand", d.condition],
      ["Renovatiebegeleiding gewenst", d.renovationSupport], ["Te vermijden", avoid],
    ]},
    { title: "Leefstijl", rows: [
      ["Wie gebruikt de woning", d.mainUse], ["Reist met", d.householdTravel],
      ["Gewenst aantal slaapkamers", d.bedrooms],
    ]},
    { title: "Investering", rows: [
      ["Interesse verhuurbeheer", d.rentalManagement],
      ["Belang verhuuropbrengst", d.rentalYieldImportance],
    ]},
    { title: "Tot slot", rows: [
      ["Al woningen gezien", seen], ["Droombeschrijving", d.dreamDescription],
      ["Opmerkingen", d.remarks],
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
  select("Budget", data.budget);
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

async function buildPdf(d) {
  const sections = buildSections(d);
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
    const title = "Aankoopdossier";
    page.drawText(title, { x: W - M - bold.widthOfTextAtSize(title, 16), y: H - 52, font: bold, size: 16, color: GOLD });
    y = H - 96 - 34;
  }
  function ensure(space) {
    if (y - space < M) { page = pdf.addPage([W, H]); y = H - M; }
  }

  header();

  // Klant + datum
  const fullName = `${d.firstName || ""} ${d.lastName || ""}`.trim() || "—";
  const dateStr = new Date().toLocaleDateString("nl-BE", { day: "2-digit", month: "long", year: "numeric" });
  page.drawText(pdfSafe(fullName), { x: M, y, font: bold, size: 15, color: INK });
  y -= 16;
  page.drawText(pdfSafe(`Aankoopdossier ontvangen op ${dateStr}`), { x: M, y, font, size: 9.5, color: MUTED });
  y -= 22;

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
    p.drawText(pdfSafe("Pugliaffari — Property management & investments · Puglia, Italië"),
      { x: M, y: 30, font: italic, size: 8, color: MUTED });
    const pg = `${i + 1} / ${pages.length}`;
    p.drawText(pg, { x: W - M - font.widthOfTextAtSize(pg, 8), y: 30, font, size: 8, color: MUTED });
  });

  return await pdf.save();
}

/* ------------------------------------------------------------------ */
/* Email (Resend)                                                      */
/* ------------------------------------------------------------------ */

async function sendEmails(data, env, pdfBase64) {
  const fromEmail = env.FROM_EMAIL || "Pugliaffari <onboarding@resend.dev>";
  const internalEmail = env.INTERNAL_EMAIL || "ciao@pugliaffari.com";
  const fullName = `${data.firstName} ${data.lastName}`.trim();
  const sections = buildSections(data);

  const attachments = pdfBase64
    ? [{ filename: `Aankoopdossier-${(fullName || "Pugliaffari").replace(/[^\w\- ]/g, "").trim().replace(/\s+/g, "-")}.pdf`, content: pdfBase64 }]
    : undefined;

  const [clientRes, internalRes] = await Promise.all([
    resendSend(env, {
      from: fromEmail,
      to: data.email,
      reply_to: internalEmail,
      subject: "Uw aankoopdossier bij Pugliaffari is ontvangen",
      html: clientEmailHtml(data, fullName, sections),
      attachments,
    }),
    resendSend(env, {
      from: fromEmail,
      to: internalEmail,
      reply_to: data.email || undefined,
      subject: `Nieuwe aankoop-lead: ${fullName || data.email}`,
      html: internalEmailHtml(data, fullName, sections),
      attachments,
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

function clientEmailHtml(d, fullName, sections) {
  const name = fullName || "toekomstige eigenaar";
  return `
  <div style="font-family:Georgia,serif;background:#FBF8F2;padding:32px;color:#26261F;">
    <div style="max-width:600px;margin:0 auto;background:#fff;border-radius:14px;padding:36px;border:1px solid #E6E0D2;">
      <div style="text-align:center;margin-bottom:6px;font-family:Arial,sans-serif;letter-spacing:0.18em;font-size:12px;color:#8A6A24;">PUGLIAFFARI</div>
      <h2 style="color:#1D3528;margin:0 0 14px;text-align:center;">Beste ${esc(name)},</h2>
      <p style="line-height:1.6;">Bedankt voor het invullen van je aankoopdossier bij <strong>Pugliaffari</strong>. We hebben je wensen goed ontvangen. Ons team neemt je dossier nu in behandeling en neemt <strong>binnen 48 uur</strong> persoonlijk contact met je op met een eerste selectie van panden die aansluiten bij je wensen.</p>
      <p style="line-height:1.6;">Ter bevestiging vind je hieronder én in de bijgevoegde PDF een overzicht van wat je hebt doorgegeven:</p>
      ${sectionsTableHtml(sections)}
      <p style="margin-top:26px;line-height:1.6;">Klopt er iets niet of wil je nog iets toevoegen? Antwoord gerust op deze e-mail of schrijf naar <a href="mailto:ciao@pugliaffari.com" style="color:#8A6A24;">ciao@pugliaffari.com</a>.</p>
      <p style="margin-top:22px;">A presto,<br><strong style="color:#1D3528;">Team Pugliaffari</strong></p>
    </div>
    <div style="text-align:center;color:#9A998C;font-size:11px;margin-top:16px;font-family:Arial,sans-serif;">Pugliaffari — Property management &amp; investments · Puglia, Italië</div>
  </div>`;
}

function internalEmailHtml(d, fullName, sections) {
  return `
  <div style="font-family:Arial,sans-serif;padding:24px;color:#26261F;">
    <h2 style="color:#1D3528;margin:0 0 4px;">Nieuwe aankoop-lead: ${esc(fullName || d.email)}</h2>
    <p style="color:#75756B;font-size:13px;margin:0 0 8px;">${esc(d.email || "")}${d.phone ? " · " + esc(d.phone) : ""} · Voorkeur: ${esc(d.contactPreference || "—")}</p>
    <p style="color:#75756B;font-size:13px;margin:0 0 12px;">Het volledige dossier zit ook als PDF in de bijlage.</p>
    <div style="max-width:640px;">${sectionsTableHtml(sections)}</div>
  </div>`;
}
