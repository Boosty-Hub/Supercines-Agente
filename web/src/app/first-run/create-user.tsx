"use client";

// INVARIANT: this file must not import runtime-config or createServiceClient

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { inputCls, labelCls } from "@/components/ui/styles";

function validate(email: string, password: string, confirm: string) {
  const errors: Record<string, string> = {};
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    errors.email = "Ingresá un email válido.";
  }
  if (password.length < 8) {
    errors.password = "La contraseña debe tener al menos 8 caracteres.";
  }
  if (password !== confirm) {
    errors.confirm = "Las contraseñas no coinciden.";
  }
  return errors;
}

export function CreateUser({ onComplete }: { onComplete: () => void }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setServerError(null);

    const errs = validate(email, password, confirm);
    setFieldErrors(errs);
    if (Object.keys(errs).length > 0) return;

    setRunning(true);
    try {
      // 1. Create the user (server-side; first-run lock enforced there).
      const res = await fetch("/api/provision/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password, confirm }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        fieldErrors?: Record<string, string>;
      };

      if (res.status === 400 && data.fieldErrors) {
        setFieldErrors(data.fieldErrors);
        return;
      }
      // 409 = a user already exists (e.g. you're resuming after a partial run).
      // That's fine — we just sign in below with the credentials entered.
      // Any other non-OK is a real error.
      if (!res.ok && res.status !== 409) {
        setServerError(data.error ?? `No se pudo crear el usuario (HTTP ${res.status})`);
        return;
      }

      // 2. Sign in with the SAME cookie-based SSR client the rest of the app
      // uses, so the middleware recognizes the session and we can continue the
      // onboarding into /setup (Anthropic + Kommo). We never bounce to /login.
      const supabase = createSupabaseBrowserClient();
      const { error: authError } = await supabase.auth.signInWithPassword({
        email,
        password,
      });
      if (authError) {
        setServerError(
          res.status === 409
            ? "Ya existe un usuario con otra contraseña. Ingresá la contraseña correcta para continuar."
            : `Usuario creado, pero no pudimos iniciar sesión: ${authError.message}. Reintentá.`
        );
        return;
      }

      // 3. Session is in cookies now → continue the flow to /setup.
      router.refresh();
      onComplete();
    } catch (err) {
      setServerError(err instanceof Error ? err.message : "Error inesperado");
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-neutral-900">
          Creá tu usuario
        </h2>
        <p className="mt-1 text-sm text-neutral-500">
          Con este email y contraseña vas a entrar al panel. Es el único acceso
          — guardalo bien.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4" noValidate>
        <div className="space-y-2">
          <label className={labelCls} htmlFor="fr-email">
            Email
          </label>
          <input
            id="fr-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="admin@tuempresa.com"
            className={inputCls}
            disabled={running}
            autoComplete="email"
          />
          {fieldErrors.email && (
            <p className="text-xs text-red-600">{fieldErrors.email}</p>
          )}
        </div>

        <div className="space-y-2">
          <label className={labelCls} htmlFor="fr-password">
            Contraseña
          </label>
          <input
            id="fr-password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Mínimo 8 caracteres"
            className={inputCls}
            disabled={running}
            autoComplete="new-password"
          />
          {fieldErrors.password && (
            <p className="text-xs text-red-600">{fieldErrors.password}</p>
          )}
        </div>

        <div className="space-y-2">
          <label className={labelCls} htmlFor="fr-confirm">
            Confirmar contraseña
          </label>
          <input
            id="fr-confirm"
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            placeholder="Repetí la contraseña"
            className={inputCls}
            disabled={running}
            autoComplete="new-password"
          />
          {fieldErrors.confirm && (
            <p className="text-xs text-red-600">{fieldErrors.confirm}</p>
          )}
        </div>

        {serverError && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
            {serverError}
          </div>
        )}

        <Button type="submit" busy={running}>
          {running ? "Creando…" : "Crear usuario y continuar"}
        </Button>
      </form>
    </div>
  );
}
