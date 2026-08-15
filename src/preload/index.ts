import { contextBridge, ipcRenderer } from "electron";

/** renderer 가 가진 표면의 전부. 파일시스템·네트워크 직접 접근은 없다. */
const api = {
  doc: {
    open: (path?: string) => ipcRenderer.invoke("doc:open", path),
    /** 돌고 있는 추출·페이지 검증을 멈춘다. */
    cancelImport: () => ipcRenderer.invoke("doc:cancelImport"),
    meta: () => ipcRenderer.invoke("doc:meta"),
  },
  blocks: {
    count: () => ipcRenderer.invoke("blocks:count"),
    range: (offset: number, limit: number) => ipcRenderer.invoke("blocks:range", offset, limit),
    byIds: (ids: string[]) => ipcRenderer.invoke("blocks:byIds", ids),
    outline: () => ipcRenderer.invoke("blocks:outline"),
    setHeights: (pairs: [string, number][]) => ipcRenderer.invoke("blocks:setHeights", pairs),
    clearHeights: () => ipcRenderer.invoke("blocks:clearHeights"),
    reset: (ids: string[]) => ipcRenderer.invoke("blocks:reset", ids),
  },
  asset: {
    /** 그림 데이터 — 렌더러가 data URI 로 만들어 <img> 에 건다. */
    get: (id: string) => ipcRenderer.invoke("asset:get", id),
  },
  translate: {
    request: (ids: string[], priority: 0 | 1 | 2 | 3) =>
      ipcRenderer.invoke("tr:request", ids, priority),
    setMode: (mode: "chapter" | "all") => ipcRenderer.invoke("tr:mode", mode),
    pause: (v: boolean) => ipcRenderer.invoke("tr:pause", v),
    stats: () => ipcRenderer.invoke("tr:stats"),
    deslop: (ids: string[]) => ipcRenderer.invoke("tr:deslop", ids),
  },
  settings: {
    get: () => ipcRenderer.invoke("settings:get"),
    set: (patch: Record<string, unknown>) => ipcRenderer.invoke("settings:set", patch),
  },
  keys: {
    status: () => ipcRenderer.invoke("keys:status"),
    set: (key: string) => ipcRenderer.invoke("keys:set", key),
    clear: () => ipcRenderer.invoke("keys:clear"),
  },
  dict: {
    lookup: (word: string) => ipcRenderer.invoke("dict:lookup", word),
  },
  export: () => ipcRenderer.invoke("export"),

  on(channel: string, cb: (payload: any) => void): () => void {
    const allowed = [
      "doc:opened", "block:updated", "import:progress", "stats", "keys:prompt",
      "help:show",
    ];
    if (!allowed.includes(channel)) throw new Error(`unknown channel ${channel}`);
    const h = (_e: unknown, payload: any) => cb(payload);
    ipcRenderer.on(channel, h);
    return () => ipcRenderer.removeListener(channel, h);
  },
};

contextBridge.exposeInMainWorld("parallax", api);
export type ParallaxAPI = typeof api;
