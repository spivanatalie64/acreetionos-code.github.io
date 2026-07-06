// Cloudflare Worker — AIDEN AI proxy + Page View Counter + Audio Transcription
// Holds the API key securely on the server, never exposed to the browser
// Maintainers: Natalie Spiva (spivanatalie64), Darren Clift (cobra3282000)
// Website: https://acreetionos.org — contact via the project channels for AIDEN
// The worker proxies the site to OpenRouter server-side. Pollinations.ai support removed.
// This worker provides:
//   GET  /api/news    — aggregates AcreetionOS news from GitHub, GitLab, and RSS, generates articles with AI
//   POST /api/chat    — server-side OpenRouter chat (free model)
//   POST /api/transcribe — audio transcription via OpenRouter Whisper (free)
//   GET  /api/counter — returns current active user count
//   POST /api/counter — increments and returns new count

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const WHISPER_URL = 'https://openrouter.ai/api/v1/audio/transcriptions';
const TTS_URL = 'https://openrouter.ai/api/v1/audio/speech';
// Use only explicitly free community models. Keep the values in one place.
const FREE_MODEL = 'openrouter/auto';
const WHISPER_MODEL = 'openai/whisper-large-v3';
const TTS_MODEL = 'cartesia-ai/cartesia-tts';
const ALLOWED_ORIGINS = [
  'https://acreetionos.org',
  'https://www.acreetionos.org',
  'https://acreetionos-code.github.io',
  'http://localhost:8080',
  'http://localhost:3000',
  'http://127.0.0.1:8080',
  'http://127.0.0.1:3000'
];

function securityHeaders() {
  return {
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains; preload',
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://static.cloudflareinsights.com https://ajax.cloudflare.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net; img-src 'self' data: https:; font-src 'self' https://fonts.gstatic.com https://cdn.jsdelivr.net; connect-src 'self' https://api.github.com https://gitlab.acreetionos.org https://cloudflareinsights.com https://openrouter.ai; base-uri 'self'; form-action 'self' https://www.qwant.com"
  };
}

function corsHeaders(request) {
  const origin = request.headers.get('Origin') || '';
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Content-Encoding, Authorization',
    'Access-Control-Max-Age': '86400',
    ...securityHeaders()
  };
}

let visitorCount = 0;
let lastPersistTime = 0;
const CACHE_KEY = 'https://acreetion-counter/count';

async function loadCount() {
  try {
    const cache = caches.default;
    const cached = await cache.match(CACHE_KEY);
    if (cached) {
      const data = await cached.json();
      visitorCount = data.count || 0;
    }
  } catch (e) {}
}

async function persistCount() {
  try {
    const cache = caches.default;
    const response = new Response(JSON.stringify({ count: visitorCount, ts: Date.now() }), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 's-maxage=86400' }
    });
    // Don't await — fire and forget
    cache.put(CACHE_KEY, response.clone());
  } catch (e) {}
}

async function handleNews(env) {
  const GH_ORG = 'AcreetionOS-Code';
  const GL_URL = 'https://gitlab.acreetionos.org';
  const RSS_FEEDS = [
    'https://news.google.com/rss/search?q=%22AcreetionOS%22&hl=en-US&gl=US&ceid=US:en',
    'https://news.google.com/rss/search?q=AcreetionOS+Arch+Linux&hl=en-US&gl=US&ceid=US:en',
    'https://news.google.com/rss/search?q=Arch+Linux+news&hl=en-US&gl=US&ceid=US:en'
  ];

  try {
    const [gh, gl, rss] = await Promise.all([
      (async () => {
        try {
          const reposRes = await fetch('https://api.github.com/orgs/' + GH_ORG + '/repos?per_page=5&sort=pushed');
          if (!reposRes.ok) return [];
          const repos = await reposRes.json();
          const repoFetches = repos.slice(0, 3).map(repo =>
            Promise.all([
              fetch('https://api.github.com/repos/' + GH_ORG + '/' + repo.name + '/commits?per_page=2'),
              fetch('https://api.github.com/repos/' + GH_ORG + '/' + repo.name + '/releases?per_page=1')
            ]).then(async ([commitsRes, releasesRes]) => {
              const items = [];
              if (commitsRes.ok) {
                const commits = await commitsRes.json();
                for (const c of commits) {
                  items.push({ type: 'commit', repo: repo.name, message: (c.commit.message || '').split('\n')[0], author: c.commit.author?.name || 'Unknown', date: c.commit.author?.date, url: c.html_url, source: 'GitHub' });
                }
              }
              if (releasesRes.ok) {
                const releases = await releasesRes.json();
                for (const r of releases) {
                  items.push({ type: 'release', repo: repo.name, name: r.tag_name, desc: (r.body || '').split('\n')[0], date: r.published_at || r.created_at, url: r.html_url, source: 'GitHub' });
                }
              }
              return items;
            }).catch(() => [])
          );
          const nested = await Promise.all(repoFetches);
          return nested.flat();
        } catch (e) { return []; }
      })(),
      (async () => {
        try {
          const projectsRes = await fetch(GL_URL + '/api/v4/projects?per_page=5&order_by=last_activity_at');
          if (!projectsRes.ok) return [];
          const projects = await projectsRes.json();
          const projFetches = projects.slice(0, 3).map(proj =>
            fetch(GL_URL + '/api/v4/projects/' + proj.id + '/repository/commits?per_page=2')
              .then(async (commitsRes) => {
                const items = [];
                if (commitsRes.ok) {
                  const commits = await commitsRes.json();
                  for (const c of commits) {
                    items.push({ type: 'commit', repo: proj.path_with_namespace || proj.name, message: c.title || c.message || '', author: c.author_name || 'Unknown', date: c.created_at, url: c.web_url || (GL_URL + '/' + proj.path_with_namespace + '/-/commit/' + c.id), source: 'GitLab' });
                  }
                }
                return items;
              }).catch(() => [])
          );
          const nested = await Promise.all(projFetches);
          return nested.flat();
        } catch (e) { return []; }
      })(),
      (async () => {
        const feedFetches = RSS_FEEDS.map(feedUrl =>
          fetch(feedUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AcreetionOS-News-Bot)' } })
            .then(async (res) => {
              if (!res.ok) return [];
              const xml = await res.text();
              const items = xml.match(/<item>[\s\S]*?<\/item>/gi) || [];
              return items.slice(0, 4).map(item => {
                const title = (item.match(/<title>(?:<!\[CDATA\[)?([^\]]*)(?:\]\]>)?<\/title>/) || [,''])[1].trim();
                const link = (item.match(/<link>(?:<!\[CDATA\[)?([^\]]*)(?:\]\]>)?<\/link>/) || [,''])[1].trim();
                const desc = (item.match(/<description>(?:<!\[CDATA\[)?([^\]]*)(?:\]\]>)?<\/description>/) || [,''])[1].trim().replace(/<[^>]+>/g, '').slice(0, 200);
                const pubDate = (item.match(/<pubDate>([^<]*)<\/pubDate>/) || [,''])[1];
                if (title && link) return { type: 'news', message: title, desc, date: pubDate, url: link, source: 'Google News' };
                return null;
              }).filter(Boolean);
            }).catch(() => [])
        );
        const nested = await Promise.all(feedFetches);
        return nested.flat();
      })()
    ]);

    const directArticles = gh.filter(a => a.type === 'release').slice(0, 3).concat(gl.slice(0, 2)).concat(rss.slice(0, 4)).slice(0, 6).map(item => ({
      type: 'direct',
      title: item.type === 'release' ? item.name + ' released' : item.message || 'AcreetionOS update',
      desc: item.desc || item.message || 'Recent activity from ' + item.source,
      tag: item.type === 'release' ? 'Release' : 'Community',
      tagClass: item.type === 'release' ? 'tag-release' : 'tag-community',
      url: item.url || 'https://acreetionos.org',
      source: item.source || 'acreetionos.org',
      date: item.date
    }));

    const activityData = [...gh, ...gl, ...rss].sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));

    return new Response(JSON.stringify({
      articles: directArticles,
      activity: activityData.slice(0, 20).map(a => ({
        type: a.type, repo: a.repo || '', message: a.message || a.name || '', author: a.author || '', date: a.date, url: a.url || '', source: a.source || ''
      })),
      meta: { directFound: directArticles.length, activityCount: activityData.length }
    }), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300', ...corsHeaders({ headers: { get: () => '' } }) }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: 'News fetch failed', articles: [], activity: [] }), {
      status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders({ headers: { get: () => '' } }) }
    });
  }
}

// ─── Hosting Provider Vetting ─────────────────────────────────

const THREAT_ACTORS = new Set([
  'lazarus', 'kimsuks', 'apt38', 'hiddencobra', 'bluenoroff',
  'fancybear', 'apt28', 'sofacy', 'pawnstorm', 'sednit',
  'cozybear', 'apt29', 'midnightblizzard', 'nobelium',
  'wizardspider', 'trickbot', 'fin7', 'carbanak',
  'darkhotel', 'apt32', 'oceanlotus', 'mustangpanda',
  'taowu', 'panda', 'apt1', 'commentcrew',
  'shuckworm', 'armageddon', 'gamaredon', 'actinium',
  'belarusian', 'ghostwriter', 'unc1151', 'stardust',
  'sandworm', 'apt44', 'blackenergy', 'telebots',
  'scatteredspider', 'scatteredsPIDEr', '0ktapus', 'octopus',
  'apt41', 'winnti', 'blacktech', 'bronzesunset',
  'bluenorthern', 'redquiet', 'blessed', 'muddywater',
  'tortoiseshell', 'imperialkitten', 'raqqah', 'thedarkoverlord',
  'darkoverlord', 'thedarkoverlord', 'thedarkoverlord',
  'conti', 'revil', 'ransomware', 'lockbit', 'blackcat',
  'alphv', 'clop', 'cryak', 'darkside', 'blackmatter',
  'blypts', 'grief', 'nokoyawa', 'vicesociety', 'ransomhouse',
  'vigorous', 'rigorous', 'hades', 'hellokitty',
  'lapsus', 'lapus', 'lgroth', 'teamtnt', 'webshell',
  'chinanet', 'barium', 'mgbot', 'mirai', 'botnet',
  'c2server', 'payloadbin', 'ddos', 'stresser', 'booter',
  'nulled', 'cracked', 'hackforums', 'raidforums',
  'breachforums', 'exploit', 'exploit.in', 'xss.is',
  'dread', 'hackerwanted', 'mostwanted', 'cybercriminal',
  'carding', 'carder', 'dumps', 'fullz', 'ssndob',
  'hijack', 'phish', 'phishing', 'malware', 'ransomware',
  'bankingtrojan', 'infostealer', 'inifil', 'formbook',
  'agenttesla', 'nanocore', 'remcos', 'darkcomet',
]);

const SANCTIONED_COUNTRIES = ['iran', 'north korea', 'syria', 'cuba', 'russia', 'belarus', 'crimea'];

async function checkEmailBreaches(env, email) {
  // Have I Been Pwned k-anonymity API (no key needed)
  try {
    const crypto = globalThis.crypto || {};
    const encoder = new TextEncoder();
    const data = encoder.encode(email);
    const hashBuffer = await crypto.subtle.digest('SHA-1', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
    const prefix = hashHex.slice(0, 5);
    const suffix = hashHex.slice(5);
    const res = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`, { signal: AbortSignal.timeout(10000) });
    if (res.ok) {
      const text = await res.text();
      const match = text.split('\n').find(line => line.startsWith(suffix));
      if (match) {
        const count = parseInt(match.split(':')[1] || '0');
        if (count > 3) return { breached: true, breach_count: count, url: `https://haveibeenpwned.com/account/${encodeURIComponent(email)}` };
      }
    }
  } catch (e) { console.error('HIBP check failed:', e); }
  return { breached: false };
}

async function validateOrgDomain(env, email, org, isPersonal) {
  // Skip validation if personal checkbox was checked
  if (isPersonal) return { valid: true, note: 'personal' };

  const domain = email.split('@')[1];
  if (!domain) return { valid: false, reason: 'Invalid email domain' };

  // Known open source project hosting platforms
  const ossPlatforms = ['github.io', 'gitlab.io', 'bitbucket.io', 'sourceforge.io', 'gitlab.com', 'github.com'];
  const isOSS = ossPlatforms.some(p => domain.endsWith('.' + p) || domain === p);
  if (isOSS) return { valid: true, note: 'open_source_platform' };

  try {
    // Check if domain has a resolvable website (proves it's a real organization)
    const headRes = await fetch(`https://${domain}`, {
      method: 'HEAD',
      signal: AbortSignal.timeout(8000)
    }).catch(() => null);

    // Also check www subdomain
    const wwwRes = !headRes?.ok ? await fetch(`https://www.${domain}`, {
      method: 'HEAD',
      signal: AbortSignal.timeout(8000)
    }).catch(() => null) : headRes;

    if (wwwRes?.ok || headRes?.ok) {
      return { valid: true, note: 'verified_domain' };
    }

    // Try HTTP as fallback
    const httpRes = !headRes && !wwwRes ? await fetch(`http://${domain}`, {
      method: 'HEAD',
      signal: AbortSignal.timeout(5000)
    }).catch(() => null) : null;

    if (httpRes?.ok) {
      return { valid: true, note: 'verified_domain_http' };
    }

    return { valid: false, reason: `Domain "${domain}" has no reachable website. Organization email must belong to an open source project or business with an active website, or check "personal use".` };
  } catch (e) {
    return { valid: false, reason: `Could not verify domain "${domain}": ${e.message}` };
  }
}

