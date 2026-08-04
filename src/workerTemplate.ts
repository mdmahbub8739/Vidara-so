export const cfWorkerCode = `export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const pathParts = url.pathname.split('/').filter(Boolean);
    
    // Check if the URL is valid, get the last part as post ID
    const postId = pathParts[pathParts.length - 1];
    if (!postId) {
      return new Response(JSON.stringify({ error: "Invalid URL: Post ID is missing" }), { 
        status: 400,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    }

    const supabaseUrl = env.SUPABASE_URL || 'https://hcgwzoyzagmfqmlcysaq.supabase.co';
    const supabaseKey = env.SUPABASE_ANON_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhjZ3d6b3l6YWdtZnFtbGN5c2FxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM1MzI2MjEsImV4cCI6MjA5OTEwODYyMX0.BwPRoFrTXB8mb6149GjPc296dy09DxZ6Y1IqrxxyyBw";
    
    if (!supabaseKey) {
      return new Response(JSON.stringify({ error: "Server configuration error: Missing Supabase Key" }), { 
        status: 500,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    }

    try {
      // Fetch post data from Supabase REST API
      const res = await fetch(\`\${supabaseUrl}/rest/v1/unified_posts?post_id=eq.\${postId}&select=*\`, {
        headers: {
          'apikey': supabaseKey,
          'Authorization': \`Bearer \${supabaseKey}\`
        }
      });
      const data = await res.json();
      
      if (!data || !Array.isArray(data) || data.length === 0) {
        return new Response(JSON.stringify({ error: "Video not found" }), { 
          status: 404, 
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } 
        });
      }

      const post = data[0];
      const links = [];

      if (post.byse_links) links.push(...post.byse_links);
      if (post.embeds) links.push(...post.embeds);
      if (post.final_embeds) links.push(...post.final_embeds);
      if (post.cloned_vidara) links.push(...post.cloned_vidara);
      if (post.cloned_dood) links.push(...post.cloned_dood);
      if (post.byse_final_links) links.push(...post.byse_final_links);

      const uniqueLinks = Array.from(new Set(links));

      const result = {
        post_id: post.post_id,
        title: post.title,
        categories: post.categories || [],
        actors: post.actors || [],
        links: uniqueLinks
      };

      return new Response(JSON.stringify(result), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*"
        }
      });

    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*"
        }
      });
    }
  }
};
`;
