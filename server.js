const express = require('express');
const path = require('path');
const jwt = require('jsonwebtoken');

const app = express();
const port = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;

// LLM proxy is only wired up in production containers. Staging/standalone
// builds receive neither URL nor token, so we fall back to a canned demo.
const LLM_ENABLED = !!process.env.USERNODE_LLM_PROXY_TOKEN;
const LLM_MODEL = 'claude-sonnet-4-6';

// Paths that stay open without authentication. Add a path here (and add it
// with `app.get`/`app.post` below) if you deliberately want it public.
// Everything else requires a valid platform-issued JWT.
//
// `/api/generate` is intentionally public: with no live proxy (staging) or no
// user token it only ever returns the canned, obviously-fake DEMO payload —
// no user data, no budget spend — so previews and the automated proposal
// checks render a result instead of logging a 401 console error. A real,
// billed LLM call still requires the user's forwarded token (see below).
const PUBLIC_API_PATHS = new Set(['/health', '/api/generate']);

app.use(express.json());

// Verify platform-issued JWT if one was passed, then enforce auth on
// anything not explicitly marked public. The iframe adds `?token=…`
// on load; the frontend script forwards the token via `x-usernode-token`
// on subsequent fetches.
app.use((req, res, next) => {
  const token = req.query.token || req.headers['x-usernode-token'];
  if (token && JWT_SECRET) {
    try { req.user = jwt.verify(token, JWT_SECRET); } catch {}
  }

  // Static assets (CSS/JS/images) are always served; the API and the HTML
  // shell are gated so direct hits to the staging/prod subdomain don't
  // leak app data to the public internet.
  if (req.method !== 'GET' || req.path.startsWith('/api/')) {
    if (PUBLIC_API_PATHS.has(req.path)) return next();
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
});

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// ---------------------------------------------------------------------------
// Branding generator
// ---------------------------------------------------------------------------

// A complete, valid branding payload used whenever the live LLM is
// unavailable (staging/standalone) or the model output can't be parsed.
// It must always render so the page is never broken or empty.
const DEMO_BRANDING = {
  name: 'Lumenforge',
  tagline: 'Where ideas get their glow-up.',
  colors: ['#7c3aed', '#22d3ee', '#0f172a', '#f8fafc'],
  logoSvg:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" width="120" height="120" role="img" aria-label="Lumenforge logo">' +
    '<rect width="120" height="120" rx="24" fill="#0f172a"/>' +
    '<circle cx="60" cy="52" r="26" fill="none" stroke="#22d3ee" stroke-width="6"/>' +
    '<path d="M60 30 L60 52 L78 64" fill="none" stroke="#7c3aed" stroke-width="6" stroke-linecap="round"/>' +
    '<text x="60" y="104" text-anchor="middle" font-family="system-ui, sans-serif" font-size="20" font-weight="700" fill="#f8fafc">LF</text>' +
    '</svg>',
  pitch:
    "Let's be honest: every other name you were considering is **fine**. Lumenforge is *inevitable*.\n\n" +
    "It sounds like a place where lightning gets manufactured by people who take their craft seriously. The cyan-on-midnight palette says \"we are cutting-edge but we will not blind you,\" and the violet arc is basically a tiny compass pointing at your bright future.\n\n" +
    "You could keep brainstorming. Or you could pick the name that already has merch energy. Choose Lumenforge. Your future investors already have.",
};

// Pull the first balanced JSON object out of arbitrary model text. Handles
// prose preambles and ```json fences without choking on braces inside strings.
function extractJson(text) {
  if (!text) return null;
  let s = text.trim();
  // Strip a leading/trailing code fence if present.
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const start = s.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') {
      inStr = true;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) {
        const candidate = s.slice(start, i + 1);
        try { return JSON.parse(candidate); } catch { return null; }
      }
    }
  }
  return null;
}

// Validate/normalize a parsed branding object. Returns null if unusable so
// the caller can fall back to the demo payload.
function normalizeBranding(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const name = typeof obj.name === 'string' ? obj.name.trim() : '';
  const logoSvg = typeof obj.logoSvg === 'string' ? obj.logoSvg.trim() : '';
  const pitch = typeof obj.pitch === 'string' ? obj.pitch.trim() : '';
  let colors = Array.isArray(obj.colors)
    ? obj.colors.filter((c) => typeof c === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(c.trim())).map((c) => c.trim())
    : [];
  if (!name || !logoSvg || !/<svg[\s>]/i.test(logoSvg) || colors.length < 3) return null;
  colors = colors.slice(0, 5);
  return {
    name,
    tagline: typeof obj.tagline === 'string' ? obj.tagline.trim() : '',
    colors,
    logoSvg,
    pitch: pitch || `${name} is the only correct choice. Trust the process.`,
  };
}

