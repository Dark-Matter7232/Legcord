import { getConfig } from "../common/config.js";

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
    return withProtocol.replace(/\/+$/, "");
}

export async function createGopeedTask(url: string, options: CreateGopeedTaskOptions = {}) {
    const gopeed = getConfig("gopeed") as { host?: unknown; token?: unknown } | undefined;
    const token = typeof gopeed?.token === "string" ? gopeed.token.trim() : "";
    const host = normalizeHost(gopeed?.host);
    const requestUrl = `${host}/api/v1/tasks`;

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

    const response = await fetch(requestUrl, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            ...(token ? { "X-Api-Token": token } : {}),
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(8_000),
    });

    if (!response.ok) {
        throw new Error(`Gopeed API returned HTTP ${response.status}`);
    }

    const json = (await response.json()) as GopeedApiResult<string>;
    if (json.code !== 0) {
        throw new Error(json.msg ?? json.message ?? "Unknown Gopeed API error");
    }

    return json.data;
}
