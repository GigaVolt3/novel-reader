const $app = document.getElementById("app");

const state = {
  novel: null,
  toc: [],
  statuses: {},
  chapter: null,
  mode: localStorage.getItem("nr.mode") || "en",
  size: Number(localStorage.getItem("nr.size") || 19),
  width: Number(localStorage.getItem("nr.width") || 720),
  leading: localStorage.getItem("nr.leading") || "1.78",
  theme: localStorage.getItem("nr.theme") || "light",
  font: localStorage.getItem("nr.font") || "serif",
  provider: localStorage.getItem("nr.provider") || "groq",
  prefetch: Number(localStorage.getItem("nr.prefetch") ?? 2),
  batchCount: Number(localStorage.getItem("nr.batchCount") ?? 5),
  timer: null,
  models: [],
  health: null,
  search: {
    active: false,
    query: "",
    data: null,
    page: 1,
    hasMore: true,
    isLoadingMore: false,
    allResults: [],
  },
};

document.documentElement.dataset.theme = state.theme;
document.documentElement.dataset.font = state.font;
document.documentElement.style.setProperty("--size", `${state.size}px`);
document.documentElement.style.setProperty("--page-width", `${state.width}px`);
document.documentElement.style.setProperty("--leading", state.leading);

function getBrowserOpenRouterKey() {
  return localStorage.getItem("nr.or_key") || "";
}

function getBrowserGroqKey() {
  return localStorage.getItem("nr.groq_key") || "";
}

const api = async (path, options = {}) => {
  const orKey = getBrowserOpenRouterKey();
  const groqKey = getBrowserGroqKey();
  const headers = { "content-type": "application/json", ...(options.headers || {}) };
  if (orKey) headers["x-openrouter-key"] = orKey;
  if (groqKey) headers["x-groq-key"] = groqKey;
  if (state.provider) headers["x-provider"] = state.provider;

  const controller = new AbortController();
  const timeoutMs = options.timeout || 30000;
  const timeoutTimer = setTimeout(() => controller.abort(new Error("Request timed out")), timeoutMs);

  try {
    const res = await fetch(path, {
      cache: "no-store",
      signal: controller.signal,
      headers,
      ...options,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  } finally {
    clearTimeout(timeoutTimer);
  }
};

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

let toastTimer;
function toast(message, isError = false) {
  let el = document.querySelector(".toast");
  if (!el) {
    el = document.createElement("div");
    el.className = "toast";
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.classList.toggle("error", isError);
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 4200);
}

function timeAgo(timestamp) {
  if (!timestamp) return "";
  const sec = Math.floor((Date.now() - timestamp) / 1000);
  if (sec < 60) return "Just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString();
}

function copyChapterText() {
  if (!state.chapter) return toast("No chapter loaded", true);
  const title = formatChapterTitle(state.chapter);
  const paras = (state.chapter.paragraphs || [])
    .map((p) => p.en || p.zh)
    .filter(Boolean);
  const text = `${title}\n\n${paras.join("\n\n")}`;
  navigator.clipboard.writeText(text).then(
    () => toast("Chapter text copied to clipboard! 📋"),
    () => toast("Failed to copy text", true),
  );
}

function exportChapterTxt() {
  if (!state.chapter) return toast("No chapter loaded", true);
  const title = formatChapterTitle(state.chapter);
  const novelTitle = state.novel?.titleEn || state.novel?.title || "Novel";
  const paras = (state.chapter.paragraphs || [])
    .map((p) => p.en || p.zh)
    .filter(Boolean);
  const text = `${novelTitle}\n${title}\n\n${paras.join("\n\n")}`;
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${novelTitle} - Ch ${state.chapter.index}.txt`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast("Chapter downloaded as .txt ✓");
}

/* ------------------------------------------------------------------ router */

function safeDecode(str) {
  try {
    return decodeURIComponent(str);
  } catch {
    return str;
  }
}

function route() {
  stopPolling();
  const hash = location.hash.replace(/^#\/?/, "");
  const parts = hash.split("/").filter(Boolean);

  // 0. Beta Smart Search: #/search or #/search?q=...
  if (parts[0] && parts[0].startsWith("search")) {
    const rawQuery = parts[0].includes("?q=") ? parts[0].split("?q=")[1] : "";
    const query = rawQuery ? decodeURIComponent(rawQuery) : (state.search?.query || "");
    return openShelf(true, query);
  }

  // 1. Chapter Reader: #/reader/:slug/:chapter OR #/n/:slug/:chapter
  if ((parts[0] === "reader" || parts[0] === "n") && parts[1] && parts[2]) {
    return openReader(safeDecode(parts[1]), Number(parts[2]) || 1);
  }

  // 2. Novel Details: #/novel/:slug OR #/n/:slug (without chapter number)
  if ((parts[0] === "novel" || parts[0] === "n") && parts[1]) {
    return openNovelDetails(safeDecode(parts[1]));
  }

  // 3. Home / Shelf: #/
  return openShelf(false);
}

window.addEventListener("hashchange", route);

/* ------------------------------------------------------------- recommendations */

function translateTag(tag) {
  if (!tag) return "";
  const t = String(tag).trim();

  // Word count pattern e.g. 378.92万字, 50万字, 12000字
  const wordMatch = t.match(/^(\d+(?:\.\d+)?)\s*万字?$/);
  if (wordMatch) {
    const wan = parseFloat(wordMatch[1]);
    if (wan >= 100) {
      return `${(wan / 100).toFixed(2)}M words`;
    }
    return `${Math.round(wan * 10)}K words`;
  }
  const rawWords = t.match(/^(\d+)\s*字$/);
  if (rawWords) {
    const num = parseInt(rawWords[1], 10);
    return num >= 1000000 ? `${(num / 1000000).toFixed(2)}M words` : `${Math.round(num / 1000)}K words`;
  }

  const map = {
    "连载": "Ongoing",
    "完本": "Completed",
    "完结": "Completed",
    "全本": "Completed",
    "玄幻魔法": "Fantasy",
    "东方玄幻": "Eastern Fantasy",
    "异界大陆": "Otherworld Fantasy",
    "传统玄幻": "Traditional Fantasy",
    "仙侠": "Cultivation",
    "修仙": "Cultivation",
    "修真": "Cultivation",
    "古典仙侠": "Cultivation",
    "幻想修仙": "Cultivation",
    "现代修真": "Modern Cultivation",
    "玄幻": "Fantasy",
    "奇幻": "Western Fantasy",
    "都市": "Urban",
    "都市生活": "Urban Life",
    "都市异能": "Urban Supernatural",
    "都市重生": "Urban Rebirth",
    "科幻": "Sci-Fi",
    "科幻未来": "Sci-Fi",
    "轻小说": "Light Novel",
    "历史": "Historical",
    "历史争霸": "Historical",
    "架空历史": "Alternate History",
    "军事": "Military",
    "武侠": "Martial Arts",
    "游戏": "Gaming",
    "网游": "Gaming",
    "游戏异界": "LitRPG / Gaming",
    "虚拟网游": "Gaming",
    "悬疑": "Mystery",
    "恐怖": "Horror",
    "灵异": "Supernatural",
    "同人": "Fanfiction",
    "短篇": "Short Story",
    "末世": "Apocalyptic",
    "末日": "Apocalyptic",
    "系统": "System",
    "穿越": "Transmigration",
    "重生": "Rebirth",
    "种田": "Farming",
    "无敌": "Invincible",
    "日常": "Daily Life",
    "恋爱": "Romance",
    "青春": "Youth",
    "热血": "Action",
    "争霸": "Kingdom Building",
    "后宫": "Harem",
    "单女主": "Single Heroine",
    "多女主": "Harem",
    "无女主": "No Romance",
    "搞笑": "Comedy",
    "爽文": "Power Fantasy",
    "二次元": "Anime",
    "魔法": "Magic",
  };

  if (map[t]) return map[t];
  if (t.includes("玄幻") || t.includes("魔法")) return "Fantasy";
  if (t.includes("仙侠") || t.includes("修仙") || t.includes("修真")) return "Cultivation";
  if (t.includes("科幻")) return "Sci-Fi";
  if (t.includes("都市")) return "Urban";
  if (t.includes("历史")) return "Historical";
  if (t.includes("武侠")) return "Martial Arts";
  if (t.includes("游戏") || t.includes("网游")) return "Gaming";
  if (t.includes("悬疑") || t.includes("恐怖")) return "Mystery";
  if (t.includes("穿越") || t.includes("重生")) return "Rebirth";
  if (t.includes("连载")) return "Ongoing";
  if (t.includes("完结") || t.includes("完本")) return "Completed";

  return t;
}

function renderRecCards(recs, limit = 6) {
  if (!Array.isArray(recs) || !recs.length) return "";
  return recs
    .slice(0, limit)
    .map((r) => {
      const title = r.titleEn || r.title || "Untitled";
      const titleZh = r.titleZh && r.titleZh !== title ? r.titleZh : null;
      const author = r.author && r.author !== "Unknown" ? r.author : null;
      const cover = r.cover || r.coverUrl;
      const hasAction = r.inLibrary || r.sourceUrl;
      const synopsis = (r.synopsisEn || r.synopsis || "").trim();

      return `
      <div class="rec-card ${r.inLibrary ? 'rec-in-lib' : 'rec-from-web'}"
           data-rec-card="true"
           data-has-popover="${synopsis ? 'true' : 'false'}"
           data-popover-title="${esc(title)}"
           data-popover-zh="${titleZh ? esc(titleZh) : ''}"
           data-popover-author="${author ? esc(author) : ''}"
           data-popover-desc="${esc(synopsis)}"
           data-rec-slug="${r.slug ? esc(r.slug) : ''}"
           data-rec-url="${r.sourceUrl ? esc(r.sourceUrl) : ''}"
           data-rec-title="${esc(title)}">
        <div class="rec-card-cover-wrap">
          ${cover ? `<img class="rec-card-cover" src="${esc(cover)}" alt="${esc(title)}" referrerpolicy="no-referrer" onerror="this.style.display='none';this.nextElementSibling.style.display='flex';" />` : ''}
          <div class="rec-card-cover-fallback" style="${cover ? 'display:none' : ''}">📖</div>
        </div>
        <div class="rec-card-content">
          <div class="rec-card-title" title="${esc(title)}">${esc(title)}</div>
          ${titleZh ? `<div class="rec-card-orig" title="${esc(titleZh)}">${esc(titleZh)}</div>` : ''}
          ${author ? `<div class="rec-card-author">✍️ ${esc(author)}</div>` : ''}
          <div class="rec-tags">
            ${(r.tags || []).slice(0, 3).map((t) => `<span class="rec-tag-pill">${esc(translateTag(t))}</span>`).join("")}
            ${r.inLibrary ? `<span class="rec-tag-pill rec-pill-lib">✓ In Library</span>` : (r.sourceUrl ? `<span class="rec-tag-pill rec-pill-web">🌐 Source Site</span>` : '')}
          </div>
          ${synopsis ? `<div class="rec-card-synopsis">${esc(synopsis)}</div>` : ''}
          ${hasAction ? `
            <div class="rec-card-footer">
              <button class="rec-action-btn ${r.inLibrary ? 'rec-btn-lib' : 'rec-btn-view'}"
                      data-rec-action="view"
                      data-rec-slug="${r.slug ? esc(r.slug) : ''}"
                      data-rec-url="${r.sourceUrl ? esc(r.sourceUrl) : ''}"
                      data-rec-title="${esc(title)}">
                ${r.inLibrary ? 'Open Novel →' : 'View Novel →'}
              </button>
            </div>
          ` : ''}
        </div>
      </div>`;
    })
    .join("");
}

function bindRecCardEvents(container) {
  if (!container) return;
  container.querySelectorAll("[data-rec-card]").forEach((card) => {
    card.onclick = async (e) => {
      const slug = card.dataset.recSlug;
      const url = card.dataset.recUrl;
      const title = card.dataset.recTitle || "novel";

      if (slug) {
        location.hash = `#/novel/${encodeURIComponent(slug)}`;
        return;
      }

      if (url) {
        const btn = card.querySelector(".rec-action-btn");
        if (btn && btn.disabled) return;
        if (btn) {
          btn.disabled = true;
          btn.innerHTML = `<span class="spinner" style="display:inline-block;width:11px;height:11px;margin-right:4px"></span> Loading…`;
        }
        card.classList.add("rec-card-loading");
        toast(`Opening novel details for "${title}"…`);

        try {
          const res = await api("/api/import", {
            method: "POST",
            body: { url, inLibrary: false },
          });
          location.hash = `#/novel/${encodeURIComponent(res.novel.slug)}`;
        } catch (err) {
          toast(`Could not open novel: ${err.message}`, true);
          if (btn) {
            btn.disabled = false;
            btn.textContent = "View Novel →";
          }
          card.classList.remove("rec-card-loading");
        }
      }
    };
  });
}

function initSynopsisPopover() {
  let popover = document.getElementById("novel-synopsis-popover");
  if (!popover) {
    popover = document.createElement("div");
    popover.id = "novel-synopsis-popover";
    popover.className = "novel-synopsis-popover";
    popover.innerHTML = `
      <div class="popover-topline">
        <div class="popover-title-text" id="popover-title"></div>
        <div class="popover-zh-text" id="popover-zh"></div>
      </div>
      <div class="popover-meta-row" id="popover-meta"></div>
      <div class="popover-desc-text" id="popover-desc"></div>
    `;
    document.body.appendChild(popover);
  }

  let hoverTimeout = null;
  let activeCard = null;

  const hidePopover = () => {
    clearTimeout(hoverTimeout);
    activeCard = null;
    popover.classList.remove("visible");
  };

  const showForCard = (card) => {
    if (!card) return;
    const title = card.dataset.popoverTitle || "";
    const zh = card.dataset.popoverZh || "";
    const author = card.dataset.popoverAuthor || "";
    const desc = (card.dataset.popoverDesc || "").trim();

    if (!desc || desc === "No synopsis available.") {
      hidePopover();
      return;
    }

    const titleEl = document.getElementById("popover-title");
    const zhEl = document.getElementById("popover-zh");
    const metaEl = document.getElementById("popover-meta");
    const descEl = document.getElementById("popover-desc");

    if (titleEl) titleEl.textContent = title;
    if (zhEl) {
      if (zh && zh !== title) {
        zhEl.textContent = zh;
        zhEl.style.display = "block";
      } else {
        zhEl.style.display = "none";
      }
    }

    if (metaEl) {
      if (author) {
        metaEl.innerHTML = `<span>✍️ ${esc(author)}</span>`;
        metaEl.style.display = "flex";
      } else {
        metaEl.style.display = "none";
      }
    }

    if (descEl) descEl.textContent = desc;

    const rect = card.getBoundingClientRect();
    const popWidth = Math.min(420, window.innerWidth - 24);
    let left = rect.right + 12;
    let top = rect.top;

    // Boundary detection
    if (left + popWidth > window.innerWidth - 12) {
      left = rect.left - popWidth - 12;
    }
    if (left < 10) {
      left = Math.max(10, Math.floor((window.innerWidth - popWidth) / 2));
      top = Math.max(10, rect.bottom + 8);
    }

    const popHeight = 260;
    if (top + popHeight > window.innerHeight - 10) {
      top = Math.max(10, window.innerHeight - popHeight - 10);
    }

    popover.style.left = `${Math.round(left)}px`;
    popover.style.top = `${Math.round(top)}px`;
    popover.classList.add("visible");
  };

  document.body.addEventListener("mouseover", (e) => {
    const card = e.target.closest('[data-has-popover="true"]');
    if (!card) return;
    if (card === activeCard) return;
    activeCard = card;
    clearTimeout(hoverTimeout);
    hoverTimeout = setTimeout(() => {
      if (activeCard === card) {
        showForCard(card);
      }
    }, 180);
  });

  document.body.addEventListener("mouseout", (e) => {
    const card = e.target.closest('[data-has-popover="true"]');
    if (!card) return;
    const related = e.relatedTarget;
    if (related && card.contains(related)) return;
    hidePopover();
  });

  window.addEventListener("scroll", hidePopover, { passive: true });
  document.body.addEventListener("click", hidePopover);
}

