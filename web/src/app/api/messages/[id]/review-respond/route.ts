import { NextResponse } from "next/server";
import { requireScope } from "@/lib/auth/require-scope";
import { triggerInternalFunction } from "@/lib/internal-call";

// Resuelve un mensaje marcado para revisión humana: limpia el flag y dispara
// al agente en modo force_review (el draft queda 'pending' para que el humano
// lo apruebe o edite en la misma conversación).
export async function POST(_request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const auth = await requireScope("operacion");
  if (!auth.ok) return auth.response;
  const { supabase } = auth;

  const { error } = await supabase
    .from("messages")
    .update({ requires_human_review: false })
    .eq("id", params.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // generate-response exige el secreto interno (lo manda el helper, en el servidor). Se
  // espera el acuse (202) porque en serverless un fetch sin await se congela; si falla
  // se registra y el barrido de pg_cron toma el mensaje.
  await triggerInternalFunction("generate-response", { message_id: params.id, force_review: true }, `message ${params.id}`);

  return NextResponse.json({ ok: true });
}
