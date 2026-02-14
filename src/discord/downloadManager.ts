import { getConfig } from "../common/config.js";
import { ActiveXObject } from "node-ole";

// ============================================================================
// Windows Utility Functions
// ============================================================================

/**
 * Minimal window activation utility using Windows COM (WScript.Shell)
 * Replaces external activator package dependency
 */
export function activateWindow(windowTitle: string): void {
    try {
        const shell = new ActiveXObject("WScript.Shell");
        shell.AppActivate(windowTitle);
    } catch {
        // Silently fail if window not found or shell unavailable
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

export class IDMDownloadManager extends DownloadManager {
    constructor() {
        super("idm");
    }

    isConfigured(): boolean {
        return true; // IDM is system-wide, always available if installed
    }

    private executeIDMHelper(
        url: string,
        referrer: string,
        cookie: string,
        filename?: string
    ): IDMTaskResult {
        try {
            // Create IDM COM object
            const idm = new ActiveXObject("IDMan.CIDMLinkTransmitter");
            
            // Call SendLinkToIDM2 with parameters:
            // URL, Referrer, Cookie, PostData, Username, Password, OutputPath, OutputFilename, Flags, reserved1, reserved2
            idm.SendLinkToIDM2(
                url,
                referrer,
                cookie,
                "", // post_data (empty)
                "", // username (empty)
                "", // password (empty)
                "", // output_path (empty - let IDM use default)
                filename || "", // output_filename
                1, // flags: 1 = silent download
                null, // reserved1
                null  // reserved2
            );
            
            return {
                success: true,
                message: "Download task sent to IDM successfully"
            };
        } catch (error) {
            throw new Error(
                `Failed to send download to IDM: ${error instanceof Error ? error.message : String(error)}`
            );
        }
    }

    async createTask(url: string, options: DownloadManagerTaskOptions = {}): Promise<string> {
        const referrer = options.headers?.Referer ?? "";
        const cookieHeader = options.headers?.Cookie ?? "";
        
        const result = this.executeIDMHelper(url, referrer, cookieHeader, options.filename);
        return result.message || "Download task sent to IDM successfully";
    }
}
