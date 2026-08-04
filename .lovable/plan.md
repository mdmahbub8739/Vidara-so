## লক্ষ্য

আপলোড করা `Sxyprn4-fixed` প্রজেক্টটাকে এই Lovable workspace-এ পুরোপুরি বসানো, চিহ্নিত useless অংশগুলো ফেলে দেয়া, এবং Render-এ deploy করার জন্য GitHub-এ push-ready অবস্থায় নিয়ে যাওয়া।

## গুরুত্বপূর্ণ সিদ্ধান্ত — Stack

এই workspace-এর template হলো **TanStack Start + Cloudflare Worker**, কিন্তু আপনার zip হলো **Vite + Express (Node)** — যেটা Render-এ চলবে। দুইটা মিশানো যাবে না। যেহেতু টার্গেট Render, template-এর TanStack shell পুরোটা সরিয়ে zip-এর original stack বসানো হবে (এটাই safest — কারণ `App.tsx` (124KB) TanStack-এ port করলে অসংখ্য bug আসতে পারে)।

## কী কী থাকবে (preserve)

Zip থেকে হুবহু আসবে:
- `src/main.tsx`, `src/index.css`, `src/workerTemplate.ts`
- `server.ts`, `helper.ts`, `vidara_patch.ts`
- `embed_template.html`, `supabase_schema.sql`, `db_schema.sql`
- `index.html`, `vite.config.ts`, `tsconfig.json`, `metadata.json`
- `assets/images/logo.svg`
- `package.json` scripts (`dev`/`build`/`start`) এবং সব dependencies

## কী কী বাদ / পরিবর্তন

**`src/App.tsx` থেকে সরানো:**
1. `Worker Code` tab পুরোটা (broken `${window.location.origin}` interpolation সহ `embedWorkerCode`)
2. `Client SDK` tab পুরোটা
3. `Difference` tab পুরোটা (Posts card-এর `dbStatus` badge already এই কাজ করছে)
4. Posts card-এর ভেতরের individual `Upload to Byse / Dood / Vidara` buttons
5. Remote Files tab-এর `Byse Upload` button
6. Related handlers: `handleUploadToByse`, `handleUploadToDood`, `handleUploadToVidara`, `embedWorkerCode` string, ClientSDK/Diff render blocks
7. Byse-সংক্রান্ত dead imports / state / helpers যেগুলো এতিম হয়ে যাবে

**Bug fix:**
8. Stats counter-এর stale closure — `setScrapedData(prev => ...)` functional form + `useMemo`/derived count দিয়ে counter সবসময় fresh রাখা

**Deploy-এর জন্য minor edit (`server.ts`):**
9. Render inject করা `process.env.PORT` respect হচ্ছে কিনা confirm/fix
10. Production-এ Vite-এর `dist/` static serve করার path ঠিক আছে কিনা check

**রাখা tabs (unchanged):** Posts, Queue, Remote Files, Supabase DB, Raw JSON, Extracted Links.

**Repo hygiene — বাদ:** `patch.py`, `test_rename.mjs`, `test_target.txt`, `temp_html.txt`, `vidara_patch.ts` (already merged? check), `package-lock.json` (bun ব্যবহার হলে) — আপনি বললে রাখবো।

**Repo hygiene — যোগ:**
- `.gitignore` (node_modules, dist, .env, .env.local)
- `render.yaml` (optional — Render service config auto-detect করার জন্য)
- `.env.example` থেকে leaked Supabase anon key সরিয়ে placeholder

## GitHub + Render ধাপ (কাজ শেষে)

কোড ready হওয়ার পরে GitHub connection **আপনাকেই** করতে হবে (আমি tool দিয়ে repo create করতে পারি না, security-এর জন্য):

1. Chat input-এর **+ menu → GitHub → Connect project → Create Repository** — Lovable আপনার code সেই repo-তে push করে দেবে (two-way sync)।
2. Render Dashboard → **New → Web Service** → সেই GitHub repo সিলেক্ট।
3. Settings:
   - Build: `npm install && npm run build`
   - Start: `npm start`
   - Node version: `20`
4. Environment variables যোগ করবেন (`.env.example` অনুযায়ী): `GEMINI_API_KEY`, `BYSE_API_KEY`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `APP_URL`, `DOODSTREAM_API_KEY`, `VIDARA_API_KEY`।
5. Supabase SQL editor-এ `supabase_schema.sql` একবার run করবেন।

## Technical Notes (dev-only)

- Template-এর `src/routes/`, `src/router.tsx`, `src/start.ts`, `src/server.ts`, `src/routeTree.gen.ts`, `AGENTS.md`, `components.json`, `eslint.config.js`, `bunfig.toml`, `.prettier*`, `src/lib/*`, `src/hooks/*`, `src/styles.css`, template-এর `package.json` — সব সরানো হবে।
- Lovable Cloud এই প্রজেক্টে ব্যবহৃত হবে না (আপনার নিজস্ব Supabase ইতোমধ্যে wire করা আছে zip-এ)।
- `App.tsx` (124KB) থেকে tab-গুলো সরানো হবে exact string boundary ধরে (JSX block-by-block), তারপর orphan symbols/imports সরানো হবে।
- `bun` ব্যবহার হবে dev-এ; `package-lock.json` না রেখে `bun.lock` থাকবে। Render `npm install` তবু কাজ করবে কারণ npm lockfile না পেলে `package.json` থেকে resolve করে।

## Approval-এর আগে ২টা প্রশ্ন

1. **package manager:** Render-এ `npm install` না `bun install`? (default: npm — Render-এর native support ভালো)
2. **`.env.example` leaked Supabase anon key:** placeholder করে দেবো, নাকি এখনকার মতোই রাখবো?

Approve করলে সঙ্গে সঙ্গে টেমপ্লেট cleanup + zip import + App.tsx surgery + server.ts port check — সব করে ফেলবো, তারপর আপনি GitHub connect করে Render-এ ছেড়ে দেবেন।