function showSmartSearchHelpDialog() {
  let dialog = document.getElementById("smart-search-help-dialog");
  if (!dialog) {
    dialog = document.createElement("div");
    dialog.id = "smart-search-help-dialog";
    dialog.className = "smart-search-modal-backdrop";
    document.body.appendChild(dialog);
  }
  dialog.innerHTML = `
    <div class="smart-search-dialog" style="max-width:540px">
      <div class="smart-search-header">
        <div class="smart-search-title-wrap">
          <span class="smart-search-dialog-icon">🔍</span>
          <h3>About Smart Search <span class="smart-search-beta">BETA</span></h3>
        </div>
        <button class="smart-search-close-btn" id="help-dialog-close">✕</button>
      </div>
      <div style="padding:14px 0;line-height:1.6;font-size:14px;color:var(--ink)">
        <p style="margin-bottom:14px">
          <strong>Smart Search (Beta)</strong> searches for novels across websites you have visited before. It navigates their search engines using smart alternate spellings and translations (via Google &amp; AI) in case names or translations don't match.
        </p>
        <div style="background:var(--bg-soft);border:1px solid var(--line);border-radius:12px;padding:12px 16px;margin-bottom:16px;font-size:13px;display:flex;flex-direction:column;gap:8px">
          <div><strong>⚡ 1. Direct Google Translation:</strong> Instantly converts your English query or typo into Chinese (&lt;200ms) and queries visited sites immediately.</div>
          <div><strong>🧠 2. AI Alternate Spellings (1 Single Prompt):</strong> In the background, AI thinks of up to 5 alternative Chinese titles, tropes, and spellings to search visited sites one by one.</div>
          <div><strong>🌐 3. Multi-Site Scrape &amp; Batch Translation:</strong> Pulls real novels from visited domains (e.g. <code>m.1qxs.com</code>, <code>m.ilwxs.com</code>) and batch-translates all titles &amp; synopses to English.</div>
        </div>
        <button class="btn-primary-smart" id="help-dialog-gotit" style="width:100%">Got it!</button>
      </div>
    </div>
  `;
  dialog.classList.add("open");
  const close = () => dialog.classList.remove("open");
  const closeBtn = document.getElementById("help-dialog-close");
  const gotItBtn = document.getElementById("help-dialog-gotit");
  if (closeBtn) closeBtn.onclick = close;
  if (gotItBtn) gotItBtn.onclick = close;
  dialog.onclick = (e) => { if (e.target === dialog) close(); };
}

function openSmartSearchModal(initialQuery = "") {
  const betaCard = document.getElementById("shelf-search-beta");
  if (betaCard) {
    const btn = document.getElementById("btn-smart-search");
    if (btn) btn.click();
    const largeInput = document.getElementById("beta-search-large-input");
    if (largeInput) {
      if (initialQuery) {
        largeInput.value = initialQuery;
        document.getElementById("beta-search-form")?.dispatchEvent(new Event("submit"));
      } else {
        largeInput.focus();
      }
    }
    return;
  }
  location.hash = initialQuery ? `#/search?q=${encodeURIComponent(initialQuery)}` : `#/search`;
}

/* ------------------------------------------------------------------- shelf */

