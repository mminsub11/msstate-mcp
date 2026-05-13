/**
 * Emergency-site HTML → structured rows.
 *
 * Three parsers exposed:
 *  - parseGuidelineHtml(html, slug)   → guideline body
 *  - parseRefugeHtml(html)            → refuge table  (stub here; filled in Task 3)
 *  - parseContactsHtml(html)          → contacts list (stub here; filled in Task 4)
 *
 * Each parser returns rows without retrieved_at / aliases / source_url. The
 * scraper attaches those.
 */
import { load as cheerioLoad } from "cheerio";
import type { GuidelineRow, RefugeRow, ContactRow } from "./types.js";

const EMERGENCY_HOST = "https://www.emergency.msstate.edu";

type CheerioAPI = ReturnType<typeof cheerioLoad>;

/** Walk a single element to a 1-N markdown line block. Headings -> "## H";
 *  <ul>/<ol> -> "- item" lines; <p> and other -> plain text line(s). */
function nodeToMarkdown($: CheerioAPI, el: any): string[] {
  const tag = (el.tagName ?? el.name ?? "").toLowerCase();
  const text = $(el).text().trim().replace(/\s+/g, " ");
  if (!text && tag !== "ul" && tag !== "ol") return [];
  if (/^h[1-6]$/.test(tag)) {
    const level = parseInt(tag.slice(1), 10);
    return [`${"#".repeat(level)} ${text}`];
  }
  if (tag === "p") return [text];
  if (tag === "ul" || tag === "ol") {
    const items: string[] = [];
    $(el).find("> li").each((_, li) => {
      const liText = $(li).text().trim().replace(/\s+/g, " ");
      if (liText) items.push(`- ${liText}`);
    });
    return items;
  }
  return text ? [text] : [];
}

export function parseGuidelineHtml(
  html: string,
  slug: string,
): Omit<GuidelineRow, "retrieved_at" | "aliases"> | null {
  const $ = cheerioLoad(html);
  const main = $("main").first();
  if (main.length === 0) return null;

  const title =
    main.find("h1.page-title").first().text().trim().replace(/\s+/g, " ") ||
    main.find("h1").first().text().trim().replace(/\s+/g, " ");
  if (!title) return null;

  const blocks: string[] = [];
  main.find("> *, > div > *").each((_, el) => {
    const t = (el as any).tagName?.toLowerCase?.();
    if (t === "h1") return; // title already captured
    const md = nodeToMarkdown($, el);
    for (const line of md) blocks.push(line);
  });
  const body_markdown = blocks.join("\n\n").trim();

  return {
    slug,
    title,
    url: `${EMERGENCY_HOST}/guidelines/${slug}`,
    body_markdown,
  };
}

/** Refuge table parser — Task 3 replaces this stub. */
export function parseRefugeHtml(_html: string): Omit<RefugeRow, "retrieved_at" | "source_url">[] {
  return [];
}

/** Contacts list parser — Task 4 replaces this stub. */
export function parseContactsHtml(_html: string): Omit<ContactRow, "retrieved_at" | "source_url">[] {
  return [];
}
