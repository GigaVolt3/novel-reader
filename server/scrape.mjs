import * as cheerio from "cheerio";
import path from "node:path";
import fs from "node:fs";
import { NOVELS } from "./store.mjs";
import { buildSourceKey, getSourceCache, setSourceCache, getContentHash } from "./cache.mjs";

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g;
const CJK_ONE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const CHAPTER_TEXT =
  /(第\s*[0-9零一二三四五六七八九十百千万两〇]+\s*[章节回卷话集篇])|(chapter\s*\d+)|(^\s*[【\[(（]?\s*\d{1,5}\s*[】\])）]?[.、:\s_-]?)|(^[0-9零一二三四五六七八九十百千万两〇]+[、.：:\s\-_])|(^(楔子|引子|序[章言]?|尾声|番外|终章|后记|完结感言|外传|大结局))/i;

const NAV_TEXT =
  /^(首页|目录|章节目录|全部章节|上一章|下一章|返回|书架|登录|注册|投票|推荐|排行|分类|完本|搜索|作者|更多|电脑版|手机版|客户端|书评)$/;

const AD_LINE =
  /(请记住本站|记住本站|最新章节|手机版|本章未完|加入书签|投推荐票|求月票|求收藏|求推荐|一秒记住|笔趣阁|首发地址|全文阅读|章节错误|返回目录|上一章|下一章|www\.|https?:\/\/|\.com|\.net|\.cc|\.la|\.org|\.info|点击下一页|继续阅读|未完待续|阅[| ]*读[| ]*模[| ]*式|畅[| ]*读[| ]*模[| ]*式|加[| ]*载[| ]*更[| ]*多)/i;

const BOILERPLATE =
  /^(下载|維基文庫|维基文库|分类：|分類：|编辑|編輯|討論|讨论|不转换|不轉換|简体|簡體|繁體|目录|目錄|下载PDF|跳转到内容|跳轉到內容|随机作品|所有页面|社群首页|最近更改|特殊页面|帮助|关于维基|作者[：:]|姊妹计划|Sister projects|维基百科|本作品|公有领域|Public domain|检索)/i;

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const cjkCount = (text) => (text.match(CJK) || []).length;

function sameOrigin(href, base) {
  try {
    return new URL(href, base).origin === new URL(base).origin;
  } catch {
    return false;
  }
}

function decode(buffer, contentType) {
  let encoding = /charset=["']?([\w-]+)/i.exec(contentType || "")?.[1];
  if (!encoding) {
    const head = buffer.subarray(0, 8192).toString("latin1");
    encoding =
      /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1] ||
      /<meta[^>]+content=["'][^"']*charset=([\w-]+)/i.exec(head)?.[1];
  }
  encoding = (encoding || "utf-8").toLowerCase();
  if (encoding === "gb2312" || encoding === "gbk") encoding = "gb18030";
  if (encoding === "big-5") encoding = "big5";
  try {
    return new TextDecoder(encoding).decode(buffer);
  } catch {
    try {
      return new TextDecoder("gb18030").decode(buffer);
    } catch {
      return buffer.toString("utf8");
    }
  }
}

export async function fetchPage(url, retries = 2) {
  let origin = "";
  try {
    origin = new URL(url).origin;
  } catch {
    /* ignore */
  }

  const headers = {
    "user-agent": UA,
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
    "accept-language": "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7",
    "sec-ch-ua": '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "sec-fetch-dest": "document",
    "sec-fetch-mode": "navigate",
    "sec-fetch-site": "same-origin",
    "cache-control": "max-age=0",
  };
  if (origin) headers.referer = origin;

  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        redirect: "follow",
        headers,
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) throw new Error(`Fetch failed: HTTP ${res.status} for ${url}`);
      const buffer = Buffer.from(await res.arrayBuffer());
      const html = decode(buffer, res.headers.get("content-type"));
      return { html, finalUrl: res.url || url };
    } catch (err) {
      lastError = err;
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      }
    }
  }
  throw lastError;
}

function cleanTitle(raw, url) {
  let title = (raw || "").replace(/\s+/g, " ").trim();
  // Strip sub-page counters like (1/4) or （2/3）
  title = title.replace(/\s*[(（]\d+[/_]\d+[)）]\s*$/, "").trim();
  title = title.split(/\s*[_|｜]\s*/)[0];
  if (title.length > 40 || title.includes(" - ") || title.includes(" – ")) {
    const parts = title.split(/\s*[-–—]\s*/);
    if (parts.length > 1 && parts[0].trim().length >= 2) title = parts[0];
  }
  // Strip trailing noise like " 列表", " 最新章节", " 目录", " 全文阅读"
  title = title.replace(/\s*(最新章节|全文阅读|免费阅读|无弹窗|txt下载|列表|目录)\s*$/gi, "").trim();
  return title || new URL(url).pathname.split("/").filter(Boolean).pop() || "Untitled";
}

/**
 * Robust Chinese novel cover image finder.
 * Handles OpenGraph, microdata, targeted novel-site containers, lazy-loaded data-src,
 * novel title alt-matching, and URL path heuristics.
 */
