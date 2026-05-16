/* ═══════════════════════════════════════════════
   AI Job Agent v2 — app.js (Part 1/2)
   State, nav, setup, PDF parsing, profile, criteria
═══════════════════════════════════════════════ */

pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

/* ──────────────── STATE ──────────────── */
const state = {
  config: { anthropicKey: '', sheetsUrl: '', model: 'claude-sonnet-4-5' },
  profile: { resumeText: '', linkedinText: '', summary: '', resumeName: '', linkedinName: '' },
  criteria: { titles: '', keywords: '', excludeKeywords: '', location: '', workType: 'any', minSalary: '', expLevel: 'any', scoringRules: '', minScore: 70 },
  agent: { running: false, jobsScanned: 0, applied: 0, skipped: 0, scores: [], coverLetters: {} },
  log: [],
  setupDone: false,
  profileDone: false,
  criteriaDone: false,
};

function loadState() {
  try {
    const s = JSON.parse(localStorage.getItem('jobAgentState') || '{}');
    Object.assign(state.config, s.config || {});
    Object.assign(state.profile, s.profile || {});
    Object.assign(state.criteria, s.criteria || {});
    state.log = (s.log || []).map(e => ({ ...e, score: parseInt(e.score) || 0 }));
    state.setupDone = s.setupDone || false;
    state.profileDone = s.profileDone || false;
    state.criteriaDone = s.criteriaDone || false;
    state.agent.jobsScanned = s.agent?.jobsScanned || 0;
    state.agent.applied = s.agent?.applied || 0;
    state.agent.skipped = s.agent?.skipped || 0;
    state.agent.scores = (s.agent?.scores || []).map(n => parseInt(n) || 0);
    state.agent.coverLetters = s.agent?.coverLetters || {};
  } catch (e) {}
}

function saveState() {
  localStorage.setItem('jobAgentState', JSON.stringify({
    config: state.config, profile: state.profile, criteria: state.criteria,
    log: state.log, setupDone: state.setupDone, profileDone: state.profileDone,
    criteriaDone: state.criteriaDone,
    agent: { jobsScanned: state.agent.jobsScanned, applied: state.agent.applied,
             skipped: state.agent.skipped, scores: state.agent.scores,
             coverLetters: state.agent.coverLetters }
  }));
}

/* ──────────────── NAV ──────────────── */
function showSection(id, el) {
  event.preventDefault();
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.getElementById('sec-' + id).classList.add('active');
  if (el) el.classList.add('active');
  if (id === 'analytics') renderCharts();
}

/* ──────────────── SERVER CHECK ──────────────── */
async function checkServer() {
  const dot = document.getElementById('serverDot');
  const txt = document.getElementById('serverTxt');
  try {
    const r = await fetch('http://localhost:3000/api/health', { signal: AbortSignal.timeout(2000) });
    if (r.ok) {
      dot.className = 'server-dot ok';
      txt.textContent = 'Server online ✓';
      return true;
    }
  } catch {}
  dot.className = 'server-dot err';
  txt.textContent = 'Server offline';
  return false;
}

/* ──────────────── API HELPERS ──────────────── */
const PROXY = '';

async function apiCall(endpoint, payload) {
  const useProxy = document.getElementById('useProxy')?.checked !== false;
  if (useProxy) {
    const r = await fetch(PROXY + endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    return r.json();
  }
  // Direct Anthropic call (CORS only works in browser for approved origins)
  throw new Error('Direct API calls require the local proxy server (node server.js).');
}

/* ──────────────── SETUP ──────────────── */
function saveSetup() {
  state.config.anthropicKey = document.getElementById('anthropicKey').value.trim();
  state.config.rapidApiKey = document.getElementById('rapidApiKey').value.trim();
  state.config.sheetsUrl = document.getElementById('sheetsUrl').value.trim();
  state.config.model = document.getElementById('claudeModel').value;
  state.setupDone = !!state.config.anthropicKey && !!state.config.rapidApiKey;
  saveState(); updateChecks();
  showMsg('setupMsg', state.setupDone ? '✅ Configuration saved!' : '⚠️ Both Anthropic and RapidAPI keys are required.', state.setupDone ? 'ok' : 'err');
}

async function testAnthropicKey() {
  const key = document.getElementById('anthropicKey').value.trim();
  if (!key) { showMsg('setupMsg', '❌ Enter your API key first.', 'err'); return; }
  const btn = document.getElementById('testKeyBtn');
  btn.textContent = 'Testing…'; btn.disabled = true;
  showMsg('setupMsg', '🔄 Connecting to Claude…', '');
  try {
    const res = await apiCall('/api/test-key', { apiKey: key, model: document.getElementById('claudeModel').value });
    if (res.ok) {
      showMsg('setupMsg', `✅ Connected! Model: ${res.model} | Tokens used: ${res.usage?.input_tokens || '—'}`, 'ok');
    } else {
      showMsg('setupMsg', `❌ ${res.error}`, 'err');
    }
  } catch (e) {
    showMsg('setupMsg', `❌ ${e.message} — Is the server running? (node server.js)`, 'err');
  }
  btn.textContent = 'Test'; btn.disabled = false;
}

/* ──────────────── PDF PARSING ──────────────── */
async function extractPdfText(file) {
  const buffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
  let text = '';
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    text += content.items.map(item => item.str).join(' ') + '\n';
  }
  return text.trim();
}

