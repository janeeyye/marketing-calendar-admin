/* ═══════════════════════════════════════════════════════════════
   Marketing Calendar – Admin  (admin.js)
   ═══════════════════════════════════════════════════════════════ */

// ── Constants ──
const SOLUTIONS = ["AI Business Solutions","Cloud and AI Platforms","Security","All CSAs"];
const SOLUTION_LABEL = {
  "AI Business Solutions":"Copilot","Cloud and AI Platforms":"Cloud & AI",
  "Security":"Security","All CSAs":"Multi-Solution",
};
const SOLUTION_COLOR = {
  "AI Business Solutions":"var(--sol-ai-business)","Cloud and AI Platforms":"var(--sol-cloud-ai)",
  "Security":"var(--sol-security)","All CSAs":"var(--sol-all-csas)",
};
const SOLUTION_HEX = {
  "AI Business Solutions":"#c26a3a","Cloud and AI Platforms":"#3d9e77",
  "Security":"#3563b0","All CSAs":"#8545c4",
};

// ── State ──
let settings = { pat:"", owner:"janeeyye", repo:"marketing-calendar-public", path:"marketing-events.json" };
let fileSha = null;          // GitHub blob SHA (needed for updates)
let allEvents = [];
let highlights = [];
let onDemand = [];
let quickLinks = [];
let currentDate = new Date();
let activeFilters = new Set(SOLUTIONS);
let dirty = false;           // unsaved changes

// ── DOM refs ──
const $ = id => document.getElementById(id);

function loadSettings(){
  try { const s=JSON.parse(localStorage.getItem("mcal_admin_settings")); if(s) settings=s; } catch(e){}
  $("inputPAT").value = settings.pat||"";
  $("inputOwner").value = settings.owner||"";
  $("inputRepo").value = settings.repo||"";
  $("inputPath").value = settings.path||"";
}

function saveSettings(){
  readSettingsFromInputs();
  localStorage.setItem("mcal_admin_settings", JSON.stringify(settings));
  toast("설정이 저장되었습니다","success");
}

// 입력창의 현재 값을 즉시 반영한다 ("설정 저장"을 누르지 않아도 게시가 동작하도록)
function readSettingsFromInputs(){
  settings.pat = $("inputPAT").value.trim();
  settings.owner = $("inputOwner").value.trim() || "janeeyye";
  settings.repo = $("inputRepo").value.trim() || "marketing-calendar-public";
  settings.path = $("inputPath").value.trim() || "marketing-events.json";
  return settings;
}

// ── Toast ──
let toastTimer;
function toast(msg, type="info"){
  const el=$("toast");
  el.textContent=msg;
  el.className="toast "+type;
  clearTimeout(toastTimer);
  toastTimer=setTimeout(()=>el.classList.add("hidden"),3000);
}

// ── GitHub API ──
class GHError extends Error {
  constructor(status, body){
    super(`GitHub API ${status}: ${body}`);
    this.status = status;
    this.body = body;
  }
}

// 상태 코드를 사용자가 조치 가능한 한글 메시지로 변환한다
function ghMessage(err){
  if(!(err instanceof GHError)) return err.message || "알 수 없는 오류";
  switch(err.status){
    case 401: return "PAT가 올바르지 않거나 만료되었습니다. 새 토큰을 발급해 다시 입력해주세요.";
    case 403: return "권한이 없습니다. PAT에 Contents(쓰기) 권한이 있는지 확인해주세요. (fine-grained PAT는 해당 레포를 Repository access에 포함해야 합니다)";
    case 404: return `레포지토리 또는 파일을 찾을 수 없습니다 (${settings.owner}/${settings.repo}/${settings.path}). 경로와 PAT 권한을 확인해주세요.`;
    case 409: return "파일이 다른 곳에서 먼저 변경되었습니다. 다시 불러온 뒤 게시해주세요.";
    case 422: return "요청 형식이 올바르지 않습니다 (SHA 불일치 또는 브랜치 오류).";
    default: return err.message;
  }
}

async function ghFetch(endpoint, opts={}){
  const base = "https://api.github.com";
  const headers = { Accept:"application/vnd.github+json", ...opts.headers };
  if(settings.pat) headers.Authorization = "Bearer "+settings.pat;
  const res = await fetch(base+endpoint, { ...opts, headers });
  if(!res.ok){
    const body = await res.text();
    throw new GHError(res.status, body);
  }
  return res.json();
}

// 큰 JSON(수만 바이트)에서 String.fromCharCode(...bytes)가 스택 오버플로를 일으키므로 청크 단위로 인코딩한다
function toBase64Utf8(str){
  const bytes = new TextEncoder().encode(str);
  const CHUNK = 0x8000;
  let binary = "";
  for(let i=0;i<bytes.length;i+=CHUNK){
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i+CHUNK));
  }
  return btoa(binary);
}

