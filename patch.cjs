const fs = require('fs');
let content = fs.readFileSync('server.ts', 'utf-8');

const target1 = `  app.get("/api/thumbnail", async (req, res) => {
    try {
      const url = req.query.url as string;
      if (!url) return res.status(400).json({ error: "url parameter is required" });`;
const repl1 = `  app.get("/api/thumbnail", async (req, res) => {
    try {
      const url = req.query.url as string;
      const title = (req.query.title as string) || "";
      if (!url) return res.status(400).json({ error: "url parameter is required" });`;
content = content.replace(target1, repl1);

const target2 = `        const img = r?.result?.[0]?.splash_img || r?.result?.[0]?.single_img;
        if (img) return res.redirect(\`/api/proxy-image?url=\${encodeURIComponent(img)}\`);
        return res.status(404).json({ error: "Thumbnail not found" });`;
const repl2 = `        const img = r?.result?.[0]?.splash_img || r?.result?.[0]?.single_img;
        if (img) return res.redirect(\`/api/proxy-image?url=\${encodeURIComponent(img)}&title=\${encodeURIComponent(title)}\`);
        return res.redirect(\`/api/proxy-image?url=unavailable&title=\${encodeURIComponent(title)}\`);`;
content = content.replace(target2, repl2);

fs.writeFileSync('server.ts', content);
