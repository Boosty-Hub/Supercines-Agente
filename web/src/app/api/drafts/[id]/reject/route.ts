import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { DRAFT_NOT_ACTIONABLE, DRAFT_REJECTABLE_STATUSES } from "@/lib/draft-status";
import { clearNoReplyReview } from "@/lib/draft-review";

export async function POST(_request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  // Un draft que se está enviando (`publishing`) o que ya salió no se rechaza: el
  // mensaje ya está en camino o en el canal, y marcarlo rechazado falsearía el historial.
  const { data: updated, error } = await supabase
    .from("drafts")
    .update({ status: "rejected", reviewer_id: user.id })
    .eq("id", params.id)
    .in("status", [...DRAFT_REJECTABLE_STATUSES])
    .select("id, agent_metadata");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!updated || updated.length === 0) {
    return NextResponse.json({ error: DRAFT_NOT_ACTIONABLE }, { status: 409 });
  }
  await clearNoReplyReview(supabase, params.id, updated[0].agent_metadata);
  return NextResponse.json({ ok: true });
}