async function vetProvider(env, body) {
  const { org, email, website, mirror_url, location, notes } = body;
  const flags = [];
  let score = 0;

  const orgLower = (org || '').toLowerCase();
  const emailLower = (email || '').toLowerCase();
  const notesLower = (notes || '').toLowerCase();
  const locationLower = (location || '').toLowerCase();

  // 1. Check org name against known threat actors
  for (const actor of THREAT_ACTORS) {
    if (orgLower.includes(actor)) {
      flags.push(`Organization name matches known threat actor keyword: "${actor}"`);
      score += 50;
    }
    if (notesLower.includes(actor) || emailLower.includes(actor)) {
      flags.push(`Communication references threat actor: "${actor}"`);
      score += 40;
    }
  }

  // 2. Check email for breach history
  const breachCheck = await checkEmailBreaches(env, email);
  if (breachCheck.breached) {
    flags.push(`Email appears in ${breachCheck.breach_count} known data breaches (${breachCheck.url})`);
    score += breachCheck.breach_count > 20 ? 30 : 15;
  }

  // 3. Check domain against threat intel blocklist
  let domain = '';
  try {
    domain = new URL(mirror_url || website || '').hostname.replace(/^www\./, '').toLowerCase();
  } catch (e) {}
  if (domain && env.CLOUDFLARE_API_TOKEN && env.CLOUDFLARE_ACCOUNT_ID) {
    const blockedDomains = [];
    try {
      const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/r2/buckets/acreetionos-hosting/objects/threat-intel%2Fall-blocked-domains.txt`, {
        headers: { 'Authorization': `Bearer ${env.CLOUDFLARE_API_TOKEN}` }
      });
      if (res.ok) {
        const text = await res.text();
        blockedDomains.push(...text.split('\n').map(s => s.trim().toLowerCase()).filter(Boolean));
      }
    } catch (e) {}
    for (const b of blockedDomains) {
      if (domain === b || domain.endsWith('.' + b)) {
        flags.push(`Domain "${domain}" appears in threat intelligence blocklist (matched: ${b})`);
        score += 45;
        break;
      }
    }
  }

  // 4. Check location against sanctioned countries
  for (const country of SANCTIONED_COUNTRIES) {
    if (locationLower.includes(country)) {
      flags.push(`Location "${location}" is a sanctioned/embargoed country`);
      score += 40;
    }
  }

  // 5. Check notes for suspicious patterns
  const suspiciousPatterns = [
    { pattern: /(credit.?card|cc.?num|ssn|social.?security|dumps|fullz)/i, weight: 40, msg: 'Financial fraud indicators in notes' },
    { pattern: /(hack|crack|c2|rat|remote.?access.?trojan|keylogger|spyware)/i, weight: 35, msg: 'Hacking tools referenced in notes' },
    { pattern: /(terrorist|extremist|jihad|isil|isis|taliban)/i, weight: 50, msg: 'Extremist references in notes' },
    { pattern: /(proxy|vpn|relay|tor|onion|i2p)/i, weight: 5, msg: 'Anonymization tools referenced' },
    { pattern: /(money.?launder|wash|sanction.?evade|tax.?haven)/i, weight: 45, msg: 'Financial crime indicators in notes' },
  ];
  for (const sp of suspiciousPatterns) {
    if (sp.pattern.test(notesLower) || sp.pattern.test(orgLower)) {
      flags.push(sp.msg);
      score += sp.weight;
    }
  }

  // 6. Check if email domain is a disposable/temporary email provider
  const disposableDomains = [
    'mailinator.com', 'guerrillamail.com', 'tempmail.com', '10minutemail.com',
    'throwaway.email', 'yopmail.com', 'mail.tm', 'tempmail.net', 'temp-mail.org',
    'dispostable.com', 'getnada.com', 'sharklasers.com', 'burnermail.io',
    'spamgourmet.com', 'mailmetrash.com', 'trashmail.com', 'fakeinbox.com',
    'mailexpire.com', 'emailondeck.com', 'temp-mail.io', 'temp-inbox.com',
  ];
  const emailDomain = emailLower.split('@')[1];
  if (disposableDomains.includes(emailDomain)) {
    flags.push(`Disposable email provider: ${emailDomain}`);
    score += 25;
  }

  // 7. Check if mirror URL matches known malicious URL patterns
  try {
    const mirrorPath = new URL(mirror_url).pathname.toLowerCase();
    if (/\.(exe|bat|cmd|scr|ps1|vbs|jar|dll)$/i.test(mirrorPath)) {
      flags.push(`Mirror URL points to executable, not ISO`);
      score += 30;
    }
  } catch (e) {}

  const verdict = score >= 40 ? 'rejected' : score >= 15 ? 'flagged' : 'pending';

  return {
    verdict,
    score,
    flags,
    auto_rejected: score >= 40,
    needs_manual_review: score >= 15 && score < 40,
    clean: score < 15,
  };
}

// ─── ISO Hosting Provider Management ───────────────────────────────

async function getR2(env, bucket, key) {
  if (!env.CLOUDFLARE_API_TOKEN || !env.CLOUDFLARE_ACCOUNT_ID) return null;
  const url = `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/r2/buckets/${bucket}/objects/${key}`;
  const res = await fetch(url, { headers: { 'Authorization': `Bearer ${env.CLOUDFLARE_API_TOKEN}` } });
  if (!res.ok) return null;
  // R2 GET returns the raw object body directly (not wrapped in { result: ... })
  return await res.json();
}

async function putR2(env, bucket, key, body) {
  if (!env.CLOUDFLARE_API_TOKEN || !env.CLOUDFLARE_ACCOUNT_ID) return false;
  const url = `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/r2/buckets/${bucket}/objects/${key}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'Authorization': `Bearer ${env.CLOUDFLARE_API_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return res.ok;
}

async function deleteR2(env, bucket, key) {
  if (!env.CLOUDFLARE_API_TOKEN || !env.CLOUDFLARE_ACCOUNT_ID) return false;
  const url = `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/r2/buckets/${bucket}/objects/${key}`;
  const res = await fetch(url, { method: 'DELETE', headers: { 'Authorization': `Bearer ${env.CLOUDFLARE_API_TOKEN}` } });
  return res.ok;
}

async function listR2(env, bucket, prefix) {
  if (!env.CLOUDFLARE_API_TOKEN || !env.CLOUDFLARE_ACCOUNT_ID) return [];
  const url = `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/r2/buckets/${bucket}/objects?prefix=${prefix}`;
  const res = await fetch(url, { headers: { 'Authorization': `Bearer ${env.CLOUDFLARE_API_TOKEN}` } });
  if (!res.ok) return [];
  const data = await res.json();
  return data?.result?.objects || [];
}

function hashPassword(password) {
  let h = 0;
  for (let i = 0; i < password.length; i++) { const c = password.charCodeAt(i); h = ((h << 5) - h) + c; h |= 0; }
  return 'h' + Math.abs(h).toString(36);
}

function getCors() {
  return { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
}

async function sendDiscordWebhook(env, message) {
  const webhook = env.DISCORD_WEBHOOK_URL;
  if (!webhook) return;
  try {
    await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: message })
    });
  } catch (e) { console.error('Discord webhook failed:', e); }
}

async function sendHostingEmail(env, to, subject, body) {
  // Store email job in R2 for Cloudflare Email Worker to pick up
  const job = { to, subject, body, from: env.EMAIL_FROM || 'developers@acreetionos.org', created: new Date().toISOString() };
  const key = 'email-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  await putR2(env, 'acreetionos-hosting', key, job);
}

async function handleHostingGetProviders(env) {
  const objects = await listR2(env, 'acreetionos-hosting', 'provider-');
  const providers = [];
  for (const obj of objects) {
    const data = await getR2(env, 'acreetionos-hosting', obj.key);
    if (data) providers.push(data);
  }
  return new Response(JSON.stringify({ providers }), { headers: getCors() });
}

async function handleHostingRegister(request, env) {
  try {
    const body = await request.json();
    if (!body.org || !body.email || !body.password || !body.mirror_url || !body.location) {
      return new Response(JSON.stringify({ error: 'org, email, password, mirror_url, and location are required' }), { status: 400, headers: getCors() });
    }

    // Validate organization domain (skip if personal checkbox checked)
    const orgCheck = await validateOrgDomain(env, body.email, body.org, body.personal_email === true);
    if (!orgCheck.valid) {
      return new Response(JSON.stringify({ success: false, error: orgCheck.reason }), { status: 400, headers: getCors() });
    }

    // Run background vetting checks
    const vetResult = await vetProvider(env, body);

    if (vetResult.auto_rejected) {
      sendDiscordWebhook(env,
        `**🚫 Registration Auto-Rejected (Vetting Failed)**\n**Organization:** ${body.org}\n**Email:** ${body.email}\n**Location:** ${body.location}\n**Risk Score:** ${vetResult.score}\n**Flags:**\n${vetResult.flags.map(f => '- ' + f).join('\n')}\n\nRegistration was automatically rejected by security vetting.`
      );
      return new Response(JSON.stringify({
        success: false, error: 'Registration rejected by automated security vetting. Contact developers@acreetionos.org if you believe this is an error.',
        vetting: { score: vetResult.score, flags: vetResult.flags }
      }), { status: 403, headers: getCors() });
    }

    const id = 'p_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
    const provider = {
      id, org: body.org, email: body.email, website: body.website || '',
      mirror_url: body.mirror_url, location: body.location,
      bandwidth: body.bandwidth || '', notes: body.notes || '',
      password: hashPassword(body.password),
      status: vetResult.needs_manual_review ? 'flagged' : 'pending',
      created: new Date().toISOString(),
      removal_requested: false,
      discord_user_id: body.discord_user_id || '',
      subscribed: body.subscribe === true,
      vetting: { score: vetResult.score, flags: vetResult.flags },
      personal_email: body.personal_email === true,
      last_seen: new Date().toISOString(),
      expiry_warning_sent: false
    };
    const ok = await putR2(env, 'acreetionos-hosting', 'provider-' + id, provider);
    if (!ok) return new Response(JSON.stringify({ error: 'Storage error' }), { status: 500, headers: getCors() });

    // Mailing list subscription
    if (body.subscribe && body.email) {
      await putR2(env, 'acreetionos-hosting', 'subscriber-' + body.email.replace(/[@.]/g, '_'), {
        email: body.email, org: body.org, subscribed: new Date().toISOString(), unsubscribe_token: Math.random().toString(36).slice(2, 10)
      });
    }

    const statusEmoji = vetResult.needs_manual_review ? '⚠️' : '✅';
    const statusLabel = vetResult.needs_manual_review ? 'Flagged — Manual Review Required' : 'Pending Approval';

    // Notify Discord
    sendDiscordWebhook(env,
      `${statusEmoji} **New Hosting Provider Registration**\n**Organization:** ${body.org}\n**Email:** ${body.email}\n**Location:** ${body.location}\n**Mirror:** ${body.mirror_url}\n**Website:** ${body.website || 'N/A'}\n**Discord User ID:** ${body.discord_user_id || 'N/A'}\n**Subscribed:** ${body.subscribe ? 'Yes' : 'No'}\n**Vetting Score:** ${vetResult.score}\n**Status:** ${statusLabel}\n**ID:** ${id}\n\nTo approve: POST to /api/hosting/admin/approve-removal with { provider_id: "${id}", admin_key: "YOUR_ADMIN_KEY" }\nTo reject: POST to /api/hosting/admin/reject-removal with same\nAdmin page: https://acreetionos.org/api/hosting/admin/pending`
    );

    if (vetResult.flags.length > 0) {
      sendDiscordWebhook(env,
        `**Vetting Details for ${body.org}**\n${vetResult.flags.map(f => '- ' + f).join('\n')}`
      );
    }

    const msg = vetResult.auto_rejected
      ? 'Registration rejected by security vetting'
      : vetResult.needs_manual_review
        ? 'Registration submitted — flagged for manual review due to security indicators'
        : 'Registration submitted for review';

    return new Response(JSON.stringify({ success: true, message: msg, id, vetting: { score: vetResult.score, flagged: vetResult.needs_manual_review } }), { headers: getCors() });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: getCors() });
  }
}

async function handleHostingRemoveRequest(request, env) {
  try {
    const body = await request.json();
    if (!body.email || !body.password) {
      return new Response(JSON.stringify({ error: 'email and password required' }), { status: 400, headers: getCors() });
    }
    const objects = await listR2(env, 'acreetionos-hosting', 'provider-');
    let found = null;
    for (const obj of objects) {
      const data = await getR2(env, 'acreetionos-hosting', obj.key);
      if (data && data.email === body.email && data.password === hashPassword(body.password)) { found = data; break; }
    }
    if (!found) return new Response(JSON.stringify({ error: 'Provider not found or password incorrect' }), { status: 404, headers: getCors() });
    found.removal_requested = true;
    found.removal_reason = body.notes || 'No reason given';
    await putR2(env, 'acreetionos-hosting', 'provider-' + found.id, found);
    sendDiscordWebhook(env, `**Removal Requested**\n**Provider:** ${found.org} (${found.email})\n**Reason:** ${body.notes || 'None'}\n**ID:** ${found.id}`);
    return new Response(JSON.stringify({ success: true, message: 'Removal request submitted for admin approval' }), { headers: getCors() });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: getCors() });
  }
}

