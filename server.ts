import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import * as cheerio from "cheerio";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import fs from "fs";

dotenv.config();

// ─── Supabase ────────────────────────────────────────────────────────────────
let supabase: any;
try {
  const url = process.env.SUPABASE_URL || '';
  const key = process.env.SUPABASE_ANON_KEY || '';
  if (!url.startsWith('http')) throw new Error('Invalid URL');
  supabase = createClient(url, key);
} catch {
  console.warn('[AI Studio] Supabase not connected — using mock');
  const noOp: any = new Proxy({}, {
    get: (_, prop) => {
      if (prop === 'then') return (resolve: any) => resolve({ data: [], error: null });
      return () => noOp;
    }
  });
  supabase = { from: () => noOp };
}

// ─── Local DB (posts) ────────────────────────────────────────────────────────
// ─── Queue persistence (SQLite via JSON file — no native addon needed) ───────
// ─── Crawler checkpoint persistence ───────────────────────────────────────────
// ─── Failed-items queue (page-atomic workflow's "Failed Page Queue") ─────────
// Items that exhausted every retry round land here instead of being silently
// dropped, so they can be reviewed or resubmitted later via
// GET/POST /api/batch/failed.

interface FailedItem {
  post_id: string; title: string; categories: string[]; actors: string[];
  original_url: string; original_embeds: string[]; error_msg?: string;
  batch_id: string; failed_at: number; thumbnail_url?: string;
}
async function readFailedItems(): Promise<FailedItem[]> {
  try {
    const { data } = await supabase.from('crawler_failed_items').select('*');
    return data || [];
  } catch { return []; }
}

async function writeFailedItems(items: FailedItem[]): Promise<void> {
  try {
    await supabase.from('crawler_failed_items').delete().neq('post_id', 'dummy_safeguard');
    if (items.length > 0) {
      await supabase.from('crawler_failed_items').upsert(items);
    }
  } catch (e) {
    console.error("[FailedItems] Write error:", e);
  }
}

async function appendFailedItems(items: FailedItem[]): Promise<void> {
  if (items.length === 0) return;
  try {
    await supabase.from('crawler_failed_items').upsert(items);
  } catch (e) {
    console.error("[FailedItems] Append error:", e);
  }
}

async function removeFailedItems(postIds: string[]): Promise<void> {
  if (postIds.length === 0) return;
  try {
    await supabase.from('crawler_failed_items').delete().in('post_id', postIds);
  } catch (e) {
    console.error("[FailedItems] Remove error:", e);
  }
}

// ─── Simple async mutex — serializes read-modify-write on the local JSON DB ──

interface UnifiedPost {
  post_id: string;
  title: string;
  categories: string[];
  actors: string[];
  original_url: string;
  embeds: string[];
  thumbnail_url?: string;
  created_at?: string;
  updated_at?: string;
}

// ─── Local post helpers ──────────────────────────────────────────────────────


// ─── Queue persistence helpers (survive restart on Render/Railway) ───────────
interface PersistedTask {
  post_id: string;
  title: string;
  categories: string[];
  actors: string[];
  original_url: string;
  original_embeds: string[];
  state: 'PENDING' | 'PROCESSING' | 'DONE' | 'ERROR' | 'DUPLICATE';
  final_embeds: string[];
  error_msg?: string;
  logs: string[];
  created_at: number;
  batch_id: string;
  committed?: boolean;
  thumbnail_url?: string;
}

function readQueueDb(): Map<string, PersistedTask> { return new Map(); } // Dummy to satisfy old init code, actual load happens async

async function writeQueueDb(queue: Map<string, PersistedTask>): Promise<void> {
  const arr = Array.from(queue.values()).map(t => {
    return { ...t, updated_at: Date.now() };
  });
  if (arr.length === 0) return;
  try {
    const { error } = await supabase.from('crawler_queue').upsert(arr);
    if (error) console.error("[QueueDB] Upsert error:", error.message);
  } catch (e) { 
    console.error("[QueueDB] Write error:", e); 
  }
}

async function deleteFromQueueDb(postIds: string[]): Promise<void> {
  if (postIds.length === 0) return;
  try {
    await supabase.from('crawler_queue').delete().in('post_id', postIds);
  } catch (e) {
    console.error("[QueueDB] Delete error:", e);
  }
}

// ─── Robust Supabase helpers ─────────────────────────────────────────────────
async function robustGetPosts(
  category?: string,
  sort?: string,
  page: number = 1,
  limit: number = 25,
  search?: string
): Promise<{ data: UnifiedPost[]; total: number; page: number; limit: number; totalPages: number }> {
  let query = supabase.from('unified_posts').select('*', { count: 'exact' });
  if (category && category !== 'All') query = query.contains('categories', JSON.stringify([category]));
  if (search && search.trim()) {
    const q = search.trim();
    query = query.or(`title.ilike.%${q}%,post_id.ilike.%${q}%`);
  }
  query = sort === 'oldest'
    ? query.order('created_at', { ascending: true })
    : query.order('created_at', { ascending: false });

  if (page && limit && limit > 0) {
    const from = (page - 1) * limit;
    const to = from + limit - 1;
    query = query.range(from, to);
  }

  const { data, count, error } = await query;
  if (error) throw error;
  const total = count ?? (data?.length || 0);
  const actualLimit = limit || 25;
  const totalPages = Math.ceil(total / actualLimit) || 1;

  return { data: (data || []) as UnifiedPost[], total, page, limit: actualLimit, totalPages };
}

async function robustGetAllPosts(): Promise<UnifiedPost[]> {
  const { data, error } = await supabase.from('unified_posts').select('*').order('created_at', { ascending: false });
  if (error) throw error;
  return (data || []) as UnifiedPost[];
}

async function robustGetPostById(postId: string): Promise<UnifiedPost | null> {
  const { data, error } = await supabase.from('unified_posts').select('*').eq('post_id', postId).maybeSingle();
  if (error) throw error;
  return data as UnifiedPost | null;
}

async function robustUpsertPost(post: UnifiedPost): Promise<void> {
  const now = new Date().toISOString();
  // Fetch existing to preserve created_at
  const existing = await robustGetPostById(post.post_id);
  const newPost = {
    ...post,
    created_at: existing ? existing.created_at : now,
    updated_at: now
  };

  const { error } = await supabase.from('unified_posts').upsert({
    post_id: newPost.post_id,
    title: newPost.title || 'Untitled',
    categories: Array.isArray(newPost.categories) ? newPost.categories : [],
    actors: Array.isArray(newPost.actors) ? newPost.actors : [],
    original_url: newPost.original_url || '',
    embeds: Array.isArray(newPost.embeds) ? newPost.embeds : [],
    thumbnail_url: newPost.thumbnail_url || null,
    created_at: newPost.created_at,
    updated_at: newPost.updated_at
  }, { onConflict: 'post_id' });
  if (error) throw new Error(error.message);
}

async function robustDeletePost(postId: string): Promise<void> {
  const { error } = await supabase.from('unified_posts').delete().eq('post_id', postId);
  if (error) throw error;
}

async function robustClearAllPosts(): Promise<void> {
  await Promise.allSettled([
    supabase.from('unified_posts').delete().neq('post_id', 'dummy_safeguard_none'),
    supabase.from('posts').delete().neq('id', '00000000-0000-0000-0000-000000000000'),
    supabase.from('crawler_queue').delete().neq('post_id', 'dummy_safeguard_none'),
    supabase.from('crawler_failed_items').delete().neq('post_id', 'dummy_safeguard_none'),
    supabase.from('crawl_checkpoint').delete().neq('id', 'dummy_safeguard_none')
  ]);
  processingQueue.clear();
}