async function handleFileUpload(event, type) {
  const file = event.target.files[0];
  if (!file) return;
  const previewId = type === 'resume' ? 'resumePreview' : 'linkedinPreview';
  const zoneId   = type === 'resume' ? 'resumeZone'    : 'linkedinZone';
  const preview  = document.getElementById(previewId);
  preview.className = 'file-preview';
  preview.innerHTML = `⏳ Reading <strong>${file.name}</strong>…`;

  try {
    let text = '';
    if (file.name.endsWith('.pdf')) {
      text = await extractPdfText(file);
    } else {
      text = await file.text();
    }
    text = text.slice(0, 9000);
    if (type === 'resume') {
      state.profile.resumeText = text;
      state.profile.resumeName = file.name;
    } else {
      state.profile.linkedinText = text;
      state.profile.linkedinName = file.name;
    }
    preview.innerHTML = `✅ <strong>${file.name}</strong> — ${(file.size / 1024).toFixed(1)} KB · ${text.split(/\s+/).length} words extracted`;
    document.getElementById(zoneId).style.borderColor = 'rgba(34,197,94,0.5)';
  } catch (e) {
    preview.innerHTML = `❌ Failed to read file: ${e.message}`;
  }
}

function handleDrop(event, type) {
  event.preventDefault();
  const file = event.dataTransfer.files[0];
  if (!file) return;
  handleFileUpload({ target: { files: [file] } }, type);
}

function saveProfile() {
  state.profile.summary = document.getElementById('personalSummary').value.trim();
  state.profileDone = !!(state.profile.resumeText || state.profile.summary);
  saveState(); updateChecks();
  showMsg('profileMsg', state.profileDone ? '✅ Profile saved!' : '⚠️ Upload a resume or add a summary.', state.profileDone ? 'ok' : 'err');
}

/* ──────────────── CRITERIA ──────────────── */
function syncSlider(val) {
  document.getElementById('minScoreSlider').value = val;
  document.getElementById('minScore').value = val;
}

function saveCriteria() {
  state.criteria.titles = document.getElementById('jobTitles').value.trim();
  state.criteria.keywords = document.getElementById('keywords').value.trim();
  state.criteria.excludeKeywords = document.getElementById('excludeKeywords').value.trim();
  state.criteria.location = document.getElementById('location').value.trim();
  state.criteria.workType = document.getElementById('workType').value;
  state.criteria.minSalary = document.getElementById('minSalary').value;
  state.criteria.expLevel = document.getElementById('expLevel').value;
  state.criteria.scoringRules = document.getElementById('scoringRules').value.trim();
  state.criteria.minScore = parseInt(document.getElementById('minScore').value) || 70;
  state.criteriaDone = !!state.criteria.titles;
  saveState(); updateChecks();
  showMsg('criteriaMsg', state.criteriaDone ? '✅ Criteria saved!' : '⚠️ Add at least one job title.', state.criteriaDone ? 'ok' : 'err');
}

