import React, { useState, useEffect, useRef, useMemo } from "react";
import { 
  Play, 
  Pause, 
  RefreshCw, 
  Search, 
  Copy, 
  ExternalLink, 
  Terminal, 
  Grid, 
  FileText, 
  Check, 
  Download, 
  AlertCircle, 
  User, 
  Video, 
  Layers, 
  Settings2, 
  ArrowRight,
  Database,
  Info,
  HelpCircle,
  Code,
  UploadCloud,
  Trash2,
  Activity,
  Link as LinkIcon,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";

// Structure of Scraped Video Posts
interface ScrapedPost {
  id?: string;
  title: string;
  categories?: string[];
  post_url: string;
  actors: string[];
  embeds: string[];
  duration?: string;
  thumbnail?: string;
  direct_link?: string;
  dbStatus?: "pending" | "processing" | "success" | "error" | "duplicate" | "dropped";
}

function resolveMasterImageUrl(thumbOrId?: string, masterDomain?: string): string {
  if (!thumbOrId) return "";
  const trimmed = thumbOrId.trim();
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://") || trimmed.startsWith("/api/")) {
    return trimmed;
  }
  const base = (masterDomain || "https://goonimage.sb2127061.workers.dev").replace(/\/+$/, '');
  if (trimmed.startsWith("posts/") || trimmed.startsWith("proxy/")) {
    return `${base}/img/${trimmed}`;
  }
  return `${base}/img/${trimmed}`;
}

function isVidaraEmbed(embeds?: string[], directLink?: string, postUrl?: string, categories?: string[]): boolean {
  const text = [...(embeds || []), directLink || '', postUrl || '', ...(categories || [])].join(' ').toLowerCase();
  return Boolean(text.match(/vidara\.so|vidara|vidaarax|vidavaca|vidaratem|vidaraw|vidarax|vidaraa|pornvoid/i));
}

function getProxyImageUrl(url?: string, title?: string, postId?: string, masterDomain?: string): string {
  if (!url) return "";
  const resolved = resolveMasterImageUrl(url, masterDomain);
  if (resolved.startsWith("/api/")) return resolved;
  if (resolved.includes(".workers.dev/img/") || resolved.startsWith("https://goonimage")) return resolved;
  let res = `/api/proxy-image?url=${encodeURIComponent(resolved)}`;
  if (title) res += `&title=${encodeURIComponent(title)}`;
  if (postId) res += `&id=${encodeURIComponent(postId)}`;
  return res;
}

interface ConsoleLog {
  timestamp: string;
  type: "info" | "success" | "warn" | "error" | "api";
  text: string;
}