async function openShelf(startInBeta = false, initialQuery = "") {
  state.novel = null;
  state.chapter = null;
  document.title = "Novel Reader";

  const showBeta = Boolean(startInBeta || (state.search?.active && location.hash.startsWith("#/search")));
  const activeQuery = initialQuery || state.search?.query || "";
  if (startInBeta) {
    if (!state.search) state.search = { active: true, query: "", data: null };
    state.search.active = true;
    if (initialQuery) state.search.query = initialQuery;
  }

  $app.innerHTML = `
    <main class="shelf">
      <div class="brand"><h1>Novel Reader</h1><span>zh → en</span></div>
      <p class="tagline">Link in, translated out. Ultra-fast AI translation powered by Groq &amp; OpenRouter.</p>
      
      <!-- Unified Search Area: Standard URL Input or Enlarged Smart Search Beta -->
      <div id="shelf-search-wrapper" style="width:100%;max-width:760px;margin:0 auto 24px">
        <!-- 1. Standard URL / Library Search Bar -->
        <div id="shelf-search-standard" style="${showBeta ? 'display:none' : 'display:block'}">
          <form class="import shelf-unified-search" id="shelf-search-form">
            <input id="shelf-search-input" type="text" placeholder="Paste Chinese novel URL to add, or search your library..." autocomplete="off" />
            <button class="primary" type="submit" id="shelf-search-btn">Add / Find</button>
            <div class="smart-search-btn-group">
              <button class="btn-smart-search" type="button" id="btn-smart-search" title="Click to enlarge Smart Search (Beta): Search visited sites with Google & AI translations">
                <span class="smart-search-icon">🔍</span>
                <span class="smart-search-beta">BETA</span>
              </button>
              <button class="btn-smart-search-help" type="button" id="btn-smart-search-help" title="What is Smart Search Beta?">?</button>
            </div>
          </form>
          <p class="hint" id="hint">Enter a novel link or search library titles. Click 🔍 BETA to expand smart search across visited sites.</p>
        </div>

        <!-- 2. Enlarged Beta Smart Search Card (Replaces URL bar when clicked) -->
        <div id="shelf-search-beta" class="beta-search-enlarged-card" style="${showBeta ? 'display:block' : 'display:none'}">
          <div class="beta-search-topline">
            <div class="beta-search-badge-title">
              <span style="font-size:24px">🔍</span>
              <div>
                <h3 style="margin:0;font-size:18px;display:flex;align-items:center;gap:8px">
                  Smart Novel Search <span class="smart-search-beta">BETA</span>
                </h3>
                <span style="font-size:12.5px;color:var(--ink-soft)">Searches visited novel sites with Google GTX + AI alternate spellings</span>
              </div>
            </div>
            <div style="display:flex;gap:8px;align-items:center">
              <button class="btn-secondary" id="btn-beta-how" type="button" style="font-size:12.5px;padding:6px 12px">❓ How it works</button>
              <button class="btn-secondary beta-close-btn" id="btn-beta-back-standard" type="button" title="Switch back to URL search">✕ Switch to URL</button>
            </div>
          </div>

          <form id="beta-search-form" class="beta-search-input-wrap-enlarged">
            <input type="text" id="beta-search-large-input" class="beta-search-input-large" placeholder="Enter novel name in English or Chinese (e.g. Salted fish king, 八百影密卫)..." value="${esc(activeQuery)}" autocomplete="off" />
            <button type="submit" id="beta-search-submit-btn" class="btn-primary-smart beta-search-submit-btn">🔍 Search</button>
          </form>
          <p class="beta-search-guide">
            ⚡ <strong>Instant Multi-Site Search:</strong> Google GTX translates your query in &lt;100ms. In parallel, AI suggests up to 5 spelling variants and searches all visited novel sites simultaneously.
          </p>

          <!-- Status Bar for Translation & AI Variants -->
          <div id="beta-search-status-bar" style="display:none"></div>
        </div>
      </div>

      <!-- Live Beta Search Results Container (in-shelf) -->
      <div id="beta-search-results-container" class="beta-search-results-wrap" style="display:none"></div>

      <!-- Continue Reading Hero Section -->
      <div id="hero-resume-container"></div>

      <!-- Library Section -->
      <div class="shelf-head">
        <h2>Your Library</h2>
        <button class="history-pill-btn" id="open-history-btn" title="View Reading History (H)">🕒 Reading History</button>
      </div>
      <div class="cards" id="cards"><div class="empty">Loading library…</div></div>

      <!-- Home Recommendations Section -->
      <div id="home-recommendations-container"></div>
    </main>

    <div class="scrim" id="scrim"></div>
    <aside class="drawer" id="drawer">
      <header>
        <h3 id="drawer-title">History</h3>
        <button id="drawer-close">✕</button>
      </header>
      <div id="drawer-body"></div>
    </aside>`;

  document.getElementById("open-history-btn").onclick = () => openDrawer("history");
  document.getElementById("scrim").onclick = closeDrawer;
  document.getElementById("drawer-close").onclick = closeDrawer;

  const searchInput = document.getElementById("shelf-search-input");
  const searchBtn = document.getElementById("shelf-search-btn");
  const hint = document.getElementById("hint");

  // Render a single smart search card HTML
  const renderSmartSearchCardHtml = (r, i) => {
    const desc = (r.synopsisEn || r.synopsis || "").trim();
    const title = r.titleEn || r.title || "Untitled";
    const titleZh = r.titleZh && r.titleZh !== title ? r.titleZh : "";
    const author = r.author && r.author !== "Unknown" ? r.author : "";

    return `
      <div class="smart-search-card"
           data-idx="${i}"
           data-has-popover="${desc ? 'true' : 'false'}"
           data-popover-title="${esc(title)}"
           data-popover-zh="${esc(titleZh)}"
           data-popover-author="${esc(author)}"
           data-popover-desc="${esc(desc)}">
        <div class="smart-search-card-cover">
          ${r.coverUrl ? `<img src="${esc(r.coverUrl)}" alt="${esc(title)}" onerror="this.style.display='none';this.nextElementSibling.style.display='flex';" />` : ""}
          <div class="card-cover-fallback" style="${r.coverUrl ? 'display:none' : 'display:flex'}">${esc((title || "📖").slice(0, 1))}</div>
        </div>
        <div class="smart-search-card-info">
          <div class="smart-search-card-title-line">
            <h4 class="smart-search-card-title">${esc(title)}</h4>
            ${r.inLibrary ? `<span class="rec-tag-pill rec-pill-lib">✓ In Library</span>` : `<span class="rec-tag-pill rec-pill-web">🌐 ${esc(r.siteDomain || "Source")}</span>`}
          </div>
          ${titleZh ? `<div class="smart-search-card-zh">${esc(titleZh)}</div>` : ""}
          <div class="smart-search-card-author">
            <span>✍️ ${esc(author || "Unknown")}</span>
            ${r.matchedVia ? `<span class="matched-badge">Matched: "${esc(r.matchedVia)}"</span>` : ""}
          </div>
          ${desc ? `<p class="smart-search-card-desc">${esc(desc)}</p>` : ""}
          <div class="smart-search-card-footer">
            <button class="btn-primary-smart smart-search-open-btn" data-url="${esc(r.sourceUrl)}" data-title="${esc(title)}" data-slug="${esc(r.slug || "")}">
              ${r.inLibrary ? "View in Library →" : "▶ Read / View Novel"}
            </button>
            <a href="${esc(r.sourceUrl)}" target="_blank" rel="noopener" class="smart-search-src-link" title="Open source website">🌐 Source ↗</a>
          </div>
        </div>
      </div>
    `;
  };

  // Bind click events on card action buttons
  const bindSmartSearchCardEvents = (container) => {
    if (!container) return;
    container.querySelectorAll(".smart-search-open-btn:not([data-bound])").forEach((btn) => {
      btn.dataset.bound = "true";
      btn.onclick = async () => {
        const u = btn.dataset.url;
        const s = btn.dataset.slug;
        const t = btn.dataset.title;
        if (s) {
          location.hash = `#/novel/${encodeURIComponent(s)}`;
          return;
        }
        if (u) {
          btn.disabled = true;
          btn.innerHTML = `<span class="spinner" style="display:inline-block;width:11px;height:11px;margin-right:4px"></span> Opening…`;
          toast(`Opening novel details for "${t}"…`);
          try {
            const res = await api("/api/import", {
              method: "POST",
              body: { url: u, inLibrary: false },
            });
            location.hash = `#/novel/${encodeURIComponent(res.novel.slug)}`;
          } catch (err) {
            toast(`Could not open novel: ${err.message}`, true);
            btn.disabled = false;
            btn.textContent = "▶ Read / View Novel";
          }
        }
      };
    });
  };

  // Update pagination area (Load More button, loader, or end banner)
  const updatePaginationWrap = () => {
    const wrap = document.getElementById("smart-search-pagination-wrap");
    if (!wrap) return;

    if (state.search.isLoadingMore) {
      wrap.innerHTML = `
        <div class="search-scroll-loader">
          <span class="spinner"></span>
          <span>Crawling next page across novel websites &amp; translating…</span>
        </div>
      `;
    } else if (state.search.hasMore) {
      wrap.innerHTML = `
        <button class="btn-load-more-novels" id="btn-load-more-novels">
          ⚡ Load More Novels (Page ${state.search.page + 1})
        </button>
      `;
      const btn = document.getElementById("btn-load-more-novels");
      if (btn) {
        btn.onclick = () => loadMoreBetaResults();
      }
    } else {
      wrap.innerHTML = `
        <div class="search-end-banner">
          ✓ All matching novels crawled across visited websites (${(state.search.allResults || []).length} total)
        </div>
      `;
    }
  };

  // Load More / Deeper page crawler
  const loadMoreBetaResults = async () => {
    if (state.search.isLoadingMore || !state.search.hasMore || !state.search.query) return;
    state.search.isLoadingMore = true;
    updatePaginationWrap();

    const nextPage = (state.search.page || 1) + 1;
    const excludeUrls = (state.search.allResults || []).map((r) => r.sourceUrl).filter(Boolean);

    try {
      const data = await api("/api/smart-search", {
        method: "POST",
        body: {
          query: state.search.query,
          page: nextPage,
          maxResults: 25,
          excludeUrls: excludeUrls.slice(-150),
        },
        timeout: 45000,
      });

      const newItems = data.results || [];
      state.search.page = nextPage;
      state.search.hasMore = data.hasMore !== false && newItems.length > 0;

      if (newItems.length > 0) {
        const startIndex = state.search.allResults.length;
        state.search.allResults = state.search.allResults.concat(newItems);

        const grid = document.querySelector(".smart-search-grid");
        if (grid) {
          const html = newItems.map((r, idx) => renderSmartSearchCardHtml(r, startIndex + idx)).join("");
          grid.insertAdjacentHTML("beforeend", html);
          bindSmartSearchCardEvents(grid);
        }

        const countEl = document.getElementById("smart-search-results-count");
        if (countEl) {
          const currentQuery = state.search.query || "";
          countEl.textContent = `Results for "${currentQuery}" (${state.search.allResults.length} novels · Page ${state.search.page})`;
        }
      } else {
        state.search.hasMore = false;
      }
    } catch (err) {
      console.error("Load more search error:", err);
      toast(`Failed to load more results: ${err.message}`, true);
    } finally {
      state.search.isLoadingMore = false;
      updatePaginationWrap();
    }
  };

  // Infinite scroll listener for search
  const onWindowScrollSearch = () => {
    if (!state.search.active || !state.search.hasMore || state.search.isLoadingMore) return;
    const scrollBottom = window.innerHeight + window.scrollY;
    const docHeight = document.documentElement.offsetHeight || document.body.offsetHeight;
    if (docHeight - scrollBottom < 380) {
      loadMoreBetaResults();
    }
  };

  if (window._nrSearchScrollHandler) {
    window.removeEventListener("scroll", window._nrSearchScrollHandler);
  }
  window._nrSearchScrollHandler = onWindowScrollSearch;
  window.addEventListener("scroll", onWindowScrollSearch, { passive: true });

  // Render Beta Search Results function
  const renderBetaResults = (data, q) => {
    const statusBar = document.getElementById("beta-search-status-bar");
    const resultsContainer = document.getElementById("beta-search-results-container");
    if (!statusBar || !resultsContainer) return;

    const isSameQuery = state.search.query === q;
    state.search.query = q;
    state.search.data = data;
    state.search.isLoadingMore = false;

    if (!isSameQuery || !state.search.allResults || !state.search.allResults.length) {
      state.search.page = data.page || 1;
      state.search.hasMore = data.hasMore !== false;
      state.search.allResults = data.results || [];
    }

    const variantsHtml = (data.aiVariants || [])
      .map((v) => `<span class="variant-pill" title="AI alternate candidate">${esc(v)}</span>`)
      .join("");

    statusBar.style.display = "block";
    statusBar.innerHTML = `
      <div class="smart-search-summary-bar">
        <div class="summary-line">
          <strong>⚡ Google Translated:</strong>
          <span class="google-zh-pill">${esc(data.googleZh || "—")}</span>
        </div>
        ${data.aiVariants?.length ? `
          <div class="summary-line">
            <strong>🧠 AI Alternate Spellings (1 Call):</strong>
            <div class="variants-wrap">${variantsHtml}</div>
          </div>
        ` : ""}
        <div class="summary-line meta-sites">
          <span>🌐 Sites checked: ${(data.sitesSearched || []).map(s => {
            try { return esc(new URL(s).hostname); } catch { return esc(s); }
          }).join(", ")}</span>
          <span>· Found <strong>${data.totalResults || 0}</strong> matching novels</span>
        </div>
      </div>
    `;

    resultsContainer.style.display = "block";
    if (!state.search.allResults.length) {
      resultsContainer.innerHTML = `
        <div class="smart-search-empty">
          <p>No matching novels found across visited sites for "${esc(q)}".</p>
          <p style="font-size:12.5px;color:var(--ink-soft);margin-top:6px">Try a shorter keyword, character name, or paste the novel URL directly.</p>
        </div>
      `;
      return;
    }

    resultsContainer.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
        <h3 id="smart-search-results-count" style="margin:0;font-size:16px;color:var(--ink)">
          Results for "${esc(q)}" (${state.search.allResults.length} novels · Page ${state.search.page})
        </h3>
        <span style="font-size:12px;color:var(--ink-soft)">💡 Hover any card for full description</span>
      </div>
      <div class="smart-search-grid">
        ${state.search.allResults.map((r, i) => renderSmartSearchCardHtml(r, i)).join("")}
      </div>
      <div id="smart-search-pagination-wrap" class="smart-search-pagination-wrap"></div>
    `;

    bindSmartSearchCardEvents(resultsContainer);
    updatePaginationWrap();
  };

  // Execute Beta Search
  const executeBetaSearch = async (q) => {
    if (!q) return;
    const statusBar = document.getElementById("beta-search-status-bar");
    const resultsContainer = document.getElementById("beta-search-results-container");
    const submitBtn = document.getElementById("beta-search-submit-btn");

    state.search.query = q;
    state.search.page = 1;
    state.search.hasMore = true;
    state.search.isLoadingMore = false;
    state.search.allResults = [];

    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.innerHTML = `<span class="spinner" style="display:inline-block;width:12px;height:12px;margin-right:6px"></span> Searching…`;
    }

    if (statusBar) {
      statusBar.style.display = "block";
      statusBar.innerHTML = `
        <div class="smart-search-summary-bar">
          <div class="summary-line">
            <strong>⚡ Translating &amp; Thinking Alternate Spellings:</strong>
            <span>Google GTX + AI searching visited sites for "${esc(q)}"…</span>
          </div>
        </div>
      `;
    }

    if (resultsContainer) {
      resultsContainer.style.display = "block";
      resultsContainer.innerHTML = `
        <div class="smart-search-loading-list">
          <div class="skeleton" style="height:90px;border-radius:12px;margin-bottom:12px"></div>
          <div class="skeleton" style="height:90px;border-radius:12px;margin-bottom:12px"></div>
          <div class="skeleton" style="height:90px;border-radius:12px"></div>
        </div>
      `;
    }

    try {
      const data = await api("/api/smart-search", {
        method: "POST",
        body: { query: q, page: 1, maxResults: 25 },
        timeout: 45000,
      });

      state.search.query = q;
      state.search.data = data;
      state.search.active = true;
      state.search.page = data.page || 1;
      state.search.hasMore = data.hasMore !== false;
      state.search.allResults = data.results || [];

      renderBetaResults(data, q);
    } catch (err) {
      if (statusBar) statusBar.innerHTML = "";
      if (resultsContainer) {
        resultsContainer.innerHTML = `<div class="smart-search-empty" style="color:var(--err)">⚠️ Search failed: ${esc(err.message)}</div>`;
      }
    } finally {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.innerHTML = `🔍 Search`;
      }
    }
  };

  // Toggle handlers for Enlarged Beta Mode vs Standard Mode
  const enableBetaMode = (prefill = "") => {
    state.search.active = true;
    if (!window._nrSearchScrollHandler) {
      window._nrSearchScrollHandler = onWindowScrollSearch;
      window.addEventListener("scroll", onWindowScrollSearch, { passive: true });
    }
    document.getElementById("shelf-search-standard").style.display = "none";
    const betaCard = document.getElementById("shelf-search-beta");
    betaCard.style.display = "block";
    const input = document.getElementById("beta-search-large-input");
    if (prefill && !input.value) input.value = prefill;
    input.focus();
    const q = input.value.trim();
    if (q) {
      location.hash = `#/search?q=${encodeURIComponent(q)}`;
    } else {
      location.hash = "#/search";
    }
    if (state.search.data && (!q || q === state.search.query)) {
      renderBetaResults(state.search.data, state.search.query);
    }
  };

  const disableBetaMode = () => {
    state.search.active = false;
    if (window._nrSearchScrollHandler) {
      window.removeEventListener("scroll", window._nrSearchScrollHandler);
      window._nrSearchScrollHandler = null;
    }
    document.getElementById("shelf-search-beta").style.display = "none";
    const resContainer = document.getElementById("beta-search-results-container");
    if (resContainer) resContainer.style.display = "none";
    document.getElementById("shelf-search-standard").style.display = "block";
    location.hash = "#/";
  };

  const smartSearchBtn = document.getElementById("btn-smart-search");
  const smartSearchHelpBtn = document.getElementById("btn-smart-search-help");
  const betaBackBtn = document.getElementById("btn-beta-back-standard");
  const betaHowBtn = document.getElementById("btn-beta-how");
  const betaForm = document.getElementById("beta-search-form");
  const betaInput = document.getElementById("beta-search-large-input");

  if (smartSearchBtn) {
    smartSearchBtn.onclick = (e) => {
      e.preventDefault();
      const q = searchInput.value.trim();
      enableBetaMode(q);
    };
  }

  if (smartSearchHelpBtn) {
    smartSearchHelpBtn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      showSmartSearchHelpDialog();
    };
  }

  if (betaBackBtn) {
    betaBackBtn.onclick = (e) => {
      e.preventDefault();
      disableBetaMode();
    };
  }

  if (betaHowBtn) {
    betaHowBtn.onclick = (e) => {
      e.preventDefault();
      showSmartSearchHelpDialog();
    };
  }

  if (betaForm) {
    betaForm.onsubmit = (e) => {
      e.preventDefault();
      const q = betaInput.value.trim();
      if (!q) return;
      executeBetaSearch(q);
    };
  }

  // Restore previous search results immediately if returning to search!
  if (showBeta) {
    if (state.search?.data && (!activeQuery || activeQuery === state.search.query)) {
      renderBetaResults(state.search.data, state.search.query);
    } else if (activeQuery) {
      executeBetaSearch(activeQuery);
    }
  }

  // Real-time text search filter for library cards
  searchInput.oninput = () => {
    const q = searchInput.value.trim().toLowerCase();
    if (q.startsWith("http://") || q.startsWith("https://")) {
      hint.className = "hint";
      hint.textContent = "Press Enter or click Add to fetch and view novel details.";
      return;
    }
    const cardEls = document.querySelectorAll("#cards .card");
    let matchCount = 0;
    cardEls.forEach((card) => {
      const text = card.textContent.toLowerCase();
      const match = !q || text.includes(q);
      card.style.display = match ? "" : "none";
      if (match) matchCount++;
    });
    if (q) {
      hint.className = "hint";
      hint.textContent = matchCount > 0 ? `Showing ${matchCount} matching novel${matchCount > 1 ? "s" : ""}.` : "No matching novels found in library. Click 🔍 BETA to search visited sites!";
    } else {
      hint.className = "hint";
      hint.textContent = "Enter a novel link or search library titles. Click 🔍 BETA to expand smart search across visited sites.";
    }
  };

  // Form submit: Import URL -> Navigate to NOVEL DETAILS
  document.getElementById("shelf-search-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const query = searchInput.value.trim();
    if (!query) return;

    if (query.startsWith("http://") || query.startsWith("https://")) {
      searchBtn.disabled = true;
      searchBtn.textContent = "Fetching…";
      hint.className = "hint";
      hint.textContent = "Discovering novel metadata and table of contents…";
      try {
        const data = await api("/api/import", { method: "POST", body: { url: query } });
        hint.textContent = `Found "${data.novel.titleEn || data.novel.title}" (${data.toc?.length || 0} chapters).`;
        location.hash = `#/novel/${encodeURIComponent(data.novel.slug)}`;
      } catch (err) {
        hint.className = "hint error";
        hint.textContent = err.message;
        searchBtn.disabled = false;
        searchBtn.textContent = "Add / Find";
      }
    } else {
      searchInput.dispatchEvent(new Event("input"));
      const visibleCards = document.querySelectorAll("#cards .card:not([style*='display: none'])");
      if (visibleCards.length === 0) {
        enableBetaMode(query);
        executeBetaSearch(query);
      }
    }
  });

  try {
    const { novels } = await api("/api/novels");
    const cards = document.getElementById("cards");
    const heroContainer = document.getElementById("hero-resume-container");

    if (!novels.length) {
      cards.innerHTML = `<div class="empty">No novels in library yet. Paste a link above to get started.</div>`;
      return;
    }

    // Hero Continue Reading Card (Requirement 8)
    const inProgressNovel = novels.find((n) => n.progress?.chaptersRead > 0 && !n.progress?.isCompleted) ||
      novels.find((n) => n.lastReadAt) ||
      novels[0];

    if (inProgressNovel && inProgressNovel.chapterCount > 0) {
      const prog = inProgressNovel.progress || {};
      const curCh = prog.nextChapter || inProgressNovel.lastChapter || 1;
      const total = inProgressNovel.chapterCount || inProgressNovel.tocLength || 1;
      const pct = prog.progressPercent !== undefined ? prog.progressPercent : Math.round((curCh / total) * 100);
      const readTime = inProgressNovel.lastReadAt ? timeAgo(inProgressNovel.lastReadAt) : "Recently added";

      heroContainer.innerHTML = `
        <div class="hero-card" data-novel-slug="${esc(inProgressNovel.slug)}">
          <div class="hero-cover-wrap">
            <img class="hero-cover" src="/api/novels/${encodeURIComponent(inProgressNovel.slug)}/cover" alt="${esc(inProgressNovel.title)}" onerror="this.style.display='none';this.nextElementSibling.style.display='flex';" />
            <div class="card-cover-fallback" style="display:none">${esc((inProgressNovel.title || "📖").slice(0, 1))}</div>
          </div>
          <div class="hero-body">
            <div class="hero-kicker">${prog.isCompleted ? "Completed Novel" : "Continue Reading"} · ${esc(readTime)}</div>
            <div class="hero-title">${esc(inProgressNovel.titleEn || inProgressNovel.title)}</div>
            ${inProgressNovel.titleEn && inProgressNovel.titleEn !== inProgressNovel.title ? `<div class="hero-orig-title">${esc(inProgressNovel.title)}</div>` : ""}
            <div class="hero-chapter">${prog.chaptersRead || 0} of ${total} chapters read (${pct}%)</div>
            <div class="hero-progress-bg">
              <div class="hero-progress-bar" style="width:${pct}%"></div>
            </div>
          </div>
          <button class="hero-action hero-smart-btn" data-goto-chapter="${prog.actionChapter || curCh}">
            ${esc(prog.actionLabel || `Continue Ch. ${curCh}`)} →
          </button>
        </div>`;

      // Hero clicks
      const heroCard = heroContainer.querySelector(".hero-card");
      if (heroCard) {
        heroCard.onclick = (e) => {
          if (e.target.closest(".hero-smart-btn")) {
            e.stopPropagation();
            const ch = heroCard.querySelector(".hero-smart-btn").dataset.gotoChapter;
            location.hash = `#/n/${encodeURIComponent(inProgressNovel.slug)}/${ch}`;
          } else {
            location.hash = `#/novel/${encodeURIComponent(inProgressNovel.slug)}`;
          }
        };
      }
    }

    // Your Library Cards (Requirement 4 & 8)
    cards.innerHTML = novels
      .map((n) => {
        const prog = n.progress || {};
        const total = n.chapterCount || 0;
        const pct = prog.progressPercent || 0;
        const readTime = n.lastReadAt ? ` · ${timeAgo(n.lastReadAt)}` : "";
        const actionChapter = prog.actionChapter || 1;
        const actionLabel = prog.actionLabel || "Read Chapter 1";
        const isCompleted = prog.isCompleted;

        const desc = (n.descriptionEn || n.description || "").trim();
        const title = n.titleEn || n.title || "";
        const titleZh = n.titleEn && n.titleEn !== n.title ? n.title : "";
        const author = n.author || "";

        return `
        <div class="card"
             data-slug="${esc(n.slug)}"
             data-has-popover="${desc ? 'true' : 'false'}"
             data-popover-title="${esc(title)}"
             data-popover-zh="${esc(titleZh)}"
             data-popover-author="${esc(author)}"
             data-popover-desc="${esc(desc)}">
          <div class="card-cover-wrapper">
            <img class="card-cover" src="/api/novels/${encodeURIComponent(n.slug)}/cover" alt="${esc(n.title)}" onerror="this.style.display='none';this.nextElementSibling.style.display='flex';" />
            <div class="card-cover-fallback" style="display:none">${esc((n.title || "📖").slice(0, 1))}</div>
          </div>
          <div class="meta">
            <div class="title">${esc(n.titleEn || n.title)}</div>
            ${n.titleEn && n.titleEn !== n.title ? `<div class="orig-title">${esc(n.title)}</div>` : ""}
            ${n.author ? `<div class="sub" style="color:var(--accent);font-size:12px;margin-bottom:2px">✍️ ${esc(n.author)}</div>` : ""}
            <div class="sub">${prog.chaptersRead || 0} / ${total} chapters (${pct}%)${readTime}${n.chainMode ? " · chained" : ""}</div>
            <div class="card-progress-track">
              <div class="card-progress-fill" style="width:${pct}%"></div>
            </div>
          </div>
          <button class="card-action-btn ${isCompleted ? 'completed' : ''}" data-ch="${actionChapter}" data-slug="${esc(n.slug)}">
            ${esc(actionLabel)}
          </button>
          <button class="card-delete" title="Delete novel from library" data-delete-slug="${esc(n.slug)}" data-title="${esc(n.titleEn || n.title)}">🗑</button>
        </div>`;
      })
      .join("");

    // Clicking card opens Novel Details (Requirement 2 & 4)
    cards.querySelectorAll(".card").forEach((card) => {
      card.onclick = (e) => {
        // If clicked action button, jump directly into reader
        const actionBtn = e.target.closest(".card-action-btn");
        if (actionBtn) {
          e.stopPropagation();
          const slug = actionBtn.dataset.slug;
          const ch = actionBtn.dataset.ch;
          location.hash = `#/n/${encodeURIComponent(slug)}/${ch}`;
          return;
        }

        // If clicked delete button, handle delete
        if (e.target.closest(".card-delete")) {
          return;
        }

        // Otherwise open Novel Details!
        const slug = card.dataset.slug;
        location.hash = `#/novel/${encodeURIComponent(slug)}`;
      };
    });

    cards.querySelectorAll(".card-delete").forEach((btn) => {
      btn.onclick = async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const slug = btn.dataset.deleteSlug;
        const title = btn.dataset.title || "this novel";
        if (!confirm(`Remove "${title}" from your library shelf?`)) {
          return;
        }
        try {
          await api(`/api/novels/${encodeURIComponent(slug)}/library`, {
            method: "POST",
            body: { inLibrary: false },
          });
          toast(`Removed "${title}" from library shelf`);
          openShelf();
        } catch (err) {
          toast(err.message, true);
        }
      };
    });

    // Home Page Recommendations Section (Requirement 6 & 8)
    const topNovel = novels[0];
    if (topNovel) {
      api(`/api/novels/${encodeURIComponent(topNovel.slug)}/recommendations`)
        .then((res) => {
          const recs = res.recommendations || [];
          if (!recs.length) return;
          const recContainer = document.getElementById("home-recommendations-container");
          if (!recContainer) return;
          recContainer.innerHTML = `
            <div class="rec-section" style="margin-top:40px">
              <h3>Recommended From Source Site</h3>
              <div class="rec-grid">
                ${renderRecCards(recs, 6)}
              </div>
            </div>`;
          bindRecCardEvents(recContainer);
        })
        .catch(() => {});
    }

    // Live Auto-Update for Shelf: If any card has Chinese, check once in 1.8s
    const hasChineseCard = Array.from(document.querySelectorAll("#cards .card .title")).some((el) => /[\u4e00-\u9fff]/.test(el.textContent));
    if (hasChineseCard) {
      setTimeout(async () => {
        if (!document.querySelector(".shelf")) return;
        try {
          const fresh = await api("/api/novels");
          if (fresh?.novels?.length) {
            fresh.novels.forEach((n) => {
              const card = document.querySelector(`.card[data-slug="${n.slug}"]`);
              if (card && n.titleEn && !/[\u4e00-\u9fff]/.test(n.titleEn)) {
                const titleEl = card.querySelector(".title");
                if (titleEl && titleEl.textContent !== n.titleEn) {
                  titleEl.textContent = n.titleEn;
                  const origEl = card.querySelector(".orig-title");
                  if (origEl && n.title && n.titleEn !== n.title) origEl.textContent = n.title;
                  card.dataset.popoverTitle = n.titleEn;
                  if (n.descriptionEn) card.dataset.popoverDesc = n.descriptionEn;
                }
              }
            });
          }
        } catch {}
      }, 1800);
    }
  } catch (err) {
    document.getElementById("cards").innerHTML = `<div class="empty">${esc(err.message)}</div>`;
  }
}

/* ------------------------------------------------------------- novel details */

let novelWatchdogTimer = null;

