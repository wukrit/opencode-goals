/**
 * Permission sandbox for unattended goals.
 *
 * Posture (documented, never silently widened):
 * - Only sessions with an `active` goal are auto-decided. All other sessions
 *   are left untouched.
 * - An incoming `deny` (explicit user/config rule) is never changed. The
 *   platform does not invoke the hook for configured denies at all; the guard
 *   below is defense-in-depth.
 * - An incoming `ask` or `allow` for a path resource inside the session's
 *   working directory is allowed; any path resource outside it is denied with
 *   a message steering the model toward `goal_block`.
 * - Resources that are not absolute filesystem paths (URLs, commands, empty)
 *   are left untouched, so the hook never invents a decision for something it
 *   cannot scope. Those prompts remain manual and are documented as such.
 *
 * Path handling is prefix-based on normalized absolute paths. Glob suffixes
 * (`/*`, `/**`) are stripped before comparison. No symlinks are resolved; a
 * session directory that is itself a symlink is compared lexically, which may
 * deny a path that resolves inside — fail-closed by design.
 */

export function stripGlob(resource: string): string {
  let out = resource.trim()
  // Strip trailing glob markers: /**, /*, *, /.
  while (out.endsWith("/**")) out = out.slice(0, -3)
  while (out.endsWith("/*")) out = out.slice(0, -2)
  // A bare trailing * (e.g. "/tmp/*" -> "/tmp/") is handled above; a lone "*"
  // means "unknown scope" and is left for the caller to reject as non-path.
  if (out === "*" || out === "**") return ""
  return out
}

export function normalizePath(p: string): string {
  const isAbsolute = p.startsWith("/")
  const parts = p.split("/").filter((seg) => seg.length > 0 && seg !== ".")
  const stack: string[] = []
  for (const seg of parts) {
    if (seg === "..") stack.pop()
    else stack.push(seg)
  }
  return (isAbsolute ? "/" : "") + stack.join("/")
}

export function isPathInside(candidate: string, root: string): boolean {
  const normCandidate = normalizePath(stripGlob(candidate))
  const normRoot = normalizePath(root)
  if (!normCandidate || !normRoot) return false
  if (normCandidate === normRoot) return true
  return normCandidate.startsWith(normRoot.endsWith("/") ? normRoot : `${normRoot}/`)
}

export function looksLikeAbsolutePath(resource: string): boolean {
  return resource.trim().startsWith("/")
}

export type PermissionDecision = { effect: "allow" | "deny"; message?: string } | { effect: "leave" }

/**
 * Decide a permission request for a goal session.
 *
 * @param resources request resources (paths or globs).
 * @param sessionDirectory the session's working directory (absolute).
 * @param incoming the effect the platform computed before hooks ran.
 */
export function decidePermission(
  resources: readonly string[],
  sessionDirectory: string | undefined,
  incoming: "allow" | "ask" | "deny",
): PermissionDecision {
  if (incoming === "deny") return { effect: "leave" }
  if (!sessionDirectory) return { effect: "leave" }
  if (resources.length === 0) return { effect: "leave" }
  // Only scope filesystem paths; anything else is out of this policy's remit.
  if (!resources.every(looksLikeAbsolutePath)) return { effect: "leave" }
  const outside = resources.filter((r) => !isPathInside(r, sessionDirectory))
  if (outside.length === 0) {
    if (incoming === "ask") return { effect: "allow" }
    return { effect: "leave" }
  }
  return {
    effect: "deny",
    message:
      `Denied by goals plugin: ${outside.join(", ")} is outside the session working directory ${sessionDirectory}. ` +
      "Work inside the session directory, or call goal_block with a specific reason if the goal genuinely cannot proceed.",
  }
}
