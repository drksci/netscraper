"use client";
import { useEffect, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { useSession } from "./session-store";

/** Chat transport + system prompt state, shared by the chat panel and the authoring views. */
export function useStudioChat() {
  const connected = useSession((s) => s.connected);
  const [system, setSystemState] = useState("");
  const systemRef = useRef("");
  const edited = useRef(false);
  systemRef.current = system;

  // Prefill from the session server once it is reachable (until the user edits it).
  useEffect(() => {
    if (!connected || edited.current) return;
    fetch("/session/system-prompt")
      .then((r) => r.json())
      .then((j) => { if (!edited.current && typeof j?.prompt === "string") setSystemState(j.prompt); })
      .catch(() => {});
  }, [connected]);

  const [transport] = useState(
    () =>
      new DefaultChatTransport({
        api: "/api/chat",
        prepareSendMessagesRequest: ({ id, messages }) => ({ body: { id, messages, system: systemRef.current } }),
      }),
  );
  const chat = useChat({ transport });
  const setSystem = (v: string) => { edited.current = true; setSystemState(v); };
  return { ...chat, system, setSystem };
}
