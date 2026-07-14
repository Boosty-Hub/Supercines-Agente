import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export async function POST(request: Request) {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const form = await request.formData();
  const webhookUrl = form.get("webhook_url")?.toString().trim() || null;
  const webhookEnabled = form.get("webhook_enabled") === "on";

  const { error } = await supabase
    .from("alert_config")
    .update({
      webhook_url: webhookUrl,
      webhook_enabled: webhookEnabled,
    })
    .eq("is_active", true);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.redirect(new URL("/settings?alerts_saved=1", request.url), { status: 303 });
}