/* ──────────────── N8N BLUEPRINT ──────────────── */
function downloadN8nBlueprint() {
  const blueprint = {
    "name": "AI Job Application Agent v2",
    "nodes": [
      {
        "id": "trigger", "name": "Schedule Trigger", "type": "n8n-nodes-base.scheduleTrigger",
        "position": [200, 300],
        "parameters": { "rule": { "interval": [{ "field": "hours", "hoursInterval": 6 }] } }
      },
      {
        "id": "jobs", "name": "Fetch LinkedIn Jobs", "type": "n8n-nodes-base.httpRequest",
        "position": [420, 300],
        "parameters": {
          "url": "https://api.linkedin.com/v2/jobSearch",
          "method": "GET",
          "headers": { "Authorization": "Bearer {{$vars.LINKEDIN_TOKEN}}" },
          "queryParameters": { "keywords": "={{$vars.JOB_TITLES}}", "location": "={{$vars.LOCATION}}", "count": 25 }
        }
      },
      {
        "id": "loop", "name": "Loop Over Jobs", "type": "n8n-nodes-base.splitInBatches",
        "position": [640, 300], "parameters": { "batchSize": 1 }
      },
      {
        "id": "claude", "name": "Claude Job Scorer", "type": "@n8n/n8n-nodes-langchain.lmChatAnthropic",
        "position": [860, 300],
        "parameters": {
          "model": "claude-haiku-3-5",
          "messages": { "values": [{ "role": "user", "content": "Score this job 0-100. Resume: {{$vars.RESUME}}. Job: {{$json.title}} at {{$json.company}}. Description: {{$json.description}}. Return JSON: {score, verdict, reasons}" }] }
        }
      },
      {
        "id": "filter", "name": "Filter High-Score Jobs", "type": "n8n-nodes-base.filter",
        "position": [1080, 300],
        "parameters": { "conditions": { "number": [{ "value1": "={{JSON.parse($json.text).score}}", "operation": "largerEqual", "value2": 70 }] } }
      },
      {
        "id": "sheets", "name": "Log to Google Sheets", "type": "n8n-nodes-base.googleSheets",
        "position": [1300, 300],
        "parameters": {
          "operation": "appendOrUpdate",
          "sheetId": "={{$vars.SHEET_ID}}",
          "columns": { "mappingMode": "defineBelow", "values": { "Company": "={{$json.company}}", "Role": "={{$json.title}}", "Score": "={{JSON.parse($json.text).score}}", "Status": "Applied", "Applied At": "={{$now}}" } }
        }
      }
    ],
    "connections": {
      "trigger": { "main": [[{ "node": "jobs", "type": "main", "index": 0 }]] },
      "jobs": { "main": [[{ "node": "loop", "type": "main", "index": 0 }]] },
      "loop": { "main": [[{ "node": "claude", "type": "main", "index": 0 }]] },
      "claude": { "main": [[{ "node": "filter", "type": "main", "index": 0 }]] },
      "filter": { "main": [[{ "node": "sheets", "type": "main", "index": 0 }]] }
    }
  };
  const blob = new Blob([JSON.stringify(blueprint, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'job-agent-n8n-blueprint.json';
  a.click();
}

/* ──────────────── APPS SCRIPT ──────────────── */
const APPS_SCRIPT = `// Google Apps Script — AI Job Agent Logger
// Deploy as Web App with "Anyone" access
// Paste the URL in Setup > Google Sheets Webhook URL

const SHEET_NAME = 'Applications';

function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let sheet = ss.getSheetByName(SHEET_NAME);
    if (!sheet) {
      sheet = ss.insertSheet(SHEET_NAME);
      sheet.appendRow(['#','Company','Role','Location','Score','Status','Verdict','Applied At','Cover Letter']);
      sheet.getRange(1, 1, 1, 9).setFontWeight('bold').setBackground('#1a1a2e').setFontColor('#ffffff');
    }
    const nextRow = sheet.getLastRow() + 1;
    sheet.appendRow([
      nextRow - 1,
      data.company || '',
      data.role || '',
      data.location || '',
      data.score || 0,
      data.status || 'unknown',
      data.verdict || '',
      data.time || new Date().toISOString(),
      data.coverLetter || ''
    ]);
    // Color-code by score
    const scoreCell = sheet.getRange(nextRow, 5);
    const score = parseInt(data.score) || 0;
    if (score >= 80) scoreCell.setBackground('#1a4731').setFontColor('#22c55e');
    else if (score >= 60) scoreCell.setBackground('#3d2e0a').setFontColor('#f59e0b');
    else scoreCell.setBackground('#3d1515').setFontColor('#ef4444');

    return ContentService.createTextOutput(JSON.stringify({ ok: true }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch(err) {
    return ContentService.createTextOutput(JSON.stringify({ error: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function doGet(e) {
  return ContentService.createTextOutput(JSON.stringify({ status: 'AI Job Agent Logger is live!' }))
    .setMimeType(ContentService.MimeType.JSON);
}`;

function copyAppsScript() {
  navigator.clipboard.writeText(APPS_SCRIPT).then(() => {
    showMsg('setupMsg', '✅ Apps Script copied to clipboard!', 'ok');
  });
}

/* ──────────────── CHECKS & HELPERS ──────────────── */
function updateChecks() {
  const set = (id, chkId, done) => {
    document.getElementById(id).classList.toggle('done', done);
    document.getElementById(chkId).textContent = done ? '✅' : '○';
  };
  set('step1', 'chk1', state.setupDone);
  set('step2', 'chk2', state.profileDone);
  set('step3', 'chk3', state.criteriaDone);
  set('step4', 'chk4', state.agent.applied > 0);
}

function showMsg(id, text, type) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text;
  el.className = 'msg ' + (type || '');
}

/* ═══════════════════════════════════════════════
   Part 2 — Agent, Log, Analytics, Tools, Init
═══════════════════════════════════════════════ */

const DEMO_JOBS = [
  { id:'j1', company:'Stripe', role:'Senior Frontend Engineer', location:'Remote', salary:160000, tags:['React','TypeScript','GraphQL'], description:'Build scalable payment UIs used by millions. React, TypeScript, GraphQL.' },
  { id:'j2', company:'Notion', role:'Full Stack Developer', location:'San Francisco, CA', salary:140000, tags:['React','Node.js','PostgreSQL'], description:'Redefining productivity. Full stack for 30M+ users.' },
  { id:'j3', company:'Linear', role:'Product Engineer', location:'Remote', salary:150000, tags:['React','Rust','Design Systems'], description:'Next-gen issue tracker. Own features end-to-end.' },
  { id:'j4', company:'Figma', role:'Software Engineer', location:'New York, NY', salary:155000, tags:['TypeScript','WebGL','Canvas API'], description:'Collaborative design platform. Deep TypeScript + rendering APIs.' },
  { id:'j5', company:'Vercel', role:'Backend Engineer', location:'Remote', salary:145000, tags:['Node.js','Edge Computing','AWS'], description:'Infrastructure that powers the modern web. Edge and serverless.' },
  { id:'j6', company:'TechCorp', role:'PHP Developer', location:'Chicago, IL', salary:70000, tags:['PHP','MySQL','Legacy Systems'], description:'Maintain legacy PHP HR system. PHP 5.6 and MySQL.' },
  { id:'j7', company:'OpenAI', role:'ML Infrastructure Engineer', location:'San Francisco, CA', salary:220000, tags:['Python','Kubernetes','CUDA','PyTorch'], description:'Infrastructure for frontier AI training at massive scale.' },
  { id:'j8', company:'Airbnb', role:'Staff Engineer', location:'Remote', salary:230000, tags:['Java','Microservices','Kafka','React'], description:'Lead core booking systems. 8+ years, large-scale distributed systems.' },
  { id:'j9', company:'GitHub', role:'Developer Experience Engineer', location:'Remote', salary:170000, tags:['TypeScript','React','Developer Tools'], description:'Build CLI features and Actions integrations for 100M developers.' },
  { id:'j10', company:'Anthropic', role:'Product Engineer', location:'Remote', salary:200000, tags:['React','Python','AI/ML','TypeScript'], description:'Interfaces for Claude. Frontier AI product development.' },
  { id:'j11', company:'Supabase', role:'Full Stack Engineer', location:'Remote', salary:130000, tags:['TypeScript','PostgreSQL','React','Rust'], description:'Open-source Firebase alternative. Dashboard, SDKs, real-time infra.' },
  { id:'j12', company:'DataCo', role:'Junior Developer', location:'Austin, TX', salary:0, tags:['Unpaid','Internship','PHP'], description:'Unpaid internship. PHP experience preferred.' },
];

let agentInterval = null;
let jobQueue = [];

function toggleAgent() { state.agent.running ? stopAgent() : startAgent(); }

async function startAgent() {
  if (!state.setupDone)    { consolePrint('❌ Configure API keys in Setup first!', 'error'); return; }
  if (!state.profileDone)  { consolePrint('❌ Upload your resume in My Profile first!', 'error'); return; }
  if (!state.criteriaDone) { consolePrint('❌ Set job criteria first!', 'error'); return; }
  
  state.agent.running = true;
  setAgentUI(true);
  
  consolePrint('🚀 Agent started — fetching live jobs from RapidAPI…', 'info');
  consolePrint(`🎯 Targeting: ${state.criteria.titles}`, 'info');
  consolePrint(`📍 ${state.criteria.location || 'Any'} | min score: ${state.criteria.minScore}`, 'info');
  consolePrint('─'.repeat(56), 'dim');

  try {
    const res = await apiCall('/api/jobs', { rapidApiKey: state.config.rapidApiKey, criteria: state.criteria });
    jobQueue = res.jobs || [];
    if (jobQueue.length === 0) {
      consolePrint('⚠️ No jobs found matching criteria.', 'warn');
      stopAgent();
      return;
    }
    consolePrint(`✅ Found ${jobQueue.length} jobs. Starting evaluation…`, 'success');
    processNextJob();
  } catch (e) {
    consolePrint(`❌ Failed to fetch jobs: ${e.message}`, 'error');
    stopAgent();
  }
}

async function processNextJob() {
  if (!state.agent.running || jobQueue.length === 0) {
    stopAgent();
    consolePrint('✅ All jobs processed!', 'success');
    addActivity('Scan complete', '🏁');
    renderCharts();
    return;
  }
  const job = jobQueue.shift();
  state.agent.jobsScanned++;
  consolePrint(`🔍 [${state.agent.jobsScanned}] Evaluating: ${job.role} @ ${job.company}`, '');
  let scoreData;
  try {
    const res = await apiCall('/api/score', { apiKey: state.config.anthropicKey, model: 'claude-haiku-3-5', job, profile: state.profile, criteria: state.criteria });
    scoreData = res;
    consolePrint(`  📊 Score: ${scoreData.score}/100 — ${scoreData.verdict}`, scoreData.score >= state.criteria.minScore ? 'success' : 'warn');
    (scoreData.reasons || []).forEach(r => consolePrint(`     → ${r}`, 'dim'));
  } catch (e) {
    consolePrint(`  ⚠️ API error: ${e.message}`, 'error');
    scoreData = { score: 0, verdict: 'skip', reasons: [e.message] };
  }
  const minScore = state.criteria.minScore || 70;
  const autoApply = document.getElementById('autoApply').checked;
  const shouldApply = autoApply && scoreData.score >= minScore;
  const status = shouldApply ? 'applied' : (scoreData.verdict === 'review' ? 'review' : 'skipped');
  if (shouldApply) {
    state.agent.applied++;
    consolePrint(`  ⏳ Approved! Pending manual submit.`, 'success');
    addActivity(`Pending Submit: ${job.role} @ ${job.company} (${scoreData.score}/100)`, '⏳');
    if (document.getElementById('genCovers').checked) {
      try {
        consolePrint(`  ✍️ Generating cover letter…`, 'info');
        const clRes = await apiCall('/api/cover-letter', { apiKey: state.config.anthropicKey, model: state.config.model, job, profile: state.profile, scoreData });
        state.agent.coverLetters[job.id] = clRes.letter;
        consolePrint(`  📄 Cover letter ready.`, 'success');
      } catch (e) { consolePrint(`  ⚠️ Cover letter failed: ${e.message}`, 'warn'); }
    }
  } else {
    state.agent.skipped++;
    consolePrint(`  ⏩ Skipped (score ${scoreData.score} < ${minScore})`, 'warn');
  }
  state.agent.scores.push(scoreData.score);
  addLogEntry(job, scoreData, status);
  updateStats();
  if (document.getElementById('logSheets').checked && state.config.sheetsUrl) logToSheets(job, scoreData, status);
  const delay = parseInt(document.getElementById('appDelay').value) || 2000;
  agentInterval = setTimeout(processNextJob, delay);
}

function stopAgent() {
  clearTimeout(agentInterval);
  state.agent.running = false;
  setAgentUI(false);
  consolePrint('⏹ Agent stopped.', 'warn');
  addActivity('Agent stopped', '⏹');
  saveState();
}

function setAgentUI(running) {
  document.getElementById('agentOrb').classList.toggle('running', running);
  document.getElementById('runBtn').classList.toggle('stop', running);
  document.getElementById('runBtn').textContent = running ? '⏹ Stop Agent' : '▶ Start Agent';
  document.getElementById('agentStatusDot').classList.toggle('running', running);
  document.getElementById('agentStatusText').textContent = running ? 'Agent Running' : 'Agent Idle';
  document.getElementById('agentStateText').textContent = running ? 'Agent Active' : 'Ready to Launch';
  document.getElementById('agentSub').textContent = running ? 'Scanning jobs with Claude…' : 'Complete setup, profile, and criteria first';
}





function addLogEntry(job, scoreData, status) {
  const entry = { id: state.log.length + 1, company: job.company, role: job.role, location: job.location, score: scoreData.score, verdict: scoreData.verdict, reasons: scoreData.reasons || [], redFlags: scoreData.redFlags || [], coverLetterHint: scoreData.coverLetterHint || '', status, appliedAt: new Date().toLocaleTimeString(), jobId: job.id, coverLetter: state.agent.coverLetters[job.id] || '', url: job.url || '' };
  state.log.unshift(entry);
  document.getElementById('logCount').textContent = state.log.length;
  saveState(); renderLog(); renderRecent();
}

function renderLog(data) {
  const rows = data || state.log;
  const tbody = document.getElementById('logBody');
  if (!rows.length) { tbody.innerHTML = '<tr><td colspan="8" class="empty-row">No applications yet.</td></tr>'; return; }
  tbody.innerHTML = rows.map(e => `<tr><td style="color:var(--muted);font-size:0.78rem">${e.id}</td><td><strong>${e.company}</strong></td><td>${e.role}</td><td style="color:var(--muted);font-size:0.8rem">${e.location}</td><td><span class="score-pill ${e.score>=70?'score-high':e.score>=50?'score-mid':'score-low'}">${e.score}</span></td><td><span class="badge ${e.status}">${e.status === 'applied' ? 'Pending Submit' : e.status}</span></td><td style="color:var(--muted);font-size:0.76rem;font-family:monospace">${e.appliedAt}</td><td><button class="action-btn" onclick="openJobModal(${e.id})">Detail</button></td></tr>`).join('');
}

function renderRecent() {
  const tbody = document.getElementById('recentBody');
  const rows = state.log.slice(0, 5);
  if (!rows.length) { tbody.innerHTML = '<tr><td colspan="4" class="empty-row">No applications yet.</td></tr>'; return; }
  tbody.innerHTML = rows.map(e => `<tr><td><strong>${e.company}</strong></td><td>${e.role}</td><td><span class="score-pill ${e.score>=70?'score-high':e.score>=50?'score-mid':'score-low'}">${e.score}</span></td><td><span class="badge ${e.status}">${e.status === 'applied' ? 'Pending Submit' : e.status}</span></td></tr>`).join('');
}

function filterLog() {
  const q = document.getElementById('logSearch').value.toLowerCase();
  const f = document.getElementById('logFilter').value;
  renderLog(state.log.filter(e => (!q || e.company.toLowerCase().includes(q) || e.role.toLowerCase().includes(q)) && (f === 'all' || e.status === f)));
}

function clearLog() {
  if (!confirm('Clear all application logs?')) return;
  state.log = []; state.agent.jobsScanned = 0; state.agent.applied = 0;
  state.agent.skipped = 0; state.agent.scores = []; state.agent.coverLetters = {};
  document.getElementById('logCount').textContent = 0;
  saveState(); renderLog(); renderRecent(); updateStats();
  document.getElementById('activityFeed').innerHTML = '<div class="activity-empty">No activity yet.</div>';
  document.getElementById('agentConsole').innerHTML = '<div class="console-line dim">// Console cleared.</div>';
  renderCharts();
}

function exportCSV() {
  if (!state.log.length) return;
  const hdr = 'ID,Company,Role,Location,Score,Status,Verdict,Applied At\n';
  const rows = state.log.map(e => `${e.id},"${e.company}","${e.role}","${e.location}",${e.score},${e.status},${e.verdict||''},"${e.appliedAt}"`).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([hdr+rows],{type:'text/csv'}));
  a.download = 'job-applications.csv'; a.click();
}

async function logToSheets(job, scoreData, status) {
  try {
    await fetch(PROXY + '/api/log-sheets', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ sheetsUrl: state.config.sheetsUrl, entry: { company:job.company, role:job.role, location:job.location, score:scoreData.score, status, verdict:scoreData.verdict, time:new Date().toISOString(), coverLetter: state.agent.coverLetters[job.id]||'' } }) });
  } catch {}
}

