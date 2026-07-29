/* ============================================================
   컴활 1급 학습 센터 - 메인 애플리케이션 로직
   기능: 라우팅, 요약노트, 퀴즈, SRS 간격반복복습, 알람, 통계
   ============================================================ */

const App = (() => {
  "use strict";

  // ---------- 상태 ----------
  const STORAGE_KEY = "comhwal_study_v1";
  let state = loadState();
  let currentQuiz = null; // 현재 진행 중인 퀴즈 세션
  let currentPage = "home";
  let reviewSession = null; // 복습 세션
  let currentUser = null; // 로그인된 사용자 (Supabase)

  // SRS 간격 (시간 단위) - 틀린 횟수에 따라 복습 간격이 늘어남
  // 맞추면 다음 단계로, 틀리면 1단계로 리셋
  const SRS_INTERVALS_HOURS = [0, 4, 12, 24, 72, 168, 336]; // 즉시, 4h, 12h, 1일, 3일, 7일, 14일
  const MASTERY_THRESHOLD = 5; // 이 단계 도달 시 '완전 숙지'로 분류
  const EXAM_DATE = new Date("2026-08-01"); // 컴활 1급 시험일

  // D-day 계산 (오늘 기준 남은 일수)
  function getDDay() {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const diff = Math.ceil((EXAM_DATE - today) / (1000 * 60 * 60 * 24));
    if (diff > 0) return "D-" + diff;
    if (diff === 0) return "D-day";
    return "D+" + Math.abs(diff);
  }

  // ---------- 저장소 ----------
  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) { console.warn("저장소 로드 실패", e); }
    return {
      theme: "dark",
      srs: {},          // { [questionId]: { level, dueDate, history:[] } }
      stats: {          // 누적 통계
        totalAnswered: 0,
        totalCorrect: 0,
        bySubject: { excel: { answered:0, correct:0 }, access: { answered:0, correct:0 }, general: { answered:0, correct:0 } }
      },
      conceptStats: {}, // { "subject|concept": { total, correct } }
      alarms: [],       // [{ id, label, time, repeat, enabled, lastFired }]
      sessions: []      // 최근 퀴즈 세션 기록 (최대 30개)
    };
  }
  function saveState() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
    catch (e) { console.warn("저장 실패", e); }
  }

  // ============================================================
  // 인증 (Supabase Auth)
  // ============================================================
  const sb = () => window.supabaseClient;
  let authMode = "login"; // "login" | "signup"

  function getConcept(qId) {
    return (window.STUDY_DATA.QUIZ_CONCEPTS && window.STUDY_DATA.QUIZ_CONCEPTS[qId]) || "기타";
  }

  function showAuth() {
    if (currentUser) { showUserMenu(); return; }
    authMode = "login";
    renderAuthModal();
    $("#authOverlay").hidden = false;
  }
  function closeAuth() { $("#authOverlay").hidden = true; }

  function switchAuthTab(mode) {
    authMode = mode;
    renderAuthModal();
  }

  function renderAuthModal() {
    const title = authMode === "login" ? "🔐 로그인" : "✨ 회원가입";
    $("#authTitle").textContent = title;
    const isLogin = authMode === "login";
    $("#authBody").innerHTML = `
      <div class="auth-tabs">
        <button class="auth-tab ${isLogin?'active':''}" onclick="App.switchAuthTab('login')">로그인</button>
        <button class="auth-tab ${!isLogin?'active':''}" onclick="App.switchAuthTab('signup')">회원가입</button>
      </div>
      <div class="auth-error" id="authError"></div>
      <div class="auth-form">
        ${!isLogin ? `<div class="form-group"><label class="form-label">닉네임</label><input type="text" id="authNickname" placeholder="표시될 이름" maxlength="20"></div>` : ""}
        <div class="form-group"><label class="form-label">이메일</label><input type="email" id="authEmail" placeholder="이메일 주소" autocomplete="email"></div>
        <div class="form-group"><label class="form-label">비밀번호</label><input type="password" id="authPassword" placeholder="비밀번호 (6자 이상)" autocomplete="${isLogin?'current-password':'new-password'}"></div>
        ${!isLogin ? `<div class="auth-notice">📧 가입 후 입력한 이메일로 <strong>인증 메일</strong>이 발송됩니다. 메일의 인증 링크를 클릭한 후 로그인할 수 있습니다.</div>` : ""}
        <button class="btn" style="width:100%" id="authSubmit" onclick="App.submitAuth()">${isLogin?"로그인":"회원가입"}</button>
        ${isLogin ? `<p class="auth-hint" style="text-align:center;margin-top:12px">계정이 없으신가요? <a href="#" onclick="App.switchAuthTab('signup');return false;" style="color:var(--primary);font-weight:600">회원가입</a></p>` : `<p class="auth-hint" style="text-align:center;margin-top:12px">이미 계정이 있으신가요? <a href="#" onclick="App.switchAuthTab('login');return false;" style="color:var(--primary);font-weight:600">로그인</a></p>`}
      </div>`;
    setTimeout(() => { const e = $("#authEmail"); if (e) e.focus(); }, 100);
  }

  function renderVerifySent(email) {
    $("#authTitle").textContent = "📬 인증 메일 발송";
    $("#authBody").innerHTML = `
      <div style="text-align:center;padding:16px 0">
        <div style="font-size:3rem;margin-bottom:16px">📧</div>
        <h3 style="margin-bottom:10px">인증 메일이 발송되었습니다!</h3>
        <p style="color:var(--text);line-height:1.6;margin-bottom:8px">
          <strong style="color:var(--primary)">${escapeHtml(email)}</strong> 로 인증 메일을 보냈습니다.
        </p>
        <p style="color:var(--text-muted);line-height:1.6;font-size:0.9rem;margin-bottom:20px">
          받은 편지함(또는 스펨함)에서 메일을 확인하고<br>
          <strong>인증 링크</strong>를 클릭한 후 로그인해 주세요.
        </p>
        <div style="background:var(--surface-2);border-radius:var(--radius-sm);padding:14px;margin-bottom:20px;text-align:left">
          <p style="font-size:0.84rem;color:var(--text-muted);line-height:1.5">
            ⏱️ 인증 메일은 발송 후 최대 수 분까지 걸릴 수 있습니다.<br>
            📂 스펨/정크 메일함도 확인해 주세요.<br>
            🔒 인증 완료 전까지 로그인할 수 없습니다.
          </p>
        </div>
        <button class="btn" style="width:100%;margin-bottom:10px" onclick="App.switchAuthTab('login')">로그인하러 가기</button>
        <button class="btn btn-ghost" style="width:100%" onclick="App.closeAuth()">나중에 인증하기</button>
      </div>`;
  }

  function showAuthError(msg) {
    const el = $("#authError");
    if (el) { el.textContent = msg; el.classList.add("show"); }
  }

  async function submitAuth() {
    const email = ($("#authEmail")?.value || "").trim();
    const password = $("#authPassword")?.value || "";
    if (!email || !password) { showAuthError("이메일과 비밀번호를 입력하세요."); return; }
    if (password.length < 6) { showAuthError("비밀번호는 6자 이상이어야 합니다."); return; }

    const btn = $("#authSubmit");
    if (btn) { btn.disabled = true; btn.textContent = "처리 중..."; }

    try {
      if (authMode === "signup") {
        const nickname = ($("#authNickname")?.value || "").trim();
        const { data, error } = await sb().auth.signUp({ email, password, options: { data: { nickname: nickname || email.split("@")[0] } } });
        if (error) throw error;
        if (data.user && !data.session) {
          renderVerifySent(email);
        }
      } else {
        const { data, error } = await sb().auth.signInWithPassword({ email, password });
        if (error) throw error;
        closeAuth();
      }
    } catch (e) {
      const msg = errMsg(e);
      if (msg.includes("Email not confirmed") || msg.includes("email_not_confirmed")) {
        showAuthError("이메일 인증이 완료되지 않았습니다. 받은 편지함(또는 스펨함)에서 인증 메일을 확인해 주세요.");
      } else if (msg.includes("Invalid login")) {
        showAuthError("이메일 또는 비밀번호가 올바르지 않습니다.");
      } else {
        showAuthError(msg);
      }
      if (btn) { btn.disabled = false; btn.textContent = authMode === "login" ? "로그인" : "회원가입"; }
    }
  }

  async function doLogout() {
    await sb().auth.signOut();
    currentUser = null;
    state = loadState();
    updateAuthUI();
    applyTheme();
    toast("로그아웃", "로그아웃되었습니다.", "");
    navigate("home");
  }

  function showUserMenu() {
    openModal("내 계정",
      `<div style="text-align:center;padding:10px 0">
        <div class="auth-user-avatar" style="width:56px;height:56px;font-size:1.4rem;margin:0 auto 12px">${(currentUser.nickname||currentUser.email||"?")[0].toUpperCase()}</div>
        <div style="font-weight:700;font-size:1.1rem">${escapeHtml(currentUser.nickname || currentUser.email)}</div>
        <div style="color:var(--text-muted);font-size:0.86rem;margin-top:4px">${escapeHtml(currentUser.email)}</div>
        ${currentUser.isAdmin ? '<div style="display:inline-block;margin-top:8px;padding:3px 12px;border-radius:999px;background:var(--primary);color:#fff;font-size:0.78rem;font-weight:600">🛡️ 관리자</div>' : ''}
       </div>`,
      `<button class="btn btn-ghost" onclick="App.closeModal()">닫기</button>
       <button class="btn btn-danger" onclick="App.closeModal();App.doLogout()">로그아웃</button>`);
  }

  function updateAuthUI() {
    const btn = $("#authBtn");
    if (!btn) return;
    if (currentUser) {
      const name = currentUser.nickname || currentUser.email.split("@")[0];
      btn.textContent = name;
      btn.classList.add("user");
      btn.title = currentUser.email;
    } else {
      btn.textContent = "🔐 로그인";
      btn.classList.remove("user");
      btn.title = "로그인 / 회원가입";
    }
  }

  // ============================================================
  // DB 연동 (Supabase)
  // ============================================================
  async function loadUserData() {
    if (!currentUser) return;
    try {
      // 1. SRS 레코드 로드
      const { data: srsRows } = await sb().from("srs_records").select("*").eq("user_id", currentUser.id);
      state.srs = {};
      if (srsRows) {
        for (const row of srsRows) {
          state.srs[row.question_id] = {
            level: row.level,
            dueDate: row.due_date ? new Date(row.due_date).getTime() : null,
            history: row.history || [],
            addedAt: row.created_at ? new Date(row.created_at).getTime() : Date.now()
          };
        }
      }

      // 2. 풀이 기록에서 통계 계산
      const { data: answers } = await sb().from("answer_records").select("*").eq("user_id", currentUser.id);
      state.stats = { totalAnswered: 0, totalCorrect: 0, bySubject: { excel: { answered:0, correct:0 }, access: { answered:0, correct:0 }, general: { answered:0, correct:0 } } };
      state.conceptStats = {};
      if (answers) {
        for (const a of answers) {
          state.stats.totalAnswered++;
          if (a.is_correct) state.stats.totalCorrect++;
          const subj = state.stats.bySubject[a.subject] || { answered:0, correct:0 };
          subj.answered++;
          if (a.is_correct) subj.correct++;
          state.stats.bySubject[a.subject] = subj;
          const concept = getConcept(a.question_id);
          const ck = a.subject + "|" + concept;
          const cs = state.conceptStats[ck] || { total: 0, correct: 0 };
          cs.total++;
          if (a.is_correct) cs.correct++;
          state.conceptStats[ck] = cs;
        }
      }
      saveState();
      toast("데이터 동기화", "클라우드에서 학습 데이터를 불러왔습니다.", "success");
    } catch (e) {
      console.warn("데이터 로드 실패", e);
      toast("동기화 실패", "클라우드 데이터 로드 중 오류가 발생했습니다.", "warn");
    }
  }

  async function syncRecordToDB(q, isCorrect, selectedIdx) {
    if (!currentUser) return;
    const uid = currentUser.id;
    const concept = getConcept(q.id);
    try {
      // 1. 풀이 기록 저장
      await sb().from("answer_records").insert({
        user_id: uid, question_id: q.id, subject: q.subject, difficulty: q.difficulty,
        selected_index: selectedIdx, correct_index: q.answer, is_correct: isCorrect
      });

      // 2. SRS 상태 upsert
      const entry = state.srs[q.id];
      await sb().from("srs_records").upsert({
        user_id: uid, question_id: q.id, level: entry.level,
        due_date: entry.dueDate ? new Date(entry.dueDate).toISOString() : null,
        mastered: entry.level >= MASTERY_THRESHOLD, history: entry.history
      }, { onConflict: "user_id,question_id" });

      // 3. 약한 개념 upsert
      const ck = q.subject + "|" + concept;
      const cs = state.conceptStats[ck] || { total: 0, correct: 0 };
      const accuracy = cs.total > 0 ? Math.round(cs.correct / cs.total * 10000) / 100 : 0;
      await sb().from("weak_concepts").upsert({
        user_id: uid, subject: q.subject, concept: concept,
        total_attempts: cs.total, correct_count: cs.correct, accuracy: accuracy,
        needs_review: cs.total >= 2 && (cs.correct / cs.total) < 0.7,
        last_evaluated: new Date().toISOString()
      }, { onConflict: "user_id,subject,concept" });
    } catch (e) {
      console.warn("DB 동기화 실패", e);
    }
  }

  // ---------- 유틸 ----------
  const $ = (sel) => document.querySelector(sel);
  const content = () => $("#content");
  const errMsg = (e) => {
    if (!e) return "오류가 발생했습니다.";
    if (typeof e === "string") return e;
    if (e.message && e.message !== "{}") return e.message;
    if (e.error_description) return e.error_description;
    if (e.error) return typeof e.error === "string" ? e.error : JSON.stringify(e.error);
    if (e.msg) return e.msg;
    try { const s = JSON.stringify(e); if (s && s !== "{}") return s; } catch (_) {}
    return "오류가 발생했습니다.";
  };
  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;" }[c]));
  const subjectName = (k) => ({ excel:"스프레드시트(엑셀)", access:"데이터베이스(액세스)", general:"전자계산기 일반" }[k] || k);
  const subjectIcon = (k) => ({ excel:"📊", access:"🗄️", general:"💻" }[k] || "📘");
  function shuffle(arr) { const a = [...arr]; for (let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];} return a; }
  function fmtDate(ts) {
    const d = new Date(ts);
    return `${d.getMonth()+1}월 ${d.getDate()}일 ${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`;
  }
  function fmtDuration(ms) {
    const h = Math.floor(ms/3600000), m = Math.floor((ms%3600000)/60000);
    if (h>0) return `${h}시간 ${m}분`;
    return `${m}분`;
  }

  // ---------- 토스트 ----------
  function toast(title, msg, type="") {
    const wrap = $("#toastWrap");
    const el = document.createElement("div");
    el.className = `toast ${type}`;
    el.innerHTML = `<div style="flex:1"><div class="toast-title">${escapeHtml(title)}</div>${msg?`<div class="toast-msg">${escapeHtml(msg)}</div>`:""}</div><button class="toast-close" aria-label="닫기">✕</button>`;
    const close = () => { clearTimeout(timer); el.style.opacity="0"; el.style.transform="translateX(120%)"; setTimeout(()=>el.remove(), 300); };
    const timer = setTimeout(close, 5000);
    el.querySelector(".toast-close").addEventListener("click", (e) => { e.stopPropagation(); close(); });
    el.addEventListener("click", close);
    el.style.cursor = "pointer";
    wrap.appendChild(el);
  }

  // ---------- 모달 ----------
  function openModal(title, bodyHtml, footerHtml="") {
    $("#modalTitle").textContent = title;
    $("#modalBody").innerHTML = bodyHtml;
    $("#modalFooter").innerHTML = footerHtml;
    $("#modalOverlay").hidden = false;
  }
  function closeModal() { $("#modalOverlay").hidden = true; }

  // ---------- 테마 ----------
  function applyTheme() {
    document.documentElement.setAttribute("data-theme", state.theme);
    $("#themeToggle").textContent = state.theme === "dark" ? "☀️" : "🌙";
  }
  function toggleTheme() {
    state.theme = state.theme === "dark" ? "light" : "dark";
    applyTheme(); saveState();
  }

  // ---------- 네비게이션 ----------
  function navigate(page) {
    if (currentPage !== "stats") destroyStatsCharts();
    currentPage = page;
    document.querySelectorAll(".menu-item").forEach(m => m.classList.toggle("active", m.dataset.page === page));
    $("#menu").classList.remove("open");
    window.scrollTo({ top: 0, behavior: "smooth" });
    render(page);
    if (window.AOS) AOS.refreshHard();
  }

  function render(page) {
    const c = content();
    switch (page) {
      case "home": c.innerHTML = viewHome(); break;
      case "notes": c.innerHTML = viewNotes(); bindNotes(); break;
      case "quiz": c.innerHTML = viewQuizSetup(); bindQuizSetup(); break;
      case "review": c.innerHTML = viewReview(); break;
      case "alarm": c.innerHTML = viewAlarm(); bindAlarm(); break;
      case "stats": c.innerHTML = viewStats(); break;
      case "board": viewBoard(); break;
      default: c.innerHTML = viewHome();
    }
  }

  // ============================================================
  // 홈
  // ============================================================
  function viewHome() {
    const srsCount = Object.keys(state.srs).length;
    const dueCount = getDueReviewIds().length;
    const masteredCount = Object.values(state.srs).filter(s => s.level >= MASTERY_THRESHOLD).length;
    const activeAlarms = state.alarms.filter(a => a.enabled).length;
    const accuracy = state.stats.totalAnswered > 0 ? Math.round(state.stats.totalCorrect/state.stats.totalAnswered*100) : 0;

    return `
      <div class="hero">
        <div class="hero-grid-bg"></div>
        <div class="hero-content">
          <div class="hero-dday" data-aos="zoom-in" data-aos-duration="800">
            <span class="hero-dday-label">시험까지</span>
            <span class="hero-dday-num">${getDDay()}</span>
          </div>
          <h1 data-aos="fade-up" data-aos-delay="100" data-aos-duration="700">컴퓨터활용능력 1급<br>합격 학습 센터</h1>
          <p data-aos="fade-up" data-aos-delay="200">기출문제 기반 퀴즈와 과학적 간격 반복 복습(SRS)으로 자주 틀리는 문제를 자동으로 관리합니다. 알람으로 학습 시간을 알림받으세요.</p>
          <div class="hero-stats" data-aos="fade-up" data-aos-delay="300">
            <div class="hero-stat"><div class="hero-stat-num">${state.stats.totalAnswered}</div><div class="hero-stat-label">누적 푼 문제</div></div>
            <div class="hero-stat"><div class="hero-stat-num">${accuracy}%</div><div class="hero-stat-label">정답률</div></div>
            <div class="hero-stat"><div class="hero-stat-num">${dueCount}</div><div class="hero-stat-label">지금 복습할 문제</div></div>
            <div class="hero-stat"><div class="hero-stat-num">${masteredCount}</div><div class="hero-stat-label">완전 숙지</div></div>
          </div>
        </div>
      </div>
      ${!currentUser ? `<div class="login-prompt"><span>💡 로그인하면 학습 데이터가 클라우드에 안전하게 저장되고, 약한 개념을 분석해줍니다.</span><button class="btn btn-secondary" onclick="App.showAuth()">지금 로그인하기</button></div>` : ""}
      <div class="grid grid-3">
        <div class="card clickable" onclick="App.navigate('notes')" data-aos="fade-up" data-aos-delay="0">
          <div class="card-icon">📝</div>
          <div class="card-text">
            <div class="card-title">요약 노트</div>
            <div class="card-desc">엑셀·액세스·전자계산기 핵심 정리. 과목별 섹션 접기/펼치기</div>
          </div>
        </div>
        <div class="card clickable" onclick="App.navigate('quiz')" data-aos="fade-up" data-aos-delay="80">
          <div class="card-icon">✍️</div>
          <div class="card-text">
            <div class="card-title">기출 퀴즈</div>
            <div class="card-desc">과목·난이도 선택. 틀린 문제는 자동으로 복습 큐에 등록</div>
          </div>
        </div>
        <div class="card clickable" onclick="App.navigate('review')" data-aos="fade-up" data-aos-delay="160">
          <div class="card-icon">🔁</div>
          <div class="card-text">
            <div class="card-title">간격 반복 복습</div>
            <div class="card-desc">오답을 4시간→12시간→1일… 주기로 재출제. 숙지까지 관리</div>
          </div>
        </div>
        <div class="card clickable" onclick="App.navigate('alarm')" data-aos="fade-up" data-aos-delay="0">
          <div class="card-icon">⏰</div>
          <div class="card-text">
            <div class="card-title">학습 알람</div>
            <div class="card-desc">시간 지정 알림 + 반복 옵션. 브라우저 알림 지원</div>
          </div>
        </div>
        <div class="card clickable" onclick="App.navigate('stats')" data-aos="fade-up" data-aos-delay="80">
          <div class="card-icon">📊</div>
          <div class="card-text">
            <div class="card-title">학습 통계</div>
            <div class="card-desc">과목별 정답률, 약한 개념 분석, 진행 상황 시각화</div>
          </div>
        </div>
        <div class="card clickable" onclick="App.navigate('board')" data-aos="fade-up" data-aos-delay="160">
          <div class="card-icon">💬</div>
          <div class="card-text">
            <div class="card-title">학습 게시판</div>
            <div class="card-desc">합격 팁, 질문, 정보 공유. 자유롭게 글을 작성하세요</div>
          </div>
        </div>
        <div class="card clickable" onclick="App.startQuickReview()" data-aos="fade-up" data-aos-delay="0">
          <div class="card-icon">⚡</div>
          <div class="card-text">
            <div class="card-title">빠른 복습 시작</div>
            <div class="card-desc">지금 복습할 때가 된 ${dueCount}문제 바로 풀기</div>
          </div>
        </div>
      </div>`;
  }

  // ============================================================
  // 요약 노트
  // ============================================================
  let notesSubject = "excel";
  function viewNotes() {
    const tabs = Object.keys(window.STUDY_DATA.NOTES).map(k => {
      const s = window.STUDY_DATA.NOTES[k];
      return `<div class="tab ${k===notesSubject?'active':''}" onclick="App.selectNotesSubject('${k}')">${s.icon} ${s.title}</div>`;
    }).join("");

    const subject = window.STUDY_DATA.NOTES[notesSubject];
    const sections = subject.sections.map((sec, i) => `
      <div class="note-section ${i===0?'open':''}">
        <div class="note-section-header" onclick="App.toggleNoteSection(this)">
          <span>${escapeHtml(sec.title)}</span>
          <span class="chev">▶</span>
        </div>
        <div class="note-section-body">
          <ul>${sec.items.map(it => `<li>${escapeHtml(it)}</li>`).join("")}</ul>
        </div>
      </div>`).join("");

    return `
      <h1 class="page-title">${subject.icon} 요약 노트</h1>
      <p class="page-subtitle">컴활 1급 핵심 개념 요약. 섹션을 클릭해 펼치고 접으세요.</p>
      <div class="subject-tabs">${tabs}</div>
      ${sections}`;
  }
  function bindNotes() {}
  function selectNotesSubject(k) { notesSubject = k; render("notes"); }
  function toggleNoteSection(headerEl) {
    headerEl.parentElement.classList.toggle("open");
  }

  // ============================================================
  // 퀴즈
  // ============================================================
  let quizConfig = { subjects: ["excel","access","general"], difficulty: 0, count: 10 };
  // difficulty: 0=전체, 1=쉬움, 2=보통, 3=어려움

  function viewQuizSetup() {
    const subjects = ["excel","access","general"].map(k => `
      <div class="chip ${quizConfig.subjects.includes(k)?'selected':''}" onclick="App.toggleQuizSubject('${k}')">${subjectIcon(k)} ${subjectName(k)}</div>`).join("");
    const diffs = [
      { v:0, l:"전체" }, { v:1, l:"⭐ 쉬움" }, { v:2, l:"⭐⭐ 보통" }, { v:3, l:"⭐⭐⭐ 어려움" }
    ].map(d => `<div class="chip ${quizConfig.difficulty===d.v?'selected':''}" onclick="App.setQuizDifficulty(${d.v})">${d.l}</div>`).join("");
    const counts = [5,10,15,20,30].map(n => `<div class="chip ${quizConfig.count===n?'selected':''}" onclick="App.setQuizCount(${n})">${n}문제</div>`).join("");

    const dueCount = getDueReviewIds().length;

    return `
      <h1 class="page-title" data-aos="fade-right">✍️ 기출 퀴즈</h1>
      <p class="page-subtitle" data-aos="fade-right" data-aos-delay="100">과목·난이도·문제 수를 선택하고 시작하세요. 틀린 문제는 자동으로 SRS 복습 큐에 들어갑니다.</p>
      <div class="quiz-setup" data-aos="fade-up" data-aos-delay="200">
        <h3>퀴즈 설정</h3>
        <div class="form-group">
          <label class="form-label">과목 선택 (복수 가능)</label>
          <div class="chip-group">${subjects}</div>
        </div>
        <div class="form-group">
          <label class="form-label">난이도</label>
          <div class="chip-group">${diffs}</div>
        </div>
        <div class="form-group">
          <label class="form-label">문제 수</label>
          <div class="chip-group">${counts}</div>
        </div>
        <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:18px">
          <button class="btn" onclick="App.startQuiz()">퀴즈 시작</button>
          <button class="btn btn-secondary" onclick="App.startQuickReview()">⚡ 복습 대기 ${dueCount}문제 바로 풀기</button>
        </div>
      </div>`;
  }
  function bindQuizSetup() {}
  function toggleQuizSubject(k) {
    const idx = quizConfig.subjects.indexOf(k);
    if (idx >= 0) {
      if (quizConfig.subjects.length > 1) quizConfig.subjects.splice(idx,1);
      else toast("알림","최소 1개 과목은 선택해야 합니다","warn");
    } else quizConfig.subjects.push(k);
    render("quiz");
  }
  function setQuizDifficulty(v) { quizConfig.difficulty = v; render("quiz"); }
  function setQuizCount(n) { quizConfig.count = n; render("quiz"); }

  function buildQuestionPool(subjects, difficulty) {
    let pool = window.STUDY_DATA.QUIZ.filter(q => subjects.includes(q.subject));
    if (difficulty > 0) pool = pool.filter(q => q.difficulty === difficulty);
    return pool;
  }

  function startQuiz() {
    let pool = buildQuestionPool(quizConfig.subjects, quizConfig.difficulty);
    if (pool.length === 0) { toast("문제 없음","선택 조건에 맞는 문제가 없습니다","warn"); return; }
    const questions = shuffle(pool).slice(0, Math.min(quizConfig.count, pool.length));
    currentQuiz = {
      questions,
      index: 0,
      correct: 0,
      answered: 0,
      results: [], // { id, correct:bool, selected }
      startTime: Date.now(),
      isReview: false
    };
    renderQuizQuestion();
  }

  function startQuickReview() {
    const dueIds = getDueReviewIds();
    if (dueIds.length === 0) {
      toast("복습할 문제 없음","지금은 복습할 문제가 없습니다. 퀴즈를 풀어 오답을 만들어보세요!","warn");
      navigate("quiz");
      return;
    }
    const questions = dueIds.map(id => window.STUDY_DATA.QUIZ.find(q => q.id === id)).filter(Boolean);
    currentQuiz = {
      questions: shuffle(questions),
      index: 0,
      correct: 0,
      answered: 0,
      results: [],
      startTime: Date.now(),
      isReview: true
    };
    toast("복습 시작",`${questions.length}문제 복습을 시작합니다`,"success");
    renderQuizQuestion();
  }

  function renderQuizQuestion() {
    if (!currentQuiz) return;
    const q = currentQuiz.questions[currentQuiz.index];
    const total = currentQuiz.questions.length;
    const progress = ((currentQuiz.index) / total) * 100;

    content().innerHTML = `
      <div class="quiz-card">
        <div class="quiz-progress">
          <span>${currentQuiz.isReview?"🔁 복습 세션":"✍️ 퀴즈"} · 문제 ${currentQuiz.index+1} / ${total}</span>
          <span>정답 ${currentQuiz.correct} / ${currentQuiz.answered}</span>
        </div>
        <div class="progress-bar"><div class="progress-fill" style="width:${progress}%"></div></div>
        <div class="quiz-question">${escapeHtml(q.q)}</div>
        <div class="quiz-options" id="quizOptions">
          ${q.options.map((opt, i) => `
            <div class="quiz-option" data-idx="${i}" onclick="App.answerQuiz(${i})">
              <span class="opt-key">${String.fromCharCode(65+i)}</span>
              <span>${escapeHtml(opt)}</span>
            </div>`).join("")}
        </div>
        <div class="quiz-explanation" id="quizExplanation"></div>
        <div class="quiz-actions">
          <button class="btn btn-ghost" onclick="App.quitQuiz()">그만두기</button>
          <button class="btn" id="nextBtn" onclick="App.nextQuiz()" disabled>다음 문제 →</button>
        </div>
      </div>`;
  }

  function answerQuiz(selectedIdx) {
    if (!currentQuiz) return;
    const q = currentQuiz.questions[currentQuiz.index];
    const opts = document.querySelectorAll(".quiz-option");
    if (opts[0].classList.contains("disabled")) return; // 이미 답함

    const isCorrect = selectedIdx === q.answer;
    opts.forEach((el, i) => {
      el.classList.add("disabled");
      el.onclick = null;
      if (i === q.answer) el.classList.add("correct");
      if (i === selectedIdx && !isCorrect) el.classList.add("wrong");
    });

    // 해설 표시
    const exp = $("#quizExplanation");
    exp.innerHTML = `<strong>${isCorrect?"✅ 정답!":"❌ 오답"}</strong> ${escapeHtml(q.explanation)}`;
    exp.classList.add("show");

    currentQuiz.answered++;
    if (isCorrect) currentQuiz.correct++;
    currentQuiz.results.push({ id: q.id, correct: isCorrect, selected: selectedIdx });

    // 통계 + SRS 업데이트
    recordAnswer(q, isCorrect, selectedIdx);

    $("#nextBtn").disabled = false;
    $("#nextBtn").textContent = currentQuiz.index + 1 >= currentQuiz.questions.length ? "결과 보기 →" : "다음 문제 →";
  }

  function nextQuiz() {
    if (!currentQuiz) return;
    currentQuiz.index++;
    if (currentQuiz.index >= currentQuiz.questions.length) {
      finishQuiz();
    } else {
      renderQuizQuestion();
    }
  }

  function quitQuiz() {
    if (!currentQuiz || currentQuiz.answered === 0) { currentQuiz = null; navigate("quiz"); return; }
    openModal("퀴즈 중단", `<p>지금까지 푼 ${currentQuiz.answered}문제의 결과만 저장하고 끝내시겠습니까?</p>`,
      `<button class="btn btn-ghost" onclick="App.closeModal()">계속 풀기</button>
       <button class="btn btn-danger" onclick="App.confirmQuit()">중단하기</button>`);
  }
  function confirmQuit() {
    closeModal();
    finishQuiz(true);
  }

  function finishQuiz(quit=false) {
    const duration = Date.now() - currentQuiz.startTime;
    const acc = currentQuiz.answered > 0 ? Math.round(currentQuiz.correct/currentQuiz.answered*100) : 0;
    const wrongList = currentQuiz.results.filter(r => !r.correct).map(r => r.id);

    // 세션 기록 저장
    state.sessions.unshift({
      date: Date.now(),
      answered: currentQuiz.answered,
      correct: currentQuiz.correct,
      accuracy: acc,
      duration,
      isReview: currentQuiz.isReview,
      wrongIds: wrongList
    });
    if (state.sessions.length > 30) state.sessions = state.sessions.slice(0, 30);
    saveState();

    const grade = acc >= 90 ? "🏆 훌륭!" : acc >= 70 ? "👍 잘했어요!" : acc >= 50 ? "💪 더 연습!" : "📚 복습 필요";
    const reviewNow = getDueReviewIds().length;

    content().innerHTML = `
      <div class="quiz-card quiz-result">
        <div class="result-score">${acc}%</div>
        <div class="result-label">${grade} ${currentQuiz.isReview?"(복습 세션)":""}</div>
        <div class="result-detail">
          <div class="result-stat"><div class="result-stat-num">${currentQuiz.correct}</div><div class="result-stat-label">정답</div></div>
          <div class="result-stat"><div class="result-stat-num">${currentQuiz.answered-currentQuiz.correct}</div><div class="result-stat-label">오답</div></div>
          <div class="result-stat"><div class="result-stat-num">${fmtDuration(duration)}</div><div class="result-stat-label">소요 시간</div></div>
          <div class="result-stat"><div class="result-stat-num">${reviewNow}</div><div class="result-stat-label">복습 대기</div></div>
        </div>
        <div class="quiz-actions" style="justify-content:center">
          <button class="btn" onclick="App.navigate('quiz')">새 퀴즈 풀기</button>
          ${reviewNow>0?`<button class="btn btn-success" onclick="App.startQuickReview()">⚡ 복습 ${reviewNow}문제 풀기</button>`:""}
          <button class="btn btn-secondary" onclick="App.navigate('review')">복습 현황 보기</button>
        </div>
      </div>`;

    currentQuiz = null;
    updateAlertBar();
    if (!quit) toast("퀴즈 완료", `정답률 ${acc}% · ${grade}`,"success");

    // 축하 이펙트
    if (typeof confetti === "function" && !quit) {
      if (acc >= 90) {
        // 만점에 가까우면 대폭죽
        const colors = ["#00d97e", "#ffb547", "#5b8def", "#ff5470"];
        const fire = (ratio, opts) => confetti({ particleCount: Math.floor(200 * ratio), spread: 70, origin: { y: 0.6 }, colors, ...opts });
        fire(0.25, { spread: 26, startVelocity: 55 });
        fire(0.2, { spread: 60 });
        fire(0.35, { spread: 100, decay: 0.91, scalar: 0.8 });
        fire(0.1, { spread: 120, startVelocity: 25, decay: 0.92, scalar: 1.2 });
        fire(0.1, { spread: 120, startVelocity: 45 });
      } else if (acc >= 70) {
        confetti({ particleCount: 80, spread: 70, origin: { y: 0.6 }, colors: ["#00d97e", "#ffb547"], scalar: 0.9 });
      }
    }
  }

  // ---------- 답 기록 + SRS 업데이트 ----------
  function recordAnswer(q, isCorrect, selectedIdx) {
    // 통계
    state.stats.totalAnswered++;
    if (isCorrect) state.stats.totalCorrect++;
    const subj = state.stats.bySubject[q.subject] || { answered:0, correct:0 };
    subj.answered++;
    if (isCorrect) subj.correct++;
    state.stats.bySubject[q.subject] = subj;

    // 개념별 통계
    const concept = getConcept(q.id);
    const ck = q.subject + "|" + concept;
    const cs = state.conceptStats[ck] || { total: 0, correct: 0 };
    cs.total++;
    if (isCorrect) cs.correct++;
    state.conceptStats[ck] = cs;

    // SRS 업데이트
    const entry = state.srs[q.id] || { level: 0, dueDate: Date.now(), history: [], addedAt: Date.now() };
    entry.history.push({ date: Date.now(), correct: isCorrect });
    if (entry.history.length > 20) entry.history = entry.history.slice(-20);

    if (isCorrect) {
      entry.level = Math.min(entry.level + 1, MASTERY_THRESHOLD);
      if (entry.level >= MASTERY_THRESHOLD) {
        entry.dueDate = null;
      } else {
        const hours = SRS_INTERVALS_HOURS[entry.level] || 168;
        entry.dueDate = Date.now() + hours * 3600000;
      }
    } else {
      entry.level = 1;
      entry.dueDate = Date.now() + SRS_INTERVALS_HOURS[1] * 3600000;
    }
    state.srs[q.id] = entry;
    saveState();

    // DB 동기화 (로그인 시)
    syncRecordToDB(q, isCorrect, selectedIdx);
  }

  // ============================================================
  // SRS 복습
  // ============================================================
  function getDueReviewIds() {
    const now = Date.now();
    return Object.entries(state.srs)
      .filter(([id, s]) => s.dueDate != null && s.dueDate <= now && s.level < MASTERY_THRESHOLD)
      .map(([id]) => id);
  }

  function viewReview() {
    const now = Date.now();
    const entries = Object.entries(state.srs).map(([id, s]) => {
      const q = window.STUDY_DATA.QUIZ.find(x => x.id === id);
      return { id, s, q };
    }).filter(e => e.q);

    const due = entries.filter(e => e.s.dueDate != null && e.s.dueDate <= now && e.s.level < MASTERY_THRESHOLD);
    const upcoming = entries.filter(e => e.s.dueDate != null && e.s.dueDate > now && e.s.level < MASTERY_THRESHOLD)
      .sort((a,b) => a.s.dueDate - b.s.dueDate);
    const mastered = entries.filter(e => e.s.level >= MASTERY_THRESHOLD);

    const summary = `
      <div class="srs-summary">
        <div class="srs-stat"><div class="srs-stat-num" style="color:var(--warn)">${due.length}</div><div class="srs-stat-label">지금 복습</div></div>
        <div class="srs-stat"><div class="srs-stat-num" style="color:var(--primary)">${upcoming.length}</div><div class="srs-stat-label">예정됨</div></div>
        <div class="srs-stat"><div class="srs-stat-num" style="color:var(--success)">${mastered.length}</div><div class="srs-stat-label">완전 숙지</div></div>
        <div class="srs-stat"><div class="srs-stat-num">${entries.length}</div><div class="srs-stat-label">전체 추적</div></div>
      </div>`;

    let body = "";
    if (due.length > 0) {
      body += `<h3 style="margin:8px 0 14px">⏰ 지금 복습할 때 (${due.length})</h3>`;
      body += due.map(e => reviewItemHtml(e, "due")).join("");
      body += `<button class="btn btn-success" style="margin:10px 0 24px" onclick="App.startQuickReview()">⚡ 복습 시작</button>`;
    }
    if (upcoming.length > 0) {
      body += `<h3 style="margin:18px 0 14px">📅 예정된 복습 (${upcoming.length})</h3>`;
      body += upcoming.slice(0,15).map(e => reviewItemHtml(e, "future")).join("");
    }
    if (mastered.length > 0) {
      body += `<h3 style="margin:18px 0 14px">🏆 완전 숙지 (${mastered.length})</h3>`;
      body += `<p style="color:var(--text-muted);font-size:0.86rem;margin-bottom:10px">이 문제들은 충분히 익숙해져 복습 큐에서 제외되었습니다.</p>`;
      body += mastered.slice(0,10).map(e => reviewItemHtml(e, "mastered")).join("");
    }
    if (entries.length === 0) {
      body = `
        <div class="empty-state">
          <div class="empty-state-icon">🔁</div>
          <h3>아직 복습할 문제가 없습니다</h3>
          <p style="margin-top:8px">퀴즈를 풀어 틀린 문제를 만들면<br>자동으로 이곳에 등록되어 간격 반복으로 복습합니다.</p>
          <button class="btn" style="margin-top:18px" onclick="App.navigate('quiz')">퀴즈 풀러 가기</button>
        </div>`;
    }

    return `
      <h1 class="page-title">🔁 간격 반복 복습 (SRS)</h1>
      <p class="page-subtitle">자주 틀리는 문제를 4시간 → 12시간 → 1일 → 3일 → 7일 주기로 재출제하여 장기 기억으로 만듭니다. 맞히면 다음 단계, 틀리면 처음 단계로 돌아갑니다.</p>
      ${summary}
      ${body}`;
  }

  function reviewItemHtml(e, kind) {
    const q = e.q, s = e.s;
    let badge = "", cls = "";
    if (kind === "due") { cls="due"; badge=`<span class="badge badge-due">지금 복습</span>`; }
    else if (kind === "future") { cls="future"; badge=`<span class="badge badge-future">${fmtDate(s.dueDate)} 예정</span>`; }
    else { cls="ready"; badge=`<span class="badge badge-mastered">완전 숙지</span>`; }
    const lastResult = s.history.length > 0 ? (s.history[s.history.length-1].correct ? "최근 정답" : "최근 오답") : "-";
    return `
      <div class="review-item ${cls}">
        <div class="review-q">
          ${escapeHtml(q.q.length > 70 ? q.q.slice(0,70)+"…" : q.q)}
          <div class="review-meta">${subjectIcon(q.subject)} ${subjectName(q.subject)} · 난이도 ${"⭐".repeat(q.difficulty)} · 단계 ${s.level}/${MASTERY_THRESHOLD} · ${lastResult}</div>
        </div>
        ${badge}
      </div>`;
  }

  // ============================================================
  // 알람
  // ============================================================
  let alarmForm = { label:"공부 시간", time:"20:00", repeat:"none", enabled:true };

  function viewAlarm() {
    // 브라우저 알림 권한 상태
    let notifStatus = "알 수 없음";
    if ("Notification" in window) notifStatus = Notification.permission === "granted" ? "허용됨" : Notification.permission === "denied" ? "차단됨" : "미설정";

    const alarmItems = state.alarms.length === 0
      ? `<div class="empty-state"><div class="empty-state-icon">⏰</div><h3>등록된 알람이 없습니다</h3><p style="margin-top:8px">학습 시간을 알림으로 설정해 꾸준히 공부하세요.</p></div>`
      : state.alarms.map(a => alarmItemHtml(a)).join("");

    const repeatOpts = [
      { v:"none", l:"반복 없음 (1회)" },
      { v:"daily", l:"매일" },
      { v:"weekdays", l:"평일 매일" },
      { v:"weekend", l:"주말 매일" },
      { v:"2h", l:"2시간마다" },
      { v:"4h", l:"4시간마다" }
    ].map(o => `<option value="${o.v}" ${alarmForm.repeat===o.v?"selected":""}>${o.l}</option>`).join("");

    return `
      <h1 class="page-title">⏰ 학습 알람</h1>
      <p class="page-subtitle">지정한 시간에 학습 알림을 보냅니다. 복습할 문제가 있으면 알림에 함께 표시됩니다. (브라우저 알림 상태: ${notifStatus})</p>
      <div class="alarm-form">
        <h3>새 알람 추가</h3>
        <div class="row">
          <div class="form-group">
            <label class="form-label">알람 이름</label>
            <input type="text" id="alarmLabel" value="${escapeHtml(alarmForm.label)}" placeholder="예: 저녁 엑셀 공부">
          </div>
          <div class="form-group">
            <label class="form-label">시간</label>
            <input type="time" id="alarmTime" value="${alarmForm.time}">
          </div>
          <div class="form-group">
            <label class="form-label">반복</label>
            <select id="alarmRepeat">${repeatOpts}</select>
          </div>
        </div>
        <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:8px">
          <button class="btn" id="btnAddAlarm">＋ 알람 추가</button>
          <button class="btn btn-secondary" id="btnNotifPerm">🔔 브라우저 알림 허용</button>
          <button class="btn btn-ghost" id="btnTestAlarm">테스트 알림</button>
          ${state.alarms.length > 0 ? `<button class="btn btn-danger" id="btnClearAlarms">전체 삭제</button>` : ""}
        </div>
      </div>
      <h3 style="margin:24px 0 14px">등록된 알람${state.alarms.length>0?` (${state.alarms.length})`:""}</h3>
      <div id="alarmList">${alarmItems}</div>`;
  }

  function bindAlarm() {
    // 입력값 동기화
    const label = $("#alarmLabel"), time = $("#alarmTime"), rep = $("#alarmRepeat");
    if (label) label.addEventListener("input", () => alarmForm.label = label.value);
    if (time) time.addEventListener("change", () => alarmForm.time = time.value);
    if (rep) rep.addEventListener("change", () => alarmForm.repeat = rep.value);

    // 폼 버튼 (ID 기반)
    const addBtn = $("#btnAddAlarm");
    if (addBtn) addBtn.onclick = () => addAlarm();
    const permBtn = $("#btnNotifPerm");
    if (permBtn) permBtn.onclick = () => requestNotifPermission();
    const testBtn = $("#btnTestAlarm");
    if (testBtn) testBtn.onclick = () => testAlarm();
    const clearBtn = $("#btnClearAlarms");
    if (clearBtn) clearBtn.onclick = () => confirmClearAll();

    // 알람 리스트 이벤트 위임 (인라인 onclick 의존 제거)
    const list = $("#alarmList");
    if (list) {
      list.onclick = (e) => {
        const btn = e.target.closest("[data-action]");
        if (!btn) return;
        const action = btn.getAttribute("data-action");
        const id = btn.getAttribute("data-id");
        if (action === "delete") deleteAlarm(id);
        else if (action === "toggle") toggleAlarm(id);
      };
    }
  }

  function alarmItemHtml(a) {
    const ringing = isAlarmRinging(a);
    const repeatLabel = { none:"1회", daily:"매일", weekdays:"평일", weekend:"주말", "2h":"2시간마다", "4h":"4시간마다" }[a.repeat] || a.repeat;
    return `
      <div class="alarm-list-item ${ringing?'ringing':''}" data-alarm-id="${a.id}">
        <div class="alarm-info">
          <div class="alarm-time">${a.repeat==="2h"||a.repeat==="4h"?"🔁":a.time}</div>
          <div class="alarm-label">${escapeHtml(a.label)}</div>
          <div class="alarm-meta">${repeatLabel} · ${a.enabled?"활성":"비활성"}</div>
        </div>
        <div class="alarm-actions">
          <button class="icon-btn" data-action="toggle" data-id="${a.id}" title="${a.enabled?'켜짐 (누르면 끔)':'꺼짐 (누르면 켬)'}">${a.enabled?"🔔":"🔕"}</button>
          <button class="icon-btn danger" data-action="delete" data-id="${a.id}" title="삭제">🗑️ 삭제</button>
        </div>
      </div>`;
  }

  function addAlarm() {
    const label = ($("#alarmLabel")?.value || "알람").trim() || "알람";
    const time = $("#alarmTime")?.value || "08:00";
    const repeat = $("#alarmRepeat")?.value || "none";
    const alarm = {
      id: "al_" + Date.now().toString(36) + Math.random().toString(36).slice(2,6),
      label, time, repeat, enabled: true, lastFired: 0
    };
    state.alarms.push(alarm);
    saveState();
    toast("알람 추가", `${label} · ${repeat==="2h"||repeat==="4h"?repeat:time}`,"success");
    render("alarm");
    bindAlarm();
  }

  function toggleAlarm(id) {
    const a = state.alarms.find(x => x.id === id);
    if (a) {
      a.enabled = !a.enabled;
      saveState();
      render("alarm");
      bindAlarm();
      toast(a.enabled ? "알람 켜짐" : "알람 꺼짐", `"${a.label}" ${a.enabled?"활성화":"비활성화"}`, a.enabled ? "success" : "");
    }
  }
  function deleteAlarm(id) {
    const a = state.alarms.find(x => x.id === id);
    // 열려있는 OS 알림 닫기
    closeActiveNotification();
    state.alarms = state.alarms.filter(x => x.id !== id);
    saveState();
    render("alarm");
    bindAlarm();
    updateAlertBar();
    toast("삭제됨", a ? `"${a.label}" 알람이 삭제되었습니다` : "알람이 삭제되었습니다", "success");
  }

  function confirmClearAll() {
    if (state.alarms.length === 0) { toast("알람 없음", "삭제할 알람이 없습니다", ""); return; }
    openModal("전체 알람 삭제",
      `<p>등록된 알람 <strong>${state.alarms.length}개</strong>를 모두 삭제합니다.</p><p style="margin-top:8px;color:var(--text-muted);font-size:0.88rem">이 작업은 되돌릴 수 없습니다.</p>`,
      `<button class="btn btn-ghost" onclick="App.closeModal()">취소</button>
       <button class="btn btn-danger" onclick="App.clearAllAlarms()">전체 삭제</button>`);
  }
  function clearAllAlarms() {
    closeActiveNotification();
    state.alarms = [];
    saveState();
    closeModal();
    render("alarm");
    bindAlarm();
    updateAlertBar();
    toast("전체 삭제", "모든 알람이 삭제되었습니다", "success");
  }

  function requestNotifPermission() {
    if (!("Notification" in window)) { toast("미지원","이 브라우저는 알림을 지원하지 않습니다","warn"); return; }
    Notification.requestPermission().then(p => {
      if (p === "granted") { toast("허용됨","브라우저 알림이 허용되었습니다","success"); render("alarm"); bindAlarm(); }
      else toast("거부됨","알림 권한이 거부되었습니다. 사이트 설정에서 변경 가능","warn");
    });
  }

  function testAlarm() {
    const due = getDueReviewIds().length;
    const msg = due > 0 ? `알림이 정상 작동합니다! 지금 복습할 문제 ${due}개가 있습니다.` : "알림이 정상 작동합니다!";
    fireNotification(`🔔 테스트 알람`, msg);
    toast("테스트 알림","화면 알림을 확인하세요","success");
  }

  let activeNotification = null;
  function closeActiveNotification() {
    if (activeNotification) { try { activeNotification.close(); } catch(e){} activeNotification = null; }
  }

  function fireNotification(title, body) {
    // 브라우저 알림
    if ("Notification" in window && Notification.permission === "granted") {
      try {
        closeActiveNotification();
        activeNotification = new Notification(title, { body, icon: "data:image/svg+xml," });
        activeNotification.onclick = () => { window.focus(); activeNotification.close(); };
        // 8초 후 자동 닫기 (일부 브라우저에서 안 닫히는 것 방지)
        setTimeout(closeActiveNotification, 8000);
      } catch(e){}
    }
    // 사이트 내 토스트
    toast(title, body, "warn");
    // 알림음 (Web Audio API 비프)
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      osc.frequency.value = 880; osc.type = "sine";
      gain.gain.setValueAtTime(0.001, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.3, ctx.currentTime + 0.05);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.6);
      osc.start(); osc.stop(ctx.currentTime + 0.6);
    } catch(e){}
  }

  // 알람이 현재 울려야 하는지 (시간 도달 + 미발생)
  function isAlarmRinging(a) {
    return a.enabled && a.lastFired > 0 && (Date.now() - a.lastFired < 60000);
  }

  // 주기적 알람 체크
  function checkAlarms() {
    const now = new Date();
    const nowTs = Date.now();
    const hhmm = String(now.getHours()).padStart(2,"0") + ":" + String(now.getMinutes()).padStart(2,"0");
    const day = now.getDay(); // 0 일 ~ 6 토

    state.alarms.forEach(a => {
      if (!a.enabled) return;
      let shouldFire = false;

      if (a.repeat === "2h" || a.repeat === "4h") {
        const hours = parseInt(a.repeat);
        if (nowTs - a.lastFired >= hours * 3600000) shouldFire = true;
      } else if (a.time === hhmm) {
        if (a.repeat === "none") {
          if (nowTs - a.lastFired > 60000) shouldFire = true;
        } else if (a.repeat === "daily") {
          if (nowTs - a.lastFired > 60000) shouldFire = true;
        } else if (a.repeat === "weekdays") {
          if (day >= 1 && day <= 5 && nowTs - a.lastFired > 60000) shouldFire = true;
        } else if (a.repeat === "weekend") {
          if ((day === 0 || day === 6) && nowTs - a.lastFired > 60000) shouldFire = true;
        }
      }

      if (shouldFire) {
        a.lastFired = nowTs;
        // 1회성(none) 알람은 한 번 울리면 자동 비활성화 (다음 날 같은 시간에 반복 금지)
        if (a.repeat === "none") a.enabled = false;
        const due = getDueReviewIds().length;
        const body = due > 0
          ? `학습 시간입니다! 지금 복습할 문제 ${due}개가 대기 중이에요.`
          : `학습 시간입니다! 컴활 1급 퀴즈를 풀어보세요.`;
        fireNotification(`⏰ ${a.label}`, body);
      }
    });
    saveState();
  }

  // 상단 알림 배너 업데이트
  let alertBarDismissedUntil = 0;
  function updateAlertBar() {
    const bar = $("#alertBar");
    if (!bar) return;
    // 사용자가 닫았으면 일정 시간 동안 숨김 유지
    if (Date.now() < alertBarDismissedUntil) { bar.hidden = true; return; }

    const due = getDueReviewIds().length;
    const ringingAlarms = state.alarms.filter(isAlarmRinging).length;
    if (due > 0 && (currentPage === "home" || currentPage === "quiz")) {
      bar.hidden = false;
      bar.innerHTML = `<span style="flex:1">⏰ 지금 복습할 때! ${due}문제가 준비되었습니다. 클릭해서 바로 복습 시작</span><button class="alert-close" aria-label="닫기">✕</button>`;
      bar.onclick = (e) => { if (e.target.classList.contains("alert-close")) { alertBarDismissedUntil = Date.now() + 300000; bar.hidden = true; } else startQuickReview(); };
    } else if (ringingAlarms > 0) {
      bar.hidden = false;
      bar.innerHTML = `<span style="flex:1">⏰ 알람이 울렸습니다. 학습 시간입니다!</span><button class="alert-close" aria-label="닫기">✕</button>`;
      bar.onclick = (e) => { if (e.target.classList.contains("alert-close")) { alertBarDismissedUntil = Date.now() + 300000; bar.hidden = true; } else navigate("alarm"); };
    } else {
      bar.hidden = true;
    }
  }

  // ============================================================
  // 통계
  // ============================================================
  function renderWeakConcepts() {
    const entries = Object.entries(state.conceptStats)
      .map(([key, v]) => {
        const [subject, concept] = key.split("|");
        const acc = v.total > 0 ? Math.round(v.correct / v.total * 100) : 0;
        return { subject, concept, total: v.total, correct: v.correct, accuracy: acc, needsReview: v.total >= 2 && acc < 70 };
      })
      .filter(e => e.total > 0)
      .sort((a, b) => a.accuracy - b.accuracy);

    if (entries.length === 0) {
      return `<p style="color:var(--text-muted)">아직 충분한 데이터가 없습니다. 퀴즈를 더 풀어보세요!</p>`;
    }

    const weak = entries.filter(e => e.needsReview);
    const ok = entries.filter(e => !e.needsReview);

    let html = "";
    if (weak.length > 0) {
      html += `<p style="color:var(--danger);font-weight:600;font-size:0.88rem;margin-bottom:10px">⚠️ 보완이 필요한 개념</p>`;
      html += weak.map(e => `
        <div class="bar-row">
          <div class="bar-label">${subjectIcon(e.subject)} ${escapeHtml(e.concept)}</div>
          <div class="bar-track"><div class="bar-fill" style="width:${e.accuracy}%;background:var(--danger)">${e.accuracy}%</div></div>
          <div style="font-size:0.82rem;color:var(--text-muted);width:90px;text-align:right">${e.correct}/${e.total}</div>
        </div>`).join("");
    }
    if (ok.length > 0) {
      html += `<p style="color:var(--success);font-weight:600;font-size:0.88rem;margin:${weak.length>0?'16px':'0'} 0 10px">✅ 안정적인 개념</p>`;
      html += ok.map(e => `
        <div class="bar-row">
          <div class="bar-label">${subjectIcon(e.subject)} ${escapeHtml(e.concept)}</div>
          <div class="bar-track"><div class="bar-fill" style="width:${e.accuracy}%;background:var(--success)">${e.accuracy}%</div></div>
          <div style="font-size:0.82rem;color:var(--text-muted);width:90px;text-align:right">${e.correct}/${e.total}</div>
        </div>`).join("");
    }
    return html;
  }

  let statsCharts = [];
  function destroyStatsCharts() {
    statsCharts.forEach(c => { try { c.destroy(); } catch(e){} });
    statsCharts = [];
  }

  function viewStats() {
    destroyStatsCharts();
    const s = state.stats;
    const acc = s.totalAnswered > 0 ? Math.round(s.totalCorrect/s.totalAnswered*100) : 0;
    const wrong = s.totalAnswered - s.totalCorrect;

    const srsTotal = Object.keys(state.srs).length;
    const mastered = Object.values(state.srs).filter(x => x.level >= MASTERY_THRESHOLD).length;
    const due = getDueReviewIds().length;
    const masteryPct = srsTotal > 0 ? Math.round(mastered/srsTotal*100) : 0;

    // 약한 개념 데이터
    const conceptEntries = Object.entries(state.conceptStats)
      .map(([key, v]) => {
        const [subject, concept] = key.split("|");
        const cAcc = v.total > 0 ? Math.round(v.correct / v.total * 100) : 0;
        return { subject, concept, total: v.total, correct: v.correct, accuracy: cAcc };
      })
      .filter(e => e.total > 0)
      .sort((a, b) => a.accuracy - b.accuracy);
    const topConcepts = conceptEntries.slice(0, 8);

    // 최근 세션
    const recentSessions = state.sessions.slice(0,8).map(ses => `
      <tr>
        <td style="padding:6px 8px">${fmtDate(ses.date)}</td>
        <td style="padding:6px 8px">${ses.isReview?"🔁 복습":"✍️ 퀴즈"}</td>
        <td style="padding:6px 8px;text-align:center">${ses.correct}/${ses.answered}</td>
        <td style="padding:6px 8px;text-align:center;font-weight:700;color:${ses.accuracy>=70?'var(--success)':'var(--danger)'}">${ses.accuracy}%</td>
        <td style="padding:6px 8px;text-align:right">${fmtDuration(ses.duration)}</td>
      </tr>`).join("");

    const result = `
      <h1 class="page-title" data-aos="fade-right">📊 학습 통계</h1>
      <p class="page-subtitle" data-aos="fade-right" data-aos-delay="100">나의 학습 진행 상황을 한눈에 확인하세요.</p>
      <div class="grid grid-2" style="margin-bottom:20px">
        <div class="stat-card" data-aos="zoom-in" data-aos-delay="0">
          <h3>전체 정답률</h3>
          <div style="position:relative;height:180px"><canvas id="accChart"></canvas></div>
          <div style="text-align:center;color:var(--text-muted);font-size:0.84rem;margin-top:8px">${s.totalCorrect} 정답 / ${s.totalAnswered} 문제</div>
        </div>
        <div class="stat-card" data-aos="zoom-in" data-aos-delay="150">
          <h3>숙지 진행도</h3>
          <div style="position:relative;height:180px"><canvas id="masteryChart"></canvas></div>
          <div style="text-align:center;color:var(--text-muted);font-size:0.84rem;margin-top:8px">${mastered} 숙지 / ${srsTotal} 추적 · ${due} 복습 대기</div>
        </div>
      </div>
      <div class="stat-card" style="margin-bottom:20px" data-aos="fade-up">
        <h3>과목별 정답률</h3>
        <div style="position:relative;height:200px"><canvas id="subjChart"></canvas></div>
      </div>
      ${topConcepts.length >= 3 ? `<div class="stat-card" style="margin-bottom:20px" data-aos="fade-up">
        <h3>🎯 약한 개념 분석</h3>
        <div style="position:relative;height:280px"><canvas id="conceptChart"></canvas></div>
      </div>` : `<div class="stat-card" style="margin-bottom:20px" data-aos="fade-up">
        <h3>🎯 약한 개념 분석</h3>
        ${renderWeakConcepts()}
      </div>`}
      <div class="stat-card" data-aos="fade-up">
        <h3>최근 학습 세션</h3>
        ${state.sessions.length === 0 ? `<p style="color:var(--text-muted)">아직 학습 기록이 없습니다.</p>` : `
        <table style="width:100%;border-collapse:collapse;font-size:0.88rem">
          <thead><tr style="border-bottom:1px solid var(--border);color:var(--text-muted);text-align:left">
            <th style="padding:6px 8px">날짜</th><th style="padding:6px 8px">유형</th>
            <th style="padding:6px 8px;text-align:center">결과</th><th style="padding:6px 8px;text-align:center">정답률</th>
            <th style="padding:6px 8px;text-align:right">소요</th>
          </tr></thead>
          <tbody>${recentSessions}</tbody>
        </table>`}
      </div>
      <div style="margin-top:24px;text-align:center">
        <button class="btn btn-danger" onclick="App.resetAllData()">🗑️ 모든 학습 데이터 초기화</button>
      </div>`;

    setTimeout(() => initStatsCharts({ acc, wrong, s, mastered, srsTotal, masteryPct, due, topConcepts }), 50);
    return result;
  }

  function initStatsCharts(data) {
    const isDark = state.theme === "dark";
    const textColor = isDark ? "#e8ecf4" : "#1a1d29";
    const mutedColor = isDark ? "#7d8aa8" : "#64748b";
    const gridColor = isDark ? "#2a3148" : "#e2e7f0";
    const greenColor = isDark ? "#00d97e" : "#159c63";
    const amberColor = isDark ? "#ffb547" : "#d97706";
    const dangerColor = isDark ? "#ff5470" : "#e22718";
    const blueColor = isDark ? "#5b8def" : "#3b6ef5";
    const baseOpts = { responsive: true, maintainAspectRatio: false, plugins: { legend: { labels: { color: textColor, font: { family: "'Noto Sans KR', sans-serif" } } } } };

    // 1. 정답률 도넛
    const accCtx = document.getElementById("accChart");
    if (accCtx) {
      statsCharts.push(new Chart(accCtx, {
        type: "doughnut",
        data: {
          labels: ["정답", "오답"],
          datasets: [{ data: [data.s.totalCorrect, data.wrong], backgroundColor: [greenColor, dangerColor], borderWidth: 0 }]
        },
        options: { ...baseOpts, cutout: "70%", plugins: { legend: { position: "bottom", labels: { color: textColor } } } }
      }));
    }

    // 2. 숙지 진행도 도넛
    const masCtx = document.getElementById("masteryChart");
    if (masCtx) {
      const notMastered = data.srsTotal - data.mastered;
      statsCharts.push(new Chart(masCtx, {
        type: "doughnut",
        data: {
          labels: ["숙지", "학습 중"],
          datasets: [{ data: [data.mastered, notMastered], backgroundColor: [greenColor, amberColor], borderWidth: 0 }]
        },
        options: { ...baseOpts, cutout: "70%", plugins: { legend: { position: "bottom", labels: { color: textColor } } } }
      }));
    }

    // 3. 과목별 정답률 막대
    const subjCtx = document.getElementById("subjChart");
    if (subjCtx) {
      const labels = Object.keys(data.s.bySubject).map(k => subjectName(k).split("(")[0]);
      const correctData = Object.values(data.s.bySubject).map(v => v.correct);
      const wrongData = Object.values(data.s.bySubject).map(v => v.answered - v.correct);
      statsCharts.push(new Chart(subjCtx, {
        type: "bar",
        data: {
          labels,
          datasets: [
            { label: "정답", data: correctData, backgroundColor: greenColor, borderRadius: 4 },
            { label: "오답", data: wrongData, backgroundColor: dangerColor, borderRadius: 4 }
          ]
        },
        options: { ...baseOpts, scales: { x: { stacked: true, ticks: { color: textColor }, grid: { color: gridColor } }, y: { stacked: true, ticks: { color: mutedColor }, grid: { color: gridColor }, beginAtZero: true } } }
      }));
    }

    // 4. 약한 개념 레이더
    const conceptCtx = document.getElementById("conceptChart");
    if (conceptCtx && data.topConcepts.length >= 3) {
      statsCharts.push(new Chart(conceptCtx, {
        type: "radar",
        data: {
          labels: data.topConcepts.map(e => e.concept),
          datasets: [{
            label: "정답률 (%)",
            data: data.topConcepts.map(e => e.accuracy),
            backgroundColor: "rgba(0, 217, 126, 0.15)",
            borderColor: greenColor,
            pointBackgroundColor: data.topConcepts.map(e => e.accuracy < 70 ? dangerColor : greenColor),
            pointBorderColor: "#fff",
            pointRadius: 5,
            borderWidth: 2
          }]
        },
        options: { ...baseOpts, scales: { r: { beginAtZero: true, max: 100, ticks: { color: mutedColor, backdropColor: "transparent" }, grid: { color: gridColor }, angleLines: { color: gridColor }, pointLabels: { color: textColor, font: { size: 11 } } } } }
      }));
    }
  }

  function resetAllData() {
    openModal("데이터 초기화",
      `<p style="color:var(--danger);font-weight:600">경고!</p>
       <p style="margin-top:8px">모든 학습 기록, 복습 큐, 알람, 통계가 영구 삭제됩니다. 이 작업은 되돌릴 수 없습니다.</p>`,
      `<button class="btn btn-ghost" onclick="App.closeModal()">취소</button>
       <button class="btn btn-danger" onclick="App.confirmReset()">전체 삭제</button>`);
  }
  async function confirmReset() {
    localStorage.removeItem(STORAGE_KEY);
    state = loadState();
    closeModal();
    if (currentUser) {
      try {
        await sb().from("answer_records").delete().eq("user_id", currentUser.id);
        await sb().from("srs_records").delete().eq("user_id", currentUser.id);
        await sb().from("weak_concepts").delete().eq("user_id", currentUser.id);
      } catch (e) { console.warn("DB 초기화 실패", e); }
    }
    toast("초기화 완료","모든 데이터가 삭제되었습니다","success");
    navigate("home");
  }

  // ============================================================
  // 게시판 (CRUD)
  // ============================================================
  let boardMode = "list"; // "list" | "detail" | "form"
  let boardEditingId = null;

  function updateCharCount(inputId, counterId, max) {
    const input = $("#" + inputId);
    const counter = $("#" + counterId);
    if (!input || !counter) return;
    const len = input.value.length;
    counter.textContent = len + " / " + max;
    counter.classList.toggle("over", len >= max);
  }

  async function viewBoard() {
    boardMode = "list";
    content().innerHTML = `<div style="text-align:center;padding:40px;color:var(--text-muted)">불러오는 중...</div>`;
    try {
      const { data: posts, error } = await sb().from("posts")
        .select("*").order("created_at", { ascending: false }).limit(50);
      if (error) throw error;

      const postList = (posts && posts.length > 0)
        ? posts.map((p, i) => `
          <div class="board-item" onclick="App.viewPostDetail('${p.id}')">
            <div class="board-item-num">${posts.length - i}</div>
            <div class="board-item-body">
              <div class="board-item-title">${escapeHtml(p.title)} ${p.updated_at !== p.created_at ? '<span class="board-edited">수정됨</span>' : ''}</div>
              <div class="board-item-meta">${escapeHtml(p.author_name)} · ${fmtDate(new Date(p.created_at).getTime())} · 👁 ${p.views}</div>
            </div>
          </div>`).join("")
        : `<div class="empty-state"><div class="empty-state-icon">💬</div><h3>게시글이 없습니다</h3><p style="margin-top:8px">첫 번째 글을 작성해 보세요!</p></div>`;

      content().innerHTML = `
        <h1 class="page-title">💬 학습 게시판</h1>
        <p class="page-subtitle">합격 팁, 질문, 정보를 자유롭게 공유하세요.</p>
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px" data-aos="fade-down">
          <span style="color:var(--text-muted);font-size:0.88rem">총 ${posts?posts.length:0}개 게시글</span>
          ${currentUser
            ? `<button class="btn" onclick="App.viewPostForm()">✏️ 글쓰기</button>`
            : `<span style="color:var(--text-muted);font-size:0.82rem">글쓰기는 로그인 필요</span>`}
        </div>
        <div class="board-list">${postList}</div>`;
      if (window.AOS) AOS.refreshHard();
    } catch (e) {
      content().innerHTML = `<div class="empty-state"><div class="empty-state-icon">⚠️</div><h3>불러오기 실패</h3><p style="margin-top:8px">${escapeHtml(errMsg(e))}</p></div>`;
    }
  }

  async function viewPostDetail(id) {
    boardMode = "detail";
    content().innerHTML = `<div style="text-align:center;padding:40px;color:var(--text-muted)">불러오는 중...</div>`;
    try {
      const { data: post, error } = await sb().from("posts").select("*").eq("id", id).single();
      if (error) throw error;
      if (!post) { toast("없음", "존재하지 않는 게시글입니다.", "warn"); viewBoard(); return; }

      // 조회수 증가 (실패해도 무시)
      sb().from("posts").update({ views: post.views + 1 }).eq("id", id).then(() => {}, () => {});

      const isAuthor = currentUser && currentUser.id === post.user_id;
      const canManage = isAuthor || (currentUser && currentUser.isAdmin);
      const authorInitial = (post.author_name || "?")[0].toUpperCase();
      content().innerHTML = `
        <div class="board-detail">
          <button class="btn btn-ghost" onclick="App.viewBoard()" style="margin-bottom:16px">← 목록으로</button>
          <h1 class="board-detail-title">${escapeHtml(post.title)}</h1>
          <div class="board-detail-meta">
            <span class="auth-user-avatar" style="width:24px;height:24px;font-size:0.72rem">${escapeHtml(authorInitial)}</span>
            <span style="font-weight:600">${escapeHtml(post.author_name)}</span>
            <span style="color:var(--text-muted)">· ${fmtDate(new Date(post.created_at).getTime())} · 👁 ${post.views + 1}조회</span>
          </div>
          <div class="board-detail-content">${escapeHtml(post.content || "").replace(/\n/g, "<br>")}</div>
          ${canManage ? `
          <div class="board-detail-actions">
            <button class="btn btn-secondary" onclick="App.viewPostForm('${post.id}')">✏️ 수정</button>
            <button class="btn btn-danger" onclick="App.confirmDeletePost('${post.id}')">🗑️ 삭제</button>
            ${currentUser && currentUser.isAdmin && !isAuthor ? '<span style="color:var(--text-muted);font-size:0.82rem;align-self:center">🛡️ 관리자 권한</span>' : ""}
          </div>` : ""}
        </div>`;
    } catch (e) {
      console.error("viewPostDetail error:", e);
      content().innerHTML = `
        <button class="btn btn-ghost" onclick="App.viewBoard()" style="margin-bottom:16px">← 목록으로</button>
        <div class="empty-state">
          <div class="empty-state-icon">⚠️</div>
          <h3>게시글을 불러올 수 없습니다</h3>
          <p style="margin-top:8px;color:var(--text-muted);font-size:0.86rem">${escapeHtml(errMsg(e))}</p>
        </div>`;
    }
  }

  function viewPostForm(editId) {
    boardMode = "form";
    boardEditingId = editId || null;
    const isEdit = !!editId;

    content().innerHTML = `
      <button class="btn btn-ghost" onclick="App.viewBoard()" style="margin-bottom:16px">← 목록으로</button>
      <h1 class="page-title">${isEdit ? "✏️ 글 수정" : "✏️ 글쓰기"}</h1>
      <div class="board-form">
        <div class="form-group">
          <div style="display:flex;justify-content:space-between;align-items:baseline">
            <label class="form-label">제목</label>
            <span class="char-counter" id="titleCounter">0 / 100</span>
          </div>
          <input type="text" id="postTitle" placeholder="제목을 입력하세요 (최대 100자)" maxlength="100" oninput="App.updateCharCount('postTitle','titleCounter',100)">
        </div>
        <div class="form-group">
          <div style="display:flex;justify-content:space-between;align-items:baseline">
            <label class="form-label">내용</label>
            <span class="char-counter" id="contentCounter">0 / 5000</span>
          </div>
          <textarea id="postContent" rows="12" placeholder="내용을 입력하세요 (최대 5,000자)" maxlength="5000" style="resize:vertical;font-family:inherit" oninput="App.updateCharCount('postContent','contentCounter',5000)"></textarea>
        </div>
        <div style="display:flex;gap:10px">
          <button class="btn" id="postSubmit" onclick="App.submitPost()">${isEdit ? "수정하기" : "작성하기"}</button>
          <button class="btn btn-ghost" onclick="App.viewBoard()">취소</button>
        </div>
      </div>`;

    if (isEdit) {
      // 기존 내용 로드
      sb().from("posts").select("title,content").eq("id", editId).single().then(({ data, error }) => {
        if (!error && data) {
          $("#postTitle").value = data.title;
          $("#postContent").value = data.content;
          updateCharCount("postTitle", "titleCounter", 100);
          updateCharCount("postContent", "contentCounter", 5000);
        }
      });
    }
    setTimeout(() => { const t = $("#postTitle"); if (t) t.focus(); }, 100);
  }

  async function submitPost() {
    const title = ($("#postTitle")?.value || "").trim();
    const content_text = ($("#postContent")?.value || "").trim();
    if (!title) { toast("입력 필요", "제목을 입력하세요.", "warn"); return; }
    if (!content_text) { toast("입력 필요", "내용을 입력하세요.", "warn"); return; }
    if (!currentUser) { toast("로그인 필요", "글을 작성하려면 로그인하세요.", "warn"); showAuth(); return; }

    const btn = $("#postSubmit");
    if (btn) { btn.disabled = true; btn.textContent = "처리 중..."; }

    try {
      if (boardEditingId) {
        const { error } = await sb().from("posts").update({
          title, content: content_text, updated_at: new Date().toISOString()
        }).eq("id", boardEditingId);
        if (error) throw error;
        toast("수정 완료", "게시글이 수정되었습니다.", "success");
        viewPostDetail(boardEditingId);
      } else {
        const { data, error } = await sb().from("posts").insert({
          user_id: currentUser.id, author_name: currentUser.nickname || currentUser.email,
          title, content: content_text
        }).select("id").single();
        if (error) throw error;
        toast("작성 완료", "게시글이 등록되었습니다.", "success");
        viewPostDetail(data.id);
      }
      boardEditingId = null;
    } catch (e) {
      toast("오류", errMsg(e), "warn");
      if (btn) { btn.disabled = false; btn.textContent = boardEditingId ? "수정하기" : "작성하기"; }
    }
  }

  function confirmDeletePost(id) {
    openModal("게시글 삭제",
      `<p>정말로 이 게시글을 삭제하시겠습니까?</p><p style="margin-top:8px;color:var(--text-muted);font-size:0.88rem">삭제 후 되돌릴 수 없습니다.</p>`,
      `<button class="btn btn-ghost" onclick="App.closeModal()">취소</button>
       <button class="btn btn-danger" onclick="App.doDeletePost('${id}')">삭제</button>`);
  }

  async function doDeletePost(id) {
    closeModal();
    try {
      const { error } = await sb().from("posts").delete().eq("id", id);
      if (error) throw error;
      toast("삭제 완료", "게시글이 삭제되었습니다.", "success");
      viewBoard();
    } catch (e) {
      toast("오류", errMsg(e), "warn");
    }
  }
  // ============================================================
  function init() {
    applyTheme();

    // AOS 스크롤 애니메이션 초기화
    if (window.AOS) AOS.init({ duration: 600, easing: "ease-out-cubic", once: true, offset: 40 });

    // 모바일 메뉴 토글
    $("#menuToggle").addEventListener("click", () => $("#menu").classList.toggle("open"));

    // 모달 외부 클릭 시 닫기
    $("#modalOverlay").addEventListener("click", (e) => {
      if (e.target.id === "modalOverlay") closeModal();
    });
    $("#authOverlay").addEventListener("click", (e) => {
      if (e.target.id === "authOverlay") closeAuth();
    });

    // ESC 키
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { closeModal(); closeAuth(); }
    });

    // Supabase 인증 상태 감지
    sb().auth.onAuthStateChange(async (event, session) => {
      if (session && session.user) {
        currentUser = {
          id: session.user.id,
          email: session.user.email,
          nickname: session.user.user_metadata?.nickname || session.user.email?.split("@")[0] || "사용자",
          isAdmin: false
        };
        // 프로필에서 관리자 여부 조회
        try {
          const { data: profile } = await sb().from("profiles").select("is_admin,nickname").eq("id", currentUser.id).single();
          if (profile) {
            currentUser.isAdmin = !!profile.is_admin;
            if (profile.nickname) currentUser.nickname = profile.nickname;
          }
        } catch (e) {}
        updateAuthUI();
        if (event === "SIGNED_IN") {
          toast("로그인됨", `${currentUser.nickname}님 환영합니다!${currentUser.isAdmin ? " (관리자)" : ""}`, "success");
          await loadUserData();
          render(currentPage);
        }
      } else {
        currentUser = null;
        updateAuthUI();
      }
    });

    // 시작
    navigate("home");

    // 첫 접속 환영 폭죽
    setTimeout(() => {
      if (typeof confetti === "function") {
        const colors = ["#00d97e", "#ffb547", "#5b8def"];
        confetti({ particleCount: 60, spread: 60, origin: { y: 0.5 }, colors, scalar: 0.8, ticks: 120 });
        setTimeout(() => confetti({ particleCount: 40, spread: 80, origin: { y: 0.4 }, colors, scalar: 0.7, ticks: 100 }), 300);
      }
    }, 400);

    // 알람 체크 (30초마다)
    checkAlarms();
    setInterval(checkAlarms, 30000);

    // 알림 배너 주기적 업데이트
    updateAlertBar();
    setInterval(updateAlertBar, 30000);

    // 페이지 다시 보일 때 (다른 탭에서 돌아올 때) 체크
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) { checkAlarms(); updateAlertBar(); }
    });
  }

  // 공개 API
  return {
    init, navigate, toggleTheme, closeModal,
    selectNotesSubject, toggleNoteSection,
    toggleQuizSubject, setQuizDifficulty, setQuizCount, startQuiz, startQuickReview,
    answerQuiz, nextQuiz, quitQuiz, confirmQuit,
    addAlarm, toggleAlarm, deleteAlarm, requestNotifPermission, testAlarm,
    confirmClearAll, clearAllAlarms,
    resetAllData, confirmReset,
    showAuth, closeAuth, switchAuthTab, submitAuth, doLogout,
    viewBoard, viewPostDetail, viewPostForm, submitPost, confirmDeletePost, doDeletePost,
    updateCharCount
  };
})();

// 데이터 로드 후 시작
window.App = App;
document.addEventListener("DOMContentLoaded", App.init);