async function handleHostingUpdateRequest(request, env) {
  try {
    const body = await request.json();
    if (!body.email || !body.password) {
      return new Response(JSON.stringify({ error: 'email and password required' }), { status: 400, headers: getCors() });
    }
    const objects = await listR2(env, 'acreetionos-hosting', 'provider-');
    let found = null;
    for (const obj of objects) {
      const data = await getR2(env, 'acreetionos-hosting', obj.key);
      if (data && data.email === body.email && data.password === hashPassword(body.password)) { found = data; break; }
    }
    if (!found) return new Response(JSON.stringify({ error: 'Provider not found or password incorrect' }), { status: 404, headers: getCors() });
    found.notes = body.notes || found.notes;
    await putR2(env, 'acreetionos-hosting', 'provider-' + found.id, found);
    return new Response(JSON.stringify({ success: true, message: 'Listing updated' }), { headers: getCors() });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: getCors() });
  }
}

async function handleHostingAdminApprove(request, env) {
  try {
    const body = await request.json();
    if (!body.admin_key || body.admin_key !== env.ADMIN_KEY) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 403, headers: getCors() });
    if (!body.provider_id) return new Response(JSON.stringify({ error: 'provider_id required' }), { status: 400, headers: getCors() });
    const data = await getR2(env, 'acreetionos-hosting', 'provider-' + body.provider_id);
    if (!data) return new Response(JSON.stringify({ error: 'Provider not found' }), { status: 404, headers: getCors() });
    if (body.action === 'approve-removal' || body.action === 'remove') {
      await deleteR2(env, 'acreetionos-hosting', 'provider-' + body.provider_id);
      sendDiscordWebhook(env, `**Provider Removed (Admin Approved)**\n**Provider:** ${data.org} (${data.email})`);
      // Notify mailing list about removal
      if (data.subscribed && data.email) {
        sendHostingEmail(env, data.email, 'AcreetionOS Hosting - Your Provider Has Been Removed',
          `Hi ${data.org},\n\nYour hosting provider listing for AcreetionOS has been removed as requested.\n\nThank you for your support.\n- AcreetionOS Team`);
      }
      triggerRedeploy(env);
      return new Response(JSON.stringify({ success: true, message: 'Provider removed and redeploy triggered' }), { headers: getCors() });
    }
    // Approve registration
    data.status = 'active';
    await putR2(env, 'acreetionos-hosting', 'provider-' + body.provider_id, data);
    sendDiscordWebhook(env, `**Provider Approved**\n**Provider:** ${data.org} (${data.email}) is now active.`);

    // Send welcome email to subscribed providers
    if (data.subscribed && data.email) {
      sendHostingEmail(env, data.email, 'Welcome to AcreetionOS Hosting Program!',
        `Hi ${data.org},\n\nYour hosting provider application has been approved!\n\nMirror URL: ${data.mirror_url}\nStatus: Active\n\nYou are now subscribed to hosting updates. We'll notify you of any changes.\n\nTo unsubscribe: https://acreetionos.org/api/hosting/unsubscribe?email=${encodeURIComponent(data.email)}\n\n- AcreetionOS Team`);
    }
    triggerRedeploy(env);
    return new Response(JSON.stringify({ success: true, message: 'Provider approved and redeploy triggered' }), { headers: getCors() });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: getCors() });
  }
}

async function handleHostingAdminReject(request, env) {
  try {
    const body = await request.json();
    if (!body.admin_key || body.admin_key !== env.ADMIN_KEY) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 403, headers: getCors() });
    if (!body.provider_id) return new Response(JSON.stringify({ error: 'provider_id required' }), { status: 400, headers: getCors() });
    await deleteR2(env, 'acreetionos-hosting', 'provider-' + body.provider_id);
    sendDiscordWebhook(env, `**Provider Registration Rejected**\n**ID:** ${body.provider_id}`);
    return new Response(JSON.stringify({ success: true, message: 'Provider registration rejected and removed' }), { headers: getCors() });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: getCors() });
  }
}

async function handleHostingAdminPending(env) {
  const objects = await listR2(env, 'acreetionos-hosting', 'provider-');
  const all = [];
  for (const obj of objects) {
    const data = await getR2(env, 'acreetionos-hosting', obj.key);
    if (data) all.push(data);
  }
  const pending = all.filter(p => p.status === 'pending' || p.removal_requested);
  return new Response(JSON.stringify({ pending, total: all.length }), { headers: getCors() });
}

async function handleHostingSubscribe(request, env) {
  try {
    const body = await request.json();
    if (!body.email) return new Response(JSON.stringify({ error: 'email required' }), { status: 400, headers: getCors() });
    const key = 'subscriber-' + body.email.replace(/[@.]/g, '_');
    const existing = await getR2(env, 'acreetionos-hosting', key);
    if (existing) return new Response(JSON.stringify({ success: true, message: 'Already subscribed' }), { headers: getCors() });
    await putR2(env, 'acreetionos-hosting', key, {
      email: body.email, org: body.org || '', subscribed: new Date().toISOString(), unsubscribe_token: Math.random().toString(36).slice(2, 10)
    });
    return new Response(JSON.stringify({ success: true, message: 'Subscribed to hosting updates' }), { headers: getCors() });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: getCors() });
  }
}

async function handleHostingUnsubscribe(request, env) {
  const email = request.url.searchParams?.get?.('email') || '';
  if (!email) return new Response(JSON.stringify({ error: 'email required' }), { status: 400, headers: getCors() });
  const key = 'subscriber-' + email.replace(/[@.]/g, '_');
  await deleteR2(env, 'acreetionos-hosting', key);
  return new Response(JSON.stringify({ success: true, message: 'Unsubscribed' }), { headers: getCors() });
}

// ─── Malware Scanning ──────────────────────────────────────────

const SUSPICIOUS_FILENAME_PATTERNS = /\.(exe|bat|cmd|scr|ps1|vbs|jar|dll|zip|rar|7z)$/i;
const ISO_MAGIC = new Uint8Array([0x43, 0x44, 0x30, 0x30, 0x31]); // "CD001" at offset 32769
const SCAN_QUOTA_KEY = 'scan-quota-state';

async function getScanQuota(env) {
  const data = await getR2(env, 'acreetionos-hosting', SCAN_QUOTA_KEY);
  return data || { vt_remaining: 500, vt_reset: Date.now() + 86400000, vt_disabled: false };
}

async function saveScanQuota(env, quota) {
  await putR2(env, 'acreetionos-hosting', SCAN_QUOTA_KEY, quota);
}

async function getThreatIntel(env) {
  try {
    const data = await getR2(env, 'acreetionos-hosting', 'threat-intel/all-blocked-domains.txt');
    if (data && typeof data === 'object' && data.body) {
      return data.body.split('\n').map(s => s.trim().toLowerCase()).filter(Boolean);
    }
    // raw text stored differently - try fetching directly
    const url = `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/r2/buckets/acreetionos-hosting/objects/threat-intel%2Fall-blocked-domains.txt`;
    const res = await fetch(url, { headers: { 'Authorization': `Bearer ${env.CLOUDFLARE_API_TOKEN}` } });
    if (res.ok) {
      const text = await res.text();
      return text.split('\n').map(s => s.trim().toLowerCase()).filter(Boolean);
    }
  } catch (e) { console.error('Threat intel fetch failed:', e); }
  return [];
}

function checkThreatIntel(domain, blockedDomains) {
  const d = domain.toLowerCase();
  for (const b of blockedDomains) {
    if (d === b || d.endsWith('.' + b) || d.includes(b)) return b;
  }
  return null;
}

async function localScanISO(env, data) {
  // Local fallback scan when VirusTotal quota is exhausted
  const issues = [];
  const isoUrl = data.mirror_url;
  const blockedDomains = await getThreatIntel(env);

  try {
    // 1. HEAD request to verify URL is reachable and looks like an ISO
    const headRes = await fetch(isoUrl, { method: 'HEAD', signal: AbortSignal.timeout(15000) });
    if (!headRes.ok) {
      issues.push('ISO URL returned ' + headRes.status);
    }

    const contentType = headRes.headers.get('Content-Type') || '';
    const contentLength = parseInt(headRes.headers.get('Content-Length') || '0');

    if (contentLength > 0 && contentLength < 104857600) {
      issues.push(`ISO too small (${(contentLength/1048576).toFixed(1)} MB) — likely not a real ISO`);
    }

    // 2. Check filename for suspicious extensions
    const pathname = new URL(isoUrl).pathname;
    if (SUSPICIOUS_FILENAME_PATTERNS.test(pathname)) {
      issues.push(`Suspicious file extension in URL: ${pathname.match(/\.[^.]+$/)[0]}`);
    }

    // 3. Check ISO magic bytes in the first chunk
    const getRes = await fetch(isoUrl, {
      headers: { 'Range': 'bytes=32769-32773' },
      signal: AbortSignal.timeout(15000)
    });
    if (getRes.ok) {
      const chunk = await getRes.arrayBuffer();
      const bytes = new Uint8Array(chunk);
      const isIso = ISO_MAGIC.every((b, i) => bytes[i] === b);
      if (!isIso) {
        issues.push('Missing ISO 9660 magic bytes — file may not be a valid ISO');
      }
    }

    // 4. Check domain against threat intelligence feeds
    try {
      const domain = new URL(isoUrl).hostname.replace(/^www\./, '');
      const match = checkThreatIntel(domain, blockedDomains);
      if (match) {
        issues.push(`Domain blocked by threat intelligence feed (match: ${match})`);
      }
    } catch (e) {
      // Invalid URL, skip domain check
    }

    // 5. Check for ISO in pathname (should contain .iso)
    if (!pathname.toLowerCase().includes('.iso')) {
      issues.push('URL does not point to an ISO file');
    }

    // 6. Flag for CI ClamAV deep scan
    if (issues.length === 0) {
      return { clean: true, scan_method: 'local_quick' };
    }

    return { clean: false, scan_method: 'local_quick', issues, auto_deregister: false, needs_clamav: true };
  } catch (e) {
    return { clean: false, scan_method: 'local_quick', issues: [`Scan error: ${e.message}`], auto_deregister: false, needs_clamav: true };
  }
}

async function scanISOSuspicious(env) {
  const objects = await listR2(env, 'acreetionos-hosting', 'provider-');
  const flagged = [];
  const errors = [];
  const vtQuarantined = [];
  const vtDisabled = [];

  let quota = await getScanQuota(env);
  let useVt = !quota.vt_disabled && env.VIRUSTOTAL_API_KEY;

  for (const obj of objects) {
    const data = await getR2(env, 'acreetionos-hosting', obj.key);
    if (!data || (data.status !== 'active' && data.status !== 'reactivating')) continue;

    const isoUrl = data.mirror_url;
    if (!isoUrl) continue;

    let result;

    if (useVt) {
      try {
        const submitRes = await fetch('https://www.virustotal.com/api/v3/urls', {
          method: 'POST',
          headers: { 'x-apikey': env.VIRUSTOTAL_API_KEY, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ url: isoUrl })
        });

        if (submitRes.status === 429 || submitRes.status === 403) {
          // Quota exhausted or key invalid — switch to local scan for all remaining
          quota.vt_disabled = true;
          quota.vt_disabled_at = Date.now();
          await saveScanQuota(env, quota);
          sendDiscordWebhook(env,
            `**VirusTotal Quota Exhausted** — Switching to local fallback scanning.\nStatus: ${submitRes.status}\nAll remaining providers will be scanned locally and flagged for ClamAV CI verification.`
          );
          useVt = false;
          vtDisabled.push(data.org);
          result = await localScanISO(env, data);
        } else if (!submitRes.ok) {
          errors.push(`${data.org}: VT submit failed ${submitRes.status}`);
          result = await localScanISO(env, data);
        } else {
          const submitData = await submitRes.json();
          const analysisId = submitData?.data?.id;
          if (analysisId) {
            await new Promise(r => setTimeout(r, 5000));
            const resultRes = await fetch(`https://www.virustotal.com/api/v3/analyses/${analysisId}`, {
              headers: { 'x-apikey': env.VIRUSTOTAL_API_KEY }
            });
            if (resultRes.ok) {
              const resultData = await resultRes.json();
              const stats = resultData?.data?.attributes?.stats;
              if (stats && (stats.malicious > 0 || stats.suspicious > 0)) {
                result = { clean: false, scan_method: 'virustotal', malicious: stats.malicious, suspicious: stats.suspicious, total: (stats.harmless||0)+(stats.malicious||0)+(stats.suspicious||0)+(stats.undetected||0) };
              } else {
                result = { clean: true, scan_method: 'virustotal' };
              }
            } else {
              errors.push(`${data.org}: VT result fetch failed`);
              result = await localScanISO(env, data);
            }
          } else {
            errors.push(`${data.org}: no VT analysis ID`);
            result = await localScanISO(env, data);
          }
        }

        if (useVt) {
          quota.vt_remaining = (quota.vt_remaining || 500) - 1;
          if (quota.vt_remaining <= 0) {
            quota.vt_disabled = true;
            quota.vt_disabled_at = Date.now();
            useVt = false;
            sendDiscordWebhook(env, '**VirusTotal Daily Quota Reached** — Switching to local scans for remaining providers.');
          }
          await saveScanQuota(env, quota);
          await new Promise(r => setTimeout(r, 16000));
        }
      } catch (e) {
        errors.push(`${data.org}: VT error ${e.message}, falling back to local scan`);
        result = await localScanISO(env, data);
      }
    } else {
      result = await localScanISO(env, data);
    }

    // Update last_seen for clean scans or local scans that passed
    if (result.clean || result.scan_method === 'local_quick') {
      data.last_seen = new Date().toISOString();

      // Auto-reactivation logic — if status is 'reactivating', track uptime
      if (data.status === 'reactivating') {
        if (!data.reactivation_online_since) {
          data.reactivation_online_since = new Date().toISOString();
        }
        const onlineSince = new Date(data.reactivation_online_since).getTime();
        const hoursOnline = (Date.now() - onlineSince) / (1000 * 60 * 60);

        if (hoursOnline >= 24) {
          data.status = 'active';
          data.reactivation_requested = false;
          data.reactivation_online_since = undefined;
          data.reactivation_requested_at = undefined;
          sendDiscordWebhook(env,
            `**✅ Provider Auto-Reactivated**\n**Provider:** ${data.org}\n**Email:** ${data.email}\n**ISO:** ${data.mirror_url}\n**Online for:** ${hoursOnline.toFixed(1)} hours\n\nProvider has been reactivated after 24+ hours of uptime.`
          );
          triggerRedeploy(env);
        }
      }

      await putR2(env, 'acreetionos-hosting', obj.key, data);
    }

    if (!result.clean) {
      const entry = {
        id: data.id, org: data.org, email: data.email,
        mirror_url: data.mirror_url,
        scan_method: result.scan_method,
        issues: result.issues || [],
      };
      if (result.malicious !== undefined) {
        entry.malicious = result.malicious;
        entry.suspicious = result.suspicious;
        entry.total = result.total;
      }
      flagged.push(entry);
    }
  }

  return { flagged, errors, vt_disabled: quota.vt_disabled, vt_quarantined: vtDisabled };
}