// ── Local draft (편집 내용 유실 방지) ──
const DRAFT_KEY = "mcal_admin_draft";

function saveDraft(){
  try{
    localStorage.setItem(DRAFT_KEY, JSON.stringify({
      events: allEvents, highlights, onDemand, quickLinks, savedAt: new Date().toISOString(),
    }));
  } catch(e){ console.warn("draft 저장 실패", e); }
}

function loadDraft(){
  try{ return JSON.parse(localStorage.getItem(DRAFT_KEY)); } catch(e){ return null; }
}

function clearDraft(){ localStorage.removeItem(DRAFT_KEY); }

function applyDraft(draft){
  allEvents = (draft.events||[]).map(e=>({id:e.id||uid(),...e}));
  highlights = draft.highlights||[];
  onDemand   = draft.onDemand||[];
  quickLinks = draft.quickLinks||[];
}

async function testConnection(){
  readSettingsFromInputs();
  const status = $("settingsStatus");
  if(!settings.pat){ status.textContent = "❌ PAT를 먼저 입력해주세요"; return; }
  status.textContent = "연결 확인 중…";
  try{
    const repoData = await ghFetch(`/repos/${settings.owner}/${settings.repo}`);
    const perms = repoData.permissions||{};
    if(!(perms.push||perms.admin)){
      status.textContent = "⚠️ 읽기만 가능합니다 — PAT에 Contents 쓰기 권한이 필요합니다";
      toast("쓰기 권한이 없어 게시할 수 없습니다","error");
      return;
    }
    try{
      const file = await ghFetch(`/repos/${settings.owner}/${settings.repo}/contents/${encodeURIComponent(settings.path)}?ref=${repoData.default_branch}`);
      fileSha = file.sha;
      status.textContent = `✅ 연결 정상 — 쓰기 가능 (${settings.path})`;
    } catch(e){
      if(e.status===404) status.textContent = `✅ 연결 정상 — ${settings.path}는 게시 시 새로 생성됩니다`;
      else throw e;
    }
    toast("GitHub 연결 정상","success");
  } catch(err){
    status.textContent = "❌ 연결 실패";
    toast("연결 실패: "+ghMessage(err),"error");
    console.error(err);
  }
}