async function openNovelDetails(slug) {
  stopPolling();
  state.chapter = null;
  clearTimeout(novelWatchdogTimer);

  // Stale-While-Revalidate: If novel is already in memory, keep current view and refresh smoothly
  const hasCachedNovel = state.novel && state.novel.slug === slug && state.toc?.length;

  if (!hasCachedNovel) {
    $app.innerHTML = `
      <main class="novel-page">
        <div class="novel-topbar">
          <a class="back-link-btn" href="#/" title="Return to Library (B)">← Library</a>
          <div style="display:flex;gap:8px">
            <button id="details-history-btn" title="Reading history (H)">🕒 History</button>
            <button id="details-settings-btn" title="Settings (S)">⚙ Settings</button>
          </div>
        </div>
        <div class="novel-loading-box">
          <div class="spinner" style="width:36px;height:36px;border-width:3px;margin:0 auto 16px"></div>
          <h3 style="margin-bottom:8px;font-size:18px;color:var(--ink)">Loading Novel Details…</h3>
          <p style="font-size:13.5px;color:var(--ink-soft);max-width:440px;margin:0 auto 16px;line-height:1.5">
            Loading chapters, reading progress and source recommendations…
          </p>
          <div id="loading-watchdog" style="display:none;margin-top:14px">
            <p style="margin-bottom:12px;font-size:13px;color:var(--warn,#d97706)">⚠️ Loading is taking longer than usual. The source site might be responding slowly.</p>
            <div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap">
              <button class="btn-primary-smart" onclick="location.reload()">🔄 Refresh</button>
              <a class="btn-secondary" href="#/" style="padding:6px 14px;text-decoration:none">← Return to Library</a>
            </div>
          </div>
        </div>
      </main>`;

    novelWatchdogTimer = setTimeout(() => {
      const wd = document.getElementById("loading-watchdog");
      if (wd) wd.style.display = "block";
    }, 3500);
  }

  try {
    const data = await api(`/api/novels/${encodeURIComponent(slug)}`);
    clearTimeout(novelWatchdogTimer);
    const novel = data.novel;
    const toc = data.toc || [];
    const progress = data.progress || {};
    const recs = data.recommendations || [];

    state.novel = novel;
    state.toc = toc;
    state.statuses = data.statuses || {};
    document.title = `${novel.titleEn || novel.title} · Novel Details`;

    const totalChapters = toc.length;
    const readCount = progress.chaptersRead || 0;
    const pct = progress.progressPercent || 0;
    const isCompleted = progress.isCompleted;
    const nextChapter = progress.nextChapter || 1;
    const actionLabel = progress.actionLabel || (readCount === 0 ? "Read Chapter 1" : `Continue Reading · Ch. ${nextChapter}`);
    const actionChapter = progress.actionChapter || nextChapter;

    let sourceDomain = "";
    try {
      if (novel.sourceUrl) sourceDomain = new URL(novel.sourceUrl).hostname;
    } catch {}

    function renderNovelActionsHtml() {
      const isInLib = novel.inLibrary !== false;
      return `
        <button class="btn-primary-smart" id="smart-action-btn">
          ${isCompleted ? '✓' : '▶'} ${esc(actionLabel)}
        </button>
        ${isInLib ? `
          <button class="btn-secondary in-library-btn" id="btn-toggle-library" title="Saved in your library. Click to remove.">✓ In Library</button>
          <button class="btn-secondary" id="btn-delete-novel" style="color:var(--err)" title="Remove this novel from your library">🗑 Remove</button>
        ` : `
          <button class="btn-primary-smart btn-add-lib" id="btn-toggle-library" title="Add this novel to your library shelf">➕ Add to Library</button>
        `}
        <button class="btn-secondary" id="btn-refresh-toc" title="Check source site for newly published chapters">🔄 Refresh TOC</button>
        <button class="btn-secondary" id="btn-translate-titles" title="Batch translate 50 chapter titles in 1 AI call">⚡ Translate Titles (50)</button>
      `;
    }

    $app.innerHTML = `
      <main class="novel-page">
        <!-- Top Navigation Bar -->
        <div class="novel-topbar">
          ${state.search?.active && state.search?.query ? `
            <a class="back-link-btn back-to-search-btn" id="novel-back-btn" href="#/search?q=${encodeURIComponent(state.search.query)}" title="Return to Search Results (B)">← Back to Search</a>
            <a class="back-link-btn" href="#/" title="Return to Library Shelf">📚 Shelf</a>
          ` : `
            <a class="back-link-btn" id="novel-back-btn" href="#/" title="Return to Library (B)">← Library</a>
          `}
          <div style="display:flex;gap:8px">
            <button id="details-history-btn" title="Reading history (H)">🕒 History</button>
            <button id="details-settings-btn" title="Settings (S)">⚙ Settings</button>
          </div>
        </div>

        <!-- Novel Hero & Metadata (Requirement 2) -->
        <section class="novel-hero">
          <div class="novel-cover-wrap">
            <img class="novel-cover-img" src="/api/novels/${encodeURIComponent(novel.slug)}/cover" alt="${esc(novel.title)}" onerror="this.style.display='none';this.nextElementSibling.style.display='flex';" />
            <div class="card-cover-fallback" style="display:none">${esc((novel.title || "📖").slice(0, 1))}</div>
          </div>
          <div class="novel-hero-info">
            <h1 class="novel-title-en">${esc(novel.titleEn || novel.title)}</h1>
            ${novel.titleEn && novel.titleEn !== novel.title ? `<div class="novel-title-zh">${esc(novel.title)}</div>` : ""}
            
            <div class="novel-author-line">
              <span>✍️</span> <strong>${esc(novel.author || "Unknown Author")}</strong>
              ${sourceDomain ? `· <a href="${esc(novel.sourceUrl)}" target="_blank" rel="noopener" style="font-size:12.5px;color:var(--ink-soft)">🌐 ${esc(sourceDomain)}</a>` : ""}
            </div>

            <!-- Metadata Pills -->
            <div class="novel-meta-pills">
              <span class="meta-pill ${isCompleted ? 'status-completed' : (readCount > 0 ? 'status-reading' : '')}">
                ${isCompleted ? '✓ Completed' : (readCount > 0 ? '📖 Reading' : 'Unread')}
              </span>
              <span class="meta-pill">📚 ${totalChapters} Total Chapters</span>
              <span class="meta-pill">✓ ${readCount} Read</span>
              <span class="meta-pill">📊 ${pct}% Complete</span>
              ${novel.genre ? `<span class="meta-pill">🏷 ${esc(novel.genre)}</span>` : ""}
            </div>

            <!-- Reading Progress Track (Single Source of Truth) -->
            <div class="novel-progress-box">
              <div class="progress-labels">
                <span>Reading Progress: ${readCount} / ${totalChapters} chapters</span>
                <strong>${pct}%</strong>
              </div>
              <div class="progress-track">
                <div class="progress-fill" style="width:${pct}%"></div>
              </div>
            </div>

            <!-- Synopsis / Description -->
            <div class="novel-synopsis" id="synopsis-box">
              ${esc(novel.descriptionEn || novel.description || "No synopsis available for this title.")}
            </div>
            <div class="synopsis-controls" style="display:flex;align-items:center;gap:10px;margin-top:6px">
              ${(novel.descriptionEn || novel.description || "").length > 200 ? `<button class="synopsis-toggle" id="synopsis-toggle-btn">Show more</button>` : ""}
              ${!novel.descriptionEn && novel.description && /[\u4e00-\u9fff]/.test(novel.description) ? `
                <button class="synopsis-trans-btn" id="btn-trans-synopsis" title="Translate synopsis to English">🌐 Translate Synopsis</button>
              ` : ""}
            </div>

            <!-- Smart Primary Action Button & Tools -->
            <div class="novel-actions">
              ${renderNovelActionsHtml()}
            </div>
          </div>
        </section>

        <!-- Chapter List Section (Requirement 5) -->
        <section class="chapter-section">
          <div class="chapter-section-header">
            <h3>Chapters (${totalChapters})</h3>
            <div class="chapter-search-wrap">
              <input type="search" id="chapter-search-input" placeholder="🔍 Search chapter title or #..." autocomplete="off" />
            </div>
            <div class="chapter-quick-actions">
              <button class="btn-secondary" id="btn-mark-all" style="padding:6px 10px;font-size:12px">Mark all read</button>
              <button class="btn-secondary" id="btn-reset-read" style="padding:6px 10px;font-size:12px">Reset progress</button>
            </div>
          </div>

          <div class="chapter-list-table" id="chapter-list-container">
            ${renderChapterItems(toc, progress, state.statuses)}
          </div>
        </section>

        <!-- Recommendations Section at Bottom (Requirement 6 & 18) -->
        <div id="novel-recommendations-container">
          ${
            recs.length
              ? `<section class="rec-section">
              <h3>Recommended From Source Site</h3>
              <div class="rec-grid">
                ${renderRecCards(recs, 10)}
              </div>
            </section>`
              : ""
          }
        </div>
      </main>

      <div class="scrim" id="scrim"></div>
      <aside class="drawer" id="drawer">
        <header>
          <h3 id="drawer-title">Drawer</h3>
          <button id="drawer-close">✕</button>
        </header>
        <div id="drawer-body"></div>
      </aside>`;

    // Event Bindings
    document.getElementById("scrim").onclick = closeDrawer;
    document.getElementById("drawer-close").onclick = closeDrawer;
    document.getElementById("details-history-btn").onclick = () => openDrawer("history");
    document.getElementById("details-settings-btn").onclick = () => openDrawer("settings");

    // Action Buttons & Library Toggle Handlers
    function bindNovelActionEvents() {
      const smartBtn = document.getElementById("smart-action-btn");
      if (smartBtn) {
        smartBtn.onclick = () => {
          location.hash = `#/n/${encodeURIComponent(novel.slug)}/${actionChapter}`;
        };
      }

      const refreshBtn = document.getElementById("btn-refresh-toc");
      if (refreshBtn) {
        refreshBtn.onclick = async () => {
          refreshBtn.disabled = true;
          refreshBtn.textContent = "Fetching…";
          try {
            const res = await api(`/api/novels/${encodeURIComponent(novel.slug)}/toc/refresh`, { method: "POST" });
            if (res.ok) {
              toast(`TOC Updated: ${res.chapterCount} total chapters ✓`);
              openNovelDetails(novel.slug);
            } else {
              toast(`Chapters count: ${res.chapterCount}`);
            }
          } catch (err) {
            toast(err.message, true);
          } finally {
            refreshBtn.disabled = false;
            refreshBtn.textContent = "🔄 Refresh TOC";
          }
        };
      }

      const transTitlesBtn = document.getElementById("btn-translate-titles");
      if (transTitlesBtn) {
        transTitlesBtn.onclick = async () => {
          transTitlesBtn.disabled = true;
          transTitlesBtn.textContent = "Translating 50…";
          try {
            const res = await api(`/api/novels/${encodeURIComponent(novel.slug)}/toc/translate-titles`, {
              method: "POST",
              body: { from: progress.nextChapter || 1, count: 50 },
            });
            if (res.toc) state.toc = res.toc;
            toast("Translated next 50 chapter titles in 1 AI call ✓");
            openNovelDetails(novel.slug);
          } catch (err) {
            toast(err.message, true);
            transTitlesBtn.disabled = false;
            transTitlesBtn.textContent = "⚡ Translate Titles (50)";
          }
        };
      }

      async function setLibraryState(inLib) {
        const toggleBtn = document.getElementById("btn-toggle-library");
        const delBtn = document.getElementById("btn-delete-novel");
        if (toggleBtn) toggleBtn.disabled = true;
        if (delBtn) delBtn.disabled = true;

        try {
          await api(`/api/novels/${encodeURIComponent(novel.slug)}/library`, {
            method: "POST",
            body: { inLibrary: inLib },
          });
          novel.inLibrary = inLib;
          if (state.novel) state.novel.inLibrary = inLib;

          if (inLib) {
            toast(`Added "${novel.titleEn || novel.title}" to library! ✓`);
          } else {
            toast(`Removed from library. You can click "+ Add to Library" to re-add anytime.`);
          }

          const container = document.querySelector(".novel-actions");
          if (container) {
            container.innerHTML = renderNovelActionsHtml();
            bindNovelActionEvents();
          }
        } catch (err) {
          toast(`Failed to update library state: ${err.message}`, true);
          if (toggleBtn) toggleBtn.disabled = false;
          if (delBtn) delBtn.disabled = false;
        }
      }

      const toggleLibBtn = document.getElementById("btn-toggle-library");
      if (toggleLibBtn) {
        toggleLibBtn.onclick = () => {
          const currentInLib = novel.inLibrary !== false;
          setLibraryState(!currentInLib);
        };
      }

      const deleteNovelBtn = document.getElementById("btn-delete-novel");
      if (deleteNovelBtn) {
        deleteNovelBtn.onclick = async () => {
          if (!confirm(`Remove "${novel.titleEn || novel.title}" from your library?`)) return;
          try {
            await api(`/api/novels/${encodeURIComponent(novel.slug)}/library`, {
              method: "POST",
              body: { inLibrary: false },
            });
            toast(`Removed "${novel.titleEn || novel.title}" from library`);
            if (state.search?.active && state.search?.query) {
              location.hash = `#/search?q=${encodeURIComponent(state.search.query)}`;
            } else {
              location.hash = "#/";
            }
          } catch (err) {
            toast(`Failed to remove: ${err.message}`, true);
          }
        };
      }
    }

    bindNovelActionEvents();

    // Synopsis Expand
    const synopsisToggleBtn = document.getElementById("synopsis-toggle-btn");
    if (synopsisToggleBtn) {
      synopsisToggleBtn.onclick = () => {
        const box = document.getElementById("synopsis-box");
        const expanded = box.classList.toggle("expanded");
        synopsisToggleBtn.textContent = expanded ? "Show less" : "Show more";
      };
    }

    // Synopsis translation
    const transSynopsisBtn = document.getElementById("btn-trans-synopsis");
    if (transSynopsisBtn) {
      const doTranslateSynopsis = async () => {
        transSynopsisBtn.disabled = true;
        transSynopsisBtn.textContent = "Translating…";
        try {
          const res = await api(`/api/novels/${encodeURIComponent(novel.slug)}/translate-description`, { method: "POST" });
          if (res.descriptionEn) {
            novel.descriptionEn = res.descriptionEn;
            const box = document.getElementById("synopsis-box");
            if (box) box.textContent = res.descriptionEn;
            transSynopsisBtn.remove();
            toast("Synopsis translated to English ✓");
          }
        } catch (err) {
          transSynopsisBtn.disabled = false;
          transSynopsisBtn.textContent = "🌐 Translate Synopsis";
        }
      };
      transSynopsisBtn.onclick = doTranslateSynopsis;

      // Auto-trigger background translation if user sees Chinese synopsis
      setTimeout(() => {
        if (transSynopsisBtn && !novel.descriptionEn) {
          doTranslateSynopsis().catch(() => {});
        }
      }, 500);
    }

    // Filter chapters live
    const chapterSearchInput = document.getElementById("chapter-search-input");
    const chapterContainer = document.getElementById("chapter-list-container");
    chapterSearchInput.oninput = () => {
      const q = chapterSearchInput.value.trim().toLowerCase();
      if (!q) {
        chapterContainer.innerHTML = renderChapterItems(toc, progress, state.statuses);
        bindChapterRowEvents(novel.slug, toc, progress);
        return;
      }
      const filtered = toc.filter((c) => {
        const disp = formatChapterTitle(c).toLowerCase();
        const orig = (c.title || "").toLowerCase();
        const chNum = String(c.index);
        return disp.includes(q) || orig.includes(q) || chNum === q;
      });
      chapterContainer.innerHTML = renderChapterItems(filtered, progress, state.statuses, filtered.length);
      bindChapterRowEvents(novel.slug, toc, progress);
    };

    chapterSearchInput.onkeydown = (e) => {
      if (e.key === "Enter") {
        const val = chapterSearchInput.value.trim();
        const chNum = parseInt(val, 10);
        if (!isNaN(chNum) && chNum >= 1 && chNum <= toc.length) {
          location.hash = `#/n/${encodeURIComponent(novel.slug)}/${chNum}`;
          return;
        }
        const first = chapterContainer.querySelector('.chapter-row:not([style*="display: none"])');
        if (first) {
          location.hash = `#/n/${encodeURIComponent(novel.slug)}/${first.dataset.chapter}`;
        }
      }
    };

    // Mark all read / reset
    document.getElementById("btn-mark-all").onclick = async () => {
      if (!confirm("Mark all chapters as read?")) return;
      try {
        await api(`/api/novels/${encodeURIComponent(novel.slug)}/mark-read`, {
          method: "POST",
          body: { readAll: true },
        });
        toast("All chapters marked read ✓");
        openNovelDetails(novel.slug);
      } catch (err) {
        toast(err.message, true);
      }
    };

    document.getElementById("btn-reset-read").onclick = async () => {
      if (!confirm("Reset reading progress for this novel?")) return;
      try {
        await api(`/api/novels/${encodeURIComponent(novel.slug)}/mark-read`, {
          method: "POST",
          body: { reset: true },
        });
        toast("Reading progress reset ✓");
        openNovelDetails(novel.slug);
      } catch (err) {
        toast(err.message, true);
      }
    };

    // Chapter row clicks & read toggle
    bindChapterRowEvents(novel.slug, toc, progress);

    // Recommendation card events (interactive open & 1-click import from web)
    bindRecCardEvents($app);

    // If recommendations weren't already loaded or have untranslated titles/synopses, fetch in background without blocking
    const needsRecsTranslation = !recs.length || recs.some((r) =>
      /[\u4e00-\u9fff]/.test(r.titleEn || r.title || '') ||
      /[\u4e00-\u9fff]/.test(r.synopsis || '')
    );
    if (needsRecsTranslation) {
      api(`/api/novels/${encodeURIComponent(novel.slug)}/recommendations`)
        .then((res) => {
          const freshRecs = res.recommendations || [];
          if (!freshRecs.length) return;
          const container = document.getElementById("novel-recommendations-container");
          if (!container) return;
          container.innerHTML = `
            <section class="rec-section">
              <h3>Recommended From Source Site</h3>
              <div class="rec-grid">
                ${renderRecCards(freshRecs, 10)}
              </div>
            </section>`;
          bindRecCardEvents(container);
        })
        .catch(() => {});
    }

    // Live Auto-Update for Novel Details: if title, synopsis, or recommendations still have Chinese,
    // poll in background every 1.5s (up to 8 times) and update DOM on-the-fly without requiring a manual refresh!
    let liveCheckCount = 0;
    const hasChinese = (text) => text && /[\u4e00-\u9fff]/.test(text);
    const checkNeedLiveUpdate = () => {
      const curNovel = state.novel || novel;
      const titleNeeds = hasChinese(curNovel.titleEn) || curNovel.titleEn === curNovel.title;
      const descNeeds = hasChinese(curNovel.descriptionEn) || !curNovel.descriptionEn;
      const curRecs = curNovel.recommendations || recs || [];
      const recsNeed = !curRecs.length || curRecs.some((r) => hasChinese(r.titleEn || r.title) || hasChinese(r.synopsis));
      return titleNeeds || descNeeds || recsNeed;
    };

    if (checkNeedLiveUpdate()) {
      const liveTimer = setInterval(async () => {
        liveCheckCount++;
        if (liveCheckCount > 8 || !document.querySelector(".novel-page")) {
          clearInterval(liveTimer);
          return;
        }
        try {
          const fresh = await api(`/api/novels/${encodeURIComponent(slug)}`);
          if (!fresh || !fresh.novel) return;

          state.novel = fresh.novel;
          if (fresh.toc) state.toc = fresh.toc;
          if (fresh.statuses) state.statuses = fresh.statuses;

          // 1. Update Title if changed to English
          if (fresh.novel.titleEn && fresh.novel.titleEn !== novel.title && !hasChinese(fresh.novel.titleEn)) {
            const titleEl = document.querySelector(".novel-title-en");
            if (titleEl && titleEl.textContent !== fresh.novel.titleEn) {
              titleEl.textContent = fresh.novel.titleEn;
              document.title = `${fresh.novel.titleEn} · Novel Details`;
            }
          }

          // 2. Update Synopsis if changed to English
          const freshDesc = fresh.novel.descriptionEn || fresh.novel.description || "";
          if (freshDesc && !hasChinese(freshDesc)) {
            const descEl = document.getElementById("synopsis-box");
            if (descEl && descEl.textContent !== freshDesc) {
              descEl.textContent = freshDesc;
            }
          }

          // 3. Update Recommendations if fresh recommendations arrived
          if (fresh.recommendations?.length) {
            const anyEn = fresh.recommendations.some((r) => r.titleEn && !hasChinese(r.titleEn));
            if (anyEn) {
              const recContainer = document.getElementById("novel-recommendations-container");
              if (recContainer) {
                recContainer.innerHTML = `
                  <section class="rec-section">
                    <h3>Recommended From Source Site</h3>
                    <div class="rec-grid">
                      ${renderRecCards(fresh.recommendations, 10)}
                    </div>
                  </section>`;
                bindRecCardEvents(recContainer);
              }
            }
          }

          if (!checkNeedLiveUpdate()) {
            clearInterval(liveTimer);
          }
        } catch {}
      }, 1500);
    }
  } catch (err) {
    clearTimeout(novelWatchdogTimer);
    $app.innerHTML = `
      <main class="novel-page">
        <div class="novel-topbar">
          ${state.search?.active && state.search?.query ? `
            <a class="back-link-btn back-to-search-btn" href="#/search?q=${encodeURIComponent(state.search.query)}" title="Return to Search Results (B)">← Back to Search</a>
            <a class="back-link-btn" href="#/" title="Return to Library Shelf">📚 Shelf</a>
          ` : `
            <a class="back-link-btn" href="#/" title="Return to Library (B)">← Library</a>
          `}
        </div>
        <div style="padding:48px 20px;text-align:center;background:var(--card);border:1px solid var(--line);border-radius:18px;margin-top:16px">
          <p style="color:var(--err);font-size:16px;margin-bottom:14px">⚠️ Could not load novel: ${esc(err.message)}</p>
          <div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap">
            <button class="btn-primary-smart" onclick="location.reload()">🔄 Retry</button>
            <button class="btn-secondary" onclick="openSmartSearchModal()">🔍 Search in Smart Search</button>
            <a class="btn-secondary" href="#/" style="padding:8px 16px;text-decoration:none;display:inline-block">← Back to Library</a>
          </div>
        </div>
      </main>`;
  }
}

