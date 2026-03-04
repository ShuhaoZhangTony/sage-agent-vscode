/**
 * sagePortsResolver.ts
 *
 * Reads port numbers from `sage.common.config.ports.SagePorts` (Python) at
 * extension activation time so VS Code settings never need to hard-code values
 * that are already canonically defined in the Python layer.
 *
 * Falls back gracefully when Python / sage-common is unavailable.
 */
import * as cp from "child_process";

export interface SagePorts {
  STUDIO_BACKEND: number;
  STUDIO_FRONTEND: number;
  SAGELLM_GATEWAY: number;
  [key: string]: number;
}

/** Fallback values mirroring SagePorts defaults (kept in sync manually). */
const FALLBACK: SagePorts = {
  STUDIO_BACKEND: 8765,
  STUDIO_FRONTEND: 5173,
  SAGELLM_GATEWAY: 8889,
};

let _resolved: SagePorts | null = null;

/**
 * Run `python3 -c "from sage.common.config.ports import SagePorts; ..."` and
 * return the port map.  Result is cached; subsequent calls are instant.
 */
export async function resolveSagePorts(): Promise<SagePorts> {
  if (_resolved) return _resolved;

  const script = [
    "from sage.common.config.ports import SagePorts, StudioPorts",
    "import json, sys",
    // Merge both classes into one dict, keeping only int values
    "d = {k:v for k,v in {**vars(SagePorts),**vars(StudioPorts)}.items()",
    "     if not k.startswith('_') and isinstance(v, int)}",
    "print(json.dumps(d))",
  ].join("; ");

  // Also try the studio-local ports module as a second source
  const scriptFallback = [
    "from sage.studio.config.ports import StudioPorts",
    "import json",
    "d = {k:v for k,v in vars(StudioPorts).items()",
    "     if not k.startswith('_') and isinstance(v, int)}",
    "print(json.dumps(d))",
  ].join("; ");

  const tryScript = (code: string): Promise<SagePorts | null> =>
    new Promise((resolve) => {
      const proc = cp.spawn("python3", ["-c", code], {
        timeout: 5000,
        stdio: ["ignore", "pipe", "ignore"],
      });
      let stdout = "";
      proc.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
      proc.on("close", (code) => {
        if (code !== 0 || !stdout.trim()) {
          resolve(null);
          return;
        }
        try {
          resolve(JSON.parse(stdout.trim()) as SagePorts);
        } catch {
          resolve(null);
        }
      });
      proc.on("error", () => resolve(null));
    });

  const result =
    (await tryScript(script)) ??
    (await tryScript(scriptFallback)) ??
    FALLBACK;

  _resolved = { ...FALLBACK, ...result };
  return _resolved;
}

/** Return the cached value synchronously (after resolveSagePorts was awaited). */
export function getCachedPorts(): SagePorts {
  return _resolved ?? FALLBACK;
}

/** Invalidate the cache (useful in tests or after env changes). */
export function invalidatePortsCache(): void {
  _resolved = null;
}
