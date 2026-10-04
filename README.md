# AJO Hybrid Personalization POC

Server fetches Adobe Journey Optimizer decisions via the **Edge Network Server API**; the browser renders them with **Web SDK**. Identity uses a server-set **FPID**, with an optional demo sign-in that links a **CRMID**.

## Setup

```bash
npm install
cp .env.example .env   # Windows: copy .env.example .env
```

Fill in `.env`:

```dotenv
ADOBE_ORG_ID=YOUR_ORG_ID@AdobeOrg
ADOBE_DATASTREAM_ID=YOUR_DATASTREAM_ID
AJO_SURFACE=""   # keep the quotes (# starts a comment)
```

## Run

```bash
npm run dev    # auto-restarts on changes
npm start      # plain run
```

Open http://localhost:3000.

## AJO requirements

- Datastream with Experience Platform + **Adobe Journey Optimizer** enabled
- Code-based channel configuration, platform **Other**, format **JSON**, surface = `AJO_SURFACE`
- Live campaign on that surface with content like:
  ```json
  { "title": "Hi from AJO", "subtitle": "Optional", "ctaText": "Claim offer" }
  ```

## Structure

| File | Role |
|---|---|
| `server.js` | FPID cookie, Edge Server API call, page render |
| `public/app.js` | Web SDK setup, `applyResponse`, rendering, display/click/page view events |
| `public/styles.css`, `public/stars.js` | UI and starfield |

> Learning POC only: demo sign-in has no password and consent defaults to "in".