function renderChapterItems(toc, progress, statuses = {}, limit = null) {
  const readSet = new Set(progress.readChapters || []);
  const nextChapter = progress.nextChapter || 1;
  const isLarge = !limit && toc.length > 120;
  const itemsToRender = isLarge ? toc.slice(0, 100) : limit ? toc.slice(0, limit) : toc;

  let html = itemsToRender
    .map((c) => {
      const isRead = readSet.has(c.index);
      const isNext = c.index === nextChapter;
      const status = statuses[c.index] || "";
      const disp = formatChapterTitle(c);

      return `
      <div class="chapter-row ${isNext ? 'is-current-next' : ''}" data-chapter="${c.index}">
        <span class="chapter-row-num">${c.index}</span>
        <div class="chapter-row-title-wrap">
          <span class="chapter-row-title">${esc(disp)}</span>
          ${c.title && disp !== c.title ? `<span class="chapter-row-orig">${esc(c.title)}</span>` : ""}
        </div>
        <div class="chapter-row-badges">
          ${isRead ? `<span class="badge-read">✓ Read</span>` : isNext ? `<span class="badge-next">→ Next</span>` : ""}
          <span class="dot ${status}" title="Translation: ${status || 'source'}"></span>
          <button class="btn-toggle-read" data-toggle-ch="${c.index}" data-is-read="${isRead ? '1' : '0'}" title="${isRead ? 'Mark as unread' : 'Mark as read'}">
            ${isRead ? '✓' : '○'}
          </button>
        </div>
      </div>`;
    })
    .join("") || `<div class="empty">No chapters available</div>`;

  if (isLarge) {
    html += `
      <div id="chapter-list-expand-bar" style="padding:16px;text-align:center;background:var(--bg-sub, rgba(0,0,0,0.02));border-radius:10px;margin-top:12px">
        <p style="font-size:13px;color:var(--ink-soft);margin-bottom:8px">Showing first 100 of ${toc.length} chapters</p>
        <button class="btn-secondary" id="btn-show-all-chapters" style="padding:8px 18px;font-size:13px">⚡ Show All ${toc.length} Chapters</button>
      </div>`;
  }
  return html;
}

function bindChapterRowEvents(slug, fullToc = null, progress = null) {
  const container = document.getElementById("chapter-list-container");
  if (!container) return;

  const showAllBtn = document.getElementById("btn-show-all-chapters");
  if (showAllBtn && fullToc) {
    showAllBtn.onclick = () => {
      showAllBtn.disabled = true;
      showAllBtn.textContent = "Loading chapters…";
      requestAnimationFrame(() => {
        container.innerHTML = renderChapterItems(fullToc, progress || {}, state.statuses, fullToc.length);
        bindChapterRowEvents(slug, fullToc, progress);
      });
    };
  }

  container.querySelectorAll(".chapter-row").forEach((row) => {
    row.onclick = (e) => {
      // If clicking toggle read button
      const toggleBtn = e.target.closest(".btn-toggle-read");
      if (toggleBtn) {
        e.stopPropagation();
        const ch = Number(toggleBtn.dataset.toggleCh);
        const currentRead = toggleBtn.dataset.isRead === "1";
        api(`/api/novels/${encodeURIComponent(slug)}/mark-read`, {
          method: "POST",
          body: { chapter: ch, read: !currentRead },
        })
          .then(() => openNovelDetails(slug))
          .catch((err) => toast(err.message, true));
        return;
      }

      // Otherwise navigate to chapter reader
      const ch = row.dataset.chapter;
      location.hash = `#/n/${encodeURIComponent(slug)}/${ch}`;
    };
  });
}

/* ------------------------------------------------------------------ reader */

function stopPolling() {
  if (state.timer) {
    clearInterval(state.timer);
    clearTimeout(state.timer);
  }
  state.timer = null;
}

async function openReader(slug, index) {
  stopPolling();

  const isSameNovel = state.novel && state.novel.slug === slug && state.toc?.length;
  if (!isSameNovel) {
    $app.innerHTML = `
      <main class="page" style="padding:60px 20px;text-align:center">
        <div class="spinner" style="width:32px;height:32px;border-width:3px;margin:0 auto 16px"></div>
        <h3 style="margin-bottom:8px;font-size:17px;color:var(--ink)">Opening Novel Reader…</h3>
        <p style="font-size:13px;color:var(--ink-soft)">Preparing Chapter ${index} and novel details</p>
      </main>`;

    try {
      const meta = await api(`/api/novels/${encodeURIComponent(slug)}`);
      state.novel = meta.novel;
      state.toc = meta.toc;
      state.statuses = meta.statuses || {};
      document.title = `${meta.novel.titleEn || meta.novel.title} · Novel Reader`;
    } catch (err) {
      $app.innerHTML = `<main class="page"><p style="color:var(--err)">${esc(err.message)}</p><p><a href="#/">← back</a></p></main>`;
      return;
    }
  }

  try {
    await loadChapter(slug, index, true);
  } catch (err) {
    $app.innerHTML = `<main class="page"><p style="color:var(--err)">${esc(err.message)}</p><p><a href="#/novel/${encodeURIComponent(slug)}">← Back to Novel Details</a></p></main>`;
  }
}

let scrollSaveTimer = null;

function setupScrollTracking(slug, chapterIndex) {
  const scrollKey = `nr.scroll.${slug}.${chapterIndex}`;
  const savedY = localStorage.getItem(scrollKey);

  // Restore previous position if exists
  if (savedY && Number(savedY) > 50) {
    requestAnimationFrame(() => {
      window.scrollTo({ top: Number(savedY), behavior: "auto" });
    });
  }

  const onScroll = () => {
    const scrollY = window.scrollY;
    const maxScroll = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
    const pct = Math.min(100, Math.max(0, Math.round((scrollY / maxScroll) * 100)));

    const scrollBar = document.getElementById("read-scroll-bar");
    if (scrollBar) scrollBar.style.width = `${pct}%`;

    const hud = document.getElementById("scroll-hud");
    if (hud) {
      hud.textContent = `${pct}%`;
      hud.classList.add("show");
      clearTimeout(hud._timer);
      hud._timer = setTimeout(() => hud.classList.remove("show"), 1200);
    }

    localStorage.setItem(scrollKey, scrollY);

    clearTimeout(scrollSaveTimer);
    scrollSaveTimer = setTimeout(() => {
      const markRead = pct >= 80;
      api(`/api/novels/${encodeURIComponent(slug)}/progress`, {
        method: "POST",
        body: { chapter: chapterIndex, scrollPercent: pct, scrollY, markRead },
      }).catch(() => {});
    }, 2000);
  };

  if (window._nrScrollHandler) {
    window.removeEventListener("scroll", window._nrScrollHandler);
  }
  window._nrScrollHandler = onScroll;
  window.addEventListener("scroll", onScroll, { passive: true });
}

async function loadChapter(slug, index, first = false) {
  const data = await api(`/api/novels/${encodeURIComponent(slug)}/chapter/${index}`);
  state.chapter = data.chapter;
  state.statuses[index] = data.chapter.status;
  if (data.hasAiKey !== undefined) state.hasAiKey = data.hasAiKey;

  // Persist current chapter visit
  api(`/api/novels/${encodeURIComponent(slug)}/progress`, {
    method: "POST",
    body: { chapter: index },
  }).catch(() => {});

  if (state.novel) state.novel.lastChapter = index;

  renderReader(data.chapter, data.total, first);
  setupScrollTracking(slug, index);

  const hasBrowserAiKey = Boolean(getBrowserGroqKey() || getBrowserOpenRouterKey());
  const hasAiKey = hasBrowserAiKey || Boolean(state.hasAiKey);

  // If chapter was translated via Google Translate fallback, and an AI API key is now active,
  // automatically re-translate for higher literary quality!
  const isFallback = Boolean(data.chapter.isGtxFallback || (data.chapter.translationProvider === "google-gtx" && data.chapter.isGtxFallback !== false));
  if (
    isFallback &&
    hasAiKey &&
    state.provider !== "google" &&
    data.chapter.status !== "translating"
  ) {
    console.log("✨ AI key detected for fallback chapter. Upgrading to literary AI translation...");
    toast("✨ AI key active: Upgrading chapter to high-quality AI translation…");
    startTranslation(slug, index, true);
    return;
  }

  const missing = data.chapter.paragraphs.some((p) => !p.en);
  if (missing && data.chapter.status !== "error") startTranslation(slug, index);
}

function renderReader(chapter, total, first) {
  const novel = state.novel;
  const hasPrev = chapter.index > 1;
  const hasNext = chapter.index < total || novel.chainMode;
  const totalPercent = total > 0 ? Math.round((chapter.index / total) * 100) : 0;

  $app.innerHTML = `
    <div class="reader">
      <div class="progress-line" id="progress" style="width:0"></div>
      <div class="reading-progress-track">
        <div class="reading-progress-fill" id="read-scroll-bar"></div>
      </div>
      <header class="topbar">
        <button class="back" id="back" title="Novel Details (B)">← <span class="label">Novel</span></button>
        <div class="titles">
          <div class="n" title="${esc(novel.title)}">${esc(novel.titleEn || novel.title)}</div>
          <div class="c" title="${esc(chapter.title)}">${esc(formatChapterTitle(chapter))}</div>
        </div>
        <div class="actions">
          <button id="mode-btn" title="Reading mode (M)">${modeLabel()}</button>
          <button id="copy-btn" title="Copy English text (C)">📋</button>
          <button id="history-btn" title="Reading history (H)">🕒</button>
          <button id="toc-btn" title="Chapters (T)">☰ <span class="label">Chapters</span></button>
          <button id="settings-btn" title="Settings (S)">⚙</button>
        </div>
      </header>

      <main class="page">
        <div class="chapter-head">
          <div class="kicker">Chapter ${chapter.index} of ${total} · ${totalPercent}% of novel</div>
          <h2>${esc(formatChapterTitle(chapter))}</h2>
          ${chapter.title && formatChapterTitle(chapter) !== chapter.title && state.mode !== "en" ? `<div class="orig-head">${esc(chapter.title)}</div>` : ""}
        </div>
        <div class="statusbar" id="statusbar"></div>
        <article id="article"></article>
      </main>

      <nav class="nav">
        <button id="prev" ${hasPrev ? "" : "disabled"}><span class="dir">‹</span> Previous</button>
        <button class="next" id="next" ${hasNext ? "" : "disabled"}>Next <span class="dir">›</span></button>
      </nav>

      <div class="scroll-hud" id="scroll-hud">0%</div>
    </div>

    <div class="scrim" id="scrim"></div>
    <aside class="drawer" id="drawer">
      <header>
        <h3 id="drawer-title">Chapters</h3>
        <button id="drawer-close">✕</button>
      </header>
      <div id="drawer-body"></div>
    </aside>`;

  paintArticle(chapter);
  paintStatus(chapter);

  document.getElementById("back").onclick = () => {
    location.hash = `#/novel/${encodeURIComponent(novel.slug)}`;
  };
  document.getElementById("prev").onclick = () => go(chapter.index - 1);
  document.getElementById("next").onclick = () => {
    // When advancing to next chapter, mark current chapter as read!
    api(`/api/novels/${encodeURIComponent(novel.slug)}/progress`, {
      method: "POST",
      body: { chapter: chapter.index, markRead: true },
    }).catch(() => {});
    go(chapter.index + 1);
  };
  document.getElementById("copy-btn").onclick = copyChapterText;
  document.getElementById("history-btn").onclick = () => openDrawer("history");
  document.getElementById("toc-btn").onclick = () => openDrawer("toc");
  document.getElementById("settings-btn").onclick = () => openDrawer("settings");
  document.getElementById("mode-btn").onclick = () => {
    state.mode = state.mode === "en" ? "both" : state.mode === "both" ? "zh" : "en";
    localStorage.setItem("nr.mode", state.mode);
    document.getElementById("mode-btn").textContent = modeLabel();
    paintArticle(state.chapter);
  };
  document.getElementById("scrim").onclick = closeDrawer;
  document.getElementById("drawer-close").onclick = closeDrawer;

  if (first && !localStorage.getItem(`nr.scroll.${novel.slug}.${chapter.index}`)) {
    window.scrollTo(0, 0);
  }
}

