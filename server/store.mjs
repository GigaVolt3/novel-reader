import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const ROOT = path.resolve(import.meta.dirname, "..");
export const NOVELS = path.join(ROOT, "novels");
export const CACHE = path.join(ROOT, "cache");
export const CONFIG_PATH = path.join(ROOT, "config.json");

// Auto-load .env if present (built into Node.js 20.6+)
export function loadEnv() {
  const envFile = path.join(ROOT, ".env");
  if (fs.existsSync(envFile)) {
    try {
      if (typeof process.loadEnvFile === "function") {
        process.loadEnvFile(envFile);
      } else {
        const content = fs.readFileSync(envFile, "utf8");
        for (const line of content.split("\n")) {
          const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
          if (match && !line.trim().startsWith("#")) {
            const key = match[1];
            let value = (match[2] || "").trim();
            if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
            if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
            if (!process.env[key]) process.env[key] = value;
          }
        }
      }
    } catch {
      /* ignore */
    }
  }
}
loadEnv();

function hasGroqKey() {
  return Boolean(process.env.GROQ_API_KEY);
}

function hasOpenRouterKey() {
  return Boolean(process.env.OPENROUTER_API_KEY);
}

export const DEFAULT_CONFIG = {
  port: 7777,
  model: hasGroqKey()
    ? { providerID: "groq", id: "groq/auto" }
    : { providerID: "openrouter", id: "openrouter/free" },
  batchChars: 1400,
  prefetch: 2,
  autoTranslate: true,
};

