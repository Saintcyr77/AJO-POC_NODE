// server.js - AJO hybrid personalization POC (runs on your laptop, no real website needed)
//
// Folder layout:
//   ajo-poc-node/
//     server.js        <- this file (the "server" half)
//     public/app.js    <- the "browser" half (Web SDK)
//     package.json
//
// Run:
//   npm install
//   cp .env.example .env      (then put your org ID + datastream ID in .env)
//   npm start
//   open http://localhost:3000 in Chrome
//
// What happens on every page load (same as cases 1, 2, 3 we talked about):
//   1. Find the visitor's FPID cookie, or create one if they're new
//   2. Collect the Adobe "kndctr_" cookies the browser sent
//   3. Check if the visitor is "logged in" (demo login) and get their CRMID
//   4. Call Adobe Edge (Server API) and ask for AJO decisions
//   5. Save the cookies Adobe asked us to store, plus the FPID
//   6. Send the page with Adobe's answer embedded, so Web SDK can render it

// Reads the .env file and puts its values into process.env (does nothing if there's no .env file)
require("dotenv").config();

const express = require("express");
const cookieParser = require("cookie-parser");
const crypto = require("crypto");


// =============================================================================
// SETTINGS - read from environment variables (your .env file), never hardcoded,
// so the code can go on GitHub without your IDs in it.
// =============================================================================

const ORG_ID = process.env.ADOBE_ORG_ID;               // e.g. "ABC123DEF456@AdobeOrg"
const DATASTREAM_ID = process.env.ADOBE_DATASTREAM_ID; // datastream with AEP + "Adobe Journey Optimizer" enabled

// The AJO code-based surface (the "location") this page asks for.
// Must EXACTLY match the surface in your AJO code-based channel configuration.
const SURFACE = process.env.AJO_SURFACE || "web://ajo-poc.local/#hero";

// Adobe Edge host. Works without an access token when the datastream Access Type is "Mixed" (default).
const EDGE_HOST = process.env.EDGE_HOST || "edge.adobedc.net";

const PORT = Number(process.env.PORT) || 3000;

// Stop straight away with a clear message if the IDs are missing
if (!ORG_ID || !DATASTREAM_ID) {
  console.error("Missing ADOBE_ORG_ID or ADOBE_DATASTREAM_ID.");
  console.error("Copy .env.example to .env, fill in your values, and run npm start again.");
  process.exit(1);
}


// =============================================================================
// CONSTANTS - no need to change
// =============================================================================

const FPID_COOKIE_NAME = "FPID";
const FPID_LIFETIME_MS = 395 * 24 * 60 * 60 * 1000;    // ~13 months

// Adobe's cookie names: "kndctr_<org id with @ replaced by _>_identity" and "..._cluster"
const ADOBE_COOKIE_PREFIX = "kndctr_" + ORG_ID.replace("@", "_") + "_";

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REGION_PATTERN = /^[a-z0-9]{2,12}$/i;
const CRM_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;        // what we accept as a demo CRMID

const PERSONALIZATION_SCHEMAS = [
  "https://ns.adobe.com/personalization/default-content-item",
  "https://ns.adobe.com/personalization/html-content-item",
  "https://ns.adobe.com/personalization/json-content-item",
  "https://ns.adobe.com/personalization/dom-action",
];

// Secret used to sign the demo login cookie. Random on every start = everyone is logged out on restart.
const COOKIE_SECRET = process.env.COOKIE_SECRET || crypto.randomBytes(32).toString("hex");


const app = express();
app.disable("x-powered-by");
app.use(cookieParser(COOKIE_SECRET));                  // reads cookies into req.cookies / req.signedCookies
app.use(express.urlencoded({ extended: false, limit: "2kb" }));   // reads the login form
app.use(express.static("public"));                     // serves public/app.js


// =============================================================================
// STEP 1 - FPID: reuse the visitor's device ID, or create one
// =============================================================================

function getOrCreateFpid(req) {
  const fpid = req.cookies[FPID_COOKIE_NAME];
  if (typeof fpid === "string" && UUID_V4_PATTERN.test(fpid)) {
    return fpid;                    // CASE 2: returning visitor - keep their FPID
  }
  return crypto.randomUUID();       // CASE 1: new visitor - make a fresh random ID (UUID v4)
}


// =============================================================================
// STEP 2 - Adobe cookies the browser sent us
// =============================================================================

function getAdobeCookies(req) {
  // Pick out Adobe's kndctr_ cookies so we can hand them to Adobe ("state entries")
  return Object.entries(req.cookies)
    .filter(([name, value]) => name.startsWith(ADOBE_COOKIE_PREFIX) && typeof value === "string" && value.length < 4096)
    .map(([name, value]) => ({ key: name, value: value }));
}

function getRegion(req) {
  // Which Adobe data centre served this visitor last time (from the cluster cookie)
  const region = req.cookies[ADOBE_COOKIE_PREFIX + "cluster"];
  return typeof region === "string" && REGION_PATTERN.test(region) ? region : null;
}


// =============================================================================
// STEP 3 - Logged in? (demo login - see /login below)
// =============================================================================