function openJobModal(id) {
  const e = state.log.find(x => x.id === id);
  if (!e) return;
  const cover = state.agent.coverLetters[e.jobId] || '';
  document.getElementById('modalContent').innerHTML = `
    <h3>${e.role} @ ${e.company}</h3>
    <p style="color:var(--muted);font-size:0.84rem;margin-bottom:1rem">${e.location} &middot; ${e.appliedAt}</p>
    <div class="modal-score-big" style="color:${e.score>=70?'var(--success)':e.score>=50?'var(--warn)':'var(--danger)'}">${e.score}<span style="font-size:1.2rem;color:var(--muted)">/100</span></div>
    <p style="text-align:center;margin-bottom:1.2rem"><span class="badge ${e.status}">${e.status === 'applied' ? 'Pending Submit' : e.status}</span></p>
    ${e.url && e.status === 'applied' ? `<div style="text-align:center; margin-bottom: 1.5rem;"><a href="${e.url}" target="_blank" class="btn-primary" style="display:inline-block; text-decoration:none;">🚀 Apply Now on Employer Site</a></div>` : ''}
    ${e.reasons?.length?`<h4 style="font-size:0.84rem;margin-bottom:0.5rem">📋 Reasons</h4><ul class="modal-reasons">${e.reasons.map(r=>`<li>&rarr; ${r}</li>`).join('')}</ul>`:''}
    ${e.redFlags?.length?`<h4 style="font-size:0.84rem;margin-bottom:0.5rem;color:var(--danger)">🚩 Red Flags</h4><ul class="modal-reasons">${e.redFlags.map(r=>`<li style="color:var(--danger)">&#9888; ${r}</li>`).join('')}</ul>`:''}
    ${cover?`<h4 style="font-size:0.84rem;margin:1rem 0 0.5rem">✍️ Cover Letter</h4><div class="cover-in-modal">${cover}</div><button class="btn-secondary" onclick="navigator.clipboard.writeText(document.querySelector('.cover-in-modal').textContent)" style="margin-top:0.5rem">📋 Copy to Clipboard</button>`:''}
  `;
  document.getElementById('modalOverlay').classList.remove('hidden');
}

