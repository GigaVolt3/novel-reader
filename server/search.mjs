import fs from "node:fs";
import path from "node:path";
import * as cheerio from "cheerio";
import { NOVELS, readJson, listNovels } from "./store.mjs";
import { getRecommendationCache } from "./cache.mjs";
import { gtxTranslate, gtxTranslateBatch } from "./gtx.mjs";
import { doGenerate } from "./translate.mjs";
import { fetchPage } from "./scrape.mjs";

const siteSearchFormsCache = new Map();
const searchSessionCache = new Map();
const SESSION_TTL_MS = 20 * 60 * 1000; // 20 minutes

function getSearchSession(queryKey) {
  const hit = searchSessionCache.get(queryKey);
  if (hit && Date.now() - hit.timestamp < SESSION_TTL_MS) {
    return hit;
  }
  return null;
}

function saveSearchSession(queryKey, data) {
  searchSessionCache.set(queryKey, {
    ...data,
    timestamp: Date.now(),
  });
}

/**
 * Extract all unique visited website origins from user's library and cached novels.
 */
export function getVisitedDomains() {
  const domains = new Set();
  try {
    if (fs.existsSync(NOVELS)) {
      const dirs = fs.readdirSync(NOVELS, { withFileTypes: true });
      for (const d of dirs) {
        if (d.isDirectory()) {
          const meta = readJson(path.join(NOVELS, d.name, "meta.json"));
          if (meta?.sourceUrl) {
            try {
              domains.add(new URL(meta.sourceUrl).origin);
            } catch {}
          }
          if (meta?.tocUrl) {
            try {
              domains.add(new URL(meta.tocUrl).origin);
            } catch {}
          }
        }
      }
    }
  } catch {}

  // Include top standard Chinese novel platforms (compatible with LNReader / Miyomi sources)
  domains.add("https://www.quanben.io");
  domains.add("https://m.1qxs.com");
  domains.add("https://m.ilwxs.com");
  return Array.from(domains);
}

/**
 * Search Quanben (quanben.io) - Extensive Chinese novel repository with covers and metadata.
 * Supports deep pagination across pages (page 1, 2, 3, 4, etc.).
 */
async function searchQuanben(keyword, page = 1) {
  if (!keyword || !keyword.trim()) return { results: [], hasMore: false };
  const cleanKw = keyword.trim();
  const url = `https://www.quanben.io/index.php?c=book&a=search&keywords=${encodeURIComponent(cleanKw)}&page=${page}`;
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        Referer: "https://www.quanben.io/",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });
    if (!res.ok) return { results: [], hasMore: false };
    const html = await res.text();
    const $ = cheerio.load(html);
    const results = [];

    $("div.list2").each((_, el) => {
      const $el = $(el);
      const link = $el.find("h3 a").first();
      const title = link.text().trim();
      const href = link.attr("href");
      if (!title || !href) return;

      const fullUrl = new URL(href, "https://www.quanben.io").href;
      if (results.some((r) => r.sourceUrl === fullUrl)) return;

      const author = $el
        .find("[itemprop='author'], .author, span:contains('作者')")
        .text()
        .replace(/作者[:：\s]*/, "")
        .trim();

      const introEl = $el.find("p[itemprop='description'], .description, .intro, p:contains('简介')").first();
      const intro = introEl.length
        ? introEl.text().replace(/^简介[:：\s]*/, "").trim()
        : $el.find("p").last().text().replace(/^(?:作者|简介)[:：\s]*/, "").trim();

      const img = $el.find("img").attr("src") || $el.find("img").attr("data-src");
      let coverUrl = null;
      if (img && !img.includes("default.png")) {
        try {
          coverUrl = new URL(img, "https://www.quanben.io").href;
        } catch {}
      }

      results.push({
        title,
        titleZh: title,
        author: author || "Unknown",
        synopsis: intro.slice(0, 180),
        coverUrl,
        sourceUrl: fullUrl,
        siteDomain: "quanben.io",
        tags: ["Chinese Novel"],
      });
    });

    const hasMore = results.length >= 20 || $(".page a:contains('下一页'), .pagination a:contains('下一页')").length > 0;
    return { results, hasMore };
  } catch (err) {
    return { results: [], hasMore: false };
  }
}

/**
 * Search novel catalog on m.1qxs.com
 * Supports deep pagination across pages (page 1, 2, 3, 4, etc.).
 */