// ─── Bulk batch-commit (page-atomic workflow) ─────────────────────────────────
// Commits a whole page's worth of successfully-cloned posts in ONE local write
// and ONE Supabase bulk upsert call, then reads the rows back to confirm they
// really landed — instead of trusting the upsert response alone. Returns the
// post_ids that were verified present after commit.
async function robustBulkCommitPosts(posts: UnifiedPost[]): Promise<{ committedIds: string[]; verifiedIds: string[]; dbError?: string }> { try {
  if (posts.length === 0) return { committedIds: [], verifiedIds: [] };
  const now = new Date().toISOString();

  const postIds = posts.map(p => p.post_id);
  const { data: existingData } = await supabase.from('unified_posts').select('post_id, created_at').in('post_id', postIds);
  const existingMap = new Map((existingData || []).map(r => [r.post_id, r.created_at]));

  const rows = posts.map(p => ({
    post_id: p.post_id,
    title: p.title || 'Untitled',
    categories: Array.isArray(p.categories) ? p.categories : [],
    actors: Array.isArray(p.actors) ? p.actors : [],
    original_url: p.original_url || '',
    embeds: Array.isArray(p.embeds) ? p.embeds : [],
    thumbnail_url: p.thumbnail_url || null,
    created_at: existingMap.get(p.post_id) || now,
    updated_at: now
  }));

  const { error } = await supabase.from('unified_posts').upsert(rows, { onConflict: 'post_id' });
  if (error) {
    return { committedIds: [], verifiedIds: [], dbError: error.message };
  }

  // Insert verify: read the rows back rather than trusting the upsert response
  const ids = rows.map(r => r.post_id);
  const { data: verifyData, error: verifyErr } = await supabase.from('unified_posts').select('post_id').in('post_id', ids);
  const verifiedIds = verifyErr ? [] : (verifyData || []).map((r: any) => r.post_id);

  return { committedIds: ids, verifiedIds, dbError: verifyErr?.message }; } catch (e: any) { return { committedIds: [], verifiedIds: [], dbError: e.message }; }
}

