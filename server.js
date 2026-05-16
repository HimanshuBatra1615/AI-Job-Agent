/**
 * AI Job Agent — Local Proxy Server
 * Handles Claude API calls (bypasses browser CORS), job searching, and Sheets logging.
 * Run: node server.js
 * Then open http://localhost:3000 in your browser
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 3000;

/* ───────────────────────── MIME TYPES ───────────────────────── */
const MIME = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/* ───────────────────────── CORS HELPER ──────────────────────── */
function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key, anthropic-version');
}

function json(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

/* ───────────────────────── BODY PARSER ──────────────────────── */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 2e6) reject(new Error('Too large')); });
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve({}); } });
    req.on('error', reject);
  });
}

/* ───────────────────────── ANTHROPIC PROXY ─────────────────── */
function callAnthropic(apiKey, model, messages, system, maxTokens = 1024) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      model,
      max_tokens: maxTokens,
      system,
      messages,
    });

    const options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(payload),
      },
    };

    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) reject(new Error(parsed.error.message));
          else resolve(parsed);
        } catch (e) { reject(e); }
      });
    });

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

/* ───────────────────────── JSEARCH API (REAL JOB DATA) ────────────────────── */
async function fetchRealJobs(rapidApiKey, query) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'jsearch.p.rapidapi.com',
      path: `/search?query=${encodeURIComponent(query)}&num_pages=1`,
      method: 'GET',
      headers: {
        'X-RapidAPI-Key': rapidApiKey,
        'X-RapidAPI-Host': 'jsearch.p.rapidapi.com'
      }
    };

    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.message) reject(new Error(parsed.message));
          else resolve(parsed.data || []);
        } catch (e) { reject(e); }
      });
    });

    req.on('error', reject);
    req.end();
  });
}

/* ───────────────────────── SCORING ENGINE ──────────────────────*/
async function scoreJobWithClaude(apiKey, model, job, profile, criteria) {
  const systemPrompt = `You are an expert job-fit evaluator for a professional candidate. 
Score jobs on a 0-100 scale based on how well they match the candidate's profile and criteria.
Respond ONLY with valid JSON in this exact format (no markdown, no extra text):
{
  "score": <number 0-100>,
  "verdict": "apply" | "skip" | "review",
  "reasons": ["reason1", "reason2", "reason3"],
  "coverLetterHint": "<one sentence unique hook for cover letter>",
  "redFlags": ["flag1"] 
}`;

  const userMsg = `CANDIDATE PROFILE:
${profile.summary || 'No summary provided.'}

RESUME EXCERPT:
${(profile.resumeText || 'No resume uploaded.').slice(0, 3000)}

JOB CRITERIA:
- Target titles: ${criteria.titles || 'Not specified'}
- Must-have keywords: ${criteria.keywords || 'None'}
- Exclude keywords: ${criteria.excludeKeywords || 'None'}
- Location preference: ${criteria.location || 'Any'}
- Work type: ${criteria.workType || 'Any'}
- Min salary: ${criteria.minSalary ? '$' + parseInt(criteria.minSalary).toLocaleString() : 'Not set'}
- Experience level: ${criteria.expLevel || 'Any'}
- Scoring rules: ${criteria.scoringRules || 'Default'}
- Min score to apply: ${criteria.minScore || 70}

JOB TO EVALUATE:
- Company: ${job.company}
- Role: ${job.role}
- Location: ${job.location}
- Salary: ${job.salary ? '$' + job.salary.toLocaleString() : 'Not disclosed'}
- Tags/Skills: ${job.tags.join(', ')}
- Description: ${job.description}

Score this job and provide your evaluation.`;

  const result = await callAnthropic(apiKey, model, [{ role: 'user', content: userMsg }], systemPrompt, 512);
  const raw = result.content[0].text.trim();
  
  // Parse JSON from response
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Invalid Claude response format');
  return JSON.parse(jsonMatch[0]);
}

/* ────────────────────── COVER LETTER GEN ───────────────────── */
async function generateCoverLetter(apiKey, model, job, profile, scoreData) {
  const systemPrompt = `You are an expert career coach writing concise, compelling cover letters.
Write in first person, professional but warm tone. Maximum 3 short paragraphs.
No generic fluff. Every sentence must be specific to the job and candidate.`;

  const userMsg = `Write a cover letter for this application:

CANDIDATE:
${profile.summary || ''}
Resume: ${(profile.resumeText || '').slice(0, 2000)}

JOB:
Company: ${job.company}
Role: ${job.role}
Description: ${job.description}
Required Skills: ${job.tags.join(', ')}

HOOK TO USE: ${scoreData.coverLetterHint || ''}

Write the cover letter now:`;

  const result = await callAnthropic(apiKey, model, [{ role: 'user', content: userMsg }], systemPrompt, 600);
  return result.content[0].text.trim();
}

