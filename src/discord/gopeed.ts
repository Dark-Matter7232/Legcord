import { getConfig } from "../common/config.js";

interface GopeedApiResult<T> {
    code: number;
    msg?: string;
    message?: string;
    data: T;
}

interface CreateGopeedTaskOptions {
    filename?: string;
    headers?: Record<string, string>;
    method?: "GET" | "POST";
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

    const json = parseGopeedApiResult(bodyText);
    if (json.code !== 0) {
        throw new Error(json.msg ?? json.message ?? "Unknown Gopeed API error");
    }

    return json.data;
}