async function search1qxs(keyword, page = 1) {
  if (!keyword || !keyword.trim()) return { results: [], hasMore: false };
  const cleanKw = keyword.trim();
  const url = page > 1
    ? `https://m.1qxs.com/search?kw=${encodeURIComponent(cleanKw)}&p=${page}`
    : `https://m.1qxs.com/search?kw=${encodeURIComponent(cleanKw)}`;
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        Referer: "https://m.1qxs.com/search",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });
    if (!res.ok) return { results: [], hasMore: false };
    const html = await res.text();
    const $ = cheerio.load(html);
    const results = [];

    $("a[href*='/xs_']").each((_, a) => {
      const href = $(a).attr("href");
      if (!href) return;
      const fullUrl = new URL(href, "https://m.1qxs.com").href;
      if (results.some((r) => r.sourceUrl === fullUrl)) return;

      const $a = $(a);
      const text = $a.text().trim();
      if (!text) return;

      const lines = text
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      const title = lines[0] || "";
      let synopsis = "";
      let author = "Unknown";
      let tags = [];

      for (let i = 1; i < lines.length; i++) {
        const l = lines[i];
        if (l.startsWith("连载") || l.startsWith("完结") || l.includes("万字")) {
          tags.push(l);
        } else if (i === lines.length - 2 || (lines.length >= 3 && i === lines.length - 1)) {
          author = l;
        } else if (!synopsis && l.length > 10) {
          synopsis = l;
        }
      }

      let coverUrl = null;
      const img = $a.find("img").attr("src") || $a.closest("li, div").find("img").attr("src");
      if (img && !img.includes("default.png")) {
        try {
          coverUrl = new URL(img, "https://m.1qxs.com").href;
        } catch {}
      }

      if (title) {
        results.push({
          title,
          titleZh: title,
          author,
          synopsis: synopsis.replace(/^　+/g, "").trim(),
          tags,
          coverUrl,
          sourceUrl: fullUrl,
          siteDomain: "m.1qxs.com",
        });
      }
    });

    const hasNextLink = $("a:contains('下一页'), a:contains('下一頁')").length > 0 &&
      !$("a:contains('下一页')").attr("href")?.includes("javascript:void");
    const hasMore = Boolean(hasNextLink || (results.length >= 15));
    return { results, hasMore };
  } catch (err) {
    return { results: [], hasMore: false };
  }
}

function parseDynamicSearchResults(html, baseOrigin, currentUrl, page = 1) {
  const $ = cheerio.load(html);
  const results = [];
  const seenUrls = new Set();

  $("a").each((_, a) => {
    const href = $(a).attr("href");
    if (!href) return;

    if (!/\/(?:book|novel|shu|xs_|txt|n|info|html)\/[a-zA-Z0-9_-]+/i.test(href)) return;
    if (/login|register|search|catalog|mulu|download|app|sort|rank/i.test(href)) return;

    let fullHref = "";
    try {
      fullHref = new URL(href, baseOrigin).href;
    } catch {
      return;
    }
    if (seenUrls.has(fullHref)) return;

    const $a = $(a);
    const title = $a.text().trim();
    if (!title || title.length < 2 || title.length > 50) return;

    const $card = $a.closest("li, .item, .book-item, .list-item, div, tr");
    let author = "Unknown";
    let synopsis = "";
    let coverUrl = null;

    if ($card.length) {
      const authorEl = $card.find(".author, span:contains('作者'), td:nth-child(3)").first();
      if (authorEl.length) {
        author = authorEl.text().replace(/作者[:：\s]*/, "").trim();
      }

      const descEl = $card.find("p[itemprop='description'], .intro, .desc, .description, p:contains('简介'), p:not(:contains('作者'))").first();
      if (descEl.length) {
        synopsis = descEl.text().replace(/^简介[:：\s]*/, "").trim().slice(0, 160);
      }

      const imgEl = $card.find("img").first();
      const imgSrc = imgEl.attr("src") || imgEl.attr("data-src");
      if (imgSrc && !imgSrc.includes("default")) {
        try {
          coverUrl = new URL(imgSrc, baseOrigin).href;
        } catch {}
      }
    }

    seenUrls.add(fullHref);
    results.push({
      title,
      titleZh: title,
      author: author || "Unknown",
      synopsis,
      coverUrl,
      sourceUrl: fullHref,
      siteDomain: new URL(baseOrigin).hostname,
      tags: ["Web Novel"],
    });
  });

  // Extract next page link (下一页, 下一頁, 下页, Next, >, » or numeric page link)
  let nextPageUrl = null;
  const nextA = $("a").filter((_, el) => {
    const t = $(el).text().trim();
    const h = $(el).attr("href");
    if (!h || h.startsWith("javascript:") || h.startsWith("#")) return false;
    return /下一[页頁]|下页|后一页|Next\s*Page|Next|>|»/i.test(t);
  }).first();

  if (nextA.length) {
    try {
      nextPageUrl = new URL(nextA.attr("href"), currentUrl).href;
    } catch {}
  } else {
    const pageNumA = $("a").filter((_, el) => {
      const t = $(el).text().trim();
      const h = $(el).attr("href");
      if (!h || h.startsWith("javascript:") || h.startsWith("#")) return false;
      return t === String(page + 1);
    }).first();
    if (pageNumA.length) {
      try {
        nextPageUrl = new URL(pageNumA.attr("href"), currentUrl).href;
      } catch {}
    }
  }

  const hasMore = Boolean(nextPageUrl || results.length >= 10);
  return { results, nextPageUrl, hasMore };
}