async function checkStaleProviders(env) {
  const objects = await listR2(env, 'acreetionos-hosting', 'provider-');
  const expired = [];
  const now = Date.now();
  const twoWeeks = 14 * 24 * 60 * 60 * 1000;

  for (const obj of objects) {
    const data = await getR2(env, 'acreetionos-hosting', obj.key);
    if (!data || data.status !== 'active') continue;

    const lastSeen = data.last_seen ? new Date(data.last_seen).getTime() : 0;
    const age = now - lastSeen;

    if (age > twoWeeks) {
      // Send expiry warning if not already sent (send once at 14 days)
      if (!data.expiry_warning_sent) {
        data.expiry_warning_sent = true;
        await putR2(env, 'acreetionos-hosting', obj.key, data);

        // Store email notification job
        const emailBody = `Hi ${data.org},\n\nYour AcreetionOS hosting provider listing has been flagged as inactive.\n\nYour ISO mirror (${data.mirror_url}) has not been reachable for 14 days. Per our requirements, providers must maintain an active mirror.\n\nIf you believe this is an error, please contact us at developers@acreetionos.org or re-register at https://acreetionos.org/hosting.html\n\nIf we don't hear from you within 7 days, your listing will be automatically removed.\n\n- AcreetionOS Team`;
        await sendHostingEmail(env, data.email, 'AcreetionOS Hosting — Inactivity Warning', emailBody);

        sendDiscordWebhook(env,
          `**⚠️ Provider Inactivity Warning**\n**Provider:** ${data.org}\n**Email:** ${data.email}\n**ISO:** ${data.mirror_url}\n**Last seen:** ${data.last_seen || 'Never'}\n**Grace period:** 7 days before removal\n\nWarning email sent to provider.`
        );
      }

      // Remove after 21 days (14 days + 7 day grace)
      if (age > twoWeeks + (7 * 24 * 60 * 60 * 1000)) {
        await deleteR2(env, 'acreetionos-hosting', obj.key);
        const removalBody = `Hi ${data.org},\n\nYour AcreetionOS hosting provider listing has been removed.\n\nReason: Your ISO mirror (${data.mirror_url}) was unreachable for more than 21 days. This violates our hosting requirements.\n\nIf you'd like to re-register, please visit https://acreetionos.org/hosting.html and ensure your mirror is online before submitting.\n\nIf you believe this is an error, contact us at developers@acreetionos.org\n\n- AcreetionOS Team`;
        await sendHostingEmail(env, data.email, 'AcreetionOS Hosting — Listing Removed (Inactivity)', removalBody);
        expired.push({ org: data.org, email: data.email, last_seen: data.last_seen, reason: 'inactive_21_days' });
      }
    }

    // Also update last_seen if ISO is reachable during scan (handled in scanISOSuspicious)
    // This is a safety net for providers not scanned recently
  }

  return expired;
}

async function handleHostingScan(request, env) {
  // POST /api/hosting/scan — triggers full scan of all provider ISOs
  // Requires admin_key
  const body = await request.json().catch(() => ({}));
  if (body.admin_key !== env.ADMIN_KEY) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 403, headers: getCors() });
  }
  const result = await scanISOSuspicious(env);

  let needsClamav = false;

  // Auto-deregister flagged providers (VT-confirmed only)
  for (const flagged of result.flagged) {
    if (flagged.scan_method === 'virustotal' || (flagged.scan_method === 'local_quick' && flagged.malicious)) {
      await deleteR2(env, 'acreetionos-hosting', 'provider-' + flagged.id);
      sendDiscordWebhook(env,
        `**🚨 MALWARE DETECTED — Provider Auto-Deregistered**\n**Provider:** ${flagged.org}\n**Email:** ${flagged.email}\n**ISO:** ${flagged.mirror_url}\n**Method:** ${flagged.scan_method}\n**Malicious detections:** ${flagged.malicious || 0}\n**Issues:** ${(flagged.issues || []).join(', ')}\n\nProvider has been immediately removed from the website.`
      );
    }
    if (flagged.needs_clamav || flagged.scan_method === 'local_quick') {
      needsClamav = true;
    }
  }

  if (result.vt_disabled) {
    sendDiscordWebhook(env,
      `**⚠️ VirusTotal Quota Exhausted** — Scanning switched to local fallback.\nFlagged ${result.flagged.filter(f => f.scan_method === 'local_quick').length} providers for ClamAV review.\nOnly VT-confirmed threats were auto-deregistered.`
    );
  }

  // Trigger CI ClamAV deep scan for locally-flagged providers
  if (needsClamav) {
    triggerClamavScan(env);
  }

  if (result.flagged.length === 0 && result.errors.length === 0) {
    sendDiscordWebhook(env, '**ISO Malware Scan Complete** — No threats detected across all providers.');
  }

  if (result.errors.length > 0) {
    sendDiscordWebhook(env, `**ISO Scan Errors**\n${result.errors.join('\n')}`);
  }

  // Check for stale/expired providers (not seen in 14+ days)
  const expired = await checkStaleProviders(env);
  if (expired.length > 0) {
    sendDiscordWebhook(env,
      `**⏰ Providers Expired (Inactive 14+ Days)**\n${expired.map(e => `- ${e.org} (${e.email}) — Last seen: ${e.last_seen || 'never'}`).join('\n')}\n\nThey have been removed and notified.`
    );
  }

  // Trigger redeploy if providers were removed or expired
  if (result.flagged.length > 0 || expired.length > 0) {
    triggerRedeploy(env);
  }

  return new Response(JSON.stringify(result), { headers: getCors() });
}

async function handleHostingCount(env) {
  const objects = await listR2(env, 'acreetionos-hosting', 'provider-');
  let active = 0;
  for (const obj of objects) {
    const data = await getR2(env, 'acreetionos-hosting', obj.key);
    if (data && data.status === 'active') active++;
  }
  return new Response(JSON.stringify({ count: active, threshold: 5, show_fastest: active >= 5 }), { headers: getCors() });
}

