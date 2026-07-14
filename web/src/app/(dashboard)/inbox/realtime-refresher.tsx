"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

// Suscribe a cambios en messages y drafts; en cualquier evento, refresca
// el server component. Debounce de 400ms para no spamear refreshes.
export default function RealtimeRefresher() {
  const router = useRouter();

  useEffect(() => {
    const supabase = createSupabaseBrowserClient();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const refreshSoon = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => router.refresh(), 400);
    };

    const channel = supabase
      .channel("inbox-live")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "messages" },
        refreshSoon
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "drafts" },
        refreshSoon
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "leads" },
        refreshSoon
      )
      .subscribe();

    return () => {
      if (timer) clearTimeout(timer);
      supabase.removeChannel(channel);
    };
  }, [router]);

  return null;
}
