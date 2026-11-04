# Novel Reader (zh → en)

An ultra-fast, local-first web novel reader that imports Chinese web novels directly from source URLs or Smart Search, translating them into English using Groq, OpenRouter, and Google Translate (GTX).

---

## 🌟 Key Features

- **⚡ Instant Translation & Reading**:
  - Translates Chinese novels paragraph-by-paragraph with bilingual, English-only, and Chinese-only viewing modes.
  - Multi-tier translation pipeline: Groq (Qwen 2.5/3), OpenRouter, with zero-setup automatic fallback to Google Translate (GTX) when no API keys are configured.
  - Automatic background upgrade: If a chapter was translated using Google fallback, it automatically upgrades to literary AI translation upon revisit when an AI key becomes available.
  - In-app provider toggle in Settings (Groq, OpenRouter, or Google GTX).

- **🔍 Smart Search (Beta) with Deep Multi-Page Crawling**:
  - Google GTX translates the search keyword in <100ms.
  - AI parallel brainstorms up to 5 alternate Chinese spellings in a single API call.
  - Deep pagination crawler navigates across visited novel websites (`quanben.io`, `1qxs.com`, and dynamic sources).
  - Infinite scroll and "Load More" button append batch-translated novel cards seamlessly.
  - Full synopsis popover preview on hover.

- **📚 Library & Reading Progress**:
  - Offline-first library shelf with reading history drawer.
  - Real-time scroll percentage and chapter completion tracking.
  - Source site recommendations widget at the bottom of the novel details page.

---

## 🚀 Quick Start

### 1. Requirements
- Node.js 18+ (tested on Node.js 20 & 26).

### 2. Launch
Simply run:
```bash
run.bat
```
Or manually:
```bash
npm install
node server/index.mjs
```
Then open your browser at:
```
http://127.0.0.1:7777
```

### 3. API Keys (Optional)
- You can add your **Groq API Key** or **OpenRouter API Key** in the in-app **Settings (⚙)** drawer or in a `.env` file.
- If no API key is provided, Novel Reader automatically uses Google Translate (GTX) so you can begin reading immediately with zero configuration.
