import { NextResponse } from "next/server";
import { requireScope } from "@/lib/auth/require-scope";
import { createServiceClient } from "@/lib/supabase/service";
import { secretInputAction } from "@/lib/config-secrets";

// alert_config solo se lee/escribe desde el servidor (migración 0079): webhook_url es un
// secreto (quien lo tiene postea en el canal del operador). El formulario nunca recibe el
// valor actual: input vacío = conservar, «Quitar el webhook» = borrar, otro valor = reemplazar.
export async function POST(request: Request) {
  const auth = await requireScope("configuracion");
  if (!auth.ok) return auth.response;

  const form = await request.formData();
  const url = secretInputAction(form.get("webhook_url")?.toString(), form.get("webhook_clear") === "on");
  const update: { webhook_enabled: boolean; webhook_url?: string | null } = {
    webhook_enabled: form.get("webhook_enabled") === "on",
  };
  if (url.action === "set") update.webhook_url = url.value;
  else if (url.action === "clear") update.webhook_url = null;

  const { error } = await createServiceClient().from("alert_config").update(update).eq("is_active", true);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.redirect(new URL("/settings?alerts_saved=1", request.url), { status: 303 });
}
