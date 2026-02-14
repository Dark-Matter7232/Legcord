import { getConfig } from "../common/config.js";
import { logMain, logMainError } from "../common/mainLogger.js";

interface GopeedApiResult<T> {
    code: number;
    msg?: string;
    message?: string;
    data: T;
}

interface CreateGopeedTaskOptions {
    filename?: string;
}

function normalizeHost(host: unknown): string {
    const trimmed = typeof host === "string" ? host.trim() : "";
    if (!trimmed) {
        return "http://127.0.0.1:9999";
    }

    const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
    const withoutTrailingSlash = withProtocol.replace(/\/+$/, "");
    return withoutTrailingSlash.replace(/\/api\/v1(?:\/tasks)?$/i, "");
}

function parseGopeedApiResult(bodyText: string): GopeedApiResult<string> {
    try {
        return JSON.parse(bodyText) as GopeedApiResult<string>;
    } catch {
        throw new Error(`Gopeed API returned non-JSON response: ${bodyText.slice(0, 300)}`);
    }
}

export async function createGopeedTask(url: string, options: CreateGopeedTaskOptions = {}) {
    const gopeed = getConfig("gopeed") as { host?: unknown; token?: unknown } | undefined;
    const token = typeof gopeed?.token === "string" ? gopeed.token.trim() : "";
    const host = normalizeHost(gopeed?.host);
    const requestUrl = `${host}/api/v1/tasks`;
    const startedAt = Date.now();

    logMain(
        `[Gopeed][debug] createGopeedTask request: url=${url} filename=${options.filename ?? "<none>"} host=${host} tokenSet=${token.length > 0}`,
    );

    const payload: {
        req: { url: string };
        opts?: { name?: string };
    } = options.filename
        ? {
              req: { url },
              opts: { name: options.filename },
          }
        : {
              req: { url },
          };

    let response: Response;
    try {
        response = await fetch(requestUrl, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                ...(token ? { "X-Api-Token": token } : {}),
            },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(8_000),
        });
    } catch (error) {
        logMainError(
            `[Gopeed][debug] createGopeedTask network error after ${Date.now() - startedAt}ms for ${requestUrl}:`,
            error,
        );
        throw error;
    }

    logMain(
        `[Gopeed][debug] createGopeedTask HTTP response: status=${response.status} ok=${response.ok} elapsedMs=${Date.now() - startedAt}`,
    );

    const bodyText = await response.text();
    logMain(`[Gopeed][debug] createGopeedTask response body (first 300 chars): ${bodyText.slice(0, 300)}`);
    if (!response.ok) {
        throw new Error(`Gopeed API returned HTTP ${response.status}: ${bodyText.slice(0, 300)}`);
    }

    const json = parseGopeedApiResult(bodyText);
    logMain(
        `[Gopeed][debug] createGopeedTask parsed API result: code=${json.code} message=${json.msg ?? json.message ?? "<none>"} data=${json.data ?? "<none>"}`,
    );
    if (json.code !== 0) {
        throw new Error(json.msg ?? json.message ?? "Unknown Gopeed API error");
    }

    return json.data;
}