/**
 * Universal Autonomous Search Crawler:
 * Automatically inspects any novel website's homepage or /search page,
 * locates search input forms, executes GET or POST searches, navigates pagination, and parses novel cards.
 */
export async function searchSiteDynamic(domain, keyword, page = 1, pageUrl = null) {
  if (!domain || !keyword || !keyword.trim()) return { results: [], nextPageUrl: null, hasMore: false };
  const cleanKw = keyword.trim();
  let baseOrigin = "";
  try {
    baseOrigin = new URL(domain).origin;
  } catch {
    return { results: [], nextPageUrl: null, hasMore: false };
  }

  // If explicit next page URL provided
  if (pageUrl) {
    try {
      const res = await fetch(pageUrl, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          Referer: baseOrigin,
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
      });
      if (res.ok) {
        const html = await res.text();
        return parseDynamicSearchResults(html, baseOrigin, pageUrl, page);
      }
    } catch {}
  }

  // Check cached search form config
  let formConfig = siteSearchFormsCache.get(baseOrigin);
  if (!formConfig) {
    try {
      const candidates = [baseOrigin, `${baseOrigin}/search`, `${baseOrigin}/search.html`, `${baseOrigin}/s`];
      for (const targetUrl of candidates) {
        try {
          const pageRes = await fetchPage(targetUrl);
          const $ = cheerio.load(pageRes.html);
          let found = null;

          $("form").each((_, formEl) => {
            if (found) return;
            const $form = $(formEl);
            const action = $form.attr("action") || targetUrl;
            const method = ($form.attr("method") || "GET").toUpperCase();

            let inputName = null;
            $form.find("input, input[type='text'], input[type='search']").each((__, inp) => {
              if (inputName) return;
              const name = $(inp).attr("name");
              const placeholder = $(inp).attr("placeholder") || "";
              if (
                name &&
                (/searchkey|keywords|keyword|kw|key|q|search|wd|word|title|name/i.test(name) ||
                  /搜索|书名|search/i.test(placeholder))
              ) {
                inputName = name;
              }
            });

            if (inputName) {
              const hiddenInputs = {};
              $form.find("input[type='hidden']").each((__, h) => {
                const hn = $(h).attr("name");
                const hv = $(h).attr("value") || "";
                if (hn) hiddenInputs[hn] = hv;
              });

              let fullAction = "";
              try {
                fullAction = new URL(action, targetUrl).href;
              } catch {
                fullAction = targetUrl;
              }

              found = {
                actionUrl: fullAction,
                method,
                paramName: inputName,
                hiddenInputs,
                siteOrigin: baseOrigin,
              };
            }
          });

          if (found) {
            formConfig = found;
            siteSearchFormsCache.set(baseOrigin, formConfig);
            break;
          }
        } catch {}
      }
    } catch {}
  }

  if (!formConfig) return { results: [], nextPageUrl: null, hasMore: false };

  // Execute the search form request
  try {
    let searchUrl = formConfig.actionUrl;
    let fetchOptions = {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        Referer: baseOrigin,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    };

    if (formConfig.method === "POST") {
      const bodyParams = new URLSearchParams({
        ...formConfig.hiddenInputs,
        [formConfig.paramName]: cleanKw,
      });
      if (page > 1) {
        bodyParams.set("page", page);
        bodyParams.set("p", page);
      }
      fetchOptions = {
        ...fetchOptions,
        method: "POST",
        headers: {
          ...fetchOptions.headers,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: bodyParams.toString(),
      };
    } else {
      const u = new URL(searchUrl);
      Object.entries(formConfig.hiddenInputs).forEach(([k, v]) => u.searchParams.set(k, v));
      u.searchParams.set(formConfig.paramName, cleanKw);
      if (page > 1) {
        u.searchParams.set("page", page);
      }
      searchUrl = u.href;
    }

    const res = await fetch(searchUrl, fetchOptions);
    if (!res.ok) return { results: [], nextPageUrl: null, hasMore: false };
    const html = await res.text();
    return parseDynamicSearchResults(html, baseOrigin, searchUrl, page);
  } catch {
    return { results: [], nextPageUrl: null, hasMore: false };
  }
}