function getLoggedInCrmId(req) {
  // CASE 3: the CRMID comes from OUR signed cookie, never from something the browser can fake.
  // (signedCookies = cookies we signed with COOKIE_SECRET; a tampered value comes back as false)
  const crmId = req.signedCookies.crm_id;
  return typeof crmId === "string" && CRM_ID_PATTERN.test(crmId) ? crmId : null;
}


// =============================================================================
// STEP 4 - Ask Adobe Edge for AJO decisions
// =============================================================================

async function askAdobeForDecisions(req, fpid, crmId, adobeCookies, region) {
  // Who is this? FPID = the device ("ambiguous" = we don't know which person)
  const identityMap = {
    FPID: [{ id: fpid, authenticatedState: "ambiguous", primary: true }],
  };
  // Logged in? Add the person ID. Sending both together LINKS them in Adobe.
  if (crmId) {
    identityMap.CRMID = [{ id: crmId, authenticatedState: "authenticated", primary: false }];
  }

  const body = {
    event: {
      xdm: {
        // Fetch decisions only - NOT an Analytics page view (the browser sends that)
        eventType: "decisioning.propositionFetch",
        timestamp: new Date().toISOString(),
        identityMap: identityMap,
        web: { webPageDetails: { URL: `${req.protocol}://${req.get("host")}${req.originalUrl}` } },
      },
    },
    query: {
      identity: { fetch: ["ECID"] },        // tell us which ECID you resolved
      personalization: { schemas: PERSONALIZATION_SCHEMAS, surfaces: [SURFACE] },
    },
    meta: {
      state: {
        domain: req.hostname,               // "localhost" for this POC
        cookiesEnabled: true,
        entries: adobeCookies,              // how Adobe recognises a RETURNING visitor
      },
    },
  };

  // Same region as last time if known, e.g. https://edge.adobedc.net/ee/or2/v2/interact
  const regionPart = region ? "/" + region : "";
  const url = `https://${EDGE_HOST}/ee${regionPart}/v2/interact?dataStreamId=${encodeURIComponent(DATASTREAM_ID)}`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": req.get("user-agent") || "" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(2000),    // don't wait more than 2 seconds
    });

    if (!response.ok) {
      // Adobe's error body explains what's wrong (bad datastream ID, etc.) - useful while setting up
      const errorText = (await response.text()).slice(0, 500);
      console.warn(`Adobe Edge returned ${response.status}: ${errorText}`);
      return null;
    }
    return { headers: Object.fromEntries(response.headers.entries()), body: await response.json() };

  } catch (error) {
    console.warn("Adobe Edge call failed:", error.name);
    return null;
  }
}

function findEcid(adobeAnswer) {
  // Pull the ECID out of Adobe's answer (the "identity:result" handle) - just to show it on the page
  for (const handle of adobeAnswer.body.handle || []) {
    if (handle.type !== "identity:result") continue;
    for (const item of handle.payload || []) {
      if (item.namespace && item.namespace.code === "ECID") return item.id;
    }
  }
  return null;
}


// =============================================================================
// STEP 5 - Save cookies
// =============================================================================

function saveAdobeCookies(req, res, adobeAnswer) {
  // Adobe's "state:store" handles = "please save these cookies" (identity + cluster)
  for (const handle of adobeAnswer.body.handle || []) {
    if (handle.type !== "state:store") continue;
    for (const cookie of handle.payload || []) {
      if (typeof cookie.key !== "string" || !cookie.key.startsWith(ADOBE_COOKIE_PREFIX)) continue;
      res.cookie(cookie.key, String(cookie.value), {
        maxAge: Number.isFinite(cookie.maxAge) ? cookie.maxAge * 1000 : undefined,  // Adobe gives seconds, Express wants ms
        path: "/",
        secure: req.secure,       // true on a real https site, false on http://localhost
        sameSite: "lax",
        httpOnly: false,          // Web SDK in the browser must be able to read these
        // No "domain" here: on localhost cookies must be host-only.
        // On a real site you'd add domain: ".yoursite.com"
      });
    }
  }
}

function saveFpidCookie(req, res, fpid) {
  // Re-send the FPID every visit to keep pushing its expiry forward. httpOnly = scripts can't touch it.
  res.cookie(FPID_COOKIE_NAME, fpid, {
    maxAge: FPID_LIFETIME_MS,
    path: "/",
    secure: req.secure,
    sameSite: "lax",
    httpOnly: true,
  });
}


// =============================================================================
// STEP 6 - The page
// =============================================================================

