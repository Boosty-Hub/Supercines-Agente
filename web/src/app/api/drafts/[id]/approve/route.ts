import { NextResponse } from "next/server";
import { requireScope } from "@/lib/auth/require-scope";
import { triggerInternalFunction } from "@/lib/internal-call";
import { DRAFT_APPROVABLE_STATUSES, DRAFT_NOT_ACTIONABLE } from "@/lib/draft-status";

export async function POST(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const auth = await requireScope("operacion");
  if (!auth.ok) return auth.response;
  const { supabase, user } = auth;

  let body: string | undefined;
  try {
    const json = await request.json();
    if (typeof json?.body === "string" && json.body.trim()) body = json.body.trim();
  } catch {
    // sin body es OK
  }

  const update: Record<string, unknown> = {
    status: "approved",
    reviewer_id: user.id,
  };
  if (body) update.edited_body = body;

  // Solo se aprueba lo que todavía no se está enviando ni se envió: re-aprobar un
  // draft `publishing`/`auto_sent` lo devolvería a `approved` y saldría DOS veces
  // (la base lo impide también: trigger drafts_guard_in_flight, migración 0074).
  const { data: updated, error } = await supabase
    .from("drafts")
    .update(update)
    .eq("id", params.id)
    .in("status", [...DRAFT_APPROVABLE_STATUSES])
    .select("id");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!updated || updated.length === 0) {
    return NextResponse.json({ error: DRAFT_NOT_ACTIONABLE }, { status: 409 });
  }

  // Disparar publish: se espera el acuse (en serverless un fetch sin await se congela
  // al devolver la respuesta). Si falla, el draft ya quedó 'approved' y el barrido de
  // pg_cron lo publica; triggerInternalFunction lo registra sin romper la respuesta.
  await triggerInternalFunction("publish-to-kommo", {}, `draft ${params.id}`);

  return NextResponse.json({ ok: true });
}