/* ─────────────────────────── ROUTER ────────────────────────── */
const server = http.createServer(async (req, res) => {
  setCORS(res);
  
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  /* ── API: Test Anthropic Key ── */
  if (pathname === '/api/test-key' && req.method === 'POST') {
    const body = await readBody(req);
    try {
      const result = await callAnthropic(body.apiKey, body.model || 'claude-haiku-3-5', 
        [{ role: 'user', content: 'Reply with: {"status":"ok"}' }], 
        'You are a test. Reply with the exact JSON asked.', 50);
      json(res, 200, { ok: true, model: result.model, usage: result.usage });
    } catch (e) {
      json(res, 400, { ok: false, error: e.message });
    }
    return;
  }

  /* ── API: Fetch Real Jobs via JSearch RapidAPI ── */
  if (pathname === '/api/jobs' && req.method === 'POST') {
    const body = await readBody(req);
    const { rapidApiKey, criteria } = body;
    if (!rapidApiKey) { json(res, 400, { error: 'Missing RapidAPI Key for JSearch' }); return; }
    
    try {
      const query = `${criteria?.titles || 'Software Engineer'} in ${criteria?.location || 'USA'}`;
      const jsearchData = await fetchRealJobs(rapidApiKey, query);
      
      // Map JSearch response to our internal job format
      const jobs = jsearchData.map(j => ({
        id: j.job_id,
        company: j.employer_name,
        role: j.job_title,
        location: `${j.job_city || ''}, ${j.job_state || ''} ${j.job_country || ''}`.trim(),
        salary: j.job_min_salary || 0, // Fallback if missing
        tags: [j.job_employment_type, j.job_publisher].filter(Boolean),
        url: j.job_apply_link,
        description: j.job_description || 'No description provided.'
      }));

      json(res, 200, { jobs, total: jobs.length });
    } catch (e) {
      json(res, 500, { error: e.message });
    }
    return;
  }

  /* ── API: Score a Job with Claude ── */
  if (pathname === '/api/score' && req.method === 'POST') {
    const body = await readBody(req);
    const { apiKey, model, job, profile, criteria } = body;
    if (!apiKey || !job) { json(res, 400, { error: 'Missing apiKey or job' }); return; }
    try {
      const scoreData = await scoreJobWithClaude(apiKey, model || 'claude-haiku-3-5', job, profile || {}, criteria || {});
      json(res, 200, scoreData);
    } catch (e) {
      json(res, 500, { error: e.message });
    }
    return;
  }

  /* ── API: Generate Cover Letter ── */
  if (pathname === '/api/cover-letter' && req.method === 'POST') {
    const body = await readBody(req);
    const { apiKey, model, job, profile, scoreData } = body;
    if (!apiKey || !job) { json(res, 400, { error: 'Missing apiKey or job' }); return; }
    try {
      const letter = await generateCoverLetter(apiKey, model || 'claude-sonnet-4-5', job, profile || {}, scoreData || {});
      json(res, 200, { letter });
    } catch (e) {
      json(res, 500, { error: e.message });
    }
    return;
  }

  /* ── API: Log to Google Sheets via Apps Script webhook ── */
  if (pathname === '/api/log-sheets' && req.method === 'POST') {
    const body = await readBody(req);
    const { sheetsUrl, entry } = body;
    if (!sheetsUrl) { json(res, 400, { error: 'No sheetsUrl provided' }); return; }
    try {
      const sheetsPayload = JSON.stringify(entry);
      const sheetsUrlParsed = new URL(sheetsUrl);
      await new Promise((resolve, reject) => {
        const reqOpts = {
          hostname: sheetsUrlParsed.hostname,
          path: sheetsUrlParsed.pathname + sheetsUrlParsed.search,
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(sheetsPayload) },
        };
        const r = https.request(reqOpts, res => { res.on('data', () => {}); res.on('end', resolve); });
        r.on('error', reject);
        r.write(sheetsPayload);
        r.end();
      });
      json(res, 200, { ok: true });
    } catch (e) {
      json(res, 500, { error: e.message });
    }
    return;
  }

  /* ── API: Health Check ── */
  if (pathname === '/api/health') {
    json(res, 200, { ok: true, version: '2.0.0', time: new Date().toISOString() });
    return;
  }

  /* ── Static File Server ── */
  let filePath = path.join(__dirname, pathname === '/' ? 'index.html' : pathname);
  const ext = path.extname(filePath);
  
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain' });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log('\n╔════════════════════════════════════════╗');
  console.log('║   🤖 AI Job Agent Server v2.0          ║');
  console.log(`║   Running at http://localhost:${PORT}     ║`);
  console.log('╚════════════════════════════════════════╝\n');
  console.log('✅ Static files served from:', __dirname);
  console.log('✅ Claude API proxy: /api/score, /api/cover-letter');
  console.log('✅ Job data: /api/jobs');
  console.log('✅ Sheets webhook: /api/log-sheets\n');
  console.log('👉 Open http://localhost:3000 in your browser\n');
});