function modeLabel() {
  return state.mode === "en" ? "EN" : state.mode === "both" ? "双语" : "中文";
}

function go(index) {
  const total = state.toc.length;
  if (index < 1 || (index > total && !state.novel.chainMode)) return;
  location.hash = `#/n/${encodeURIComponent(state.novel.slug)}/${index}`;
}

function renderMarkdownInline(str) {
  if (!str) return "";
  let s = esc(str);

  // System & web novel brackets: 【...】 and [...]
  s = s.replace(/【(.*?)】/g, '<span class="sys-bracket">【$1】</span>');
  s = s.replace(/\[([A-Za-z0-9\u4e00-\u9fff\s\-_',:!?.]{2,60})\]/g, '<span class="sys-bracket">[$1]</span>');

  // Bold text for shouting, loud commands, anger: **text** -> <strong>text</strong>
  s = s.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');

  // Italics for sound effects, thoughts, emphasis: *text* -> <em>text</em>
  s = s.replace(/(?<!\*)\*(?!\*)(.*?)(?<!\*)\*(?!\*)/g, '<em>$1</em>');

  return s;
}

function formatParagraph(text) {
  if (!text) return "";
  const trimmed = text.trim();
  const html = renderMarkdownInline(trimmed);
  const isSys = /^(?:【|\[)/.test(trimmed) || /^(?:\"|“)?\s*(?:Ding!|Ding~|叮[！!])/i.test(trimmed);
  return `<p${isSys ? ' class="system-line"' : ''}>${html}</p>`;
}

function paintArticle(chapter) {
  const article = document.getElementById("article");
  if (!article || !chapter) return;
  const paras = chapter.paragraphs || [];
  const parts = [];

  for (const p of paras) {
    const en = p.en?.trim();
    const zh = p.zh?.trim();
    if (!zh && !en) continue;

    if (state.mode === "zh") {
      if (zh) parts.push(formatParagraph(zh));
      continue;
    }

    if (en) {
      parts.push(formatParagraph(en));
      if (state.mode === "both" && zh) {
        parts.push(`<p class="src">${renderMarkdownInline(zh)}</p>`);
      }
    } else if (zh) {
      parts.push(`<p class="src">${renderMarkdownInline(zh)}</p>`);
    }
  }

  article.innerHTML = parts.join("") || `<p class="src">No text in this chapter.</p>`;
}

function paintStatus(chapter, etaSec = null) {
  const bar = document.getElementById("statusbar");
  if (!bar) return;
  const total = chapter.paragraphs?.length || 0;
  const done = chapter.paragraphs?.filter((p) => p.en).length || 0;
  const status = chapter.status || "source";

  let etaStr = "";
  if (status === "translating" && etaSec !== null && etaSec > 0) {
    const m = Math.floor(etaSec / 60);
    const s = etaSec % 60;
    etaStr = m > 0 ? ` · ~${m}m ${s}s left` : ` · ~${s}s left`;
  }

  const hasBrowserAiKey = Boolean(getBrowserGroqKey() || getBrowserOpenRouterKey());
  const hasAiKey = hasBrowserAiKey || Boolean(state.hasAiKey);

  let doneHtml = `<span>Translated · ${total} paragraphs</span>`;
  if (status === "done") {
    if (chapter.isGtxFallback) {
      const upgradeBtn = (hasAiKey && state.provider !== "google")
        ? `<button id="btn-upgrade-ai" title="Upgrade this chapter from Google Translate fallback to literary AI">✨ Upgrade to AI</button>`
        : "";
      doneHtml = `<span class="badge-fallback" title="Translated via Google Translate fast fallback">⚡ Google Translate (Fallback)</span> <span>· ${total} paragraphs</span>${upgradeBtn}<button id="btn-retranslate" title="Re-translate this chapter">↻ Re-translate</button>`;
    } else if (chapter.translationProvider === "google-gtx") {
      doneHtml = `<span>🌐 Google Translate · ${total} paragraphs</span><button id="btn-retranslate" title="Re-translate this chapter">↻ Re-translate</button>`;
    } else {
      const pName = chapter.translationProvider === "groq" ? "Groq AI" : chapter.translationProvider === "openrouter" ? "OpenRouter AI" : "Literary AI";
      doneHtml = `<span>✨ ${pName} · ${total} paragraphs</span><button id="btn-retranslate" title="Re-translate this chapter">↻ Re-translate</button>`;
    }
  }

  const labels = {
    source: "Not translated",
    translating: `Translating ${done}/${total}${etaStr}`,
    done: doneHtml,
    error: chapter.error ? `Failed: ${chapter.error}` : "Translation failed",
    partial: "Partially translated",
  };
  bar.innerHTML = `<span class="dot ${status}"></span><span class="${status === "error" ? "error-text" : ""}">${status === "done" ? doneHtml : (labels[status] || status)}</span>${
    status === "source" ? `<button id="translate-now" style="padding:4px 10px;font-size:12px">Translate</button>` : ""
  }${status === "error" ? `<button id="retry-now" style="padding:4px 10px;font-size:12px">Retry</button>` : ""}`;

  const progress = document.getElementById("progress");
  if (progress) {
    progress.style.width = status === "translating" && total ? `${Math.round((done / total) * 100)}%` : status === "done" ? "100%" : "0";
  }

  const now = document.getElementById("translate-now") || document.getElementById("retry-now");
  if (now) now.onclick = () => startTranslation(state.novel.slug, chapter.index, true);

  const upgradeBtn = document.getElementById("btn-upgrade-ai");
  if (upgradeBtn) upgradeBtn.onclick = () => {
    toast("Upgrading chapter to high-quality AI translation…");
    startTranslation(state.novel.slug, chapter.index, true);
  };

  const retransBtn = document.getElementById("btn-retranslate");
  if (retransBtn) retransBtn.onclick = () => {
    toast("Re-translating chapter…");
    startTranslation(state.novel.slug, chapter.index, true);
  };
}

async function startTranslation(slug, index, force = false) {
  if (state.timer && !force) return;
  stopPolling();
  try {
    await api(`/api/novels/${encodeURIComponent(slug)}/chapter/${index}/translate`, {
      method: "POST",
      body: { force, provider: state.provider },
    });
    if (state.chapter) {
      state.chapter.status = "translating";
      paintStatus(state.chapter);
    }
  } catch (err) {
    toast(err.message, true);
    return;
  }

  let lastCount = -1;
  let idle = 0;
  let pollMs = 1000;
  const POLL_MAX = 3000;
  let translationStart = Date.now();

  const tick = async () => {
    try {
      const data = await api(`/api/novels/${encodeURIComponent(slug)}/chapter/${index}`);
      const chapter = data.chapter;
      const count = chapter.paragraphs.filter((p) => p.en).length;
      state.chapter = chapter;
      state.statuses[index] = chapter.status;
      paintArticle(chapter);

      // Live Update: Update chapter title in topbar and chapter-head dynamically!
      const dispTitle = formatChapterTitle(chapter);
      const topbarTitleEl = document.querySelector(".topbar .titles .c");
      if (topbarTitleEl && topbarTitleEl.textContent !== dispTitle) {
        topbarTitleEl.textContent = dispTitle;
      }
      const headTitleEl = document.querySelector(".chapter-head h2");
      if (headTitleEl && headTitleEl.textContent !== dispTitle) {
        headTitleEl.textContent = dispTitle;
      }
      if (chapter.titleEn && !/[\u4e00-\u9fff]/.test(chapter.titleEn)) {
        document.title = `${dispTitle} · ${state.novel?.titleEn || state.novel?.title || "Reader"}`;
        if (state.toc?.[index - 1]) {
          state.toc[index - 1].titleEn = chapter.titleEn;
        }
      }
      if (state.novel?.titleEn) {
        const topbarNovelEl = document.querySelector(".topbar .titles .n");
        if (topbarNovelEl && topbarNovelEl.textContent !== state.novel.titleEn) {
          topbarNovelEl.textContent = state.novel.titleEn;
        }
      }

      const elapsed = (Date.now() - translationStart) / 1000;
      const rate = elapsed > 5 ? count / elapsed : 0;
      const remaining = chapter.paragraphs.length - count;
      const etaSec = rate > 0 ? Math.round(remaining / rate) : null;
      paintStatus(chapter, etaSec);

      if (count === lastCount) {
        idle += 1;
        pollMs = Math.min(pollMs + 400, POLL_MAX);
      } else {
        idle = 0;
        pollMs = 1000;
      }
      lastCount = count;

      if (chapter.status === "done" || chapter.status === "error") {
        stopPolling();
        if (chapter.status === "error") toast(chapter.error || "Translation failed", true);
      } else if (idle > 120) {
        stopPolling();
        toast("Translation looks stalled. Tap Translate to retry.", true);
      } else {
        state.timer = setTimeout(tick, pollMs);
      }
    } catch {
      state.timer = setTimeout(tick, pollMs);
    }
  };

  state.timer = setTimeout(tick, 600);
}

/* ------------------------------------------------------------------ drawer */

function formatChapterTitle(c) {
  if (c.titleEn) return c.titleEn;
  const raw = c.title || "";
  const m = raw.match(/^第\s*([0-9零一二三四五六七八九十百千万两〇]+)\s*[章节回卷话集篇][:：\s]*(.*)$/);
  if (m) {
    const rest = m[2].trim();
    return rest ? `Chapter ${c.index}: ${rest}` : `Chapter ${c.index}`;
  }
  if (/^楔子/i.test(raw)) return raw.replace(/^楔子[:：\s]*/, "Prologue: ");
  if (/^尾声/i.test(raw)) return raw.replace(/^尾声[:：\s]*/, "Epilogue: ");
  if (/^番外/i.test(raw)) return raw.replace(/^番外[:：\s]*/, "Extra: ");
  if (/^大结局/i.test(raw)) return raw.replace(/^大结局[:：\s]*/, "Grand Finale: ");
  return raw;
}

async function openDrawer(kind) {
  const drawer = document.getElementById("drawer");
  const scrim = document.getElementById("scrim");
  const title = document.getElementById("drawer-title");
  const body = document.getElementById("drawer-body");
  if (!drawer) return;

  if (kind === "toc") {
    title.textContent = `Chapters · ${state.toc.length}`;
    body.className = "toc-drawer-wrapper";
    body.innerHTML = `
      <div class="toc-toolbar">
        <input type="search" class="toc-search-input" id="toc-filter" placeholder="🔍 Search title or enter chapter #..." autocomplete="off" />
      </div>
      <div class="toc-list" id="toc-items-container">
        ${
          state.toc
            .map((c) => {
              const status = state.statuses[c.index] || "";
              const disp = formatChapterTitle(c);
              return `<button class="toc-item ${c.index === state.chapter?.index ? "active" : ""}" data-chapter="${c.index}">
                <span class="num">${c.index}</span>
                <span class="t-wrapper">
                  <span class="t">${esc(disp)}</span>
                  ${c.title && disp !== c.title ? `<span class="t-orig">${esc(c.title)}</span>` : ""}
                </span>
                <span class="dot ${status}"></span>
              </button>`;
            })
            .join("") || `<div class="empty">No chapters</div>`
        }
      </div>
      <div class="toc-footer">
        <button id="translate-titles-btn" style="width:100%;border:1px solid var(--line);background:var(--bg-sub, transparent);cursor:pointer">⚡ Translate Next 50 Titles (1 AI Call)</button>
        <button id="refresh-toc-btn" style="width:100%;border:1px solid var(--line);background:var(--bg-sub, transparent);cursor:pointer">🔄 Refresh TOC / Fetch All Chapters</button>
        <div style="display:flex;gap:6px;align-items:center">
          <select id="toc-batch-count" style="padding:7px;border-radius:6px;border:1px solid var(--line);background:var(--bg);color:var(--ink);font-size:12px;flex-shrink:0" title="Number of chapters to translate">
            ${[1, 3, 5, 10, 20].map((n) => `<option value="${n}" ${state.batchCount === n ? "selected" : ""}>Next ${n} Ch</option>`).join("")}
          </select>
          <button id="batch" style="flex:1;padding:8px;font-size:12.5px;font-weight:600">⚡ Auto-Translate</button>
          <button id="stop-queue-btn" style="padding:8px 10px;font-size:12.5px;color:var(--err);border-color:color-mix(in srgb, var(--err) 35%, transparent);cursor:pointer" title="Stop translation queue">⏹ Stop</button>
        </div>
      </div>`;

    // Single smart search bar: real-time filter + press Enter to jump to chapter number or first match
    const filterInput = document.getElementById("toc-filter");
    const container = document.getElementById("toc-items-container");

    filterInput.oninput = () => {
      const q = filterInput.value.trim().toLowerCase();
      container.querySelectorAll(".toc-item").forEach((item) => {
        const text = item.textContent.toLowerCase();
        item.style.display = !q || text.includes(q) ? "" : "none";
      });
    };

    filterInput.onkeydown = (e) => {
      if (e.key === "Enter") {
        const val = filterInput.value.trim();
        const chNum = parseInt(val, 10);
        // If user typed a number like "45", jump straight to chapter 45!
        if (!isNaN(chNum) && chNum >= 1 && chNum <= state.toc.length) {
          closeDrawer();
          go(chNum);
          return;
        }
        // Otherwise, jump to the first visible search result
        const firstVisible = container.querySelector('.toc-item:not([style*="display: none"])');
        if (firstVisible) {
          closeDrawer();
          go(Number(firstVisible.dataset.chapter));
        }
      }
    };

    // Item click
    container.querySelectorAll("[data-chapter]").forEach((el) => {
      el.onclick = () => {
        closeDrawer();
        go(Number(el.dataset.chapter));
      };
    });

    // Auto-scroll to active chapter
    requestAnimationFrame(() => {
      const activeEl = container.querySelector(".toc-item.active");
      if (activeEl) activeEl.scrollIntoView({ block: "center", behavior: "auto" });
    });

    // Translate next 50 titles button
    const translateTitlesBtn = document.getElementById("translate-titles-btn");
    if (translateTitlesBtn) {
      translateTitlesBtn.onclick = async () => {
        translateTitlesBtn.disabled = true;
        translateTitlesBtn.textContent = "Translating 50 titles in 1 call…";
        try {
          const from = state.chapter?.index || 1;
          const res = await api(`/api/novels/${encodeURIComponent(state.novel.slug)}/toc/translate-titles`, {
            method: "POST",
            body: { from, count: 50 },
          });
          if (res.toc) state.toc = res.toc;
          toast(`Translated 50 chapter titles in 1 AI call ✓`);
          openDrawer("toc");
        } catch (err) {
          toast(err.message, true);
          translateTitlesBtn.disabled = false;
          translateTitlesBtn.textContent = "⚡ Translate Next 50 Titles (1 AI Call)";
        }
      };
    }

    // Refresh TOC button
    const refreshTocBtn = document.getElementById("refresh-toc-btn");
    if (refreshTocBtn) {
      refreshTocBtn.onclick = async () => {
        refreshTocBtn.disabled = true;
        refreshTocBtn.textContent = "Fetching all chapters…";
        try {
          const res = await api(`/api/novels/${encodeURIComponent(state.novel.slug)}/toc/refresh`, { method: "POST" });
          if (res.ok) {
            state.toc = res.toc;
            toast(`TOC Updated: Found ${res.chapterCount} total chapters ✓`);
            openDrawer("toc");
          } else {
            toast(`Current chapters: ${res.chapterCount}`);
          }
        } catch (err) {
          toast(err.message, true);
        } finally {
          refreshTocBtn.disabled = false;
          refreshTocBtn.textContent = "🔄 Refresh TOC / Fetch All Chapters";
        }
      };
    }

    // Batch translate chapters
    const batchBtn = document.getElementById("batch");
    const stopQueueBtn = document.getElementById("stop-queue-btn");
    const tocBatchCount = document.getElementById("toc-batch-count");

    if (tocBatchCount) {
      tocBatchCount.onchange = () => {
        state.batchCount = Number(tocBatchCount.value);
        localStorage.setItem("nr.batchCount", state.batchCount);
      };
    }

    if (batchBtn) {
      batchBtn.onclick = async () => {
        const count = Number(tocBatchCount?.value || state.batchCount || 5);
        state.batchCount = count;
        localStorage.setItem("nr.batchCount", count);
        const from = (state.chapter?.index || 1) + 1;
        batchBtn.disabled = true;
        batchBtn.textContent = "Queueing…";
        try {
          const res = await api(`/api/novels/${encodeURIComponent(state.novel.slug)}/translate-range`, {
            method: "POST",
            body: { from, count },
          });
          toast(`Queued next ${res.count} chapter(s) (${from}–${from + res.count - 1}) ✓`);
        } catch (err) {
          toast(err.message, true);
        } finally {
          batchBtn.disabled = false;
          batchBtn.textContent = "⚡ Auto-Translate";
        }
      };
    }

    if (stopQueueBtn) {
      stopQueueBtn.onclick = async () => {
        try {
          const res = await api(`/api/novels/${encodeURIComponent(state.novel.slug)}/cancel-translate`, { method: "POST" });
          toast(`Translation queue stopped (${res.cancelled} queued jobs cancelled) ✓`);
        } catch (err) {
          toast(err.message, true);
        }
      };
    }
  } else if (kind === "history") {
    title.textContent = "Reading History";
    body.className = "history-list";
    body.innerHTML = `<div class="empty">Loading history…</div>`;

    try {
      const { history } = await api("/api/history");
      if (!history || !history.length) {
        body.innerHTML = `<div class="empty">No reading history yet. Read any chapter to track your history!</div>`;
      } else {
        body.innerHTML = history
          .map(
            (h) => `
            <a class="history-item" href="#/n/${encodeURIComponent(h.slug)}/${h.chapterIndex}">
              <div class="history-cover-wrap">
                <img class="history-cover" src="/api/novels/${encodeURIComponent(h.slug)}/cover" onerror="this.style.display='none';this.nextElementSibling.style.display='flex';" />
                <div class="card-cover-fallback" style="display:none;font-size:16px">${esc((h.title || "📖").slice(0, 1))}</div>
              </div>
              <div class="history-content">
                <div class="history-n-title">${esc(h.titleEn || h.title)}</div>
                <div class="history-ch-title">${esc(h.chapterTitleEn || h.chapterTitle || `Chapter ${h.chapterIndex}`)}</div>
                <div class="history-time">
                  <span>${esc(timeAgo(h.readAt))}</span>
                  <span class="history-badge">Ch. ${h.chapterIndex}</span>
                </div>
              </div>
            </a>`,
          )
          .join("");

        body.insertAdjacentHTML(
          "beforeend",
          `<div style="padding:16px 8px 8px">
            <button id="clear-history-btn" style="width:100%;color:var(--err);border-color:color-mix(in srgb, var(--err) 35%, transparent)">Clear reading history</button>
          </div>`,
        );

        body.querySelectorAll(".history-item").forEach((el) => {
          el.onclick = () => closeDrawer();
        });

        document.getElementById("clear-history-btn").onclick = async () => {
          if (!confirm("Clear your entire reading history?")) return;
          try {
            await api("/api/history", { method: "DELETE" });
            toast("Reading history cleared");
            openDrawer("history");
          } catch (err) {
            toast(err.message, true);
          }
        };
      }
    } catch (err) {
      body.innerHTML = `<div class="empty">${esc(err.message)}</div>`;
    }
  } else if (kind === "shortcuts") {
    title.textContent = "Keyboard Shortcuts";
    body.className = "shortcuts-list";
    body.innerHTML = `
      <div class="shortcut-row"><span>Previous Chapter</span><div><kbd>←</kbd> or <kbd>A</kbd></div></div>
      <div class="shortcut-row"><span>Next Chapter</span><div><kbd>→</kbd> or <kbd>D</kbd></div></div>
      <div class="shortcut-row"><span>Chapters (TOC)</span><kbd>T</kbd></div>
      <div class="shortcut-row"><span>Reading History</span><kbd>H</kbd></div>
      <div class="shortcut-row"><span>Settings &amp; Theme</span><kbd>S</kbd></div>
      <div class="shortcut-row"><span>Reading Mode (EN/Both/ZH)</span><kbd>M</kbd></div>
      <div class="shortcut-row"><span>Return to Library</span><kbd>B</kbd></div>
      <div class="shortcut-row"><span>Copy English Text</span><kbd>C</kbd></div>
      <div class="shortcut-row"><span>Shortcuts Help</span><kbd>?</kbd></div>
      <div class="shortcut-row"><span>Close Open Drawer</span><kbd>Esc</kbd></div>
    `;
  } else {
    title.textContent = "Settings";
    body.className = "settings";
    body.innerHTML = `
      <div class="field">
        <label>Reading mode</label>
        <div class="seg" id="seg-mode">
          ${["en", "both", "zh"].map((m) => `<button data-mode="${m}" class="${state.mode === m ? "on" : ""}">${m === "en" ? "English" : m === "both" ? "Bilingual" : "中文"}</button>`).join("")}
        </div>
      </div>
      <div class="field">
        <label>Theme</label>
        <div class="seg" id="seg-theme">
          <button data-theme="light" class="${state.theme === "light" ? "on" : ""}">Paper</button>
          <button data-theme="sepia" class="${state.theme === "sepia" ? "on" : ""}">Sepia</button>
          <button data-theme="dark" class="${state.theme === "dark" ? "on" : ""}">Night</button>
        </div>
      </div>
      <div class="field">
        <label>Font</label>
        <div class="seg" id="seg-font">
          <button data-font="serif" class="${state.font === "serif" ? "on" : ""}">Serif</button>
          <button data-font="sans" class="${state.font === "sans" ? "on" : ""}">Sans</button>
          <button data-font="mono" class="${state.font === "mono" ? "on" : ""}">Mono</button>
        </div>
      </div>
      <div class="field">
        <label>Text size</label>
        <div class="row"><span>${state.size}px</span><input type="range" id="size" min="16" max="28" step="1" value="${state.size}" /></div>
      </div>
      <div class="field">
        <label>Page width</label>
        <div class="seg" id="seg-width">
          <button data-width="620" class="${state.width === 620 ? "on" : ""}">Compact</button>
          <button data-width="720" class="${state.width === 720 ? "on" : ""}">Default</button>
          <button data-width="900" class="${state.width === 900 ? "on" : ""}">Wide</button>
          <button data-width="1100" class="${state.width === 1100 ? "on" : ""}">Full</button>
        </div>
      </div>
      <div class="field">
        <label>Line Spacing</label>
        <div class="seg" id="seg-leading">
          <button data-leading="1.5" class="${state.leading === "1.5" ? "on" : ""}">Compact</button>
          <button data-leading="1.78" class="${state.leading === "1.78" ? "on" : ""}">Normal</button>
          <button data-leading="2.1" class="${state.leading === "2.1" ? "on" : ""}">Relaxed</button>
        </div>
      </div>
      <div class="field">
        <label>Offline &amp; Export</label>
        <div style="display:flex;gap:8px">
          <button id="copy-setting-btn" style="flex:1">📋 Copy English</button>
          <button id="export-txt-btn" style="flex:1">💾 Save .txt</button>
        </div>
      </div>
      <div class="field">
        <label>Auto-Translate Ahead (Save Tokens)</label>
        <div class="field-hint">
          Prefetches up to N chapters ahead while reading. Won't translate beyond this limit to avoid wasting tokens if you leave the novel.
        </div>
        <div class="seg" id="seg-prefetch">
          <button data-prefetch="0" class="${state.prefetch === 0 ? "on" : ""}">Off (0)</button>
          <button data-prefetch="1" class="${state.prefetch === 1 ? "on" : ""}">1 Ch</button>
          <button data-prefetch="2" class="${state.prefetch === 2 ? "on" : ""}">2 Ch</button>
          <button data-prefetch="3" class="${state.prefetch === 3 ? "on" : ""}">3 Ch</button>
          <button data-prefetch="5" class="${state.prefetch === 5 ? "on" : ""}">5 Ch</button>
          <button data-prefetch="10" class="${state.prefetch === 10 ? "on" : ""}">10 Ch</button>
        </div>
      </div>
      <div class="field">
        <label>Batch Auto-Translate (Finite Limit)</label>
        <div class="field-hint">
          Translate consecutive chapters one after another. Automatically stops at the chosen limit.
        </div>
        <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px">
          <label style="font-size:12px;color:var(--ink);margin-bottom:0;text-transform:none">Translate next:</label>
          <select id="settings-batch-count" style="padding:6px 10px;font-size:13px;border-radius:8px;border:1px solid var(--line);background:var(--bg);color:var(--ink);flex:1">
            ${[1, 3, 5, 10, 20].map((n) => `<option value="${n}" ${state.batchCount === n ? "selected" : ""}>${n} chapter${n > 1 ? "s" : ""}</option>`).join("")}
          </select>
        </div>
        <div style="display:flex;gap:8px">
          <button id="settings-start-batch-btn" style="flex:2;padding:10px;font-size:13px;font-weight:600;background:var(--accent);color:#fff;border:none;border-radius:8px;cursor:pointer">⚡ Start Auto-Translate</button>
          <button id="settings-stop-batch-btn" style="flex:1;padding:10px;font-size:13px;color:var(--err);border-color:color-mix(in srgb, var(--err) 35%, transparent);border-radius:8px;cursor:pointer">⏹ Stop Queue</button>
        </div>
        <div id="settings-queue-status" style="font-size:12px;color:var(--ink-soft);margin-top:6px"></div>
      </div>
      <div class="field">
        <label>Translation Provider</label>
        <div class="seg" id="seg-provider">
          <button data-provider="groq" class="${state.provider === "groq" ? "on" : ""}">⚡ Groq (AI)</button>
          <button data-provider="openrouter" class="${state.provider === "openrouter" ? "on" : ""}">🌐 OpenRouter (AI)</button>
          <button data-provider="google" class="${state.provider === "google" ? "on" : ""}">🚀 Google (Free)</button>
        </div>
        <div class="field-hint" id="provider-hint" style="margin-top:6px;font-size:12px;color:var(--ink-soft)"></div>
      </div>
      <div class="field" id="model-field">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:7px">
          <label style="margin-bottom:0">Translation model</label>
          <button id="refresh-models-btn" style="padding:2px 8px;font-size:11.5px;border-radius:6px;cursor:pointer" title="Benchmark live models dynamically">⚡ Benchmark</button>
        </div>
        <select id="model"><option>Loading live models…</option></select>
      </div>
      <div class="field" id="api-key-field">
        <label id="api-key-label">${state.provider === "groq" ? "Groq API key" : "OpenRouter API key"}</label>
        <div class="api-key-row" id="api-key-row">
          <span class="api-key-status" id="api-key-status">Checking…</span>
        </div>
        <div class="api-key-form" id="api-key-form" style="display:none">
          <input type="password" id="api-key-input" placeholder="${state.provider === "groq" ? "gsk_…" : "sk-or-v1-…"}" autocomplete="off" spellcheck="false" />
          <div class="api-key-actions">
            <button id="api-key-save">Save key</button>
            <button id="api-key-cancel" style="color:var(--ink-soft)">Cancel</button>
          </div>
        </div>
      </div>
      <div class="field">
        <label>Glossary</label>
        <button id="glossary-btn" style="width:100%">Extract names &amp; terms from chapter 1</button>
      </div>
      <div class="health" id="health">Checking connection…</div>
      <div class="field" style="border-top:1px solid var(--line);padding-top:14px;margin-top:8px">
        <button id="open-shortcuts-btn" style="width:100%;font-size:13px">❓ View Keyboard Shortcuts</button>
      </div>
      <div class="field" style="border-top:1px solid var(--line);padding-top:16px;margin-top:12px">
        <label style="color:var(--err)">Danger Zone</label>
        <button id="delete-novel-btn" style="width:100%;color:var(--err);border-color:color-mix(in srgb, var(--err) 35%, transparent)">Delete this novel from library</button>
      </div>`;

    document.getElementById("open-shortcuts-btn").onclick = () => openDrawer("shortcuts");
    document.getElementById("copy-setting-btn").onclick = copyChapterText;
    document.getElementById("export-txt-btn").onclick = exportChapterTxt;

    body.querySelectorAll("[data-mode]").forEach((el) => {
      el.onclick = () => {
        state.mode = el.dataset.mode;
        localStorage.setItem("nr.mode", state.mode);
        document.getElementById("mode-btn").textContent = modeLabel();
        paintArticle(state.chapter);
        body.querySelectorAll("[data-mode]").forEach((b) => b.classList.toggle("on", b === el));
      };
    });

    body.querySelectorAll("[data-theme]").forEach((el) => {
      el.onclick = () => {
        state.theme = el.dataset.theme;
        localStorage.setItem("nr.theme", state.theme);
        document.documentElement.dataset.theme = state.theme;
        body.querySelectorAll("[data-theme]").forEach((b) => b.classList.toggle("on", b === el));
      };
    });

    body.querySelectorAll("[data-font]").forEach((el) => {
      el.onclick = () => {
        state.font = el.dataset.font;
        localStorage.setItem("nr.font", state.font);
        document.documentElement.dataset.font = state.font;
        body.querySelectorAll("[data-font]").forEach((b) => b.classList.toggle("on", b === el));
      };
    });

    document.getElementById("size").oninput = (event) => {
      state.size = Number(event.target.value);
      localStorage.setItem("nr.size", state.size);
      document.documentElement.style.setProperty("--size", `${state.size}px`);
      event.target.closest(".row").querySelector("span").textContent = `${state.size}px`;
    };

    body.querySelectorAll("[data-width]").forEach((el) => {
      el.onclick = () => {
        state.width = Number(el.dataset.width);
        localStorage.setItem("nr.width", state.width);
        document.documentElement.style.setProperty("--page-width", `${state.width}px`);
        body.querySelectorAll("[data-width]").forEach((b) => b.classList.toggle("on", b === el));
      };
    });

    body.querySelectorAll("[data-leading]").forEach((el) => {
      el.onclick = () => {
        state.leading = el.dataset.leading;
        localStorage.setItem("nr.leading", state.leading);
        document.documentElement.style.setProperty("--leading", state.leading);
        body.querySelectorAll("[data-leading]").forEach((b) => b.classList.toggle("on", b === el));
      };
    });

    body.querySelectorAll("[data-prefetch]").forEach((el) => {
      el.onclick = async () => {
        const val = Number(el.dataset.prefetch);
        state.prefetch = val;
        localStorage.setItem("nr.prefetch", val);
        body.querySelectorAll("[data-prefetch]").forEach((b) => b.classList.toggle("on", b === el));
        try {
          await api("/api/config", { method: "POST", body: { prefetch: val } });
          toast(val === 0 ? "Auto-translate ahead turned Off (0 chapters)" : `Auto-translate ahead set to ${val} chapter${val > 1 ? "s" : ""}`);
        } catch (err) {
          toast(err.message, true);
        }
      };
    });

    const startBatchBtn = document.getElementById("settings-start-batch-btn");
    const stopBatchBtn = document.getElementById("settings-stop-batch-btn");
    const batchSelect = document.getElementById("settings-batch-count");
    const queueStatus = document.getElementById("settings-queue-status");

    const refreshQueueStatus = async () => {
      if (!queueStatus) return;
      try {
        const { jobs } = await api("/api/jobs");
        const novelSlug = state.novel?.slug;
        const novelJobs = novelSlug ? jobs.filter((j) => j.slug === novelSlug) : jobs;
        const running = novelJobs.filter((j) => j.status === "running").length;
        const queued = novelJobs.filter((j) => j.status === "queued").length;
        if (running > 0 || queued > 0) {
          queueStatus.innerHTML = `⏳ <strong>${running}</strong> translating, <strong>${queued}</strong> queued in line.`;
        } else {
          queueStatus.textContent = "Queue idle (no chapters translating).";
        }
      } catch {}
    };

    refreshQueueStatus();

    if (batchSelect) {
      batchSelect.onchange = () => {
        state.batchCount = Number(batchSelect.value);
        localStorage.setItem("nr.batchCount", state.batchCount);
      };
    }

    if (startBatchBtn) {
      startBatchBtn.onclick = async () => {
        if (!state.novel?.slug) return toast("Open a novel first to batch translate", true);
        const count = Number(batchSelect?.value || state.batchCount || 5);
        state.batchCount = count;
        localStorage.setItem("nr.batchCount", count);
        const from = (state.chapter?.index || state.novel?.lastChapter || 1) + (state.chapter ? 1 : 0);
        startBatchBtn.disabled = true;
        startBatchBtn.textContent = "Queueing…";
        try {
          const res = await api(`/api/novels/${encodeURIComponent(state.novel.slug)}/translate-range`, {
            method: "POST",
            body: { from, count },
          });
          toast(`Queued next ${res.count} chapter(s) (${from}–${from + res.count - 1}) ✓`);
          await refreshQueueStatus();
        } catch (err) {
          toast(err.message, true);
        } finally {
          startBatchBtn.disabled = false;
          startBatchBtn.textContent = "⚡ Start Auto-Translate";
        }
      };
    }

    if (stopBatchBtn) {
      stopBatchBtn.onclick = async () => {
        try {
          const res = state.novel?.slug
            ? await api(`/api/novels/${encodeURIComponent(state.novel.slug)}/cancel-translate`, { method: "POST" })
            : await api("/api/jobs/cancel", { method: "POST", body: {} });
          toast(`Translation queue stopped (${res.cancelled} queued jobs cancelled) ✓`);
          await refreshQueueStatus();
        } catch (err) {
          toast(err.message, true);
        }
      };
    }

    const updateProviderHint = () => {
      const hintEl = document.getElementById("provider-hint");
      const modelField = document.getElementById("model-field");
      if (state.provider === "google") {
        if (hintEl) hintEl.textContent = "Instant translation via Google Translate (GTX). Free, unlimited, and no API key required.";
        if (modelField) modelField.style.display = "none";
      } else if (state.provider === "openrouter") {
        if (hintEl) hintEl.textContent = "Multi-model literary AI (DeepSeek, Qwen). Automatically falls back to Google Translate if key is missing.";
        if (modelField) modelField.style.display = "";
      } else {
        if (hintEl) hintEl.textContent = "Ultra-fast literary AI. If no Groq key is present, automatically falls back to Google Translate.";
        if (modelField) modelField.style.display = "";
      }
    };
    updateProviderHint();

    body.querySelectorAll("[data-provider]").forEach((el) => {
      el.onclick = async () => {
        const prov = el.dataset.provider;
        if (state.provider === prov) return;
        state.provider = prov;
        localStorage.setItem("nr.provider", prov);
        body.querySelectorAll("[data-provider]").forEach((b) => b.classList.toggle("on", b === el));
        updateProviderHint();

        if (prov !== "google") {
          const targetModel =
            prov === "groq"
              ? { providerID: "groq", id: "groq/auto" }
              : { providerID: "openrouter", id: "openrouter/free" };
          if (state.novel) {
            state.novel.model = targetModel;
            api(`/api/novels/${encodeURIComponent(state.novel.slug)}`, {
              method: "PATCH",
              body: { model: targetModel },
            }).catch(() => {});
          }
          await loadModels();
        }

        loadApiKeyStatus();
        loadHealth();
        toast(`Switched provider to ${prov === "groq" ? "Groq (AI)" : prov === "openrouter" ? "OpenRouter (AI)" : "Google Translate (Free)"}`);
      };
    });

    document.getElementById("refresh-models-btn").onclick = async () => {
      const btn = document.getElementById("refresh-models-btn");
      btn.disabled = true;
      btn.textContent = "Benchmarking…";
      try {
        await loadModels(true);
        loadHealth();
        toast("Models dynamically evaluated & ranked ✓");
      } catch (err) {
        toast(err.message, true);
      } finally {
        btn.disabled = false;
        btn.textContent = "⚡ Benchmark";
      }
    };

    loadModels();
    loadHealth();
    loadApiKeyStatus();

    document.getElementById("glossary-btn").onclick = async (event) => {
      const btn = event.target;
      btn.disabled = true;
      btn.textContent = "Extracting…";
      try {
        const data = await api(`/api/novels/${encodeURIComponent(state.novel.slug)}/glossary`, { method: "PUT" });
        toast(`Glossary: ${data.terms.length} terms saved`);
        btn.textContent = `Re-extract (${data.terms.length} terms)`;
      } catch (err) {
        toast(err.message, true);
        btn.textContent = "Extract names & terms from chapter 1";
      }
      btn.disabled = false;
    };

    const delBtn = document.getElementById("delete-novel-btn");
    if (delBtn) {
      delBtn.onclick = async () => {
        const title = state.novel?.title || "this novel";
        if (!confirm(`Delete "${title}" and all its chapters from your library? This cannot be undone.`)) {
          return;
        }
        delBtn.disabled = true;
        delBtn.textContent = "Deleting…";
        try {
          await api(`/api/novels/${encodeURIComponent(state.novel.slug)}`, { method: "DELETE" });
          toast(`Deleted "${title}"`);
          closeDrawer();
          location.hash = "#/";
        } catch (err) {
          toast(err.message, true);
          delBtn.disabled = false;
          delBtn.textContent = "Delete this novel from library";
        }
      };
    }
  }

  drawer.classList.add("open");
  scrim.classList.add("open");
}

function closeDrawer() {
  document.getElementById("drawer")?.classList.remove("open");
  document.getElementById("scrim")?.classList.remove("open");
}

async function loadModels(force = false) {
  if (state.provider === "google") return;
  const select = document.getElementById("model");
  if (!select) return;
  try {
    select.innerHTML = "<option>Loading live models…</option>";
    const data = await api(`/api/models?provider=${state.provider}&refresh=${force ? "true" : "false"}`);
    const models = state.provider === "groq" ? data.groqModels || [] : data.openrouterModels || [];
    state.models = models;

    if (!models.length) {
      select.innerHTML = `<option value="">No ${state.provider} models found (check API key)</option>`;
      return;
    }

    const current = state.novel?.model;
    select.innerHTML = models
      .map((m) => {
        const isSel = current
          ? current.providerID === m.providerID && current.id === m.id
          : m.id === "groq/auto" || m.id === "openrouter/free";
        return `<option value="${esc(m.providerID)}|${esc(m.id)}" ${isSel ? "selected" : ""}>${esc(m.name)}${m.free ? " · free" : ""}</option>`;
      })
      .join("");

    select.onchange = async () => {
      const [providerID, id] = select.value.split("|");
      try {
        await api(`/api/novels/${encodeURIComponent(state.novel.slug)}`, {
          method: "PATCH",
          body: { model: { providerID, id } },
        });
        state.novel.model = { providerID, id };
        toast("Model updated for this novel");
      } catch (err) {
        toast(err.message, true);
      }
    };
  } catch (err) {
    select.innerHTML = `<option>${esc(err.message)}</option>`;
  }
}

async function loadHealth() {
  const el = document.getElementById("health");
  if (!el) return;
  try {
    const health = await api("/api/health");
    state.health = health;
    if (state.provider === "google") {
      el.innerHTML = `<span style="color:var(--ok,#3f7a52)">● Google Translate: Ready (Instant &amp; Free, No API key needed)</span>`;
      return;
    }
    if (state.provider === "groq") {
      if (health.groq?.available) {
        const l = health.groq.limits;
        let quotaInfo = "";
        if (l?.remainingRequests !== null && l?.limitRequests) {
          quotaInfo = ` · Quota: ${l.remainingRequests}/${l.limitRequests} reqs`;
        }
        const activeModel = health.groq.activeModel || health.groq.bestModel || "auto";
        el.innerHTML = `<span style="color:var(--ok,#3f7a52)">● Groq: Auto Ready (Active: ${esc(activeModel)}${quotaInfo})</span>`;
      } else {
        el.innerHTML = `<span style="color:var(--warn)">● Groq: No API key (Auto-falling back to Google Translate)</span>`;
      }
    } else {
      if (health.openrouter?.available) {
        if (health.openrouter?.exhausted) {
          const q = health.openrouter?.limits?.freeDaily;
          el.innerHTML = `<span style="color:var(--warn)">● OpenRouter: Free limit reached (Auto-falling back to Google Translate)</span>`;
        } else {
          el.innerHTML = `<span style="color:var(--ok,#3f7a52)">● OpenRouter: Ready</span>`;
        }
      } else {
        el.innerHTML = `<span style="color:var(--warn)">● OpenRouter: No key (Auto-falling back to Google Translate)</span>`;
      }
    }
  } catch (err) {
    el.textContent = err.message;
  }
}

/* --------------------------------------------------------------- api key UI */

function loadApiKeyStatus() {
  const rowEl = document.getElementById("api-key-row");
  const formEl = document.getElementById("api-key-form");
  const labelEl = document.getElementById("api-key-label");
  if (!rowEl || !formEl) return;

  if (state.provider === "google") {
    if (labelEl) labelEl.textContent = "Google Translate Status";
    rowEl.innerHTML = `
      <div class="provider-info-box" style="width:100%">
        <div style="color:var(--ok,#3f7a52);font-weight:600;margin-bottom:4px">✓ Ready · No API Key Needed</div>
        <div style="color:var(--ink-soft)">Google Translate (GTX) translates chapters instantly in parallel batches. Free, unlimited, and requires zero setup.</div>
      </div>`;
    formEl.style.display = "none";
    return;
  }

  const isGroq = state.provider === "groq";
  if (labelEl) labelEl.textContent = isGroq ? "Groq API key" : "OpenRouter API key";
  const inputEl = formEl.querySelector("#api-key-input");
  if (inputEl) inputEl.placeholder = isGroq ? "gsk_…" : "sk-or-v1-…";

  function masked(key) {
    if (!key) return null;
    return `${key.slice(0, 8)}${"•".repeat(Math.max(0, key.length - 12))}${key.slice(-4)}`;
  }

  function renderStatus() {
    const browserKey = isGroq ? getBrowserGroqKey() : getBrowserOpenRouterKey();
    rowEl.innerHTML = "";
    formEl.style.display = "none";

    if (browserKey) {
      rowEl.innerHTML = `
        <span class="api-key-set">● ${esc(masked(browserKey))}</span>
        <button id="api-key-change" style="margin-left:8px;padding:4px 10px;font-size:12px">Change</button>
        <button id="api-key-remove" style="margin-left:4px;padding:4px 10px;font-size:12px;color:var(--err)">Remove</button>
        <div id="api-key-quota" style="width:100%;font-size:12px;color:var(--ink-soft);margin-top:4px">Checking quota…</div>`;
      rowEl.querySelector("#api-key-change").onclick = () => {
        formEl.style.display = "";
        inputEl.value = "";
        inputEl.focus();
      };
      rowEl.querySelector("#api-key-remove").onclick = async () => {
        if (isGroq) localStorage.removeItem("nr.groq_key");
        else localStorage.removeItem("nr.or_key");
        await api("/api/secrets", { method: "POST", body: { provider: state.provider, key: "" } }).catch(() => {});
        renderStatus();
        loadModels();
        loadHealth();
        toast(`${isGroq ? "Groq" : "OpenRouter"} API key removed`);
      };

      api("/api/secrets").then((info) => {
        const qEl = rowEl.querySelector("#api-key-quota");
        if (!qEl) return;
        if (!isGroq && info.openrouter?.limits?.freeDaily) {
          const q = info.openrouter.limits.freeDaily;
          if (q.remaining === 0) {
            qEl.innerHTML = `<span style="color:var(--err)">⚠️ Daily free limit reached (${q.used}/${q.limit} used). Reset at 00:00 UTC or add credits.</span>`;
          } else {
            qEl.innerHTML = `<span>Quota: ${q.remaining}/${q.limit} free requests remaining today (used: ${q.used})</span>`;
          }
        } else if (isGroq && info.groq) {
          const l = info.groq.limits;
          let quotaText = `Top: ${esc(info.groq.bestModel || "auto")}`;
          if (l?.remainingRequests !== null && l?.limitRequests) {
            quotaText += ` · Quota: ${l.remainingRequests}/${l.limitRequests} reqs`;
          }
          if (l?.remainingTokens !== null && l?.limitTokens) {
            quotaText += ` · TPM: ${l.remainingTokens}/${l.limitTokens}`;
          }
          qEl.innerHTML = info.groq.valid
            ? `<span style="color:var(--ok)">✓ Active · ${quotaText}</span>`
            : "";
        } else {
          qEl.innerHTML = "";
        }
      }).catch(() => {});
    } else {
      api("/api/secrets").then((info) => {
        const sec = isGroq ? info.groq : info.openrouter;
        if (sec?.fromEnv || sec?.set) {
          let quotaHtml = "";
          if (!isGroq && sec.limits?.freeDaily) {
            const q = sec.limits.freeDaily;
            quotaHtml = q.remaining === 0
              ? `<div style="color:var(--err);font-size:12px;margin-top:4px">⚠️ Daily limit reached (${q.used}/${q.limit} used).</div>`
              : `<div style="font-size:12px;color:var(--ink-soft);margin-top:4px">${q.remaining}/${q.limit} free requests remaining today</div>`;
          } else if (isGroq && sec) {
            const l = sec.limits;
            let quotaText = `Top model: ${esc(sec.bestModel || "auto")}`;
            if (l?.remainingRequests !== null && l?.limitRequests) {
              quotaText += ` · Quota: ${l.remainingRequests}/${l.limitRequests} reqs`;
            }
            if (l?.remainingTokens !== null && l?.limitTokens) {
              quotaText += ` · TPM: ${l.remainingTokens}/${l.limitTokens}`;
            }
            quotaHtml = `<div style="font-size:12px;color:var(--ink-soft);margin-top:4px">Server configured (.env) · ${quotaText}</div>`;
          }
          rowEl.innerHTML = `
            <span class="api-key-set">● ${esc(sec.masked || "Set on server (.env)")}</span>
            <button id="api-key-change" style="margin-left:8px;padding:4px 10px;font-size:12px">Edit</button>
            <button id="api-key-remove" style="margin-left:4px;padding:4px 10px;font-size:12px;color:var(--err)">Remove</button>
            ${quotaHtml}`;
          rowEl.querySelector("#api-key-change").onclick = () => {
            formEl.style.display = "";
            inputEl.value = "";
            inputEl.focus();
          };
          rowEl.querySelector("#api-key-remove").onclick = async () => {
            if (isGroq) localStorage.removeItem("nr.groq_key");
            else localStorage.removeItem("nr.or_key");
            await api("/api/secrets", { method: "POST", body: { provider: state.provider, key: "" } }).catch(() => {});
            renderStatus();
            loadModels();
            loadHealth();
            toast(`${isGroq ? "Groq" : "OpenRouter"} API key removed from .env`);
          };
          return;
        }

        rowEl.innerHTML = `
          <span style="color:var(--ink-soft);font-size:13px">No key set</span>
          <button id="api-key-add" style="margin-left:8px;padding:4px 10px;font-size:12px">Add key</button>`;
        rowEl.querySelector("#api-key-add").onclick = () => {
          formEl.style.display = "";
          inputEl.value = "";
          inputEl.focus();
        };
      }).catch(() => {
        rowEl.innerHTML = `
          <span style="color:var(--ink-soft);font-size:13px">No key set</span>
          <button id="api-key-add" style="margin-left:8px;padding:4px 10px;font-size:12px">Add key</button>`;
        rowEl.querySelector("#api-key-add").onclick = () => {
          formEl.style.display = "";
          inputEl.value = "";
          inputEl.focus();
        };
      });
    }
  }

  renderStatus();

  formEl.querySelector("#api-key-save").onclick = async () => {
    const key = inputEl.value.trim();
    if (!key) { toast("Please enter a key", true); return; }
    if (isGroq && !key.startsWith("gsk_")) {
      toast("Groq key should start with gsk_…", true);
      return;
    }
    if (!isGroq && !key.startsWith("sk-or-")) {
      toast("OpenRouter key should start with sk-or-…", true);
      return;
    }

    if (isGroq) localStorage.setItem("nr.groq_key", key);
    else localStorage.setItem("nr.or_key", key);

    try {
      await api("/api/secrets", {
        method: "POST",
        body: { provider: state.provider, key },
      });
    } catch {}

    inputEl.value = "";
    renderStatus();
    await loadModels(true);
    loadHealth();

    // If viewing a chapter translated via Google fallback, automatically upgrade!
    if (state.novel && state.chapter && (state.chapter.isGtxFallback || state.chapter.translationProvider === "google-gtx")) {
      toast(`✨ ${isGroq ? "Groq" : "OpenRouter"} key saved! Upgrading current chapter to high-quality AI translation…`);
      startTranslation(state.novel.slug, state.chapter.index, true);
    } else {
      toast(`${isGroq ? "Groq" : "OpenRouter"} key saved (.env & browser) ✓`);
    }
  };

  formEl.querySelector("#api-key-cancel").onclick = () => {
    formEl.style.display = "none";
    inputEl.value = "";
  };

  inputEl.onkeydown = (e) => {
    if (e.key === "Enter") formEl.querySelector("#api-key-save").click();
    if (e.key === "Escape") formEl.querySelector("#api-key-cancel").click();
  };
}

/* ---------------------------------------------------------------- keyboard */

document.addEventListener("keydown", (event) => {
  if (event.target.matches("input, textarea, select")) return;
  if (event.key === "Escape") return closeDrawer();
  if (event.key === "?") return openDrawer("shortcuts");
  if (event.key.toLowerCase() === "h") return openDrawer("history");
  if (event.key.toLowerCase() === "t" && state.novel) return openDrawer("toc");
  if (event.key.toLowerCase() === "s") return openDrawer("settings");
  if (event.key.toLowerCase() === "b") {
    if (state.chapter && state.novel) {
      location.hash = `#/novel/${encodeURIComponent(state.novel.slug)}`;
    } else if (state.search?.active && state.search?.query) {
      location.hash = `#/search?q=${encodeURIComponent(state.search.query)}`;
    } else {
      location.hash = "#/";
    }
    return;
  }
  if (!state.chapter) return;
  if (event.key === "ArrowLeft" || event.key.toLowerCase() === "a") go(state.chapter.index - 1);
  if (event.key === "ArrowRight" || event.key.toLowerCase() === "d") go(state.chapter.index + 1);
  if (event.key.toLowerCase() === "m") document.getElementById("mode-btn")?.click();
  if (event.key.toLowerCase() === "c") copyChapterText();
});

initSynopsisPopover();
route();
