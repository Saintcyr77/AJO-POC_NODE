//
// What this does, in order:
//   1. Sets up Web SDK ("alloy")
//   2. Takes the decisions the SERVER already fetched (no second call to Adobe for decisions)
//   3. Renders the AJO content into the hero
//   4. Tells Adobe "displayed", "clicked", and sends the one real page view
//   5. Fills the status readouts and the event log so you can follow along


!function(n,o){o.forEach(function(o){n[o]||((n.__alloyNS=n.__alloyNS||
[]).push(o),n[o]=function(){var u=arguments;return new Promise(
function(i,l){n.setTimeout(function(){n[o].q.push([i,l,u])})})},n[o].q=[])})}
(window,["alloy"]);


// ---------------------------------------------------------------------------
// 2. Read what the server put into the page
// ---------------------------------------------------------------------------
function readJson(id) {
  var el = document.getElementById(id);
  if (!el) return null;
  try { return JSON.parse(el.textContent); } catch (e) { return null; }
}

var poc = readJson("poc-config");          // org ID, datastream, surface, login state, server's ECID
var edge = readJson("aep-edge-response");  // Adobe's full answer to the server's call (or null)


// Event log helper - adds a timestamped line to the "Event log" panel.
// kind: "info" (default), "ajo" (AJO content), "alert" (something went wrong)
function log(label, value, kind) {
  var item = document.createElement("li");
  item.setAttribute("data-kind", kind || "info");

  var time = document.createElement("time");
  time.textContent = new Date().toLocaleTimeString([], { hour12: false });

  var body = document.createElement("div");
  var lbl = document.createElement("span");
  lbl.className = "lbl";
  lbl.textContent = label;                       // textContent = shown as plain text, never run as HTML
  body.appendChild(lbl);

  if (typeof value === "string" || typeof value === "number") {
    var val = document.createElement("span");
    val.className = "val";
    val.textContent = "  " + value;
    body.appendChild(val);
  } else if (value !== undefined) {
    var pre = document.createElement("pre");      // objects are shown pretty-printed underneath
    pre.textContent = JSON.stringify(value, null, 2);
    body.appendChild(pre);
  }

  item.appendChild(time);
  item.appendChild(body);
  document.getElementById("debug").appendChild(item);
}

// Status readout helper - sets one of the values in the status grid.
// state: "ok" (green), "alert" (red), or nothing (normal colour)
function setStatus(id, text, state) {
  var el = document.getElementById(id);
  if (!el) return;
  el.textContent = text;
  if (state) el.setAttribute("data-state", state); else el.removeAttribute("data-state");
}


// ---------------------------------------------------------------------------
// 3. Configure Web SDK
// ---------------------------------------------------------------------------
alloy("configure", {
  datastreamId: poc.datastreamId,
  orgId: poc.orgId,
  edgeDomain: "edge.adobedc.net",
  thirdPartyCookiesEnabled: false,   // FPID setups can't use third-party cookies
  defaultConsent: "in",              // POC only - a real site takes this from the consent banner
  debugEnabled: true                 // Web SDK prints detailed logs in the browser console (F12)
});


// Add the CRMID to an event when logged in (case 3, stage 7).
// The ECID is added automatically by Web SDK from the kndctr_ identity cookie.
function withIdentity(xdm) {
  if (poc.loggedIn) {
    xdm.identityMap = {
      CRMID: [{ id: poc.crmId, authenticatedState: "authenticated", primary: false }]
    };
  }
  return xdm;
}

// Adobe needs these 3 fields of each proposition to know WHAT was displayed/clicked
function forTracking(propositions) {
  return propositions.map(function (p) {
    return { id: p.id, scope: p.scope, scopeDetails: p.scopeDetails };
  });
}


// ---------------------------------------------------------------------------
// 4. Render AJO content into the hero
//    Expected AJO JSON content, e.g.:
//      { "title": "Hi there!", "subtitle": "Optional line", "ctaText": "Grab 10% off" }
// ---------------------------------------------------------------------------
function renderHero(propositions) {
  var shown = [];

  propositions.forEach(function (p) {
    if (p.scope !== poc.surface) return;          // only the surface this page asked for

    (p.items || []).forEach(function (item) {
      var content = item.data && item.data.content;
      if (typeof content === "string") {          // AJO may send JSON as text - try to read it
        try { content = JSON.parse(content); } catch (e) { log("Content is not JSON", content, "alert"); return; }
      }
      if (!content || typeof content !== "object") return;

      var hero = document.getElementById("hero");
      if (content.title)    hero.querySelector(".title").textContent = String(content.title);
      if (content.subtitle) hero.querySelector(".sub").textContent = String(content.subtitle);
      if (content.ctaText)  hero.querySelector(".cta").textContent = String(content.ctaText);

      // Visual cue: chip says where the content came from + one-time sweep animation
      hero.setAttribute("data-source", "ajo");
      document.getElementById("hero-source").textContent = "Delivered by Journey Optimizer";
      hero.classList.add("arrived");

      log("AJO content rendered", content, "ajo");
      if (shown.indexOf(p) === -1) shown.push(p);
    });
  });

  return shown;
}