async function autoLoadPublic(){
  const owner = settings.owner || "janeeyye";
  const repo = settings.repo || "marketing-calendar-public";
  const path = settings.path || "marketing-events.json";
  $("settingsStatus").textContent = "불러오는 중…";
  try{
    const url = `https://raw.githubusercontent.com/${owner}/${repo}/main/${path}`;
    const res = await fetch(url, { cache:"no-store" });
    if(!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    applyLoadedJson(json);
    // fileSha is needed for publishing; fetch it via API if PAT exists
    if(settings.pat){
      try{
        const data = await ghFetch(`/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`);
        fileSha = data.sha;
      } catch(e){ console.warn("SHA fetch failed, will retry on publish", e); }
    }
    markClean();
    $("settingsStatus").textContent = `✅ ${allEvents.length}개 이벤트 로드됨`;
    toast(`${allEvents.length}개 이벤트를 불러왔습니다`,"success");
    offerDraftRestore();
    renderAll();
  } catch(err){
    $("settingsStatus").textContent = "❌ 로드 실패";
    toast("이벤트 불러오기 실패: "+err.message,"error");
    console.error(err);
    offerDraftRestore();
    renderAll();
  }
}

function applyLoadedJson(json){
  allEvents = (Array.isArray(json) ? json : (json.events||[])).map(e=>({id:e.id||uid(),...e}));
  highlights = Array.isArray(json) ? [] : (json.highlights||[]);
  onDemand   = Array.isArray(json) ? [] : (json.onDemand||[]);
  quickLinks = Array.isArray(json) ? [] : (json.quickLinks||[]);
}

// 게시되지 않은 로컬 편집이 있으면 공개본으로 덮어쓰지 않고 복구 여부를 묻는다
function offerDraftRestore(){
  const draft = loadDraft();
  if(!draft || !draft.savedAt) return;

  // 공개본과 내용이 같으면 물어볼 필요가 없다
  const current = JSON.stringify({ events:allEvents, highlights, onDemand, quickLinks });
  const saved = JSON.stringify({
    events: draft.events||[], highlights: draft.highlights||[],
    onDemand: draft.onDemand||[], quickLinks: draft.quickLinks||[],
  });
  if(current === saved){ clearDraft(); return; }

  const when = new Date(draft.savedAt).toLocaleString("ko-KR");
  if(confirm(`아직 게시하지 않은 편집 내용이 있습니다 (${when}).\n복구하시겠습니까?\n\n[취소]를 누르면 공개 캘린더 내용으로 시작합니다.`)){
    applyDraft(draft);
    markDirty();
    $("settingsStatus").textContent = `✏️ 미게시 편집본 복구됨 (이벤트 ${allEvents.length}개)`;
    toast("미게시 편집 내용을 복구했습니다","info");
  } else {
    // 실수로 거절하거나 브라우저가 dialog를 차단한 경우를 대비해 바로 지우지 않고 백업해 둔다
    try{ localStorage.setItem(DRAFT_KEY+"_discarded", JSON.stringify(draft)); } catch(e){}
    clearDraft();
  }
}

async function loadFromGitHub(){
  readSettingsFromInputs();
  if(!settings.owner||!settings.repo||!settings.path){
    toast("먼저 GitHub 설정을 입력해주세요","error"); return;
  }
  if(dirty && !confirm("게시하지 않은 변경사항이 있습니다. GitHub 내용으로 덮어쓸까요?")) return;
  $("settingsStatus").textContent = "불러오는 중…";
  try{
    const data = await ghFetch(`/repos/${settings.owner}/${settings.repo}/contents/${encodeURIComponent(settings.path)}`);
    fileSha = data.sha;
    const binary = atob(data.content.replace(/\n/g,""));
    const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
    applyLoadedJson(JSON.parse(new TextDecoder("utf-8").decode(bytes)));
    clearDraft();
    markClean();
    $("settingsStatus").textContent = `✅ ${allEvents.length}개 이벤트 로드됨`;
    toast(`${allEvents.length}개 이벤트를 불러왔습니다`,"success");
    renderAll();
  } catch(err){
    $("settingsStatus").textContent = "❌ 로드 실패";
    toast("GitHub에서 불러오기 실패: "+ghMessage(err),"error");
    console.error(err);
  }
}

// 게시 직전에 항상 최신 SHA를 다시 읽는다 (오래된 SHA로 인한 409 방지)
async function fetchLatestSha(branch){
  try{
    const ref = branch ? `?ref=${encodeURIComponent(branch)}` : "";
    const data = await ghFetch(`/repos/${settings.owner}/${settings.repo}/contents/${encodeURIComponent(settings.path)}${ref}`);
    return data.sha;
  } catch(e){
    if(e instanceof GHError && e.status===404) return null; // 새 파일
    throw e;
  }
}

async function putContent(content, msg, sha, branch){
  const body = { message: msg, content, branch };
  if(sha) body.sha = sha;
  return ghFetch(`/repos/${settings.owner}/${settings.repo}/contents/${encodeURIComponent(settings.path)}`,{
    method:"PUT",
    headers:{"Content-Type":"application/json"},
    body: JSON.stringify(body),
  });
}

async function publishToGitHub(){
  readSettingsFromInputs();
  if(!settings.pat){ toast("GitHub PAT를 입력해주세요","error"); return; }
  if(!settings.owner||!settings.repo||!settings.path){ toast("Owner/Repo/Path를 입력해주세요","error"); return; }

  const btn = $("publishConfirm");
  const btnLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = "게시 중…";

  const msg = $("commitMessage").value.trim() || "캘린더 업데이트";
  const jsonObj = { events:allEvents, highlights, onDemand, quickLinks };

  try{
    const content = toBase64Utf8(JSON.stringify(jsonObj, null, 2));

    const repoData = await ghFetch(`/repos/${settings.owner}/${settings.repo}`);
    const branch = repoData.default_branch || "main";
    const perms = repoData.permissions||{};
    if(!(perms.push||perms.admin)){
      throw new GHError(403, "no write permission");
    }

    let sha = await fetchLatestSha(branch);
    let res;
    try{
      res = await putContent(content, msg, sha, branch);
    } catch(e){
      // 다른 곳에서 먼저 변경된 경우 최신 SHA로 1회 자동 재시도
      if(e instanceof GHError && (e.status===409 || e.status===422)){
        sha = await fetchLatestSha(branch);
        res = await putContent(content, msg, sha, branch);
      } else throw e;
    }

    fileSha = res.content.sha;
    clearDraft();
    markClean();
    closeModal("publishModal");
    toast("✅ 게시 완료! 공개 사이트 반영까지 1~2분 걸릴 수 있습니다","success");
    verifyPublished(branch, allEvents.length);
  } catch(err){
    toast("게시 실패: "+ghMessage(err),"error");
    $("settingsStatus").textContent = "❌ 게시 실패 — "+ghMessage(err);
    $("settingsPanel").classList.remove("hidden");
    console.error(err);
  } finally {
    btn.disabled = false;
    btn.textContent = btnLabel;
  }
}

// 게시 후 실제 공개 파일이 갱신됐는지 확인 (CDN 캐시로 지연될 수 있으므로 실패해도 오류로 취급하지 않는다)
async function verifyPublished(branch, expectedCount){
  try{
    const url = `https://raw.githubusercontent.com/${settings.owner}/${settings.repo}/${branch}/${settings.path}?t=${Date.now()}`;
    const res = await fetch(url, { cache:"no-store" });
    if(!res.ok) throw new Error("HTTP "+res.status);
    const json = await res.json();
    const count = (Array.isArray(json)?json:(json.events||[])).length;
    $("settingsStatus").textContent = count===expectedCount
      ? `✅ 게시 확인됨 (이벤트 ${count}개)`
      : `⏳ 게시됨 — 공개본 반영 대기 중 (현재 ${count}개)`;
  } catch(e){
    $("settingsStatus").textContent = "⏳ 게시됨 — 공개본 반영 대기 중";
  }
}

// ── Helpers ──
function uid(){ return "event-"+Date.now()+"-"+Math.random().toString(36).slice(2,11); }
function pad2(n){ return String(n).padStart(2,"0"); }
function fmtISO(d){ return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`; }
function parseISO(iso){ const[y,m,d]=iso.split("-").map(Number); return new Date(y,m-1,d); }
function clampEnd(s,e){ return e&&e.trim()?e:s; }
function isInRange(day,s,e){
  const t=parseISO(day).getTime(), ts=parseISO(s).getTime(), te=parseISO(clampEnd(s,e)).getTime();
  return t>=ts&&t<=te;
}
function getPos(day,s,e){
  const end=clampEnd(s,e);
  if(s===end) return "single"; if(day===s) return "start"; if(day===end) return "end"; return "middle";
}
function calGrid(y,mi){
  const first=new Date(y,mi,1), last=new Date(y,mi+1,0);
  const start=new Date(first); start.setDate(first.getDate()-first.getDay());
  const end=new Date(last); end.setDate(last.getDate()+(6-last.getDay()));
  const days=[];
  for(let d=new Date(start);d<=end;d.setDate(d.getDate()+1))
    days.push({date:new Date(d), iso:fmtISO(d), isCurrentMonth:d.getMonth()===mi});
  return days;
}

// ── Modal helpers ──
function openModal(id){ $(id).classList.remove("hidden"); }
function closeModal(id){ $(id).classList.add("hidden"); }

// ── Render Calendar ──
function renderCalendar(){
  $("monthTitle").textContent = `${currentDate.getFullYear()}년 ${currentDate.getMonth()+1}월`;
  const days = calGrid(currentDate.getFullYear(), currentDate.getMonth());
  const grid = $("calendarGrid");
  grid.innerHTML = "";

  const filtered = allEvents.filter(ev=>{
    if(ev.solution==="All CSAs") return SOLUTIONS.some(s=>s!=="All CSAs"&&activeFilters.has(s))||activeFilters.has("All CSAs");
    return activeFilters.has(ev.solution);
  });

  days.forEach(day=>{
    const cell = document.createElement("div");
    cell.className = "day"+(day.isCurrentMonth?"":" other-month");
    cell.addEventListener("dblclick", ()=>openAddEvent(day.iso));

    const num = document.createElement("div");
    num.className = "day-number";
    num.textContent = day.date.getDate();
    cell.appendChild(num);

    const stack = document.createElement("div");
    stack.className = "events";

    filtered.filter(ev=>isInRange(day.iso, ev.startDate, ev.endDate))
      .sort((a,b)=>{
        const sa=(getPos(day.iso,a.startDate,a.endDate)==="single"||getPos(day.iso,a.startDate,a.endDate)==="start")?0:1;
        const sb=(getPos(day.iso,b.startDate,b.endDate)==="single"||getPos(day.iso,b.startDate,b.endDate)==="start")?0:1;
        return sa-sb||(a.title||"").localeCompare(b.title||"");
      })
      .forEach(ev=>{
        const pos = getPos(day.iso, ev.startDate, ev.endDate);
        const color = SOLUTION_COLOR[ev.solution]||"var(--muted)";
        if(pos==="single"||pos==="start"){
          const card = document.createElement("div");
          card.className = "event-card";
          card.style.borderLeftColor = color;
          card.addEventListener("click", e=>{ e.stopPropagation(); openEditEvent(ev); });

          const t = document.createElement("div");
          t.className = "event-title"; t.textContent = ev.title||"(Untitled)";
          card.appendChild(t);

          if(ev.location){
            const loc = document.createElement("div");
            loc.className = "event-location";
            const pin = document.createElement("span");
            pin.className = "pin"; pin.textContent = "📍";
            const locText = document.createElement("span");
            locText.textContent = ev.location;
            loc.append(pin, locText);
            card.appendChild(loc);
          }

          if(ev.registrationUrl && ev.registrationUrl.trim()){
            const links = document.createElement("div");
            links.className = "event-links";
            const a = document.createElement("a");
            a.href = ev.registrationUrl;
            a.target = "_blank";
            a.rel = "noreferrer";
            a.textContent = "등록하러 가기❯";
            a.addEventListener("click", e => e.stopPropagation());
            links.appendChild(a);
            card.appendChild(links);
          }

          stack.appendChild(card);
        } else {
          const cont = document.createElement("div");
          cont.className = "cont-card";
          cont.style.borderLeftColor = color;
          cont.addEventListener("click", e=>{ e.stopPropagation(); openEditEvent(ev); });
          const arrow = document.createElement("span");
          arrow.style.color = color; arrow.textContent = "→";
          const t = document.createElement("span");
          t.className = "cont-title"; t.style.color = color; t.textContent = ev.title;
          cont.append(arrow, t);
          stack.appendChild(cont);
        }
      });

    cell.appendChild(stack);
    grid.appendChild(cell);
  });
}

// ── Render Filters ──
function renderFilters(){
  const bar = $("filterBar");
  bar.innerHTML = "";
  SOLUTIONS.forEach(sol=>{
    const pill = document.createElement("button");
    pill.type = "button";
    pill.className = "filter-pill";
    pill.textContent = SOLUTION_LABEL[sol]||sol;
    const isActive = sol==="All CSAs"
      ? SOLUTIONS.some(s=>s!=="All CSAs"&&activeFilters.has(s))||activeFilters.has("All CSAs")
      : activeFilters.has(sol);
    if(isActive){
      pill.classList.add("active");
      pill.style.background = SOLUTION_COLOR[sol];
      pill.style.color = "#fff";
    }
    pill.addEventListener("click",()=>{
      if(activeFilters.has(sol)) activeFilters.delete(sol); else activeFilters.add(sol);
      if(activeFilters.size===0) SOLUTIONS.forEach(s=>activeFilters.add(s));
      renderFilters(); renderCalendar();
    });
    bar.appendChild(pill);
  });
}

// ── Render Event List ──
function renderEventList(){
  const tbody = $("eventTableBody");
  tbody.innerHTML = "";
  const q = ($("listSearch").value||"").trim().toLowerCase();
  const solFilter = $("listSolutionFilter").value;

  let list = [...allEvents];
  if(q) list = list.filter(ev=>(ev.title||"").toLowerCase().includes(q)||(ev.location||"").toLowerCase().includes(q));
  if(solFilter) list = list.filter(ev=>ev.solution===solFilter);
  list.sort((a,b)=>(a.startDate||"").localeCompare(b.startDate||""));

  list.forEach(ev=>{
    const tr = document.createElement("tr");
    const hex = SOLUTION_HEX[ev.solution]||"#8b949e";
    tr.innerHTML = `
      <td>${esc(ev.title||"")}</td>
      <td><span class="sol-pill" style="background:${hex}">${esc(SOLUTION_LABEL[ev.solution]||ev.solution||"")}</span></td>
      <td>${esc(ev.startDate||"")}</td>
      <td>${esc(ev.endDate||"")}</td>
      <td>${esc(ev.location||"")}</td>
      <td class="actions"></td>
    `;
    const actions = tr.querySelector(".actions");

    const editBtn = document.createElement("button");
    editBtn.className = "btn btn-ghost btn-sm"; editBtn.textContent = "편집";
    editBtn.addEventListener("click", ()=>openEditEvent(ev));

    const delBtn = document.createElement("button");
    delBtn.className = "btn btn-danger btn-sm"; delBtn.textContent = "삭제";
    delBtn.addEventListener("click", ()=>{ if(confirm(`"${ev.title}" 삭제?`)) deleteEvent(ev.id); });

    actions.append(editBtn, delBtn);
    tbody.appendChild(tr);
  });
}

function esc(s){ const d=document.createElement("div"); d.textContent=s; return d.innerHTML; }

// ── Render Sidebar Panels (public-page style with edit controls) ──
function renderSidebarPanel(section, items, containerId){
  const container = $(containerId);
  container.innerHTML = "";

  if(section==="highlights"){
    items.forEach((item, idx)=>{
      const hex = SOLUTION_HEX[item.solution]||"#6b7280";
      const card = document.createElement("div");
      card.className = "highlight-card";
      card.style.borderLeftColor = hex;
      card.addEventListener("click", ()=>openEditSidebarItem(section, idx));

      let html = `<div class="highlight-title">${esc(item.title||"(Untitled)")}</div>`;
      if(item.metaText||item.meta) html += `<div class="highlight-meta">${esc(item.metaText||item.meta)}</div>`;
      if(item.description) html += `<div class="highlight-description">${esc(item.description)}</div>`;
      if(item.url) html += `<a class="sidebar-link" href="${esc(item.url)}" target="_blank" rel="noreferrer" onclick="event.stopPropagation()">자세히 보기 ❯</a>`;
      html += `<div class="highlight-actions">
        <button class="btn btn-danger btn-sm" data-del="${idx}">삭제</button>
      </div>`;
      card.innerHTML = html;

      const delBtn = card.querySelector(`[data-del="${idx}"]`);
      if(delBtn) delBtn.addEventListener("click", e=>{
        e.stopPropagation();
        if(confirm(`"${item.title}" 삭제?`)){ getSidebarArray(section).splice(idx,1); markDirty(); renderSidebarSection(section); }
      });

      container.appendChild(card);
    });
  } else if(section==="onDemand"){
    items.forEach((item, idx)=>{
      const row = document.createElement("div");
      row.className = "ondemand-item";
      row.addEventListener("click", ()=>openEditSidebarItem(section, idx));
      row.innerHTML = `
        <span class="ondemand-icon">▶</span>
        <div class="ondemand-copy">
          <div class="ondemand-title">${esc(item.title||"(Untitled)")}</div>
          ${item.metaText||item.meta ? `<div class="ondemand-date">${esc(item.metaText||item.meta)}</div>` : ""}
        </div>
        <div class="ondemand-actions">
          <button class="btn btn-danger btn-sm" data-del="${idx}">삭제</button>
        </div>
        <span class="ondemand-arrow">❯</span>
      `;
      const delBtn = row.querySelector(`[data-del="${idx}"]`);
      if(delBtn) delBtn.addEventListener("click", e=>{
        e.stopPropagation();
        if(confirm(`"${item.title}" 삭제?`)){ getSidebarArray(section).splice(idx,1); markDirty(); renderSidebarSection(section); }
      });
      container.appendChild(row);
    });
  } else {
    items.forEach((item, idx)=>{
      const row = document.createElement("div");
      row.className = "quicklink-item";
      row.addEventListener("click", ()=>openEditSidebarItem(section, idx));
      row.innerHTML = `
        <span class="quicklink-icon">↗</span>
        <span class="quicklink-title">${esc(item.title||"(Untitled)")}</span>
        <div class="quicklink-actions">
          <button class="btn btn-danger btn-sm" data-del="${idx}">삭제</button>
        </div>
        <span class="quicklink-arrow">❯</span>
      `;
      const delBtn = row.querySelector(`[data-del="${idx}"]`);
      if(delBtn) delBtn.addEventListener("click", e=>{
        e.stopPropagation();
        if(confirm(`"${item.title}" 삭제?`)){ getSidebarArray(section).splice(idx,1); markDirty(); renderSidebarSection(section); }
      });
      container.appendChild(row);
    });
  }
}

function getSidebarArray(section){
  if(section==="highlights") return highlights;
  if(section==="onDemand") return onDemand;
  return quickLinks;
}

function renderSidebarSection(section){
  if(section==="highlights") renderSidebarPanel("highlights", highlights, "sidebarHighlights");
  else if(section==="onDemand") renderSidebarPanel("onDemand", onDemand, "sidebarOnDemand");
  else renderSidebarPanel("quickLinks", quickLinks, "sidebarQuickLinks");
}

// ── Event CRUD ──
function openAddEvent(defaultDate){
  $("eventModalTitle").textContent = "이벤트 추가";
  $("formEventId").value = "";
  $("formTitle").value = "";
  $("formSolution").value = "AI Business Solutions";
  $("formStartDate").value = defaultDate||fmtISO(new Date());
  $("formEndDate").value = "";
  $("formLocation").value = "";
  $("formTime").value = "";
  $("formRegUrl").value = "";
  $("eventFormDelete").classList.add("hidden");
  openModal("eventModal");
}

function openEditEvent(ev){
  $("eventModalTitle").textContent = "이벤트 편집";
  $("formEventId").value = ev.id;
  $("formTitle").value = ev.title||"";
  $("formSolution").value = ev.solution||"AI Business Solutions";
  $("formStartDate").value = ev.startDate||"";
  $("formEndDate").value = ev.endDate||"";
  $("formLocation").value = ev.location||"";
  $("formTime").value = ev.time||"";
  $("formRegUrl").value = ev.registrationUrl||"";
  $("eventFormDelete").classList.remove("hidden");
  openModal("eventModal");
}

function saveEvent(){
  const id = $("formEventId").value || uid();
  const ev = {
    id,
    title: $("formTitle").value.trim(),
    solution: $("formSolution").value,
    startDate: $("formStartDate").value,
    endDate: $("formEndDate").value||"",
    location: $("formLocation").value.trim(),
    time: $("formTime").value.trim(),
    registrationUrl: $("formRegUrl").value.trim(),
  };
  const idx = allEvents.findIndex(e=>e.id===id);
  if(idx>=0) allEvents[idx]=ev; else allEvents.push(ev);
  markDirty();
  closeModal("eventModal");
  renderAll();
  toast(idx>=0?"이벤트가 수정되었습니다":"이벤트가 추가되었습니다","success");
}

function deleteEvent(id){
  allEvents = allEvents.filter(e=>e.id!==id);
  markDirty(); renderAll();
  toast("이벤트가 삭제되었습니다","info");
}

// ── Sidebar CRUD ──
function openAddSidebarItem(section){
  $("sidebarModalTitle").textContent = "항목 추가";
  $("sFormId").value = "";
  $("sFormSection").value = section;
  $("sFormTitle").value = "";
  $("sFormSolution").value = "";
  $("sFormMeta").value = "";
  $("sFormDesc").value = "";
  $("sFormUrl").value = "";
  $("sFormOrder").value = "0";
  openModal("sidebarModal");
}

function openEditSidebarItem(section, idx){
  const item = getSidebarArray(section)[idx];
  $("sidebarModalTitle").textContent = "항목 편집";
  $("sFormId").value = String(idx);
  $("sFormSection").value = section;
  $("sFormTitle").value = item.title||"";
  $("sFormSolution").value = item.solution||"";
  $("sFormMeta").value = item.metaText||item.meta||"";
  $("sFormDesc").value = item.description||"";
  $("sFormUrl").value = item.url||"";
  $("sFormOrder").value = item.displayOrder!=null?item.displayOrder:0;
  openModal("sidebarModal");
}

function saveSidebarItem(){
  const section = $("sFormSection").value;
  const arr = getSidebarArray(section);
  const idxStr = $("sFormId").value;
  const item = {
    title: $("sFormTitle").value.trim(),
    solution: $("sFormSolution").value||undefined,
    metaText: $("sFormMeta").value.trim()||undefined,
    description: $("sFormDesc").value.trim()||undefined,
    url: $("sFormUrl").value.trim()||undefined,
    displayOrder: parseInt($("sFormOrder").value)||0,
  };
  // Clean undefined keys
  Object.keys(item).forEach(k=>{ if(item[k]===undefined) delete item[k]; });

  if(idxStr!=="") arr[parseInt(idxStr)]=item; else arr.push(item);
  markDirty();
  closeModal("sidebarModal");
  renderSidebarSection(section);
  toast("항목이 저장되었습니다","success");
}

// ── Dirty tracking ──
function markDirty(){
  dirty = true;
  $("btnPublish").textContent = "🚀 게시 (변경사항 있음)";
  $("btnPublish").style.animation = "none";
  void $("btnPublish").offsetWidth; // reflow
  saveDraft();
}

function markClean(){
  dirty = false;
  $("btnPublish").textContent = "🚀 게시";
}

// ── Publish flow ──
function openPublishDialog(){
  const note = dirty ? "" : `<br><span class="publish-note">변경사항이 없지만 현재 내용을 그대로 다시 게시할 수 있습니다.</span>`;
  $("publishStats").innerHTML = `
    📅 이벤트: <strong>${allEvents.length}</strong>개<br>
    🔥 하이라이트: <strong>${highlights.length}</strong>개<br>
    ▶ 다시보기: <strong>${onDemand.length}</strong>개<br>
    ↗ 바로가기: <strong>${quickLinks.length}</strong>개${note}
  `;
  $("commitMessage").value = "캘린더 업데이트 " + fmtISO(new Date());
  openModal("publishModal");
}

// ── Render all views ──
function renderAll(){
  renderFilters();
  renderCalendar();
  renderEventList();
  renderSidebarPanel("highlights", highlights, "sidebarHighlights");
  renderSidebarPanel("onDemand", onDemand, "sidebarOnDemand");
  renderSidebarPanel("quickLinks", quickLinks, "sidebarQuickLinks");
}

// ── View switching ──
function switchView(view){
  ["viewCalendar","viewList","viewSidebar"].forEach(id=>$(id).classList.add("hidden"));
  if(view==="calendar") $("viewCalendar").classList.remove("hidden");
  else if(view==="list"){ $("viewList").classList.remove("hidden"); renderEventList(); }
  else if(view==="sidebar") $("viewSidebar").classList.remove("hidden");

  document.querySelectorAll(".view-tabs .tab").forEach(t=>{
    t.classList.toggle("active", t.dataset.view===view);
  });
}

function switchSidebarTab(section){
  ["sidebarHighlights","sidebarOnDemand","sidebarQuickLinks"].forEach(id=>$(id).classList.add("hidden"));
  if(section==="highlights") $("sidebarHighlights").classList.remove("hidden");
  else if(section==="onDemand") $("sidebarOnDemand").classList.remove("hidden");
  else $("sidebarQuickLinks").classList.remove("hidden");

  document.querySelectorAll(".sidebar-tabs .stab").forEach(t=>{
    t.classList.toggle("active", t.dataset.section===section);
  });
}

// ── File import (drag & drop / file picker for JSON) ──
function handleFileImport(file){
  const reader = new FileReader();
  reader.onload = function(e){
    try{
      const json = JSON.parse(e.target.result);
      allEvents = (Array.isArray(json) ? json : (json.events||[])).map((ev,i)=>({id:ev.id||uid(),...ev}));
      highlights = Array.isArray(json)?[]:(json.highlights||[]);
      onDemand = Array.isArray(json)?[]:(json.onDemand||[]);
      quickLinks = Array.isArray(json)?[]:(json.quickLinks||[]);
      markDirty(); renderAll();
      toast(`JSON 파일에서 ${allEvents.length}개 이벤트를 불러왔습니다`,"success");
    } catch(err){
      toast("JSON 파싱 실패: "+err.message,"error");
    }
  };
  reader.readAsText(file);
}

// ── Init ──
document.addEventListener("DOMContentLoaded", ()=>{
  loadSettings();

  // Settings
  $("settingsToggle").addEventListener("click", ()=>$("settingsPanel").classList.toggle("hidden"));
  $("btnSaveSettings").addEventListener("click", saveSettings);
  $("btnTestConnection").addEventListener("click", testConnection);
  $("btnLoadFromGH").addEventListener("click", loadFromGitHub);

  // Month nav
  $("prevMonthBtn").addEventListener("click", ()=>{ currentDate=new Date(currentDate.getFullYear(),currentDate.getMonth()-1,1); renderCalendar(); });
  $("nextMonthBtn").addEventListener("click", ()=>{ currentDate=new Date(currentDate.getFullYear(),currentDate.getMonth()+1,1); renderCalendar(); });
  $("todayBtn").addEventListener("click", ()=>{ currentDate=new Date(); renderCalendar(); });

  // Sidebar add buttons
  $("btnAddHighlight").addEventListener("click", ()=>openAddSidebarItem("highlights"));
  $("btnAddOnDemand").addEventListener("click", ()=>openAddSidebarItem("onDemand"));
  $("btnAddQuickLink").addEventListener("click", ()=>openAddSidebarItem("quickLinks"));

  // Add event button
  $("btnAddEvent").addEventListener("click", ()=>openAddEvent());

  // Event form
  $("eventForm").addEventListener("submit", e=>{ e.preventDefault(); saveEvent(); });
  $("eventModalClose").addEventListener("click", ()=>closeModal("eventModal"));
  $("eventFormCancel").addEventListener("click", ()=>closeModal("eventModal"));
  $("eventFormDelete").addEventListener("click", ()=>{
    const id = $("formEventId").value;
    if(id && confirm("이 이벤트를 삭제하시겠습니까?")){
      deleteEvent(id);
      closeModal("eventModal");
    }
  });

  // Sidebar form
  $("sidebarForm").addEventListener("submit", e=>{ e.preventDefault(); saveSidebarItem(); });
  $("sidebarModalClose").addEventListener("click", ()=>closeModal("sidebarModal"));
  $("sidebarFormCancel").addEventListener("click", ()=>closeModal("sidebarModal"));

  // Publish
  $("btnPublish").addEventListener("click", openPublishDialog);
  $("publishConfirm").addEventListener("click", publishToGitHub);
  $("publishCancel").addEventListener("click", ()=>closeModal("publishModal"));
  $("publishModalClose").addEventListener("click", ()=>closeModal("publishModal"));

  // List search/filter
  $("listSearch").addEventListener("input", renderEventList);
  $("listSolutionFilter").addEventListener("change", renderEventList);

  // Close modals on backdrop click
  ["eventModal","sidebarModal","publishModal"].forEach(id=>{
    $(id).addEventListener("click", e=>{ if(e.target===$(id)) closeModal(id); });
  });

  // Keyboard
  document.addEventListener("keydown", e=>{
    if(e.key==="Escape"){
      ["eventModal","sidebarModal","publishModal"].forEach(id=>{
        if(!$(id).classList.contains("hidden")) closeModal(id);
      });
    }
  });

  // Drag & drop JSON import
  document.body.addEventListener("dragover", e=>{ e.preventDefault(); e.dataTransfer.dropEffect="copy"; });
  document.body.addEventListener("drop", e=>{
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if(file && file.name.endsWith(".json")) handleFileImport(file);
  });

  // Warn on unsaved changes
  window.addEventListener("beforeunload", e=>{
    if(dirty){ e.preventDefault(); e.returnValue=""; }
  });

  // Auto-load from public repo (no PAT needed for reading)
  autoLoadPublic();
});
