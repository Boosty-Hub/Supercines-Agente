"use client";

export const dynamic = "force-dynamic";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { inputCls, errorCls } from "@/components/ui/styles";

export default function LoginPage() {
  const router = useRouter();
  const supabase = createSupabaseBrowserClient();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });
    setLoading(false);
    if (error) {
      setError(error.message);
      return;
    }
    router.push("/inbox");
    router.refresh();
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-neutral-50 p-6">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-sm space-y-5 rounded-2xl border border-neutral-200 bg-white p-8 shadow-modal"
      >
        <div className="space-y-1">
          <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-xl bg-brand text-brand-foreground text-sm font-semibold">
            {(process.env.NEXT_PUBLIC_AGENT_LABEL || "A").charAt(0).toUpperCase()}
          </div>
          <h1 className="text-[15px] font-semibold tracking-tight text-neutral-900">
            {process.env.NEXT_PUBLIC_AGENT_LABEL || "Agente"}
          </h1>
          <p className="text-sm text-neutral-500">Iniciar sesión</p>
        </div>
        <div className="space-y-2">
          <label
            className="block text-sm font-medium text-neutral-700"
            htmlFor="email"
          >
            Email
          </label>
          <input
            id="email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className={inputCls}
          />
        </div>
        <div className="space-y-2">
          <label
            className="block text-sm font-medium text-neutral-700"
            htmlFor="password"
          >
            Contraseña
          </label>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className={inputCls}
          />
        </div>
        {error && <p className={errorCls}>{error}</p>}
        <Button type="submit" busy={loading} className="w-full justify-center">
          Entrar
        </Button>
      </form>
    </main>
  );
}