export function findCoverImage($, baseUrl, novelTitle = "") {
  // 1. Meta / OpenGraph tags
  const metaSelectors = [
    'meta[property="og:image"]',
    'meta[name="og:image"]',
    'meta[property="twitter:image"]',
    'meta[name="twitter:image"]',
    'meta[itemprop="image"]',
    'link[rel="image_src"]',
  ];
  for (const sel of metaSelectors) {
    const content = $(sel).attr("content") || $(sel).attr("href");
    if (content && isValidCoverUrl(content)) {
      try {
        return new URL(content, baseUrl).href;
      } catch {}
    }
  }

  const getImgSrc = (el) => {
    return (
      $(el).attr("data-src") ||
      $(el).attr("data-original") ||
      $(el).attr("data-lazy-src") ||
      $(el).attr("data-url") ||
      $(el).attr("data-img") ||
      $(el).attr("data-echo") ||
      $(el).attr("_src") ||
      $(el).attr("src") ||
      ""
    ).trim();
  };

  function isValidCoverUrl(url) {
    if (!url || typeof url !== "string") return false;
    if (url.startsWith("data:image")) return false;
    const lower = url.toLowerCase();
    if (
      lower.includes("loading") ||
      lower.includes("blank") ||
      lower.includes("logo") ||
      lower.includes("avatar") ||
      lower.includes("icon") ||
      lower.includes("share") ||
      lower.includes("advert") ||
      lower.includes("banner") ||
      lower.endsWith(".gif")
    ) {
      return false;
    }
    return true;
  }

  // 2. High-priority novel cover containers across Chinese sites
  const containerSelectors = [
    ".book-cover img",
    ".bookcover img",
    ".cover img",
    ".book-img img",
    ".bookimg img",
    ".pic img",
    ".imgbox img",
    "#fmimg img",
    ".synopsisArea_detail img",
    ".detail-thumb img",
    ".detail img",
    ".book_info img",
    ".con_top img",
    ".block_img2 img",
    ".book_cover img",
    ".novel-cover img",
    ".thumb img",
    ".info_img img",
    ".novel_img img",
  ];

  for (const sel of containerSelectors) {
    const el = $(sel).first();
    if (el.length) {
      const src = getImgSrc(el);
      if (isValidCoverUrl(src)) {
        try {
          return new URL(src, baseUrl).href;
        } catch {}
      }
    }
  }

  // 3. Match <img> with alt or title matching novel title
  if (novelTitle) {
    const cleanT = novelTitle.replace(/[！!？?：:\s_]+/g, "");
    let matchedSrc = null;
    $("img").each((_, el) => {
      if (matchedSrc) return;
      const alt = ($(el).attr("alt") || $(el).attr("title") || "").replace(/[！!？?：:\s_]+/g, "");
      if (alt && (alt.includes(cleanT) || cleanT.includes(alt))) {
        const src = getImgSrc(el);
        if (isValidCoverUrl(src)) {
          try {
            matchedSrc = new URL(src, baseUrl).href;
          } catch {}
        }
      }
    });
    if (matchedSrc) return matchedSrc;
  }

  // 4. Look for common cover path patterns in any img src
  const coverPathPatterns = [/cover/i, /article\/image/i, /files\/article/i, /bookcover/i, /book\/\d+/i, /\/shu\/\d+/i, /\d+\/\d+\.(jpg|jpeg|png|webp)/i];
  let heuristicSrc = null;
  $("img").each((_, el) => {
    if (heuristicSrc) return;
    const src = getImgSrc(el);
    if (!isValidCoverUrl(src)) return;
    for (const pat of coverPathPatterns) {
      if (pat.test(src)) {
        try {
          heuristicSrc = new URL(src, baseUrl).href;
          break;
        } catch {}
      }
    }
  });
  if (heuristicSrc) return heuristicSrc;

  return null;
}

/**
 * Download a remote book cover and cache it locally to novels/<slug>/cover.jpg
 * Sends proper browser headers and referer to bypass anti-hotlinking protections.
 */
