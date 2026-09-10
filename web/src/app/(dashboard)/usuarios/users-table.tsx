"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Modal, ConfirmDialog } from "@/components/ui";
import { Plus, Trash } from "@/components/ui/icons";
import type { ManagedUser } from "@/lib/users/admin";
import { SCOPES, SCOPE_LABEL, SCOPE_DESC, type Scope } from "@/lib/auth/roles";

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("es", { dateStyle: "medium" });
}

export default function UsersTable({
  initialUsers,
  currentUserId,
  loadError,
}: {
  initialUsers: ManagedUser[];
  currentUserId: string;
  loadError: string | null;
}) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);

  // Crear
  const [createOpen, setCreateOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [scope, setScope] = useState<Scope>("operacion");
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // Reset password
  const [pwUser, setPwUser] = useState<ManagedUser | null>(null);
  const [newPassword, setNewPassword] = useState("");
  const [pwBusy, setPwBusy] = useState(false);
  const [pwError, setPwError] = useState<string | null>(null);

  // Borrar
  const [delUser, setDelUser] = useState<ManagedUser | null>(null);
  const [delBusy, setDelBusy] = useState(false);

  const inputCls =
    "w-full rounded-lg border border-neutral-200 px-3 py-2 text-sm text-neutral-900 placeholder:text-neutral-400 focus:border-neutral-400 focus:outline-none focus:ring-1 focus:ring-neutral-400";

  async function changeScope(u: ManagedUser, next: Scope) {
    setBusyId(u.id);
    setRowError(null);
    try {
      const res = await fetch(`/api/users/${u.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope: next }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      router.refresh();
    } catch (e) {
      setRowError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  }

  async function createUser() {
    setCreateBusy(true);
    setCreateError(null);
    try {
      const res = await fetch("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, scope }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setCreateOpen(false);
      setEmail("");
      setPassword("");
      setScope("operacion");
      router.refresh();
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreateBusy(false);
    }
  }

  async function resetPassword() {
    if (!pwUser) return;
    setPwBusy(true);
    setPwError(null);
    try {
      const res = await fetch(`/api/users/${pwUser.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: newPassword }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setPwUser(null);
      setNewPassword("");
    } catch (e) {
      setPwError(e instanceof Error ? e.message : String(e));
    } finally {
      setPwBusy(false);
    }
  }

  async function doDelete() {
    if (!delUser) return;
    setDelBusy(true);
    try {
      const res = await fetch(`/api/users/${delUser.id}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setDelUser(null);
      router.refresh();
    } catch (e) {
      setRowError(e instanceof Error ? e.message : String(e));
      setDelUser(null);
    } finally {
      setDelBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-neutral-500">{initialUsers.length} usuario(s)</p>
        <Button variant="primary" size="sm" leftIcon={<Plus size={14} />} onClick={() => setCreateOpen(true)}>
          Nuevo usuario
        </Button>
      </div>

      {loadError && (
        <p className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          No se pudieron cargar los usuarios: {loadError}
        </p>
      )}
      {rowError && (
        <p className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{rowError}</p>
      )}

      <div className="overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[640px]">
            <thead className="bg-neutral-50/60 text-left">
              <tr>
                <th className="px-4 py-2.5 text-[11px] font-medium uppercase tracking-wider text-neutral-400">Email</th>
                <th className="px-4 py-2.5 text-[11px] font-medium uppercase tracking-wider text-neutral-400">Alcance</th>
                <th className="px-4 py-2.5 text-[11px] font-medium uppercase tracking-wider text-neutral-400">Último acceso</th>
                <th className="px-4 py-2.5 text-[11px] font-medium uppercase tracking-wider text-neutral-400">Creado</th>
                <th className="px-4 py-2.5 text-[11px] font-medium uppercase tracking-wider text-neutral-400 text-right">Acciones</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100">
              {initialUsers.map((u) => {
                const isSelf = u.id === currentUserId;
                return (
                  <tr key={u.id}>
                    <td className="px-4 py-3 text-neutral-900">
                      {u.email} {isSelf && <span className="text-[11px] text-neutral-400">(vos)</span>}
                    </td>
                    <td className="px-4 py-3">
                      <select
                        value={u.scope}
                        disabled={busyId === u.id}
                        onChange={(e) => changeScope(u, e.target.value as Scope)}
                        title={SCOPE_DESC[u.scope]}
                        className="rounded-lg border border-neutral-300 bg-white px-2 py-1 text-xs text-neutral-800 focus:border-neutral-900 focus:outline-none focus:ring-1 focus:ring-neutral-900 disabled:opacity-50"
                      >
                        {SCOPES.map((s) => (
                          <option key={s} value={s}>
                            {SCOPE_LABEL[s]}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="px-4 py-3 text-neutral-500">{fmtDate(u.last_sign_in_at)}</td>
                    <td className="px-4 py-3 text-neutral-500">{fmtDate(u.created_at)}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1">
                        <Button variant="ghost" size="sm" onClick={() => { setPwUser(u); setNewPassword(""); setPwError(null); }}>
                          Cambiar contraseña
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label="Borrar"
                          disabled={isSelf}
                          onClick={() => setDelUser(u)}
                          className="p-1.5 text-red-500 hover:text-red-700 hover:bg-red-50 disabled:opacity-30"
                        >
                          <Trash size={15} />
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Crear usuario */}
      <Modal
        open={createOpen}
        title="Nuevo usuario"
        onClose={() => setCreateOpen(false)}
        size="md"
        footer={
          <>
            <Button variant="secondary" onClick={() => setCreateOpen(false)} disabled={createBusy}>Cancelar</Button>
            <Button variant="primary" busy={createBusy} onClick={createUser}>Crear</Button>
          </>
        }
      >
        <div className="space-y-4">
          {createError && (
            <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 border border-red-200">{createError}</p>
          )}
          <div className="space-y-1">
            <label className="text-xs font-medium text-neutral-700">Email</label>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="persona@empresa.com" className={inputCls} />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-neutral-700">Contraseña (mín. 8)</label>
            <input type="text" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="contraseña inicial" className={inputCls + " font-mono"} />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-neutral-700">Alcance</label>
            <div className="flex flex-wrap gap-2">
              {SCOPES.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setScope(s)}
                  className={
                    "px-3 py-1.5 text-sm font-medium rounded-lg border transition-colors " +
                    (scope === s ? "border-neutral-900 bg-neutral-900 text-white" : "border-neutral-200 bg-white text-neutral-700 hover:bg-neutral-50")
                  }
                >
                  {SCOPE_LABEL[s]}
                </button>
              ))}
            </div>
            <p className="text-[11px] text-neutral-500">{SCOPE_DESC[scope]}</p>
          </div>
        </div>
      </Modal>

      {/* Cambiar contraseña */}
      <Modal
        open={pwUser !== null}
        title={pwUser ? `Cambiar contraseña de ${pwUser.email}` : ""}
        onClose={() => setPwUser(null)}
        size="md"
        footer={
          <>
            <Button variant="secondary" onClick={() => setPwUser(null)} disabled={pwBusy}>Cancelar</Button>
            <Button variant="primary" busy={pwBusy} onClick={resetPassword}>Guardar</Button>
          </>
        }
      >
        <div className="space-y-4">
          {pwError && (
            <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 border border-red-200">{pwError}</p>
          )}
          <div className="space-y-1">
            <label className="text-xs font-medium text-neutral-700">Nueva contraseña (mín. 8)</label>
            <input type="text" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} className={inputCls + " font-mono"} />
          </div>
        </div>
      </Modal>

      <ConfirmDialog
        open={delUser !== null}
        title="Borrar usuario"
        description={delUser ? `Se eliminará el acceso de ${delUser.email}. Esta acción es irreversible.` : ""}
        confirmLabel="Borrar"
        cancelLabel="Cancelar"
        tone="danger"
        busy={delBusy}
        onCancel={() => setDelUser(null)}
        onConfirm={doDelete}
      />
    </div>
  );
}