async function triggerClamavScan(env) {
  const ghToken = env.GH_TOKEN;
  if (!ghToken) return;
  try {
    await fetch('https://api.github.com/repos/AcreetionOS-Code/acreetionos-code.github.io/actions/workflows/scan-provider-isos.yml/dispatches', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${ghToken}`, 'Content-Type': 'application/json', 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'AcreetionOS-Hosting' },
      body: JSON.stringify({ ref: 'main' })
    });
  } catch (e) { console.error('ClamAV scan trigger failed:', e); }
}

async function handleHostingReactivate(request, env) {
  // POST /api/hosting/reactivate — Request reactivation after expiry
  // Body: { email, password, agreement: true }
  try {
    const body = await request.json();
    if (!body.email || !body.password) {
      return new Response(JSON.stringify({ error: 'email and password required' }), { status: 400, headers: getCors() });
    }
    if (!body.agreement) {
      return new Response(JSON.stringify({ error: 'You must accept the hosting agreement to reactivate' }), { status: 400, headers: getCors() });
    }

    // Check if provider exists (including deleted/expired — we can't find deleted ones)
    // Scan all providers for matching email
    const objects = await listR2(env, 'acreetionos-hosting', 'provider-');
    let found = null;
    let providerKey = '';
    for (const obj of objects) {
      const data = await getR2(env, 'acreetionos-hosting', obj.key);
      if (data && data.email === body.email && data.password === hashPassword(body.password)) {
        found = data; providerKey = obj.key; break;
      }
    }

    if (!found) {
      // Check if they were deleted — store a reactivation request
      return new Response(JSON.stringify({
        success: true, message: 'If your account exists, we will verify your mirror and reactivate it within 24 hours if it remains online.',
        verification_pending: true
      }), { headers: getCors() });
    }

    // Mark as pending reactivation with timestamp
    found.reactivation_requested = true;
    found.reactivation_requested_at = new Date().toISOString();
    found.reactivation_agreement_accepted = true;
    found.status = 'reactivating';
    await putR2(env, 'acreetionos-hosting', providerKey, found);

    sendDiscordWebhook(env,
      `**🔄 Reactivation Requested**\n**Provider:** ${found.org} (${found.email})\n**ISO:** ${found.mirror_url}\n**Agreement accepted:** Yes\n\nMirror will be verified every 6 hours. If online for 24+ consecutive hours, it will be automatically reactivated.`
    );

    triggerRedeploy(env);

    return new Response(JSON.stringify({
      success: true,
      message: 'Reactivation requested. Your mirror will be checked every 6 hours. If it stays online for 24 hours, you will be automatically reactivated.',
      verification_pending: true
    }), { headers: getCors() });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: getCors() });
  }
}

// ─── ISO Reachability Check ────────────────────────────

const ISO_MIRRORS = {
  cinnamon: [
    'https://iso.acreetionos.org:8448/acreetion/AcreetionOS-1.0-x86_64.iso',
    'https://pub-173a1f638a3b4c95b5f58b09c0b968aa.r2.dev/AcreetionOS-latest.iso',
    'https://ftp2.osuosl.org/pub/acreetionos/AcreetionOS-1.0-x86_64.iso',
    'https://archive.org/download/AcreetionOS-1.0-x86_64/AcreetionOS-1.0-x86_64.iso',
    'https://sourceforge.net/projects/acreetionos-iso-image/files/AcreetionOS-1.0-x86_64.iso/download',
  ],
  xl: [
    'https://iso.acreetionos.org:8448/acreetion/AcreetionOS_XL-1.0-x86_64.iso',
    'https://pub-173a1f638a3b4c95b5f58b09c0b968aa.r2.dev/AcreetionOS_XL-latest.iso',
    'https://ftp2.osuosl.org/pub/acreetionos/AcreetionOS_XL-1.0-x86_64.iso',
    'https://archive.org/download/AcreetionOS_XL-1.0-x86_64/AcreetionOS_XL-1.0-x86_64.iso',
    'https://sourceforge.net/projects/acreetionos-iso-image/files/AcreetionOS_XL-1.0-x86_64.iso/download',
  ],
};

function getEditionNameFromUrl(url) {
  if (url.includes('AcreetionOS-1.0-x86_64') || url.includes('AcreetionOS-latest')) return 'cinnamon';
  if (url.includes('AcreetionOS_XL')) return 'xl';
  if (url.includes('AcreetionOS32')) return '32bit';
  if (url.includes('Hyprland')) return 'hyprland';
  if (url.includes('Plasma')) return 'plasma';
  if (url.includes('MATE')) return 'mate';
  if (url.includes('GNOME')) return 'gnome';
  if (url.includes('XFCE')) return 'xfce';
  if (url.includes('Sway')) return 'sway';
  if (url.includes('i3')) return 'i3';
  return null;
}

async function handleISOCheck(request, env) {
  const url = new URL(request.url).searchParams.get('url');
  if (!url) {
    return new Response(JSON.stringify({ error: 'url parameter required', reachable: false }), {
      status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders(request) }
    });
  }

  // Try URL — HEAD first, fallback to Range+magic, accept 401/403 for R2
  async function tryUrl(u) {
    // R2 URLs return 401 — treat as potentially valid
    const isR2 = u.includes('.r2.dev');

    // HEAD request (fast)
    try {
      const headRes = await fetch(u, { method: 'HEAD', signal: AbortSignal.timeout(8000) });
      const ok = headRes.ok || headRes.status === 206 || headRes.status === 301 || headRes.status === 302;
      if (ok || (isR2 && (headRes.status === 401 || headRes.status === 403))) {
        const cl = parseInt(headRes.headers.get('Content-Length') || '0');
        if (cl >= 209715200 || isR2) return { reachable: true, status: headRes.status };
        // If no Content-Length, try Range
      }
    } catch {}

    // Range request for magic byte verification
    try {
      const res = await fetch(u, { headers: { 'Range': 'bytes=0-1048575' }, signal: AbortSignal.timeout(15000) });
      if (res.ok || res.status === 206 || (isR2 && (res.status === 401 || res.status === 403))) {
        if (isR2 && (res.status === 401 || res.status === 403)) return { reachable: true, status: res.status };
        const chunk = await res.arrayBuffer();
        const bytes = new Uint8Array(chunk);
        if (bytes.length >= 32774) {
          const magic = bytes.slice(32769, 32774);
          const isIso = magic[0] === 0x43 && magic[1] === 0x44 && magic[2] === 0x30 &&
                         magic[3] === 0x30 && magic[4] === 0x31;
          if (!isIso) return { reachable: false, status: res.status, error: 'Not valid ISO' };
        }
        const cr = res.headers.get('Content-Range') || '';
        const sm = cr.match(/\/(\d+)$/);
        if (sm) { const ts = parseInt(sm[1]); if (ts < 209715200 && !isR2) return { reachable: false, status: res.status, error: `ISO too small` }; }
        return { reachable: true, status: res.status };
      }
    } catch (e) { return { reachable: false, status: 0, error: e.message }; }
    return { reachable: false, status: 0 };
  }

  let result = await tryUrl(url);

  // If unreachable, try alternative mirrors
  let foundUrl = null;
  if (!result.reachable) {
    const edition = getEditionNameFromUrl(url);
    const mirrors = edition ? ISO_MIRRORS[edition] || [] : [];
    // Also try generic fallback patterns
    const alternatives = [
      ...mirrors,
      url.replace('https://', 'https://ftp2.osuosl.org/pub/acreetionos/').split('/').pop(),
      url.replace('.iso', '.iso.zip'),
    ].filter(u => u !== url).filter(Boolean);

    for (const alt of alternatives) {
      let altUrl = alt;
      // If it's just a filename, prepend the OSUOSL base
      if (!altUrl.startsWith('http')) {
        altUrl = `https://ftp2.osuosl.org/pub/acreetionos/${altUrl}`;
      }
      const altResult = await tryUrl(altUrl);
    if (altResult.reachable) {
        foundUrl = altUrl;
        result = { reachable: true, status: altResult.status, found_at: altUrl, used_mirror: altUrl };
        break;
    }
    }

    // If found a working mirror, auto-fix the URL in flash.html via PR
    if (foundUrl && env.GH_TOKEN) {
      try {
        const repo = 'AcreetionOS-Code/acreetionos-code.github.io';
        const h = { 'Authorization': `Bearer ${env.GH_TOKEN}`, 'Content-Type': 'application/json', 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'AcreetionOS-AutoFix/1.0' };
        const api = (p) => `https://api.github.com/repos/${repo}/${p}`;

        // Fetch current flash.html from GitHub
        const flashRes = await fetch(api('contents/flash.html'), { headers: h });
        if (flashRes.ok) {
          const flashData = await flashRes.json();
          let content = atob(flashData.content);
          const sha = flashData.sha;

          if (content.includes(url)) {
            content = content.replace(url, foundUrl);
            const branch = `fix/iso-${Date.now().toString(36)}`;
            const base = await (await fetch(api('git/ref/heads/main'), { headers: h })).json();
            const tree = await (await fetch(api('git/trees'), { method: 'POST', headers: h,
              body: JSON.stringify({ base_tree: base.object.sha, tree: [{ path: 'flash.html', mode: '100644', type: 'blob', content }] })
            })).json();
            const commit = await (await fetch(api('git/commits'), { method: 'POST', headers: h,
              body: JSON.stringify({ message: `Auto-fix: ${edition || 'ISO'} URL — was unreachable, found at mirror`, tree: tree.sha, parents: [base.object.sha] })
            })).json();
            await fetch(api('git/refs'), { method: 'POST', headers: h, body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: commit.sha }) });
            const pr = await (await fetch(api('pulls'), { method: 'POST', headers: h,
              body: JSON.stringify({ title: `Auto-fix: ${edition || 'ISO'} download URL`, body: `🤖 **Auto-fix**: ${url}\nwas broken, found working mirror at:\n${foundUrl}`, head: branch, base: 'main' })
            })).json();
            if (pr.number) {
              await fetch(api(`pulls/${pr.number}/merge`), { method: 'PUT', headers: h, body: JSON.stringify({ merge_method: 'merge' }) }).catch(() => {});
              await fetch(api(`git/refs/heads/${branch}`), { method: 'DELETE', headers: h }).catch(() => {});
            }
          }
        }
      } catch (e) { console.error('Auto-fix PR failed:', e.message); }
    }
  }

  return new Response(JSON.stringify({
    url, reachable: result.reachable, status: result.status,
    found_at: result.found_at || null,
    size: null, type: null, last_modified: null
  }), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300', ...corsHeaders(request) }
  });
}

// ─── Site Health Check ──────────────────────────────────

const HEALTH_PAGES = [
  '', 'flash.html', 'hosting.html', 'security.html', 'wiki.html',
  'developers.html', 'contact.html', 'faq.html', 'install.html',
  'git-tracker.html', 'blog.html', 'build.html', 'compare.html',
  'contributing.html', 'governance.html', 'requirements.html',
  '32bit.html', 'gnome.html', 'hyprland.html', 'i3.html',
  'mate.html', 'openbox.html', 'plasma.html', 'sway.html',
  'xfce.html', 'immutable.html', 'unofficial.html'
];

const HEALTH_APIS = [
  'https://acreetionos.org/api/cve/status',
  'https://acreetionos.org/api/hosting/count',
  'https://acreetionos.org/api/mirror/best?edition=cinnamon'
];

async function handleHealthCheck(env) {
  const results = { pages: [], apis: [], downloads: [], healthy: true, timestamp: new Date().toISOString() };
  let totalIssues = 0;

  // 1. Check all HTML pages
  const pageChecks = HEALTH_PAGES.map(async (page) => {
    const url = `https://acreetionos.org/${page}`;
    try {
      const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(10000) });
      const ok = res.ok || res.status === 301 || res.status === 302;
      results.pages.push({ page, status: res.status, healthy: ok });
      if (!ok) totalIssues++;
    } catch (e) {
      results.pages.push({ page, status: 0, healthy: false, error: e.message });
      totalIssues++;
    }
  });

  // 2. Check API endpoints
  const apiChecks = HEALTH_APIS.map(async (url) => {
    try {
      const res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(10000) });
      const ok = res.ok;
      results.apis.push({ url: url.replace('https://acreetionos.org', ''), status: res.status, healthy: ok });
      if (!ok) totalIssues++;
    } catch (e) {
      results.apis.push({ url: url.replace('https://acreetionos.org', ''), status: 0, healthy: false, error: e.message });
      totalIssues++;
    }
  });

  // 3. Check ISO download links from flash.html EDITIONS + auto-fix
  const isoChecks = (async () => {
    try {
      const flashRes = await fetch('https://acreetionos.org/flash.html', { signal: AbortSignal.timeout(10000) });
      const html = await flashRes.text();
      const match = html.match(/const EDITIONS\s*=\s*(\[[\s\S]*?\]);/);
      if (match) {
        let js = match[1].replace(/'/g, '"').replace(/,\s*([\]}])/g, '$1');
        const editions = JSON.parse(js);
        for (const ed of editions) {
          const url = ed.iso_url;
          if (!url) continue;
          // Use the ISO check handler which has auto-fix logic
          const fakeReq = new Request(`https://acreetionos.org/api/iso/check?url=${encodeURIComponent(url)}`);
          const checkRes = await handleISOCheck(fakeReq, env);
          const checkData = await checkRes.json();
          results.downloads.push({
            edition: ed.id, status: checkData.status,
            healthy: checkData.reachable,
            found_at: checkData.found_at || null
          });
          if (!checkData.reachable) totalIssues++;
        }
      }
    } catch (e) {
      results.downloads.push({ edition: 'flash.html', status: 0, healthy: false, error: e.message });
      totalIssues++;
    }
  });

  await Promise.all([...pageChecks, ...apiChecks, isoChecks]);

  results.healthy = totalIssues === 0;
  results.issues = totalIssues;

  // Store in R2 for status badge
  await putR2(env, 'acreetionos-hosting', 'health-check.json', results).catch(() => {});

  // If issues found, create a PR via GitHub
  if (totalIssues > 0 && env.GH_TOKEN) {
    const branch = `fix/health-auto-${Date.now().toString(36)}`;
    let prBody = `🤖 **Site Health Check Report**\n\n**Issues found:** ${totalIssues}\n\n`;
    for (const p of results.pages) { if (!p.healthy) prBody += `- ❌ Page /${p.page}: HTTP ${p.status}\n`; }
    for (const a of results.apis) { if (!a.healthy) prBody += `- ❌ API ${a.url}: HTTP ${a.status}\n`; }
    for (const d of results.downloads) { if (!d.healthy) prBody += `- ❌ ISO ${d.edition}: HTTP ${d.status}\n`; }
    prBody += '\n---\n_Created automatically by the site health check._';

    try {
      const repo = 'AcreetionOS-Code/acreetionos-code.github.io';
      const h = { 'Authorization': `Bearer ${env.GH_TOKEN}`, 'Content-Type': 'application/json', 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'AcreetionOS-Health/1.0' };
      const api = (p) => `https://api.github.com/repos/${repo}/${p}`;

      const base = await (await fetch(api('git/ref/heads/main'), { headers: h })).json();
      const tree = await (await fetch(api('git/trees'), { method: 'POST', headers: h, body: JSON.stringify({ base_tree: base.object.sha, tree: [] }) })).json();
      const commit = await (await fetch(api('git/commits'), { method: 'POST', headers: h, body: JSON.stringify({ message: `Health check: ${totalIssues} issue(s)`, tree: tree.sha, parents: [base.object.sha] }) })).json();
      await fetch(api('git/refs'), { method: 'POST', headers: h, body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: commit.sha }) });
      const pr = await (await fetch(api('pulls'), { method: 'POST', headers: h, body: JSON.stringify({ title: `Health: ${totalIssues} issue(s) found`, body: prBody, head: branch, base: 'main' }) })).json();
      if (pr.number) {
        await fetch(api(`pulls/${pr.number}/merge`), { method: 'PUT', headers: h, body: JSON.stringify({ merge_method: 'merge' }) }).catch(() => {});
        await fetch(api(`git/refs/heads/${branch}`), { method: 'DELETE', headers: h }).catch(() => {});
      }
    } catch (e) { console.error('PR creation failed:', e.message); }
  }

  return new Response(JSON.stringify(results), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache', ...corsHeaders({ headers: { get: () => '' } }) }
  });
}

// ─── GitHub Auto-Fix PR Creator ────────────────────────────

