// PodExecPage — interactive shell into a container, powered by xterm.js.
// Uses the WebSocket /pods/.../exec endpoint: text frames carry control
// messages (resize), binary frames carry stdin/stdout bytes.
//
// Default exec command (executed by the server): `sh -c "clear; (bash || ash || sh)"`.
// That mirrors Lens — the user gets the best available shell with a clear
// screen, without knowing what is installed.

import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { X } from "lucide-react";
import { api } from "../lib/api";
import { useApp } from "../stores/app";

type PodTerminalMode = "exec" | "attach";

const AUTO = "auto";

export function PodExecPage(
  { mode = "exec", clusterOverride, ns, podName, onClose }: {
    mode?: PodTerminalMode; clusterOverride?: string; ns?: string; podName?: string; onClose?: () => void;
  } = {},
) {
  const routeParams = useParams();
  const namespace = ns ?? routeParams.namespace ?? "";
  const name = podName ?? routeParams.name ?? "";
  const [params] = useSearchParams();
  const activeCluster = useApp((s) => s.cluster);
  const cluster = clusterOverride ?? activeCluster;
  const [container, setContainer] = useState<string>(params.get("container") ?? "");
  const [shell, setShell] = useState<string>(params.get("command") ?? AUTO);

  const { data: pod } = useQuery({
    enabled: !!cluster && !!namespace && !!name,
    queryKey: ["pod", cluster, namespace, name],
    queryFn: () => api.getResource(cluster, { group: "", version: "v1", resource: "pods" }, namespace, name),
  });

  const containers = useMemo(() => {
    const cs = pod?.spec?.containers ?? [];
    const ics = pod?.spec?.initContainers ?? [];
    // attach can also target init containers when they're long-running.
    return [...cs.map((c: any) => c.name), ...ics.map((c: any) => c.name)];
  }, [pod]);

  useEffect(() => {
    if (containers.length > 0 && !container) setContainer(containers[0]);
  }, [containers, container]);

  const termHostRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!container || !termHostRef.current) return;

    const term = new Terminal({
      fontFamily: "JetBrains Mono, Menlo, Consolas, monospace",
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
      theme: {
        background: "#000000",
        foreground: "#e6e6e6",
        cursor: "#22c55e",
      },
      allowProposedApi: true,
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(termHostRef.current);
    fit.fit();

    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = new URL(`${proto}//${window.location.host}/api/v1/${encodeURIComponent(cluster)}/pods/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/${mode}`);
    url.searchParams.set("container", container);
    if (mode === "exec" && shell !== AUTO) {
      // explicit shell requested — pass-through. AUTO leaves command empty so
      // the server applies its `sh -c "clear; (bash || ash || sh)"` default.
      url.searchParams.set("command", shell);
    }
    const ws = new WebSocket(url.toString());
    ws.binaryType = "arraybuffer";

    ws.onopen = () => {
      ws.send(JSON.stringify({ resize: { cols: term.cols, rows: term.rows } }));
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data === "string") {
        term.write(ev.data);
        return;
      }
      term.write(new Uint8Array(ev.data));
    };
    ws.onclose = () => {
      term.write("\r\n[connection closed]\r\n");
    };

    const dataDisp = term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(new TextEncoder().encode(data));
      }
    });

    const onResize = () => {
      fit.fit();
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ resize: { cols: term.cols, rows: term.rows } }));
      }
    };
    window.addEventListener("resize", onResize);

    return () => {
      window.removeEventListener("resize", onResize);
      dataDisp.dispose();
      ws.close();
      term.dispose();
    };
  }, [cluster, namespace, name, container, shell, mode]);

  const showContainerPicker = containers.length > 1;

  return (
    <div className="h-full flex flex-col bg-black">
      <header className="h-10 px-3 border-b border-line flex items-center gap-2 bg-bg-soft text-xs">
        {showContainerPicker ? (
          <select className="input h-7 text-xs" value={container} onChange={(e) => setContainer(e.target.value)}>
            {containers.map((c: string) => <option key={c} value={c}>{c}</option>)}
          </select>
        ) : (
          <span className="chip">{container || "—"}</span>
        )}
        {mode === "exec" && (
          <select className="input h-7 text-xs" value={shell} onChange={(e) => setShell(e.target.value)}>
            <option value={AUTO}>auto (clear; bash || ash || sh)</option>
            <option value="/bin/bash">/bin/bash</option>
            <option value="/bin/sh">/bin/sh</option>
            <option value="/bin/ash">/bin/ash</option>
            <option value="/bin/zsh">/bin/zsh</option>
          </select>
        )}
        <span className="chip">{mode === "attach" ? "attach" : "exec"}</span>
        <div className="ml-auto text-fg-mute">{namespace}/{name}</div>
        {onClose && (
          <button
            className="h-7 w-7 rounded-md flex items-center justify-center text-fg-soft hover:text-fg hover:bg-bg-mute"
            onClick={onClose}
            title="Close"
          >
            <X size={13} />
          </button>
        )}
      </header>
      <div ref={termHostRef} className="flex-1 p-1" />
    </div>
  );
}