export default function App() {
  const [isAutoUploading, setIsAutoUploading] = useState(false);
  const handleUploadToDood = async (url: string, filename: string, title: string = '') => {
    try {
      const isDoodEmbed = url.match(/dood|ds2play|d[0oO]+d|vide0|do7go|playmogo|doodstream|doodapi/i);
      
      if (isDoodEmbed && !url.includes('.mp4')) {
        const match = url.match(/\/(?:d|e|v)?\/?([a-zA-Z0-9_-]+)\/?$/i);
        const fileCode = match ? match[1] : null;
        if (fileCode) {
          addLog("info", `Initiating Clone to Doodstream for filecode: ${fileCode}`);
          const res = await fetch("/api/doodstream/clone", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ file_code: fileCode })
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || "Failed to clone Doodstream");
          addLog("success", `Successfully cloned Doodstream file: ${fileCode}`);
          return;
        }
      }

      addLog("info", `Initiating Remote Upload to Doodstream for: ${title || filename}`);
      const res = await fetch("/api/doodstream/remote/add", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to upload to Doodstream");
      addLog("success", `Successfully queued remote upload to Doodstream: ${title || filename}`);
    } catch (e: any) {
      addLog("error", `Doodstream Upload/Clone Error: ${e.message}`);
    }
  };

  // State variables for Crawler
  const [targetUrl, setTargetUrl] = useState("https://sxyprn.com/blog/all/0.html");
  const [crawlDelay, setCrawlDelay] = useState(-1); // ms delay (-1 represents randomized human jitter)
  const [countdown, setCountdown] = useState<number | null>(null);
  const [countdownMax, setCountdownMax] = useState<number>(0);
  const [isCrawling, setIsCrawling] = useState(false);
  const [scrapedData, setScrapedData] = useState<ScrapedPost[]>([]);
  const [logs, setLogs] = useState<ConsoleLog[]>([]);
  const [activeTab, setActiveTab] = useState<"posts" | "json" | "uploads" | "database" | "remotefiles" | "queue" | "links" | "images">("posts");
  const [isLoading, setIsLoading] = useState(false);
  const [copiedText, setCopiedText] = useState<string | null>(null);
  const [cfDomain, setCfDomain] = useState("https://apiv2.pasamaraooo49.workers.dev/embed");
  const [actorFilter, setActorFilter] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [autoQueueToDb, setAutoQueueToDb] = useState(true); // Always on by default

  // ── Cloudflare Image Worker & R2 Engine States ──────────────────────────────
  const [imageWorkerUrl, setImageWorkerUrl] = useState("https://goonimage.pasamaraooo49.workers.dev");
  const [imageWorkerStatus, setImageWorkerStatus] = useState<any>(null);
  const [imageStats, setImageStats] = useState<{ total: number; with_thumbnail: number; on_cloudflare_cdn: number; external_source: number; missing_thumbnail: number; worker_url?: string } | null>(null);
  const [isImageSyncing, setIsImageSyncing] = useState(false);
  const [imageSyncLimit, setImageSyncLimit] = useState(50);
  const [imageSyncForceAll, setImageSyncForceAll] = useState(false);
  const [imageSyncLog, setImageSyncLog] = useState<string | null>(null);
  const [testImageUrl, setTestImageUrl] = useState("");
  const [testImageResult, setTestImageResult] = useState<any>(null);
  const [isTestingImage, setIsTestingImage] = useState(false);
  const [autoSyncImagesToR2, setAutoSyncImagesToR2] = useState(true);

  // ── Prune Orphaned R2 Images state ──────────────────────────────────────────
  const [isPruningR2, setIsPruningR2] = useState(false);
  const [pruneDryRun, setPruneDryRun] = useState(true);
  const [autoArchiveMissing, setAutoArchiveMissing] = useState(true);
  const [pruneResult, setPruneResult] = useState<any>(null);

  // ── Server-side crawler state (survives browser close) ─────────────────────
  const [serverCrawlerState, setServerCrawlerState] = useState<any>(null);
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const r = await fetch('/api/crawl/server/status');
        if (r.ok) {
          const j = await r.json();
          if (!cancelled) setServerCrawlerState(j.state);
        }
      } catch {}
    };
    poll();
    const id = setInterval(poll, 3000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);
  
  const autoQueueRef = useRef(autoQueueToDb);

  // ── Crawler checkpoint / consecutive-duplicate-page tracking ──────────────
  // Instead of stopping the moment a SINGLE duplicate post is seen (which can
  // wrongly cut the crawl short if a stray old post is sorted in among new
  // ones), we only stop after several consecutive PAGES come back with zero
  // newly-added posts. Re-scraping a few extra pages is cheap and safe
  // (the backend's duplicate check is idempotent); missing new videos is not.
  const DUPLICATE_STREAK_STOP_THRESHOLD = 3;
  const duplicateStreakRef = useRef(0);
  const [consecutiveDuplicatePages, setConsecutiveDuplicatePages] = useState(0);
  const [savedCheckpoint, setSavedCheckpoint] = useState<{ url: string; consecutiveDuplicatePages?: number; updated_at?: string } | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/crawl/checkpoint");
        if (res.ok) {
          const data = await res.json();
          if (data.checkpoint?.url) setSavedCheckpoint(data.checkpoint);
        }
      } catch {}
    })();
  }, []);

  const saveCheckpoint = async (
    nextUrl: string | null,
    streak: number,
    opts: { lastUrl?: string | null; pagesCrawledDelta?: number; lastError?: string | null } = {}
  ) => {
    try {
      await fetch("/api/crawl/checkpoint", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          next_url: nextUrl,
          last_url: opts.lastUrl ?? null,
          consecutiveDuplicatePages: streak,
          pagesCrawledDelta: opts.pagesCrawledDelta ?? 0,
          last_error: opts.lastError ?? null,
        })
      });
    } catch {}
  };


  useEffect(() => {
    autoQueueRef.current = autoQueueToDb;
  }, [autoQueueToDb]);
  const [stats, setStats] = useState({
    pagesCrawled: 0,
    totalEmbeds: 0,
    totalActors: 0,
    startTime: ""
  });

  // Derived totals (avoid stale closure bug on setStats)
  const derivedTotalEmbeds = useMemo(
    () => scrapedData.reduce((a, p) => a + (p.embeds?.length || 0), 0),
    [scrapedData]
  );
  const derivedTotalActors = useMemo(
    () => new Set(scrapedData.flatMap(p => p.actors || [])).size,
    [scrapedData]
  );


  const [remoteFiles, setRemoteFiles] = useState<{byse: any[], dood: any[]}>({byse: [], dood: []});
  const [remoteFilesPage, setRemoteFilesPage] = useState<{byse: number, dood: number}>({byse: 1, dood: 1});
  const [remoteFilesTotalPages, setRemoteFilesTotalPages] = useState<{byse: number, dood: number}>({byse: 1, dood: 1});
  const [isRemoteFilesLoading, setIsRemoteFilesLoading] = useState(false);
  const [remoteFilesError, setRemoteFilesError] = useState("");

  // ── Cloudflare Image Worker & R2 Handlers ─────────────────────────────────
  const fetchImageWorkerStatus = async (urlToTest?: string) => {
    try {
      const target = urlToTest || imageWorkerUrl;
      const res = await fetch(`/api/image-worker/status?worker_url=${encodeURIComponent(target)}`);
      if (res.ok) {
        const data = await res.json();
        setImageWorkerStatus(data);
        return data;
      }
    } catch (e: any) {
      setImageWorkerStatus({ connected: false, error: e.message });
    }
  };

  const fetchImageStats = async () => {
    try {
      const res = await fetch("/api/image-worker/stats");
      if (res.ok) {
        const data = await res.json();
        setImageStats(data);
        return data;
      }
    } catch {}
  };

  useEffect(() => {
    fetchImageWorkerStatus();
    fetchImageStats();
  }, []);

  const handleSaveImageWorkerUrl = async (newUrl: string) => {
    const trimmed = newUrl.trim();
    setImageWorkerUrl(trimmed);
    try {
      await fetch("/api/image-worker/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ worker_url: trimmed })
      });
      await fetchImageWorkerStatus(trimmed);
      addLog("success", `Cloudflare Image Worker URL updated: ${trimmed}`);
    } catch (e: any) {
      addLog("error", `Failed to save Worker URL: ${e.message}`);
    }
  };

  const handleSyncDbImagesToCdn = async (limit: number = imageSyncLimit, forceAll: boolean = imageSyncForceAll) => {
    setIsImageSyncing(true);
    setImageSyncLog("Starting Cloudflare R2 / Edge CDN thumbnail sync...");
    addLog("info", `Initiating Cloudflare R2 Sync (Limit: ${limit}, Force All: ${forceAll})...`);

    try {
      const res = await fetch("/api/image-worker/sync-db", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          limit,
          force_all: forceAll,
          worker_url: imageWorkerUrl
        })
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Sync failed");

      setImageSyncLog(data.message || `Successfully synced ${data.updated || 0} images!`);
      addLog("success", data.message || `Image sync completed: ${data.updated} updated.`);
      
      // Refresh DB posts and Image stats
      await fetchImageStats();
      fetchDbPosts();
    } catch (e: any) {
      setImageSyncLog(`Error: ${e.message}`);
      addLog("error", `Image Worker Sync error: ${e.message}`);
    } finally {
      setIsImageSyncing(false);
    }
  };

  const handlePruneOrphanedImages = async (dryRun: boolean = pruneDryRun) => {
    setIsPruningR2(true);
    setPruneResult(null);
    addLog("info", `Initiating R2 Orphaned Images Prune (${dryRun ? 'DRY RUN - Safe Simulation' : 'PERMANENT PURGE'})...`);

    try {
      const res = await fetch("/api/image-worker/prune-orphans", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dry_run: dryRun,
          auto_archive_missing: autoArchiveMissing,
          worker_url: imageWorkerUrl
        })
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Prune failed");

      setPruneResult(data);
      if (dryRun) {
        addLog("warn", `[DRY RUN] Found ${data.orphaned_count} orphans, ${data.verified_telegram_count} verified in Telegram (Ready to prune: ${data.safe_to_delete_count}, Preserved: ${data.unverified_preserved_count})`);
      } else {
        addLog("success", `Successfully purged ${data.deleted_count} orphaned & Telegram-verified images from R2!`);
        await fetchImageStats();
        fetchDbPosts();
      }
    } catch (e: any) {
      addLog("error", `Prune R2 Error: ${e.message}`);
    } finally {
      setIsPruningR2(false);
    }
  };

  const handleTestUploadImage = async () => {
    if (!testImageUrl) return;
    setIsTestingImage(true);
    setTestImageResult(null);
    try {
      const res = await fetch("/api/image-worker/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: testImageUrl,
          worker_url: imageWorkerUrl
        })
      });
      const data = await res.json();
      setTestImageResult(data);
      if (data.success) {
        addLog("success", `Test image uploaded/proxied: ${data.cdnUrl}`);
      } else {
        addLog("warn", `Test image warning: ${data.error || "Fallback to proxy"}`);
      }
    } catch (e: any) {
      setTestImageResult({ success: false, error: e.message });
      addLog("error", `Test image upload error: ${e.message}`);
    } finally {
      setIsTestingImage(false);
    }
  };

  const handleSinglePostCdnUpload = async (postId: string, currentThumb: string) => {
    if (!currentThumb) return;
    try {
      addLog("info", `Uploading thumbnail for post ${postId} to Cloudflare R2...`);
      const res = await fetch("/api/image-worker/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: currentThumb,
          post_id: postId,
          worker_url: imageWorkerUrl
        })
      });
      const data = await res.json();
      if (data.success && data.cdnUrl) {
        setDbPosts((prev: any[]) => prev.map((p: any) => p.post_id === postId ? { ...p, thumbnail_url: data.cdnUrl } : p));
        addLog("success", `Thumbnail synced to CDN for post ${postId}`);
        fetchImageStats();
      }
    } catch (e: any) {
      addLog("error", `Failed to upload thumbnail for post ${postId}: ${e.message}`);
    }
  };

  const fetchRemoteFiles = async (provider?: 'byse' | 'dood', targetPage?: number) => {
    setIsRemoteFilesLoading(true);
    setRemoteFilesError("");

    try {
      const bysePage = provider === 'byse' && targetPage ? targetPage : remoteFilesPage.byse;
      const doodPage = provider === 'dood' && targetPage ? targetPage : remoteFilesPage.dood;

      let newByseData: any = null;
      let newDoodData: any = null;

      if (!provider || provider === 'byse') {
        const byseRes = await fetch(`/api/byse/file/list?page=${bysePage}`);
        newByseData = await byseRes.json();
      }
      if (!provider || provider === 'dood') {
        try {
          const doodRes = await fetch(`/api/doodstream/file/list?page=${doodPage}`);
          newDoodData = await doodRes.json();
        } catch (e) {}
      }

      setRemoteFiles(prev => ({
         byse: newByseData ? (newByseData?.result?.files || newByseData?.result || []) : prev.byse,
         dood: newDoodData ? (newDoodData?.result?.files || []) : prev.dood,
      }));

      setRemoteFilesTotalPages(prev => {
        let byseT = prev.byse;
        if (newByseData?.result?.total_pages) byseT = newByseData.result.total_pages;
        else if (newByseData?.result?.results_total) byseT = Math.ceil(parseInt(newByseData.result.results_total) / 40);

        let doodT = prev.dood;
        if (newDoodData?.result?.total_pages) doodT = newDoodData.result.total_pages;
        else if (newDoodData?.result?.results_total) doodT = Math.ceil(parseInt(newDoodData.result.results_total) / 40);
        return { byse: byseT, dood: doodT };

      });

      setRemoteFilesPage(prev => ({
        byse: bysePage,
        dood: doodPage,
      }));

    } catch (e: any) {
      setRemoteFilesError(e.message);
    } finally {
      setIsRemoteFilesLoading(false);
    }
  };

  useEffect(() => {
    if (activeTab === "remotefiles") {
      fetchRemoteFiles();
    }
  }, [activeTab]);

  

  

  
  const [queueStatus, setQueueStatus] = useState<any[]>([]);
  useEffect(() => {
    if (activeTab === "queue") {
      const interval = setInterval(async () => {
        try {
          const res = await fetch("/api/queue/status");
          const data = await res.json();
          setQueueStatus(data.queue || []);
        } catch (e) {}
      }, 3000);
      return () => clearInterval(interval);
    }
  }, [activeTab]);

  // DB Tab State
  const [dbPosts, setDbPosts] = useState<any[]>([]);
  const [dbCategoryFilter, setDbCategoryFilter] = useState("All");
  const [dbSort, setDbSort] = useState("newest");
  const [dbSearchQuery, setDbSearchQuery] = useState("");
  const [isDbLoading, setIsDbLoading] = useState(false);
  const [dbError, setDbError] = useState("");
  const [dbPage, setDbPage] = useState(1);
  const [dbLimit, setDbLimit] = useState(25);
  const [dbTotalCount, setDbTotalCount] = useState(0);
  const [dbTotalPages, setDbTotalPages] = useState(1);

  const consoleEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll terminal on new logs
  useEffect(() => {
    consoleEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  // Fetch DB Posts
  const fetchDbPosts = async (targetPage = dbPage, limitOverride = dbLimit) => {
    setIsDbLoading(true);
    setDbError("");
    try {
      const url = new URL("/api/db/posts", window.location.origin);
      if (dbCategoryFilter !== "All") url.searchParams.append("category", dbCategoryFilter);
      url.searchParams.append("sort", dbSort);
      url.searchParams.append("page", targetPage.toString());
      url.searchParams.append("limit", limitOverride.toString());
      if (dbSearchQuery.trim()) url.searchParams.append("search", dbSearchQuery.trim());

      const res = await fetch(url.toString());
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Failed to fetch database records (Status: ${res.status}). Details: ${text}`);
      }
      const result = await res.json();
      if (result.error) throw new Error(result.error);
      setDbPosts(result.data || []);
      setDbTotalCount(result.total ?? (result.data ? result.data.length : 0));
      setDbTotalPages(result.totalPages ?? 1);
      setDbPage(result.page ?? targetPage);
    } catch (e: any) {
      setDbError(e.message);
    } finally {
      setIsDbLoading(false);
    }
  };

  useEffect(() => {
    if (activeTab === "database") {
      fetchDbPosts(1);
    }
  }, [activeTab, dbCategoryFilter, dbSort, dbLimit, dbSearchQuery]);

    const addLog = (type: "info" | "success" | "warn" | "error" | "api", text: string) => {
    setLogs(prev => [...prev, {
      timestamp: new Date().toLocaleTimeString(),
      type,
      text
    }]);
  };

  const deletePost = async (postId: string) => {
    if (!window.confirm("Are you sure you want to delete this post?")) return;
    setIsDbLoading(true);
    try {
      const res = await fetch(`/api/db/posts/${postId}`, { method: "DELETE" });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Failed to delete post: ${text}`);
      }
      addLog("success", "Post deleted successfully.");
      fetchDbPosts();
    } catch (e: any) {
      setDbError(e.message);
    } finally {
      setIsDbLoading(false);
    }
  };

  const cleanUpDb = async () => {
    if (!window.confirm("Run cleanup? This scans and double-verifies all posts, which may take time.")) return;
    setIsDbLoading(true);
    setDbError("");
    try {
      const res = await fetch("/api/db/clean-up", { method: "POST" });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Cleanup failed: ${text}`);
      }
      const result = await res.json();
      if (result.error) throw new Error(result.error);
      addLog("success", `Cleanup complete. Scanned: ${result.scanned}, Updated: ${result.updated}, Deleted: ${result.deleted}`);
      fetchDbPosts();
    } catch (e: any) {
      setDbError(e.message);
    } finally {
      setIsDbLoading(false);
    }
  };

  const reconcileDb = async () => {
    setIsDbLoading(true);
    setDbError("");
    try {
      const res = await fetch("/api/db/reconcile", { method: "POST" });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Reconciliation failed: ${text}`);
      }
      const result = await res.json();
      if (result.error) throw new Error(result.error);
      addLog("success", `Reconciliation complete. Dead links found: ${result.dead_links}, Posts updated/deleted: ${result.posts_updated}`);
      fetchDbPosts();
    } catch (e: any) {
      setDbError(e.message);
    } finally {
      setIsDbLoading(false);
    }
  };

  const clearDb = async () => {
    if (!window.confirm("Are you sure you want to delete all posts from the remote database? This cannot be undone.")) return;
    setIsDbLoading(true);
    setDbError("");
    try {
      const res = await fetch("/api/db/posts", { method: "DELETE" });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Failed to clear database (Status: ${res.status}). Details: ${text}`);
      }
      const result = await res.json();
      if (result.error) throw new Error(result.error);
      addLog("success", "Database cleared successfully.");
      setDbPosts([]);
    } catch (e: any) {
      setDbError(e.message);
    } finally {
      setIsDbLoading(false);
    }
  };

  const calculatePostId = (url: string) => {
    const match = url.match(/\/([a-zA-Z0-9_-]+)(?:\.html)?(?:\?.*)?$/);
    return match ? match[1] : btoa(url).replace(/=/g, '');
  };

  // Polls the backend queue until every post_id from this page has reached a
  // terminal state (DONE or ERROR). No timeout — the user explicitly wants
  // accuracy over speed, so we wait as long as it takes rather than racing
  // ahead to the next page while clones are still in flight. If a task has
  // already been cleaned up from the queue (30s after finishing) before we
  // polled it, we treat it as done (its dbStatus already reflects the
  // outcome we saw right before cleanup).
  const waitForPageCompletion = async (
    posts: Array<{ postId: string; postUrl: string }>
  ): Promise<{ done: number; error: number }> => {
    const pending = new Map(posts.map(p => [p.postId, p.postUrl]));
    let done = 0, error = 0;
    while (pending.size > 0) {
      await new Promise(r => setTimeout(r, 4000));
      try {
        const res = await fetch("/api/queue/status");
        if (!res.ok) continue;
        const data = await res.json();
        const queue: any[] = data.queue || [];
        for (const [postId, postUrl] of Array.from(pending.entries())) {
          const task = queue.find((t: any) => t.post_id === postId);
          if (!task) {
            // Already cleaned up — nothing more to learn, count as done.
            done++;
            pending.delete(postId);
            continue;
          }
          if (task.state === 'DONE') {
            done++;
            pending.delete(postId);
            setScrapedData(prev => prev.map((p: any) => p.post_url === postUrl ? { ...p, dbStatus: 'success' as const } : p));
          } else if (task.state === 'ERROR') {
            error++;
            pending.delete(postId);
            setScrapedData(prev => prev.map((p: any) => p.post_url === postUrl ? { ...p, dbStatus: 'error' as const } : p));
          }
          // PENDING / PROCESSING → keep waiting
        }
      } catch {
        // Network hiccup while polling — just try again next tick.
      }
    }
    return { done, error };
  };

  const scrapeSinglePage = async (urlToScrape: string) => {
    setIsLoading(true);
    addLog("info", `Initiating Scrape: ${urlToScrape}`);
    try {
      const res = await fetch("/api/scrape", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: urlToScrape })
      });
      if (!res.ok) {
        throw new Error(`Scraper returned status ${res.status}`);
      }
      const result = await res.json();
      if (result.error) throw new Error(result.error);
      
      const newPosts = result.data || result.posts || [];
      
      // Update local state
      setScrapedData(prev => [...prev, ...newPosts.map((p: any) => ({...p, dbStatus: 'pending' as const}))]);
      
      let queueCounts = { added: 0, duplicate: 0, error: 0 };
      const queuedPosts: Array<{ postId: string; postUrl: string }> = [];
      let batchId: string | null = null;

      if (newPosts.length > 0) {
        // Queue to DB if autoQueue is enabled
        if (autoQueueRef.current) {
          // The whole page is submitted as ONE batch (not N separate
          // requests) so the backend can hold every result in memory and
          // commit them to the database in a single bulk transaction once
          // the entire page is done — "সবগুলো Clone হয়েছে? → Bulk Insert".
          const postIdByUrl = new Map<string, string>();
          const items = newPosts.map((post: any) => {
            const postId = calculatePostId(post.post_url);
            postIdByUrl.set(post.post_url, postId);
            let finalEmbeds = [...(post.embeds || []), ...(post.direct_link ? [post.direct_link] : [])];
            return {
              post_id: postId, title: post.title, categories: post.categories,
              actors: post.actors, original_url: post.post_url, embeds: finalEmbeds,
              thumbnail: post.thumbnail
            };
          });

          try {
            const res = await fetch("/api/batch", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ items })
            });
            if (res.ok) {
              const batchRes = await res.json();
              batchId = batchRes.batch_id;
              const resultByPostId = new Map<string, string>((batchRes.results || []).map((r: any) => [r.post_id, r.status]));
              for (const post of newPosts) {
                const postId = postIdByUrl.get(post.post_url)!;
                const status = resultByPostId.get(postId);
                if (status === 'queued') {
                  queueCounts.added++;
                  queuedPosts.push({ postId, postUrl: post.post_url });
                  // 'processing', not 'success' yet — cloning + the bulk DB
                  // commit for the whole page still has to happen.
                  setScrapedData(prev => prev.map((p: any) => p.post_url === post.post_url ? { ...p, dbStatus: 'processing' as const } : p));
                } else if (status === 'duplicate') {
                  queueCounts.duplicate++;
                  setScrapedData(prev => prev.map((p: any) => p.post_url === post.post_url ? { ...p, dbStatus: 'duplicate' as const } : p));
                } else {
                  queueCounts.error++;
                  setScrapedData(prev => prev.map((p: any) => p.post_url === post.post_url ? { ...p, dbStatus: 'error' as const } : p));
                }
              }
            } else {
              queueCounts.error += newPosts.length;
              setScrapedData(prev => prev.map((p: any) => newPosts.find((np: any) => np.post_url === p.post_url) ? { ...p, dbStatus: 'error' as const } : p));
              addLog("error", `Batch submit failed (HTTP ${res.status}).`);
            }
          } catch (e) {
            queueCounts.error += newPosts.length;
            console.error("Failed to submit page batch:", e);
            setScrapedData(prev => prev.map((p: any) => newPosts.find((np: any) => np.post_url === p.post_url) ? { ...p, dbStatus: 'error' as const } : p));
          }
        } else {
           // Do not queue, stays as pending
           setScrapedData(prev => prev.map((p: any) => newPosts.find((np:any) => np.post_url === p.post_url) ? { ...p, dbStatus: 'dropped' as const } : p));
        }
      }

      // No rush — wait for EVERY post queued from this page to actually
      // finish cloning (DONE or ERROR) before moving on. This is what
      // "one page fully done, then the next page" means in practice: we
      // don't advance the crawl while clone jobs from this page are still
      // in flight on the backend, and the backend itself won't touch the
      // real database until this whole batch is ready to bulk-commit.
      let cloneResults = { done: 0, error: 0 };
      if (queuedPosts.length > 0) {
        addLog("info", `⏳ এই পেজের ${queuedPosts.length}টা পোস্ট ক্লোন হওয়া পর্যন্ত অপেক্ষা করছি...`);
        cloneResults = await waitForPageCompletion(queuedPosts);

        // Pull the authoritative, DB-verified bundle summary — this is the
        // "18 links → 18 processed → 18 unique codes → 18 saved" figure.
        if (batchId) {
          try {
            const sres = await fetch(`/api/batch/${batchId}/summary`);
            if (sres.ok) {
              const { summary } = await sres.json();
              addLog(summary.state === 'COMMITTED' ? "success" : "warn",
                `📦 Bundle "${batchId}": ${summary.requested} links → ${summary.processed} processed → ${summary.unique_codes ?? 0} unique codes → ${summary.saved ?? 0} saved (${summary.verified ?? 0} verified) → ${summary.failed} failed.`);
              if (summary.db_error) addLog("error", `DB commit issue: ${summary.db_error}`);
            }
          } catch { /* summary fetch is best-effort logging, not critical path */ }
        }

        const accuracyPct = queuedPosts.length > 0 ? ((cloneResults.done / queuedPosts.length) * 100).toFixed(1) : "0.0";
        addLog(cloneResults.error === 0 ? "success" : "warn",
          `✅ পেজ সম্পূর্ণ: ${cloneResults.done}/${queuedPosts.length} সফলভাবে ক্লোন হয়েছে (${accuracyPct}%), ${cloneResults.error}টা ব্যর্থ।`);
      }

      // Update statistics
      setStats(prev => ({
        ...prev,
        pagesCrawled: prev.pagesCrawled + 1,
      }));

      addLog("success", `Parsed ${newPosts.length} posts from page.`);
      
      if (newPosts.length > 0) {
        addLog("info", `Sample Title: "${newPosts[0].title.substring(0, 50)}..."`);
        if (newPosts[0].actors.length > 0) {
          addLog("info", `Extracted Actors: ${newPosts[0].actors.join(", ")}`);
        }
        const hasDirect = newPosts.some(p => p.direct_link);
        if (hasDirect) {
          addLog("success", `Successfully extracted direct raw .vid CDN stream links.`);
        }
      }

      setIsLoading(false);
      return { nextUrl: result.next_page, extractedCount: newPosts.length, queueCounts, cloneResults };

    } catch (error: any) {
      addLog("error", `Scrape Failed: ${error.message}`);
      setIsLoading(false);
      // Return an explicit error shape so the crawl loop can auto-retry the
      // same URL (404 / 5xx / network hiccup) instead of stopping.
      return { error: true as const, message: String(error?.message || error) };
    }
  };


  // Crawler loop controller with dynamic countdown ticker & human pacing
  useEffect(() => {
    let timer: NodeJS.Timeout | undefined;
    let countdownInterval: NodeJS.Timeout | undefined;
    let isMounted = true;

    if (!isCrawling) {
      setCountdown(null);
      return;
    }

    // Auto-retry state for transient failures (404s, network hiccups). The
    // upstream site periodically 404s a few pages in a row, then recovers on
    // its own — user's rule: "just start again from that page and it'll be
    // fine". So we hold the same URL, back off, and try again automatically.
    let retryCount = 0;
    const MAX_RETRIES = 8;              // ~8 attempts is plenty for a flaky window
    const RETRY_DELAY_MS = 30_000;      // wait 30s between retries

    const runCrawlLoop = async () => {
      if (!isMounted || !isCrawling) return;

      const scrapeResult = await scrapeSinglePage(targetUrl);

      if (!isMounted || !isCrawling) return;

      // ── Transient failure (404 / 5xx / network) → retry SAME url ──────────
      if (scrapeResult && "error" in scrapeResult) {
        retryCount += 1;
        // Persist the failing URL + error to the DB checkpoint so a full
        // restart still knows exactly where to resume from.
        saveCheckpoint(targetUrl, duplicateStreakRef.current, { lastError: scrapeResult.message });

        if (retryCount > MAX_RETRIES) {
          setIsCrawling(false);
          setCountdown(null);
          addLog("error", `থামানো হলো: ${MAX_RETRIES}বার চেষ্টার পরেও পেজটা লোড হলো না। Checkpoint সেভ করা আছে — Start চাপলে এই URL থেকেই আবার শুরু হবে।`);
          return;
        }

        addLog("warn", `Retry ${retryCount}/${MAX_RETRIES} in ${RETRY_DELAY_MS / 1000}s (same URL): ${targetUrl}`);
        setCountdown(RETRY_DELAY_MS / 1000);
        let remaining = RETRY_DELAY_MS / 1000;
        countdownInterval = setInterval(() => {
          remaining -= 1;
          setCountdown(remaining > 0 ? remaining : null);
          if (remaining <= 0 && countdownInterval) clearInterval(countdownInterval);
        }, 1000);
        timer = setTimeout(() => {
          if (!isMounted || !isCrawling) return;
          // Re-trigger loop on the SAME URL by nudging state — since the
          // effect deps include targetUrl, we bump a retry ref via setState
          // fallback: call runCrawlLoop directly.
          runCrawlLoop();
        }, RETRY_DELAY_MS);
        return;
      }

      if (scrapeResult && scrapeResult.nextUrl) {
        const { nextUrl, extractedCount, queueCounts } = scrapeResult;
        retryCount = 0; // successful page — clear retry budget

        // Track consecutive fully-duplicate pages (only meaningful when
        // auto-queueing is on and the page actually had extractable posts).
        if (autoQueueRef.current && extractedCount > 0 && queueCounts) {
          if (queueCounts.added === 0 && queueCounts.duplicate > 0) {
            duplicateStreakRef.current += 1;
          } else if (queueCounts.added > 0) {
            duplicateStreakRef.current = 0;
          }
          setConsecutiveDuplicatePages(duplicateStreakRef.current);
        }

        // Persist progress to the DB after every successful page: bumps
        // pages_crawled_total by 1 and records last_url / next_url.
        saveCheckpoint(nextUrl, duplicateStreakRef.current, {
          lastUrl: targetUrl,
          pagesCrawledDelta: 1,
        });

        if (autoQueueRef.current && duplicateStreakRef.current >= DUPLICATE_STREAK_STOP_THRESHOLD) {
          const DUPLICATE_REFRESH_DELAY_MS = 100 * 60 * 1000; // 100 minutes
          const waitMins = Math.round(DUPLICATE_REFRESH_DELAY_MS / 60000);
          addLog("warn", `পরপর ${DUPLICATE_STREAK_STOP_THRESHOLD}টি পেজেই সব ডুপ্লিকেট। ${waitMins} মিনিট রিফ্রেশ কুলডাউন পর আবার শুরু থেকে (0.html) রিস্টার্ট হবে...`);
          setTargetUrl("https://sxyprn.com/blog/all/0.html");
          duplicateStreakRef.current = 0;
          setConsecutiveDuplicatePages(0);
          
          saveCheckpoint("https://sxyprn.com/blog/all/0.html", 0, {
            lastUrl: null,
            pagesCrawledDelta: 0,
          });

          setCountdown(DUPLICATE_REFRESH_DELAY_MS / 1000);
          setCountdownMax(DUPLICATE_REFRESH_DELAY_MS / 1000);
          let remaining = DUPLICATE_REFRESH_DELAY_MS / 1000;
          countdownInterval = setInterval(() => {
            remaining -= 1;
            setCountdown(remaining > 0 ? remaining : null);
            if (remaining <= 0 && countdownInterval) clearInterval(countdownInterval);
          }, 1000);
          timer = setTimeout(() => {
            if (!isMounted || !isCrawling) return;
            addLog("info", `১০০ মিনিট কুলডাউন সমাপ্ত। শুরু থেকে স্ক্র্যাপিং শুরু হচ্ছে...`);
            runCrawlLoop();
          }, DUPLICATE_REFRESH_DELAY_MS);
          return;
        }

        // No human delay — jump to next page immediately after processing
        addLog("info", `Advancing to next page immediately: ${nextUrl}`);
        setCountdown(null);
        setTargetUrl(nextUrl);

      } else {
        setIsCrawling(false);
        setCountdown(null);
        addLog("warn", "Crawling paused or reached end of pagination (No 'next_page' URL found).");
      }
    };


    runCrawlLoop();

    return () => {
      isMounted = false;
      clearTimeout(timer);
      clearInterval(countdownInterval);
    };
  }, [isCrawling, targetUrl, crawlDelay]);

  // Handler to clear all data
  const handleClear = async () => {
    if (!window.confirm("Are you sure you want to clear the local scraper catalog AND delete all entries in the database? This cannot be undone.")) return;
    
    // Clear local state
    setScrapedData([]);
    setActorFilter(null);
    setSearchQuery("");
    setStats(prev => ({
      ...prev,
      pagesCrawled: 0,
      totalEmbeds: 0,
      totalActors: 0
    }));
    addLog("warn", "Scraper dashboard state cleared.");

    // Clear remote/file database
    setIsDbLoading(true);
    setDbError("");
    try {
      const res = await fetch("/api/db/posts", { method: "DELETE" });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Failed to clear database (Status: ${res.status}). Details: ${text}`);
      }
      const result = await res.json();
      if (result.error) throw new Error(result.error);
      addLog("success", "Remote and local database cleared successfully.");
      setDbPosts([]);
    } catch (e: any) {
      setDbError(e.message);
      addLog("error", `Failed to clear database: ${e.message}`);
    } finally {
      setIsDbLoading(false);
    }
  };

  // Copy helper
  const handleCopy = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    setCopiedText(label);
    addLog("success", `Copied to clipboard: ${label}`);
    setTimeout(() => setCopiedText(null), 2000);
  };

  // Download collected JSON helper
  const handleDownloadJSON = () => {
    const jsonString = `data:text/json;charset=utf-8,${encodeURIComponent(
      JSON.stringify(scrapedData, null, 2)
    )}`;
    const downloadAnchor = document.createElement("a");
    downloadAnchor.setAttribute("href", jsonString);
    downloadAnchor.setAttribute("download", "sxyprn_scraped_database.json");
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
    addLog("success", "Downloaded scraped catalog as local JSON file.");
  };

  // Filtering scraped posts based on search query or selected actor
  const filteredPosts = useMemo(() => {
    return scrapedData.filter(post => {
      const matchesActor = actorFilter ? post.actors.includes(actorFilter) : true;
      const matchesSearch = searchQuery 
        ? post.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
          post.actors.some(a => a.toLowerCase().includes(searchQuery.toLowerCase()))
        : true;
      return matchesActor && matchesSearch;
    });
  }, [scrapedData, actorFilter, searchQuery]);

  // Computing difference between scraped posts and db posts
  const diffData = useMemo(() => {
    const scrapedUrls = new Set(scrapedData.map(p => p.post_url));
    const dbUrls = new Set(dbPosts.map(p => p.original_url));

    const scrapedNotDb = scrapedData.filter(p => !dbUrls.has(p.post_url));
    const dbNotScraped = dbPosts.filter(p => !scrapedUrls.has(p.original_url));

    return { scrapedNotDb, dbNotScraped };
  }, [scrapedData, dbPosts]);



  const clientCode = `/**
 * Client-Side Crawl Engine Loop (React/Vanilla JS)
 * This script runs continuously: fetches a page, processes the data,
 * then jumps to the 'next_page' URL returned in the API payload.
 */

const API_CRAWLER_ENDPOINT = "https://your-worker.your-subdomain.workers.dev";
const START_URL = "https://sxyprn.com/blog/all/0.html";
const DELAY_BETWEEN_PAGES = 3000; // 3 seconds polite delay to prevent bans

async function runSequentialCrawler(startUrl) {
  let currentTargetUrl = startUrl;
  let hasMore = true;
  let pageCount = 0;

  console.log("🚀 Starting crawler loop...");

  while (hasMore) {
    pageCount++;
    console.log(\`[PAGE \${pageCount}] Fetching: \${currentTargetUrl}\`);

    try {
      // Fetch data from the Cloudflare Worker proxy to avoid CORS blocks
      const requestUrl = \`\${API_CRAWLER_ENDPOINT}?url=\${encodeURIComponent(currentTargetUrl)}\`;
      const response = await fetch(requestUrl);
      
      if (!response.ok) {
        throw new Error(\`Network response failed with status \${response.status}\`);
      }

      const result = await response.json();
      const extractedPosts = result.data || [];

      console.log(\`✅ Extracted \${extractedPosts.length} posts from page.\`);

      // ----------------------------------------------------
      // TODO: Implement your database insert / save handler
      // Example: saveToDatabase(extractedPosts);
      // ----------------------------------------------------
      extractedPosts.forEach(post => {
        console.log(\` - Title: \${post.title}\`);
        console.log(\` - Actors: \${post.actors.join(", ") || "None"}\`);
        console.log(\` - Embeds: \${post.embeds.join(" | ") || "None"}\`);
        if (post.direct_link) {
          console.log(\` - Direct Stream: \${post.direct_link}\`);
        }
      });

      // Jump parameter update
      if (result.next_page) {
        currentTargetUrl = result.next_page;
        console.log(\`⏳ Waiting \${DELAY_BETWEEN_PAGES}ms before requesting next page...\`);
        await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_PAGES));
      } else {
        hasMore = false;
        console.log("🏁 Crawl loop completed! No more pages left.");
      }

    } catch (error) {
      console.error(\`❌ Error occurred on page \${pageCount}: \`, error);
      hasMore = false; // Graceful exit on network errors
    }
  }
}`;

  const filteredDbPosts = dbPosts.filter(post => {
    if (!dbSearchQuery) return true;
    const query = dbSearchQuery.toLowerCase();
    const matchesTitle = post.title?.toLowerCase().includes(query);
    const matchesActor = post.actors?.some((actor: string) => actor.toLowerCase().includes(query));
    const matchesCategory = post.categories?.some((cat: string) => cat.toLowerCase().includes(query));
    return matchesTitle || matchesActor || matchesCategory;
  });

  return (
    <div className="min-h-screen bg-[#FDFCFB] text-[#1A1A1A] flex flex-col selection:bg-[#FDE68A] selection:text-[#92400E]">
      
      {/* Editorial Premium Header */}
      <header className="border-b-2 border-[#1A1A1A] mx-4 md:mx-8 mt-6 md:mt-8 pb-4 flex flex-col md:flex-row md:items-baseline justify-between gap-4" id="app_header">
        <div className="flex flex-col">
          <h1 className="text-3xl md:text-5xl font-black font-serif tracking-tighter leading-none text-[#1A1A1A] flex flex-wrap items-baseline gap-2">
            EDGE CRAWLER 
            <span className="text-xs font-sans font-normal tracking-[0.25em] align-top bg-[#1A1A1A] text-white px-2 py-0.5 uppercase rounded-none inline-block">
              v2.0 Beta
            </span>
          </h1>
          <p className="font-sans text-xs uppercase tracking-widest mt-2 opacity-70 text-[#1A1A1A]">
            Real-time Content Ingestion Interface • Cloudflare Worker Node: HKG-04
          </p>
        </div>

        <div className="flex flex-col sm:flex-row items-start sm:items-center md:items-baseline gap-4 md:text-right">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-1.5 text-xs bg-white px-2.5 py-1.5 rounded-none text-[#1A1A1A] border border-[#1A1A1A] font-mono font-bold shadow-[2px_2px_0px_#1A1A1A]">
              <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
              API Status: <strong className="text-[#1A1A1A]">Online</strong>
            </div>
          </div>

          <div className="md:min-w-[120px]">
            <p className="font-sans text-[10px] uppercase font-bold tracking-widest text-[#1A1A1A]/60">Status</p>
            <p className="text-xl italic font-semibold text-[#D97706] font-serif leading-none mt-1">
              {isCrawling ? "Active Extraction..." : "Engine Idle"}
            </p>
          </div>
        </div>
      </header>

      {/* Main Workspace Layout */}
      <main className="flex-1 max-w-7xl w-full mx-auto p-4 md:p-8 grid grid-cols-1 lg:grid-cols-12 gap-8">
        
        {/* LEFT COLUMN: Controls, Terminal & Crawl Stats (5 cols) */}
        <div className="lg:col-span-5 flex flex-col gap-8" id="left_column">
          
          {/* 1. Crawler Engine Config Panel */}
          <div className="bg-white border border-[#1A1A1A] rounded-none p-6 shadow-[4px_4px_0px_#1A1A1A]" id="controls_card">
            <h2 className="text-sm font-bold uppercase tracking-wider text-[#1A1A1A] mb-4 flex items-center gap-2 border-b border-[#1A1A1A] pb-2 font-serif italic">
              <Settings2 className="w-4 h-4 text-amber-600" />
              Engine Configuration
            </h2>

            <div className="flex flex-col gap-4">
              {/* Target URL Input */}
              <div className="flex flex-col gap-1.5">
                <label className="text-xs text-[#1A1A1A] font-sans font-bold uppercase tracking-wider">Starting Page URL / Anchor</label>
                <div className="relative">
                  <input
                    id="input_target_url"
                    type="text"
                    value={targetUrl}
                    onChange={(e) => setTargetUrl(e.target.value)}
                    placeholder="https://sxyprn.com/blog/all/0.html"
                    className="w-full bg-white border border-[#1A1A1A] rounded-none px-3 py-2 text-xs font-mono text-[#1A1A1A] placeholder-zinc-400 focus:outline-none focus:ring-1 focus:ring-[#1A1A1A] pr-8"
                  />
                  <Search className="w-3.5 h-3.5 text-[#1A1A1A]/70 absolute right-3 top-3" />
                </div>
              </div>

              {/* Advanced Processing Toggles */}
              <div className="flex flex-col gap-2 p-3 bg-zinc-50 border border-zinc-200 shadow-inner">
                <label className="text-xs font-bold uppercase tracking-wider text-zinc-600 mb-1">Queue Processing Rules</label>
                
                <label className="flex items-center gap-2 cursor-pointer group">
                  <input
                    type="checkbox"
                    checked={autoQueueToDb}
                    onChange={(e) => setAutoQueueToDb(e.target.checked)}
                    className="w-4 h-4 rounded-none border-[#1A1A1A] text-[#1A1A1A] focus:ring-[#1A1A1A]"
                  />
                  <span className="text-xs font-medium text-[#1A1A1A] group-hover:text-blue-600">Auto-Queue to Database</span>
                </label>

                <label className="flex items-center gap-2 cursor-pointer group">
                  <input
                    type="checkbox"
                    className="w-4 h-4 rounded-none border-[#1A1A1A] text-[#1A1A1A] focus:ring-[#1A1A1A]"
                  />
                </label>
              </div>

              {/* Crawl Delay Input */}
              <div className="grid grid-cols-2 gap-4">
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs text-[#1A1A1A] font-sans font-bold uppercase tracking-wider">Delay Between Jumps</label>
                  <select
                    id="select_delay"
                    value={crawlDelay}
                    onChange={(e) => setCrawlDelay(Number(e.target.value))}
                    className="w-full bg-white border border-[#1A1A1A] rounded-none px-3 py-2 text-xs text-[#1A1A1A] font-mono focus:outline-none"
                  >
                    <option value={-1}>⏳ Random (60s - 300s)</option>
                    <option value={-2}>⚡ Fast Random (10s - 30s)</option>
                    <option value={-3}>🕒 Std Random (30s - 60s)</option>
                    <option value={-4}>🔥 Aggressive (5s - 15s)</option>
                    <option value={10000}>10s (Fixed)</option>
                    <option value={30000}>30s (Fixed)</option>
                    <option value={60000}>60s (Fixed)</option>
                    <option value={120000}>120s (Fixed)</option>
                  </select>
                </div>

                <div className="flex flex-col justify-end">
                  <div className="bg-[#FAF8F5] border border-[#1A1A1A] px-3 py-2 rounded-none text-center text-xs flex flex-col gap-1 items-center">
                    <div>
                      <span className="text-[#1A1A1A]/60 font-sans">Method: </span>
                      <span className="font-mono text-[#D97706] font-bold">HTTP_PROXY</span>
                    </div>
                    {/* Auto Byse Upload (Hidden) */}
                    {false && (
                    <label className="flex items-center gap-1.5 cursor-pointer mt-1 border-t border-[#1A1A1A]/20 pt-1 w-full justify-center">
                      <input 
                        type="checkbox" 
                        checked={isAutoUploading}
                        onChange={(e) => setIsAutoUploading(e.target.checked)}
                        className="accent-amber-600 w-3 h-3"
                      />
                      <span className="text-[10px] font-sans font-bold uppercase tracking-wider text-[#1A1A1A]">Auto Byse Upload</span>
                    </label>
                    )}
                  </div>
                </div>
              </div>

              {/* Presets Grid */}
              <div className="flex flex-col gap-1.5">
                <span className="text-[10px] text-[#1A1A1A]/60 font-sans font-bold uppercase tracking-wider">Starting Page Presets</span>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    id="preset_0"
                    onClick={() => {
                      setTargetUrl("https://sxyprn.com/blog/all/0.html");
                      addLog("info", "Loaded preset: Latest (Blog All)");
                    }}
                    className="bg-white hover:bg-zinc-50 border border-[#1A1A1A] py-1.5 text-[10px] font-mono text-[#1A1A1A] text-center shadow-[2px_2px_0px_#1A1A1A] active:translate-x-[1px] active:translate-y-[1px] active:shadow-none transition-all"
                  >
                    Latest
                  </button>
                  <button
                    id="preset_orgasmic"
                    onClick={() => {
                      setTargetUrl("https://sxyprn.com/orgasm/0");
                      addLog("info", "Loaded preset: Orgasmic");
                    }}
                    className="bg-white hover:bg-zinc-50 border border-[#1A1A1A] py-1.5 text-[10px] font-mono text-[#1A1A1A] text-center shadow-[2px_2px_0px_#1A1A1A] active:translate-x-[1px] active:translate-y-[1px] active:shadow-none transition-all"
                  >
                    Orgasmic
                  </button>
                </div>
              </div>

              {/* Human Pacing / Duplicate Cooldown Countdown Ticker */}
              {countdown !== null && isCrawling && (
                <div className="bg-[#FEF3C7] border-2 border-[#1A1A1A] p-3 text-xs flex flex-col gap-2 shadow-[2px_2px_0px_#1A1A1A] mt-2">
                  <div className="flex items-center justify-between font-bold">
                    <span className="text-[#92400E] flex items-center gap-1">
                      <span className="animate-pulse text-[#D97706] inline-block">⏳</span>
                      {countdown > 120 ? "Duplicate Cooldown / Refresh Loop Active..." : "Safe Human Delay Active..."}
                    </span>
                    <span className="font-mono text-[#D97706]">
                      Next Page in {countdown >= 60 ? `${Math.floor(countdown / 60)}m ${(countdown % 60).toString().padStart(2, '0')}s` : `${countdown}s`}
                    </span>
                  </div>
                  <div className="w-full bg-[#FAF8F5] border border-[#1A1A1A] h-2 relative overflow-hidden">
                    <motion.div
                      key={countdown}
                      initial={{ width: `${((countdown + 1) / (countdownMax || countdown + 1)) * 100}%` }}
                      animate={{ width: `${(countdown / (countdownMax || countdown)) * 100}%` }}
                      transition={{ duration: 1, ease: "linear" }}
                      className="bg-[#D97706] h-full"
                    />
                  </div>
                  <p className="text-[9px] text-[#92400E]/80 font-serif italic text-center">
                    {countdown > 120 
                      ? "100-minute cooldown active across full duplicate streak to allow source site to update before refreshing from beginning."
                      : "Simulating randomized human browsing patterns to safely bypass Cloudflare/IP blocks."}
                  </p>
                </div>
              )}

              {/* Resume-from-checkpoint banner */}
              {savedCheckpoint && !isCrawling && (
                <div className="bg-[#EFF6FF] border-2 border-[#1A1A1A] p-3 text-xs flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2 shadow-[2px_2px_0px_#1A1A1A] mt-2">
                  <span className="font-mono text-[#1E3A8A]">
                    Saved checkpoint: <span className="break-all">{savedCheckpoint.url}</span>
                    {savedCheckpoint.updated_at ? ` (${new Date(savedCheckpoint.updated_at).toLocaleString()})` : ""}
                  </span>
                  <button
                    id="btn_resume_checkpoint"
                    onClick={() => {
                      setTargetUrl(savedCheckpoint.url);
                      duplicateStreakRef.current = 0;
                      setConsecutiveDuplicatePages(0);
                      addLog("info", `Checkpoint থেকে resume করা হলো: ${savedCheckpoint.url}`);
                    }}
                    className="bg-white hover:bg-zinc-50 border border-[#1A1A1A] py-1 px-3 text-[10px] font-mono text-[#1A1A1A] shrink-0"
                  >
                    Resume from checkpoint
                  </button>
                </div>
              )}

              {/* Control Action Buttons */}
              <div className="grid grid-cols-2 gap-3 mt-2">
                
                {isCrawling ? (
                  <button
                    id="btn_pause_crawl"
                    onClick={() => {
                      setIsCrawling(false);
                      addLog("warn", "Crawl Loop paused by user.");
                    }}
                    className="w-full bg-[#D97706] hover:bg-[#C2410C] text-white font-bold py-2.5 px-4 rounded-none flex items-center justify-center gap-2 transition-all text-xs uppercase tracking-wider border-2 border-[#1A1A1A] shadow-[3px_3px_0px_#1A1A1A]"
                  >
                    <Pause className="w-4 h-4 fill-current" />
                    Pause Crawler
                  </button>
                ) : (
                  <button
                    id="btn_start_crawl"
                    onClick={() => {
                      duplicateStreakRef.current = 0;
                      setConsecutiveDuplicatePages(0);
                      setIsCrawling(true);
                      addLog("success", `Initiated recursive multi-page crawler starting from: ${targetUrl}`);
                    }}
                    className="w-full bg-[#1A1A1A] hover:bg-zinc-800 text-white font-bold py-2.5 px-4 rounded-none flex items-center justify-center gap-2 transition-all text-xs uppercase tracking-wider border-2 border-[#1A1A1A] shadow-[3px_3px_0px_#FDE68A]"
                  >
                    <Play className="w-4 h-4 fill-current" />
                    Start Crawling
                  </button>
                )}

                <button
                  id="btn_step_scrape"
                  disabled={isLoading || isCrawling}
                  onClick={async () => {
                    const next = await scrapeSinglePage(targetUrl);
                    if (next && next.nextUrl) setTargetUrl(next.nextUrl);
                  }}
                  className="w-full bg-white hover:bg-zinc-50 text-[#1A1A1A] font-bold py-2.5 px-4 rounded-none flex items-center justify-center gap-2 transition-all text-xs uppercase tracking-wider border-2 border-[#1A1A1A] shadow-[3px_3px_0px_#1A1A1A] disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <RefreshCw className={`w-4 h-4 ${isLoading ? "animate-spin" : ""}`} />
                  Single Step
                </button>

              </div>

              {/* Server-side crawler — keeps running when browser is closed */}
              <div className="mt-3 border-2 border-[#1A1A1A] bg-[#FDE68A]/40 p-2.5 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-bold uppercase tracking-wider text-[#1A1A1A]">
                    🖥️ Server-side Crawler (browser বন্ধ করলেও চলবে)
                  </span>
                  <span className={`text-[10px] font-mono px-2 py-0.5 border border-[#1A1A1A] ${serverCrawlerState?.running ? 'bg-[#16A34A] text-white' : 'bg-white text-[#1A1A1A]'}`}>
                    {serverCrawlerState?.running ? 'RUNNING' : 'IDLE'}
                  </span>
                </div>
                {serverCrawlerState && (
                  <div className="text-[10px] font-mono text-[#1A1A1A]/80 leading-relaxed space-y-1">
                    <div className="flex justify-between border-b border-[#1A1A1A]/20 pb-1 mb-1">
                      <span>current: <a href={serverCrawlerState.currentUrl || '#'} target="_blank" rel="noopener noreferrer" className="hover:underline text-blue-600">{serverCrawlerState.currentUrl || '—'}</a></span>
                      <span>pages: {serverCrawlerState.pagesThisRun ?? 0} · dup: {serverCrawlerState.duplicateStreak ?? 0}</span>
                    </div>
                    {serverCrawlerState.lastError && <div className="text-red-700 bg-red-50 p-1">error: {serverCrawlerState.lastError}</div>}
                    <div className="bg-[#1A1A1A]/5 p-1.5 h-32 overflow-y-auto border border-[#1A1A1A]/10 space-y-0.5 flex flex-col-reverse">
                      {serverCrawlerState.logs && serverCrawlerState.logs.length > 0 ? (
                        [...serverCrawlerState.logs].reverse().map((log: string, idx: number) => (
                          <div key={idx} className="whitespace-pre-wrap">{log}</div>
                        ))
                      ) : (
                        <div className="italic opacity-50">No logs yet...</div>
                      )}
                    </div>
                  </div>
                )}
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                  <button
                    disabled={serverCrawlerState?.running}
                    onClick={async () => {
                      try {
                        const r = await fetch('/api/crawl/server/start', {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ resume: true }),
                        });
                        const j = await r.json();
                        if (r.ok) {
                          setServerCrawlerState(j.state);
                          addLog('success', `Server crawler resumed from checkpoint.`);
                        } else {
                          addLog('error', `Resume failed: ${j.error || r.status}`);
                        }
                      } catch (e: any) { addLog('error', `Resume error: ${e.message}`); }
                    }}
                    className="bg-[#2563EB] hover:bg-[#1D4ED8] text-white font-bold py-2 px-2 text-[10px] uppercase tracking-wider border-2 border-[#1A1A1A] shadow-[2px_2px_0px_#1A1A1A] disabled:opacity-40"
                  >
                    ▶ Resume on Server
                  </button>
                  <button
                    disabled={serverCrawlerState?.running}
                    onClick={async () => {
                      try {
                        const r = await fetch('/api/crawl/server/start', {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ url: targetUrl, resume: false }),
                        });
                        const j = await r.json();
                        if (r.ok) {
                          setServerCrawlerState(j.state);
                          addLog('success', `Server crawler started from: ${targetUrl}`);
                        } else {
                          addLog('error', `Start failed: ${j.error || r.status}`);
                        }
                      } catch (e: any) { addLog('error', `Start error: ${e.message}`); }
                    }}
                    className="bg-[#16A34A] hover:bg-[#15803D] text-white font-bold py-2 px-2 text-[10px] uppercase tracking-wider border-2 border-[#1A1A1A] shadow-[2px_2px_0px_#1A1A1A] disabled:opacity-40"
                  >
                    ▶ Start Fresh
                  </button>
                  <button
                    disabled={!serverCrawlerState?.running}
                    onClick={async () => {
                      try {
                        const r = await fetch('/api/crawl/server/stop', { method: 'POST' });
                        const j = await r.json();
                        if (r.ok) {
                          setServerCrawlerState(j.state);
                          addLog('warn', 'Server crawler stopped.');
                        }
                      } catch (e: any) { addLog('error', `Stop error: ${e.message}`); }
                    }}
                    className="bg-[#DC2626] hover:bg-[#B91C1C] text-white font-bold py-2 px-2 text-[10px] uppercase tracking-wider border-2 border-[#1A1A1A] shadow-[2px_2px_0px_#1A1A1A] disabled:opacity-40"
                  >
                    ■ Stop
                  </button>
                </div>
              </div>

              <div className="hidden">{/* spacer replaced */}</div>

              {consecutiveDuplicatePages > 0 && isCrawling && (
                <p className="text-[10px] font-mono text-[#92400E] mt-1">
                  পরপর {consecutiveDuplicatePages}/{DUPLICATE_STREAK_STOP_THRESHOLD} পেজে নতুন পোস্ট পাওয়া যায়নি — {DUPLICATE_STREAK_STOP_THRESHOLD} এ পৌঁছালে crawler নিরাপদে থেমে যাবে।
                </p>
              )}


              <button
                id="btn_clear_data"
                onClick={handleClear}
                className="w-full text-center text-[#1A1A1A]/60 hover:text-red-700 text-xs py-1 transition-colors hover:underline font-serif italic mt-1"
              >
                Clear Database & Reset
              </button>

            </div>
          </div>

          {/* 2. Scraper Live Statistics Panel */}
          <div className="bg-[#1A1A1A] text-white p-5 border border-[#1A1A1A] shadow-[4px_4px_0px_#D97706] rounded-none" id="stats_panel">
            <h4 className="font-sans text-[10px] uppercase tracking-[0.2em] mb-4 opacity-75 font-bold flex items-center gap-1.5">
              <Database className="w-3.5 h-3.5 text-amber-400" />
              Extraction Metrics
            </h4>
            <div className="grid grid-cols-3 gap-3 text-center">
              <div className="border-r border-white/10 pr-2">
                <p className="text-2xl font-bold font-serif leading-none text-white">{stats.pagesCrawled}</p>
                <p className="font-sans text-[9px] uppercase tracking-widest opacity-60 mt-1">Pages Scraped</p>
              </div>
              <div className="border-r border-white/10 px-2">
                <p className="text-2xl font-bold font-serif leading-none text-[#FDE68A]">{scrapedData.length}</p>
                <p className="font-sans text-[9px] uppercase tracking-widest opacity-60 mt-1">Total Posts</p>
              </div>
              <div className="pl-2">
                <p className="text-2xl font-bold font-serif leading-none text-emerald-400">{derivedTotalEmbeds}</p>
                <p className="font-sans text-[9px] uppercase tracking-widest opacity-60 mt-1">Embed Links</p>
              </div>
            </div>
          </div>

          {/* 3. Terminal Live Logs (Real-time monitoring console) */}
          <div className="bg-white border-2 border-[#1A1A1A] rounded-none flex-1 flex flex-col overflow-hidden min-h-[300px] shadow-[4px_4px_0px_#1A1A1A]" id="terminal_card">
            <div className="bg-[#1A1A1A] text-white px-4 py-2.5 flex items-center justify-between border-b border-[#1A1A1A]">
              <div className="flex items-center gap-2">
                <Terminal className="w-3.5 h-3.5 text-amber-400" />
                <span className="text-xs font-mono font-bold tracking-tight">CRAWLER_CONSOLE_OUTPUT</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
                <span className="text-[10px] font-mono text-white/70">ACTIVE_STREAM</span>
              </div>
            </div>

            {/* Terminal Feed Scroll area */}
            <div className="p-4 flex-1 overflow-y-auto font-mono text-[11px] leading-relaxed flex flex-col gap-2 max-h-[380px] bg-[#FAF8F5] select-text border-b border-[#1A1A1A]" id="terminal_output">
              {logs.length === 0 ? (
                <div className="text-zinc-400 italic text-center py-6 font-serif">Terminal logs are currently empty. Run the scraper to populate.</div>
              ) : (
                logs.map((log, index) => {
                  let badgeColor = "text-zinc-500 font-bold";
                  let textColor = "text-zinc-800";

                  if (log.type === "success") {
                    badgeColor = "text-emerald-700 font-extrabold";
                    textColor = "text-emerald-900 font-medium";
                  } else if (log.type === "warn") {
                    badgeColor = "text-amber-700 font-extrabold";
                    textColor = "text-amber-900 font-medium";
                  } else if (log.type === "error") {
                    badgeColor = "text-red-700 font-extrabold";
                    textColor = "text-red-900 font-medium";
                  } else if (log.type === "api") {
                    badgeColor = "text-[#1A1A1A] font-extrabold";
                    textColor = "text-[#1A1A1A]";
                  }

                  return (
                    <div key={index} className="border-b border-zinc-200/60 pb-1 flex items-start gap-1">
                      <span className="text-zinc-400 font-mono select-none">[{log.timestamp}]</span>
                      <span className={`${badgeColor} select-none`}>[{log.type.toUpperCase()}]</span>
                      <span className={`${textColor} break-all`}>{log.text}</span>
                    </div>
                  );
                })
              )}
              <div ref={consoleEndRef} />
            </div>

            <div className="bg-white px-4 py-2 flex justify-between items-center font-mono text-[9px] uppercase tracking-wider text-[#1A1A1A]/70">
              <span>LOOP_INTERVAL: {crawlDelay}ms</span>
              <button
                id="btn_clear_logs"
                onClick={() => setLogs([])}
                className="font-bold hover:text-red-600 underline"
              >
                CLEAR_LOGS
              </button>
            </div>
          </div>

        </div>

        {/* RIGHT COLUMN: Results Workspace (7 cols) */}
        <div className="lg:col-span-7 flex flex-col gap-8" id="right_column">
          
          {/* Main workspace navigation tabs */}
          <div className="border-b-2 border-[#1A1A1A] flex flex-wrap items-center justify-between gap-4">
            <div className="flex flex-wrap gap-1 -mb-[2px] text-xs">
              <button
                id="tab_posts"
                onClick={() => setActiveTab("posts")}
                className={`flex items-center gap-2 px-4 py-2.5 transition-all uppercase tracking-wider text-[11px] font-sans ${
                  activeTab === "posts" 
                    ? "border-t-2 border-x-2 border-[#1A1A1A] bg-white font-bold text-[#1A1A1A]" 
                    : "border-transparent text-zinc-500 hover:text-[#1A1A1A]"
                }`}
              >
                <Grid className="w-3.5 h-3.5" />
                Extracted Catalog ({filteredPosts.length})
              </button>
              <button
                id="tab_json"
                onClick={() => setActiveTab("json")}
                className={`flex items-center gap-2 px-4 py-2.5 transition-all uppercase tracking-wider text-[11px] font-sans ${
                  activeTab === "json" 
                    ? "border-t-2 border-x-2 border-[#1A1A1A] bg-white font-bold text-[#1A1A1A]" 
                    : "border-transparent text-zinc-500 hover:text-[#1A1A1A]"
                }`}
              >
                <FileText className="w-3.5 h-3.5" />
                Raw JSON Output
              </button>
              
              <button
                id="tab_queue"
                onClick={() => setActiveTab("queue")}
                className={`flex items-center gap-2 px-4 py-2.5 transition-all uppercase tracking-wider text-[11px] font-sans ${
                  activeTab === "queue" 
                    ? "border-t-2 border-x-2 border-[#1A1A1A] bg-white font-bold text-[#1A1A1A]" 
                    : "border-transparent text-zinc-500 hover:text-[#1A1A1A]"
                }`}
              >
                <Activity className="w-3.5 h-3.5" />
                Queue
              </button>
              <button
                id="tab_remotefiles"
                onClick={() => setActiveTab("remotefiles")}
                className={`flex items-center gap-2 px-4 py-2.5 transition-all uppercase tracking-wider text-[11px] font-sans ${
                  activeTab === "remotefiles" 
                    ? "border-t-2 border-x-2 border-[#1A1A1A] bg-white font-bold text-[#1A1A1A]" 
                    : "border-transparent text-zinc-500 hover:text-[#1A1A1A]"
                }`}
              >
                <Database className="w-3.5 h-3.5" />
                Remote Files
              </button>
              <button
                id="tab_database"
                onClick={() => setActiveTab("database")}
                className={`flex items-center gap-2 px-4 py-2.5 transition-all uppercase tracking-wider text-[11px] font-sans ${
                  activeTab === "database" 
                    ? "border-t-2 border-x-2 border-[#1A1A1A] bg-white font-bold text-[#1A1A1A]" 
                    : "border-transparent text-zinc-500 hover:text-[#1A1A1A]"
                }`}
              >
                <Database className="w-3.5 h-3.5" />
                Supabase DB
              </button>
              <button
                id="tab_images"
                onClick={() => setActiveTab("images")}
                className={`flex items-center gap-2 px-4 py-2.5 transition-all uppercase tracking-wider text-[11px] font-sans ${
                  activeTab === "images" 
                    ? "border-t-2 border-x-2 border-[#1A1A1A] bg-white font-bold text-[#1A1A1A]" 
                    : "border-transparent text-zinc-500 hover:text-[#1A1A1A]"
                }`}
              >
                <UploadCloud className="w-3.5 h-3.5 text-amber-600" />
                Edge Image CDN
                {imageStats && (
                  <span className="text-[9px] bg-amber-100 text-amber-900 border border-amber-300 px-1 py-0.2 rounded font-mono font-bold">
                    {imageStats.on_cloudflare_cdn}/{imageStats.total}
                  </span>
                )}
              </button>
              <button
                id="tab_links"
                onClick={() => setActiveTab("links")}
                className={`flex items-center gap-2 px-4 py-2.5 transition-all uppercase tracking-wider text-[11px] font-sans ${
                  activeTab === "links" 
                    ? "border-t-2 border-x-2 border-[#1A1A1A] bg-white font-bold text-[#1A1A1A]" 
                    : "border-transparent text-zinc-500 hover:text-[#1A1A1A]"
                }`}
              >
                <LinkIcon className="w-3.5 h-3.5" />
                Extracted Links
              </button>
            </div>
            
            {activeTab === "posts" && scrapedData.length > 0 && (
              <button
                id="btn_download_json_main"
                onClick={handleDownloadJSON}
                className="bg-[#1A1A1A] hover:bg-zinc-800 text-white border-2 border-[#1A1A1A] px-3 py-1 text-xs font-sans font-bold uppercase tracking-wider transition-all shadow-[2px_2px_0px_#FAF8F5]"
              >
                <Download className="w-3.5 h-3.5 inline mr-1" />
                Download JSON
              </button>
            )}
          </div>

          {/* TAB CONTENTS CONTAINER */}
          <div className="flex-1 min-h-[500px]" id="tab_contents">
            
            {/* TAB 1: Extracted Catalog Cards */}
            {activeTab === "posts" && (
              <div className="flex flex-col gap-6">
                
                {/* Search & Active Actor Filters */}
                <div className="bg-white border-2 border-[#1A1A1A] p-4 flex flex-col md:flex-row gap-4 items-center justify-between shadow-[4px_4px_0px_#1A1A1A]" id="search_filters">
                  <div className="relative w-full md:max-w-xs">
                    <input
                      id="input_search"
                      type="text"
                      placeholder="Search items or actors..."
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      className="w-full bg-white border border-[#1A1A1A] py-1.5 pl-8 pr-3 text-xs placeholder-zinc-400 focus:outline-none focus:ring-1 focus:ring-[#1A1A1A]"
                    />
                    <Search className="w-3.5 h-3.5 text-[#1A1A1A]/70 absolute left-2.5 top-2.5" />
                  </div>

                  <div className="flex flex-wrap items-center gap-2.5 w-full md:w-auto justify-end text-xs">
                    {actorFilter && (
                      <span className="bg-[#FDE68A] text-[#92400E] border border-[#92400E] px-2 py-1 font-mono font-bold uppercase text-[10px] flex items-center gap-1.5">
                        <User className="w-3 h-3" />
                        Actor: {actorFilter}
                        <button
                          id="btn_clear_actor_filter"
                          onClick={() => setActorFilter(null)}
                          className="font-extrabold hover:text-red-700 px-0.5 ml-1"
                        >
                          ×
                        </button>
                      </span>
                    )}
                    {searchQuery && (
                      <button
                        id="btn_clear_search"
                        onClick={() => setSearchQuery("")}
                        className="text-[#1A1A1A] font-bold uppercase tracking-wider text-[10px] hover:underline"
                      >
                        Clear Search
                      </button>
                    )}
                    <span className="text-[#1A1A1A]/60 text-xs font-mono font-bold">
                      [ {filteredPosts.length} / {scrapedData.length} RECORDS ]
                    </span>
                  </div>
                </div>

                {/* Cards List */}
                {filteredPosts.length === 0 ? (
                  <div className="bg-[#FAF8F5] border-2 border-[#1A1A1A] p-12 text-center text-zinc-500 flex flex-col items-center gap-4 shadow-[4px_4px_0px_#1A1A1A]">
                    <Video className="w-12 h-12 text-zinc-400" />
                    <div>
                      <p className="text-xl font-bold text-[#1A1A1A] font-serif italic">No scraped database records found</p>
                      <p className="text-xs text-zinc-500 mt-2 max-w-sm font-sans mx-auto leading-relaxed">
                        Specify a start URL, choose a mode, and click <strong className="text-[#1A1A1A]">Start Crawling</strong> or <strong className="text-[#1A1A1A]">Single Step</strong> to fetch records.
                      </p>
                    </div>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 gap-4" id="cards_grid">
                    <AnimatePresence>
                      {filteredPosts.map((post, idx) => (
                        <motion.div
                          key={`${post.post_url}-${idx}`}
                          initial={{ opacity: 0, y: 12 }}
                          animate={{ opacity: 1, y: 0 }}
                          transition={{ duration: 0.2, delay: Math.min(idx * 0.04, 0.4) }}
                          className="bg-white border-2 border-[#1A1A1A] p-5 flex flex-col md:flex-row gap-5 transition-all shadow-[4px_4px_0px_#1A1A1A] rounded-none"
                        >
                          {/* Left: Sequence Number block */}
                          <div className="w-full md:w-32 h-24 bg-[#1A1A1A] text-white border-2 border-[#1A1A1A] rounded-none flex-shrink-0 flex flex-col items-center justify-center relative overflow-hidden group shadow-inner">
                            {post.thumbnail ? (
                              <img src={getProxyImageUrl(post.thumbnail, post.title)} referrerPolicy="no-referrer" onError={(e) => { (e.target as HTMLElement).style.display = 'none'; }} className="absolute inset-0 w-full h-full object-cover opacity-60 group-hover:opacity-80 transition-opacity" />
                            ) : (post.embeds && post.embeds.length > 0) ? (
                              <img src={`/api/thumbnail?url=${encodeURIComponent(post.embeds[0])}&title=${encodeURIComponent(post.title)}`} referrerPolicy="no-referrer" onError={(e) => { (e.target as HTMLElement).style.display = 'none'; }} className="absolute inset-0 w-full h-full object-cover opacity-60 group-hover:opacity-80 transition-opacity" />
                            ) : null}

                            
                            <span className="text-[10px] font-mono uppercase tracking-widest font-bold text-zinc-400 absolute top-2 left-2">Record</span>
                            <span className="text-4xl font-serif italic font-bold group-hover:scale-110 transition-transform text-[#FAF8F5]">
                              #{idx + 1}
                            </span>
                            {post.duration && (
                              <span className="absolute bottom-1.5 right-1.5 bg-[#FAF8F5] text-[#1A1A1A] border border-[#1A1A1A] text-[10px] font-mono px-1.5 py-0.5 font-bold">
                                {post.duration}
                              </span>
                            )}
                          </div>

                          {/* Right: Detailed Extracted Content */}
                          <div className="flex-1 flex flex-col justify-between gap-3">
                            <div>
                                                            <h3 className="text-sm md:text-base font-bold text-[#1A1A1A] leading-tight font-serif flex items-center gap-2 flex-wrap">
                                <span className="font-mono text-xs bg-zinc-100 text-zinc-500 px-1.5 py-0.5 border border-zinc-200 uppercase">ID: {calculatePostId(post.post_url)}</span>
                                <span className="italic">{post.title}</span>
                                {isVidaraEmbed(post.embeds, post.direct_link, post.post_url, post.categories) && (
                                  <span className="text-[10px] font-mono font-bold bg-amber-400 text-black border border-[#1A1A1A] px-1.5 py-0.5 whitespace-nowrap uppercase shadow-[1px_1px_0px_#1A1A1A] flex items-center gap-1">
                                    💎 PORNVOID PREMIUM
                                  </span>
                                )}
                                {post.dbStatus === 'success' && <span className="text-[10px] font-mono font-bold bg-emerald-100 text-emerald-800 border border-emerald-200 px-1.5 py-0.5 whitespace-nowrap uppercase">DB Added</span>}
                                {post.dbStatus === 'processing' && <span className="text-[10px] font-mono font-bold bg-blue-100 text-blue-800 border border-blue-200 px-1.5 py-0.5 whitespace-nowrap uppercase">Cloning...</span>}
                                {post.dbStatus === 'error' && <span className="text-[10px] font-mono font-bold bg-red-100 text-red-800 border border-red-200 px-1.5 py-0.5 whitespace-nowrap uppercase">DB Error</span>}
                                {post.dbStatus === 'duplicate' && <span className="text-[10px] font-mono font-bold bg-purple-100 text-purple-800 border border-purple-200 px-1.5 py-0.5 whitespace-nowrap uppercase">Duplicate</span>}
                                {post.dbStatus === 'pending' && <span className="text-[10px] font-mono font-bold bg-yellow-100 text-yellow-800 border border-yellow-200 px-1.5 py-0.5 whitespace-nowrap uppercase">DB Pending</span>}
                                {post.dbStatus === 'dropped' && <span className="text-[10px] font-mono font-bold bg-zinc-200 text-zinc-600 border border-zinc-300 px-1.5 py-0.5 whitespace-nowrap uppercase">Not Queued</span>}
                              </h3>
                              {isVidaraEmbed(post.embeds, post.direct_link, post.post_url, post.categories) && (
                                <div className="mt-1 text-[10px] font-mono text-amber-900 bg-amber-50 border border-amber-300 px-2 py-0.5 inline-block">
                                  <span className="font-bold">slug:</span> {post.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'video'}-pornvoid-premium
                                </div>
                              )}
                              
                              {post.categories && post.categories.length > 0 && (
                                <div className="mt-1.5 flex flex-wrap gap-1">
                                  {post.categories.map((cat, idx) => (
                                    <div key={idx} className="inline-block bg-[#1A1A1A] text-white text-[9px] px-1.5 py-0.5 rounded-sm font-bold uppercase tracking-wider font-mono">
                                      {cat}
                                    </div>
                                  ))}
                                </div>
                              )}

                              <div className="flex flex-wrap items-center gap-1.5 mt-2.5">
                                <span className="text-[10px] text-[#1A1A1A]/70 font-sans font-bold uppercase tracking-wider">Actors:</span>
                                {post.actors && post.actors.length > 0 ? (
                                  post.actors.map(actor => (
                                    <button
                                      key={actor}
                                      onClick={() => setActorFilter(actor)}
                                      className={`text-[9px] px-2 py-0.5 rounded-none border font-mono font-bold flex items-center gap-1 transition-colors uppercase tracking-wider ${
                                        actorFilter === actor 
                                          ? "bg-[#1A1A1A] text-white border-[#1A1A1A]" 
                                          : "bg-white text-[#1A1A1A] border-[#1A1A1A] hover:bg-zinc-50"
                                      }`}
                                    >
                                      <User className="w-2.5 h-2.5" />
                                      {actor}
                                    </button>
                                  ))
                                ) : (
                                  <span className="text-[10px] text-zinc-500 italic">None detected</span>
                                )}
                              </div>
                            </div>

                            {/* Embed targets & Direct file urls */}
                            <div className="border-t border-[#1A1A1A]/20 pt-3 grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
                              {/* External Embeds list */}
                              <div>
                                {(() => {
                                  const total = post.embeds?.length || 0;
                                  let playmate = 0, dood = 0, vid = 0, lulu = 0, other = 0;
                                  post.embeds?.forEach(emb => {
                                    const l = emb.toLowerCase();
                                    if (l.includes("playmate")) playmate++;
                                    else if (l.match(/vidara|vidaarax|vidavaca|vidaratem|vidaraw/)) vid++;
                                    else if (l.match(/dood|ds2play|d000d|vide0|do7go|playmogo|doodstream/)) dood++;
                                    else if (l.includes("lulu")) lulu++;
                                    else other++;
                                  });
                                  return (
                                    <span className="text-[9px] text-[#1A1A1A]/70 uppercase font-sans font-bold tracking-wider block mb-1.5">
                                      Scraped Embeds ({total})
                                      {playmate > 0 && <span className="ml-1.5 text-emerald-800 bg-emerald-100 px-1 py-0.2 rounded font-mono font-bold">{playmate} Playmate</span>}
                                      {vid > 0 && <span className="ml-1 text-amber-800 bg-amber-100 px-1 py-0.2 rounded font-mono font-bold">{vid} Vidara</span>}
                                      {dood > 0 && <span className="ml-1 text-blue-800 bg-blue-100 px-1 py-0.2 rounded font-mono font-bold">{dood} Dood</span>}
                                    </span>
                                  );
                                })()}
                                <div className="flex flex-wrap gap-1.5">
                                  {post.embeds && post.embeds.length > 0 ? (
                                    post.embeds.map((emb, i) => {
                                      let label = "External Stream";
                                      let colorClass = "bg-cyan-100 text-cyan-900 border-cyan-900/50";
                                      
                                      const lowerEmb = emb.toLowerCase();
                                      if (lowerEmb.includes("playmate")) {
                                        label = "Playmate";
                                        colorClass = "bg-emerald-100 text-emerald-950 border-emerald-600/70 shadow-sm";
                                      } else if (lowerEmb.includes("vidara") || lowerEmb.match(/vidaarax|vidavaca|vidaratem|vidaraw/)) {
                                        label = "Vidara";
                                        colorClass = "bg-amber-100 text-amber-950 border-amber-600/70";
                                      } else if (lowerEmb.includes("lulu")) {
                                        label = "Luluvid";
                                        colorClass = "bg-purple-100 text-purple-900 border-purple-900/50";
                                      } else if (lowerEmb.match(/dood|ds2play|d000d|vide0|do7go|playmogo|doodstream/)) {
                                        label = "Doodstream";
                                        colorClass = "bg-blue-100 text-blue-900 border-blue-900/50";
                                      }

                                      return (
                                        <div key={i} className="flex gap-1">
                                          <a
                                            href={emb}
                                            target="_blank"
                                            rel="noreferrer"
                                            className={`text-[9px] px-2 py-1 rounded-none border font-sans font-bold uppercase tracking-wider flex items-center gap-1 transition-all hover:brightness-95 ${colorClass}`}
                                          >
                                            {label === "Playmate" && <span className="text-[10px]">▶</span>}
                                            {label}
                                            <ExternalLink className="w-2.5 h-2.5" />
                                          </a>
                                        </div>
                                      );
                                    })
                                  ) : (
                                    <span className="text-[10px] text-zinc-500 italic">No external embeds</span>
                                  )}
                                </div>
                              </div>

                              {/* Direct CDN Video Stream Link */}
                              <div className="flex flex-col gap-2">
                                <div>
                                  <span className="text-[9px] text-[#1A1A1A]/70 uppercase font-sans font-bold tracking-wider block mb-1.5">Direct CDN Video File</span>
                                  {post.direct_link ? (
                                    <div className="flex gap-1.5">
                                      <input
                                        type="text"
                                        readOnly
                                        value={post.direct_link}
                                        className="w-full bg-[#FAF8F5] border border-[#1A1A1A] rounded-none px-2 py-1 text-[10px] font-mono text-emerald-800 focus:outline-none font-bold"
                                      />
                                    </div>
                                  ) : (
                                    <span className="text-[10px] text-zinc-500 italic">Missing direct path; check detail page</span>
                                  )}
</div></div>

                                </div>

                            {/* Footer links */}
                            <div className="flex justify-between items-center text-[10px] border-t border-[#1A1A1A]/10 pt-2">
                              <span className="font-mono text-zinc-400 overflow-hidden text-ellipsis whitespace-nowrap max-w-[280px]">
                                {post.post_url}
                              </span>
                              <a
                                href={post.post_url}
                                target="_blank"
                                rel="noreferrer"
                                className="text-[#D97706] hover:text-[#C2410C] font-sans font-bold uppercase tracking-wider text-[9px] flex items-center gap-0.5 transition-colors"
                              >
                                View Page
                                <ExternalLink className="w-2.5 h-2.5" />
                              </a>
                            </div>

                          </div>
                        </motion.div>
                      ))}
                    </AnimatePresence>
                  </div>
                )}

              </div>
            )}

            {/* TAB 2: Combined RAW JSON viewer */}
            {activeTab === "json" && (
              <div className="bg-white border-2 border-[#1A1A1A] p-6 flex flex-col gap-4 shadow-[4px_4px_0px_#1A1A1A] rounded-none">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-[#1A1A1A] pb-4">
                  <div>
                    <h3 className="text-base font-bold font-serif italic text-[#1A1A1A]">Raw API Payload Data</h3>
                    <p className="text-xs text-zinc-500 mt-1">Aggregated array database of all successfully parsed posts.</p>
                  </div>
                  <div className="flex gap-2">
                    <button
                      id="btn_copy_json"
                      onClick={() => handleCopy(JSON.stringify(scrapedData, null, 2), "ALL_JSON")}
                      className="bg-white hover:bg-zinc-50 text-[#1A1A1A] border-2 border-[#1A1A1A] px-3 py-1.5 text-xs font-sans font-bold uppercase tracking-wider shadow-[2px_2px_0px_#1A1A1A]"
                    >
                      {copiedText === "ALL_JSON" ? (
                        <>
                          <Check className="w-3.5 h-3.5 text-emerald-600 inline mr-1 font-bold" />
                          Copied!
                        </>
                      ) : (
                        <>
                          <Copy className="w-3.5 h-3.5 inline mr-1" />
                          Copy JSON
                        </>
                      )}
                    </button>
                    <button
                      id="btn_download_json_tab"
                      onClick={handleDownloadJSON}
                      className="bg-[#1A1A1A] hover:bg-zinc-800 text-white border-2 border-[#1A1A1A] px-3 py-1.5 text-xs font-sans font-bold uppercase tracking-wider shadow-[2px_2px_0px_#FAF8F5]"
                    >
                      <Download className="w-3.5 h-3.5 inline mr-1" />
                      Download Database
                    </button>
                  </div>
                </div>

                <div className="relative">
                  <pre className="bg-[#FAF8F5] border border-[#1A1A1A] p-4 rounded-none text-xs font-mono text-[#1A1A1A] overflow-x-auto max-h-[500px] leading-relaxed select-text shadow-inner">
                    {scrapedData.length === 0 
                      ? "[\n  // Your scraped results database is empty. Launch crawler to populate JSON.\n]" 
                      : JSON.stringify(scrapedData, null, 2)
                    }
                  </pre>
                </div>
              </div>
            )}

            {/* TAB: Processing Queue — 3-state real-time tracker */}
            {activeTab === "queue" && (() => {
              const pending    = queueStatus.filter((t: any) => t.state === 'PENDING');
              const processing = queueStatus.filter((t: any) => t.state === 'PROCESSING');
              const done       = queueStatus.filter((t: any) => t.state === 'DONE' || t.state === 'ERROR' || t.state === 'DUPLICATE');

              const TaskCard = ({ task }: { task: any }) => (
                <div className="bg-[#FAF8F5] border border-zinc-200 p-3 flex flex-col gap-2 relative hover:border-[#1A1A1A] transition-colors">
                  <div className="flex items-start justify-between gap-2">
                    <h4 className="font-bold text-[#1A1A1A] text-xs leading-snug flex-1">{task.title}</h4>
                    <span className={`shrink-0 px-2 py-0.5 text-[9px] font-bold uppercase font-mono border ${
                      task.state === 'DONE'       ? 'bg-emerald-100 text-emerald-800 border-emerald-300' :
                      task.state === 'ERROR'      ? 'bg-red-100 text-red-800 border-red-300' :
                      task.state === 'DUPLICATE'  ? 'bg-purple-100 text-purple-800 border-purple-300' :
                      task.state === 'PROCESSING' ? 'bg-blue-100 text-blue-800 border-blue-300 animate-pulse' :
                                                    'bg-zinc-100 text-zinc-600 border-zinc-300'
                    }`}>{task.state}</span>
                  </div>

                  {task.final_embeds && task.final_embeds.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {task.final_embeds.map((url: string, i: number) => {
                        const isPlaymate = url.match(/playmate/i);
                        const isVidara   = url.match(/vidara|vidaarax|vidavaca|vidaratem|vidaraw/i);
                        const isDood     = url.match(/dood|ds2play|d000d|vide0|do7go|playmogo|doodstream/i);
                        const isLulu     = url.match(/lulu/i);
                        const label = isPlaymate ? 'Playmate' : isVidara ? 'Vidara' : isDood ? 'Dood' : isLulu ? 'Luluvid' : 'Embed';
                        return (
                          <a key={i} href={url} target="_blank" rel="noreferrer"
                             className={`text-[9px] px-1.5 py-0.5 border font-mono font-bold uppercase flex items-center gap-1 ${
                               isPlaymate ? 'bg-emerald-100 text-emerald-900 border-emerald-400' :
                               isVidara   ? 'bg-amber-100 text-amber-900 border-amber-400' :
                               isDood     ? 'bg-blue-100 text-blue-800 border-blue-300' :
                               isLulu     ? 'bg-purple-100 text-purple-800 border-purple-300' :
                                            'bg-zinc-100 text-zinc-700 border-zinc-300'
                             }`}>
                            {label}
                            <ExternalLink className="w-2 h-2" />
                          </a>
                        );
                      })}
                    </div>
                  )}

                  {task.error_msg && (
                    <div className="text-[10px] text-red-600 font-mono bg-red-50 p-1.5 border border-red-200">{task.error_msg}</div>
                  )}

                  {task.logs && task.logs.length > 0 && (
                    <details className="mt-1">
                      <summary className="text-[9px] font-bold uppercase tracking-wider text-zinc-400 cursor-pointer">Engine Logs ({task.logs.length})</summary>
                      <div className="bg-zinc-900 text-emerald-400 p-2 text-[9px] font-mono mt-1.5 max-h-36 overflow-y-auto flex flex-col gap-0.5 border border-zinc-700">
                        {task.logs.map((log: string, i: number) => <div key={i} className="break-all leading-relaxed">{log}</div>)}
                      </div>
                    </details>
                  )}
                </div>
              );

              return (
                <div className="flex flex-col gap-6">
                  <div className="bg-white border-2 border-[#1A1A1A] p-6 flex flex-col gap-6 shadow-[4px_4px_0px_#1A1A1A]">
                    <div className="border-b border-[#1A1A1A] pb-4">
                      <h3 className="text-base font-bold font-serif italic text-[#1A1A1A]">Processing Queue</h3>
                    </div>

                    {/* Summary badges */}
                    <div className="grid grid-cols-3 gap-3 text-center">
                      <div className="border border-zinc-200 p-3 bg-zinc-50">
                        <div className="text-2xl font-bold font-serif">{pending.length}</div>
                        <div className="text-[10px] uppercase font-bold text-zinc-500 mt-1">Pending</div>
                      </div>
                      <div className="border border-blue-200 p-3 bg-blue-50">
                        <div className="text-2xl font-bold font-serif text-blue-700">{processing.length}</div>
                        <div className="text-[10px] uppercase font-bold text-blue-500 mt-1">Processing</div>
                      </div>
                      <div className="border border-emerald-200 p-3 bg-emerald-50">
                        <div className="text-2xl font-bold font-serif text-emerald-700">{done.length}</div>
                        <div className="text-[10px] uppercase font-bold text-emerald-500 mt-1">Done / Error</div>
                      </div>
                    </div>

                    {queueStatus.length === 0 ? (
                      <div className="text-sm text-zinc-500 italic py-8 text-center bg-[#FAF8F5] border border-zinc-200">Queue is empty. Posts will appear here after Auto-Queue is enabled.</div>
                    ) : (
                      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                        {/* Column 1: Pending */}
                        <div className="flex flex-col gap-2">
                          <div className="text-[10px] font-bold uppercase tracking-widest text-zinc-500 border-b border-zinc-200 pb-1.5">
                            ⏳ Pending ({pending.length})
                          </div>
                          {pending.length === 0
                            ? <div className="text-[10px] text-zinc-400 italic py-3 text-center">None</div>
                            : pending.map((t: any) => <TaskCard key={t.post_id} task={t} />)
                          }
                        </div>

                        {/* Column 2: Processing */}
                        <div className="flex flex-col gap-2">
                          <div className="text-[10px] font-bold uppercase tracking-widest text-blue-600 border-b border-blue-200 pb-1.5">
                            ⚙️ Processing ({processing.length})
                          </div>
                          {processing.length === 0
                            ? <div className="text-[10px] text-zinc-400 italic py-3 text-center">None</div>
                            : processing.map((t: any) => <TaskCard key={t.post_id} task={t} />)
                          }
                        </div>

                        {/* Column 3: Done / Error */}
                        <div className="flex flex-col gap-2">
                          <div className="text-[10px] font-bold uppercase tracking-widest text-emerald-700 border-b border-emerald-200 pb-1.5">
                            ✅ Done / Error ({done.length})
                          </div>
                          {done.length === 0
                            ? <div className="text-[10px] text-zinc-400 italic py-3 text-center">None</div>
                            : done.map((t: any) => <TaskCard key={t.post_id} task={t} />)
                          }
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              );
            })()}


            {/* TAB: Remote Files */}
            {activeTab === "remotefiles" && (
              <div className="flex flex-col gap-6">
                <div className="bg-white border-2 border-[#1A1A1A] p-6 flex flex-col gap-4 shadow-[4px_4px_0px_#1A1A1A] rounded-none">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-[#1A1A1A] pb-4">
                    <div>
                      <h3 className="text-base font-bold font-serif italic text-[#1A1A1A]">Remote Video Files (APIs)</h3>
                      <p className="text-xs text-zinc-500 mt-1">Files currently hosted on your Byse and Doodstream accounts.</p>
                    </div>
                    <button
                      onClick={() => fetchRemoteFiles()}
                      disabled={isRemoteFilesLoading}
                      className="bg-[#1A1A1A] hover:bg-black text-white px-3 py-1.5 rounded-none text-[10px] font-sans font-bold uppercase tracking-wider flex items-center gap-2 transition-colors disabled:opacity-50"
                    >
                      <RefreshCw className={`w-3.5 h-3.5 ${isRemoteFilesLoading ? 'animate-spin' : ''}`} />
                      Refresh Lists
                    </button>
                  </div>
                  
                  {remoteFilesError && (
                    <div className="p-3 bg-red-50 border border-red-200 text-red-600 text-xs font-mono">
                      Failed to load remote files: {remoteFilesError}
                    </div>
                  )}

                  <div className="grid grid-cols-1 gap-6">
{/* Doodstream Files */}
                    <div className="flex flex-col gap-3">
                       <h4 className="font-bold text-orange-600 text-sm uppercase tracking-wider border-b border-zinc-200 pb-2 flex items-center justify-between">
                         Doodstream Files
                         <div className="flex items-center gap-2">
                           <button disabled={remoteFilesPage.dood <= 1 || isRemoteFilesLoading} onClick={() => fetchRemoteFiles('dood', remoteFilesPage.dood - 1)} className="px-1 py-0.5 bg-zinc-200 text-[#1A1A1A] disabled:opacity-50 text-[10px]">&lt;</button>
                           <span className="text-[10px] lowercase text-zinc-500">pg {remoteFilesPage.dood}/{remoteFilesTotalPages.dood}</span>
                           <button disabled={remoteFilesPage.dood >= remoteFilesTotalPages.dood || isRemoteFilesLoading} onClick={() => fetchRemoteFiles('dood', remoteFilesPage.dood + 1)} className="px-1 py-0.5 bg-zinc-200 text-[#1A1A1A] disabled:opacity-50 text-[10px]">&gt;</button>
                         </div>
                       </h4>
                       <div className="flex flex-col gap-2 max-h-[500px] overflow-y-auto pr-2">
                         {remoteFiles.dood.length === 0 ? (
                           <div className="text-xs text-zinc-500 italic py-4 text-center">No files found on Doodstream API.</div>
                         ) : (
                           remoteFiles.dood.map((file: any, idx: number) => (
                             <div key={idx} className="bg-orange-50/30 border border-orange-100 p-3 flex flex-col gap-2 hover:border-orange-300 transition-colors">
                               <div className="font-bold text-[#1A1A1A] text-xs truncate" title={file.title || file.file_code}>{file.title || file.file_code || "Unknown"}</div>
                               <div className="flex items-center justify-between">
                                 <span className="font-mono text-[9px] text-zinc-500">{file.file_code}</span>
                                 <div className="flex items-center gap-2">
                                   {file.download_url && (
                                     <a href={file.download_url} target="_blank" rel="noreferrer" className="text-[9px] font-bold uppercase bg-orange-100 px-1.5 py-0.5 text-orange-800 hover:bg-orange-500 hover:text-white transition-colors">Link</a>
                                   )}
                                 </div>
                               </div>
                             </div>
                           ))
                         )}
                       </div>
                    </div>
                  </div>
                </div>
              </div>
            )}


            {/* TAB 6: Database */}
            {activeTab === "database" && (
              <div className="flex flex-col gap-6">
                <div className="bg-white border-2 border-[#1A1A1A] p-6 flex flex-col gap-4 shadow-[4px_4px_0px_#1A1A1A] rounded-none">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-[#1A1A1A] pb-4">
                    <div>
                      <div className="flex justify-between items-center w-full">
                      <h3 className="text-base font-bold font-serif italic text-[#1A1A1A]">Supabase Remote Database</h3>
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-bold font-sans uppercase">Embed Domain Base URL:</span>
                        <input 
                          type="text" 
                          value={cfDomain} 
                          onChange={(e) => setCfDomain(e.target.value)} 
                          className="bg-white border-2 border-[#1A1A1A] px-2 py-1 text-xs font-mono w-64 shadow-[2px_2px_0px_#1A1A1A] focus:outline-none"
                          placeholder="https://apiv2.pasamaraooo49.workers.dev/embed"
                        />
                      </div>
                    </div>
                      <p className="text-xs text-zinc-500 mt-1">Unified Links stored in the central remote database.</p>
                    </div>
                    <div className="flex flex-col sm:flex-row items-center gap-2 mt-4 sm:mt-0 w-full sm:w-auto">
                      <div className="relative w-full sm:w-48">
                        <input
                          type="text"
                          placeholder="Search title, actor..."
                          value={dbSearchQuery}
                          onChange={(e) => setDbSearchQuery(e.target.value)}
                          className="w-full bg-white border border-[#1A1A1A] py-1.5 pl-8 pr-3 text-xs placeholder-zinc-400 focus:outline-none focus:ring-1 focus:ring-[#1A1A1A]"
                        />
                        <Search className="w-3.5 h-3.5 text-[#1A1A1A]/70 absolute left-2.5 top-2.5" />
                      </div>
                      <select 
                        value={dbCategoryFilter}
                        onChange={e => setDbCategoryFilter(e.target.value)}
                        className="bg-white border border-[#1A1A1A] text-[#1A1A1A] text-xs px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-[#1A1A1A]"
                      >
                        <option value="All">All Categories</option>
                        <option value="pornvoid premium">💎 Pornvoid Premium (VIP)</option>
                        <option value="onlyfans">onlyfans</option>
                        <option value="fansly">fansly</option>
                        <option value="general">general</option>
                      </select>
                      <select 
                        value={dbSort}
                        onChange={e => setDbSort(e.target.value)}
                        className="bg-white border border-[#1A1A1A] text-[#1A1A1A] text-xs px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-[#1A1A1A]"
                      >
                        <option value="newest">Newest First</option>
                        <option value="oldest">Oldest First</option>
                      </select>
                      <button
                        onClick={() => fetchDbPosts()}
                        className="bg-[#1A1A1A] hover:bg-zinc-800 text-white border-2 border-[#1A1A1A] px-3 py-1.5 text-xs font-sans font-bold uppercase tracking-wider shadow-[2px_2px_0px_#1A1A1A] flex items-center gap-1.5"
                      >
                        <RefreshCw className={`w-3.5 h-3.5 ${isDbLoading ? 'animate-spin' : ''}`} />
                        Refresh
                      </button>
                      <button
                        onClick={cleanUpDb}
                        className="bg-amber-500 hover:bg-amber-600 text-white border-2 border-[#1A1A1A] px-3 py-1.5 text-xs font-sans font-bold uppercase tracking-wider shadow-[2px_2px_0px_#1A1A1A] flex items-center gap-1.5"
                        disabled={isDbLoading}
                        title="Scan database and remove invalid/empty links"
                      >
                        <AlertCircle className={`w-3.5 h-3.5 ${isDbLoading ? 'animate-spin' : ''}`} />
                        Clean Up Tables
                      </button>
                      <button
                        onClick={reconcileDb}
                        className="bg-emerald-500 hover:bg-emerald-600 text-white border-2 border-[#1A1A1A] px-3 py-1.5 text-xs font-sans font-bold uppercase tracking-wider shadow-[2px_2px_0px_#1A1A1A] flex items-center gap-1.5"
                        disabled={isDbLoading}
                        title="Fetch DMCA and Blocked links directly from Host Providers and prune from DB"
                      >
                        <Activity className={`w-3.5 h-3.5 ${isDbLoading ? 'animate-spin' : ''}`} />
                        Reconcile Links
                      </button>
                      <button
                        onClick={() => handleSyncDbImagesToCdn(50, false)}
                        className="bg-amber-600 hover:bg-amber-700 text-white border-2 border-[#1A1A1A] px-3 py-1.5 text-xs font-sans font-bold uppercase tracking-wider shadow-[2px_2px_0px_#1A1A1A] flex items-center gap-1.5"
                        disabled={isDbLoading || isImageSyncing}
                        title="Sync thumbnails to Cloudflare R2 / CDN"
                      >
                        <UploadCloud className={`w-3.5 h-3.5 ${isImageSyncing ? 'animate-spin' : ''}`} />
                        {isImageSyncing ? 'Syncing R2...' : 'Sync R2 CDN'}
                      </button>
                      <button
                        onClick={clearDb}
                        className="bg-red-500 hover:bg-red-600 text-white border-2 border-[#1A1A1A] px-3 py-1.5 text-xs font-sans font-bold uppercase tracking-wider shadow-[2px_2px_0px_#1A1A1A] flex items-center gap-1.5 ml-auto sm:ml-0"
                        title="Delete all database records"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                        Clear
                      </button>
                    </div>
                  </div>

                  {dbError && (
                    <div className="bg-red-50 text-red-700 border border-red-200 p-3 text-xs font-mono mb-4">
                      {dbError}
                    </div>
                  )}

                  {/* Top Pagination Controls */}
                  <div className="flex flex-col sm:flex-row items-center justify-between gap-3 bg-[#FAF8F5] border-2 border-[#1A1A1A] p-3 text-xs font-mono shadow-[2px_2px_0px_#1A1A1A]">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-bold text-[#1A1A1A]">
                        Showing {dbTotalCount === 0 ? 0 : (dbPage - 1) * dbLimit + 1}–{Math.min(dbPage * dbLimit, dbTotalCount)} of {dbTotalCount} records
                      </span>
                      <span className="bg-emerald-100 text-emerald-900 border border-emerald-800 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide rounded-sm">
                        ⚡ 25 Limit / Page (Bandwidth Saved)
                      </span>
                    </div>

                    <div className="flex items-center gap-3">
                      <div className="flex items-center gap-1.5">
                        <span className="text-[11px] font-sans uppercase font-bold text-zinc-600">Per Page:</span>
                        <select
                          value={dbLimit}
                          onChange={(e) => {
                            const newLimit = parseInt(e.target.value, 10);
                            setDbLimit(newLimit);
                            setDbPage(1);
                            fetchDbPosts(1, newLimit);
                          }}
                          className="bg-white border border-[#1A1A1A] px-2 py-1 text-xs focus:outline-none"
                        >
                          <option value={25}>25</option>
                          <option value={50}>50</option>
                          <option value={100}>100</option>
                        </select>
                      </div>

                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => fetchDbPosts(1)}
                          disabled={dbPage <= 1 || isDbLoading}
                          className="p-1.5 bg-white border border-[#1A1A1A] disabled:opacity-30 disabled:cursor-not-allowed hover:bg-zinc-100 transition-colors shadow-[1px_1px_0px_#1A1A1A]"
                          title="First Page"
                        >
                          <ChevronsLeft className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => fetchDbPosts(dbPage - 1)}
                          disabled={dbPage <= 1 || isDbLoading}
                          className="p-1.5 bg-white border border-[#1A1A1A] disabled:opacity-30 disabled:cursor-not-allowed hover:bg-zinc-100 transition-colors shadow-[1px_1px_0px_#1A1A1A]"
                          title="Previous Page"
                        >
                          <ChevronLeft className="w-3.5 h-3.5" />
                        </button>

                        <span className="px-2 py-1 bg-white border border-[#1A1A1A] text-xs font-bold text-[#1A1A1A] min-w-[70px] text-center shadow-[1px_1px_0px_#1A1A1A]">
                          Page {dbPage} / {dbTotalPages}
                        </span>

                        <button
                          onClick={() => fetchDbPosts(dbPage + 1)}
                          disabled={dbPage >= dbTotalPages || isDbLoading}
                          className="p-1.5 bg-white border border-[#1A1A1A] disabled:opacity-30 disabled:cursor-not-allowed hover:bg-zinc-100 transition-colors shadow-[1px_1px_0px_#1A1A1A]"
                          title="Next Page"
                        >
                          <ChevronRight className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => fetchDbPosts(dbTotalPages)}
                          disabled={dbPage >= dbTotalPages || isDbLoading}
                          className="p-1.5 bg-white border border-[#1A1A1A] disabled:opacity-30 disabled:cursor-not-allowed hover:bg-zinc-100 transition-colors shadow-[1px_1px_0px_#1A1A1A]"
                          title="Last Page"
                        >
                          <ChevronsRight className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  </div>

                  <div className="flex flex-col gap-3">
                    {isDbLoading ? (
                       <div className="text-center p-8 font-mono text-zinc-500 text-xs">Loading database records...</div>
                    ) : filteredDbPosts.length === 0 ? (
                       <div className="text-center p-8 font-mono text-zinc-500 text-xs">No records found. Connect crawler or adjust filters.</div>
                    ) : (
                      filteredDbPosts.map((post: any, idx: number) => (
                        <div key={`${post.post_id}-${idx}`} className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 bg-[#FAF8F5] border border-zinc-200 p-3 hover:border-[#1A1A1A] transition-colors group">
                           {post.thumbnail_url && (
                             <div className="w-20 h-14 bg-zinc-200 shrink-0 border border-zinc-300 relative overflow-hidden group/thumb">
                               <img src={getProxyImageUrl(post.thumbnail_url, post.title, post.post_id)} referrerPolicy="no-referrer" onError={(e) => { (e.target as HTMLElement).style.display = 'none'; }} className="absolute inset-0 w-full h-full object-cover" />
                               <span className={`absolute bottom-0 inset-x-0 text-[8px] font-mono font-bold text-center py-0.5 uppercase ${
                                 post.thumbnail_url.includes('.workers.dev/') || post.thumbnail_url.startsWith('https://goonimage')
                                   ? 'bg-emerald-900/90 text-emerald-200' 
                                   : 'bg-amber-900/90 text-amber-200'
                               }`}>
                                 {post.thumbnail_url.includes('.workers.dev/') || post.thumbnail_url.startsWith('https://goonimage') ? 'CF R2 CDN' : 'EXTERNAL'}
                               </span>
                             </div>
                           )}
                           <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 flex-wrap">
                                <h4 className="text-xs font-bold text-[#1A1A1A] truncate">{post.title}</h4>
                                {isVidaraEmbed(post.embeds, '', post.original_url, post.categories) && (
                                  <span className="text-[9px] font-mono font-bold bg-amber-400 text-black border border-[#1A1A1A] px-1.5 py-0.2 uppercase shadow-[1px_1px_0px_#1A1A1A] flex items-center gap-1">
                                    💎 PORNVOID PREMIUM
                                  </span>
                                )}
                              </div>
                              <div className="flex flex-wrap items-center gap-2 mt-1">
                                <span className="text-[10px] font-mono text-zinc-500">ID: {post.post_id}</span>
                                {isVidaraEmbed(post.embeds, '', post.original_url, post.categories) && (
                                  <span className="text-[9px] font-mono text-amber-900 bg-amber-50 border border-amber-300 px-1.5 py-0.5 rounded-sm">
                                    slug: {post.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'video'}-pornvoid-premium
                                  </span>
                                )}
                                {post.thumbnail_url && !(post.thumbnail_url.includes('.workers.dev/') || post.thumbnail_url.startsWith('https://goonimage')) && (
                                  <button
                                    onClick={() => handleSinglePostCdnUpload(post.post_id, post.thumbnail_url)}
                                    className="text-[9px] font-mono font-bold text-amber-800 bg-amber-100 hover:bg-amber-200 border border-amber-300 px-1.5 py-0.5 rounded-sm flex items-center gap-1 transition-colors"
                                    title="Upload this thumbnail to Cloudflare R2"
                                  >
                                    <UploadCloud className="w-2.5 h-2.5" /> Sync R2
                                  </button>
                                )}
                                {post.categories && post.categories.length > 0 && post.categories.map((cat: string, idx: number) => (
                                  <span key={idx} className={`text-[10px] font-mono font-bold px-1 py-0.5 rounded-sm ${cat.toLowerCase().includes('pornvoid') ? 'bg-amber-400 text-black border border-black' : 'bg-[#1A1A1A] text-white'}`}>
                                    {cat}
                                  </span>
                                ))}
                              </div>

                              {/* Embed Badges in DB View */}
                              {post.embeds && post.embeds.length > 0 && (
                                <div className="flex flex-wrap items-center gap-1 mt-1.5">
                                  {post.embeds.map((emb: string, i: number) => {
                                    const isPlaymate = emb.toLowerCase().includes("playmate");
                                    const isVidara   = emb.toLowerCase().match(/vidara|vidaarax|vidavaca|vidaratem|vidaraw/);
                                    const isDood     = emb.toLowerCase().match(/dood|ds2play|d000d|vide0|do7go|playmogo|doodstream/);
                                    const isLulu     = emb.toLowerCase().includes("lulu");
                                    const label = isPlaymate ? "Playmate" : isVidara ? "Vidara" : isDood ? "Doodstream" : isLulu ? "Luluvid" : "Stream";
                                    const colorClass = isPlaymate ? "bg-emerald-100 text-emerald-900 border-emerald-400"
                                      : isVidara ? "bg-amber-100 text-amber-900 border-amber-400"
                                      : isDood ? "bg-blue-100 text-blue-900 border-blue-400"
                                      : isLulu ? "bg-purple-100 text-purple-900 border-purple-400"
                                      : "bg-zinc-100 text-zinc-800 border-zinc-300";

                                    return (
                                      <a
                                        key={i}
                                        href={emb}
                                        target="_blank"
                                        rel="noreferrer"
                                        className={`text-[9px] font-mono font-bold uppercase px-1.5 py-0.5 border flex items-center gap-1 hover:brightness-95 transition-all ${colorClass}`}
                                      >
                                        {isPlaymate && <span>▶</span>}
                                        {label}
                                        <ExternalLink className="w-2 h-2" />
                                      </a>
                                    );
                                  })}
                                </div>
                              )}
                           </div>
                           <div className="flex items-center gap-2 shrink-0">
                             <button
                               onClick={() => deletePost(post.post_id)}
                               className="bg-red-100 hover:bg-red-200 text-red-900 border-2 border-red-900 px-2 py-1 flex items-center gap-1 text-[10px] font-bold uppercase shadow-[2px_2px_0px_#1A1A1A] transition-colors"
                               title="Delete Post"
                             >
                               <Trash2 className="w-3 h-3" />
                             </button>
                             <button
                               onClick={() => handleCopy(`${cfDomain.replace(/\/$/, '')}/api/embed/${post.post_id}`, "API Link")}
                               className="bg-emerald-100 hover:bg-emerald-200 text-emerald-900 border-2 border-emerald-900 px-2 py-1 flex items-center gap-1 text-[10px] font-bold uppercase shadow-[2px_2px_0px_#1A1A1A] transition-colors"
                             >
                               <Code className="w-3 h-3" /> API Link
                             </button>
                             <a
                               href={`/v/${post.post_id}`}
                               target="_blank"
                               rel="noreferrer"
                               className="bg-[#1A1A1A] text-white border-2 border-[#1A1A1A] px-2 py-1 flex items-center gap-1 text-[10px] font-bold uppercase shadow-[2px_2px_0px_#FAF8F5] hover:bg-zinc-800 transition-colors"
                             >
                               <Play className="w-3 h-3" /> Unified Player
                             </a>
                           </div>
                        </div>
                      ))
                    )}
                  </div>

                  {/* Bottom Pagination Controls */}
                  {filteredDbPosts.length > 0 && (
                    <div className="flex flex-col sm:flex-row items-center justify-between gap-3 bg-[#FAF8F5] border-2 border-[#1A1A1A] p-3 text-xs font-mono shadow-[2px_2px_0px_#1A1A1A] mt-2">
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-[#1A1A1A]">
                          Page {dbPage} of {dbTotalPages} ({dbTotalCount} total items)
                        </span>
                      </div>

                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => fetchDbPosts(1)}
                          disabled={dbPage <= 1 || isDbLoading}
                          className="p-1.5 bg-white border border-[#1A1A1A] disabled:opacity-30 disabled:cursor-not-allowed hover:bg-zinc-100 transition-colors shadow-[1px_1px_0px_#1A1A1A]"
                          title="First Page"
                        >
                          <ChevronsLeft className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => fetchDbPosts(dbPage - 1)}
                          disabled={dbPage <= 1 || isDbLoading}
                          className="p-1.5 bg-white border border-[#1A1A1A] disabled:opacity-30 disabled:cursor-not-allowed hover:bg-zinc-100 transition-colors shadow-[1px_1px_0px_#1A1A1A]"
                          title="Previous Page"
                        >
                          <ChevronLeft className="w-3.5 h-3.5" />
                        </button>

                        <span className="px-3 py-1 bg-white border border-[#1A1A1A] text-xs font-bold text-[#1A1A1A] shadow-[1px_1px_0px_#1A1A1A]">
                          {dbPage}
                        </span>

                        <button
                          onClick={() => fetchDbPosts(dbPage + 1)}
                          disabled={dbPage >= dbTotalPages || isDbLoading}
                          className="p-1.5 bg-white border border-[#1A1A1A] disabled:opacity-30 disabled:cursor-not-allowed hover:bg-zinc-100 transition-colors shadow-[1px_1px_0px_#1A1A1A]"
                          title="Next Page"
                        >
                          <ChevronRight className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => fetchDbPosts(dbTotalPages)}
                          disabled={dbPage >= dbTotalPages || isDbLoading}
                          className="p-1.5 bg-white border border-[#1A1A1A] disabled:opacity-30 disabled:cursor-not-allowed hover:bg-zinc-100 transition-colors shadow-[1px_1px_0px_#1A1A1A]"
                          title="Last Page"
                        >
                          <ChevronsRight className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* TAB: Cloudflare R2 Image CDN */}
            {activeTab === "images" && (
              <div className="flex flex-col gap-6">
                
                {/* Engine Status & Overview Card */}
                <div className="bg-white border-2 border-[#1A1A1A] p-6 shadow-[4px_4px_0px_#1A1A1A]">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-[#1A1A1A] pb-4">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-xl">⚡</span>
                        <h3 className="text-base font-bold font-serif italic text-[#1A1A1A]">
                          Telegram Storage & Cloudflare Edge CDN Engine
                        </h3>
                        <span className={`text-[10px] font-mono font-bold px-2 py-0.5 border ${
                          imageWorkerStatus?.connected 
                            ? 'bg-emerald-100 text-emerald-900 border-emerald-500' 
                            : 'bg-amber-100 text-amber-900 border-amber-500'
                        }`}>
                          {imageWorkerStatus?.connected ? `ONLINE (v4.0.2 - Telegram CDN)` : 'CHECKING STATUS...'}
                        </span>
                      </div>
                      <p className="text-xs text-zinc-600 mt-1">
                        Ultra-fast Telegram Storage Archival with Cloudflare Edge Caching (GET /img/:fileId) and SSRF-hardened zero-copy proxy.
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => { fetchImageWorkerStatus(); fetchImageStats(); }}
                        className="bg-white hover:bg-zinc-50 text-[#1A1A1A] border-2 border-[#1A1A1A] px-3 py-1.5 text-xs font-mono font-bold uppercase tracking-wider shadow-[2px_2px_0px_#1A1A1A] flex items-center gap-1.5 transition-colors"
                      >
                        <RefreshCw className="w-3.5 h-3.5" />
                        Ping Engine
                      </button>
                    </div>
                  </div>

                  {/* Engine Details Bar */}
                  {imageWorkerStatus && (
                    <div className="mt-4 bg-[#FAF8F5] border border-zinc-200 p-3 text-xs font-mono grid grid-cols-2 sm:grid-cols-4 gap-3">
                      <div>
                        <span className="text-[10px] text-zinc-400 block uppercase">Edge Colo:</span>
                        <span className="font-bold text-[#1A1A1A]">{imageWorkerStatus.edge_colo || 'SIN (Singapore)'}</span>
                      </div>
                      <div>
                        <span className="text-[10px] text-zinc-400 block uppercase">RAM Cache Entries:</span>
                        <span className="font-bold text-emerald-700">{imageWorkerStatus.memory_cache_entries ?? 0} active</span>
                      </div>
                      <div>
                        <span className="text-[10px] text-zinc-400 block uppercase">Single Upload Mode:</span>
                        <span className="font-bold text-blue-700">&lt;20ms instant edge</span>
                      </div>
                      <div>
                        <span className="text-[10px] text-zinc-400 block uppercase">Batch Concurrency:</span>
                        <span className="font-bold text-purple-700">2x parallel queue</span>
                      </div>
                    </div>
                  )}

                  {/* Speed Optimizations Chips */}
                  {imageWorkerStatus?.speed_optimizations && (
                    <div className="mt-3 flex flex-wrap gap-1.5">
                      {imageWorkerStatus.speed_optimizations.map((opt: string, idx: number) => (
                        <span key={idx} className="text-[9px] font-mono bg-zinc-100 text-zinc-700 border border-zinc-300 px-2 py-0.5">
                          ✓ {opt}
                        </span>
                      ))}
                    </div>
                  )}
                </div>

                {/* Metrics Stats Grid */}
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  <div className="bg-white border-2 border-[#1A1A1A] p-4 text-center shadow-[3px_3px_0px_#1A1A1A]">
                    <div className="text-2xl font-bold font-serif text-[#1A1A1A]">{imageStats?.total ?? 0}</div>
                    <div className="text-[10px] uppercase font-bold text-zinc-500 mt-1">Total DB Posts</div>
                  </div>
                  <div className="bg-emerald-50 border-2 border-emerald-800 p-4 text-center shadow-[3px_3px_0px_#065F46]">
                    <div className="text-2xl font-bold font-serif text-emerald-800">{imageStats?.on_cloudflare_cdn ?? 0}</div>
                    <div className="text-[10px] uppercase font-bold text-emerald-700 mt-1">On Cloudflare CDN / R2</div>
                  </div>
                  <div className="bg-amber-50 border-2 border-amber-800 p-4 text-center shadow-[3px_3px_0px_#92400E]">
                    <div className="text-2xl font-bold font-serif text-amber-800">{imageStats?.external_source ?? 0}</div>
                    <div className="text-[10px] uppercase font-bold text-amber-700 mt-1">External / Unsynced</div>
                  </div>
                  <div className="bg-zinc-50 border-2 border-zinc-400 p-4 text-center shadow-[3px_3px_0px_#71717A]">
                    <div className="text-2xl font-bold font-serif text-zinc-600">{imageStats?.missing_thumbnail ?? 0}</div>
                    <div className="text-[10px] uppercase font-bold text-zinc-500 mt-1">No Thumbnail URL</div>
                  </div>
                </div>

                {/* Bulk Database Sync Tool */}
                <div className="bg-white border-2 border-[#1A1A1A] p-6 shadow-[4px_4px_0px_#1A1A1A] flex flex-col gap-4">
                  <div className="border-b border-[#1A1A1A] pb-3 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                    <div>
                      <h4 className="text-sm font-bold font-serif italic text-[#1A1A1A]">
                        🚀 Bulk Sync Supabase Thumbnails to Cloudflare R2
                      </h4>
                      <p className="text-xs text-zinc-600 mt-0.5">
                        Scrapes and uploads image bytes directly to Cloudflare R2 / Telegram Async CDN and updates the unified_posts database.
                      </p>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 items-end">
                    <div>
                      <label className="text-[10px] font-bold uppercase tracking-wider text-zinc-700 block mb-1">
                        Batch Size Limit:
                      </label>
                      <select
                        value={imageSyncLimit}
                        onChange={(e) => setImageSyncLimit(Number(e.target.value))}
                        disabled={isImageSyncing}
                        className="w-full bg-white border-2 border-[#1A1A1A] px-3 py-2 text-xs font-mono shadow-[2px_2px_0px_#1A1A1A] focus:outline-none"
                      >
                        <option value={10}>10 images (Quick test)</option>
                        <option value={25}>25 images</option>
                        <option value={50}>50 images (Recommended)</option>
                        <option value={100}>100 images</option>
                        <option value={250}>250 images</option>
                        <option value={500}>500 images</option>
                      </select>
                    </div>

                    <div className="flex items-center gap-2 pb-2">
                      <input
                        type="checkbox"
                        id="chk_force_all_images"
                        checked={imageSyncForceAll}
                        onChange={(e) => setImageSyncForceAll(e.target.checked)}
                        disabled={isImageSyncing}
                        className="w-4 h-4 accent-[#1A1A1A]"
                      />
                      <label htmlFor="chk_force_all_images" className="text-xs font-sans text-zinc-700 cursor-pointer">
                        Force re-upload all (even if already on CDN)
                      </label>
                    </div>

                    <button
                      id="btn_start_r2_sync"
                      onClick={() => handleSyncDbImagesToCdn()}
                      disabled={isImageSyncing}
                      className="w-full bg-[#1A1A1A] hover:bg-zinc-800 text-white font-bold py-2.5 px-4 rounded-none flex items-center justify-center gap-2 transition-all text-xs uppercase tracking-wider border-2 border-[#1A1A1A] shadow-[3px_3px_0px_#FDE68A] disabled:opacity-50"
                    >
                      <UploadCloud className={`w-4 h-4 ${isImageSyncing ? 'animate-spin' : ''}`} />
                      {isImageSyncing ? 'Syncing to Cloudflare...' : 'Start R2 Sync'}
                    </button>
                  </div>

                  {/* Sync Status Banner */}
                  {imageSyncLog && (
                    <div className={`p-3 border-2 border-[#1A1A1A] text-xs font-mono ${
                      imageSyncLog.startsWith('Error') 
                        ? 'bg-red-50 text-red-800' 
                        : 'bg-emerald-50 text-emerald-900'
                    }`}>
                      {imageSyncLog}
                    </div>
                  )}
                </div>

                {/* 🧹 Prune Orphaned Images & 100% Verified Telegram Backup Guard */}
                <div className="bg-white border-2 border-[#1A1A1A] p-6 shadow-[4px_4px_0px_#1A1A1A] flex flex-col gap-4">
                  <div className="border-b border-[#1A1A1A] pb-3 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                    <div>
                      <h4 className="text-sm font-bold font-serif italic text-[#1A1A1A] flex items-center gap-2">
                        <span>🧹 Prune Orphaned Images & Reclaim R2 Storage</span>
                        <span className="text-[10px] font-mono bg-emerald-100 text-emerald-900 border border-emerald-500 px-1.5 py-0.5 font-bold">100% Telegram Verification Guard</span>
                      </h4>
                      <p className="text-xs text-zinc-600 mt-0.5 leading-relaxed">
                        Cross-references live R2 bucket files against active Database records. Unlinked orphans and posts that are <strong className="text-emerald-800">100% verified in Telegram</strong> are safely pruned to keep your R2 storage minimal and free.
                      </p>
                    </div>
                  </div>

                  <div className="bg-amber-50/70 border border-amber-300 p-3 text-xs text-amber-900 font-mono flex items-start gap-2">
                    <span className="text-base leading-none">🛡️</span>
                    <div>
                      <strong>Zero Data-Loss Guarantee:</strong> Before deleting any image from R2, the system validates the Telegram <code className="bg-amber-100 px-1 py-0.5">file_id</code> directly against Telegram API. If Telegram verification is not 100% confirmed, the image is <em>kept safe in R2</em> and deletion is skipped.
                    </div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 items-end">
                    <div className="flex flex-col gap-2">
                      <label className="flex items-center gap-2 text-xs font-sans text-zinc-700 cursor-pointer">
                        <input
                          type="checkbox"
                          id="chk_auto_archive_missing"
                          checked={autoArchiveMissing}
                          onChange={(e) => setAutoArchiveMissing(e.target.checked)}
                          disabled={isPruningR2}
                          className="w-4 h-4 accent-[#1A1A1A]"
                        />
                        <span>Auto-archive missing backups to Telegram first</span>
                      </label>
                      <label className="flex items-center gap-2 text-xs font-sans text-zinc-700 cursor-pointer">
                        <input
                          type="checkbox"
                          id="chk_dry_run"
                          checked={pruneDryRun}
                          onChange={(e) => setPruneDryRun(e.target.checked)}
                          disabled={isPruningR2}
                          className="w-4 h-4 accent-[#1A1A1A]"
                        />
                        <span className="font-bold">Dry Run (Simulate safely first)</span>
                      </label>
                    </div>

                    <div className="sm:col-span-2 flex flex-col sm:flex-row gap-2">
                      <button
                        id="btn_sim_prune_r2"
                        onClick={() => handlePruneOrphanedImages(true)}
                        disabled={isPruningR2}
                        className="flex-1 bg-amber-600 hover:bg-amber-700 text-white font-bold py-2.5 px-3 rounded-none flex items-center justify-center gap-1.5 transition-all text-xs uppercase tracking-wider border-2 border-[#1A1A1A] shadow-[2px_2px_0px_#1A1A1A] disabled:opacity-50"
                      >
                        <RefreshCw className={`w-3.5 h-3.5 ${isPruningR2 && pruneDryRun ? 'animate-spin' : ''}`} />
                        {isPruningR2 && pruneDryRun ? 'Scanning...' : 'Simulate Dry Run'}
                      </button>

                      <button
                        id="btn_execute_prune_r2"
                        onClick={() => {
                          if (window.confirm("Are you sure you want to permanently prune orphaned and 100% Telegram-verified images from R2?")) {
                            handlePruneOrphanedImages(false);
                          }
                        }}
                        disabled={isPruningR2}
                        className="flex-1 bg-red-700 hover:bg-red-800 text-white font-bold py-2.5 px-3 rounded-none flex items-center justify-center gap-1.5 transition-all text-xs uppercase tracking-wider border-2 border-[#1A1A1A] shadow-[2px_2px_0px_#1A1A1A] disabled:opacity-50"
                      >
                        <Trash2 className={`w-3.5 h-3.5 ${isPruningR2 && !pruneDryRun ? 'animate-spin' : ''}`} />
                        {isPruningR2 && !pruneDryRun ? 'Pruning R2...' : 'Prune R2 Now'}
                      </button>
                    </div>
                  </div>

                  {/* Prune Results Feed */}
                  {pruneResult && (
                    <div className="bg-[#FAF8F5] border-2 border-[#1A1A1A] p-4 text-xs font-mono flex flex-col gap-3">
                      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-300 pb-2">
                        <span className="font-bold text-[#1A1A1A]">
                          {pruneResult.dry_run ? '🔍 Dry Run Simulation Summary' : '✅ Prune Execution Complete'}
                        </span>
                        <div className="flex gap-2">
                          <span className="bg-zinc-200 px-2 py-0.5">Scanned: {pruneResult.total_scanned_r2}</span>
                          <span className="bg-emerald-100 text-emerald-900 px-2 py-0.5 font-bold">100% TG Verified: {pruneResult.verified_telegram_count}</span>
                          <span className="bg-red-100 text-red-900 px-2 py-0.5 font-bold">Orphans: {pruneResult.orphaned_count}</span>
                          <span className="bg-blue-100 text-blue-900 px-2 py-0.5 font-bold">Preserved Safe: {pruneResult.unverified_preserved_count}</span>
                        </div>
                      </div>

                      {pruneResult.results && pruneResult.results.length > 0 ? (
                        <div className="max-h-48 overflow-y-auto divide-y divide-zinc-200 bg-white border border-zinc-300 p-2">
                          {pruneResult.results.map((res: any, idx: number) => {
                            let badgeClass = "bg-zinc-100 text-zinc-700";
                            if (res.status === 'verified_telegram') badgeClass = "bg-emerald-100 text-emerald-900 font-bold border-emerald-400";
                            else if (res.status === 'orphan_safe_to_delete') badgeClass = "bg-red-100 text-red-900 font-bold border-red-400";
                            else if (res.status === 'unverified_kept_safe') badgeClass = "bg-amber-100 text-amber-900 font-bold border-amber-400";

                            return (
                              <div key={idx} className="py-1.5 flex flex-col sm:flex-row sm:items-center justify-between gap-1">
                                <div className="flex items-center gap-2">
                                  <span className={`text-[9px] px-1.5 py-0.5 border ${badgeClass}`}>{res.status}</span>
                                  <span className="font-bold">{res.key}</span>
                                  {res.postId && <span className="text-zinc-400">({res.postId})</span>}
                                </div>
                                <span className="text-[10px] text-zinc-500">{res.detail}</span>
                              </div>
                            );
                          })}
                        </div>
                      ) : (
                        <div className="text-zinc-500 italic text-center py-2">
                          No orphaned or pending images found. R2 is clean!
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {/* Worker URL Configuration */}
                <div className="bg-white border-2 border-[#1A1A1A] p-6 shadow-[4px_4px_0px_#1A1A1A] flex flex-col gap-4">
                  <h4 className="text-sm font-bold font-serif italic text-[#1A1A1A]">
                    ⚙️ Cloudflare Image Worker Configuration
                  </h4>
                  <div className="flex flex-col sm:flex-row gap-3 items-stretch">
                    <input
                      type="text"
                      value={imageWorkerUrl}
                      onChange={(e) => setImageWorkerUrl(e.target.value)}
                      placeholder="https://goonimage.pasamaraooo49.workers.dev"
                      className="flex-1 bg-white border-2 border-[#1A1A1A] px-3 py-2 text-xs font-mono shadow-[2px_2px_0px_#1A1A1A] focus:outline-none"
                    />
                    <button
                      onClick={() => handleSaveImageWorkerUrl(imageWorkerUrl)}
                      className="bg-[#1A1A1A] hover:bg-zinc-800 text-white border-2 border-[#1A1A1A] px-4 py-2 text-xs font-mono font-bold uppercase tracking-wider shadow-[2px_2px_0px_#FAF8F5] shrink-0"
                    >
                      Save & Test Endpoint
                    </button>
                  </div>
                </div>

                {/* Instant Single Image Tester */}
                <div className="bg-white border-2 border-[#1A1A1A] p-6 shadow-[4px_4px_0px_#1A1A1A] flex flex-col gap-4">
                  <h4 className="text-sm font-bold font-serif italic text-[#1A1A1A]">
                    🧪 Instant Image URL Upload & Latency Test
                  </h4>
                  <div className="flex flex-col sm:flex-row gap-3">
                    <input
                      type="text"
                      value={testImageUrl}
                      onChange={(e) => setTestImageUrl(e.target.value)}
                      placeholder="Paste image URL (e.g. https://img.sxyprn.com/...)"
                      className="flex-1 bg-white border-2 border-[#1A1A1A] px-3 py-2 text-xs font-mono shadow-[2px_2px_0px_#1A1A1A] focus:outline-none"
                    />
                    <button
                      onClick={handleTestUploadImage}
                      disabled={isTestingImage || !testImageUrl}
                      className="bg-amber-600 hover:bg-amber-700 text-white border-2 border-[#1A1A1A] px-4 py-2 text-xs font-sans font-bold uppercase tracking-wider shadow-[2px_2px_0px_#1A1A1A] shrink-0 disabled:opacity-40"
                    >
                      {isTestingImage ? 'Uploading...' : 'Test Upload'}
                    </button>
                  </div>

                  {testImageResult && (
                    <div className="bg-[#FAF8F5] border border-zinc-300 p-4 flex flex-col sm:flex-row gap-4 items-start">
                      {testImageResult.cdnUrl && (
                        <div className="w-32 h-24 bg-zinc-200 border border-zinc-400 shrink-0 relative overflow-hidden">
                          <img 
                            src={testImageResult.cdnUrl} 
                            alt="Test Result" 
                            referrerPolicy="no-referrer"
                            className="w-full h-full object-cover" 
                          />
                        </div>
                      )}
                      <div className="flex-1 overflow-x-auto text-xs font-mono space-y-1">
                        <div><span className="font-bold">CDN URL:</span> <a href={testImageResult.cdnUrl} target="_blank" rel="noreferrer" className="text-blue-600 underline break-all">{testImageResult.cdnUrl}</a></div>
                        {testImageResult.proxyUrl && (
                          <div><span className="font-bold">Proxy URL:</span> <a href={testImageResult.proxyUrl} target="_blank" rel="noreferrer" className="text-emerald-700 underline break-all">{testImageResult.proxyUrl}</a></div>
                        )}
                        <pre className="text-[10px] bg-zinc-900 text-emerald-400 p-2 rounded mt-2 overflow-x-auto">
                          {JSON.stringify(testImageResult, null, 2)}
                        </pre>
                      </div>
                    </div>
                  )}
                </div>

                {/* Worker Endpoints Documentation Card */}
                <div className="bg-white border-2 border-[#1A1A1A] p-6 shadow-[4px_4px_0px_#1A1A1A] flex flex-col gap-3">
                  <h4 className="text-sm font-bold font-serif italic text-[#1A1A1A]">
                    📡 Worker API Endpoints Specifications
                  </h4>
                  <div className="text-xs font-mono divide-y divide-zinc-200">
                    <div className="py-2 flex flex-col sm:flex-row sm:justify-between gap-1">
                      <span className="font-bold text-blue-700">POST /upload</span>
                      <span className="text-zinc-600">Single image upload, returns instant edge CDN URL in &lt;20ms</span>
                    </div>
                    <div className="py-2 flex flex-col sm:flex-row sm:justify-between gap-1">
                      <span className="font-bold text-purple-700">POST /batch-upload-urls</span>
                      <span className="text-zinc-600">JSON array of URLs, drains queue with 2 parallel workers</span>
                    </div>
                    <div className="py-2 flex flex-col sm:flex-row sm:justify-between gap-1">
                      <span className="font-bold text-amber-700">POST /upload-url</span>
                      <span className="text-zinc-600">Delegates to Telegram JSON directly (zero worker RAM consumed)</span>
                    </div>
                    <div className="py-2 flex flex-col sm:flex-row sm:justify-between gap-1">
                      <span className="font-bold text-emerald-700">GET /proxy?url=:url&id=:postId</span>
                      <span className="text-zinc-600">Zero-copy streaming proxy (body.tee) with Telegram background archival</span>
                    </div>
                    <div className="py-2 flex flex-col sm:flex-row sm:justify-between gap-1">
                      <span className="font-bold text-zinc-900">GET /img/:fileId</span>
                      <span className="text-zinc-600">Direct instant edge delivery from Telegram CDN cache</span>
                    </div>
                  </div>
                </div>

              </div>
            )}

            {/* TAB 9: Extracted Links */}
            {activeTab === "links" && (
              <div className="flex flex-col gap-6">
                <div className="bg-white border-2 border-[#1A1A1A] p-6 flex flex-col gap-6 shadow-[4px_4px_0px_#1A1A1A] rounded-none">
                  <div className="flex flex-col gap-2">
                     <h3 className="text-base font-bold font-serif italic text-[#1A1A1A]">Extracted Links Summary</h3>
                     <p className="text-xs text-zinc-500">Summary of all link types extracted from the current scraped session data.</p>
                  </div>
                  
                  {(() => {
                    const dood: {url: string, title: string, id: string}[] = [];
                    const lulu: {url: string, title: string, id: string}[] = [];
                    const vidara: {url: string, title: string, id: string}[] = [];
                    const other: {url: string, title: string, id: string}[] = [];

                    scrapedData.forEach(post => {
                      const finalEmbeds = [...(post.embeds || []), ...(post.direct_link ? [post.direct_link] : [])];
                      finalEmbeds.forEach(url => {
                         const lower = url.toLowerCase();
                         const p = { url, title: post.title, id: calculatePostId(post.post_url) };
                         if (lower.match(/vidavaca\.net|vidaarax\.net|vidaarax\.com|vidaratem\.com|vidaraw\.com|vidarax\.cc|vidaraa\.cc|vidara\.so|vidara\.to/i)) vidara.push(p);
                         else if (lower.includes('lulu')) lulu.push(p);
                         else if (lower.match(/dood|ds2play|d000d|vide0|do7go|playmogo/)) dood.push(p);
                         else other.push(p);
                      });
                    });

                    return (
                      <div className="flex flex-col gap-8">
                         <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                            <div className="bg-[#FAF8F5] border border-[#1A1A1A] p-4 text-center">
                               <div className="text-2xl font-bold font-serif">{vidara.length}</div>
                               <div className="text-[10px] uppercase font-bold text-teal-700">Vidara</div>
                            </div>
                            <div className="bg-[#FAF8F5] border border-[#1A1A1A] p-4 text-center">
                               <div className="text-2xl font-bold font-serif">{dood.length}</div>
                               <div className="text-[10px] uppercase font-bold text-blue-700">Doodstream</div>
                            </div>
                            <div className="bg-[#FAF8F5] border border-[#1A1A1A] p-4 text-center">
                               <div className="text-2xl font-bold font-serif">{lulu.length}</div>
                               <div className="text-[10px] uppercase font-bold text-purple-700">Luluvid</div>
                            </div>
                            <div className="bg-[#FAF8F5] border border-[#1A1A1A] p-4 text-center">
                               <div className="text-2xl font-bold font-serif">{other.length}</div>
                               <div className="text-[10px] uppercase font-bold text-zinc-700">Other / Direct</div>
                            </div>
                         </div>
                         
                         {/* Vidara list */}
                         {vidara.length > 0 && (
                            <div className="flex flex-col gap-2">
                               <h4 className="text-xs font-bold uppercase tracking-wider text-teal-700 border-b border-zinc-200 pb-1">Vidara Links</h4>
                               <ul className="flex flex-col gap-1 max-h-64 overflow-y-auto pr-2">
                                  {vidara.map((item, i) => (
                                     <li key={i} className="text-[10px] font-mono flex flex-col md:flex-row md:items-center justify-between border-b border-zinc-100 pb-1">
                                        <a href={item.url} target="_blank" rel="noreferrer" className="text-teal-600 hover:underline truncate md:max-w-[60%]">{item.url}</a>
                                        <span className="text-zinc-400 truncate md:max-w-[35%] mt-1 md:mt-0">{item.title}</span>
                                     </li>
                                  ))}
                               </ul>
                            </div>
                         )}

                         {/* Doodstream list */}
                         {dood.length > 0 && (
                            <div className="flex flex-col gap-2">
                               <h4 className="text-xs font-bold uppercase tracking-wider text-blue-700 border-b border-zinc-200 pb-1">Doodstream Links</h4>
                               <ul className="flex flex-col gap-1 max-h-64 overflow-y-auto pr-2">
                                  {dood.map((item, i) => (
                                     <li key={i} className="text-[10px] font-mono flex flex-col md:flex-row md:items-center justify-between border-b border-zinc-100 pb-1">
                                        <a href={item.url} target="_blank" rel="noreferrer" className="text-blue-600 hover:underline truncate md:max-w-[60%]">{item.url}</a>
                                        <span className="text-zinc-400 truncate md:max-w-[35%] mt-1 md:mt-0">{item.title}</span>
                                     </li>
                                  ))}
                               </ul>
                            </div>
                         )}

                            

                         {/* Luluvid list */}
                         {lulu.length > 0 && (
                            <div className="flex flex-col gap-2">
                               <h4 className="text-xs font-bold uppercase tracking-wider text-purple-700 border-b border-zinc-200 pb-1">Luluvid Links</h4>
                               <ul className="flex flex-col gap-1 max-h-64 overflow-y-auto pr-2">
                                  {lulu.map((item, i) => (
                                     <li key={i} className="text-[10px] font-mono flex flex-col md:flex-row md:items-center justify-between border-b border-zinc-100 pb-1">
                                        <a href={item.url} target="_blank" rel="noreferrer" className="text-purple-600 hover:underline truncate md:max-w-[60%]">{item.url}</a>
                                        <span className="text-zinc-400 truncate md:max-w-[35%] mt-1 md:mt-0">{item.title}</span>
                                     </li>
                                  ))}
                               </ul>
                            </div>
                         )}

                         {/* Other list */}
                         {other.length > 0 && (
                            <div className="flex flex-col gap-2">
                               <h4 className="text-xs font-bold uppercase tracking-wider text-zinc-700 border-b border-zinc-200 pb-1">Other / Direct Links</h4>
                               <ul className="flex flex-col gap-1 max-h-64 overflow-y-auto pr-2">
                                  {other.map((item, i) => (
                                     <li key={i} className="text-[10px] font-mono flex flex-col md:flex-row md:items-center justify-between border-b border-zinc-100 pb-1">
                                        <a href={item.url} target="_blank" rel="noreferrer" className="text-zinc-600 hover:underline truncate md:max-w-[60%]">{item.url}</a>
                                        <span className="text-zinc-400 truncate md:max-w-[35%] mt-1 md:mt-0">{item.title}</span>
                                     </li>
                                  ))}
                               </ul>
                            </div>
                         )}
                      </div>
                    );
                  })()}
                </div>
              </div>
            )}

          </div>

        </div>

      </main>

      {/* Footer Area */}
      <footer className="border-t-2 border-[#1A1A1A] bg-[#FAF8F5] text-[#1A1A1A]/70 text-[10px] py-6 text-center mt-auto font-mono uppercase tracking-wider font-bold">
        <p>© 2026 SxyPrn Worker Scraper. Built as a full-stack secure API playground.</p>
      </footer>

    </div>
  );
}