async function handleCreatePR(request, env) {
  // POST /api/github/create-pr — creates a PR with auto-fixes
  // Body: { branch, title, body, files: [{ path, content }], base?: "main" }
  try {
    const body = await request.json();
    const ghToken = env.GH_TOKEN;
    if (!ghToken) {
      return new Response(JSON.stringify({ error: 'GitHub not configured', pr: null }), {
        status: 503, headers: { 'Content-Type': 'application/json', ...corsHeaders(request) }
      });
    }

    const repo = 'AcreetionOS-Code/acreetionos-code.github.io';
    const base = body.base || 'main';
    const branch = body.branch || `fix/auto-${Date.now().toString(36)}`;
    const headers = {
      'Authorization': `Bearer ${ghToken}`,
      'Content-Type': 'application/json',
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'AcreetionOS-AutoFix/1.0'
    };
    const api = (path) => `https://api.github.com/repos/${repo}/${path}`;

    // 1. Get the latest commit SHA on base branch
    const baseRes = await fetch(api(`git/ref/heads/${base}`), { headers });
    if (!baseRes.ok) {
      return new Response(JSON.stringify({ error: 'Failed to get base ref', pr: null }), {
        status: 502, headers: { 'Content-Type': 'application/json', ...corsHeaders(request) }
      });
    }
    const baseData = await baseRes.json();
    const baseSha = baseData.object.sha;

    // 2. Create a new tree with the file changes
    const treeItems = (body.files || []).map(f => ({
      path: f.path,
      mode: '100644',
      type: 'blob',
      content: f.content
    }));

    const treeRes = await fetch(api('git/trees'), {
      method: 'POST', headers,
      body: JSON.stringify({ base_tree: baseSha, tree: treeItems })
    });
    if (!treeRes.ok) {
      const err = await treeRes.text();
      return new Response(JSON.stringify({ error: 'Tree creation failed', detail: err.slice(0, 300), pr: null }), {
        status: 502, headers: { 'Content-Type': 'application/json', ...corsHeaders(request) }
      });
    }
    const treeData = await treeRes.json();

    // 3. Create a commit
    const commitRes = await fetch(api('git/commits'), {
      method: 'POST', headers,
      body: JSON.stringify({
        message: body.title || 'Auto-fix: AI website guardian repairs',
        tree: treeData.sha,
        parents: [baseSha]
      })
    });
    if (!commitRes.ok) {
      const err = await commitRes.text();
      return new Response(JSON.stringify({ error: 'Commit failed', detail: err.slice(0, 300), pr: null }), {
        status: 502, headers: { 'Content-Type': 'application/json', ...corsHeaders(request) }
      });
    }
    const commitData = await commitRes.json();

    // 4. Create the branch
    const branchRes = await fetch(api(`git/refs`), {
      method: 'POST', headers,
      body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: commitData.sha })
    });
    if (!branchRes.ok) {
      const err = await branchRes.text();
      return new Response(JSON.stringify({ error: 'Branch creation failed', detail: err.slice(0, 300), pr: null }), {
        status: 502, headers: { 'Content-Type': 'application/json', ...corsHeaders(request) }
      });
    }

    // 5. Create the PR
    const prRes = await fetch(api('pulls'), {
      method: 'POST', headers,
      body: JSON.stringify({
        title: body.title || 'Auto-fix: AI guardian repairs',
        body: (body.body || '🤖 **Auto-fix PR**\n\nCreated automatically by the AcreetionOS AI Guardian.') + '\n\n_Generated via Cloudflare Worker_',
        head: branch,
        base: base
      })
    });
    if (!prRes.ok) {
      const err = await prRes.text();
      return new Response(JSON.stringify({ error: 'PR creation failed', detail: err.slice(0, 300), pr: null }), {
        status: 502, headers: { 'Content-Type': 'application/json', ...corsHeaders(request) }
      });
    }
    const prData = await prRes.json();

    // 6. Enable auto-merge with branch deletion
    const mergeRes = await fetch(api(`pulls/${prData.number}/merge`), {
      method: 'PUT', headers,
      body: JSON.stringify({ merge_method: 'merge' })
    }).catch(() => {});

    // 7. Delete the branch after merge
    if (mergeRes && mergeRes.ok) {
      await fetch(api(`git/refs/heads/${branch}`), {
        method: 'DELETE', headers
      }).catch(() => {});
    }

    return new Response(JSON.stringify({
      pr: { number: prData.number, url: prData.html_url, branch },
      success: true
    }), {
      headers: { 'Content-Type': 'application/json', ...corsHeaders(request) }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message, pr: null }), {
      status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders(request) }
    });
  }
}

async function handlePushFix(request, env) {
  // POST /api/github/push-fix — directly push a file fix to main
  // Body: { files: [{ path, content }], message }
  try {
    const body = await request.json();
    const ghToken = env.GH_TOKEN;
    if (!ghToken) {
      return new Response(JSON.stringify({ error: 'GitHub not configured' }), {
        status: 503, headers: { 'Content-Type': 'application/json', ...corsHeaders(request) }
      });
    }

    // First try to create a PR, fallback to direct push
    const prResult = await handleCreatePR(request.clone ? request.clone() : request, env).then(r => r.json());
    return new Response(JSON.stringify(prResult), {
      headers: { 'Content-Type': 'application/json', ...corsHeaders(request) }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders(request) }
    });
  }
}

// ─── CVE Security Monitoring ──────────────────────────────────

const NVD_BASE = 'https://services.nvd.nist.gov/rest/json/cves/2.0';
const OSV_BASE = 'https://api.osv.dev/v1';

function parseArchAtom(xml) {
  const items = [];
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/gi;
  let match;
  while ((match = entryRegex.exec(xml)) !== null) {
    const entry = match[1];
    const title = (entry.match(/<title[^>]*>(?:<!\[CDATA\[)?([^\]]*(?:\]\]>)?[^<]*)/) || [,''])[1].replace(']]>', '').trim();
    const content = (entry.match(/<content[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/content>/) || [,''])[1].trim();
    const updated = (entry.match(/<updated>([^<]*)<\/updated>/) || [,''])[1].trim();
    const summary = (entry.match(/<summary[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/summary>/) || [,''])[1].replace(']]>', '').trim();

    const cveMatch = title.match(/(CVE-\d{4}-\d+)/gi);
    const severityMatch = content.match(/Severity:\s*(\w+)/i);
    const packageMatch = content.match(/Package\s*:\s*([^\s<&]+)/i);
    const typeMatch = content.match(/Type\s*:\s*([^<]+)/i);
    const remoteMatch = content.match(/Remote\s*:\s*(\w+)/i);
    const resolutionMatch = content.match(/Upgrade to\s*([^<]+)/i);
    const linkMatch = entry.match(/<link[^>]*href="([^"]*)"/);
    const avgMatch = content.match(/AVG-\d+/);

    if (cveMatch && cveMatch.length > 0) {
      const pkg = (packageMatch ? packageMatch[1].trim() : (title.match(/^\[([^\]]+)\]/) || [,''])[1]).replace(/&amp;/g, '&');
      items.push({
        cves: cveMatch.map(c => c.toUpperCase()),
        primary_cve: cveMatch[0].toUpperCase(),
        title: title.replace(/&amp;/g, '&'),
        link: linkMatch ? linkMatch[1] : 'https://security.archlinux.org/',
        summary: summary.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').trim(),
        content: content.replace(/<br\/?>/g, '\n').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#34;/g, '"').trim(),
        date: updated,
        package: pkg,
        severity: severityMatch ? severityMatch[1] : 'Unknown',
        type: typeMatch ? typeMatch[1].trim() : 'unknown',
        remote: remoteMatch ? remoteMatch[1] === 'Yes' : false,
        resolution: resolutionMatch ? resolutionMatch[1].trim() : '',
        avg: avgMatch ? avgMatch[0] : ''
      });
    }
  }
  return items;
}

async function fetchCVEDetails(cveId) {
  // Get CVSS score from NVD
  try {
    const res = await fetch(`${NVD_BASE}?cveId=${cveId}`, {
      headers: { 'User-Agent': 'AcreetionOS-CVE/1.0' },
      signal: AbortSignal.timeout(8000)
    });
    if (res.ok) {
      const data = await res.json();
      const vuln = data?.vulnerabilities?.[0]?.cve;
      if (vuln) {
        const metrics = vuln.metrics;
        let cvss = null, exploitability = null;
        if (metrics?.cvssMetricV31?.[0]) {
          cvss = metrics.cvssMetricV31[0].cvssData;
        } else if (metrics?.cvssMetricV30?.[0]) {
          cvss = metrics.cvssMetricV30[0].cvssData;
        } else if (metrics?.cvssMetricV2?.[0]) {
          cvss = metrics.cvssMetricV2[0].cvssData;
        }
        return {
          cvss_score: cvss?.baseScore || null,
          cvss_severity: cvss?.baseSeverity || null,
          cvss_vector: cvss?.vectorString || null,
          exploitability: metrics?.cvssMetricV31?.[0]?.exploitabilityScore || null,
          impact_score: metrics?.cvssMetricV31?.[0]?.impactScore || null,
          cisa_kev: vuln?.cisaExploitAdd ? true : false,
          cisa_due: vuln?.cisaActionDue || null,
          known_ransomware: vuln?.cisaRansomwareUse ? true : false
        };
      }
    }
  } catch (e) {}
  return null;
}