// Makes data safe to put inside a <script type="application/json"> block
function jsonForHtml(data) {
  return JSON.stringify(data === undefined ? null : data)
    .replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

// Makes text safe to show inside HTML
function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function renderPage(poc, adobeAnswer) {
  // Top-right: sign-in form when anonymous, signed-in chip + sign-out when logged in (case 3)
  const signIn = poc.loggedIn
    ? `<form class="signin" method="post" action="/logout">
         <span class="who">Signed in as <b>${escapeHtml(poc.crmId)}</b></span>
         <button class="ghost" type="submit">Sign out</button>
       </form>`
    : `<form class="signin" method="post" action="/login">
         <label for="crm">Test CRMID</label>
         <input id="crm" name="crm_id" placeholder="cust-001" required autocomplete="off"
                pattern="[A-Za-z0-9_\\-]{1,64}" title="Letters, numbers, - and _ only">
         <button type="submit">Sign in</button>
       </form>`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>AJO hybrid console</title>

  <!-- Fonts + our stylesheet (public/styles.css) -->
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=Rajdhani:wght@500;600;700&display=swap">
  <link rel="stylesheet" href="/styles.css">

  <!-- Data from the server. type="application/json" = just data, not code. -->
  <script type="application/json" id="poc-config">${jsonForHtml(poc)}</script>
  <script type="application/json" id="aep-edge-response">${jsonForHtml(adobeAnswer)}</script>
</head>
<body>
  <!-- Background: drifting stars + shooting stars, drawn by public/stars.js -->
  <canvas id="starfield" aria-hidden="true"></canvas>

  <div class="shell">
    <header class="bar">
      <div class="brand"><span class="brand-mark" aria-hidden="true"></span>AJO hybrid console</div>
      ${signIn}
    </header>

    <main>
      <!-- The personalized spot. Starts with DEFAULT content; app.js swaps in the AJO content. -->
      <section id="hero" class="transmission" data-source="default" aria-live="polite">
        <span class="source" id="hero-source">Default content</span>
        <h1 class="title">Welcome aboard</h1>
        <p class="sub">This panel shows the site's default content until a Journey Optimizer decision replaces it.</p>
        <button class="cta" type="button">Explore the ship</button>
      </section>

      <!-- Live identity + decision status, filled in by app.js -->
      <section class="readouts" aria-label="Identity and decision status">
        <dl>
          <div><dt>Visitor</dt><dd id="st-visitor">Checking</dd></div>
          <div><dt>Signed in as</dt><dd id="st-login">Checking</dd></div>
          <div><dt>Decisions received</dt><dd id="st-props">Waiting</dd></div>
          <div class="wide"><dt>ECID from server</dt><dd id="st-ecid-server" class="mono">Waiting</dd></div>
          <div class="wide"><dt>ECID in Web SDK</dt><dd id="st-ecid-sdk" class="mono">Waiting</dd></div>
        </dl>
      </section>

      <!-- Step-by-step log of what happened, written by app.js -->
      <section class="log" aria-label="Event log">
        <h2>Event log</h2>
        <ol id="debug"></ol>
      </section>
    </main>
  </div>

  <!-- 1) starfield  2) our browser code (sets up Web SDK)  3) the Web SDK library itself -->
  <script src="/stars.js"></script>
  <script src="/app.js"></script>
  <script src="https://cdn1.adoberesources.net/alloy/2.32.0/alloy.min.js" async></script>
</body>
</html>`;
}


app.get("/", async (req, res) => {
  const fpid = getOrCreateFpid(req);                                   // STEP 1
  const adobeCookies = getAdobeCookies(req);                           // STEP 2
  const region = getRegion(req);
  const crmId = getLoggedInCrmId(req);                                 // STEP 3
  const adobeAnswer = await askAdobeForDecisions(req, fpid, crmId, adobeCookies, region);   // STEP 4

  // Values the browser code (public/app.js) needs
  const poc = {
    orgId: ORG_ID,
    datastreamId: DATASTREAM_ID,
    surface: SURFACE,
    loggedIn: Boolean(crmId),
    crmId: crmId,
    serverEcid: adobeAnswer ? findEcid(adobeAnswer) : null,
    isNewVisitor: adobeCookies.length === 0,       // no Adobe cookies came in = first visit
  };

  saveFpidCookie(req, res, fpid);                                      // STEP 5
  if (adobeAnswer) saveAdobeCookies(req, res, adobeAnswer);

  // Personalized page - never cache. Basic Content-Security-Policy for the POC.
  res.set("Cache-Control", "private, no-store");
  res.set("Content-Security-Policy",
    "default-src 'self'; " +
    "script-src 'self' https://cdn1.adoberesources.net; " +
    "connect-src 'self' https://*.adobedc.net; " +
    "style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; " +
    "img-src 'self' data:; form-action 'self'");

  res.send(renderPage(poc, adobeAnswer));                              // STEP 6
});


// =============================================================================
// DEMO LOGIN / LOGOUT - POC ONLY. No password: you just type a test CRMID.
// In a real site this is your actual login system.
// =============================================================================

app.post("/login", (req, res) => {
  const crmId = String(req.body.crm_id || "").trim();
  if (CRM_ID_PATTERN.test(crmId)) {
    res.cookie("crm_id", crmId, { signed: true, httpOnly: true, sameSite: "lax", secure: req.secure, path: "/" });
  }
  res.redirect("/");   // reload the page -> next server call includes the CRMID (case 3, flavor A)
});

app.post("/logout", (req, res) => {
  res.clearCookie("crm_id", { path: "/" });
  res.redirect("/");
});


app.listen(PORT, "localhost", () => {
  console.log(`AJO hybrid POC running: http://localhost:${PORT}`);
  console.log(`Using datastream: ${DATASTREAM_ID}`);
});