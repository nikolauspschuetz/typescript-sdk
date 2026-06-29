import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { StdioClientTransport } from '../../src/client/stdio';

/**
 * Regression test for issue #2023: StdioClientTransport.close() must kill the whole
 * process tree, not just the direct child. Wrapper commands (npx/uvx/python -m) fork
 * the real server as a grandchild; closing the transport must not orphan it.
 *
 * The wrapper child here spawns a long-sleeping grandchild, writes the grandchild's
 * pid to a marker file, then parks on stdin (so it behaves like a live MCP server and
 * the transport's stdio stays wired). After close(), the grandchild must be gone.
 */

// These commands signal child processes by pid; that machinery is POSIX/Windows-specific
// but the assertion (`process.kill(pid, 0)` throws once the process is gone) is portable.
const isWindows = process.platform === 'win32';

// Wrapper script: fork a detached grandchild that sleeps, record its pid, then read stdin
// forever so the wrapper stays alive until the transport closes it.
const WRAPPER_SCRIPT = `
const { spawn } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const markerFile = process.env.MARKER_FILE;

// Grandchild: sleep far longer than the test so it can only die by being killed.
const grandchild = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], {
    detached: false,
    stdio: 'ignore'
});

writeFileSync(markerFile, String(grandchild.pid));

// Keep the wrapper alive by holding stdin open; never resolve on its own.
process.stdin.resume();
setTimeout(() => {}, 600000);
`;

function isAlive(pid: number): boolean {
    try {
        // Signal 0 performs error checking without actually sending a signal.
        process.kill(pid, 0);
        return true;
    } catch (err) {
        // ESRCH => no such process. EPERM => exists but not ours (treat as alive).
        return (err as NodeJS.ErrnoException).code === 'EPERM';
    }
}

async function waitForDead(pid: number, timeoutMs = 5000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (!isAlive(pid)) {
            return true;
        }
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    return !isAlive(pid);
}

describe.skipIf(isWindows)('StdioClientTransport.close() kills the process tree (POSIX)', () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = mkdtempSync(join(tmpdir(), 'mcp-stdio-tree-'));
    });

    afterEach(() => {
        rmSync(tmpDir, { recursive: true, force: true });
    });

    test('grandchild process is terminated when the transport is closed', async () => {
        const markerFile = join(tmpDir, 'grandchild.pid');

        const transport = new StdioClientTransport({
            command: process.execPath,
            args: ['-e', WRAPPER_SCRIPT],
            env: { MARKER_FILE: markerFile }
        });
        transport.onerror = () => {
            // The wrapper does not speak MCP; ignore protocol read noise.
        };

        await transport.start();

        // Wait for the wrapper to record its grandchild's pid.
        let grandchildPid: number | undefined;
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
            try {
                const contents = readFileSync(markerFile, 'utf8').trim();
                if (contents) {
                    grandchildPid = Number.parseInt(contents, 10);
                    break;
                }
            } catch {
                // marker not written yet
            }
            await new Promise(resolve => setTimeout(resolve, 25));
        }

        expect(grandchildPid).toBeDefined();
        expect(Number.isInteger(grandchildPid)).toBe(true);
        expect(isAlive(grandchildPid!)).toBe(true);

        await transport.close();

        // The grandchild must be reaped along with the wrapper.
        const dead = await waitForDead(grandchildPid!);
        expect(dead).toBe(true);
        expect(() => process.kill(grandchildPid!, 0)).toThrow(/ESRCH/);
    }, 20000);
});

describe.runIf(isWindows)('StdioClientTransport.close() kills the process tree (Windows)', () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = mkdtempSync(join(tmpdir(), 'mcp-stdio-tree-'));
    });

    afterEach(() => {
        rmSync(tmpDir, { recursive: true, force: true });
    });

    test('grandchild process is terminated when the transport is closed', async () => {
        const markerFile = join(tmpDir, 'grandchild.pid');

        const transport = new StdioClientTransport({
            command: process.execPath,
            args: ['-e', WRAPPER_SCRIPT],
            env: { MARKER_FILE: markerFile }
        });
        transport.onerror = () => {
            // The wrapper does not speak MCP; ignore protocol read noise.
        };

        await transport.start();

        let grandchildPid: number | undefined;
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
            try {
                const contents = readFileSync(markerFile, 'utf8').trim();
                if (contents) {
                    grandchildPid = Number.parseInt(contents, 10);
                    break;
                }
            } catch {
                // marker not written yet
            }
            await new Promise(resolve => setTimeout(resolve, 25));
        }

        expect(grandchildPid).toBeDefined();
        expect(isAlive(grandchildPid!)).toBe(true);

        await transport.close();

        const dead = await waitForDead(grandchildPid!);
        expect(dead).toBe(true);
    }, 20000);
});
