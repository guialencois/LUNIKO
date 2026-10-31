"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import "@/lib/workflows/definitions";
import { getAllNodeDefinitions } from "@/lib/workflows/registry";
import { getNodeIcon } from "../nodes/node-icon-map";
import type { NodeCategory } from "@/lib/workflows/types";
import { cn } from "@/lib/utils";

const CATEGORY_LABELS: Record<NodeCategory, string> = {
  trigger: "Triggers",
  action: "Actions",
  logic: "Logic",
  data: "Data",
  utilities: "Utilities",
  code: "Code",
};

const CATEGORY_ORDER: NodeCategory[] = [
  "trigger",
  "action",
  "logic",
  "data",
  "utilities",
  "code",
];

export interface NodePickerProps {
  /** Viewport coordinates (clientX/clientY) — this panel is `fixed`, not a
   *  React Flow element, so it never pans or zooms with the canvas. */
  screenPosition: { x: number; y: number };
  onSelect: (nodeType: string) => void;
  onClose: () => void;
}

/**
 * Floating node search panel opened from a connection drag or from the "+"
 * on a handle (components/workflow/nodes/workflow-node-view.tsx). This is
 * the LUNIKO equivalent of n8n's "Node Creator opened from a connection" —
 * reimplemented from scratch against @xyflow/react; no n8n source was
 * copied (n8n's canvas is Vue, this is React, and n8n's code is licensed
 * under the Sustainable Use License, which this agency's internal tool does
 * not redistribute).
 *
 * Filtering logic is intentionally the same as NodeLibrary's — both are
 * "search the node registry" — but this component owns its own copy rather
 * than sharing state with the sidebar, since it mounts/unmounts per drag and
 * closes on selection.
 */
export function NodePicker({ screenPosition, onSelect, onClose }: NodePickerProps) {
  const [query, setQuery] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const definitions = useMemo(() => getAllNodeDefinitions(), []);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    function handlePointerDown(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        onClose();
      }
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    // Capture phase + a microtask delay so the click/drag-release that
    // opened this panel doesn't itself register as the "outside click"
    // that closes it.
    const id = setTimeout(() => {
      document.addEventListener("mousedown", handlePointerDown, true);
    }, 0);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      clearTimeout(id);
      document.removeEventListener("mousedown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return definitions;
    return definitions.filter(
      (def) =>
        def.displayName.toLowerCase().includes(q) ||
        def.description.toLowerCase().includes(q)
    );
  }, [definitions, query]);

  const grouped = useMemo(() => {
    const map = new Map<NodeCategory, typeof definitions>();
    for (const def of filtered) {
      const list = map.get(def.category) ?? [];
      list.push(def);
      map.set(def.category, list);
    }
    return map;
  }, [filtered]);

  // Clamp so the panel never opens past the right/bottom edge of the
  // viewport when the drag ends near the edge of the canvas.
  const PANEL_WIDTH = 280;
  const PANEL_MAX_HEIGHT = 360;
  const left = Math.min(screenPosition.x, window.innerWidth - PANEL_WIDTH - 16);
  const top = Math.min(screenPosition.y, window.innerHeight - PANEL_MAX_HEIGHT - 16);

  return (
    <div
      ref={containerRef}
      style={{ left, top, width: PANEL_WIDTH, maxHeight: PANEL_MAX_HEIGHT }}
      className="fixed z-50 flex flex-col overflow-hidden rounded-lg border border-border bg-background shadow-lg"
    >
      <div className="border-b border-border p-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            ref={inputRef}
            placeholder="O que vem agora?"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="pl-8"
          />
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-1.5">
        {CATEGORY_ORDER.map((category) => {
          const items = grouped.get(category);
          if (!items || items.length === 0) return null;
          return (
            <div key={category} className="mb-2">
              <div className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                {CATEGORY_LABELS[category]}
              </div>
              {items.map((def) => {
                const Icon = getNodeIcon(def.icon);
                return (
                  <button
                    key={def.type}
                    type="button"
                    onClick={() => onSelect(def.type)}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                    )}
                  >
                    <div
                      className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md"
                      style={{ backgroundColor: `${def.color}1a` }}
                    >
                      <Icon className="h-3.5 w-3.5" style={{ color: def.color }} />
                    </div>
                    <span className="truncate font-medium leading-tight">{def.displayName}</span>
                  </button>
                );
              })}
            </div>
          );
        })}
        {filtered.length === 0 && (
          <p className="p-3 text-sm text-muted-foreground">Nenhum node encontrado.</p>
        )}
      </div>
    </div>
  );
}
