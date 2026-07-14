"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type SampleType = "chat_export" | "transcript" | "rule" | "example_response";

const TYPE_INFO: Record<SampleType, { label: string; hint: string; accept: string; allowPaste: boolean }> = {
  chat_export: {
    label: "Export de chat",
    hint: "WhatsApp .txt o IG .json. El parser detecta turnos y separa al operador del lead.",
    accept: ".txt,.json",
    allowPaste: false,
  },
  transcript: {
    label: "Transcripción",
    hint: "Curso, video, podcast. .txt, .srt o .vtt — los timestamps se descartan.",
    accept: ".txt,.srt,.vtt,.md",
    allowPaste: true,
  },
  rule: {
    label: "Regla / Doc de voz",
    hint: "Markdown libre. Ej: \"nunca abro con ¡Hola!\", \"si me preguntan precio sin call, X\".",
    accept: ".md,.txt",
    allowPaste: true,
  },
  example_response: {
    label: "Respuesta ejemplo",
    hint: "Pega una conversación corta (lead → tu respuesta ideal) que quieres que el agente imite.",
    accept: ".txt,.md",
    allowPaste: true,
  },
};

export default function VoiceUploader() {
  const router = useRouter();
  const [type, setType] = useState<SampleType>("chat_export");
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  const info = TYPE_INFO[type];

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setResult(null);
    if (!title.trim()) return setError("Título requerido");
    if (!file && !content.trim()) return setError("Sube un archivo o pega contenido");

    setBusy(true);
    const form = new FormData();
    form.set("type", type);
    form.set("title", title);
    if (file) form.set("file", file);
    if (content.trim()) form.set("content", content);

    const res = await fetch("/api/voz/ingest", { method: "POST", body: form });
    const json = await res.json();
    setBusy(false);
    if (!res.ok) {
      setError(json.error ?? "Error desconocido");
      return;
    }
    setResult(`✓ ${json.chunks} chunks ingeridos (${json.blocks} bloques)`);
    setTitle("");
    setContent("");
    setFile(null);
    const fileInput = document.getElementById("voice-file") as HTMLInputElement | null;
    if (fileInput) fileInput.value = "";
    router.refresh();
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="space-y-5 rounded-xl border border-neutral-200 bg-white p-6 shadow-sm"
    >
      <div className="flex flex-wrap gap-2">
        {(Object.keys(TYPE_INFO) as SampleType[]).map((t) => (
          <button
            type="button"
            key={t}
            onClick={() => {
              setType(t);
              setResult(null);
              setError(null);
            }}
            className={
              "rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors " +
              (type === t
                ? "border-neutral-900 bg-neutral-900 text-white"
                : "border-neutral-300 bg-white text-neutral-700 hover:bg-neutral-50")
            }
          >
            {TYPE_INFO[t].label}
          </button>
        ))}
      </div>
      <p className="text-xs text-neutral-500">{info.hint}</p>

      <div className="space-y-2">
        <label className="text-sm font-medium text-neutral-700">Título</label>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder='Ej: "WhatsApp con prospectos Q4 2025"'
          className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm focus:border-neutral-900 focus:ring-1 focus:ring-neutral-900 focus:outline-none"
        />
      </div>

      <div className="space-y-2">
        <label className="text-sm font-medium text-neutral-700">Archivo</label>
        <label
          htmlFor="voice-file"
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            const f = e.dataTransfer.files?.[0];
            if (f) setFile(f);
          }}
          className={
            "flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-6 py-8 text-center transition-colors " +
            (dragging
              ? "border-neutral-900 bg-neutral-50"
              : "border-neutral-300 hover:border-neutral-400 hover:bg-neutral-50")
          }
        >
          <svg
            className="h-8 w-8 text-neutral-400"
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={1.5}
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5m-13.5-9L12 3m0 0 4.5 4.5M12 3v13.5"
            />
          </svg>
          {file ? (
            <span className="text-sm font-medium text-neutral-900">{file.name}</span>
          ) : (
            <>
              <span className="text-sm font-medium text-neutral-700">
                Arrastra un archivo o haz clic para seleccionar
              </span>
              <span className="text-xs text-neutral-400">Acepta: {info.accept}</span>
            </>
          )}
          <input
            id="voice-file"
            type="file"
            accept={info.accept}
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="sr-only"
          />
        </label>
        <p className="text-xs text-neutral-400">Acepta: {info.accept}</p>
      </div>

      {info.allowPaste && (
        <div className="space-y-2">
          <label className="text-sm font-medium text-neutral-700">… o pegá contenido</label>
          <textarea
            rows={6}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="Pega texto plano aquí"
            className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm font-mono focus:border-neutral-900 focus:ring-1 focus:ring-neutral-900 focus:outline-none"
          />
        </div>
      )}

      {error && <p className="text-sm text-red-600">{error}</p>}
      {result && <p className="text-sm text-emerald-700">{result}</p>}

      <button
        type="submit"
        disabled={busy}
        className="inline-flex items-center justify-center gap-2 rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-neutral-800 disabled:opacity-50"
      >
        {busy ? "Procesando…" : "Ingerir voz"}
      </button>
    </form>
  );
}
