---
'@modelcontextprotocol/client': patch
---

Fix `StdioClientTransport.close()` leaving MCP server processes alive when the command is a wrapper (npx/uvx/python -m, shell scripts) that forks the real server as a grandchild — `ChildProcess.kill()` only signalled the direct child.

The child is now spawned in its own process group on POSIX, and the existing SIGTERM→2s grace→SIGKILL escalation in `close()` now signals the whole tree: `process.kill(-pid)` on POSIX (with a best-effort `pgrep -P` descendant-walk fallback), and `taskkill /T` (soft) escalating to `taskkill /T /F` on Windows. A server that exits on SIGTERM no longer triggers a redundant SIGKILL.

Note: spawning detached means the child no longer shares the parent's controlling terminal, so terminal SIGINT (Ctrl+C) is not auto-forwarded to it; the transport tears the tree down in `close()`.
