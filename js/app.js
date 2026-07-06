/* Épreuve C1 — Service Client Amazon (v2)
   Auth: Supabase (email/password). Grading: Supabase Edge Function → OpenRouter.
   API key never leaves the server. */

"use strict";

/* ---------------- config & state ---------------- */

const COUNTS = { comprehension: 5, oral: 4, writing: 4 };
const WRITE_MAX_WORDS = 100;

// user-adjustable timers (seconds); 0 = no limit
const timerDefaults = { mcq: 90, oral: 60, writing: 480 };
const timers = {
  mcq: Number(localStorage.getItem("c1_t_mcq") ?? timerDefaults.mcq),
  oral: Number(localStorage.getItem("c1_t_oral") ?? timerDefaults.oral),
  writing: Number(localStorage.getItem("c1_t_writing") ?? timerDefaults.writing),
};

const sb = window.supabase.createClient(window.C1_CONFIG.SUPABASE_URL, window.C1_CONFIG.SUPABASE_ANON_KEY);

let bank = null;
let session = null;
let answers = null;
let phase = { section: "auth", index: 0 };
let qTimer = null; // active question countdown

const $app = document.getElementById("app");

/* ---------------- utils ---------------- */

const shuffle = (arr) => arr.map(v => [Math.random(), v]).sort((a, b) => a[0] - b[0]).map(p => p[1]);
const pick = (arr, n) => shuffle(arr).slice(0, Math.min(n, arr.length));
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const wordCount = (s) => (s.trim().match(/[\p{L}\p{N}'’-]+/gu) || []).length;
const fmtTime = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

function setProgress() {
  const total = COUNTS.comprehension + COUNTS.oral + COUNTS.writing;
  let done = 0, label = "";
  if (phase.section === "comprehension") { done = phase.index; label = `Épreuve I · ${phase.index + 1}/${COUNTS.comprehension}`; }
  else if (phase.section === "oral") { done = COUNTS.comprehension + phase.index; label = `Épreuve II · ${phase.index + 1}/${COUNTS.oral}`; }
  else if (phase.section === "writing") { done = COUNTS.comprehension + COUNTS.oral + phase.index; label = `Épreuve III · ${phase.index + 1}/${COUNTS.writing}`; }
  else if (phase.section === "results" || phase.section === "grading") { done = total; label = "Résultats"; }
  document.getElementById("progress-fill").style.width = `${(done / total) * 100}%`;
  document.getElementById("session-progress").textContent = label;
}

function ticket(eyebrow, title, constraint, bodyHTML) {
  return `<section class="ticket">
    <div class="ticket-head">
      <div><div class="eyebrow">${eyebrow}</div><h2>${title}</h2></div>
      ${constraint ? `<span class="constraint">${constraint}</span>` : ""}
    </div>
    <div class="ticket-body">${bodyHTML}</div>
  </section>`;
}

function clearQTimer() { if (qTimer) { clearInterval(qTimer.id); qTimer = null; } }

/* Countdown chip in ticket head. onExpire fires once. */
function startQTimer(seconds, onExpire) {
  clearQTimer();
  const $chip = document.getElementById("q-timer");
  if (!seconds || !$chip) { if ($chip) $chip.textContent = "sans limite"; return; }
  let left = seconds;
  $chip.textContent = fmtTime(left);
  qTimer = { id: setInterval(() => {
    left--;
    $chip.textContent = fmtTime(Math.max(0, left));
    if (left <= 10) $chip.classList.add("t-danger");
    if (left <= 0) { clearQTimer(); onExpire(); }
  }, 1000) };
}

/* ---------------- auth ---------------- */

async function getSessionUser() {
  const { data } = await sb.auth.getSession();
  return data.session?.user ?? null;
}

function renderAuth(msg = "") {
  phase = { section: "auth", index: 0 };
  document.getElementById("session-progress").textContent = "";
  $app.innerHTML = ticket("Accès", "Connexion", "", `
    ${msg ? `<div class="notice ${msg.startsWith("✔") ? "warn" : "err"}">${esc(msg)}</div>` : ""}
    <label class="field"><span>E-mail</span><input type="email" id="auth-email" autocomplete="email"></label>
    <label class="field"><span>Mot de passe</span><input type="password" id="auth-pass" autocomplete="current-password"></label>
    <div class="actions">
      <button id="btn-signup" class="btn-outline">Créer un compte</button>
      <button id="btn-login" class="btn-primary">Se connecter</button>
    </div>
  `);
  const creds = () => ({
    email: document.getElementById("auth-email").value.trim(),
    password: document.getElementById("auth-pass").value,
  });
  document.getElementById("btn-login").onclick = async () => {
    const { error } = await sb.auth.signInWithPassword(creds());
    if (error) return renderAuth(error.message);
    afterLogin();
  };
  document.getElementById("btn-signup").onclick = async () => {
    const { error } = await sb.auth.signUp(creds());
    if (error) return renderAuth(error.message);
    renderAuth("✔ Compte créé. Vérifiez votre e-mail pour confirmer, puis connectez-vous.");
  };
}

async function afterLogin() {
  const user = await getSessionUser();
  if (!user) return renderAuth();
  document.getElementById("user-email").textContent = user.email;
  const $out = document.getElementById("btn-logout");
  $out.classList.remove("hidden");
  $out.onclick = async () => { await sb.auth.signOut(); location.reload(); };
  renderIntro();
}

/* ---------------- edge function calls ---------------- */

async function callGrade(kind, messages, jsonMode = true) {
  const { data: { session: s } } = await sb.auth.getSession();
  if (!s) throw new Error("Session expirée — reconnectez-vous.");
  const res = await fetch(`${window.C1_CONFIG.SUPABASE_URL}/functions/v1/grade`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${s.access_token}`,
      "apikey": window.C1_CONFIG.SUPABASE_ANON_KEY,
    },
    body: JSON.stringify({ kind, messages, jsonMode }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  const txt = data.content || "";
  if (!jsonMode) return txt;
  const clean = txt.replace(/```json|```/g, "").trim();
  const m = clean.match(/\{[\s\S]*\}/);
  return JSON.parse(m ? m[0] : clean);
}

/* ---------------- grading prompts ---------------- */

const RUBRIC = `Tu es un examinateur DALF C1 expérimenté ET un formateur du service client Amazon.
Évalue la réponse d'un candidat qui joue le rôle d'un conseiller Amazon (scénarios : client, vendeur tiers, compte, livraison, remboursement…).
Critères C1 : richesse et précision lexicales, correction grammaticale, registre professionnel, cohérence/structure, pertinence métier (empathie, solution concrète, étapes claires).
Sois exigeant mais constructif. Réponds UNIQUEMENT en JSON strict.`;

async function gradeWriting(items) {
  const payload = items.map((it, i) =>
    `### Réponse ${i + 1}\nCourriel du client:\n${it.context}\n\nConsigne: ${it.instruction}\n\nRéponse du candidat (${wordCount(it.answer)} mots):\n${it.answer || "(vide)"}`
  ).join("\n\n");
  const messages = [
    { role: "system", content: RUBRIC },
    { role: "user", content: `${payload}\n\nPour chaque réponse, note sur 10 et donne un retour bref (3-4 phrases, en français) incluant 1-2 corrections précises de langue. Contrainte: max ${WRITE_MAX_WORDS} mots — pénalise le dépassement ou la réponse vide.\nJSON attendu: {"results":[{"score":n,"feedback":"..."}]}` },
  ];
  return (await callGrade("text", messages)).results;
}

async function gradeOralOne(item, rec) {
  const content = [
    { type: "text", text: `${RUBRIC}\n\nContexte (message du client):\n${item.transcript}\n\nConsigne donnée au candidat: ${item.instruction}\nContrainte: ${timers.oral || 60} secondes max.\n\nÉcoute l'audio joint (réponse orale du candidat). Transcris-la fidèlement, puis évalue prononciation/fluidité en plus des critères.\nJSON attendu: {"transcription":"...","score":n,"feedback":"..."} (feedback: 3-4 phrases en français, avec 1-2 corrections précises).` },
    { type: "input_audio", input_audio: { data: rec.base64, format: "wav" } },
  ];
  return await callGrade("audio", [{ role: "user", content }]);
}

async function gradeLevel(summary) {
  const messages = [
    { role: "system", content: "Tu es un examinateur DALF. Réponds uniquement en JSON strict." },
    { role: "user", content: `Bilan d'une session d'entraînement C1 (rôle: conseiller Amazon):\n${summary}\n\nAttribue un niveau CECRL global estimé (parmi B1, B2, C1, C2) et un commentaire de synthèse (4-5 phrases en français): points forts, axes de progrès prioritaires pour atteindre/consolider le C1.\nJSON: {"level":"...","comment":"..."}` },
  ];
  return await callGrade("text", messages);
}

/* ---------------- audio recording → WAV ---------------- */

function encodeWav16kMono(audioBuffer) {
  const targetRate = 16000;
  const srcRate = audioBuffer.sampleRate;
  const len = audioBuffer.length;
  const mono = new Float32Array(len);
  for (let c = 0; c < audioBuffer.numberOfChannels; c++) {
    const d = audioBuffer.getChannelData(c);
    for (let i = 0; i < len; i++) mono[i] += d[i] / audioBuffer.numberOfChannels;
  }
  const outLen = Math.round(len * targetRate / srcRate);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * srcRate / targetRate;
    const i0 = Math.floor(pos), i1 = Math.min(i0 + 1, len - 1);
    out[i] = mono[i0] + (mono[i1] - mono[i0]) * (pos - i0);
  }
  const buf = new ArrayBuffer(44 + outLen * 2);
  const v = new DataView(buf);
  const wStr = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  wStr(0, "RIFF"); v.setUint32(4, 36 + outLen * 2, true); wStr(8, "WAVE");
  wStr(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, targetRate, true); v.setUint32(28, targetRate * 2, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  wStr(36, "data"); v.setUint32(40, outLen * 2, true);
  for (let i = 0; i < outLen; i++) {
    const s = Math.max(-1, Math.min(1, out[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
  }
  return buf;
}

function bufToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  return btoa(bin);
}

async function blobToWavBase64(blob) {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const arr = await blob.arrayBuffer();
  const decoded = await ctx.decodeAudioData(arr);
  ctx.close();
  return bufToBase64(encodeWav16kMono(decoded));
}

/* ---------------- render: intro (with timer settings) ---------------- */

function timerField(id, label, val) {
  return `<label class="field field-inline">
    <span>${label}</span>
    <input type="number" id="${id}" min="0" step="10" value="${val}"> <em>s (0 = sans limite)</em>
  </label>`;
}

function renderIntro() {
  phase = { section: "intro", index: 0 };
  setProgress();
  $app.innerHTML = ticket("Session d'entraînement", "Épreuve C1 — Conseiller Service Client", "≈ 25 min", `
    <p>Vous incarnez un conseiller Amazon face à des clients et vendeurs (compte, commandes, livraisons, remboursements, marketplace). Trois épreuves tirées aléatoirement :</p>
    <div class="intro-grid">
      <div class="intro-item"><span class="roman">I</span><p><strong>Compréhension</strong> — ${COUNTS.comprehension} QCM sur des courriels/messages, chronométrés.</p></div>
      <div class="intro-item"><span class="roman">II</span><p><strong>Expression orale</strong> — ${COUNTS.oral} situations. Réponse enregistrée et évaluée par IA.</p></div>
      <div class="intro-item"><span class="roman">III</span><p><strong>Expression écrite</strong> — ${COUNTS.writing} courriels. <strong>${WRITE_MAX_WORDS} mots max</strong>, temps limité, correction IA.</p></div>
    </div>
  `) + ticket("Réglages", "Chronomètres", "modifiables avant l'épreuve", `
    ${timerField("t-mcq", "Temps par QCM", timers.mcq)}
    ${timerField("t-oral", "Durée max de réponse orale", timers.oral)}
    ${timerField("t-writing", "Temps par courriel écrit", timers.writing)}
    <div class="actions"><button id="btn-start" class="btn-primary">Commencer l'épreuve</button></div>
  `);
  document.getElementById("btn-start").onclick = () => {
    timers.mcq = Math.max(0, Number(document.getElementById("t-mcq").value) || 0);
    timers.oral = Math.max(0, Number(document.getElementById("t-oral").value) || 0) || 60;
    timers.writing = Math.max(0, Number(document.getElementById("t-writing").value) || 0);
    localStorage.setItem("c1_t_mcq", timers.mcq);
    localStorage.setItem("c1_t_oral", timers.oral);
    localStorage.setItem("c1_t_writing", timers.writing);
    startSession();
  };
}

function startSession() {
  session = {
    comprehension: pick(bank.comprehension, COUNTS.comprehension),
    oral: pick(bank.oral, COUNTS.oral),
    writing: pick(bank.writing, COUNTS.writing),
  };
  answers = {
    comprehension: Array(session.comprehension.length).fill(null),
    oral: Array(session.oral.length).fill(null),
    writing: Array(session.writing.length).fill(""),
  };
  phase = { section: "comprehension", index: 0 };
  renderComprehension();
}

/* ---------------- render: comprehension ---------------- */

function renderComprehension() {
  setProgress();
  const i = phase.index;
  const q = session.comprehension[i];
  const audioHTML = q.audio ? audioBlock(q) : "";
  $app.innerHTML = ticket("Épreuve I · Compréhension", `Question ${i + 1} / ${session.comprehension.length}`,
    `⏱ <span id="q-timer"></span>`, `
    ${audioHTML}
    ${q.context && !q.audio ? `<div class="mail">${esc(q.context)}</div>` : ""}
    <p class="q-instruction">${esc(q.question)}</p>
    <div class="options" id="options"></div>
    <div class="actions"><button id="btn-next" class="btn-primary" disabled>Valider et continuer</button></div>
  `);
  const $opts = document.getElementById("options");
  q.options.forEach((opt, oi) => {
    const b = document.createElement("button");
    b.className = "option";
    b.innerHTML = `<span class="opt-letter">${"ABCD"[oi]}</span><span>${esc(opt)}</span>`;
    b.onclick = () => {
      answers.comprehension[i] = oi;
      [...$opts.children].forEach(c => c.classList.remove("selected"));
      b.classList.add("selected");
      document.getElementById("btn-next").disabled = false;
    };
    $opts.appendChild(b);
  });
  const next = () => {
    clearQTimer();
    if (i + 1 < session.comprehension.length) { phase.index++; renderComprehension(); }
    else { phase = { section: "oral", index: 0 }; renderOral(); }
  };
  document.getElementById("btn-next").onclick = next;
  startQTimer(timers.mcq, next); // expiry locks current selection (or none) and advances
}

/* ---------------- audio block helper ---------------- */

function audioBlock(q) {
  return `<div class="audio-block">
    <audio controls preload="none" src="${q.audio}" onerror="this.closest('.audio-block').querySelector('.audio-missing').classList.remove('hidden');this.classList.add('hidden')"></audio>
    <div class="audio-missing hidden">Fichier audio <code>${esc(q.audio)}</code> introuvable — utilisez la transcription ci-dessous.</div>
    <button type="button" class="transcript-toggle" onclick="this.nextElementSibling.classList.toggle('open')">Afficher / masquer la transcription</button>
    <div class="transcript mail">${esc(q.transcript || q.context || "")}</div>
  </div>`;
}

/* ---------------- render: oral ---------------- */

let recState = null;

function renderOral() {
  setProgress();
  const i = phase.index;
  const q = session.oral[i];
  const oralMax = timers.oral || 60;
  $app.innerHTML = ticket("Épreuve II · Expression orale", `Situation ${i + 1} / ${session.oral.length}`, `⏱ ${oralMax} s max`, `
    ${audioBlock(q)}
    <p class="q-instruction">${esc(q.instruction)}</p>
    <div class="recorder">
      <div class="rec-ring" id="rec-ring"><div class="rec-inner" id="rec-timer">${oralMax}</div></div>
      <div class="rec-controls">
        <button id="btn-rec" class="btn-danger">● Enregistrer</button>
        <button id="btn-stop" class="btn-outline" disabled>■ Arrêter</button>
        <button id="btn-redo" class="btn-ghost hidden">↺ Recommencer</button>
      </div>
      <div class="rec-status" id="rec-status">Micro prêt. Répondez comme au téléphone.</div>
      <audio id="playback" class="playback hidden" controls></audio>
    </div>
    <div class="actions"><button id="btn-next" class="btn-primary" disabled>Valider et continuer</button></div>
  `);
  setupRecorder(i, oralMax);
  document.getElementById("btn-next").onclick = () => {
    stopRecorderHard();
    if (i + 1 < session.oral.length) { phase.index++; renderOral(); }
    else { phase = { section: "writing", index: 0 }; renderWriting(); }
  };
}

function setupRecorder(qIndex, maxSec) {
  const $rec = document.getElementById("btn-rec");
  const $stop = document.getElementById("btn-stop");
  const $redo = document.getElementById("btn-redo");
  const $ring = document.getElementById("rec-ring");
  const $timer = document.getElementById("rec-timer");
  const $status = document.getElementById("rec-status");
  const $play = document.getElementById("playback");
  const $next = document.getElementById("btn-next");

  recState = { mr: null, chunks: [], timerId: null, start: 0, stream: null };

  async function begin() {
    try {
      recState.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      $status.textContent = "Accès au micro refusé. Autorisez le micro dans votre navigateur.";
      return;
    }
    recState.chunks = [];
    recState.mr = new MediaRecorder(recState.stream);
    recState.mr.ondataavailable = (e) => e.data.size && recState.chunks.push(e.data);
    recState.mr.onstop = onStopped;
    recState.mr.start();
    recState.start = Date.now();
    $rec.disabled = true; $stop.disabled = false; $redo.classList.add("hidden");
    $play.classList.add("hidden"); $next.disabled = true;
    $ring.classList.add("live");
    $status.textContent = "Enregistrement en cours…";
    recState.timerId = setInterval(() => {
      const elapsed = (Date.now() - recState.start) / 1000;
      const left = Math.max(0, maxSec - elapsed);
      $timer.textContent = Math.ceil(left);
      $ring.style.setProperty("--p", (elapsed / maxSec) * 100);
      if (elapsed >= maxSec) stop();
    }, 200);
  }

  function stop() {
    if (recState.mr && recState.mr.state !== "inactive") recState.mr.stop();
  }

  async function onStopped() {
    clearInterval(recState.timerId);
    recState.stream?.getTracks().forEach(t => t.stop());
    $ring.classList.remove("live");
    $rec.disabled = false; $stop.disabled = true; $redo.classList.remove("hidden");
    const blob = new Blob(recState.chunks, { type: recState.mr.mimeType || "audio/webm" });
    $play.src = URL.createObjectURL(blob);
    $play.classList.remove("hidden");
    $status.textContent = "Conversion de l'audio…";
    try {
      const base64 = await blobToWavBase64(blob);
      answers.oral[qIndex] = { base64 };
      $status.textContent = `Réponse enregistrée (${Math.round((Date.now() - recState.start) / 1000)} s). Vous pouvez la réécouter ou recommencer.`;
      $next.disabled = false;
    } catch (e) {
      $status.textContent = "Erreur de conversion audio : " + e.message;
    }
  }

  $rec.onclick = begin;
  $stop.onclick = stop;
  $redo.onclick = begin;
}

function stopRecorderHard() {
  if (recState) {
    clearInterval(recState.timerId);
    if (recState.mr && recState.mr.state !== "inactive") recState.mr.stop();
    recState.stream?.getTracks().forEach(t => t.stop());
  }
}

/* ---------------- render: writing ---------------- */

function renderWriting() {
  setProgress();
  const i = phase.index;
  const q = session.writing[i];
  $app.innerHTML = ticket("Épreuve III · Expression écrite", `Courriel ${i + 1} / ${session.writing.length}`,
    `✍ ${WRITE_MAX_WORDS} mots · ⏱ <span id="q-timer"></span>`, `
    <div class="mail">${esc(q.context)}</div>
    <p class="q-instruction">${esc(q.instruction)}</p>
    <textarea id="write-area" class="write-area" placeholder="Bonjour Madame / Monsieur, …" spellcheck="false">${esc(answers.writing[i])}</textarea>
    <div id="word-counter" class="word-counter">0 / ${WRITE_MAX_WORDS} mots</div>
    <div class="actions"><button id="btn-next" class="btn-primary" disabled>Valider et continuer</button></div>
  `);
  const $ta = document.getElementById("write-area");
  const $wc = document.getElementById("word-counter");
  const $next = document.getElementById("btn-next");
  const update = () => {
    const n = wordCount($ta.value);
    $wc.textContent = `${n} / ${WRITE_MAX_WORDS} mots`;
    $wc.classList.toggle("over", n > WRITE_MAX_WORDS);
    $next.disabled = n === 0 || n > WRITE_MAX_WORDS;
    answers.writing[i] = $ta.value;
  };
  $ta.addEventListener("input", update);
  update();
  const next = () => {
    clearQTimer();
    if (i + 1 < session.writing.length) { phase.index++; renderWriting(); }
    else { phase = { section: "grading", index: 0 }; runGrading(); }
  };
  $next.onclick = next;
  startQTimer(timers.writing, next); // time's up → submit as-is
}

/* ---------------- grading & results ---------------- */

async function runGrading() {
  clearQTimer();
  setProgress();
  $app.innerHTML = `<div class="grading-wait"><span class="spinner"></span><span id="grading-msg">Correction en cours…</span></div>`;
  const $msg = document.getElementById("grading-msg");
  const results = { comp: [], oral: [], writing: [], level: null };

  results.comp = session.comprehension.map((q, i) => ({
    ok: answers.comprehension[i] === q.correct,
    chosen: answers.comprehension[i],
    q,
  }));

  try {
    for (let i = 0; i < session.oral.length; i++) {
      $msg.textContent = `Correction orale ${i + 1}/${session.oral.length}…`;
      if (!answers.oral[i]) { results.oral.push({ score: 0, feedback: "Aucune réponse enregistrée.", transcription: "" }); continue; }
      results.oral.push(await gradeOralOne(session.oral[i], answers.oral[i]));
    }
    $msg.textContent = "Correction des réponses écrites…";
    const items = session.writing.map((q, i) => ({ context: q.context, instruction: q.instruction, answer: answers.writing[i] }));
    results.writing = await gradeWriting(items);
    $msg.textContent = "Estimation du niveau CECRL…";
    const compScore = results.comp.filter(r => r.ok).length;
    const summary =
      `Compréhension: ${compScore}/${results.comp.length} bonnes réponses.\n` +
      `Oral (sur 10 chacun): ${results.oral.map(r => r.score).join(", ")}.\n` +
      `Écrit (sur 10 chacun): ${results.writing.map(r => r.score).join(", ")}.\n` +
      `Extraits de feedback oral: ${results.oral.map(r => r.feedback).join(" | ")}\n` +
      `Extraits de feedback écrit: ${results.writing.map(r => r.feedback).join(" | ")}`;
    results.level = await gradeLevel(summary);
  } catch (e) {
    $app.innerHTML = ticket("Correction", "Erreur", "", `
      <div class="notice err">${esc(e.message)}</div>
      <div class="actions"><button class="btn-primary" onclick="location.reload()">Recommencer</button></div>`);
    return;
  }
  renderResults(results);
}

function renderResults(r) {
  phase = { section: "results", index: 0 };
  setProgress();
  const compScore = r.comp.filter(x => x.ok).length;
  const avg = (arr) => arr.length ? (arr.reduce((s, x) => s + (Number(x.score) || 0), 0) / arr.length).toFixed(1) : "—";

  const compHTML = r.comp.map((x, i) => `
    <div class="feedback-item">
      <h3>Question ${i + 1} — ${x.ok ? "✔ correcte" : "✘ incorrecte"}</h3>
      <div class="fb-text">${esc(x.q.question)}\nVotre réponse : ${x.chosen != null ? esc(x.q.options[x.chosen]) : "(aucune — temps écoulé)"}${x.ok ? "" : `\nBonne réponse : ${esc(x.q.options[x.q.correct])}`}</div>
    </div>`).join("");

  const oralHTML = r.oral.map((x, i) => `
    <div class="feedback-item">
      <h3>Situation ${i + 1} <span class="fb-score">${x.score}/10</span></h3>
      ${x.transcription ? `<div class="fb-text">Transcription : « ${esc(x.transcription)} »</div>` : ""}
      <div class="fb-text">${esc(x.feedback || "")}</div>
    </div>`).join("");

  const writeHTML = r.writing.map((x, i) => `
    <div class="feedback-item">
      <h3>Courriel ${i + 1} <span class="fb-score">${x.score}/10</span></h3>
      <div class="fb-text">${esc(x.feedback || "")}</div>
    </div>`).join("");

  $app.innerHTML = `
    <div class="level-banner">
      <span class="level">${esc(r.level?.level || "?")}</span>
      <p>${esc(r.level?.comment || "")}</p>
    </div>
    <div class="score-strip">
      <div class="score-cell"><div class="big">${compScore}/${r.comp.length}</div><div class="lbl">Compréhension</div></div>
      <div class="score-cell"><div class="big">${avg(r.oral)}/10</div><div class="lbl">Oral (moyenne)</div></div>
      <div class="score-cell"><div class="big">${avg(r.writing)}/10</div><div class="lbl">Écrit (moyenne)</div></div>
    </div>
    ${ticket("Détail", "Épreuve I — Compréhension", "", compHTML)}
    ${ticket("Détail", "Épreuve II — Expression orale", "", oralHTML)}
    ${ticket("Détail", "Épreuve III — Expression écrite", "", writeHTML)}
    <div class="actions"><button class="btn-primary" onclick="location.reload()">Nouvelle session</button></div>
  `;
}

/* ---------------- boot ---------------- */

(async function boot() {
  try {
    const res = await fetch("data/questions.json");
    bank = await res.json();
  } catch (e) {
    $app.innerHTML = `<div class="notice err">Impossible de charger data/questions.json : ${esc(e.message)}</div>`;
    return;
  }
  const user = await getSessionUser();
  if (user) afterLogin(); else renderAuth();
})();
