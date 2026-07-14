// INVARIANT: this route group must not import runtime-config or createServiceClient
// This page is served in NO-ENV mode (Supabase env vars may be absent).
// Any server-only import that touches runtime-config.ts or service.ts WILL crash.

export const dynamic = "force-dynamic";

import { FirstRunWizard } from "./wizard";

export default function FirstRunPage() {
  return <FirstRunWizard />;
}
