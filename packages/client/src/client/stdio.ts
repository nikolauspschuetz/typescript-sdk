import type { ChildProcess, IOType } from 'node:child_process';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import type { Stream } from 'node:stream';
import { PassThrough } from 'node:stream';

import type { JSONRPCMessage, Transport } from '@modelcontextprotocol/core-internal';
import { ReadBuffer, SdkError, SdkErrorCode, serializeMessage } from '@modelcontextprotocol/core-internal';
import spawn from 'cross-spawn';

export type StdioServerParameters = {
    /**
     * The executable to run to start the server.
     */
    command: string;

    /**
     * Command line arguments to pass to the executable.
     */
    args?: string[];

    /**
     * The environment to use when spawning the process.
     *
     * If not specified, the result of {@linkcode getDefaultEnvironment} will be used.
     */
    env?: Record<string, string>;

    /**
     * How to handle stderr of the child process. This matches the semantics of Node's `child_process.spawn`.
     *
     * The default is `"inherit"`, meaning messages to stderr will be printed to the parent process's stderr.
     */
    stderr?: IOType | Stream | number;

    /**
     * The working directory to use when spawning the process.
     *
     * If not specified, the current working directory will be inherited.
     */
    cwd?: string;

    /**
     * Maximum size of the read buffer in bytes. If a single message exceeds
     * this size the transport will emit an error and close.
     *
     * Defaults to 10 MB.
     */
    maxBufferSize?: number;
};

/**
 * Environment variables to inherit by default, if an environment is not explicitly given.
 */
export const DEFAULT_INHERITED_ENV_VARS =
    process.platform === 'win32'
        ? [
              'APPDATA',
              'HOMEDRIVE',
              'HOMEPATH',
              'LOCALAPPDATA',
              'PATH',
              'PROCESSOR_ARCHITECTURE',
              'SYSTEMDRIVE',
              'SYSTEMROOT',
              'TEMP',
              'USERNAME',
              'USERPROFILE',
              'PROGRAMFILES'
          ]
        : /* list inspired by the default env inheritance of sudo */
          ['HOME', 'LOGNAME', 'PATH', 'SHELL', 'TERM', 'USER'];

/**
 * Returns a default environment object including only environment variables deemed safe to inherit.
 */
export function getDefaultEnvironment(): Record<string, string> {
    const env: Record<string, string> = {};

    for (const key of DEFAULT_INHERITED_ENV_VARS) {
        const value = process.env[key];
        if (value === undefined) {
            continue;
        }

        if (value.startsWith('()')) {
            // Skip functions, which are a security risk.
            continue;
        }

        env[key] = value;
    }

    return env;
}

/**
 * Client transport for stdio: this will connect to a server by spawning a process and communicating with it over stdin/stdout.
 *
 * This transport is only available in Node.js environments.
 */
export class StdioClientTransport implements Transport {
    private _process?: ChildProcess;
    private _readBuffer: ReadBuffer;
    private _serverParams: StdioServerParameters;
    private _stderrStream: PassThrough | null = null;

    onclose?: () => void;
    onerror?: (error: Error) => void;
    onmessage?: (message: JSONRPCMessage) => void;

    constructor(server: StdioServerParameters) {
        this._serverParams = server;
        this._readBuffer = new ReadBuffer({ maxBufferSize: server.maxBufferSize });
        if (server.stderr === 'pipe' || server.stderr === 'overlapped') {
            this._stderrStream = new PassThrough();
        }
    }