function closeModal() { document.getElementById('modalOverlay').classList.add('hidden'); }

function updateStats() {
  document.getElementById('stat-scanned').textContent = state.agent.jobsScanned;
  document.getElementById('stat-applied').textContent = state.log.filter(e=>e.status==='applied').length;
  document.getElementById('stat-skipped').textContent = state.log.filter(e=>e.status==='skipped').length;
  const scores = state.log.map(e => parseInt(e.score)||0).filter(s=>s>0);
  const avg = scores.length ? Math.round(scores.reduce((a,b)=>a+b,0)/scores.length) : '—';
  document.getElementById('stat-score').textContent = avg;
}

function addActivity(msg, icon) {
  const feed = document.getElementById('activityFeed');
  const empty = feed.querySelector('.activity-empty');
  if (empty) empty.remove();
  const div = document.createElement('div');
  div.className = 'activity-item';
  div.innerHTML = `<span>${icon}</span><span style="flex:1">${msg}</span><span class="activity-time">${new Date().toLocaleTimeString()}</span>`;
  feed.insertBefore(div, feed.firstChild);
  if (feed.children.length > 20) feed.removeChild(feed.lastChild);
}

function consolePrint(text, type) {
  const con = document.getElementById('agentConsole');
  const div = document.createElement('div');
  div.className = 'console-line ' + (type || '');
  div.textContent = `[${new Date().toLocaleTimeString()}] ${text}`;
  con.appendChild(div);
  con.scrollTop = con.scrollHeight;
}