/**
 * Scan visited novel library & cached recommendation lists from visited websites.
 */
function searchVisitedRecommendations(keyword) {
  if (!keyword || !keyword.trim()) return [];
  const q = keyword.trim().toLowerCase();
  const results = [];
  const seenUrls = new Set();

  try {
    if (fs.existsSync(NOVELS)) {
      const dirs = fs.readdirSync(NOVELS, { withFileTypes: true });
      for (const d of dirs) {
        if (!d.isDirectory()) continue;
        const meta = readJson(path.join(NOVELS, d.name, "meta.json"));
        if (!meta) continue;

        const recs = Array.isArray(meta.recommendations)
          ? meta.recommendations
          : getRecommendationCache(meta.slug) || [];
        for (const r of recs) {
          if (!r.sourceUrl || seenUrls.has(r.sourceUrl)) continue;

          const matchTitleZh = r.titleZh && r.titleZh.toLowerCase().includes(q);
          const matchTitleEn = r.titleEn && r.titleEn.toLowerCase().includes(q);
          const matchTitle = r.title && r.title.toLowerCase().includes(q);
          const matchSynopsis = (r.synopsis || r.synopsisZh || "").toLowerCase().includes(q);

          if (matchTitleZh || matchTitleEn || matchTitle || matchSynopsis) {
            seenUrls.add(r.sourceUrl);
            let siteDomain = "";
            try {
              siteDomain = new URL(r.sourceUrl).hostname;
            } catch {}

            results.push({
              title: r.titleEn || r.title,
              titleZh: r.titleZh || r.title,
              author: r.author || "Unknown",
              synopsis: r.synopsisEn || r.synopsis || "",
              coverUrl: r.coverUrl || r.cover || null,
              sourceUrl: r.sourceUrl,
              siteDomain: siteDomain || "Visited Site",
              tags: r.tags || [],
            });
          }
        }
      }
    }
  } catch {}

  return results;
}

/**
 * Parse JSON array from AI output with fallback.
 */
function parseJsonArray(raw) {
  if (!raw) return [];
  let text = String(raw).trim();
  text = text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  text = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end <= start) return [];
  try {
    const arr = JSON.parse(text.slice(start, end + 1));
    return Array.isArray(arr) ? arr.map((s) => String(s || "").trim()).filter(Boolean) : [];
  } catch {
    return [];
  }
}

/**
 * Generate candidate query variations:
 * Supports BOTH:
 * - English input: Google GTX translates to Chinese (<200ms) + AI generates 5 alternative Chinese titles/tropes.
 * - Chinese input: Directly uses Chinese query + AI generates 5 alternate titles/prefixes.
 */