const SYSTEM_PROMPT = [
  'You are Namer2000, a wildly overconfident, very funny brand strategist.',
  'Your job: invent ONE original brand identity for a software project and hard-sell it.',
  'You ALWAYS respond with a single JSON object and NOTHING else — no prose, no code fences.',
  'The JSON object has exactly these keys:',
  '  "name": a punchy, original, made-up brand name (1-3 words).',
  '  "tagline": a short one-liner slogan.',
  '  "colors": an array of 3 to 5 hex color strings (e.g. "#7c3aed") forming a cohesive palette with good contrast.',
  '  "logoSvg": a COMPLETE, self-contained inline SVG document string (start with <svg xmlns=...>, include a viewBox and width/height around 120). Use ONLY colors from your palette. Build it from simple geometric shapes and text — a tasteful monogram or wordmark. NO external images, NO <script>, NO <foreignObject>, NO event handlers.',
  '  "pitch": 2-3 short punchy paragraphs (markdown allowed: **bold**, *italic*). Be opinionated, hilarious, and aggressively convince the user that THIS name and logo are the obvious, only correct choice. Lean into the bit — own any quirk of the logo as a feature.',
  'Keep the SVG compact. Make every generation feel distinct.',
].join('\n');

app.post('/api/generate', async (req, res) => {
  const userToken = req.headers['x-usernode-token'];

  // No live proxy (staging / standalone), or no signed-in user to bill the
  // call to (anonymous preview / automated checks) — serve the demo payload.
  // This keeps the endpoint public-safe: it never errors and never spends a
  // user's budget without their token.
  if (!LLM_ENABLED || !userToken) {
    return res.json({ ...DEMO_BRANDING, demo: true });
  }

  try {
    const nonce = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const resp = await fetch(`${process.env.USERNODE_LLM_PROXY_URL}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        'x-usernode-app-token': process.env.USERNODE_LLM_PROXY_TOKEN,
        'x-usernode-user-token': req.headers['x-usernode-token'],
      },
      body: JSON.stringify({
        model: LLM_MODEL,
        max_tokens: 2000,
        temperature: 1,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content:
              'Generate a fresh, original brand identity for a fun indie software project. ' +
              'Surprise me — make it memorable and distinct from anything generic. ' +
              `(variation token: ${nonce}) Respond with the JSON object only.`,
          },
        ],
      }),
    });

    if (!resp.ok) {
      // Forward the platform's consent/cap codes faithfully so the frontend
      // can trigger the grant dialog or show the right message.
      let code;
      try { code = (await resp.json()).code; } catch {}
      if (resp.status === 403) return res.status(403).json({ code: code || 'grant_required' });
      if (resp.status === 429) return res.status(429).json({ code: code || 'app_cap_exceeded' });
      return res.status(502).json({ error: 'The branding machine is jammed. Try again.' });
    }

    const data = await resp.json();
    const text = Array.isArray(data.content)
      ? data.content.filter((b) => b.type === 'text').map((b) => b.text).join('')
      : '';
    const branding = normalizeBranding(extractJson(text));

    // Parsing failed — degrade gracefully rather than 500.
    if (!branding) return res.json({ ...DEMO_BRANDING, demo: true });
    return res.json(branding);
  } catch (err) {
    return res.status(502).json({ error: 'The branding machine is jammed. Try again.' });
  }
});

app.use(express.static(path.join(__dirname, 'public')));

// HTML shell: serve the app if authenticated, otherwise an "open in Usernode"
// landing page so stray visits to the staging URL don't reveal the app.
app.get('*', (req, res) => {
  if (!req.user) {
    return res.status(401).send(`<!doctype html><meta charset=utf-8><title>Open in Usernode</title>
<body style="font-family:system-ui;background:#09090b;color:#e4e4e7;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">
  <div style="max-width:24rem;padding:2rem;text-align:center">
    <h1 style="font-size:1.25rem;margin:0 0 0.5rem">Open this app inside Usernode</h1>
    <p style="color:#a1a1aa;font-size:0.9rem;margin:0 0 1.25rem">This page is served via the platform; direct visits aren't authenticated.</p>
    <a href="https://social-vibecoding.usernodelabs.org" style="display:inline-block;padding:0.5rem 1rem;background:#7c3aed;color:white;border-radius:0.5rem;text-decoration:none;font-size:0.9rem">Go to Usernode</a>
  </div>
</body>`);
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(port, () => console.log(`Listening on :${port}`));