    /**
     * Starts the server process and prepares to communicate with it.
     */
    async start(): Promise<void> {
        if (this._process) {
            throw new Error(
                'StdioClientTransport already started! If using Client class, note that connect() calls start() automatically.'
            );
        }

        return new Promise((resolve, reject) => {
            this._process = spawn(this._serverParams.command, this._serverParams.args ?? [], {
                // merge default env with server env because mcp server needs some env vars
                env: {
                    ...getDefaultEnvironment(),
                    ...this._serverParams.env
                },
                stdio: ['pipe', 'pipe', this._serverParams.stderr ?? 'inherit'],
                shell: false,
                // On POSIX, run the child as the leader of its own process group (pgid === pid)
                // so that wrapper commands (npx/uvx/python -m/shells) and the real server they
                // fork can be terminated together as a tree in close(). We keep stdio wired and do
                // NOT call unref(): the transport still owns the child's lifecycle. Skipped on
                // Windows, where `detached` opens a new console window instead.
                // Tradeoff: a detached child no longer shares the parent's controlling terminal,
                // so terminal SIGINT (Ctrl+C) is not auto-delivered to it, and an abrupt parent
                // death that skips close() can orphan the tree.
                detached: process.platform !== 'win32',
                windowsHide: process.platform === 'win32',
                cwd: this._serverParams.cwd
            });

            this._process.on('error', error => {
                reject(error);
                this.onerror?.(error);
            });

            this._process.on('spawn', () => {
                resolve();
            });

            this._process.on('close', _code => {
                this._process = undefined;
                this.onclose?.();
            });

            this._process.stdin?.on('error', error => {
                this.onerror?.(error);
            });

            this._process.stdout?.on('data', chunk => {
                try {
                    this._readBuffer.append(chunk);
                    this.processReadBuffer();
                } catch (error) {
                    this.onerror?.(error as Error);
                    this.close().catch(() => {});
                }
            });

            this._process.stdout?.on('error', error => {
                this.onerror?.(error);
            });

            if (this._stderrStream && this._process.stderr) {
                this._process.stderr.pipe(this._stderrStream);
            }
        });
    }

    /**
     * The `stderr` stream of the child process, if {@linkcode StdioServerParameters.stderr} was set to `"pipe"` or `"overlapped"`.
     *
     * If `stderr` piping was requested, a `PassThrough` stream is returned _immediately_, allowing callers to
     * attach listeners before the `start` method is invoked. This prevents loss of any early
     * error output emitted by the child process.
     */
    get stderr(): Stream | null {
        if (this._stderrStream) {
            return this._stderrStream;
        }

        return this._process?.stderr ?? null;
    }

    /**
     * The child process pid spawned by this transport.
     *
     * This is only available after the transport has been started.
     */
    get pid(): number | null {
        return this._process?.pid ?? null;
    }

    private processReadBuffer() {
        while (true) {
            try {
                const message = this._readBuffer.readMessage();
                if (message === null) {
                    break;
                }

                this.onmessage?.(message);
            } catch (error) {
                this.onerror?.(error as Error);
            }
        }
    }

    async close(): Promise<void> {
        if (this._process) {
            const processToClose = this._process;
            this._process = undefined;

            const closePromise = new Promise<void>(resolve => {
                processToClose.once('close', () => {
                    resolve();
                });
            });

            try {
                processToClose.stdin?.end();
            } catch {
                // ignore
            }

            await Promise.race([closePromise, new Promise(resolve => setTimeout(resolve, 2000).unref())]);

            // `exitCode` stays null both before exit AND after death-by-signal (where
            // `signalCode` is set instead). Only escalate while the process is genuinely
            // still running, so a server that terminates on SIGTERM does not trigger a
            // pointless SIGKILL — and its descendant-tree walk — on the common close path.
            const stillRunning = () => processToClose.exitCode === null && processToClose.signalCode === null;

            if (stillRunning()) {
                killProcessTree(processToClose, 'SIGTERM');

                await Promise.race([closePromise, new Promise(resolve => setTimeout(resolve, 2000).unref())]);
            }

            if (stillRunning()) {
                killProcessTree(processToClose, 'SIGKILL');
            }
        }

        this._readBuffer.clear();
    }