function clearConsole() {
  document.getElementById('agentConsole').innerHTML = '<div class="console-line dim">// Console cleared.</div>';
}

let scoreChartInst = null, statusChartInst = null;

function renderCharts() {
  // Rebuild scores array from log in case of stale state
  const allScores = state.log.map(e => parseInt(e.score) || 0);
  const buckets = [0,0,0,0,0];
  allScores.forEach(s => { buckets[Math.min(4, Math.floor(s/20))]++; });
  const sCtx = document.getElementById('scoreChart').getContext('2d');
  if (scoreChartInst) scoreChartInst.destroy();
  scoreChartInst = new Chart(sCtx, { type:'bar', data:{ labels:['0-19','20-39','40-59','60-79','80-100'], datasets:[{ label:'Jobs', data:buckets, backgroundColor:['#ef444433','#f59e0b33','#facc1533','#22c55e33','#22c55e66'], borderColor:['#ef4444','#f59e0b','#facc15','#22c55e','#16a34a'], borderWidth:2, borderRadius:6 }] }, options:{ responsive:true, plugins:{legend:{display:false}}, scales:{ x:{ticks:{color:'#5a6278'},grid:{color:'rgba(255,255,255,0.04)'}}, y:{ticks:{color:'#5a6278',stepSize:1},grid:{color:'rgba(255,255,255,0.04)'}} } } });
  const applied = state.log.filter(e=>e.status==='applied').length;
  const skipped = state.log.filter(e=>e.status==='skipped').length;
  const review  = state.log.filter(e=>e.status==='review').length;
  const dCtx = document.getElementById('statusChart').getContext('2d');
  if (statusChartInst) statusChartInst.destroy();
  statusChartInst = new Chart(dCtx, { type:'doughnut', data:{ labels:['Applied','Skipped','Review'], datasets:[{ data:[applied||0,skipped||0,review||0], backgroundColor:['rgba(34,197,94,0.7)','rgba(239,68,68,0.6)','rgba(245,158,11,0.6)'], borderColor:'transparent' }] }, options:{ responsive:true, cutout:'65%', plugins:{legend:{labels:{color:'#8892a4',boxWidth:12}}} } });
  const byCompany = {};
  state.log.forEach(e => {
    const s = parseInt(e.score) || 0;
    if (!byCompany[e.company] || s > byCompany[e.company]) byCompany[e.company] = s;
  });
  const sorted = Object.entries(byCompany).sort((a,b)=>b[1]-a[1]).slice(0,6);
  const tc = document.getElementById('topCompanies');
  if (!sorted.length) { tc.innerHTML = '<div class="activity-empty">Run the agent first.</div>'; return; }
  tc.innerHTML = sorted.map(([co,sc]) => `<div class="top-item"><span style="font-size:0.84rem;font-weight:600;width:130px">${co}</span><div class="top-bar-wrap"><div class="top-bar" style="width:${sc}%"></div></div><span class="top-score">${sc}</span></div>`).join('');
}