// ---------------------------------------------------------------------------
// 5. Events back to Adobe
// ---------------------------------------------------------------------------

// "This content was shown" - AJO counts impressions from this
function sendDisplay(shown) {
  if (!shown.length) return;
  alloy("sendEvent", {
    xdm: withIdentity({
      eventType: "decisioning.propositionDisplay",
      _experience: { decisioning: { propositions: forTracking(shown), propositionEventType: { display: 1 } } }
    })
  }).then(function () { log("Display event", "sent"); });
}

// "This content was clicked" - AJO counts clicks from this
function trackClick(shown) {
  if (!shown.length) return;
  document.querySelector("#hero .cta").addEventListener("click", function () {
    alloy("sendEvent", {
      xdm: withIdentity({
        eventType: "decisioning.propositionInteract",
        _experience: {
          decisioning: {
            propositions: forTracking(shown),
            propositionEventType: { interact: 1 },
            propositionAction: { label: "hero-cta" }
          }
        }
      })
    }).then(function () { log("Click event", "sent"); });
  });
}

// The ONE real page view (the server's call was "fetch only")
function sendPageView() {
  return alloy("sendEvent", {
    personalization: { defaultPersonalizationEnabled: false },  // server already fetched decisions
    xdm: withIdentity({
      eventType: "web.webpagedetails.pageViews",
      web: { webPageDetails: { name: "AJO POC home", pageViews: { value: 1 } } }
    })
  }).then(function () { log("Page view", "sent"); });
}


// ---------------------------------------------------------------------------
// 6. Main flow
// ---------------------------------------------------------------------------
setStatus("st-visitor", poc.isNewVisitor ? "New (case 1)" : "Returning (case 2)");
setStatus("st-login", poc.loggedIn ? poc.crmId + " (case 3)" : "Not signed in");
setStatus("st-ecid-server", poc.serverEcid || "None returned", poc.serverEcid ? null : "alert");

log("Visitor", poc.isNewVisitor ? "New: no Adobe cookies came with the request (case 1)"
                                : "Returning: Adobe cookies were forwarded (case 2)");
log("Signed in", poc.loggedIn ? "Yes, CRMID " + poc.crmId + " (case 3)" : "No (anonymous)");
log("ECID the server got from Adobe", poc.serverEcid || "none");

function showWebSdkEcid() {
  // Should be the SAME ECID as the server's - proof that server and browser agree on identity
  return alloy("getIdentity", { namespaces: ["ECID"] })
    .then(function (r) {
      var ecid = r.identity.ECID;
      var match = poc.serverEcid && ecid === poc.serverEcid;
      setStatus("st-ecid-sdk", ecid + (match ? "  (matches server)" : ""), match ? "ok" : "alert");
      log("ECID Web SDK is using", ecid);
    })
    .catch(function (err) { setStatus("st-ecid-sdk", "Unavailable", "alert"); log("getIdentity error", String(err), "alert"); });
}
if (edge && edge.body && edge.body.warnings) {
  log("Adobe warnings", edge.body.warnings, "alert");
}

if (edge && edge.body) {
  // Hand Web SDK the server's answer instead of asking Adobe again
  alloy("applyResponse", {
    renderDecisions: true,            // AJO web-channel changes render automatically
    responseHeaders: edge.headers || {},
    responseBody: edge.body
  })
    .then(function (result) {
      var propositions = (result && result.propositions) || [];
      setStatus("st-props", String(propositions.length), propositions.length ? "ok" : null);
      log("Propositions in server's answer", propositions.length);
      var shown = renderHero(propositions);
      if (!shown.length) log("Hero", "No AJO content for " + poc.surface + ", showing default");
      sendDisplay(shown);
      trackClick(shown);
    })
    .catch(function (err) { log("applyResponse error", String(err), "alert"); })
    .then(sendPageView)
    .then(showWebSdkEcid);
} else {
  setStatus("st-props", "0 (no answer from Adobe)", "alert");
  log("Server got no answer from Adobe", "Check the terminal running the server for the error. Showing default content.", "alert");
  sendPageView().then(showWebSdkEcid);
}