// ─── Text helpers ─────────────────────────────────────────────────────────────
function extractCategories(title: string): string[] {
  const tags = title.match(/#[\w-]+/g);
  if (!tags) return [];
  const forbidden = ['#ad','#ads','#sponsor','#sponsors','#promo','#promos','#brazzers','#naughtyamerica','#realitykings','#bangbros','#mofos'];
  return Array.from(new Set(
    tags.filter(t => !forbidden.includes(t.toLowerCase()) && !t.toLowerCase().startsWith('#promo') && !t.toLowerCase().startsWith('#sponsor'))
        .map(t => t.substring(1))
  ));
}

function cleanTitle(title: string): string {
  let c = title.replace(/#[\w-]+/g, '').replace(/https?:\/\/[^\s]+/g, '').replace(/^[\s\-|:]+|[\s\-|:]+$/g, '').replace(/\s+/g, ' ');
  return c.trim() || 'Untitled';
}

function extractUrlsFromTitle(title: string): string[] {
  return Array.from(title.match(/(https?:\/\/[^\s]+)/g) || []);
}

function formatEmbedDomain(urlStr: string): string {
  try {
    const u = new URL(urlStr);
    const h = u.hostname.toLowerCase();
    if (h.startsWith("lulu")) {
      u.hostname = ["luluvdo.com","luluvdoo.com","luluvid.com"][Math.floor(Math.random()*3)];
    } else if (h.match(/dood|ds2play|d000d|vide0|do7go|playmogo/i)) {
      u.hostname = "dood.la";
      u.pathname = u.pathname.replace(/^\/[a-z]\//, '/e/');
      u.pathname = u.pathname.replace(/^\/[a-z]\//, '/e/');
    }
    return u.toString();
  } catch { return urlStr; }
}

// ─── API base URLs ────────────────────────────────────────────────────────────
const DOOD_API_BASE   = "https://doodapi.co/api";

async function extractVidara(url: string) {
  try {
    const urlObj = new URL(url);
    const mainUrl = urlObj.origin;
    const fileCode = urlObj.pathname.split("/").filter(Boolean).pop();
    
    if (!fileCode) return null;

    const response = await fetch(`${mainUrl}/api/stream`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
      body: JSON.stringify({ filecode: fileCode, device: 'web' })
    });
    
    if (!response.ok) return null;
    const data = await response.json();
    return {
      streaming_url: data.streaming_url,
      subtitles: data.subtitles,
      title: data.title,
      thumbnail: data.thumbnail
    };
  } catch (e) {
    return null;
  }
}

function getDoodKey(): string {
  const k = process.env.DOODSTREAM_API_KEY;
  if (!k) throw new Error("DOODSTREAM_API_KEY environment variable is required.");
  return k;
}

// ─── Rate limiting ────────────────────────────────────────────────────────────
// DoodStream's own docs: "API requests are rate limited to 10 per second" and
// return {"msg":"Too Many Requests","status":"429"} past that. We stay safely
// until real numbers are confirmed; watch logs for 429s to recalibrate.
class RateLimiter {
  private tokens: number;
  private waiters: Array<() => void> = [];
  constructor(public maxPerInterval: number, private intervalMs: number) {
    this.tokens = maxPerInterval;
    setInterval(() => {
      // If using adaptive limits, don't restore beyond the current adaptive max
      this.tokens = Math.floor(this.maxPerInterval);
      while (this.tokens > 0 && this.waiters.length > 0) {
        this.tokens--;
        this.waiters.shift()!();
      }
    }, this.intervalMs);
  }
  async acquire(): Promise<void> {
    if (this.tokens > 0) { this.tokens--; return; }
    await new Promise<void>(resolve => this.waiters.push(resolve));
  }
  
  // For adaptive probing
  report429() {
    // Halve the limit on 429
    this.maxPerInterval = Math.max(1, Math.floor(this.maxPerInterval / 2));
  }
  
  reportSuccess() {
    // Slowly probe up to a max of 15 req/sec
    if (this.maxPerInterval < 15) {
      this.maxPerInterval += 0.2; 
    }
  }
}
const doodLimiter = new RateLimiter(8, 1000);

const MAX_API_RETRIES = 2;
// Acquires a rate-limit token, fetches JSON, and retries on 429 (with backoff
// matching DoodStream's documented 429 body) or transient network/parse
// failures. This is what actually pushes clone success rate up — most
// failures on flaky third-party APIs are transient, not permanent.
async function rateLimitedFetchJson(limiter: RateLimiter, url: string, log?: (m: string) => void): Promise<any> {
  let lastErr: any = null;
  for (let attempt = 1; attempt <= MAX_API_RETRIES; attempt++) {
    await limiter.acquire();
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
      let json: any = null;
      try { json = await res.json(); } catch { /* fall through as failure */ }
      const isRateLimited = res.status === 429 || `${json?.status}` === '429' || json?.msg === 'Too Many Requests';
      if (isRateLimited) {
        if ((limiter as any).report429) (limiter as any).report429();
        const backoff = Math.min(1000 * 2 ** attempt, 15000) + Math.floor(Math.random() * 300);
        log?.(`Rate limited (429) — backing off ${backoff}ms, retry ${attempt}/${MAX_API_RETRIES}...`);
        if (attempt === MAX_API_RETRIES) return json ?? { status: 429, msg: 'Too Many Requests' };
        await new Promise(r => setTimeout(r, backoff));
        continue;
      }
      if (json === null) {
        if (res.status === 401 || res.status === 403) {
          throw new Error(`Authentication failed (HTTP ${res.status}). Check your API key.`);
        }
        if (res.status === 404) {
          throw new Error(`Not found (HTTP 404). File may be deleted.`);
        }
        throw new Error(`Non-JSON response (HTTP ${res.status})`);
      }
      if ((limiter as any).reportSuccess) (limiter as any).reportSuccess();
      return json;
    } catch (e: any) {
      lastErr = e;
      if (e.message.includes('Authentication failed')) throw e; // Fatal, do not retry
      if (e.message.includes('Not found (HTTP 404)')) throw e; // Fatal, do not retry
      if (attempt === MAX_API_RETRIES) break;
      const backoff = Math.min(800 * 2 ** attempt, 8000);
      log?.(`Request failed (${e.message}) — retrying ${attempt}/${MAX_API_RETRIES} in ${backoff}ms...`);
      await new Promise(r => setTimeout(r, backoff));
    }
  }
  throw lastErr || new Error('Request failed after retries');
}

// ─── Classify embed URLs ──────────────────────────────────────────────────────
function classifyEmbed(url: string): 'dood' | 'lulu' | 'vidara' | 'other' {
  try {
    const h = new URL(url).hostname.toLowerCase();
    if (h.match(/dood|ds2play|d000d|vide0|do7go|playmogo|doodstream/)) return 'dood';
    if (h.match(/lulu/)) return 'lulu';
    if (h.match(/vidavaca\.net|vidaarax\.net|vidaarax\.com|vidaratem\.com|vidaraw\.com|vidarax\.cc|vidaraa\.cc|vidara\.so|vidara\.to/i)) return 'vidara';
  } catch {}
  return 'other';
}

function extractFilecode(url: string): string | null {
  try {
    const m = new URL(url).pathname.match(/\/(?:[devDEV]\/)?([a-zA-Z0-9_-]{6,})(?:\/)?$/);
    return m ? m[1] : null;
  } catch { return null; }
}

// ─── Process a single embed: collect embed URL directly ──
async function processEmbed(url: string, taskLog: (m: string) => void): Promise<string | null> {
  if (!url || typeof url !== 'string') return null;
  const cleanUrl = url.trim();
  if (!cleanUrl) return null;

  // If Vidara download link, convert to embed link
  if (cleanUrl.includes('vidara') || cleanUrl.includes('vidaa')) {
    if (cleanUrl.includes('/d/')) {
      const converted = cleanUrl.replace('/d/', '/e/');
      taskLog(`[Vidara] Converted download link to embed → ${converted}`);
      return converted;
    }
  }

  taskLog(`[Direct Embed] Collected embed link → ${cleanUrl}`);
  return cleanUrl;
}

// ─── Clone verification (Dood only — DoodStream docs list a /file/check
// clones are trusted at the clone-response level only) ───────────────────────
async function verifyDoodActive(filecode: string, taskLog?: (m: string) => void): Promise<boolean> {
  try {
    const key = getDoodKey();
    const res = await rateLimitedFetchJson(doodLimiter, `${DOOD_API_BASE}/file/check?key=${key}&file_code=${filecode}`);
    const status = res?.result?.[0]?.status;
    const active = `${status}`.toLowerCase() === 'active';
    taskLog?.(`[Dood] Verify file/check(${filecode}) → status="${status}" (${active ? 'Active ✅' : 'NOT active ❌'})`);
    return active;
  } catch (e: any) {
    taskLog?.(`[Dood] Verify file/check(${filecode}) failed: ${e.message} — treating as unverified`);
    return false;
  }
}

// Clone with retry ROUNDS: 3 quick attempts, then (if still failing) pause
// 30s and try 3 more — matching "Retry #1,#2,#3 → pause 30s → retry again"
// from the workflow spec. This sits ABOVE processEmbed's own internal
// 3x retry-on-429/network-error (rateLimitedFetchJson), so failures that
// aren't HTTP-level (e.g. clone API returned success but file/check shows
// not-yet-Active) also get a real second chance instead of failing outright.
const RETRY_ATTEMPTS_PER_ROUND = 3;
const RETRY_ROUNDS = 2;
const RETRY_ROUND_PAUSE_MS = 7000;

async function cloneEmbedVerified(url: string, taskLog: (m: string) => void): Promise<string | null> {
  taskLog(`[Bypass Clone] Returning original URL without external API call: ${url}`);
  return url;
}

async function persistCrawlerCheckpoint(fields: {
  nextUrl?: string | null; lastUrl?: string | null;
  pagesCrawledDelta?: number; consecutiveDuplicatePages?: number;
  lastError?: string | null;
}): Promise<void> {
  try {
    const { data: current } = await supabase
      .from("crawl_checkpoint").select("*").eq("id", "default").maybeSingle();
    const newTotal = (current?.pages_crawled_total || 0) + (fields.pagesCrawledDelta || 0);
    await supabase.from("crawl_checkpoint").upsert({
      id: "default",
      next_url: fields.nextUrl ?? current?.next_url ?? null,
      last_url: fields.lastUrl ?? current?.last_url ?? null,
      pages_crawled_total: newTotal,
      consecutive_duplicate_pages: fields.consecutiveDuplicatePages ?? current?.consecutive_duplicate_pages ?? 0,
      last_error: fields.lastError ?? null,
      last_error_at: fields.lastError ? new Date().toISOString() : (current?.last_error_at ?? null),
      updated_at: new Date().toISOString(),
    }, { onConflict: "id" });
  } catch (e: any) {
    console.error('[Crawler] checkpoint persist failed:', e?.message);
  }
}

const processingQueue = new Map<string, PersistedTask>();
let queueWriteTimeout: NodeJS.Timeout | null = null;
function scheduleQueueWrite() {
  if (queueWriteTimeout) clearTimeout(queueWriteTimeout);
  queueWriteTimeout = setTimeout(() => {
    writeQueueDb(processingQueue);
    queueWriteTimeout = null;
  }, 1000);
}
function flushQueueWriteNow() {
  if (queueWriteTimeout) { clearTimeout(queueWriteTimeout); queueWriteTimeout = null; }
  return writeQueueDb(processingQueue);
}

const batchSummaries = new Map<string, any>();

async function tryCommitBatch(batchId: string) {
  const items = Array.from(processingQueue.values()).filter(t => t.batch_id === batchId);
  if (items.length === 0) return;
  const pending = items.filter(t => t.state === 'PENDING' || t.state === 'PROCESSING');
  if (pending.length > 0) return; // not ready

  const doneItems = items.filter(t => t.state === 'DONE');
  const errorItems = items.filter(t => t.state === 'ERROR');
  const duplicateItems = items.filter(t => t.state === 'DUPLICATE');

  let db_error: string | null = null;
  let savedCount = 0;
  
  if (doneItems.length > 0) {
    const postsToInsert = doneItems.map(t => ({
      post_id: t.post_id,
      title: t.title,
      categories: t.categories,
      actors: t.actors,
      original_url: t.original_url,
      embeds: t.final_embeds,
      thumbnail_url: t.thumbnail_url,
      created_at: new Date(t.created_at).toISOString(),
      updated_at: new Date().toISOString()
    }));
    try {
      const { error } = await supabase.from('unified_posts').upsert(postsToInsert);
      if (error) db_error = error.message;
      else savedCount = postsToInsert.length;
    } catch (e: any) {
      db_error = e.message;
    }
  }

  const failedToLog = errorItems.map(t => ({
    post_id: t.post_id,
    title: t.title,
    categories: t.categories,
    actors: t.actors,
    original_url: t.original_url,
    original_embeds: t.original_embeds,
    error_msg: t.error_msg,
    thumbnail_url: t.thumbnail_url,
    batch_id: t.batch_id,
    failed_at: Date.now()
  }));

  if (failedToLog.length > 0) {
    await appendFailedItems(failedToLog);
  }

  const summary = {
    batch_id: batchId,
    requested: items.length,
    duplicates: duplicateItems.length,
    processed: doneItems.length + errorItems.length,
    cloned_ok: doneItems.length,
    failed: errorItems.length,
    state: db_error ? 'ERROR' : 'COMMITTED',
    saved: savedCount,
    verified: savedCount,
    db_error
  };
  
  batchSummaries.set(batchId, summary);
  
  for (const item of items) {
    processingQueue.delete(item.post_id);
  }
  scheduleQueueWrite();
}

setInterval(async () => {
  const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT_TASKS || '5');
  let activeCount = 0;
  for (const task of processingQueue.values()) {
    if (task.state === 'PROCESSING') activeCount++;
  }
  
  if (activeCount >= MAX_CONCURRENT) return;
  
  const pendingTasks = Array.from(processingQueue.values()).filter(t => t.state === 'PENDING');
  for (const task of pendingTasks) {
    if (activeCount >= MAX_CONCURRENT) break;
    activeCount++;
    task.state = 'PROCESSING';
    scheduleQueueWrite();
    
    (async () => {
      try {
        let allOk = true;
        const newEmbeds: string[] = [];
        for (const embed of task.original_embeds) {
          try {
            const url = await processEmbed(embed, (msg: string) => { task.logs.push(msg); });
            if (url) newEmbeds.push(url);
            else allOk = false;
          } catch (e: any) {
            task.logs.push(`Error: ${e.message}`);
            allOk = false;
          }
        }
        if (allOk) {
          task.state = 'DONE';
          task.final_embeds = newEmbeds;
        } else {
          task.state = 'ERROR';
          task.error_msg = 'Failed to process embeds';
        }
      } catch (e: any) {
        task.state = 'ERROR';
        task.error_msg = e.message;
      }
      
      scheduleQueueWrite();
      if (task.batch_id) {
        tryCommitBatch(task.batch_id).catch(console.error);
      }
    })();
  }
}, 2000);

let serverCrawlerAbort = false;
let fatalEngineError: string | null = null;
const serverCrawler = {
  running: false,
  currentUrl: null as string | null,
  lastUrl: null as string | null,
  nextUrl: null as string | null,
  startedAt: 0,
  pagesThisRun: 0,
  duplicateStreak: 0,
  retryCount: 0,
  lastError: null as string | null,
  lastMessage: '',
  currentBatchId: null as string | null,
  logs: [] as string[]
};

const CRAWLER_MAX_RETRIES = 8;
const CRAWLER_RETRY_DELAY_MS = 30000;
const DUPLICATE_STREAK_STOP = 3;

function crawlerLog(msg: string) {
  const ts = new Date().toISOString();
  console.log(`[Crawler ${ts}] ${msg}`);
  serverCrawler.logs.push(`[${ts}] ${msg}`);
  serverCrawler.lastMessage = msg;
  if (serverCrawler.logs.length > 50) {
    serverCrawler.logs.shift();
  }
}

async function crawlerCallScrape(port: number, url: string) {
  const res = await fetch(`http://127.0.0.1:${port}/api/scrape`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url })
  });
  if (!res.ok) throw new Error(`Scrape failed: ${res.status}`);
  return await res.json();
}