export async function generateSearchVariants(query, { model, apiKey } = {}) {
  const cleanQ = String(query || "").trim();
  if (!cleanQ) return { googleZh: "", aiVariants: [] };

  const isAlreadyChinese = /[\u4e00-\u9fff]/.test(cleanQ) && !/[a-zA-Z]{4,}/.test(cleanQ);

  // 1. Google GTX direct translation (sub-second)
  let googleZh = cleanQ;
  if (!isAlreadyChinese) {
    try {
      const tr = await gtxTranslate(cleanQ, { from: "auto", to: "zh-CN" });
      if (tr && tr.trim()) googleZh = tr.trim();
    } catch {}
  }

  // 2. AI generates up to 5 alternative spellings/names in 1 prompt (single AI call)
  let aiVariants = [];
  try {
    const prompt = `You are a Chinese web novel search engine assistant.
A user is searching for a novel on Chinese novel platforms using query: "${cleanQ}" (Primary Chinese query: "${googleZh}").
The user might have:
- Misspelled the title or used a slightly different English translation
- Missed common web novel keywords/prefixes (e.g. 反派, 玄幻, 开局, 重生, 师尊, 穿越, 签到, 无敌, 大帝)
- Remembered only a character name, sect, or concept

Generate up to 5 alternative Chinese search queries, official Chinese book titles, or alternative spellings that this web novel could be named on Chinese novel platforms.
Return ONLY a valid JSON array of up to 5 Chinese string variations in order of likelihood, e.g. ["标题1", "标题2", "标题3", "标题4", "标题5"].
No markdown code fences, no explanations, no commentary.`;

    const raw = await doGenerate({ prompt, model, apiKey });
    aiVariants = parseJsonArray(raw).slice(0, 5);
  } catch (err) {
    // Rule-based fallback if AI is unavailable or offline
    const fallbackVariants = [];
    const noPunct = googleZh.replace(/[：:，,\s·!！?？]/g, "");
    if (noPunct && noPunct !== googleZh) fallbackVariants.push(noPunct);

    const prefixes = ["反派", "玄幻", "开局", "重生", "修仙", "无敌"];
    for (const p of prefixes) {
      if (!googleZh.includes(p) && fallbackVariants.length < 5) {
        fallbackVariants.push(`${p}：${noPunct.slice(0, 8)}`);
      }
    }
    aiVariants = fallbackVariants.slice(0, 5);
  }

  // Deduplicate against googleZh
  aiVariants = aiVariants.filter((v) => v && v !== googleZh && v !== cleanQ);

  return { googleZh, aiVariants };
}

/**
 * Smart Multi-Site Search:
 * - Executes instant search with Google GTX translation first.
 * - Searches with each of the up to 5 AI spellings.
 * - Queries visited websites & Quanben & 1qxs & dynamic site search.
 * - Deeply navigates across site pages (Page 1, 2, 3, 4, etc.) on request or scroll.
 * - Batch translates found results into English via Google GTX in 1 single HTTP request.
 */
