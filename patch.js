const fs = require('fs');
let code = fs.readFileSync('server.ts', 'utf8');
const start = code.indexOf('async function cloneEmbedVerified(url: string, taskLog: (m: string) => void): Promise<string | null> {');
const end = code.indexOf('return null;\n}', start) + 'return null;\n}'.length;

if (start !== -1 && end !== -1 && end > start) {
  const newCode = code.substring(0, start) + `async function cloneEmbedVerified(url: string, taskLog: (m: string) => void): Promise<string | null> {
  taskLog(\`[Bypass Clone] Returning original URL without external API call: \${url}\`);
  return url;
}` + code.substring(end);
  fs.writeFileSync('server.ts', newCode, 'utf8');
  console.log('patched');
} else {
  console.log('not found');
}
