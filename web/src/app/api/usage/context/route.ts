import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { configValues } from "@/lib/runtime-config";
import { listMemories } from "@/lib/anthropic-managed";

export const runtime = "nodejs";
export const maxDuration = 60;

// ≈4 bytes por token en español — estimación, etiquetada como tal en la UI.
const BYTES_PER_TOKEN = 4;

// GET /api/usage/context — composición REAL del contexto que cada sesión
// monta: system prompt + master store (voz/kb/dreams) + memoria por lead.
// 100% dinámico: lee los stores del deployment actual, sirve para cualquier
// cliente/agente que se monte con este template.
export async function GET() {
  const authClient = createSupabaseServerClient();
  const { data: { user } } = await authClient.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const cfg = await configValues([
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_MEMORY_MASTER_ID",
    "ANTHROPIC_MEMORY_LEADS_ID",
    "SYSTEM_PROMPT",
  ]);
  if (!cfg.ANTHROPIC_API_KEY || !cfg.ANTHROPIC_MEMORY_MASTER_ID || !cfg.ANTHROPIC_MEMORY_LEADS_ID) {
    return NextResponse.json({ ok: false, error: "Faltan credenciales de Anthropic o IDs de Memory Stores en la configuración." }, { status: 400 });
  }

  try {
    const [master, leads] = await Promise.all([
      listMemories(cfg.ANTHROPIC_API_KEY, cfg.ANTHROPIC_MEMORY_MASTER_ID, undefined, 1000),
      listMemories(cfg.ANTHROPIC_API_KEY, cfg.ANTHROPIC_MEMORY_LEADS_ID, undefined, 2000),
    ]);

    // Master por prefijo raíz (/voice, /kb, /dreams, /dreams-pending, …)
    const byPrefix = new Map<string, { files: number; bytes: number }>();
    for (const m of master) {
      const pfx = "/" + m.path.replace(/^\/+/, "").split("/")[0];
      const e = byPrefix.get(pfx) ?? { files: 0, bytes: 0 };
      e.files += 1;
      e.bytes += m.content_size_bytes ?? 0;
      byPrefix.set(pfx, e);
    }

    // Leads por carpeta (un lead = un directorio)
    const byLead = new Map<string, number>();
    for (const m of leads) {
      const lead = m.path.replace(/^\/+/, "").split("/")[0];
      byLead.set(lead, (byLead.get(lead) ?? 0) + (m.content_size_bytes ?? 0));
    }
    const leadSizes = Array.from(byLead.values()).sort((a, b) => b - a);
    const leadsTotal = leadSizes.reduce((s, v) => s + v, 0);

    const promptChars = (cfg.SYSTEM_PROMPT ?? "").length;

    return NextResponse.json({
      ok: true,
      promptTokens: Math.round(promptChars / BYTES_PER_TOKEN),
      master: Array.from(byPrefix.entries())
        .map(([prefix, e]) => ({
          prefix,
          files: e.files,
          tokens: Math.round(e.bytes / BYTES_PER_TOKEN),
          // /dreams-pending NO lo lee el agente: no cuesta nada en sesión.
          readByAgent: prefix !== "/dreams-pending",
        }))
        .sort((a, b) => b.tokens - a.tokens),
      leads: {
        count: byLead.size,
        avgTokens: byLead.size > 0 ? Math.round(leadsTotal / byLead.size / BYTES_PER_TOKEN) : 0,
        maxTokens: leadSizes.length > 0 ? Math.round(leadSizes[0] / BYTES_PER_TOKEN) : 0,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: msg }, { status: 502 });
  }
}
