import { getConfig } from "../common/config.js";
import { Buffer } from "node:buffer";
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { app } from "electron";

// ============================================================================
// Generic Download Manager Types and Interfaces
// ============================================================================

/**
 * Minimal window activation utility using Windows COM (WScript.Shell)
 * Replaces external activator package dependency
 */
export function activateWindow(windowTitle: string): void {
    const helperScript = join(app.getAppPath(), "scripts", "bring_idm_to_front.vbs");
    // Fire and forget - don't wait for completion
    try {
        const process = spawn("cscript.exe", [helperScript], {
            detached: true,
            stdio: "ignore",
        });
        process.unref();
    } catch {
        // Silently fail if script cannot be executed
    }
}

export interface DownloadManagerTaskOptions {
    filename?: string;
    headers?: Record<string, string>;
    method?: "GET" | "POST";
}

export interface DownloadManagerConfig {
    host?: unknown;
    token?: unknown;
}

export abstract class DownloadManager {
    protected config: DownloadManagerConfig;

    constructor(configKey: string) {
        this.config = (getConfig(configKey) as DownloadManagerConfig) ?? {};
    }

    abstract createTask(url: string, options?: DownloadManagerTaskOptions): Promise<string>;
    abstract isConfigured(): boolean;
}

// ============================================================================
// Gopeed Download Manager Implementation
// ============================================================================

interface GopeedApiResult<T> {
    code: number;
    msg?: string;
    message?: string;
    data: T;
}

export class GopeedDownloadManager extends DownloadManager {
    constructor() {
        super("gopeed");
    }

    public normalizeHost(host: unknown): string {
        const trimmed = typeof host === "string" ? host.trim() : "";
        if (!trimmed) {
            return "http://127.0.0.1:9999";
        }

        const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
        const withoutTrailingSlash = withProtocol.replace(/\/+$/, "");
        return withoutTrailingSlash.replace(/\/api\/v1(?:\/tasks)?$/i, "");
    }

    private parseApiResult(bodyText: string): GopeedApiResult<string> {
        try {
            return JSON.parse(bodyText) as GopeedApiResult<string>;
        } catch {
            throw new Error(`Gopeed API returned non-JSON response: ${bodyText.slice(0, 300)}`);
        }
    }

    isConfigured(): boolean {
        // Gopeed is configured if we can reach it. Always allow attempting connection.
        return true;
    }

    async createTask(url: string, options: DownloadManagerTaskOptions = {}): Promise<string> {
        const token = typeof this.config.token === "string" ? this.config.token.trim() : "";
        const host = this.normalizeHost(this.config.host);
        const requestUrl = `${host}/api/v1/tasks`;

        const extra: { header?: Record<string, string>; method?: "GET" | "POST" } = {};
        if (options.headers && Object.keys(options.headers).length > 0) {
            extra.header = options.headers;
        }
        if (options.method) {
            extra.method = options.method;
        }

        const reqPayload = Object.keys(extra).length > 0 ? { url, extra } : { url };

        const payload: {
            req: { url: string; extra?: { header?: Record<string, string>; method?: "GET" | "POST" } };
            opts?: { name?: string };
        } = options.filename
            ? {
                  req: reqPayload,
                  opts: { name: options.filename },
              }
            : {
                  req: reqPayload,
              };

        const payloadText = JSON.stringify(payload);

        let response: Response;
        try {
            response = await fetch(requestUrl, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    ...(token ? { "X-Api-Token": token } : {}),
                },
                body: payloadText,
                signal: AbortSignal.timeout(8_000),
            });
        } catch (error) {
            throw error;
        }

        const bodyText = await response.text();
        if (!response.ok) {
            throw new Error(`Gopeed API returned HTTP ${response.status}: ${bodyText.slice(0, 300)}`);
        }

        const json = this.parseApiResult(bodyText);
        if (json.code !== 0) {
            throw new Error(json.msg ?? json.message ?? "Unknown Gopeed API error");
        }

        return json.data;
    }
}

// ============================================================================
// Backward Compatibility Exports
// ============================================================================

export function normalizeGopeedHost(host: unknown): string {
    return new GopeedDownloadManager().normalizeHost(host);
}

export async function createGopeedTask(url: string, options: DownloadManagerTaskOptions = {}): Promise<string> {
    const manager = new GopeedDownloadManager();
    return manager.createTask(url, options);
}

// ============================================================================
// Internet Download Manager (IDM) Implementation
// ============================================================================

interface IDMTaskResult {
    success: boolean;
    error?: string;
    message?: string;
}

function getIDMHelperScriptPath(): string {
    // Get the VBScript helper path relative to app root
    // This function is called at runtime, after app initialization
    return join(app.getAppPath(), "scripts", "idm_helper.vbs");
}

export class IDMDownloadManager extends DownloadManager {
    constructor() {
        super("idm");
    }

    isConfigured(): boolean {
        return true; // IDM is system-wide, always available if installed
    }

    private async executeIDMHelper(
        url: string,
        referrer: string,
        cookie: string,
        filename?: string
    ): Promise<IDMTaskResult> {
        return new Promise((resolve, reject) => {
            const helperScript = getIDMHelperScriptPath();
            
            // VBScript expects: cscript.exe idm_helper.vbs url referrer cookie postData username password outputPath outputFilename userAgent flags
            const args = [
                helperScript,
                url,
                referrer,
                cookie,
                "", // post_data (empty)
                "", // username (empty)
                "", // password (empty)
                "", // output_path (empty - let IDM use default)
                filename || "", // output_filename
                "", // user_agent (empty)
                "1", // flags: 1 = silent download
            ];

            // Use cscript.exe to execute the VBScript
            const ps = spawn("cscript.exe", args, { stdio: ["pipe", "pipe", "pipe"] });
            let output = "";
            let errorOutput = "";

            ps.stdout?.on("data", (data: Buffer) => {
                output += data.toString();
            });

            ps.stderr?.on("data", (data: Buffer) => {
                errorOutput += data.toString();
            });

            ps.on("close", (code: number | null) => {
                try {
                    // Parse the JSON response from VBScript
                    const jsonMatch = output.match(/\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/);
                    const jsonStr = jsonMatch ? jsonMatch[0] : output.trim();
                    const result = JSON.parse(jsonStr) as IDMTaskResult;
                    
                    if (result.success) {
                        resolve(result);
                    } else {
                        reject(new Error(result.error || "Unknown IDM error"));
                    }
                } catch (error) {
                    reject(
                        new Error(
                            `Failed to execute IDM helper: ${errorOutput || output || `exit code ${code}`}`
                        )
                    );
                }
            });

            ps.on("error", (err: Error) => {
                reject(
                    new Error(
                        `Failed to execute IDM helper script: ${err.message}`
                    )
                );
            });
        });
    }

    async createTask(url: string, options: DownloadManagerTaskOptions = {}): Promise<string> {
        try {
            const referrer = options.headers?.Referer ?? "";
            const cookieHeader = options.headers?.Cookie ?? "";

            const result = await this.executeIDMHelper(url, referrer, cookieHeader, options.filename);
            return result.message || "Download task sent to IDM successfully";
        } catch (error) {
            throw new Error(
                `Failed to send download to IDM: ${error instanceof Error ? error.message : String(error)}`
            );
        }
    }
}