async function generateManualCoverLetter() {
  if (!state.config.anthropicKey) { alert('Add your Anthropic API key in Setup first.'); return; }
  const job = { company: document.getElementById('clCompany').value.trim()||'Company', role: document.getElementById('clRole').value.trim()||'Role', description: document.getElementById('clDesc').value.trim(), tags:[], location:'', salary:0 };
  const btn = document.getElementById('genCLBtn');
  btn.textContent = '⏳ Generating…'; btn.disabled = true;
  try {
    const res = await apiCall('/api/cover-letter', { apiKey: state.config.anthropicKey, model: state.config.model, job, profile: state.profile, scoreData:{} });
    document.getElementById('coverLetterText').textContent = res.letter;
    document.getElementById('coverOutput').classList.remove('hidden');
  } catch (e) { alert('Error: ' + e.message); }
  btn.textContent = '✨ Generate with Claude'; btn.disabled = false;
}

function copyCoverLetter() {
  navigator.clipboard.writeText(document.getElementById('coverLetterText').textContent).then(()=>alert('✅ Copied!'));
}

async function scoreResume() {
  if (!state.config.anthropicKey) { alert('Add your Anthropic API key in Setup first.'); return; }
  const desc = document.getElementById('rsJobDesc').value.trim();
  if (!desc) { alert('Paste a job description first.'); return; }
  try {
    const res = await apiCall('/api/score', { apiKey: state.config.anthropicKey, model: state.config.model, job:{ company:'Target', role:'Target Role', description:desc, tags:[], location:'', salary:0 }, profile: state.profile, criteria: state.criteria });
    let txt = `Score: ${res.score}/100  |  Verdict: ${res.verdict}\n\nReasons:\n`;
    (res.reasons||[]).forEach(r => txt += `• ${r}\n`);
    if (res.redFlags?.length) { txt += '\nRed Flags:\n'; res.redFlags.forEach(f => txt += `⚠ ${f}\n`); }
    if (res.coverLetterHint) txt += `\nCover Letter Hook:\n${res.coverLetterHint}`;
    document.getElementById('resumeScoreText').textContent = txt;
    document.getElementById('resumeScoreOutput').classList.remove('hidden');
  } catch (e) { alert('Error: ' + e.message); }
}

