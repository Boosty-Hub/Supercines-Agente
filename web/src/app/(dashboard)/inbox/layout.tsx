import type { Metadata } from "next";
import InboxShell from "./inbox-shell";

export const metadata: Metadata = { title: "Inbox" };

// Lista a la izquierda (InboxShell, se mantiene montada) + la conversación
// abierta como hijo (/inbox/[leadId]). Ver el comentario de inbox-shell.tsx.
export default function InboxLayout({ children }: { children: React.ReactNode }) {
  return <InboxShell>{children}</InboxShell>;
}