async function fetchOSVDetails(cveId) {
  // Cross-reference with OSV.dev for patch status
  try {
    const res = await fetch(`${OSV_BASE}/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: cveId }),
      signal: AbortSignal.timeout(8000)
    });
    if (res.ok) {
      const data = await res.json();
      const vuln = data?.vulns?.[0];
      if (vuln) {
        const affected = (vuln.affected || []).map(a => ({
          package: a.package?.name || '',
          ecosystem: a.package?.ecosystem || '',
          ranges: a.ranges || [],
          versions: a.versions || []
        }));
        const patches = vuln.related ? vuln.related.filter(r => r.type === 'FIX' || r.type === 'PACKAGE') : [];
        return { affected, patches, aliases: vuln.aliases || [], severity: vuln.severity || [] };
      }
    }
  } catch (e) {}
  return null;
}

async function crossReferenceCVE(cveId) {
  const [nvd, osv] = await Promise.all([
    fetchCVEDetails(cveId),
    fetchOSVDetails(cveId).catch(() => null)
  ]);
  return { nvd, osv };
}

function generateFixScript(cve, pkg, arch) {
  var packages = pkg ? pkg.split(',').map(function(p) { return p.trim(); }).filter(Boolean) : [];
  var pkgList = packages.length > 0 ? packages.join(' ') : 'PACKAGE_NAME';
  return [
    '#!/bin/bash',
    '# AcreetionOS CVE Fix Script',
    '# CVE: ' + cve,
    '# Package: ' + pkgList,
    '# Generated: ' + new Date().toISOString(),
    '#',
    '# This script will attempt to fix the vulnerability by updating',
    '# the affected package(s) to the latest patched version.',
    '#',
    '# DISCLAIMER: This script is provided as-is. The AcreetionOS project',
    '# is not responsible for any damage or data loss. By running this',
    '# script, you accept full responsibility for your system.',
    '# Review the script before running it.',
    '',
    'set -e',
    '',
    'echo "=== AcreetionOS CVE Fix: ' + cve + ' ==="',
    'echo "Affected package(s): ' + pkgList + '"',
    'echo ""',
    '',
    'if [ ! -f /etc/arch-release ]; then',
    '  echo "ERROR: This script is for Arch Linux / AcreetionOS only."',
    '  exit 1',
    'fi',
    '',
    'if [ "$(id -u)" -ne 0 ]; then',
    '  echo "ERROR: This script must be run as root (sudo)."',
    '  exit 1',
    'fi',
    '',
    'echo "[1/3] Updating package databases..."',
    'pacman -Sy --noconfirm',
    '',
    'echo "[2/3] Upgrading affected package(s)..."',
    'pacman -S --noconfirm ' + pkgList,
    '',
    'echo "[3/3] Verification..."',
    'for pkg in ' + pkgList + '; do',
    '  if pacman -Qi "$pkg" &>/dev/null; then',
    '    ver=$(pacman -Qi "$pkg" | grep \'^Version\' | awk \'{print $3}\')',
    '    echo "  OK $pkg updated to $ver"',
    '  fi',
    'done',
    '',
    'echo ""',
    'echo "=== Fix applied for ' + cve + ' ==="',
    'echo "Please reboot if the vulnerability affects the kernel or a system service."',
    'echo "For more details: https://security.archlinux.org/' + cve + '"',
  ].join('\n');
}

// ─── Smart Mirror Selection ──────────────────────────────────

const MIRRORS = {
  cinnamon: [
    { url: 'https://iso.acreetionos.org:8448/acreetion/AcreetionOS-1.0-x86_64.iso', name: 'Direct Server', priority: 1 },
    { url: 'https://pub-173a1f638a3b4c95b5f58b09c0b968aa.r2.dev/AcreetionOS-latest.iso', name: 'Cloudflare R2', priority: 2 },
    { url: 'https://ftp2.osuosl.org/pub/acreetionos/AcreetionOS-1.0-x86_64.iso', name: 'OSUOSL Mirror', priority: 3 },
    { url: 'https://archive.org/download/AcreetionOS-1.0-x86_64/AcreetionOS-1.0-x86_64.iso', name: 'Internet Archive', priority: 4 },
    { url: 'https://sourceforge.net/projects/acreetionos-iso-image/files/AcreetionOS-1.0-x86_64.iso/download', name: 'SourceForge', priority: 5 },
  ],
  xl: [
    { url: 'https://iso.acreetionos.org:8448/acreetion/AcreetionOS_XL-1.0-x86_64.iso', name: 'Direct Server', priority: 1 },
    { url: 'https://pub-173a1f638a3b4c95b5f58b09c0b968aa.r2.dev/AcreetionOS_XL-latest.iso', name: 'Cloudflare R2', priority: 2 },
    { url: 'https://ftp2.osuosl.org/pub/acreetionos/AcreetionOS_XL-1.0-x86_64.iso', name: 'OSUOSL Mirror', priority: 3 },
    { url: 'https://archive.org/download/AcreetionOS_XL-1.0-x86_64/AcreetionOS_XL-1.0-x86_64.iso', name: 'Internet Archive', priority: 4 },
    { url: 'https://sourceforge.net/projects/acreetionos-iso-image/files/AcreetionOS_XL-1.0-x86_64.iso/download', name: 'SourceForge', priority: 5 },
  ],
};

async function handleBestMirror(request, env) {
  const edition = (new URL(request.url).searchParams.get('edition') || 'cinnamon').toLowerCase();
  const mirrors = MIRRORS[edition] || MIRRORS.cinnamon;

  // Test each mirror's latency in parallel
  const results = await Promise.all(mirrors.map(async (mirror) => {
    const start = Date.now();
    try {
      const res = await fetch(mirror.url, {
        method: 'HEAD',
        signal: AbortSignal.timeout(5000)
      });
      const latency = Date.now() - start;
      return { ...mirror, latency, status: res.status, online: res.ok };
    } catch (e) {
      return { ...mirror, latency: 9999, status: 0, online: false };
    }
  }));

  const online = results.filter(r => r.online).sort((a, b) => a.latency - b.latency);
  const best = online[0] || results[0];

  return new Response(JSON.stringify({
    edition,
    best: best,
    all: results,
    online_count: online.length,
    total: results.length,
  }), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache', ...corsHeaders({ headers: { get: () => '' } }) }
  });
}

async function handleCVEFeed(env) {
  try {
    // Fetch from Arch Linux Atom feed (official advisory source)
    const res = await fetch('https://security.archlinux.org/advisory/feed.atom', {
      headers: { 'User-Agent': 'AcreetionOS-CVE-Monitor/1.0' },
      signal: AbortSignal.timeout(15000)
    });
    if (!res.ok) throw new Error('Atom feed fetch failed: ' + res.status);
    const xml = await res.text();
    let cves = parseArchAtom(xml);

    // Cross-reference each CVE with NVD, CISA KEV, and OSV for enrichment
    const enriched = [];
    // Limit to 10 cross-references per request for performance
    const toEnrich = cves.slice(0, 10);
    const enrichedPromises = toEnrich.map(async (cve) => {
      const crossRef = await crossReferenceCVE(cve.primary_cve).catch(() => null);
      return { ...cve, cross_ref: crossRef };
    });
    const enrichedResults = await Promise.all(enrichedPromises);

    // For remaining CVEs, just pass through without enrichment
    const remaining = cves.slice(10);
    const allCves = [...enrichedResults, ...remaining.map(c => ({ ...c, cross_ref: null }))];

    // Store in R2 cache
    await putR2(env, 'acreetionos-hosting', 'cve-cache.json', {
      updated: new Date().toISOString(),
      cves: allCves,
      count: allCves.length,
      source: 'security.archlinux.org/advisory/feed.atom'
    });

    return new Response(JSON.stringify({ cves: allCves, count: allCves.length, updated: new Date().toISOString(), source: 'security.archlinux.org' }), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=1800', ...corsHeaders({ headers: { get: () => '' } }) }
    });
  } catch (e) {
    // Serve from cache on failure
    const cached = await getR2(env, 'acreetionos-hosting', 'cve-cache.json');
    if (cached && cached.cves) {
      return new Response(JSON.stringify({ cves: cached.cves, count: cached.count, updated: cached.updated, source: 'cached', cached: true }), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600', ...corsHeaders({ headers: { get: () => '' } }) }
      });
    }
    return new Response(JSON.stringify({ error: e.message, cves: [], count: 0 }), { headers: getCors() });
  }
}

async function handleCVEStatus(env) {
  const cached = await getR2(env, 'acreetionos-hosting', 'cve-cache.json');
  if (cached && cached.cves) {
    const critical = cached.cves.filter(c =>
      c.severity?.toLowerCase() === 'critical' ||
      c.severity?.toLowerCase() === 'high' ||
      c.cross_ref?.nvd?.cvss_severity === 'CRITICAL' ||
      c.cross_ref?.nvd?.cvss_severity === 'HIGH'
    );
    const exploitable = cached.cves.filter(c => c.cross_ref?.nvd?.cisa_kev).length;
    const avgCvss = cached.cves
      .map(c => c.cross_ref?.nvd?.cvss_score)
      .filter(Boolean);
    const meanCvss = avgCvss.length > 0 ? (avgCvss.reduce((a, b) => a + b, 0) / avgCvss.length).toFixed(1) : null;
    return new Response(JSON.stringify({
      count: cached.count,
      critical: critical.length,
      exploitable,
      avg_cvss: meanCvss,
      updated: cached.updated,
      has_active: cached.count > 0,
      source: cached.source || 'archlinux'
    }), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=600', ...corsHeaders({ headers: { get: () => '' } }) }
    });
  }
  return handleCVEFeed(env);
}

async function handleCVEFix(request, env) {
  try {
    const body = await request.json();
    if (!body.cve || body.accepted !== true) {
      return new Response(JSON.stringify({ error: 'CVE ID and acceptance required' }), { status: 400, headers: getCors() });
    }
    const cveId = body.cve.toUpperCase();
    if (!/^CVE-\d{4}-\d+$/.test(cveId)) {
      return new Response(JSON.stringify({ error: 'Invalid CVE ID format' }), { status: 400, headers: getCors() });
    }

    const cached = await getR2(env, 'acreetionos-hosting', 'cve-cache.json');
    let cveData = null;
    if (cached && cached.cves) {
      cveData = cached.cves.find(c => c.primary_cve === cveId || (c.cves || []).includes(cveId));
    }

    const pkg = cveData ? cveData.package : '';
    const arch = 'x86_64';
    const script = generateFixScript(cveId, pkg, arch);

    // Get CVSS if available
    const cvssInfo = cveData?.cross_ref?.nvd;

    return new Response(JSON.stringify({
      cve: cveId,
      package: pkg || 'unknown',
      severity: cveData?.severity || 'Unknown',
      cvss_score: cvssInfo?.cvss_score || null,
      cvss_severity: cvssInfo?.cvss_severity || null,
      cisa_known: cvssInfo?.cisa_kev || false,
      description: cveData?.summary || '',
      resolution: cveData?.resolution || '',
      script,
      source: 'Arch Linux Security Advisory',
      source_url: cveData?.link || `https://security.archlinux.org/${cveId}`,
      disclaimer: 'This script is provided as-is. The AcreetionOS project is not responsible for any damage or data loss. By using this script, you accept full responsibility for your system.'
    }), { headers: getCors() });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: getCors() });
  }
}

