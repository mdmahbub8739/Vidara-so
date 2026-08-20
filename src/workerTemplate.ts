export const cfWorkerCode = `export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, HEAD, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, If-None-Match, X-Post-Id, X-Auth-Key",
      "Access-Control-Expose-Headers": "ETag, Content-Length, Content-Type"
    };

    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const TELEGRAM_BOT_TOKEN = env.TELEGRAM_BOT_TOKEN || "8947409354:AAHFQfR1Tyy9BBDS383fA6v0kOS3GNifTt0";
    const TELEGRAM_CHAT_ID = env.TELEGRAM_CHAT_ID || "-1004390909964";
    const SUPABASE_URL = env.SUPABASE_URL || "https://hcgwzoyzagmfqmlcysaq.supabase.co";
    const SUPABASE_KEY = env.SUPABASE_ANON_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhjZ3d6b3l6YWdtZnFtbGN5c2FxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM1MzI2MjEsImV4cCI6MjA5OTEwODYyMX0.BwPRoFrTXB8mb6149GjPc296dy09DxZ6Y1IqrxxyyBw";

    // ──────────────────────────────────────────────────────────────────────────
    // HEALTH & API OVERVIEW (GET /)
    // ──────────────────────────────────────────────────────────────────────────
    if (path === "/" || path === "/health") {
      return new Response(JSON.stringify({
        status: "healthy",
        service: "million-scale-image-engine",
        version: "4.0.2",
        security: "ssrf-hardened-anti-abuse",
        endpoints: {
          delivery: "GET /img/:fileId",
          onDemandProxy: "GET /proxy?url=:url&id=:postId",
          directUpload: "POST /upload (multipart 'file' or 'image')",
          urlUpload: "POST /upload-url (json { url, post_id })",
          videoEmbed: "GET /:postId"
        }
      }), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    }

    // ──────────────────────────────────────────────────────────────────────────
    // ১. DIRECT FAST DELIVERY FROM TELEGRAM (/img/:fileId)
    // ──────────────────────────────────────────────────────────────────────────
    if (path.startsWith("/img/") || path.startsWith("/image/")) {
      const parts = path.split("/").filter(Boolean);
      const fileId = parts[parts.length - 1];

      if (!fileId) {
        return new Response(JSON.stringify({ error: "Missing image file ID" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      }

      const etag = \`"tg-\${fileId.slice(-24)}"\`;
      const ifNoneMatch = request.headers.get("If-None-Match");
      if (ifNoneMatch && (ifNoneMatch === etag || ifNoneMatch === "*" || ifNoneMatch.includes(etag))) {
        return new Response(null, {
          status: 304,
          headers: {
            ...corsHeaders,
            "ETag": etag,
            "Cache-Control": "public, max-age=31536000, immutable"
          }
        });
      }

      const cache = caches.default;
      const cacheKey = new Request(url.toString(), { method: "GET" });
      let cachedResponse = await cache.match(cacheKey);

      if (cachedResponse) {
        if (method === "HEAD") {
          return new Response(null, { status: 200, headers: cachedResponse.headers });
        }
        return cachedResponse;
      }

      try {
        const getFileRes = await fetch(\`https://api.telegram.org/bot\${TELEGRAM_BOT_TOKEN}/getFile?file_id=\${fileId}\`, {
          cf: { cacheEverything: true, cacheTtl: 31536000 }
        });
        const fileData = await getFileRes.json();

        if (!fileData.ok || !fileData.result?.file_path) {
          return new Response(JSON.stringify({ error: "Image not found on storage" }), {
            status: 404,
            headers: {
              "Content-Type": "application/json",
              "Cache-Control": "no-cache, no-store, must-revalidate",
              ...corsHeaders
            }
          });
        }

        const telegramFileUrl = \`https://api.telegram.org/file/bot\${TELEGRAM_BOT_TOKEN}/\${fileData.result.file_path}\`;
        const imageRes = await fetch(telegramFileUrl, {
          cf: { cacheEverything: true, cacheTtl: 31536000 }
        });

        if (!imageRes.ok) {
          return new Response(JSON.stringify({ error: "Storage fetch failed", status: imageRes.status }), {
            status: 502,
            headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...corsHeaders }
          });
        }

        const filePath = (fileData.result?.file_path || "").toLowerCase();
        let contentType = "image/jpeg";
        if (filePath.endsWith(".webp")) contentType = "image/webp";
        else if (filePath.endsWith(".png")) contentType = "image/png";
        else if (filePath.endsWith(".gif")) contentType = "image/gif";
        else if (filePath.endsWith(".jpg") || filePath.endsWith(".jpeg")) contentType = "image/jpeg";

        const contentLength = imageRes.headers.get("content-length") || String(fileData.result.file_size || "");

        const headers = new Headers({
          ...corsHeaders,
          "Content-Type": contentType,
          "Content-Disposition": "inline",
          "ETag": etag,
          "Cache-Control": "public, max-age=31536000, immutable",
          "CDN-Cache-Control": "max-age=31536000",
          "Cloudflare-CDN-Cache-Control": "max-age=31536000"
        });

        if (contentLength) headers.set("Content-Length", contentLength);

        const edgeResponse = new Response(imageRes.body, {
          status: 200,
          headers
        });

        ctx.waitUntil(cache.put(cacheKey, edgeResponse.clone()));

        if (method === "HEAD") {
          return new Response(null, { status: 200, headers });
        }

        return edgeResponse;
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message || "CDN Gateway Error" }), {
          status: 500,
          headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...corsHeaders }
        });
      }
    }

    // ──────────────────────────────────────────────────────────────────────────
    // ২. DIRECT BINARY / MULTIPART UPLOAD (POST /upload)
    // ──────────────────────────────────────────────────────────────────────────
    if (method === "POST" && (path === "/upload" || path === "/api/upload")) {
      try {
        const contentTypeHeader = request.headers.get("content-type") || "";
        let fileBlob = null;
        let postId = url.searchParams.get("id") || url.searchParams.get("post_id") || request.headers.get("X-Post-Id") || "";

        if (contentTypeHeader.includes("multipart/form-data")) {
          const formData = await request.formData();
          fileBlob = formData.get("file") || formData.get("image") || formData.get("photo");
          if (formData.get("post_id")) postId = String(formData.get("post_id"));
        } else {
          fileBlob = await request.blob();
        }

        if (!fileBlob || (typeof fileBlob === "string")) {
          return new Response(JSON.stringify({ error: "No valid image file uploaded" }), {
            status: 400,
            headers: { "Content-Type": "application/json", ...corsHeaders }
          });
        }

        const tgFormData = new FormData();
        tgFormData.append("chat_id", TELEGRAM_CHAT_ID);
        tgFormData.append("photo", fileBlob, "upload.jpg");
        if (postId) tgFormData.append("caption", \`ID: \${postId}\`);

        const tgRes = await fetch(\`https://api.telegram.org/bot\${TELEGRAM_BOT_TOKEN}/sendPhoto\`, {
          method: "POST",
          body: tgFormData
        });
        const tgData = await tgRes.json();

        if (!tgData.ok || !tgData.result?.photo) {
          return new Response(JSON.stringify({ error: "Telegram upload failed", details: tgData }), {
            status: 502,
            headers: { "Content-Type": "application/json", ...corsHeaders }
          });
        }

        const photos = tgData.result.photo;
        const bestPhoto = photos[photos.length - 1];
        const fileId = bestPhoto.file_id;
        const publicUrl = \`\${url.origin}/img/\${fileId}\`;

        if (postId && SUPABASE_URL && SUPABASE_KEY) {
          ctx.waitUntil(fetch(\`\${SUPABASE_URL}/rest/v1/unified_posts?post_id=eq.\${postId}\`, {
            method: "PATCH",
            headers: {
              "apikey": SUPABASE_KEY,
              "Authorization": \`Bearer \${SUPABASE_KEY}\`,
              "Content-Type": "application/json",
              "Prefer": "return=minimal"
            },
            body: JSON.stringify({ telegram_file_id: fileId, thumbnail_url: publicUrl })
          }));
        }

        return new Response(JSON.stringify({
          ok: true,
          file_id: fileId,
          url: publicUrl,
          width: bestPhoto.width,
          height: bestPhoto.height,
          file_size: bestPhoto.file_size
        }), {
          status: 200,
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message || "Upload processing error" }), {
          status: 500,
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      }
    }

    // ──────────────────────────────────────────────────────────────────────────
    // ৩. UPLOAD VIA URL (POST /upload-url)
    // ──────────────────────────────────────────────────────────────────────────
    if (method === "POST" && (path === "/upload-url" || path === "/api/upload-url")) {
      try {
        const body = await request.json();
        const targetUrl = body.url || body.image_url;
        const postId = body.post_id || body.id || "";

        if (!targetUrl) {
          return new Response(JSON.stringify({ error: "Missing 'url' in JSON body" }), {
            status: 400,
            headers: { "Content-Type": "application/json", ...corsHeaders }
          });
        }

        const sourceRes = await fetch(targetUrl, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
            "Referer": new URL(targetUrl).origin
          }
        });

        if (!sourceRes.ok) {
          return new Response(JSON.stringify({ error: "Failed to download image from source URL" }), {
            status: 502,
            headers: { "Content-Type": "application/json", ...corsHeaders }
          });
        }

        const imageBlob = await sourceRes.blob();
        const tgFormData = new FormData();
        tgFormData.append("chat_id", TELEGRAM_CHAT_ID);
        tgFormData.append("photo", imageBlob, "image.jpg");
        if (postId) tgFormData.append("caption", \`ID: \${postId}\`);

        const tgRes = await fetch(\`https://api.telegram.org/bot\${TELEGRAM_BOT_TOKEN}/sendPhoto\`, {
          method: "POST",
          body: tgFormData
        });
        const tgData = await tgRes.json();

        if (!tgData.ok || !tgData.result?.photo) {
          return new Response(JSON.stringify({ error: "Telegram archival failed", details: tgData }), {
            status: 502,
            headers: { "Content-Type": "application/json", ...corsHeaders }
          });
        }

        const photos = tgData.result.photo;
        const bestPhoto = photos[photos.length - 1];
        const fileId = bestPhoto.file_id;
        const publicUrl = \`\${url.origin}/img/\${fileId}\`;

        if (postId && SUPABASE_URL && SUPABASE_KEY) {
          ctx.waitUntil(fetch(\`\${SUPABASE_URL}/rest/v1/unified_posts?post_id=eq.\${postId}\`, {
            method: "PATCH",
            headers: {
              "apikey": SUPABASE_KEY,
              "Authorization": \`Bearer \${SUPABASE_KEY}\`,
              "Content-Type": "application/json",
              "Prefer": "return=minimal"
            },
            body: JSON.stringify({ telegram_file_id: fileId, thumbnail_url: publicUrl })
          }));
        }

        return new Response(JSON.stringify({
          ok: true,
          file_id: fileId,
          url: publicUrl,
          width: bestPhoto.width,
          height: bestPhoto.height
        }), {
          status: 200,
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message || "Failed to process URL upload" }), {
          status: 500,
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      }
    }

    // ──────────────────────────────────────────────────────────────────────────
    // ৪. ON-DEMAND PROXY & AUTO-ARCHIVE WITH ABUSE & SSRF PROTECTION (GET /proxy)
    // ──────────────────────────────────────────────────────────────────────────
    if (path === "/proxy" || path === "/auto" || path === "/p") {
      let targetUrl = url.searchParams.get("url") || url.searchParams.get("src") || "";
      const postId = url.searchParams.get("id") || url.searchParams.get("post_id") || "";

      if (!targetUrl) {
        return new Response(JSON.stringify({ error: "Missing image 'url' parameter" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      }

      if (targetUrl.startsWith("http%3A") || targetUrl.startsWith("https%3A")) {
        try { targetUrl = decodeURIComponent(targetUrl); } catch (_) {}
      }

      let parsedTarget;
      try {
        parsedTarget = new URL(targetUrl);
      } catch (_) {
        return new Response(JSON.stringify({ error: "Invalid image URL format" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      }

      const protocol = parsedTarget.protocol.toLowerCase();
      const hostname = parsedTarget.hostname.toLowerCase();

      if (protocol !== "http:" && protocol !== "https:") {
        return new Response(JSON.stringify({ error: "Only HTTP and HTTPS protocols are allowed" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      }

      const isPrivateOrInternal = (
        hostname === "localhost" ||
        hostname === "127.0.0.1" ||
        hostname === "0.0.0.0" ||
        hostname === "::1" ||
        hostname === "169.254.169.254" ||
        hostname.startsWith("10.") ||
        hostname.startsWith("192.168.") ||
        hostname.startsWith("172.16.") ||
        hostname.startsWith("172.17.") ||
        hostname.startsWith("172.18.") ||
        hostname.startsWith("172.19.") ||
        hostname.startsWith("172.2") ||
        hostname.startsWith("172.3") ||
        hostname.endsWith(".internal") ||
        hostname.endsWith(".local") ||
        hostname.endsWith(".lan") ||
        hostname.endsWith(".home")
      );

      if (isPrivateOrInternal) {
        return new Response(JSON.stringify({ error: "Access to private or internal networks is strictly forbidden" }), {
          status: 403,
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      }

      const cache = caches.default;
      const cacheKey = new Request(url.toString(), { method: "GET" });
      let cachedResponse = await cache.match(cacheKey);

      if (cachedResponse) {
        if (method === "HEAD") {
          return new Response(null, { status: 200, headers: cachedResponse.headers });
        }
        return cachedResponse;
      }

      try {
        const sourceRes = await fetch(targetUrl, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
            "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
            "Referer": parsedTarget.origin
          },
          cf: { cacheEverything: true, cacheTtl: 31536000 }
        });

        if (!sourceRes.ok) {
          return new Response(JSON.stringify({ error: "Failed to fetch source image", status: sourceRes.status }), {
            status: 502,
            headers: { "Content-Type": "application/json", ...corsHeaders }
          });
        }

        const rawType = (sourceRes.headers.get("content-type") || "").toLowerCase();
        const isImageMime = (
          rawType.startsWith("image/") ||
          rawType.includes("octet-stream") ||
          targetUrl.match(/\\.(jpg|jpeg|png|webp|gif|avif|bmp|svg)/i)
        );

        if (!isImageMime && rawType.includes("text/html")) {
          return new Response(JSON.stringify({ error: "Target URL did not return an image" }), {
            status: 415,
            headers: { "Content-Type": "application/json", ...corsHeaders }
          });
        }

        const contentLengthHeader = parseInt(sourceRes.headers.get("content-length") || "0", 10);
        if (contentLengthHeader > 26214400) {
          return new Response(JSON.stringify({ error: "Image file exceeds size limit (25MB)" }), {
            status: 413,
            headers: { "Content-Type": "application/json", ...corsHeaders }
          });
        }

        let contentType = "image/jpeg";
        if (rawType.includes("webp") || targetUrl.includes(".webp")) contentType = "image/webp";
        else if (rawType.includes("png") || targetUrl.includes(".png")) contentType = "image/png";
        else if (rawType.includes("gif") || targetUrl.includes(".gif")) contentType = "image/gif";
        else if (rawType.includes("jpeg") || rawType.includes("jpg") || targetUrl.includes(".jpg") || targetUrl.includes(".jpeg")) contentType = "image/jpeg";

        const imageBuffer = await sourceRes.arrayBuffer();

        const headers = new Headers({
          ...corsHeaders,
          "Content-Type": contentType,
          "Content-Disposition": "inline",
          "Cache-Control": "public, max-age=31536000, immutable",
          "CDN-Cache-Control": "max-age=31536000",
          "Cloudflare-CDN-Cache-Control": "max-age=31536000"
        });

        const edgeResponse = new Response(imageBuffer, {
          status: 200,
          headers
        });

        ctx.waitUntil(cache.put(cacheKey, edgeResponse.clone()));

        // Background Auto-Archiving to Telegram (Non-blocking)
        ctx.waitUntil((async () => {
          try {
            const formData = new FormData();
            formData.append("chat_id", TELEGRAM_CHAT_ID);
            const blob = new Blob([imageBuffer], { type: contentType });
            formData.append("photo", blob, "image.jpg");
            if (postId) formData.append("caption", \`ID: \${postId}\`);

            const tgRes = await fetch(\`https://api.telegram.org/bot\${TELEGRAM_BOT_TOKEN}/sendPhoto\`, {
              method: "POST",
              body: formData
            });
            const tgData = await tgRes.json();

            if (tgData.ok && tgData.result?.photo && postId && SUPABASE_URL && SUPABASE_KEY) {
              const photos = tgData.result.photo;
              const bestPhoto = photos[photos.length - 1];
              const fileId = bestPhoto.file_id;

              await fetch(\`\${SUPABASE_URL}/rest/v1/unified_posts?post_id=eq.\${postId}\`, {
                method: "PATCH",
                headers: {
                  "apikey": SUPABASE_KEY,
                  "Authorization": \`Bearer \${SUPABASE_KEY}\`,
                  "Content-Type": "application/json",
                  "Prefer": "return=minimal"
                },
                body: JSON.stringify({ telegram_file_id: fileId, thumbnail_url: \`\${url.origin}/img/\${fileId}\` })
              });
            }
          } catch (_) {}
        })());

        return edgeResponse;
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message || "Proxy bridge error" }), {
          status: 500,
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      }
    }

    // ──────────────────────────────────────────────────────────────────────────
    // ৫. CACHED VIDEO METADATA & EMBED ROUTING (/:postId)
    // ──────────────────────────────────────────────────────────────────────────
    const pathParts = path.split("/").filter(Boolean);
    const postId = pathParts[pathParts.length - 1];

    if (!postId) {
      return new Response(JSON.stringify({ error: "Post ID is required" }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    }

    const postCacheKey = new Request(\`\${url.origin}/api/cached-embed/\${postId}\`, { method: "GET" });
    const cache = caches.default;
    const cachedPost = await cache.match(postCacheKey);
    if (cachedPost) {
      return cachedPost;
    }

    try {
      const res = await fetch(\`\${SUPABASE_URL}/rest/v1/unified_posts?post_id=eq.\${postId}&select=*\`, {
        headers: {
          "apikey": SUPABASE_KEY,
          "Authorization": \`Bearer \${SUPABASE_KEY}\`
        },
        cf: { cacheEverything: true, cacheTtl: 300 }
      });
      const data = await res.json();

      if (!data || !Array.isArray(data) || data.length === 0) {
        return new Response(JSON.stringify({ error: "Video not found", post_id: postId }), {
          status: 404,
          headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=60", ...corsHeaders }
        });
      }

      const post = data[0];
      const links = [];

      if (Array.isArray(post.byse_links)) links.push(...post.byse_links);
      if (Array.isArray(post.embeds)) links.push(...post.embeds);
      if (Array.isArray(post.final_embeds)) links.push(...post.final_embeds);
      if (Array.isArray(post.cloned_vidara)) links.push(...post.cloned_vidara);
      if (Array.isArray(post.cloned_dood)) links.push(...post.cloned_dood);
      if (Array.isArray(post.byse_final_links)) links.push(...post.byse_final_links);

      const uniqueLinks = Array.from(new Set(links.filter(l => l && typeof l === "string" && l.trim().length > 0)));

      let thumbnail = post.thumbnail_url || "";
      if (post.telegram_file_id) {
        thumbnail = \`\${url.origin}/img/\${post.telegram_file_id}\`;
      } else if (thumbnail) {
        thumbnail = \`\${url.origin}/proxy?url=\${encodeURIComponent(thumbnail)}&id=\${post.post_id}\`;
      }

      const result = {
        post_id: post.post_id,
        title: post.title || "Untitled",
        categories: post.categories || [],
        actors: post.actors || [],
        thumbnail,
        telegram_file_id: post.telegram_file_id || null,
        links: uniqueLinks,
        updated_at: post.updated_at || post.created_at || new Date().toISOString()
      };

      const jsonResponse = new Response(JSON.stringify(result), {
        status: 200,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "public, max-age=300, s-maxage=600, stale-while-revalidate=86400",
          ...corsHeaders
        }
      });

      ctx.waitUntil(cache.put(postCacheKey, jsonResponse.clone()));
      return jsonResponse;
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message || "Failed to load video metadata" }), {
        status: 500,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...corsHeaders }
      });
    }
  }
};
`;

