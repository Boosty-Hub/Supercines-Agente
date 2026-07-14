"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

function CallbackInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const supabase = createSupabaseBrowserClient();
    const next = searchParams.get("next") ?? "/inbox";

    async function proceedIfAlreadyAuthed(): Promise<boolean> {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (session) {
        router.replace(next);
        router.refresh();
        return true;
      }
      return false;
    }

    async function handleAuth() {
      // Magic-links are single-use. If this callback runs twice (React strict
      // remount, an iframe reload, or "Refrescar"), the second run gets an
      // expired/used token — but the FIRST run already established the session,
      // so just proceed instead of showing a scary error.
      if (await proceedIfAlreadyAuthed()) return;

      if (typeof window !== "undefined" && window.location.hash.includes("access_token")) {
        const hash = new URLSearchParams(window.location.hash.slice(1));
        const access_token = hash.get("access_token");
        const refresh_token = hash.get("refresh_token");
        if (access_token && refresh_token) {
          const { error } = await supabase.auth.setSession({ access_token, refresh_token });
          if (error) {
            // The token may have been consumed by a parallel load that already
            // set the session — re-check before surfacing the error.
            if (await proceedIfAlreadyAuthed()) return;
            setError(error.message);
            return;
          }
          router.replace(next);
          router.refresh();
          return;
        }
      }

      const code = searchParams.get("code");
      if (code) {
        const { error } = await supabase.auth.exchangeCodeForSession(code);
        if (error) {
          if (await proceedIfAlreadyAuthed()) return;
          setError(error.message);
          return;
        }
        router.replace(next);
        router.refresh();
        return;
      }

      setError("No se recibió token ni code en la URL.");
    }

    handleAuth();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="w-full max-w-sm space-y-2 rounded-xl border border-neutral-200 bg-white p-8 text-center shadow-sm">
      <p className="text-sm font-medium text-neutral-900">
        {error ? "Error en autenticación" : "Autenticando…"}
      </p>
      {error && (
        <p className="mx-auto max-w-md text-xs text-red-600">{error}</p>
      )}
    </div>
  );
}

export default function AuthCallbackPage() {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-neutral-50 p-6">
      <Suspense
        fallback={<p className="text-sm text-neutral-400">Cargando…</p>}
      >
        <CallbackInner />
      </Suspense>
    </main>
  );
}