async function checkServer() {
  const dot = document.getElementById('serverDot');
  const txt = document.getElementById('serverTxt');
  try {
    const r = await fetch(PROXY + '/api/health', { signal: AbortSignal.timeout(2000) });
    if (r.ok) { dot.className='server-dot ok'; txt.textContent='Server online ✓'; return true; }
  } catch {}
  dot.className = 'server-dot err'; txt.textContent = 'Server offline';
  return false;
}

function init() {
  loadState();
  document.getElementById('anthropicKey').value = state.config.anthropicKey || '';
  document.getElementById('rapidApiKey').value = state.config.rapidApiKey || '';
  document.getElementById('sheetsUrl').value = state.config.sheetsUrl || '';
  document.getElementById('claudeModel').value = state.config.model || 'claude-sonnet-4-5';
  document.getElementById('personalSummary').value = state.profile.summary || '';
  document.getElementById('jobTitles').value = state.criteria.titles || '';
  document.getElementById('keywords').value = state.criteria.keywords || '';
  document.getElementById('excludeKeywords').value = state.criteria.excludeKeywords || '';
  document.getElementById('location').value = state.criteria.location || '';
  document.getElementById('workType').value = state.criteria.workType || 'any';
  document.getElementById('minSalary').value = state.criteria.minSalary || '';
  document.getElementById('expLevel').value = state.criteria.expLevel || 'any';
  document.getElementById('scoringRules').value = state.criteria.scoringRules || '';
  document.getElementById('minScore').value = state.criteria.minScore || 70;
  document.getElementById('minScoreSlider').value = state.criteria.minScore || 70;
  if (state.profile.resumeName) { const p=document.getElementById('resumePreview'); p.className='file-preview'; p.innerHTML=`✅ <strong>${state.profile.resumeName}</strong> (saved)`; document.getElementById('resumeZone').style.borderColor='rgba(34,197,94,0.5)'; }
  if (state.profile.linkedinName) { const p=document.getElementById('linkedinPreview'); p.className='file-preview'; p.innerHTML=`✅ <strong>${state.profile.linkedinName}</strong> (saved)`; document.getElementById('linkedinZone').style.borderColor='rgba(34,197,94,0.5)'; }
  document.getElementById('appsScriptCode').textContent = APPS_SCRIPT;
  document.getElementById('logCount').textContent = state.log.length;
  updateStats(); updateChecks(); renderLog(); renderRecent();
  checkServer();
  setInterval(checkServer, 30000);
}

init();
