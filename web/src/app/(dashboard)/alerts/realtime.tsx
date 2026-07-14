"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

export default function AlertsRealtime() {
  const router = useRouter();
  useEffect(() => {
    const supabase = createSupabaseBrowserClient();
    let t: ReturnType<typeof setTimeout> | null = null;
    const refresh = () => {
      if (t) clearTimeout(t);
      t = setTimeout(() => router.refresh(), 400);
    };
    const ch = supabase
      .channel("alerts-live")
      .on("postgres_changes", { event: "*", schema: "public", table: "alerts" }, refresh)
      .subscribe();
    return () => {
      if (t) clearTimeout(t);
      supabase.removeChannel(ch);
    };
  }, [router]);
  return null;
}
