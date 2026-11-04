/**
 * Centralized Reading Progress Service (Single Source of Truth)
 * Shared between Server APIs and computed consistently for UI.
 */

export function computeProgress(meta = {}, toc = []) {
  const total = Array.isArray(toc) ? toc.length : Number(meta.chapterCount) || 0;
  const rawReadList = Array.isArray(meta.readChapters) ? meta.readChapters : null;
  
  let readSet;
  if (rawReadList !== null) {
    // If readChapters is explicitly maintained, trust it directly
    readSet = new Set(
      rawReadList
        .map((n) => Number(n))
        .filter((n) => Number.isInteger(n) && n >= 1 && (total === 0 || n <= total))
    );
  } else {
    // Legacy migration: if readChapters was not yet initialized, use lastChapter if scroll >= 80%
    readSet = new Set();
    if (meta.lastChapter && Number(meta.lastChapter) >= 1 && (meta.scrollPercent || 0) >= 80) {
      for (let i = 1; i <= Number(meta.lastChapter); i++) readSet.add(i);
    }
  }

  const chaptersRead = readSet.size;
  const isCompleted = total > 0 && chaptersRead >= total;

  let nextChapter = 1;
  if (total > 0) {
    if (isCompleted) {
      nextChapter = 1; // Completed: allows "Read Again"
    } else if (chaptersRead === 0) {
      nextChapter = 1; // Unread: start at Chapter 1
    } else {
      // Find the next unread chapter: first look forward from lastChapter, then wrap around
      const startCandidate = Math.max(1, Number(meta.lastChapter || 1));
      let found = null;
      for (let i = startCandidate; i <= total; i++) {
        if (!readSet.has(i)) {
          found = i;
          break;
        }
      }
      if (!found) {
        for (let i = 1; i <= total; i++) {
          if (!readSet.has(i)) {
            found = i;
            break;
          }
        }
      }
      nextChapter = found || 1;
    }
  }

  const progressPercent = total > 0 ? Number(((chaptersRead / total) * 100).toFixed(1)) : 0;

  let actionType = "start";
  let actionLabel = "Read Chapter 1";
  let actionChapter = 1;

  if (isCompleted) {
    actionType = "completed";
    actionLabel = "Completed · Read Again";
    actionChapter = 1;
  } else if (chaptersRead > 0) {
    actionType = "continue";
    actionLabel = `Continue Reading · Ch. ${nextChapter}`;
    actionChapter = nextChapter;
  }

  return {
    lastChapter: Number(meta.lastChapter) || 0,
    lastReadAt: meta.lastReadAt || null,
    scrollPercent: Number(meta.scrollPercent) || 0,
    scrollY: Number(meta.scrollY) || 0,
    nextChapter,
    chaptersRead,
    totalChapters: total,
    progressPercent,
    isCompleted,
    actionType,
    actionLabel,
    actionChapter,
    readChapters: Array.from(readSet).sort((a, b) => a - b),
  };
}

/**
 * Apply a progress update to a novel's metadata and return the new state.
 */
export function applyProgressUpdate(meta, toc, update = {}) {
  const chapter = Number(update.chapter) || meta.lastChapter || 1;
  const scrollPercent = update.scrollPercent !== undefined ? Number(update.scrollPercent) : (meta.scrollPercent || 0);
  const scrollY = update.scrollY !== undefined ? Number(update.scrollY) : (meta.scrollY || 0);
  const markRead = Boolean(update.markRead) || scrollPercent >= 80;

  const readSet = new Set(Array.isArray(meta.readChapters) ? meta.readChapters : []);

  if (markRead && chapter >= 1) {
    readSet.add(chapter);
  }

  meta.lastChapter = chapter;
  meta.scrollPercent = scrollPercent;
  meta.scrollY = scrollY;
  meta.lastReadAt = Date.now();
  meta.readChapters = Array.from(readSet).sort((a, b) => a - b);

  const progress = computeProgress(meta, toc);
  meta.progressPercent = progress.progressPercent;
  meta.isCompleted = progress.isCompleted;

  return { meta, progress };
}