    send(message: JSONRPCMessage): Promise<void> {
        return new Promise(resolve => {
            if (!this._process?.stdin) {
                throw new SdkError(SdkErrorCode.NotConnected, 'Not connected');
            }

            const json = serializeMessage(message);
            if (this._process.stdin.write(json)) {
                resolve();
            } else {
                this._process.stdin.once('drain', resolve);
            }
        });
    }
}

/**
 * Terminate a child process together with any descendants it spawned.
 *
 * {@link StdioClientTransport} frequently launches wrapper commands (`npx`, `uvx`,
 * `python -m`, shell scripts) that fork the real MCP server as a grandchild.
 * {@link ChildProcess.kill} only signals the direct child, leaving the server
 * orphaned; this helper signals the whole tree instead.
 *
 * - On POSIX the child is spawned `detached`, so it leads its own process group
 *   (`pgid === pid`); signalling the negative pid reaches every member of the group.
 *   If the group signal fails we fall back to a best-effort `pgrep -P` descendant walk
 *   (which can miss descendants already reparented away from an exited leader), then the
 *   direct child.
 * - On Windows there is no process-group primitive, so we shell out to `taskkill /T`,
 *   which terminates the pid and its entire child tree. The graceful pass (SIGTERM) uses a
 *   soft taskkill and the SIGKILL pass adds `/F`, mirroring the POSIX escalation.
 */
function killProcessTree(proc: ChildProcess, signal: NodeJS.Signals): void {
    const pid = proc.pid;
    if (pid === undefined) {
        return;
    }

    if (process.platform === 'win32') {
        // Windows has no process-group primitive and Node's kill() cannot deliver POSIX
        // signals there, so shell out to taskkill /T (whole tree). Map the graceful pass
        // (SIGTERM) to a soft taskkill and reserve /F for the SIGKILL pass, mirroring the
        // POSIX SIGTERM -> grace -> SIGKILL escalation. `timeout` bounds a hung taskkill.
        const force = signal === 'SIGKILL';
        const args = force ? ['/T', '/F', '/PID', String(pid)] : ['/T', '/PID', String(pid)];
        const result = spawnSync('taskkill', args, { windowsHide: true, timeout: 2000 });
        // Only fall back to a direct kill on the force pass. A soft taskkill legitimately
        // fails for a console process with no window to receive the close request; killing
        // just the direct child there would orphan the tree, so we let close() escalate to
        // the SIGKILL pass instead.
        if (force && (result.error || result.status !== 0)) {
            killPid(proc, signal);
        }
        return;
    }

    try {
        // A negative pid signals the entire process group led by the detached child.
        process.kill(-pid, signal);
        return;
    } catch {
        // Group signalling failed (e.g. the child was never a group leader, or the
        // group is already gone); fall back to walking the descendant tree explicitly.
    }

    for (const descendant of collectDescendantPids(pid)) {
        try {
            process.kill(descendant, signal);
        } catch {
            // ignore processes that already exited
        }
    }

    killPid(proc, signal);
}

/**
 * Signal a single child process, swallowing errors (e.g. it already exited).
 */
function killPid(proc: ChildProcess, signal: NodeJS.Signals): void {
    try {
        proc.kill(signal);
    } catch {
        // ignore
    }
}

/**
 * Depth-first enumeration of a process's descendant pids via `pgrep -P`, ordered
 * deepest-first so children are signalled before their parents.
 */
function collectDescendantPids(pid: number): number[] {
    // `timeout` bounds a hung pgrep so close() can't block forever.
    const result = spawnSync('pgrep', ['-P', String(pid)], { encoding: 'utf8', timeout: 2000 });
    if (result.status !== 0 || typeof result.stdout !== 'string') {
        return [];
    }

    const descendants: number[] = [];
    for (const line of result.stdout.split('\n')) {
        const childPid = Number.parseInt(line.trim(), 10);
        if (!Number.isInteger(childPid) || childPid <= 0) {
            continue;
        }
        descendants.push(...collectDescendantPids(childPid), childPid);
    }
    return descendants;
}
