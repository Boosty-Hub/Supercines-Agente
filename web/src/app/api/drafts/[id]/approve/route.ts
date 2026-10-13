import { NextResponse } from "next/server";
import { triggerInternalFunction } from "@/lib/internal-call";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export async function POST(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

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

  const { error } = await supabase
    .from("drafts")
    .update(update)
    .eq("id", params.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Disparar publish: se espera el acuse (en serverless un fetch sin await se congela
  // al devolver la respuesta). Si falla, el draft ya quedó 'approved' y el barrido de
  // pg_cron lo publica; triggerInternalFunction lo registra sin romper la respuesta.
  await triggerInternalFunction("publish-to-kommo", {}, `draft ${params.id}`);

  return NextResponse.json({ ok: true });
}
