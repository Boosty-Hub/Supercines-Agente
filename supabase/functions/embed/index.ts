// Edge Function: embed
// Devuelve embeddings de 384 dims usando el modelo gte-small de Supabase AI.
// Llamada desde Next.js durante ingesta de KB y al servir consultas.
//
// POST { "inputs": ["texto 1", "texto 2", ...] }
// → 200 { "embeddings": [[...], [...]] }

const session = new Supabase.ai.Session("gte-small");

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }
  let body: { inputs?: string[] };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "invalid json" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }
  const inputs = Array.isArray(body.inputs) ? body.inputs : [];
  if (inputs.length === 0) {
    return new Response(JSON.stringify({ error: "inputs vacío" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }
  if (inputs.length > 8) {
    return new Response(JSON.stringify({ error: "máx 8 inputs por request" }), {
      status: 413,
      headers: { "content-type": "application/json" },
    });
  }

  const embeddings: number[][] = [];
  for (const text of inputs) {
    const truncated = String(text).slice(0, 8000);
    const emb = (await session.run(truncated, {
      mean_pool: true,
      normalize: true,
    })) as number[];
    embeddings.push(emb);
  }

  return new Response(JSON.stringify({ embeddings }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
});
