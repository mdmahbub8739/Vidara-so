const fs = require('fs');
let content = fs.readFileSync('server.ts', 'utf-8');

const startIndex = content.indexOf('  app.get(["/api/proxy-image"');
const endIndex = content.indexOf('  // ── Thumbnail Resolution', startIndex);

if (startIndex === -1 || endIndex === -1) {
    console.error("Could not find bounds", startIndex, endIndex);
    process.exit(1);
}

const newProxy = `  app.get(["/api/proxy-image", "/api/proxy/image"], async (req, res) => {
    try {
      const rawUrl = (req.query.url || req.query.src) as string;
      const title = (req.query.title as string) || "Video";
      if (!rawUrl) return res.status(400).send("url parameter required");

      let targetUrl = rawUrl.trim();
      if (targetUrl.startsWith("//")) targetUrl = \`https:\${targetUrl}\`;
      else if (targetUrl !== 'unavailable' && !targetUrl.startsWith("http://") && !targetUrl.startsWith("https://")) {
        targetUrl = \`https://sxyprn.com/\${targetUrl.replace(/^\\//, '')}\`;
      }

      const sendFallback = () => {
        let hash = 0;
        for (let i = 0; i < targetUrl.length; i++) hash = targetUrl.charCodeAt(i) + ((hash << 5) - hash);
        const hue1 = Math.abs(hash) % 360;
        const hue2 = (hue1 + 40 + Math.abs(hash >> 8) % 80) % 360;
        
        const displayTitle = title ? title.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').substring(0, 40) + (title.length > 40 ? '...' : '') : 'Video Unavailable';

        const svg = \`<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180" viewBox="0 0 320 180">
            <defs>
              <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stop-color="hsl(\${hue1}, 30%, 15%)" />
                <stop offset="100%" stop-color="hsl(\${hue2}, 40%, 5%)" />
              </linearGradient>
              <pattern id="grid" width="20" height="20" patternUnits="userSpaceOnUse">
                <path d="M 20 0 L 0 0 0 20" fill="none" stroke="rgba(255,255,255,0.03)" stroke-width="1"/>
              </pattern>
            </defs>
            <rect width="320" height="180" fill="url(#bg)"/>
            <rect width="320" height="180" fill="url(#grid)"/>
            <circle cx="160" cy="70" r="24" fill="none" stroke="rgba(255,255,255,0.15)" stroke-width="2" />
            <path d="M154 60 L170 70 L154 80 Z" fill="rgba(255,255,255,0.3)" />
            <text x="160" y="120" dominant-baseline="middle" text-anchor="middle" fill="#F4F4F5" font-family="system-ui, sans-serif" font-weight="600" font-size="13" letter-spacing="0.5">\${displayTitle}</text>
            <text x="160" y="142" dominant-baseline="middle" text-anchor="middle" fill="#A1A1AA" font-family="monospace" font-size="9" letter-spacing="1">SOURCE UNREACHABLE</text>
          </svg>\`;
        
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
      return res.status(200).send(\`<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#1A1A1A"/><text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" fill="#A1A1AA" font-family="monospace" font-size="12">ERROR</text></svg>\`);
    }
  });

`;

content = content.substring(0, startIndex) + newProxy + content.substring(endIndex);
fs.writeFileSync('server.ts', content);