export async function executeSmartSearch(query, { model, apiKey, page = 1, maxResults = 25, excludeUrls = [] } = {}) {
  const cleanQ = String(query || "").trim();
  if (!cleanQ) {
    return {
      query: cleanQ,
      page: 1,
      hasMore: false,
      googleZh: "",
      aiVariants: [],
      totalCandidates: 0,
      sitesSearched: [],
      totalResults: 0,
      pageResults: 0,
      results: [],
    };
  }

  const queryKey = cleanQ.toLowerCase();
  let session = getSearchSession(queryKey);

  if (!session || page === 1) {
    const visitedDomains = getVisitedDomains();
    const { googleZh, aiVariants } = await generateSearchVariants(cleanQ, { model, apiKey });
    const candidates = [
      { text: googleZh, isGoogle: true },
      ...aiVariants.map((v) => ({ text: v, isGoogle: false })),
    ].filter((c) => Boolean(c.text));

    session = {
      queryKey,
      googleZh,
      aiVariants,
      candidates,
      seenUrls: new Set(excludeUrls || []),
      siteNextUrls: new Map(), // nextKey -> url
      visitedDomains,
      totalCrawled: 0,
      allResults: [],
    };
    saveSearchSession(queryKey, session);
  } else if (Array.isArray(excludeUrls) && excludeUrls.length) {
    excludeUrls.forEach((u) => session.seenUrls.add(u));
  }

  const candidates = session.candidates || [{ text: cleanQ, isGoogle: true }];
  const visitedDomains = session.visitedDomains || getVisitedDomains();
  const libraryNovels = listNovels();
  const newFound = [];

  // Determine candidate queries & site pages to search for this page request:
  // On page 1: Primary query at site page 1 + first candidate variants
  // On page 2: Primary query at site page 2 + candidate 1 & 2
  // On page 3: Primary query at site page 3 + candidate 3 & 4
  // On page 4: Primary query at site page 4 + candidate 5
  const targetSitePage = page;
  const candIndicesToSearch = new Set();
  candIndicesToSearch.add(0); // always crawl primary query at sitePage = page
  const aiVariantIdx = (page - 1) * 2 + 1;
  if (candidates[aiVariantIdx]) candIndicesToSearch.add(aiVariantIdx);
  if (candidates[aiVariantIdx + 1]) candIndicesToSearch.add(aiVariantIdx + 1);

  for (const candIdx of candIndicesToSearch) {
    const cand = candidates[candIdx];
    if (!cand) continue;
    const kw = cand.text;
    const sitePage = candIdx === 0 ? targetSitePage : 1;

    // 1. Search Quanben (quanben.io)
    try {
      const qbRes = await searchQuanben(kw, sitePage);
      for (const item of qbRes.results) {
        if (!session.seenUrls.has(item.sourceUrl)) {
          session.seenUrls.add(item.sourceUrl);
          newFound.push({ ...item, matchedVia: kw, isGoogleMatch: cand.isGoogle, pageNumber: page });
        }
      }
    } catch {}

    // 2. Search 1qxs (m.1qxs.com)
    try {
      const qxRes = await search1qxs(kw, sitePage);
      for (const item of qxRes.results) {
        if (!session.seenUrls.has(item.sourceUrl)) {
          session.seenUrls.add(item.sourceUrl);
          newFound.push({ ...item, matchedVia: kw, isGoogleMatch: cand.isGoogle, pageNumber: page });
        }
      }
    } catch {}

    // 3. Search dynamic visited sites
    for (const d of visitedDomains) {
      if (d.includes("quanben.io") || d.includes("1qxs.com")) continue;
      try {
        const nextKey = `${d}:${kw}`;
        const previousNextUrl = session.siteNextUrls?.get(nextKey) || null;
        const dynRes = await searchSiteDynamic(d, kw, sitePage, previousNextUrl);
        if (dynRes.nextPageUrl) {
          session.siteNextUrls.set(nextKey, dynRes.nextPageUrl);
        }
        for (const item of dynRes.results) {
          if (!session.seenUrls.has(item.sourceUrl)) {
            session.seenUrls.add(item.sourceUrl);
            newFound.push({ ...item, matchedVia: kw, isGoogleMatch: cand.isGoogle, pageNumber: page });
          }
        }
      } catch {}
    }

    // 4. On page 1, search local recommendation index
    if (page === 1) {
      const recs = searchVisitedRecommendations(kw);
      for (const item of recs) {
        if (!session.seenUrls.has(item.sourceUrl)) {
          session.seenUrls.add(item.sourceUrl);
          newFound.push({ ...item, matchedVia: kw, isGoogleMatch: cand.isGoogle, pageNumber: page });
        }
      }
    }

    if (newFound.length >= maxResults) break;
  }

  const sliced = newFound.slice(0, maxResults);

  // Batch translate found titles & synopses to English with Google GTX in 1 single HTTP request
  const titlesToTranslate = sliced.map((item) =>
    item.titleZh && (!item.titleEn || /[\u4e00-\u9fff]/.test(item.titleEn)) ? item.titleZh : ""
  );
  const synopsesToTranslate = sliced.map((item) =>
    item.synopsis && /[\u4e00-\u9fff]/.test(item.synopsis) ? item.synopsis.slice(0, 160) : ""
  );

  try {
    const [transTitles, transSynopses] = await Promise.all([
      titlesToTranslate.some(Boolean) ? gtxTranslateBatch(titlesToTranslate) : [],
      synopsesToTranslate.some(Boolean) ? gtxTranslateBatch(synopsesToTranslate) : [],
    ]);

    sliced.forEach((item, idx) => {
      if (transTitles[idx] && transTitles[idx] !== titlesToTranslate[idx]) {
        item.title = transTitles[idx];
        item.titleEn = transTitles[idx];
      }
      if (transSynopses[idx] && transSynopses[idx] !== synopsesToTranslate[idx]) {
        item.synopsis = transSynopses[idx];
        item.synopsisEn = transSynopses[idx];
      }
    });
  } catch {}

  // Check which novels are already in user's library
  sliced.forEach((item) => {
    const matched = libraryNovels.find(
      (n) =>
        (item.sourceUrl && n.sourceUrl && item.sourceUrl.replace(/\/$/, "") === n.sourceUrl.replace(/\/$/, "")) ||
        (n.title && item.titleZh && n.title.trim().toLowerCase() === item.titleZh.trim().toLowerCase())
    );
    if (matched) {
      item.inLibrary = true;
      item.slug = matched.slug;
    } else {
      item.inLibrary = false;
      item.slug = null;
    }
  });

  session.totalCrawled = (session.totalCrawled || 0) + sliced.length;
  saveSearchSession(queryKey, session);

  const hasMore = page < 10 && (sliced.length >= 8 || (page * 2 < candidates.length));

  return {
    query: cleanQ,
    page,
    hasMore,
    googleZh: session.googleZh,
    aiVariants: session.aiVariants,
    totalCandidates: candidates.length,
    sitesSearched: visitedDomains,
    totalResults: session.totalCrawled,
    pageResults: sliced.length,
    results: sliced,
  };
}