async function triggerRedeploy(env) {
  const ghToken = env.GH_TOKEN;
  if (!ghToken) return;
  try {
    await fetch('https://api.github.com/repos/AcreetionOS-Code/acreetionos-code.github.io/actions/workflows/deploy-hosting-providers.yml/dispatches', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${ghToken}`, 'Content-Type': 'application/json', 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'AcreetionOS-Hosting' },
      body: JSON.stringify({ ref: 'main' })
    });
  } catch (e) { console.error('Redeploy trigger failed:', e); }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    // Serve flash.html directly from worker
    if (url.pathname === '/flash.html' && request.method === 'GET') {
      const res = await fetch('https://raw.githubusercontent.com/AcreetionOS-Code/acreetionos-code.github.io/main/flash.html', {
        headers: { 'User-Agent': 'AcreetionOS-Worker/1.0' }
      });
      if (res.ok) {
        return new Response(await res.text(), {
          headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=120' }
        });
      }
    }

    // Page view counter — GET returns count, POST increments
    if (url.pathname === '/api/news') {
      return handleNews(env);
    }
    if (url.pathname === '/api/counter') {
      if (request.method === 'POST') {
        visitorCount++;
        if (Date.now() - lastPersistTime > 60000) {
          lastPersistTime = Date.now();
          ctx.waitUntil(persistCount());
        }
        return new Response(JSON.stringify({ count: visitorCount }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders(request) }
        });
      }
      return new Response(JSON.stringify({ count: visitorCount }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders(request), 'Cache-Control': 'no-cache' }
      });
    }

    // R2 ISO listing for AcreetionOS Immutable downloads
    if (url.pathname === '/api/r2/list') {
      const cfToken = env.CLOUDFLARE_API_TOKEN;
      const cfAccount = env.CLOUDFLARE_ACCOUNT_ID;
      if (!cfToken || !cfAccount) {
        return new Response(JSON.stringify({ error: 'R2 not configured', isos: [] }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders(request) }
        });
      }
      try {
        const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${cfAccount}/r2/buckets/immutable-iso/objects`, {
          headers: { 'Authorization': `Bearer ${cfToken}` }
        });
        const data = await res.json();
        const objects = data?.result?.objects || [];
        const isos = objects.filter(o => o.key.endsWith('.iso')).sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, 10).map(o => ({
          name: o.key,
          size: o.size,
          date: o.created_at
        }));
        return new Response(JSON.stringify({ isos }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders(request), 'Cache-Control': 'public, max-age=3600' }
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message, isos: [] }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders(request) }
        });
      }
    }

    // R2 ISO download proxy (supports "latest" → resolves to newest matching ISO)
    if (url.pathname.startsWith('/api/r2/get/')) {
      let filename = url.pathname.replace('/api/r2/get/', '');
      if (!filename || !filename.endsWith('.iso')) {
        return new Response('Not found', { status: 404 });
      }
      const cfToken = env.CLOUDFLARE_API_TOKEN;
      const cfAccount = env.CLOUDFLARE_ACCOUNT_ID;
      if (!cfToken || !cfAccount) {
        return new Response('R2 not configured', { status: 503 });
      }
      try {
        // Resolve "latest" to the most recent matching ISO
        if (filename.includes('latest')) {
          const prefix = filename.replace('-latest.iso', '');
          const listRes = await fetch(`https://api.cloudflare.com/client/v4/accounts/${cfAccount}/r2/buckets/immutable-iso/objects`, {
            headers: { 'Authorization': `Bearer ${cfToken}` }
          });
          const listData = await listRes.json();
          const objects = listData?.result?.objects || [];
          const match = objects.filter(o => o.key.startsWith(prefix) && o.key.endsWith('.iso'))
            .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
          if (match) filename = match.key;
          else return new Response('No ISO builds found', { status: 404 });
        }
        const downloadUrl = `https://${cfAccount}.r2.cloudflarestorage.com/immutable-iso/${filename}`;
        // 302 redirect directly to R2 — no proxy overhead, full speed
        return new Response(null, {
          status: 302,
          headers: {
            'Location': downloadUrl,
            'Cache-Control': 'public, max-age=86400'
          }
        });
      } catch (e) {
        return new Response('Download error', { status: 500 });
      }
    }

    // Build system — trigger GitHub Actions builds and check status
    if (url.pathname === '/api/build/trigger' && request.method === 'POST') {
      try {
        const body = await request.json();
        const edition = body.edition;
        if (!edition) {
          return new Response(JSON.stringify({ error: 'edition required' }), {
            status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders(request) }
          });
        }
        const ghToken = env.GH_TOKEN;
        if (!ghToken) {
          return new Response(JSON.stringify({ error: 'Build trigger not configured' }), {
            status: 503, headers: { 'Content-Type': 'application/json', ...corsHeaders(request) }
          });
        }
        const today = new Date().toISOString().slice(0, 10);
        const lock = await getR2(env, 'build-status', 'manual-trigger-lock.json');
        if (lock && lock.date === today) {
          return new Response(JSON.stringify({ error: 'Only one manual build trigger is allowed per UTC day', detail: `Last trigger: ${lock.edition || 'unknown'} at ${lock.triggered_at || 'unknown'}` }), {
            status: 429, headers: { 'Content-Type': 'application/json', ...corsHeaders(request) }
          });
        }
        const ghRes = await fetch('https://api.github.com/repos/AcreetionOS-Code/acreetionos-code.github.io/actions/workflows/build-all.yml/dispatches', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${ghToken}`,
            'Content-Type': 'application/json',
            'Accept': 'application/vnd.github.v3+json',
            'User-Agent': 'AcreetionOS-Build-Trigger'
          },
          body: JSON.stringify({
            ref: 'main',
            inputs: { edition }
          })
        });
        if (!ghRes.ok) {
          const errText = await ghRes.text();
          return new Response(JSON.stringify({ error: 'GitHub trigger failed', detail: errText.slice(0, 300) }), {
            status: 502, headers: { 'Content-Type': 'application/json', ...corsHeaders(request) }
          });
        }
        await putR2(env, 'build-status', 'manual-trigger-lock.json', {
          date: today,
          edition,
          triggered_at: new Date().toISOString(),
          run_url: `https://github.com/AcreetionOS-Code/acreetionos-code.github.io/actions/runs/${Date.now()}`
        });
        return new Response(JSON.stringify({ triggered: true, edition, date: today }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders(request) }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: 'Trigger error: ' + err.message }), {
          status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders(request) }
        });
      }
    }

    if (url.pathname === '/api/build/status' && request.method === 'GET') {
      try {
        const edition = url.searchParams.get('edition') || '';
        const cfToken = env.CLOUDFLARE_API_TOKEN;
        const cfAccount = env.CLOUDFLARE_ACCOUNT_ID;
        if (!cfToken || !cfAccount) {
          return new Response(JSON.stringify({ error: 'R2 not configured', builds: {} }), {
            headers: { 'Content-Type': 'application/json', ...corsHeaders(request) }
          });
        }
        if (edition) {
          const statusRes = await fetch(`https://api.cloudflare.com/client/v4/accounts/${cfAccount}/r2/buckets/build-status/objects/${edition}-status.json`, {
            headers: { 'Authorization': `Bearer ${cfToken}` }
          });
          if (!statusRes.ok) {
            return new Response(JSON.stringify({ edition, status: 'unknown', builds: [] }), {
              headers: { 'Content-Type': 'application/json', ...corsHeaders(request) }
            });
          }
          const data = await statusRes.json();
          return new Response(JSON.stringify(data), {
            headers: { 'Content-Type': 'application/json', ...corsHeaders(request), 'Cache-Control': 'no-cache' }
          });
        }
        const listRes = await fetch(`https://api.cloudflare.com/client/v4/accounts/${cfAccount}/r2/buckets/build-status/objects`, {
          headers: { 'Authorization': `Bearer ${cfToken}` }
        });
        const listData = await listRes.json();
        const objects = listData?.result?.objects || [];
        const statuses = {};
        for (const obj of objects) {
          if (obj.key.endsWith('-status.json')) {
            const slug = obj.key.replace('-status.json', '');
            const itemRes = await fetch(`https://api.cloudflare.com/client/v4/accounts/${cfAccount}/r2/buckets/build-status/objects/${obj.key}`, {
              headers: { 'Authorization': `Bearer ${cfToken}` }
            });
            if (itemRes.ok) {
              const itemData = await itemRes.json();
              statuses[slug] = itemData;
            }
          }
        }
        return new Response(JSON.stringify({ builds: statuses }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders(request), 'Cache-Control': 'no-cache' }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message, builds: {} }), {
          status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders(request) }
        });
      }
    }

    // Audio transcription via OpenRouter Whisper (free)
    // POST /api/transcribe  — body: { audio: <base64 opus/webm>, mimeType: string }
    if (request.method === 'POST' && url.pathname === '/api/transcribe') {
      try {
        const body = await request.json();
        if (!body.audio) {
          return new Response(JSON.stringify({ error: 'audio data required' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', ...corsHeaders(request) }
          });
        }

        const apiKey = env.OPENROUTER_API_KEY;
        if (!apiKey) {
          return new Response(JSON.stringify({ error: 'Transcription not configured' }), {
            status: 503,
            headers: { 'Content-Type': 'application/json', ...corsHeaders(request) }
          });
        }

        // Derive format from MIME type
        const mime = body.mimeType || 'audio/webm';
        const fmt = mime.includes('ogg') ? 'ogg' : mime.includes('mp4') ? 'mp4' : 'webm';

        const whisperRes = await fetch(WHISPER_URL, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': 'https://acreetionos.org',
            'X-Title': 'AIDEN Whisper (AcreetionOS Voice Input)'
          },
          body: JSON.stringify({
            model: WHISPER_MODEL,
            input_audio: {
              data: body.audio,
              format: fmt
            }
          })
        });

        // OpenRouter may return 200 with empty body on format issues; check for that too
        const whisperText = await whisperRes.text();
        if (!whisperText || whisperText.trim().length === 0) {
          return new Response(JSON.stringify({ error: 'Empty transcription response' }), {
            status: 502,
            headers: { 'Content-Type': 'application/json', ...corsHeaders(request) }
          });
        }

        let whisperData;
        try {
          whisperData = JSON.parse(whisperText);
        } catch (e) {
          return new Response(JSON.stringify({ error: 'Invalid transcription response', raw: whisperText.slice(0, 200) }), {
            status: 502,
            headers: { 'Content-Type': 'application/json', ...corsHeaders(request) }
          });
        }

        if (!whisperRes.ok) {
          return new Response(JSON.stringify({
            error: whisperData.error?.message || 'Transcription failed',
            status: whisperRes.status
          }), {
            status: 502,
            headers: { 'Content-Type': 'application/json', ...corsHeaders(request) }
          });
        }

        return new Response(JSON.stringify({
          text: whisperData.text || '',
          model: WHISPER_MODEL
        }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders(request) }
        });

      } catch (err) {
        return new Response(JSON.stringify({ error: 'Transcription error: ' + err.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', ...corsHeaders(request) }
        });
      }
    }

    // Load persisted count on first request
    if (visitorCount === 0) {
      ctx.waitUntil(loadCount());
    }

    // AI news article generation
    if (request.method === 'POST' && url.pathname === '/api/news/ai') {
      try {
        const body = await request.json();
        const apiKey = env.OPENROUTER_API_KEY;
        if (!apiKey) {
          return new Response(JSON.stringify({ error: 'AI generation not configured' }), {
            status: 503, headers: { 'Content-Type': 'application/json', ...corsHeaders(request) }
          });
        }
        const openRouterRes = await fetch(OPENROUTER_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
            'HTTP-Referer': 'https://acreetionos.org',
            'X-Title': 'AcreetionOS News AI'
          },
          body: JSON.stringify({
            model: FREE_MODEL,
            messages: body.messages || [],
            max_tokens: body.max_tokens || 512
          })
        });
        const data = await openRouterRes.json();
        if (!openRouterRes.ok) {
          const errDetail = JSON.stringify(data).slice(0, 500);
          return new Response(JSON.stringify({
            error: data.error?.message || data.error || 'AI generation failed',
            detail: errDetail,
            status: openRouterRes.status
          }), {
            status: 502,
            headers: { 'Content-Type': 'application/json', ...corsHeaders(request) }
          });
        }
        return new Response(JSON.stringify(data), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders(request) }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: 'AI generation failed: ' + err.message }), {
          status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders(request) }
        });
      }
    }

    // Text-to-Speech via OpenRouter (Cartesia TTS — natural human voice)
    if (request.method === 'POST' && url.pathname === '/api/tts') {
      try {
        const body = await request.json();
        if (!body.input) {
          return new Response(JSON.stringify({ error: 'input text required' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', ...corsHeaders(request) }
          });
        }
        const apiKey = env.OPENROUTER_API_KEY;
        if (!apiKey) {
          return new Response(JSON.stringify({ error: 'TTS not configured' }), {
            status: 503,
            headers: { 'Content-Type': 'application/json', ...corsHeaders(request) }
          });
        }
        const ttsRes = await fetch(TTS_URL, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': 'https://acreetionos.org',
            'X-Title': 'AIDEN TTS (AcreetionOS Voice Output)'
          },
          body: JSON.stringify({
            model: TTS_MODEL,
            input: body.input,
            voice: body.voice || 'nova',
            response_format: 'mp3'
          })
        });
        if (!ttsRes.ok) {
          const errText = await ttsRes.text();
          return new Response(JSON.stringify({ error: 'TTS failed', detail: errText.slice(0, 300) }), {
            status: 502,
            headers: { 'Content-Type': 'application/json', ...corsHeaders(request) }
          });
        }
        return new Response(ttsRes.body, {
          headers: {
            'Content-Type': ttsRes.headers.get('Content-Type') || 'audio/mpeg',
            ...corsHeaders(request)
          }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: 'TTS error: ' + err.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', ...corsHeaders(request) }
        });
      }
    }

    // ISO Hosting Provider management
    if (url.pathname === '/api/hosting/providers' && request.method === 'GET') {
      return handleHostingGetProviders(env);
    }
    if (url.pathname === '/api/hosting/register' && request.method === 'POST') {
      return handleHostingRegister(request, env);
    }
    if (url.pathname === '/api/hosting/remove-request' && request.method === 'POST') {
      return handleHostingRemoveRequest(request, env);
    }
    if (url.pathname === '/api/hosting/update-request' && request.method === 'POST') {
      return handleHostingUpdateRequest(request, env);
    }
    if (url.pathname === '/api/hosting/admin/approve-removal' && request.method === 'POST') {
      return handleHostingAdminApprove(request, env);
    }
    if (url.pathname === '/api/hosting/admin/reject-removal' && request.method === 'POST') {
      return handleHostingAdminReject(request, env);
    }
    if (url.pathname === '/api/hosting/admin/pending' && request.method === 'GET') {
      return handleHostingAdminPending(env);
    }
    if (url.pathname === '/api/hosting/subscribe' && request.method === 'POST') {
      return handleHostingSubscribe(request, env);
    }
    if (url.pathname === '/api/hosting/unsubscribe' && request.method === 'GET') {
      return handleHostingUnsubscribe(request, env);
    }
    if (url.pathname === '/api/hosting/count' && request.method === 'GET') {
      return handleHostingCount(env);
    }
    if (url.pathname === '/api/hosting/scan' && request.method === 'POST') {
      return handleHostingScan(request, env);
    }
    if (url.pathname === '/api/hosting/reactivate' && request.method === 'POST') {
      return handleHostingReactivate(request, env);
    }

    // ─── ISO reachability check (proxied to avoid CORS) ─────
    if (url.pathname === '/api/iso/check' && request.method === 'GET') {
      return handleISOCheck(request, env);
    }

    // ─── Site Health Check (runs periodically via cron) ──────
    if (url.pathname === '/api/health/check' && request.method === 'GET') {
      return handleHealthCheck(env);
    }

    // ─── GitHub Auto-Fix PR Creator ───────────────────────────
    if (url.pathname === '/api/github/create-pr' && request.method === 'POST') {
      return handleCreatePR(request, env);
    }
    if (url.pathname === '/api/github/push-fix' && request.method === 'POST') {
      return handlePushFix(request, env);
    }

    // ─── Smart Mirror Selection ────────────────────────────────
    if (url.pathname === '/api/mirror/best' && request.method === 'GET') {
      return handleBestMirror(request, env);
    }

    // ─── CVE Security Endpoints ──────────────────────────────────
    if (url.pathname === '/api/cve/feed' && request.method === 'GET') {
      return handleCVEFeed(env);
    }
    if (url.pathname === '/api/cve/status' && request.method === 'GET') {
      return handleCVEStatus(env);
    }
    if (url.pathname === '/api/cve/fix' && request.method === 'POST') {
      return handleCVEFix(request, env);
    }

    // Chat endpoint
    if (request.method !== 'POST' || url.pathname !== '/api/chat') {
      const csp = "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://unpkg.com https://static.cloudflareinsights.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net; img-src 'self' data: https:; font-src 'self' https://fonts.gstatic.com https://cdn.jsdelivr.net; connect-src 'self' https://openrouter.ai https://api.github.com https://gitlab.acreetionos.org https://news.google.com https://api.allorigins.win https://cloudflareinsights.com; base-uri 'self'; form-action 'self' https://www.qwant.com";
      return new Response('AcreetionOS Worker — POST /api/chat | POST /api/transcribe | POST /api/news/ai | /flash.html', {
        status: 200,
        headers: { 'Content-Type': 'text/plain', 'Content-Security-Policy': csp, ...corsHeaders(request) }
      });
    }

    try {
      const body = await request.json();
      if (!body.messages || !Array.isArray(body.messages)) {
        return new Response(JSON.stringify({ error: 'messages array required' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', ...corsHeaders(request) }
        });
      }

      // Server-side OpenRouter key must be configured in env (Cloudflare Worker secrets
      // or origin server environment). This keeps keys off the client.
      const apiKey = env.OPENROUTER_API_KEY;
      if (!apiKey) {
        return new Response(JSON.stringify({ error: 'Backup AI is not configured' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json', ...corsHeaders(request) }
        });
      }

      // Only allow explicitly whitelisted free models to be used
      let model = body.model || FREE_MODEL;
      if (model !== FREE_MODEL && !model.endsWith(':free')) {
        model = FREE_MODEL;
      }

      const isStream = body.stream === true;

      const openRouterRes = await fetch(OPENROUTER_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'HTTP-Referer': 'https://acreetionos.org',
          'X-Title': 'AIDEN (AcreetionOS Assistant)'
        },
        body: JSON.stringify(isStream ? {
          model: model,
          messages: body.messages,
          max_tokens: body.max_tokens || 800,
          stream: true
        } : {
          model: model,
          messages: body.messages,
          max_tokens: body.max_tokens || 800
        })
      });

      if (isStream) {
        // Forward SSE stream directly to client
        const headers = {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          ...corsHeaders(request)
        };
        return new Response(openRouterRes.body, { headers });
      }

      const data = await openRouterRes.json();

      if (!openRouterRes.ok) {
        const errDetail = JSON.stringify(data).slice(0, 500);
        return new Response(JSON.stringify({
          error: data.error?.message || data.error || 'OpenRouter request failed',
          detail: errDetail,
          status: openRouterRes.status
        }), {
          status: 502,
          headers: { 'Content-Type': 'application/json', ...corsHeaders(request) }
        });
      }

      const content = data.choices?.[0]?.message?.content;
      if (!content) {
        const errDetail = JSON.stringify(data).slice(0, 500);
        return new Response(JSON.stringify({
          error: 'AI model returned empty response',
          detail: errDetail,
          model: data.model || FREE_MODEL
        }), {
          status: 502,
          headers: { 'Content-Type': 'application/json', ...corsHeaders(request) }
        });
      }
      return new Response(JSON.stringify({
        content: content,
        model: data.model || FREE_MODEL,
        backend: 'openrouter'
      }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders(request) }
      });

    } catch (err) {
      return new Response(JSON.stringify({ error: 'Proxy error: ' + err.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders(request) }
      });
    }
  },

  // Cron: runs every 30 min — verifies all ISOs downloadable, auto-fixes broken
  async scheduled(event, env, ctx) {
    console.log('Running scheduled health check...');
    const req = new Request('https://acreetionos.org/api/health/check');
    const resp = await handleHealthCheck(env);
    const result = await resp.json();
    console.log(`Health check complete: ${result.issues} issues, healthy: ${result.healthy}`);
  }
};
