import { NextResponse } from "next/server";
import { z } from "zod";
import { requireScope } from "@/lib/auth/require-scope";
import { createServiceClient } from "@/lib/supabase/service";
import { secretInputAction } from "@/lib/config-secrets";
import { readForm } from "@/lib/api/body";

// Checkboxes: presentes = "on", ausentes = desmarcados.
const AlertsForm = z.object({
  webhook_url: z.string().optional(),
  webhook_clear: z.string().optional(),
  webhook_enabled: z.string().optional(),
});

// alert_config solo se lee/escribe desde el servidor (migración 0079): webhook_url es un
// secreto (quien lo tiene postea en el canal del operador). El formulario nunca recibe el
// valor actual: input vacío = conservar, «Quitar el webhook» = borrar, otro valor = reemplazar.
export async function POST(request: Request) {
  const auth = await requireScope("configuracion");
  if (!auth.ok) return auth.response;

  const parsed = await readForm(request, AlertsForm);
  if (!parsed.ok) return parsed.response;
  const form = parsed.data;
  const url = secretInputAction(form.webhook_url, form.webhook_clear === "on");
  const update: { webhook_enabled: boolean; webhook_url?: string | null } = {
    webhook_enabled: form.webhook_enabled === "on",
  };
  if (url.action === "set") update.webhook_url = url.value;
  else if (url.action === "clear") update.webhook_url = null;

  const { error } = await createServiceClient().from("alert_config").update(update).eq("is_active", true);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.redirect(new URL("/settings?alerts_saved=1", request.url), { status: 303 });
}