export async function downloadCover(slug, coverUrl, referer = "") {
  if (!coverUrl) return null;
  const dir = path.join(NOVELS, slug);
  const targetFile = path.join(dir, "cover.jpg");
  try {
    const headers = {
      "User-Agent": UA,
      Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
    };
    if (referer) headers.Referer = referer;
    const res = await fetch(coverUrl, {
      headers,
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length < 500) return null;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(targetFile, buffer);
    return `/api/novels/${slug}/cover`;
  } catch (err) {
    console.warn(`Failed to download cover from ${coverUrl}:`, err.message);
    return null;
  }
}

function pageTitle($, url) {
  const h1 = $("h1").first().text().trim();
  if (h1) return cleanTitle(h1, url);
  const bookname = $(".bookname h1, .bookname, #info h1, .info h1, .title h1").first().text().trim();
  if (bookname) return cleanTitle(bookname, url);
  return cleanTitle($("title").text(), url);
}

export function pageAuthor($, url) {
  const metaAuthor =
    $('meta[property="og:novel:author"]').attr("content") ||
    $('meta[name="author"]').attr("content") ||
    $('meta[property="book:author"]').attr("content") ||
    $('meta[property="author"]').attr("content");
  if (metaAuthor && metaAuthor.trim()) {
    return metaAuthor.replace(/^作\s*者[:：\s]*/, "").trim();
  }

  // Clone document to safely strip recommendation blocks before extracting author
  const $clean = cheerio.load($.html());
  $clean(".swiper-container, .swiper-wrapper, [class*='swiper'], [class*='recommend'], [class*='guess'], [class*='hot-'], [class*='other'], [id*='other']").remove();

  // Try direct author element (e.g. <div class="author">天不早了</div>)
  const direct = $clean(".author, [itemprop='author'], .book-author, .novel-author").first();
  if (direct.length) {
    const t = direct.text().replace(/^作\s*者[:：\s]*/, "").trim();
    if (t && t.length <= 25 && !/小说|阅读|加入|书架/i.test(t)) {
      return t;
    }
  }

  const candidates = [
    "#info p",
    ".info p",
    ".book-info p",
    ".book-detail p",
    ".msg em",
    ".detail-box p",
  ];
  for (const sel of candidates) {
    let found = "";
    $clean(sel).each((_, el) => {
      const text = $clean(el).text().replace(/\s+/g, " ").trim();
      const m = text.match(/作\s*者[:：\s]+([^\s|｜,，\n]+)/);
      if (m && m[1]) {
        found = m[1].trim();
        return false;
      }
    });
    if (found) return found;
  }

  // Extract from title tag if in format "Title - Author - Site"
  const rawTitle = $("title").text().trim();
  const parts = rawTitle.split(/\s*[-_|\s]\s*/);
  if (parts.length >= 3 && parts[1].length >= 2 && parts[1].length <= 20) {
    if (!/小说|最新|章节|阅读|无弹窗|全文|免费/i.test(parts[1])) {
      return parts[1].trim();
    }
  }

  return "";
}

function cleanDescription(desc) {
  return String(desc || "")
    .replace(/^简介[:：\s]*/, "")
    .replace(/^内容简介[:：\s]*/, "")
    .replace(/^.*?(?:全文阅读|免费阅读|小说阅读)[:：\s]*/i, "")
    .replace(/\s+/g, " ")
    .replace(/\s*(最新章节|全文阅读|免费阅读|无弹窗|txt下载)$/gi, "")
    .trim();
}

export function pageDescription($, url) {
  const metaDesc =
    $('meta[property="og:description"]').attr("content") ||
    $('meta[name="description"]').attr("content");
  if (metaDesc && metaDesc.trim() && metaDesc.length > 15) {
    return cleanDescription(metaDesc);
  }

  const descSelectors = [
    "#intro",
    ".intro",
    ".introtxt",
    "#bookintro",
    ".book-intro",
    "#synopsis",
    ".synopsis",
    ".description",
    ".summary",
    "#summary",
  ];
  for (const sel of descSelectors) {
    const el = $(sel).first();
    if (el.length) {
      const text = el.text().trim();
      if (text.length > 20) {
        return cleanDescription(text);
      }
    }
  }
  return "";
}

/**
 * Extract recommended novels from the novel's webpage / source site.
 * Supports swiper carousels, recommendation blocks, like lists, and related novel links.
 */
export function extractRecommendations($, baseUrl, currentNovelTitle = "") {
  const recommendations = [];
  const seenUrls = new Set();
  const seenTitles = new Set();

  function cleanT(t) {
    if (!t) return "";
    return t
      .replace(/[\r\n\t]+/g, " ")
      .replace(/\s*(最新章节|全文阅读|免费阅读|无弹窗|txt下载|列表|目录|在线阅读|小说)\s*$/gi, "")
      .trim();
  }

  const cleanCurrent = cleanT(currentNovelTitle).toLowerCase();
  if (cleanCurrent) seenTitles.add(cleanCurrent);

  function cleanUrl(href) {
    if (!href) return null;
    try {
      const u = new URL(href, baseUrl);
      if (u.protocol !== "http:" && u.protocol !== "https:") return null;
      const p = u.pathname.toLowerCase();
      if (
        p === "/" ||
        p === "" ||
        /login|register|search|rank|top|user|history|allvisit|monthvisit|goodnum|lastupdate|leibie|category|sort|tag|down|download|app/i.test(
          p
        )
      ) {
        return null;
      }
      return u.href;
    } catch {
      return null;
    }
  }

  function cleanAuthor(raw) {
    if (!raw) return "";
    return raw
      .replace(/^作\s*者[:：\s]*/i, "")
      .replace(/[\r\n\t]+/g, " ")
      .trim();
  }

  // 1. Rich Cards (.swiper-slide, [class*='book-item'], ul.list li, etc.)
  $(
    ".swiper-slide, [class*='swiper-slide'], [class*='rec-item'], [class*='book-item'], .tui-item, " +
    "ul.list li:has(img), .list li:has(img), .booklist li, [class*='book-list'] li, " +
    "li:has(img):has(a), li:has(.intro), li:has(.bookname), .like-list li, .guess-list li, " +
    "div.box ul li:has(img)"
  ).each((_, el) => {
    const $el = $(el);

    const $img = $el.find("img");
    let coverUrl =
      $img.attr("data-src") ||
      $img.attr("data-original") ||
      $img.attr("data-echo") ||
      $img.attr("src") ||
      null;
    if (coverUrl && (/default|placeholder|loading|blank/i.test(coverUrl) || coverUrl.endsWith(".gif"))) {
      coverUrl = $img.attr("data-src") || $img.attr("data-original") || null;
    }
    if (coverUrl) {
      try {
        coverUrl = new URL(coverUrl, baseUrl).href;
      } catch {}
    }

    const rawTitle =
      $el.find(".name, .title, [class*='title'], .bookname, h3, h4, h2").first().text().trim() ||
      $el.find("img[alt]").attr("alt") ||
      $el.find("a[title]").attr("title") ||
      "";
    const title = cleanT(rawTitle || $el.find("a").first().text().trim().split(/[\n\r]+/)[0]);
    if (!title || title.length < 2 || title.length > 50) return;
    if (CHAPTER_TEXT.test(title)) return; // Discard chapter items!
    if (cleanCurrent && (title.toLowerCase().includes(cleanCurrent) || cleanCurrent.includes(title.toLowerCase()))) return;
    if (seenTitles.has(title.toLowerCase())) return;

    let href = null;
    const $titleLink = $el.find(".bookname a, .title a, [class*='title'] a, h3 a, h4 a, h2 a").first();
    if ($titleLink.length && $titleLink.attr("href")) {
      href = cleanUrl($titleLink.attr("href"));
    }
    if (!href) {
      $el.find("a[href]").each((_, a) => {
        if (href) return;
        const h = $(a).attr("href");
        if (h && (/info-|shu\/|book\/|read\/|novel\//i.test(h) || !/javascript|void/i.test(h))) {
          const cu = cleanUrl(h);
          if (cu) href = cu;
        }
      });
    }
    if (!href) {
      const $a = $el.find("a[href]").first();
      href = cleanUrl($a.attr("href") || $el.attr("href"));
    }
    if (!href || seenUrls.has(href)) return;

    const rawAuthor = $el.find(".author, [class*='author']").first().text().trim();
    const author = cleanAuthor(rawAuthor);

    const tags = [];
    $el.find(".tags, [class*='tag'], [class*='type'], [class*='cate'], .data span, .layui-btn").each((_, s) => {
      const st = $(s).text().trim();
      if (st && st.length >= 2 && st.length <= 15 && !st.startsWith("最新") && !/^\d+$/.test(st) && !CHAPTER_TEXT.test(st)) {
        st.split(/[|\s,/，、]+/).forEach((t) => {
          const ct = t.trim();
          if (ct && ct.length >= 2 && ct.length <= 15 && !ct.startsWith("最新") && !/^\d+$/.test(ct)) {
            tags.push(ct);
          }
        });
      }
    });

    const rawDesc = $el.find(".intro, [class*='intro'], .desc, [class*='desc'], p:not(.bookname):not(.data)").first().text().trim();
    const synopsis = rawDesc.replace(/^[\s　]+/, "").replace(/[\r\n\t]+/g, " ").slice(0, 300);

    seenUrls.add(href);
    seenTitles.add(title.toLowerCase());
    recommendations.push({
      title,
      titleZh: title,
      titleEn: title,
      author: author || "Unknown",
      tags,
      synopsis,
      coverUrl,
      sourceUrl: href,
      inLibrary: false,
    });
  });

  // 2. Recommendation containers (.recommend, [class*='like'], .tui, etc.)
  if (recommendations.length < 8) {
    const recContainers = $(
      "[class*='recommend'], [id*='recommend'], [class*='guess'], [class*='like'], [class*='same'], [class*='relat'], [class*='tui'], [id*='tui'], .readtop, .quantop, .newtop"
    );
    recContainers.find("a[href]").each((_, a) => {
      if (recommendations.length >= 10) return;
      const $a = $(a);
      const href = cleanUrl($a.attr("href"));
      if (!href || seenUrls.has(href)) return;

      const title = cleanT($a.text());
      if (
        !title ||
        title.length < 2 ||
        title.length > 40 ||
        CHAPTER_TEXT.test(title) ||
        /^(大家在看|站内强推|经典收藏|最近更新|更多|排行榜|分类|首页|书架|全部)$/.test(title)
      ) {
        return;
      }
      if (cleanCurrent && (title.toLowerCase().includes(cleanCurrent) || cleanCurrent.includes(title.toLowerCase()))) return;
      if (seenTitles.has(title.toLowerCase())) return;

      seenUrls.add(href);
      seenTitles.add(title.toLowerCase());
      recommendations.push({
        title,
        titleZh: title,
        titleEn: title,
        author: "Unknown",
        tags: [],
        synopsis: "",
        coverUrl: null,
        sourceUrl: href,
        inLibrary: false,
      });
    });
  }

  return recommendations;
}

function scoreElement($, el) {
  const text = $(el).text();
  const cjk = cjkCount(text);
  if (cjk < 150) return 0;
  let linkCjk = 0;
  $(el)
    .find("a")
    .each((_, a) => {
      linkCjk += cjkCount($(a).text());
    });
  return cjk - linkCjk * 4;
}

const CONTENT_SELECTORS = [
  "#content",
  "#chaptercontent",
  "#chapterContent",
  "#booktext",
  "#htmlContent",
  "#chapter-content",
  "#nr1",
  "#txtContent",
  "#mw-content-text",
  ".mw-parser-output",
  ".content",
  ".read-content",
  ".article-content",
  ".chapter-content",
  ".entry-content",
  ".content-text",
  ".showtxt",
  ".txt",
  ".text",
  "article",
];

function isDescendant(child, parent) {
  let node = child?.parent;
  while (node) {
    if (node === parent) return true;
    node = node.parent;
  }
  return false;
}

function pickContainer($) {
  const candidates = [];
  const add = (el) => {
    if (!el || candidates.some((c) => c.el === el)) return;
    const score = scoreElement($, el);
    if (score > 0) candidates.push({ el, score });
  };

  for (const selector of CONTENT_SELECTORS) $(selector).each((_, el) => add(el));
  $("div, section, article").each((_, el) => {
    if ($(el).find("p").length >= 3 || $(el).find("br").length >= 5) add(el);
  });

  if (!candidates.length) return null;
  candidates.sort((a, b) => b.score - a.score);

  const chosen = candidates.find(
    (c) =>
      c.score >= 150 &&
      !candidates.some((d) => d !== c && d.score >= c.score * 0.9 && isDescendant(d.el, c.el)),
  );
  return (chosen || (candidates[0].score >= 150 ? candidates[0] : null))?.el ?? null;
}

function toLines($, el) {
  const clone = $(el).clone();
  clone.find("script,style,noscript,iframe,ins,form,nav,footer,aside").remove();
  clone.find("p,div,h1,h2,h3,h4,h5,h6,li,blockquote").each((_, node) => {
    $(node).append("\n");
  });
  let html = clone.html() || "";
  html = html.replace(/<br\s*\/?>/gi, "\n");
  const text = cheerio.load(`<div>${html}</div>`)("div").text();
  return text
    .split(/\n+/)
    .map((line) => line.replace(/[\u00a0\u3000]/g, " ").replace(/\s+/g, " ").trim())
    .filter((line) => line.length >= 2)
    .filter((line) => !AD_LINE.test(line) && !BOILERPLATE.test(line))
    .filter((line) => cjkCount(line) > 0 || /[a-zA-Z]{3,}/.test(line));
}

export function extractChapter(html, url) {
  const $ = cheerio.load(html);
  const title = pageTitle($, url);

  $("script,style,noscript,iframe,ins,form,nav,footer,header,aside").remove();
  $('[id^="ad-"],[id$="-ad"],[class^="ad-"],[class$="-ad"],[class*=" banner"],[class*="adsbygoogle"]').remove();

  const container = pickContainer($);
  let paragraphs = container ? toLines($, container) : [];

  // Some sites append the next chapter's title block or ads to the body
  const tailStart = Math.floor(paragraphs.length * 0.85);
  const cut = paragraphs.findIndex(
    (line, i) => i >= tailStart && i >= 5 && /^第\s*[0-9零一二三四五六七八九十百千万两〇]+\s*[回章节篇]$/.test(line),
  );
  if (cut > 0) paragraphs = paragraphs.slice(0, cut);

  const joined = paragraphs.join("");
  return {
    title,
    paragraphs,
    cjkRatio: joined.length ? cjkCount(joined) / joined.length : 0,
    charCount: joined.length,
  };
}

/**
 * Fetch a complete chapter, handling multi-page chapters (e.g. 123_2.html, (1/2), 下一页)
 * seamlessly stitching all parts into one full chapter.
 */
export async function fetchFullChapter(initialUrl, { slug = "", index = 0 } = {}) {
  const cacheKey = buildSourceKey(slug || "novel", index || 0, initialUrl);
  const cached = getSourceCache(cacheKey);
  if (cached && Array.isArray(cached.paragraphs) && cached.paragraphs.length > 0) {
    return cached;
  }

  let page = await fetchPage(initialUrl);
  const firstExtract = extractChapter(page.html, page.finalUrl);
  const allParagraphs = [...firstExtract.paragraphs];
  const seenPages = new Set([page.finalUrl]);

  // Check up to 5 sub-pages for the same chapter
  for (let part = 2; part <= 6; part++) {
    const $ = cheerio.load(page.html);
    let nextSubPageUrl = null;

    $("a[href]").each((_, a) => {
      const text = $(a).text().trim();
      // Must be "下一页" (next page) or explicit page number (2)
      if (/^下一页$/i.test(text) || new RegExp(`^[（(]?${part}[)）]?$`).test(text)) {
        const raw = $(a).attr("href");
        try {
          const abs = new URL(raw, page.finalUrl).href;
          if (sameOrigin(abs, page.finalUrl) && !seenPages.has(abs)) {
            // Distinguish sub-page from next CHAPTER: sub-page has _2, -2, p=2, or title continuation
            const isSub =
              abs.includes(`_${part}`) ||
              abs.includes(`-${part}`) ||
              abs.includes(`page=${part}`) ||
              abs.includes(`p=${part}`) ||
              (firstExtract.title && text === "下一页" && !/下一[章节回篇]/.test(text));
            if (isSub) {
              nextSubPageUrl = abs;
            }
          }
        } catch {}
      }
    });

    if (!nextSubPageUrl) break;

    try {
      seenPages.add(nextSubPageUrl);
      page = await fetchPage(nextSubPageUrl);
      const subExtract = extractChapter(page.html, page.finalUrl);
      if (subExtract.paragraphs.length > 0) {
        allParagraphs.push(...subExtract.paragraphs);
      } else {
        break;
      }
    } catch {
      break;
    }
  }

  // Deduplicate consecutive identical lines (e.g. watermarks)
  const cleanParagraphs = [];
  for (const p of allParagraphs) {
    if (!cleanParagraphs.length || cleanParagraphs[cleanParagraphs.length - 1] !== p) {
      cleanParagraphs.push(p);
    }
  }

  const result = {
    ...firstExtract,
    paragraphs: cleanParagraphs,
    charCount: cleanParagraphs.join("").length,
    contentHash: getContentHash(cleanParagraphs),
  };
  setSourceCache(cacheKey, result);
  return result;
}

function anchorList($, base) {
  const out = [];
  const seen = new Set();
  $("a[href]").each((_, a) => {
    const raw = $(a).attr("href");
    if (!raw || raw.startsWith("#") || raw.startsWith("javascript:")) return;
    let abs;
    try {
      abs = new URL(raw, base).href;
    } catch {
      return;
    }
    if (!/^https?:/i.test(abs)) return;
    if (seen.has(abs)) return;
    const text = $(a).text().replace(/\s+/g, " ").trim();
    if (!text || NAV_TEXT.test(text)) return;
    seen.add(abs);
    out.push({ text, url: abs, order: out.length });
  });
  return out;
}

// A URL that plausibly points at a chapter, not a nav/menu entry.
function chapterishUrl(url) {
  let decoded = url;
  try {
    decoded = decodeURIComponent(url);
  } catch {
    /* keep raw */
  }
  return (
    /第\s*[0-9零一二三四五六七八九十百千万两〇]+\s*[章节回卷话集篇]/.test(decoded) ||
    /chapter[_-]?\d+/i.test(decoded) ||
    /[/_-]\d{1,6}(?:[._/-]|\.html?$)/i.test(decoded) ||
    /\d{1,6}\.html?$/i.test(decoded)
  );
}

/**
 * Extract chapter links from an HTML document, identifying the primary chapter container
 * and stripping out preview banners / top latest chapter modules.
 */
export function extractChapterAnchors($, baseUrl) {
  // 1. Remove obvious non-chapter components & recommendation blocks
  $("script, style, noscript, iframe, ins, form, nav, footer, header, aside, .footer, .header, #footer, #header, .ad, [class*='ad-']").remove();
  $(".swiper-container, .swiper-wrapper, [class*='swiper'], [class*='recommend'], [id*='recommend'], [class*='like'], [class*='other'], [id*='other'], [class*='guess'], [class*='hot-'], [class*='rank-'], [class*='similar'], [id*='similar']").remove();

  // 2. Remove top latest/preview chapter blocks so they don't overwrite Chapter 1
  $(".new, .latest, .update, .recent, [class*='new-chap'], [class*='latest-'], [id*='latest'], #newlist, p.new").remove();

  // 3. Find the dense chapter list container
  const candidateContainers = [
    "#list",
    "#chapterlist",
    "#chapter-list",
    "#chapters",
    ".read",
    ".chapterlist",
    ".chapter-list",
    ".directory-list",
    ".catalog",
    ".mulu",
    "#mulu",
    ".book-chapter-list",
    ".section-box",
    ".box_con",
    "#defaulthtml4",
    "div.list",
    "ul.read",
    "ul.list",
    "div.read",
    "div.book_list",
  ];

  let best = $("body");
  for (const sel of candidateContainers) {
    const el = $(sel).first();
    if (el.length && el.find("a[href]").length >= 3) {
      best = el;
      break;
    }
  }

  // Fallback: look for ul, ol, dl, div with densest link count
  if (best.is("body")) {
    let maxCount = 0;
    $("ul, ol, dl, div").each((_, el) => {
      if ($(el).is("header, nav, footer, form") || $(el).parents("header, nav, footer, form").length) return;
      const count = $(el).find("a[href]").length;
      if (count > maxCount && count >= 4) {
        maxCount = count;
        best = $(el);
      }
    });
  }

  const list = [];
  const seen = new Set();
  best.find("a[href]").each((_, a) => {
    const raw = $(a).attr("href");
    if (!raw || raw.startsWith("#") || raw.startsWith("javascript:")) return;
    let abs;
    try {
      abs = new URL(raw, baseUrl).href;
    } catch {
      return;
    }
    if (!sameOrigin(abs, baseUrl) || seen.has(abs)) return;

    let text = $(a).text().replace(/\s+/g, " ").trim();
    // Strip timestamps like 2022-02-04 05:54 or 2022-02-04
    text = text.replace(/^\d{4}[-/]\d{2}[-/]\d{2}(?:\s*\d{2}:\d{2}(?::\d{2})?)?\s*/, "").trim();
    text = text.replace(/\s*\d{4}[-/]\d{2}[-/]\d{2}.*$/, "").trim();
    text = text.replace(/\s*[(（]\d+[/_]\d+[)）]\s*$/, "").trim();
    if (!text || text.length > 70) return;
    if (NAV_TEXT.test(text)) return;
    if (/^(返回|书页|书架|书评|加入书架|投推荐票|电脑版|手机版|客户端|上一页|下一页|免费阅读|开始阅读|立即阅读)$/.test(text)) return;
    if (/目录|最新章节|全部章节/.test(text) && !/第\s*[0-9零一二三四五六七八九十百千万两〇]/.test(text)) return;

    // Check if it looks like a chapter (by title or by URL)
    if (CHAPTER_TEXT.test(text) || chapterishUrl(abs) || !best.is("body")) {
      seen.add(abs);
      list.push({ title: text, url: abs });
    }
  });

  return list;
}

/**
 * Discover all TOC pagination URLs from a TOC page (select dropdowns, pagination buttons, page ranges).
 */
export function discoverTocPages($, baseUrl) {
  const pages = new Set();
  pages.add(baseUrl);

  // 1. <select> dropdowns (common on mobile novel sites: 第1-50章, 第51-100章...)
  $("select option").each((_, opt) => {
    const val = $(opt).attr("value");
    if (val) {
      try {
        const abs = new URL(val, baseUrl).href;
        if (sameOrigin(abs, baseUrl)) pages.add(abs);
      } catch {}
    }
  });

  // 2. Pagination links
  $("[class*='page'], .page, .pager, .pagelist, #pages, .pagination").find("a[href]").each((_, a) => {
    const text = $(a).text().trim();
    const href = $(a).attr("href");
    if (!href) return;
    try {
      const abs = new URL(href, baseUrl).href;
      if (!sameOrigin(abs, baseUrl)) return;
      if (/^\d{1,4}$/.test(text) || /下一页|下页|末页|尾页/i.test(text)) {
        pages.add(abs);
      }
      // If "尾页" or "末页" reveals total page count (e.g. /shu/86569_23/ or ?page=23)
      if (/末页|尾页/i.test(text)) {
        const m = abs.match(/_(\d+)\/?$/) || abs.match(/[?&]page=(\d+)/i) || abs.match(/page\/(\d+)/i);
        if (m) {
          const total = parseInt(m[1], 10);
          if (total > 1 && total <= 80) {
            const prefix = abs.slice(0, m.index);
            const isUnder = m[0].startsWith("_");
            for (let p = 1; p <= total; p++) {
              pages.add(isUnder ? `${prefix}_${p}/` : `${prefix}?page=${p}`);
            }
          }
        }
      }
    } catch {}
  });

  return Array.from(pages);
}

/**
 * Controlled concurrency map helper.
 */
async function pMap(items, fn, concurrency = 4) {
  const results = [];
  const executing = [];
  for (const item of items) {
    const p = Promise.resolve().then(() => fn(item));
    results.push(p);
    if (concurrency <= items.length) {
      const e = p.then(() => executing.splice(executing.indexOf(e), 1));
      executing.push(e);
      if (executing.length >= concurrency) {
        await Promise.race(executing);
      }
    }
  }
  return Promise.all(results);
}

/**
 * Detect descending/reverse chapter order and normalize to chronological order (Chapter 1 to N).
 */
function normalizeChapterOrder(chapters) {
  if (chapters.length < 5) return chapters;

  const numbers = [];
  for (let i = 0; i < Math.min(chapters.length, 30); i++) {
    const m =
      chapters[i].title.match(/第\s*(\d+)\s*[章节回卷话集篇]/) ||
      chapters[i].title.match(/^(\d{1,5})/);
    if (m) numbers.push({ index: i, num: parseInt(m[1], 10) });
  }

  // If majority of sampled chapter numbers are descending, reverse the array
  if (numbers.length >= 3) {
    let descendingCount = 0;
    for (let i = 1; i < numbers.length; i++) {
      if (numbers[i].num < numbers[i - 1].num) descendingCount++;
    }
    if (descendingCount >= numbers.length * 0.7) {
      chapters.reverse();
    }
  }

  return chapters.map((c, i) => ({
    index: i + 1,
    title: c.title,
    url: c.url,
  }));
}

/**
 * Extract TOC from a single HTML page.
 */
export function extractToc(html, baseUrl) {
  const $ = cheerio.load(html);
  const rawList = extractChapterAnchors($, baseUrl);
  return normalizeChapterOrder(rawList);
}

/**
 * Fetch the complete table of contents, discovering all pagination pages and stitching them.
 */
export async function fetchCompleteToc(initialUrl) {
  const main = await fetchPage(initialUrl);
  const $ = cheerio.load(main.html);
  let novelTitle = pageTitle($, main.finalUrl);

  // Check if there is an "All Chapters" / "完整目录" page
  let targetUrl = main.finalUrl;
  let allChaptersUrl = null;
  $("a[href]").each((_, a) => {
    const text = $(a).text().trim();
    const href = $(a).attr("href");
    const isTocAnchor =
      /^(全部章节|完整目录|所有章节|查看全部|查看目录|章节列表|目录)$/.test(text) ||
      /(全部章节|完整目录|所有章节|章节列表)/.test(text) ||
      (href && /(?:list\.html|all\.html|mulu\.html|\/catalog\/?|\/chapters\/?)$/i.test(href) && !/(?:login|user|download|app)/i.test(href));

    if (isTocAnchor && href) {
      try {
        const abs = new URL(href, main.finalUrl).href;
        if (sameOrigin(abs, main.finalUrl)) allChaptersUrl = abs;
      } catch {}
    }
  });

  let workingPage = main;
  if (allChaptersUrl && allChaptersUrl !== main.finalUrl) {
    try {
      const p = await fetchPage(allChaptersUrl);
      const testExtract = extractChapterAnchors(cheerio.load(p.html), p.finalUrl);
      // Only switch to allChaptersUrl if it actually returns chapters!
      if (testExtract.length > 0) {
        workingPage = p;
        targetUrl = workingPage.finalUrl;
      }
    } catch {}
  }

  const working$ = cheerio.load(workingPage.html);
  const pages = discoverTocPages(working$, targetUrl);

  // Fetch all discovered TOC pages concurrently
  const pageResults = await pMap(
    pages,
    async (pUrl) => {
      if (pUrl === targetUrl) {
        return extractChapterAnchors(working$, targetUrl);
      }
      try {
        const p = await fetchPage(pUrl);
        return extractChapterAnchors(cheerio.load(p.html), p.finalUrl);
      } catch {
        return [];
      }
    },
    4,
  );

  const combined = [];
  const seen = new Set();
  for (const pageAnchors of pageResults) {
    for (const a of pageAnchors) {
      if (!seen.has(a.url)) {
        seen.add(a.url);
        combined.push(a);
      }
    }
  }

  // Also include anchors extracted from main page if workingPage was separate
  if (workingPage !== main) {
    const mainAnchors = extractChapterAnchors($, main.finalUrl);
    for (const a of mainAnchors) {
      if (!seen.has(a.url)) {
        seen.add(a.url);
        combined.push(a);
      }
    }
  }

  // Detect "Start Reading" button on main page
  let startReadingUrl = null;
  $("a[href]").each((_, a) => {
    const text = $(a).text().trim();
    if (/^(免费阅读|开始阅读|立即阅读|点击阅读|阅读第一章|从头阅读|第一章|第1章)$/.test(text)) {
      try {
        startReadingUrl = new URL($(a).attr("href"), main.finalUrl).href;
      } catch {}
    }
  });

  let finalChapters = [];

  // Filter out any directory/catalog link that got captured
  const actualChapters = combined.filter((c) => {
    if (/catalog|mulu|dir|index/i.test(new URL(c.url).pathname) && !/\/\d+$/.test(new URL(c.url).pathname)) return false;
    if (/目录|最新章节/i.test(c.title) && !/第\s*[0-9零一二三四五六七八九十百千万两〇]/.test(c.title)) return false;
    return true;
  });

  // Check if we can synthesize complete chapters using numeric sequential pattern
  const allCandidateUrls = [...actualChapters.map((c) => c.url)];
  if (startReadingUrl) allCandidateUrls.unshift(startReadingUrl);

  const getNum = (u) => {
    const m = String(u || "").match(/[/_-](\d+)(?:\.html?)?$/);
    return m ? parseInt(m[1], 10) : null;
  };

  const startNum = startReadingUrl ? getNum(startReadingUrl) : Math.min(...actualChapters.map((c) => getNum(c.url) || Infinity));
  const maxNum = Math.max(...allCandidateUrls.map((u) => getNum(u) || 0));

  if (startNum === 1 && maxNum > 1 && maxNum <= 5000 && actualChapters.length < maxNum) {
    // We found a sequential chapter pattern! e.g. /xs_1/57733/1 to /xs_1/57733/283
    const refUrl = startReadingUrl || actualChapters.find((c) => getNum(c.url) === 1)?.url;
    if (refUrl) {
      const template = refUrl.replace(/([/_-])1(?:\.html?)?$/, "$1{INDEX}");
      const titleMap = new Map();
      for (const c of actualChapters) {
        titleMap.set(c.url, c.title);
      }

      // If chapter 1 title is missing or generic, peek Chapter 1 page
      let ch1Title = titleMap.get(refUrl);
      if (!ch1Title || ch1Title.startsWith("Chapter") || ch1Title === "免费阅读") {
        try {
          const ch1Page = await fetchPage(refUrl);
          ch1Title = pageTitle(cheerio.load(ch1Page.html), refUrl);
        } catch {}
      }

      const synthesized = [];
      for (let i = 1; i <= maxNum; i++) {
        const chUrl = template.replace("{INDEX}", String(i));
        let chTitle = titleMap.get(chUrl) || "";
        if (i === 1 && ch1Title) {
          chTitle = ch1Title;
        } else if (!chTitle) {
          chTitle = `Chapter ${i}`;
        }
        synthesized.push({ index: i, title: chTitle, url: chUrl });
      }
      finalChapters = synthesized;
    }
  }

  if (!finalChapters.length) {
    finalChapters = normalizeChapterOrder(actualChapters);
  }

  let coverUrl = findCoverImage(working$, targetUrl, novelTitle) || findCoverImage($, main.finalUrl, novelTitle);
  let author = pageAuthor(working$, targetUrl) || pageAuthor($, main.finalUrl) || "";
  let description = pageDescription(working$, targetUrl) || pageDescription($, main.finalUrl) || "";
  let recommendations =
    extractRecommendations(working$, targetUrl, novelTitle).length > 0
      ? extractRecommendations(working$, targetUrl, novelTitle)
      : extractRecommendations($, main.finalUrl, novelTitle);

  // If recommendations have no covers or details, or cover/description are missing, check for a novel info/details page!
  const isRecsDegraded = !recommendations.length || recommendations.every((r) => !r.coverUrl && !r.synopsis);
  if (isRecsDegraded || !coverUrl || !description) {
    const infoUrl = findInfoUrl(working$, targetUrl) || findInfoUrl($, main.finalUrl);
    if (infoUrl && infoUrl !== targetUrl && infoUrl !== main.finalUrl) {
      try {
        const infoPage = await fetchPage(infoUrl);
        const info$ = cheerio.load(infoPage.html);
        if (isRecsDegraded) {
          const infoRecs = extractRecommendations(info$, infoPage.finalUrl, novelTitle);
          if (infoRecs.length > 0 && infoRecs.some((r) => r.coverUrl || r.synopsis)) {
            recommendations = infoRecs;
          }
        }
        if (!coverUrl) coverUrl = findCoverImage(info$, infoPage.finalUrl, novelTitle);
        if (!description) description = pageDescription(info$, infoPage.finalUrl);
        if (!author) author = pageAuthor(info$, infoPage.finalUrl);
      } catch {}
    }
  }

  return {
    chapters: finalChapters,
    novelTitle,
    finalTocUrl: targetUrl,
    coverUrl,
    author,
    description,
    startReadingUrl,
    recommendations,
  };
}

/**
 * Find novel info/details page URL from TOC or chapter pages.
 */
export function findInfoUrl(input, baseUrl) {
  const $ = typeof input === "function" ? input : (typeof input === "string" ? cheerio.load(input) : cheerio.load(""));
  let infoUrl = null;

  // 1. Explicit link text or href
  $("a[href]").each((_, a) => {
    if (infoUrl) return;
    const text = $(a).text().trim();
    const href = $(a).attr("href");
    if (!href) return;
    if (
      /^(书籍详情|返回书页|小说详情|作品详情|小说信息|作品信息|查看详情|小说介绍|书本详情)$/.test(text) ||
      /(info-\d+|book-\d+|\/info\/\d+|\/book\/\d+)/i.test(href)
    ) {
      try {
        const abs = new URL(href, baseUrl).href;
        if (sameOrigin(abs, baseUrl) && abs !== baseUrl) {
          infoUrl = abs;
        }
      } catch {}
    }
  });

  if (infoUrl) return infoUrl;

  // 2. Check header, listtop, breadcrumbs
  $(".listtop, .nav, .weizhi, .path, .breadcrumb").find("a[href]").each((_, a) => {
    if (infoUrl) return;
    const href = $(a).attr("href");
    if (href && /info|book|detail|novel/i.test(href)) {
      try {
        const abs = new URL(href, baseUrl).href;
        if (sameOrigin(abs, baseUrl) && abs !== baseUrl) {
          infoUrl = abs;
        }
      } catch {}
    }
  });

  if (infoUrl) return infoUrl;

  // 3. Known URL pattern mappings (e.g. m.ilwxs.com /shu/ID/ -> /info-ID.html)
  try {
    const u = new URL(baseUrl);
    const mShu = u.pathname.match(/\/shu\/(\d+)\/?$/);
    if (mShu) {
      return new URL(`/info-${mShu[1]}.html`, baseUrl).href;
    }
    const mBookMulu = u.pathname.match(/\/(book|novel)\/(\d+)\/(mulu|dir|catalog)\/?$/);
    if (mBookMulu) {
      return new URL(`/${mBookMulu[1]}/${mBookMulu[2]}`, baseUrl).href;
    }
  } catch {}

  return null;
}

/**
 * Find TOC URL from any page (supports breadcrumbs, nav links, and URL path reduction).
 */
export function findTocUrl(html, baseUrl) {
  const $ = cheerio.load(html);

  // 1. Breadcrumbs: <div class="breadcrumb">, <div class="path">, .weizhi, nav
  const breadcrumbLinks = $(".breadcrumb a, .path a, .weizhi a, #nav a, nav a");
  if (breadcrumbLinks.length >= 2) {
    for (let i = breadcrumbLinks.length - 1; i >= 0; i--) {
      const a = breadcrumbLinks.eq(i);
      const text = a.text().trim();
      const href = a.attr("href");
      if (href && !NAV_TEXT.test(text) && !/首页|home/i.test(text)) {
        try {
          const abs = new URL(href, baseUrl).href;
          if (sameOrigin(abs, baseUrl) && abs !== baseUrl) return abs;
        } catch {}
      }
    }
  }

  // 2. High priority navigation anchors
  const anchors = anchorList($, baseUrl);
  const scored = anchors
    .map((a) => {
      let score = 0;
      if (/^(目录|章节目录|全部章节|章节列表|返回目录)$/.test(a.text)) score += 25;
      else if (/^(书籍详情|小说详情|书籍简介|作品详情|书本详情|返回书页|书页|书目)$/.test(a.text)) score += 20;
      else if (/目录|章节列表|全部章节|章节目录|完整目录/.test(a.text)) score += 15;
      else if (/书籍详情|小说详情|书籍简介|作品详情/.test(a.text)) score += 12;
      if (/index|catalog|mulu|list|book|shu/i.test(a.url)) score += 5;
      if (a.text.length <= 10) score += 2;
      return { ...a, score };
    })
    .filter((a) => a.score >= 10)
    .sort((a, b) => b.score - a.score);

  if (scored[0]?.url) return scored[0].url;

  // 3. Heuristic URL reduction:
  // e.g. /shu/86569/123.html -> /shu/86569/
  // or /xs_1/57733/1 -> /xs_1/57733
  try {
    const u = new URL(baseUrl);
    const pathParts = u.pathname.split("/").filter(Boolean);
    if (pathParts.length >= 2) {
      const last = pathParts[pathParts.length - 1];
      if (/^\d+\.html?$/i.test(last) || /^\d+$/i.test(last)) {
        pathParts.pop();
        u.pathname = "/" + pathParts.join("/");
        u.hash = "";
        u.search = "";
        return u.href;
      }
    }
  } catch {}

  return null;
}

function incrementUrl(url) {
  try {
    const u = new URL(url);
    const decoded = decodeURIComponent(u.pathname);
    const matches = [...decoded.matchAll(/\d+/g)];
    if (!matches.length) return null;
    const last = matches[matches.length - 1];
    const num = last[0];
    const next = String(Number(num) + 1).padStart(num.length, "0");
    u.pathname = decoded.slice(0, last.index) + next + decoded.slice(last.index + num.length);
    u.hash = "";
    return u.href;
  } catch {
    return null;
  }
}

export function findNextUrl(html, baseUrl) {
  const $ = cheerio.load(html);
  const anchors = anchorList($, baseUrl);
  
  // 1. Next chapter link (下一章, 下一节, 下一回, next chapter)
  let next = anchors.find((a) => /^(下一[章节篇回]|next\s*chapter)$/i.test(a.text));
  if (next?.url) return next.url;

  // 2. "下一页" (next page) - if it leads to a chapter on same origin
  const nextPage = anchors.find((a) => /^下一页$/i.test(a.text));
  if (nextPage?.url && nextPage.url !== baseUrl) {
    return nextPage.url;
  }

  // 3. Fallback to incrementing numeric segment in URL
  return incrementUrl(baseUrl);
}

function normalize(url) {
  try {
    const u = new URL(url);
    u.hash = "";
    return u.href.replace(/\/$/, "");
  } catch {
    return url;
  }
}

/**
 * Smart Novel Resolver: navigates from ANY URL (chapter, book info, or TOC page),
 * discovers all TOC pages, aggregates chapters, and establishes starting position.
 */
export async function resolveNovel(inputUrl) {
  const page = await fetchPage(inputUrl);
  const $ = cheerio.load(page.html);
  let title = pageTitle($, page.finalUrl);
  let coverUrl = findCoverImage($, page.finalUrl, title);

  // Check if input is a single CHAPTER page
  const isChapterPage = Boolean(
    page.html.length > 500 &&
    extractChapter(page.html, page.finalUrl).paragraphs.length >= 4 &&
    (CHAPTER_TEXT.test(title) || findNextUrl(page.html, page.finalUrl))
  );

  let tocUrl = page.finalUrl;
  let targetChapterUrl = isChapterPage ? page.finalUrl : null;

  if (isChapterPage) {
    const detected = findTocUrl(page.html, page.finalUrl);
    if (detected) {
      tocUrl = detected;
    }
  }

  // Fetch complete TOC with pagination discovery
  let { chapters, novelTitle, finalTocUrl, coverUrl: tocCoverUrl, author: tocAuthor, description: tocDesc, startReadingUrl, recommendations } = await fetchCompleteToc(tocUrl);
  if (finalTocUrl) tocUrl = finalTocUrl;
  if (!coverUrl && tocCoverUrl) coverUrl = tocCoverUrl;
  if (novelTitle && (!title || novelTitle.length > title.length || isChapterPage)) {
    title = novelTitle;
  }
  const author = tocAuthor || pageAuthor($, page.finalUrl) || "";
  const description = tocDesc || pageDescription($, page.finalUrl) || "";
  if (!recommendations || !recommendations.length) {
    recommendations = extractRecommendations($, page.finalUrl, title);
  }

  // Fallback to crawling chapter chain if site has no static TOC
  let chainMode = false;
  if (chapters.length < 2) {
    chainMode = true;
    const startUrl = targetChapterUrl || startReadingUrl || page.finalUrl;
    chapters = await crawlChain(startUrl, page.html, 40);
  }

  // Determine starting chapter index
  let startIndex = 1;
  if (targetChapterUrl) {
    const foundIdx = chapters.findIndex((c) => normalize(c.url) === normalize(targetChapterUrl));
    if (foundIdx !== -1) startIndex = foundIdx + 1;
  }

  return { title, author, description, coverUrl, tocUrl, chapters, startIndex, chainMode, finalUrl: page.finalUrl, recommendations };
}

async function crawlChain(startUrl, startHtml, limit) {
  const out = [];
  let url = startUrl;
  let html = startHtml;
  const seen = new Set();

  // If startUrl is a novel info page (not a chapter), find the "Read Chapter 1" button!
  const $start = cheerio.load(startHtml);
  let startChapterUrl = null;
  $start("a[href]").each((_, a) => {
    const text = $start(a).text().trim();
    if (/^(免费阅读|开始阅读|立即阅读|点击阅读|阅读第一章|从头阅读|第一章|第1章)$/.test(text)) {
      try {
        startChapterUrl = new URL($start(a).attr("href"), startUrl).href;
      } catch {}
    }
  });

  if (startChapterUrl && startChapterUrl !== startUrl) {
    url = startChapterUrl;
    try {
      const page = await fetchPage(url);
      html = page.html;
    } catch {}
  }

  while (url && out.length < limit && !seen.has(url)) {
    seen.add(url);
    const $ = cheerio.load(html);
    out.push({ index: out.length + 1, title: pageTitle($, url), url });
    const next = findNextUrl(html, url);
    if (!next) break;
    url = next;
    try {
      const page = await fetchPage(url);
      html = page.html;
      if (extractChapter(html, url).paragraphs.length < 3) break;
    } catch {
      break;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return out;
}

export async function extendChain(lastChapter) {
  if (!lastChapter?.url) return null;
  const page = await fetchPage(lastChapter.url);
  const next = findNextUrl(page.html, lastChapter.url);
  if (!next) return null;
  const nextPage = await fetchPage(next);
  const title = pageTitle(cheerio.load(nextPage.html), next);
  return { title, url: next };
}