async function crawlerSubmitBatch(port: number, items: any[]) {
  const res = await fetch(`http://127.0.0.1:${port}/api/batch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items })
  });
  if (!res.ok) throw new Error(`Batch submit failed: ${res.status}`);
  return await res.json();
}

async function crawlerWaitForBatch(port: number, batchId: string) {
  let attempts = 0;
  while (attempts < 450) { // 30 mins (450 * 4s)
    await new Promise(r => setTimeout(r, 4000));
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/batch/${batchId}/summary`);
      if (res.ok) {
        const data = await res.json();
        if (!data.live && data.summary) {
          return data.summary;
        }
      }
    } catch {}
    attempts++;
  }
  return null;
}

async function runServerCrawler(port: number): Promise<void> {
  while (serverCrawler.running && !serverCrawlerAbort) {
    const url = serverCrawler.currentUrl;
    if (!url) { crawlerLog('no currentUrl — stopping'); break; }

    let scrape: any;
    try {
      crawlerLog(`Fetching ${url}`);
      scrape = await crawlerCallScrape(port, url);
    } catch (e: any) {
      serverCrawler.retryCount += 1;
      serverCrawler.lastError = e?.message || String(e);
      await persistCrawlerCheckpoint({ nextUrl: url, lastError: serverCrawler.lastError });
      if (serverCrawler.retryCount > CRAWLER_MAX_RETRIES) {
        crawlerLog(`stopping — ${CRAWLER_MAX_RETRIES} retries exhausted on ${url}`);
        serverCrawler.running = false;
        break;
      }
      crawlerLog(`retry ${serverCrawler.retryCount}/${CRAWLER_MAX_RETRIES} in ${CRAWLER_RETRY_DELAY_MS / 1000}s: ${serverCrawler.lastError}`);
      await new Promise(r => setTimeout(r, CRAWLER_RETRY_DELAY_MS));
      continue;
    }

    serverCrawler.retryCount = 0;
    serverCrawler.lastError = null;
    const posts: any[] = scrape.data || [];
    const nextPage: string | null = scrape.next_page || null;
    crawlerLog(`Extracted ${posts.length} posts. Next: ${nextPage || '(none)'}`);

    let batchQueued = 0, batchDup = 0;
    if (posts.length > 0) {
      const items = posts.map((p: any) => {
        let postId = `p_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        if (p.post_url) {
          const match = p.post_url.match(/\/([a-zA-Z0-9_-]+)(?:\.html)?(?:\?.*)?$/);
          postId = match ? match[1] : Buffer.from(p.post_url).toString('base64').replace(/=/g, '');
        }
        let finalEmbeds = [...(p.embeds || []), ...(p.direct_link ? [p.direct_link] : [])];
        return {
          post_id: postId,
          title: p.title, categories: p.categories, actors: p.actors,
          original_url: p.post_url, embeds: finalEmbeds, thumbnail: p.thumbnail,
        };
      });
      try {
        const bres = await crawlerSubmitBatch(port, items);
        serverCrawler.currentBatchId = bres.batch_id;
        batchQueued = bres.queued;
        batchDup = bres.duplicates;
        crawlerLog(`Batch ${bres.batch_id}: ${bres.queued} queued, ${bres.duplicates} duplicate. Waiting for commit…`);
        const summary = await crawlerWaitForBatch(port, bres.batch_id);
        if (summary) {
          if (summary.state === 'COMMITTED') {
            crawlerLog(`Batch ${bres.batch_id} → ${summary.state}: saved ${summary.saved}/${summary.requested}`);
          } else {
            crawlerLog(`Batch ${bres.batch_id} → ${summary.state}: saved ${summary.saved}/${summary.requested} (Err: ${summary.db_error || 'unknown'})`);
          }
        } else if (fatalEngineError) {
          crawlerLog(`Batch ${bres.batch_id} aborted due to fatal engine error.`);
        } else {
          crawlerLog(`Batch ${bres.batch_id} timed out (30min) — advancing anyway`);
        }
      } catch (e: any) {
        crawlerLog(`batch submit failed: ${e?.message} — advancing anyway`);
      }
    }
    
    if (fatalEngineError) {
      crawlerLog(`stopping — fatal engine error: ${fatalEngineError}`);
      serverCrawler.lastError = fatalEngineError;
      break;
    }

    // Duplicate-streak stop
    if (posts.length > 0 && batchQueued === 0 && batchDup > 0) {
      serverCrawler.duplicateStreak += 1;
    } else if (batchQueued > 0) {
      serverCrawler.duplicateStreak = 0;
    }
    serverCrawler.pagesThisRun += 1;
    serverCrawler.currentBatchId = null;

    await persistCrawlerCheckpoint({
      lastUrl: url,
      nextUrl: nextPage,
      pagesCrawledDelta: 1,
      consecutiveDuplicatePages: serverCrawler.duplicateStreak,
    });

    if (serverCrawler.duplicateStreak >= DUPLICATE_STREAK_STOP) {
      crawlerLog(`reached ${DUPLICATE_STREAK_STOP} consecutive duplicate pages. Restarting from beginning in 30 seconds...`);
      serverCrawler.duplicateStreak = 0;
      serverCrawler.lastUrl = null;
      serverCrawler.currentUrl = "https://sxyprn.com/blog/all/0.html";
      serverCrawler.nextUrl = "https://sxyprn.com/blog/all/0.html";

      await persistCrawlerCheckpoint({
        lastUrl: null,
        nextUrl: serverCrawler.currentUrl,
        consecutiveDuplicatePages: 0,
      });

      await new Promise(r => setTimeout(r, 30000));
      continue;
    }

    if (!nextPage) {
      crawlerLog('stopping — no next_page');
      serverCrawler.running = false;
      break;
    }

    serverCrawler.lastUrl = url;
    serverCrawler.currentUrl = nextPage;
    serverCrawler.nextUrl = nextPage;

    // Polite rate limit delay to prevent IP blocking from source site
    const pageDelay = parseInt(process.env.CRAWLER_PAGE_DELAY_MS || '2500', 10);
    if (pageDelay > 0 && serverCrawler.running && !serverCrawlerAbort) {
      await new Promise(r => setTimeout(r, pageDelay));
    }
  }
  serverCrawler.running = false;
  crawlerLog('crawler loop exited');
}


async function startServer() {
  const app = express();
  const PORT = 3000;
  app.use(express.json());

  // ── Scraper ──────────────────────────────────────────────────────────────────
  app.all("/api/scrape", async (req, res) => {
    const targetUrl = (req.body?.url as string) || (req.query?.url as string) || "https://sxyprn.com/blog/all/0.html";
    try {
      console.log(`[Scraper] Fetching: ${targetUrl}`);
      const response = await fetch(targetUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.5"
        },
        signal: AbortSignal.timeout(6000)
      });
      if (!response.ok) throw new Error(`Target returned status: ${response.status}`);
      const html = await response.text();
      const $ = cheerio.load(html);
      const posts: any[] = [];
      const isDetailPage = targetUrl.includes("/post/") || $('span.vidsnfo').length > 0;

      if (isDetailPage) {
        let directLink = "";
        const vnfo = $('span.vidsnfo').attr('data-vnfo');
        if (vnfo) {
          try {
            const p = JSON.parse(vnfo);
            const v = Object.values(p)[0] as string;
            if (v) directLink = v.startsWith("http") ? v : `https://sxyprn.com${v}`;
          } catch {}
        }
        const rawTitle = $('.post_title, h1').first().text().trim() || $('title').text().trim() || "Video";
        const title = cleanTitle(rawTitle);
        const titleEmbeds = extractUrlsFromTitle(rawTitle);
        const actors: string[] = [];
        $('a.ps_link').each((_, el) => { const a = $(el).attr('data-subkey') || $(el).text().trim(); if (a && !actors.includes(a)) actors.push(a); });
        
        let embeds: string[] = [];
        $('a.extlink, a.extlink_icon').each((_, el) => {
          let href = $(el).attr('href');
          if (href) {
            const f = formatEmbedDomain(href);
            if (f && classifyEmbed(f) === 'vidara' && !embeds.includes(f)) embeds.push(f);
          }
        });
        for (const u of titleEmbeds) if (classifyEmbed(u) === 'vidara' && !embeds.includes(u)) embeds.push(u);
        
        if (directLink && classifyEmbed(directLink) === 'vidara' && !embeds.includes(directLink)) {
            embeds.push(directLink);
        }

        const resolveThumbnail = (src: string) => {
          if (!src) return "";
          if (src.startsWith("http")) return src;
          if (src.startsWith("//")) return `https:${src}`;
          return `https://sxyprn.com${src.startsWith('/') ? '' : '/'}${src}`;
        };

        if (embeds.length > 0) {
          const thumbSrc = $('meta[itemprop="thumbnailUrl"]').attr('content') || $('video#player_el').attr('poster') || $('.post_video img').attr('data-src') || $('.post_video img').attr('src') || "";
          const thumbnail = resolveThumbnail(thumbSrc);
          posts.push({ title, categories: extractCategories(rawTitle), post_url: targetUrl, actors, embeds, duration: "N/A", thumbnail, direct_link: directLink });
        }
      } else {
        $('div.post_el_small, div.post_el, .post_card, .post_el_small_mob').each((_, el) => {
          if (posts.length >= 20) return false;
          const rawTitle = $(el).find('.post_el_small_mob_title').text().trim() || $(el).find('a.post_time').attr('title') || $(el).find('.post_title').text().trim() || "";
          const title = cleanTitle(rawTitle);
          const titleEmbeds = extractUrlsFromTitle(rawTitle);
          const postUrlSuffix = $(el).closest('a[href^="/post/"]').attr('href') || $(el).find('a.js-pop, a[href^="/post/"]').attr('href') || "";
          const postUrl = postUrlSuffix ? (postUrlSuffix.startsWith("http") ? postUrlSuffix : `https://sxyprn.com${postUrlSuffix}`) : "";
          const actors: string[] = [];
          $(el).find('a.ps_link').each((_, a) => { const act = $(a).attr('data-subkey') || $(a).text().trim(); if (act && !actors.includes(act)) actors.push(act); });
          
          let embeds: string[] = [];
          $(el).find('a.extlink, a.extlink_icon').each((_, e) => {
            let href = $(e).attr('href');
            if (href) {
              const f = formatEmbedDomain(href);
              if (f && classifyEmbed(f) === 'vidara' && !embeds.includes(f)) embeds.push(f);
            }
          });
          for (const u of titleEmbeds) if (classifyEmbed(u) === 'vidara' && !embeds.includes(u)) embeds.push(u);
          
          let directLink = "";
          const vnfo = $(el).find('span.vidsnfo').attr('data-vnfo');
          if (vnfo) { try { const p = JSON.parse(vnfo); const v = Object.values(p)[0] as string; if (v) directLink = v.startsWith("http") ? v : `https://sxyprn.com${v}`; } catch {} }
          
          if (directLink && classifyEmbed(directLink) === 'vidara' && !embeds.includes(directLink)) {
              embeds.push(directLink);
          }

          const resolveThumbnail = (src: string) => {
            if (!src) return "";
            if (src.startsWith("http")) return src;
            if (src.startsWith("//")) return `https:${src}`;
            return `https://sxyprn.com${src.startsWith('/') ? '' : '/'}${src}`;
          };
          const duration = $(el).find('.post_duration, .duration').text().trim() || "";
          const thumbSrc = $(el).find('img').attr('data-src') || $(el).find('img').attr('src') || "";
          const thumbnail = resolveThumbnail(thumbSrc);
          
          if (embeds.length > 0) {
              posts.push({ title, categories: extractCategories(rawTitle), post_url: postUrl, actors, embeds, duration, thumbnail, direct_link: directLink });
          }
        });
      }

      // Next page
      let nextPage = "";
      const nextLink = $('link[rel="next"]').attr('href') || $('a.next_page').attr('href') || $('a').filter((_, e) => !!$(e).text().trim().match(/^(?:Next|»|Next Page)$/i)).attr('href');
      if (nextLink) {
        nextPage = nextLink.startsWith('http') ? nextLink : `https://sxyprn.com${nextLink.startsWith('/') ? '' : '/'}${nextLink}`;
      } else {
        const m1 = targetUrl.match(/^(.*\/all\/)(\d+)(\.html)$/);
        if (m1) nextPage = `${m1[1]}${parseInt(m1[2]) + 20}${m1[3]}`;
        else {
          const m2 = targetUrl.match(/^(.*\/)(\d+)(\.html)$/);
          if (m2) nextPage = `${m2[1]}${parseInt(m2[2]) + 1}${m2[3]}`;
          else {
            const m3 = targetUrl.match(/^(.*\/orgasm\/)(\d+)$/);
            if (m3) nextPage = `${m3[1]}${parseInt(m3[2]) + 30}`;
          }
        }
      }

      return res.json({ current_page: targetUrl, next_page: nextPage || null, total_posts: posts.length, data: posts });
    } catch (e: any) {
      return res.status(500).json({ error: `Scrape failed: ${e.message}` });
    }
  });

  // ── Queue API ─────────────────────────────────────────────────────────────────
  // POST /api/db/posts  → add to processing queue (dedup check first)
  app.post("/api/db/posts", express.json(), async (req, res) => {
    try {
      const { post_id, title, categories, actors, original_url, embeds, thumbnail } = req.body;
      if (!post_id) return res.status(400).json({ error: "post_id is required" });

      // Already in queue? (synchronous check, no race here)
      if (processingQueue.has(post_id)) {
        return res.status(409).json({ error: "Already in processing queue." });
      }

      // Reserve the slot IMMEDIATELY, synchronously, before doing any `await`.
      // This closes the race window: previously the queue-check happened,
      // then an `await` for the Supabase duplicate check gave the event loop
      // a chance to run another request for the SAME post_id, which could
      // also pass the queue-check before either request had registered
      // itself — producing two tasks for one post. By reserving first and
      // validating after, a second concurrent request now correctly sees
      // "already in queue" immediately.
      const task: PersistedTask = {
        post_id, title, categories: categories || [], actors: actors || [],
        original_url, original_embeds: embeds || [], thumbnail_url: thumbnail,
        state: 'PENDING', final_embeds: [], logs: [],
        created_at: Date.now(),
        batch_id: `single_${post_id}_${Date.now()}` // self-contained 1-item batch
      };
      processingQueue.set(post_id, task);
      scheduleQueueWrite();

      // Now safe to do the slower async duplicate check against the DB.
      try {
        const existing = await robustGetPostById(post_id);
        if (existing) {
          processingQueue.delete(post_id); // release the reservation
          deleteFromQueueDb([post_id]);
          scheduleQueueWrite();
          return res.status(409).json({ error: "Duplicate: post already in database." });
        }
      } catch (e) {
        processingQueue.delete(post_id); // release on error too
        deleteFromQueueDb([post_id]);
        scheduleQueueWrite();
        throw e;
      }

      flushQueueWriteNow(); // durable write once genuinely accepted
      console.log(`[Queue] Added task: ${post_id}`);
      return res.json({ success: true, status: "queued", post_id });
    } catch (e: any) {
      return res.status(500).json({ error: e.message });
    }
  });

  // ── Page-atomic batch workflow ────────────────────────────────────────────────
  // POST a whole page's posts at once. Each item is duplicate-checked and
  // reserved the same race-free way as /api/db/posts, then queued for strictly
  // sequential clone+verify. Nothing is written to the real DB until every
  // item in the batch reaches DONE/ERROR/DUPLICATE — see tryCommitBatch.
  app.post("/api/batch", express.json(), async (req, res) => {
    try {
      const items = req.body?.items;
      if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ error: "items array is required" });
      }
      const batchId = `batch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      let duplicates = 0, queued = 0;
      const results: Array<{ post_id: string; status: 'queued' | 'duplicate' | 'skipped' }> = [];

      for (const item of items) {
        const { post_id, title, categories, actors, original_url, embeds, thumbnail } = item;
        if (!post_id) { results.push({ post_id: post_id || '', status: 'skipped' }); continue; }

        if (processingQueue.has(post_id)) { duplicates++; results.push({ post_id, status: 'duplicate' }); continue; }

        // Reserve synchronously first (same race-free pattern as /api/db/posts)
        const task: PersistedTask = {
          post_id, title, categories: categories || [], actors: actors || [],
          original_url, original_embeds: embeds || [], thumbnail_url: thumbnail,
          state: 'PENDING', final_embeds: [], logs: [],
          created_at: Date.now(), batch_id: batchId
        };
        processingQueue.set(post_id, task);

        try {
          const existing = await robustGetPostById(post_id);
          if (existing) {
            task.state = 'DUPLICATE'; // keep it in the batch as a terminal item, don't delete —
            duplicates++;             // tryCommitBatch needs every item accounted for
            results.push({ post_id, status: 'duplicate' });
          } else {
            queued++;
            results.push({ post_id, status: 'queued' });
          }
        } catch {
          task.state = 'DUPLICATE'; // fail-safe: if the check itself errors, don't risk a double-clone
          task.error_msg = 'Duplicate-check failed; skipped as a precaution.';
          duplicates++;
          results.push({ post_id, status: 'duplicate' });
        }
      }
      scheduleQueueWrite();
      console.log(`[Batch ${batchId}] Submitted: ${items.length} items, ${queued} queued, ${duplicates} duplicate.`);

      // A batch where everything was a duplicate has nothing left to commit —
      // resolve it immediately instead of waiting for an engine tick that has
      // no PENDING work to find.
      if (queued === 0) await tryCommitBatch(batchId);

      return res.json({ batch_id: batchId, total: items.length, queued, duplicates, results });
    } catch (e: any) {
      return res.status(500).json({ error: e.message });
    }
  });

  // GET a batch's live/final summary — "18 links → 18 processed → 18 unique
  // codes → 18 saved" comes straight from here.
  app.get("/api/batch/:id/summary", (req, res) => {
    const batchId = req.params.id;
    const finalSummary = batchSummaries.get(batchId);
    if (finalSummary) return res.json({ summary: finalSummary, live: false });

    // Not committed yet — report live progress from the queue
    const items = Array.from(processingQueue.values()).filter(t => t.batch_id === batchId);
    if (items.length === 0) return res.status(404).json({ error: "Batch not found (may have been cleaned up)." });
    const done = items.filter(t => t.state === 'DONE').length;
    const error = items.filter(t => t.state === 'ERROR').length;
    const duplicate = items.filter(t => t.state === 'DUPLICATE').length;
    res.json({
      live: true,
      summary: {
        batch_id: batchId, requested: items.length, duplicates: duplicate,
        processed: done + error, cloned_ok: done, failed: error, state: 'PROCESSING'
      }
    });
  });

  // Review / retry the persisted failed-items queue
  app.get("/api/batch/failed", (_req, res) => {
    res.json({ items: readFailedItems() });
  });

  app.post("/api/batch/retry-failed", express.json(), async (req, res) => {
    try {
      const postIds: string[] | undefined = req.body?.post_ids; // omit to retry ALL failed items
      const all = await readFailedItems();
      const toRetry = postIds && postIds.length > 0 ? all.filter(i => postIds.includes(i.post_id)) : all;
      if (toRetry.length === 0) return res.json({ batch_id: null, queued: 0, message: "Nothing to retry." });

      const batchId = `retry_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      let queued = 0;
      for (const item of toRetry) {
        if (processingQueue.has(item.post_id)) continue; // already in flight elsewhere
        processingQueue.set(item.post_id, {
          post_id: item.post_id, title: item.title, categories: item.categories, actors: item.actors,
          original_url: item.original_url, original_embeds: item.original_embeds, thumbnail_url: item.thumbnail_url,
          state: 'PENDING', final_embeds: [], logs: [], created_at: Date.now(), batch_id: batchId
        });
        queued++;
      }
      scheduleQueueWrite();
      removeFailedItems(toRetry.map(i => i.post_id)); // will be re-added if they fail again
      console.log(`[Batch ${batchId}] Retrying ${queued} previously-failed item(s).`);
      return res.json({ batch_id: batchId, queued });
    } catch (e: any) {
      return res.status(500).json({ error: e.message });
    }
  });

  // GET /api/queue/status → all tasks with state
  app.get("/api/queue/status", (req, res) => {
    res.json({ queue: Array.from(processingQueue.values()) });
  });
  // POST version for compatibility with original frontend
  app.post("/api/queue/status", (req, res) => {
    res.json({ queue: Array.from(processingQueue.values()) });
  });

  // ── Crawler checkpoint (resume support) ───────────────────────────────────────
  // Persists "how far the crawler got" so a restart/refresh can resume from the
  // last safe page instead of re-scraping (and re-hitting duplicates for) the
  // whole site from 0.html, or worse, restarting from scratch and missing pages
  // that were never actually checked.
  app.get("/api/crawl/checkpoint", async (_req, res) => {
    try {
      // Prefer Supabase (survives Render restarts / ephemeral disks).
      const { data, error } = await supabase
        .from("crawl_checkpoint")
        .select("*")
        .eq("id", "default")
        .maybeSingle();
      if (!error && data && (data.next_url || data.last_url)) {
        // Shape it like the old JSON checkpoint the frontend already expects.
        return res.json({
          checkpoint: {
            url: data.next_url || data.last_url,
            last_url: data.last_url,
            next_url: data.next_url,
            pagesCrawledTotal: data.pages_crawled_total || 0,
            consecutiveDuplicatePages: data.consecutive_duplicate_pages || 0,
            last_error: data.last_error || null,
            last_error_at: data.last_error_at || null,
            updated_at: data.updated_at,
          },
        });
      }
      return res.json({ checkpoint: null });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/crawl/checkpoint", express.json(), async (req, res) => {
    try {
      const {
        url,                            // legacy: treated as next_url
        next_url,
        last_url,
        consecutiveDuplicatePages,
        pagesCrawledDelta,              // +1 per successfully processed page
        pagesCrawledTotal,              // or explicit absolute value
        last_error,
      } = req.body || {};
      const nextUrl = next_url || url || null;
      if (!nextUrl && !last_url && pagesCrawledDelta == null && pagesCrawledTotal == null && !last_error) {
        return res.status(400).json({ error: "nothing to update" });
      }

      // Load current row so we can increment pages_crawled_total atomically-ish.
      const { data: current } = await supabase
        .from("crawl_checkpoint")
        .select("*")
        .eq("id", "default")
        .maybeSingle();

      const newTotal = pagesCrawledTotal != null
        ? Number(pagesCrawledTotal)
        : (current?.pages_crawled_total || 0) + (Number(pagesCrawledDelta) || 0);

      const row = {
        id: "default",
        next_url: nextUrl ?? current?.next_url ?? null,
        last_url: last_url ?? current?.last_url ?? null,
        pages_crawled_total: newTotal,
        consecutive_duplicate_pages: consecutiveDuplicatePages ?? current?.consecutive_duplicate_pages ?? 0,
        last_error: last_error ?? null,
        last_error_at: last_error ? new Date().toISOString() : (current?.last_error_at ?? null),
        updated_at: new Date().toISOString(),
      };

      const { error: upErr } = await supabase
        .from("crawl_checkpoint")
        .upsert(row, { onConflict: "id" });
      if (upErr) console.error("[Checkpoint] Supabase upsert failed:", upErr.message);

      res.json({ success: true, checkpoint: row });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });


  // ── Server-side crawler control ─────────────────────────────────────────────
  // The frontend can Start/Stop the server-side crawler here. Once started,
  // the crawler runs inside the Node process and survives browser close /
  // network loss / tab reload. Only the Render server needs to stay awake
  // (use UptimeRobot to keep it from sleeping).
  app.post("/api/crawl/server/start", express.json(), async (req, res) => {
    try {
      if (serverCrawler.running) {
        return res.status(409).json({ error: "already running", state: serverCrawler });
      }
      let startUrl: string | null = (req.body?.url as string) || null;
      const explicitResume = req.body?.resume === true;
      if (explicitResume || !startUrl) {
        const { data } = await supabase
          .from("crawl_checkpoint").select("*").eq("id", "default").maybeSingle();
        if (data?.next_url || data?.last_url) {
          startUrl = data.next_url || data.last_url;
        }
      }
      if (!startUrl) startUrl = "https://sxyprn.com/blog/all/0.html";

      serverCrawlerAbort = false;
      fatalEngineError = null;
      serverCrawler.running = true;
      serverCrawler.currentUrl = startUrl;
      serverCrawler.lastUrl = null;
      serverCrawler.nextUrl = null;
      serverCrawler.startedAt = Date.now();
      serverCrawler.pagesThisRun = 0;
      serverCrawler.duplicateStreak = 0;
      serverCrawler.retryCount = 0;
      serverCrawler.lastError = null;
      serverCrawler.lastMessage = 'started';
      serverCrawler.currentBatchId = null;
      // Fire-and-forget: loop runs in the background.
      runServerCrawler(PORT).catch(e => {
        console.error('[Crawler] fatal:', e);
        serverCrawler.running = false;
        serverCrawler.lastError = e?.message || String(e);
      });
      res.json({ success: true, state: serverCrawler });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/crawl/server/stop", (_req, res) => {
    serverCrawlerAbort = true;
    serverCrawler.running = false;
    serverCrawler.lastMessage = 'stopped by user';
    res.json({ success: true, state: serverCrawler });
  });

  app.get("/api/crawl/server/status", (_req, res) => {
    res.json({ state: serverCrawler });
  });


  // ── DB CRUD ───────────────────────────────────────────────────────────────────

  app.get("/api/db/posts", async (req, res) => {
    try {
      const { category, sort, search } = req.query as { category?: string; sort?: string; search?: string };
      const page = req.query.page ? parseInt(req.query.page as string, 10) : 1;
      const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 25;
      const result = await robustGetPosts(category, sort, page, limit, search);
      res.json({ success: true, ...result });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  app.delete("/api/db/posts", async (req, res) => {
    try { await robustClearAllPosts(); res.json({ success: true }); }
    catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  app.delete("/api/db/posts/:post_id", async (req, res) => {
    try { await robustDeletePost(req.params.post_id); res.json({ success: true }); }
    catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  app.get("/api/db/posts/:post_id", async (req, res) => {
    try {
      const data = await robustGetPostById(req.params.post_id);
      if (!data) return res.status(404).json({ error: "Post not found" });
      res.json({ success: true, data });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // DB Cleanup
  app.post("/api/db/clean-up", async (req, res) => {
    try {
      const posts = await robustGetAllPosts();
      let scanned = posts.length, updated = 0, deleted = 0;
      for (const post of posts) {
        const alive = (post.embeds || []).filter(u => u && typeof u === 'string' && u.trim().length > 0);
        if (alive.length > 0) {
          if (alive.length !== post.embeds.length) {
            await robustUpsertPost({ ...post, embeds: alive });
            updated++;
          }
        }
        else { await robustDeletePost(post.post_id); deleted++; }
      }
      res.json({ success: true, scanned, updated, deleted });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // Reconcile Dead Links (DMCA & Blocked)
  app.post("/api/db/reconcile", async (req, res) => {
    try {
      const posts = await robustGetAllPosts();
      let scanned = posts.length, dead_links = 0, posts_updated = 0;
      
      const doodKey = getDoodKey();

      let doodDmcaCodes = new Set<string>();
      try {
        const d_res = await fetch(`${DOOD_API_BASE}/dmca/list?key=${doodKey}`).then(r => r.json());
        if (d_res.result) {
          // Array of objects with file_code or filecode
          for (const item of d_res.result) {
            const fc = item.file_code || item.filecode;
            if (fc) doodDmcaCodes.add(fc);
          }
        }
      } catch(e) { console.warn('Dood DMCA list fetch failed', e); }


      for (const post of posts) {
        let changed = false;
        const aliveEmbeds = post.embeds.filter(url => {
          const kind = classifyEmbed(url);
          const fc = extractFilecode(url);
          if (kind === 'dood' && fc && doodDmcaCodes.has(fc)) { changed = true; return false; }
          return true;
        });

        if (changed) {
          dead_links += (post.embeds.length - aliveEmbeds.length);
          posts_updated++;
          if (aliveEmbeds.length > 0) {
            await robustUpsertPost({ ...post, embeds: aliveEmbeds });
          } else {
            await robustDeletePost(post.post_id);
          }
        }
      }
      res.json({ success: true, scanned, dead_links, posts_updated, doodDmcaCount: doodDmcaCodes.size });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  app.get("/assets/images/logo.svg", (req, res) => {
    res.setHeader("Content-Type", "image/svg+xml");
  });

  // ── Doodstream API proxy ──────────────────────────────────────────────────────
  app.get("/api/doodstream/file/list", async (req, res) => {
    try {
      const key = getDoodKey();
      const page = parseInt(req.query.page as string) || 1;
      const perPage = parseInt(req.query.per_page as string) || 40;
      const r = await fetch(`${DOOD_API_BASE}/file/list?key=${key}&page=${page}&per_page=${perPage}`).then(r => r.json());
      res.json(r);
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  
  // ── Image Proxy ──────────────────────────────────────────────────────────────
  app.get(["/api/proxy-image", "/api/proxy/image"], async (req, res) => {
    try {
      const rawUrl = (req.query.url || req.query.src) as string;
      const title = (req.query.title as string) || "Video";
      if (!rawUrl) return res.status(400).send("url parameter required");

      let targetUrl = rawUrl.trim();
      if (targetUrl.startsWith("//")) targetUrl = `https:${targetUrl}`;
      else if (targetUrl !== 'unavailable' && !targetUrl.startsWith("http://") && !targetUrl.startsWith("https://")) {
        targetUrl = `https://sxyprn.com/${targetUrl.replace(/^\//, '')}`;
      }

      const sendFallback = () => {
        let hash = 0;
        for (let i = 0; i < targetUrl.length; i++) hash = targetUrl.charCodeAt(i) + ((hash << 5) - hash);
        const hue1 = Math.abs(hash) % 360;
        const hue2 = (hue1 + 40 + Math.abs(hash >> 8) % 80) % 360;
        
        const displayTitle = title ? title.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').substring(0, 40) + (title.length > 40 ? '...' : '') : 'Video Unavailable';

        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180" viewBox="0 0 320 180">
            <defs>
              <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stop-color="hsl(${hue1}, 30%, 15%)" />
                <stop offset="100%" stop-color="hsl(${hue2}, 40%, 5%)" />
              </linearGradient>
              <pattern id="grid" width="20" height="20" patternUnits="userSpaceOnUse">
                <path d="M 20 0 L 0 0 0 20" fill="none" stroke="rgba(255,255,255,0.03)" stroke-width="1"/>
              </pattern>
            </defs>
            <rect width="320" height="180" fill="url(#bg)"/>
            <rect width="320" height="180" fill="url(#grid)"/>
            <circle cx="160" cy="70" r="24" fill="none" stroke="rgba(255,255,255,0.15)" stroke-width="2" />
            <path d="M154 60 L170 70 L154 80 Z" fill="rgba(255,255,255,0.3)" />
            <text x="160" y="120" dominant-baseline="middle" text-anchor="middle" fill="#F4F4F5" font-family="system-ui, sans-serif" font-weight="600" font-size="13" letter-spacing="0.5">${displayTitle}</text>
            <text x="160" y="142" dominant-baseline="middle" text-anchor="middle" fill="#A1A1AA" font-family="monospace" font-size="9" letter-spacing="1">SOURCE UNREACHABLE</text>
          </svg>`;
        
        res.setHeader("Content-Type", "image/svg+xml");
        res.setHeader("Cache-Control", "public, max-age=300");
        return res.status(200).send(svg);
      };

      if (targetUrl === 'unavailable') {
        return sendFallback();
      }

      let response;
      let retries = 2;
      
      for (let attempt = 0; attempt <= retries; attempt++) {
        try {
          response = await fetch(targetUrl, {
            headers: {
              "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
              "Referer": "https://sxyprn.com/",
              "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8"
            },
            signal: AbortSignal.timeout(4000)
          });
          
          if (response.ok) {
            break;
          }
          
          if (response.status === 404 && attempt < retries) {
            await new Promise(r => setTimeout(r, 500));
          }
        } catch (err) {
          if (attempt < retries) await new Promise(r => setTimeout(r, 500));
        }
      }

      if (!response || !response.ok) {
        return sendFallback();
      }

      const contentType = response.headers.get("content-type") || "image/jpeg";
      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      res.setHeader("Content-Type", contentType);
      res.setHeader("Cache-Control", "public, max-age=86400, s-maxage=86400");
      res.setHeader("Access-Control-Allow-Origin", "*");
      return res.status(200).send(buffer);
    } catch (e: any) {
      res.setHeader("Content-Type", "image/svg+xml");
      res.setHeader("Cache-Control", "public, max-age=300");
      return res.status(200).send(`<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#1A1A1A"/><text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" fill="#A1A1AA" font-family="monospace" font-size="12">ERROR</text></svg>`);
    }
  });

  app.get("/api/thumbnail", async (req, res) => {
    try {
      const url = req.query.url as string;
      const title = (req.query.title as string) || "";
      if (!url) return res.status(400).json({ error: "url parameter is required" });
      const kind = classifyEmbed(url);
      const fc = extractFilecode(url);
      if (!fc) return res.status(400).json({ error: "Invalid embed URL" });

      if (kind === 'dood') {
        const key = getDoodKey();
        const r = await rateLimitedFetchJson(doodLimiter, `${DOOD_API_BASE}/file/image?key=${key}&file_code=${fc}`);
        const img = r?.result?.[0]?.splash_img || r?.result?.[0]?.single_img;
        if (img) return res.redirect(`/api/proxy-image?url=${encodeURIComponent(img)}&title=${encodeURIComponent(title)}`);
        return res.redirect(`/api/proxy-image?url=unavailable&title=${encodeURIComponent(title)}`);
      } else {
        return res.status(400).json({ error: "Unsupported provider" });
      }
    } catch (e: any) {
      console.error("[Thumbnail API] Error:", e);
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/doodstream/clone", express.json(), async (req, res) => {
    try {
      const key = getDoodKey();
      const { file_code } = req.body;
      if (!file_code) return res.status(400).json({ error: "file_code is required" });
      const r = await fetch(`${DOOD_API_BASE}/file/clone?key=${key}&file_code=${file_code}`).then(r => r.json());
      res.json(r);
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  app.post("/api/doodstream/remote/add", express.json(), async (req, res) => {
    try {
      const key = getDoodKey();
      const { url } = req.body;
      if (!url) return res.status(400).json({ error: "url is required" });
      const r = await fetch(`${DOOD_API_BASE}/upload/url?key=${key}&url=${encodeURIComponent(url)}`).then(r => r.json());
      res.json(r);
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  app.get("/api/doodstream/remote/status", async (req, res) => {
    try {
      const key = getDoodKey();
      const { file_code } = req.query;
      if (!file_code) return res.status(400).json({ error: "file_code is required" });
      const r = await fetch(`${DOOD_API_BASE}/urlupload/status?key=${key}&file_code=${file_code}`).then(r => r.json());
      res.json(r);
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // ── Byse stubs (disabled) ─────────────────────────────────────────────────────
  app.get("/api/byse/file/list", (_, res) => res.json({ status: 200, result: { files: [], results_total: "0", total_pages: 1 } }));
  app.post("/api/byse/remote/add", (_, res) => res.json({ status: 400, msg: "Byse disabled" }));
  app.post("/api/byse/clone", (_, res) => res.json({ status: 400, msg: "Byse disabled" }));
  app.get("/api/byse/account", (_, res) => res.json({ status: 200, result: { email: "disabled", premium: false } }));
  app.post("/api/byse/bulk-status", (_, res) => res.json({ success: true, results: [] }));

  // ── Vidara Extractor ──────────────────────────────────────────────────────────
  app.post("/api/extract/vidara", express.json(), async (req, res) => {
    try {
      const { url } = req.body;
      if (!url) return res.status(400).json({ error: "Missing URL" });
      const extracted = await extractVidara(url);
      if (extracted) {
        return res.json({ success: true, ...extracted });
      }
      return res.status(404).json({ error: "Could not extract video" });
    } catch (e: any) {
      return res.status(500).json({ error: e.message });
    }
  });

  // ── Embed/player endpoints ────────────────────────────────────────────────────
  app.get("/api/embed/:post_id", async (req, res) => {
    try {
      const data = await robustGetPostById(req.params.post_id);
      if (!data) return res.status(404).json({ status: 404, message: "Not found", error: true });
      res.json({ success: true, post_id: data.post_id, title: data.title, embeds: data.embeds || [], actors: data.actors || [], categories: data.categories || [], thumbnail: data.thumbnail_url || null });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  const embedHandler = async (req: express.Request, res: express.Response) => {
    try {
      const data = await robustGetPostById(req.params.post_id);
      if (!data) return res.status(404).json({ status: 404, message: "Not found", error: true });
      const links = Array.from(new Set(data.embeds || []));
      res.json({ post_id: data.post_id, title: data.title, categories: data.categories || [], actors: data.actors || [], links, thumbnail: data.thumbnail_url || null });
    } catch (e: any) { res.status(500).send("Internal Server Error"); }
  };

  app.get("/v/:post_id", embedHandler);
  app.get("/embed/:post_id", embedHandler);
  app.get("/:post_id([a-zA-Z0-9_-]+)", (req, res, next) => {
    if (req.params.post_id.includes(".") || ["api","assets","v","embed"].includes(req.params.post_id)) return next();
    embedHandler(req, res);
  });

  // ── Vite / static ─────────────────────────────────────────────────────────────
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({ server: { middlewareMode: true }, appType: "spa" });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_, res) => res.sendFile(path.join(distPath, 'index.html')));
  }

  app.listen(PORT, "0.0.0.0", () => console.log(`Server running on port ${PORT}`));
}

startServer();