for (const dir of [NOVELS, CACHE]) fs.mkdirSync(dir, { recursive: true });

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const uniqueId = `${process.pid}.${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const tmp = `${file}.${uniqueId}.tmp`;
  const data = JSON.stringify(value, null, 2);
  fs.writeFileSync(tmp, data, "utf8");
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    if (err.code === "EBUSY" || err.code === "EPERM") {
      try {
        fs.writeFileSync(file, data, "utf8");
        if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
      } catch {}
    } else {
      throw err;
    }
  }
}

export function loadConfig() {
  return { ...DEFAULT_CONFIG, ...(readJson(CONFIG_PATH, {}) || {}) };
}

export function saveConfig(patch) {
  const next = { ...loadConfig(), ...patch };
  writeJson(CONFIG_PATH, next);
  return next;
}

export function slugify(input) {
  const base = String(input || "novel")
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  const hash = crypto.createHash("sha1").update(String(input)).digest("hex").slice(0, 6);
  return `${base || "novel"}-${hash}`;
}

export const novelDir = (slug) => path.join(NOVELS, slug);
export const chapterFile = (slug, index) =>
  path.join(novelDir(slug), "chapters", `${String(index).padStart(4, "0")}.json`);
export const HISTORY_FILE = path.join(CACHE, "history.json");

export function getHistory() {
  return readJson(HISTORY_FILE, []);
}

export function recordHistory(item) {
  const list = getHistory();
  const filtered = list.filter((h) => !(h.slug === item.slug && h.chapterIndex === item.chapterIndex));
  filtered.unshift({
    ...item,
    readAt: Date.now(),
  });
  const trimmed = filtered.slice(0, 100);
  writeJson(HISTORY_FILE, trimmed);
  return trimmed;
}

export function clearHistory() {
  writeJson(HISTORY_FILE, []);
}

export function listNovels() {
  return fs
    .readdirSync(NOVELS, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => readJson(path.join(NOVELS, d.name, "meta.json")))
    .filter(Boolean)
    .filter((m) => m.inLibrary !== false)
    .map((m) => {
      const toc = readJson(path.join(novelDir(m.slug), "toc.json"), []);
      return { ...m, chapterCount: toc.length };
    })
    .sort((a, b) => (b.lastReadAt || b.updatedAt || 0) - (a.lastReadAt || a.updatedAt || 0));
}

export function getNovel(slug) {
  return readJson(path.join(novelDir(slug), "meta.json"));
}

export function saveNovel(meta) {
  meta.updatedAt = Date.now();
  writeJson(path.join(novelDir(meta.slug), "meta.json"), meta);
  return meta;
}

export function getToc(slug) {
  return readJson(path.join(novelDir(slug), "toc.json"), []);
}

export function realignChapters(slug, toc) {
  const dir = path.join(novelDir(slug), "chapters");
  if (!fs.existsSync(dir) || !Array.isArray(toc) || toc.length === 0) return;
  const urlToIndex = new Map();
  for (const entry of toc) {
    if (entry.url && entry.index) {
      urlToIndex.set(entry.url, entry.index);
    }
  }

  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  const chapters = [];
  for (const f of files) {
    const fullPath = path.join(dir, f);
    const data = readJson(fullPath);
    if (data && data.url) {
      chapters.push({ path: fullPath, data });
    }
  }

  const toMove = [];
  for (const item of chapters) {
    const targetIndex = urlToIndex.get(item.data.url);
    if (targetIndex && targetIndex !== item.data.index) {
      toMove.push({ item, targetIndex });
    }
  }

  if (toMove.length === 0) return;

  const inMemory = toMove.map(({ item, targetIndex }) => {
    item.data.index = targetIndex;
    return {
      oldPath: item.path,
      targetIndex,
      data: item.data,
    };
  });

  for (const { oldPath } of inMemory) {
    try {
      if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
    } catch {}
  }

  for (const { targetIndex, data } of inMemory) {
    saveChapter(slug, targetIndex, data);
  }
}

export function saveToc(slug, toc) {
  writeJson(path.join(novelDir(slug), "toc.json"), toc);
  realignChapters(slug, toc);
}

export function getGlossary(slug) {
  return readJson(path.join(novelDir(slug), "glossary.json"), {
    terms: [],
    policy: { honorifics: "localize", profanity: "moderate" },
  });
}

export function saveGlossary(slug, glossary) {
  writeJson(path.join(novelDir(slug), "glossary.json"), glossary);
}

export function getChapter(slug, index) {
  return readJson(chapterFile(slug, index));
}

export function saveChapter(slug, index, chapter) {
  writeJson(chapterFile(slug, index), chapter);
}

export function chapterStatuses(slug) {
  const dir = path.join(novelDir(slug), "chapters");
  if (!fs.existsSync(dir)) return {};
  const out = {};
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    const ch = readJson(path.join(dir, file));
    if (ch) out[ch.index] = ch.status;
  }
  return out;
}

export function cacheKey(parts) {
  return crypto.createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 32);
}

export function cacheGet(key) {
  return readJson(path.join(CACHE, `${key}.json`));
}

export function cachePut(key, value) {
  writeJson(path.join(CACHE, `${key}.json`), value);
}

// -------- secrets: read and write to environment / .env --------

export function getSecret(name) {
  if (name === "openrouter") {
    return process.env.OPENROUTER_API_KEY || null;
  }
  if (name === "groq") {
    return process.env.GROQ_API_KEY || null;
  }
  return process.env[name] || null;
}

export function setEnvSecret(key, value) {
  const envFile = path.join(ROOT, ".env");
  let content = "";
  if (fs.existsSync(envFile)) {
    content = fs.readFileSync(envFile, "utf8");
  }
  const lines = content.split(/\r?\n/);
  let found = false;
  const newLines = lines
    .map((line) => {
      const match = line.match(/^\s*([\w.-]+)\s*=/);
      if (match && match[1] === key) {
        found = true;
        if (!value) return null; // remove line
        return `${key}="${value}"`;
      }
      return line;
    })
    .filter((line) => line !== null);

  if (!found && value) {
    newLines.push(`${key}="${value}"`);
  }

  const clean = newLines.filter((l) => l !== "").join("\n");
  fs.writeFileSync(envFile, clean ? clean + "\n" : "", "utf8");
  if (value) {
    process.env[key] = value;
  } else {
    delete process.env[key];
  }
}
