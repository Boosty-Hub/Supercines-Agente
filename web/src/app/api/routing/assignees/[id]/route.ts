import { NextResponse } from "next/server";
import { requireScope } from "@/lib/auth/require-scope";
import { parseTerms } from "@/lib/routing";
import { z } from "zod";
import { readJson } from "@/lib/api/body";

const AssigneePatchBody = z.object({
  display_name: z.string().nullable().optional(),
  match_terms: z.union([z.string(), z.array(z.unknown())]).optional(),
  enabled: z.boolean().optional(),
  sort_order: z.number().optional(),
});

export async function PATCH(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const params = await ctx.params;
  const auth = await requireScope("configuracion");
  if (!auth.ok) return auth.response;
  const { supabase } = auth;

  const input = await readJson(request, AssigneePatchBody);
  if (!input.ok) return input.response;
  const body = input.data;
  const update: Record<string, unknown> = {};
  if (typeof body.display_name === "string") {
    update.display_name = body.display_name.trim() || null;
  }
  if (body.match_terms !== undefined) update.match_terms = parseTerms(body.match_terms);
  if (body.enabled !== undefined) update.enabled = body.enabled;
  if (body.sort_order !== undefined && Number.isFinite(body.sort_order)) update.sort_order = body.sort_order;

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: "nada para actualizar" }, { status: 400 });
  }

  const { error } = await supabase.from("routing_assignees").update(update).eq("id", params.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const params = await ctx.params;
  const auth = await requireScope("configuracion");
  if (!auth.ok) return auth.response;
  const { supabase } = auth;

  const { error } = await supabase.from("routing_assignees").delete().eq("id", params.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
