"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ConfirmDialog } from "@/components/ui";

export default function SampleRow({
  id,
  type,
  title,
  chunkCount,
  ingestedAt,
}: {
  id: string;
  type: string;
  title: string;
  chunkCount: number;
  ingestedAt: string | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);

  async function doDelete() {
    setDeleting(true);
    const res = await fetch(`/api/voz/sample/${id}`, { method: "DELETE" });
    setDeleting(false);
    setConfirming(false);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setError(j.error ?? "error");
      return;
    }
    startTransition(() => router.refresh());
  }

  return (
    <tr className={"hover:bg-neutral-50 " + (pending ? "opacity-50" : "")}>
      <td className="px-4 py-3">
        <span className="inline-flex items-center rounded-full bg-neutral-100 px-2 py-0.5 text-[11px] font-medium text-neutral-700">
          {type}
        </span>
      </td>
      <td className="px-4 py-3 font-medium text-neutral-900">{title}</td>
      <td className="px-4 py-3 text-neutral-600">{chunkCount}</td>
      <td className="px-4 py-3 text-neutral-600">
        {ingestedAt ? new Date(ingestedAt).toLocaleString() : "—"}
      </td>
      <td className="px-4 py-3 text-right">
        <div className="flex items-center justify-end gap-4">
          <a
            href={`/api/voz/sample/${id}`}
            download
            className="text-xs font-medium text-neutral-700 transition-colors hover:text-neutral-900 hover:underline"
          >
            Descargar
          </a>
          <button
            onClick={() => setConfirming(true)}
            disabled={pending}
            className="text-xs font-medium text-red-600 transition-colors hover:text-red-700 hover:underline disabled:opacity-50"
          >
            Borrar
          </button>
        </div>
        {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
      </td>

      <ConfirmDialog
        open={confirming}
        title="Borrar muestra de voz"
        description={`¿Borrar "${title}" y sus ${chunkCount} chunks de memoria? Esta acción no se puede deshacer.`}
        confirmLabel="Borrar"
        tone="danger"
        busy={deleting}
        onCancel={() => setConfirming(false)}
        onConfirm={doDelete}
      />
    </tr>
  );
}
