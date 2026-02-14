import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
    BrowserWindow,
    type BrowserWindowConstructorOptions,
    type DownloadItem,
    type MessageBoxOptions,
    app,
    dialog,
    nativeImage,
    shell,
} from "electron";
import contextMenu from "electron-context-menu";
import { firstRun, getConfig, setConfig } from "../common/config.js";
import { navigateTo } from "../common/dom.js";
import { forceQuit, setForceQuit } from "../common/forceQuit.js";
import { getLang } from "../common/lang.js";
import { initQuickCss, injectThemesMain } from "../common/themes.js";
import { getWindowState, setWindowState } from "../common/windowState.js";
import { init } from "../main.js";
import { registerGlobalKeybinds } from "./globalKeybinds.js";
import { createGopeedTask } from "./gopeed.js";
import { registerIpc } from "./ipc.js";
import { setMenu } from "./menu.js";
import { startRPC, stopRPC } from "./rpcProcess.js";
import { registerCustomHandler } from "./screenshare.js";
import { mainTouchBar } from "./touchbar.js";
import { createTray, tray } from "./tray.js";
import { registerVenmicIpc } from "./venmic.js";
export let mainWindows: BrowserWindow[] = [];
export let inviteWindow: BrowserWindow;
let gopeedHandlerRegistered = false;
const gopeedBypassUrls = new Set<string>();
const DISCORD_DOWNLOAD_HOSTS = new Set(["cdn.discordapp.com", "cdn.discordapp.net", "media.discordapp.net"]);
const DOWNLOAD_FILE_EXTENSION_RE =
    /(\.zip|\.rar|\.7z|\.tar|\.gz|\.exe|\.msi|\.deb|\.rpm|\.dmg|\.pkg|\.apk|\.iso|\.pdf|\.mp3|\.mp4|\.mkv|\.mov|\.wav|\.flac|\.png|\.jpg|\.jpeg|\.gif|\.webp|\.txt|\.csv|\.json)$/i;
const DANGEROUS_DOWNLOAD_EXTENSION_RE = /(\.exe|\.msi|\.bat|\.cmd|\.scr|\.com|\.pif|\.ps1|\.jar|\.vbs|\.wsf|\.reg|\.apk|\.appimage|\.dmg|\.pkg)$/i;

interface GopeedRouteDecision {
    shouldRoute: boolean;
    reason: string;
}

function isHttpUrl(url: string): boolean {
    const lowerUrl = url.toLowerCase();
    return lowerUrl.startsWith("http://") || lowerUrl.startsWith("https://");
}

function isGopeedEnabled(): boolean {
    const gopeed = getConfig("gopeed") as { enabled?: unknown } | undefined;
    return gopeed?.enabled === true;
}

function getDownloadUrl(item: DownloadItem): string {
    const chain = item.getURLChain();
    return chain.at(-1) ?? item.getURL();
}

function isPotentiallyDangerousDownload(url: string, filename?: string): boolean {
    if (filename && DANGEROUS_DOWNLOAD_EXTENSION_RE.test(filename.toLowerCase())) {
        return true;
    }

    try {
        const parsed = new URL(url);
        const lowerPath = decodeURIComponent(parsed.pathname).toLowerCase();
        if (DANGEROUS_DOWNLOAD_EXTENSION_RE.test(lowerPath)) {
            return true;
        }

        const queryFilename =
            parsed.searchParams.get("filename") ??
            parsed.searchParams.get("file") ??
            parsed.searchParams.get("name") ??
            "";

        return queryFilename.length > 0 && DANGEROUS_DOWNLOAD_EXTENSION_RE.test(queryFilename.toLowerCase());
    } catch {
        return false;
    }
}

async function confirmGopeedDownload(passedWindow: BrowserWindow, url: string, filename?: string): Promise<boolean> {
    if (!isPotentiallyDangerousDownload(url, filename)) {
        return true;
    }

    const options: MessageBoxOptions = {
        type: "warning",
        buttons: [getLang("dialog-gopeedDangerous-close"), getLang("dialog-gopeedDangerous-continue")],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
        title: getLang("dialog-gopeedDangerous-title"),
        message: getLang("dialog-gopeedDangerous-message"),
        detail: getLang("dialog-gopeedDangerous-detail"),
    };

    const { response } = await dialog.showMessageBox(passedWindow, options);
    return response === 1;
}

function bringGopeedToFront(): void {
    void shell.openExternal("gopeed://").catch(() => undefined);
}

function normalizeGopeedHost(host: unknown): string {
    const trimmed = typeof host === "string" ? host.trim() : "";
    if (!trimmed) {
        return "http://127.0.0.1:9999";
    }

    const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
    const withoutTrailingSlash = withProtocol.replace(/\/+$/, "");
    return withoutTrailingSlash.replace(/\/api\/v1(?:\/tasks)?$/i, "");
}

function canUseGopeedDeepLink(): boolean {
    const gopeed = getConfig("gopeed") as { host?: unknown } | undefined;
    try {
        const host = normalizeGopeedHost(gopeed?.host);
        const parsed = new URL(host);
        const hostname = parsed.hostname.toLowerCase();
        return hostname === "127.0.0.1" || hostname === "localhost";
    } catch {
        return false;
    }
}

function buildGopeedCreateDeepLink(url: string, headers: Record<string, string>, filename?: string): string {
    const req =
        Object.keys(headers).length > 0
            ? {
                  url,
                  extra: {
                      header: headers,
                  },
              }
            : {
                  url,
              };

    const payload = filename
        ? {
              req,
              opts: {
                  name: filename,
              },
          }
        : {
              req,
          };

    const encodedParams = (globalThis as unknown as {
        Buffer: { from(input: string, encoding: string): { toString(encoding: string): string } };
    }).Buffer
        .from(JSON.stringify(payload), "utf8")
        .toString("base64");
    return `gopeed:///create?params=${encodeURIComponent(encodedParams)}`;
}

async function queueGopeedDownload(passedWindow: BrowserWindow, url: string, filename?: string): Promise<boolean> {
    const approved = await confirmGopeedDownload(passedWindow, url, filename);
    if (!approved) {
        return false;
    }

    const headers = await buildGopeedRequestHeaders(passedWindow, url);
    if (canUseGopeedDeepLink()) {
        try {
            const deepLink = buildGopeedCreateDeepLink(url, headers, filename);
            await shell.openExternal(deepLink);
            return true;
        } catch {
            // fallback to REST API path below
        }
    }

    const taskOptions = filename
        ? {
              filename,
              headers,
          }
        : {
              headers,
          };
    await createGopeedTask(url, taskOptions);
    bringGopeedToFront();
    return true;
}

async function buildGopeedRequestHeaders(passedWindow: BrowserWindow, url: string): Promise<Record<string, string>> {
    const headers: Record<string, string> = {};

    const userAgent = passedWindow.webContents.userAgent;
    if (typeof userAgent === "string" && userAgent.length > 0) {
        headers["User-Agent"] = userAgent;
    }

    const currentUrl = passedWindow.webContents.getURL();
    if (isHttpUrl(currentUrl)) {
        headers.Referer = currentUrl;
    }

    try {
        const cookies = await passedWindow.webContents.session.cookies.get({ url });
        if (cookies.length > 0) {
            headers.Cookie = cookies
                .map((cookie: { name: string; value: string }) => `${cookie.name}=${cookie.value}`)
                .join("; ");
        }
    } catch {
        // best-effort header collection
    }

    return headers;
}

function registerGopeedHandler(passedWindow: BrowserWindow): void {
    if (gopeedHandlerRegistered) {
        return;
    }

    gopeedHandlerRegistered = true;
    passedWindow.webContents.session.on("will-download", (event, item, webContents) => {
        const sourceUrl = getDownloadUrl(item);
        if (!sourceUrl) {
            return;
        }

        if (gopeedBypassUrls.has(sourceUrl)) {
            gopeedBypassUrls.delete(sourceUrl);
            return;
        }

        if (!isGopeedEnabled()) {
            return;
        }

        if (!isHttpUrl(sourceUrl)) {
            return;
        }

        event.preventDefault();
        item.cancel();

        void (async () => {
            try {
                const queued = await queueGopeedDownload(passedWindow, sourceUrl, item.getFilename());
                if (!queued) {
                    return;
                }
            } catch {
                gopeedBypassUrls.add(sourceUrl);
                if (!webContents.isDestroyed()) {
                    webContents.downloadURL(sourceUrl);
                }
            }
        })();

        return;
    });
}

function getGopeedRouteDecision(url: string): GopeedRouteDecision {
    try {
        const parsed = new URL(url);
        const hostname = parsed.hostname.toLowerCase();
        const lowerPath = parsed.pathname.toLowerCase();

        if (lowerPath.includes("/attachments/") || DISCORD_DOWNLOAD_HOSTS.has(hostname)) {
            return { shouldRoute: true, reason: "discord-attachment-or-cdn-host" };
        }

        if (
            parsed.searchParams.has("download") ||
            parsed.searchParams.has("response-content-disposition") ||
            parsed.searchParams.has("filename")
        ) {
            return { shouldRoute: true, reason: "download-query-parameter" };
        }

        if (DOWNLOAD_FILE_EXTENSION_RE.test(lowerPath)) {
            return { shouldRoute: true, reason: "download-like-file-extension" };
        }

        return { shouldRoute: false, reason: "no-download-pattern-match" };
    } catch {
        return { shouldRoute: false, reason: "invalid-url" };
    }
}

contextMenu({
    showSaveImageAs: true,
    showCopyImageAddress: true,
    showSearchWithGoogle: false,
    prepend: (_defaultActions, parameters) => [
        {
            label: getLang("contextMenu-searchGoogle"),
            // Only show it when right-clicking text
            visible: parameters.selectionText.trim().length > 0,
            click: () => {
                void shell.openExternal(`https://google.com/search?q=${encodeURIComponent(parameters.selectionText)}`);
            },
        },
        {
            label: getLang("contextMenu-searchDuckDuckGo"),
            // Only show it when right-clicking text
            visible: parameters.selectionText.trim().length > 0,
            click: () => {
                void shell.openExternal(`https://duckduckgo.com/?q=${encodeURIComponent(parameters.selectionText)}`);
            },
        },
    ],
});
function doAfterDefiningTheWindow(passedWindow: BrowserWindow): void {
    const openExternalWithReason = (url: string): void => {
        void shell.openExternal(url);
    };

    createTray();
    if (getWindowState("isMaximized") ?? false) {
        passedWindow.setSize(835, 600); //just so the whole thing doesn't cover whole screen
        passedWindow.maximize();
        void passedWindow.webContents.executeJavaScript(`document.body.setAttribute("isMaximized", "");`);
        passedWindow.hide(); // please don't flashbang the user
    }

    // REVIEW - Test the protocol warning. I was not sure how to get it to pop up. For now I've voided the promises.

    const ignoreProtocolWarning = getConfig("ignoreProtocolWarning");
    registerIpc(passedWindow);
    registerVenmicIpc();
    if (getConfig("mobileMode")) {
        passedWindow.webContents.userAgent =
            "Mozilla/5.0 (Linux; Android 6.0; Nexus 5 Build/MRA58N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/102.0.5005.149 Mobile Safari/537.36";
    } else {
        let osType = process.platform === "darwin" ? "Macintosh" : process.platform === "win32" ? "Windows" : "Linux";
        if (osType === "Linux") osType = `X11; ${osType}`;
        const chromeVersion = process.versions.chrome;
        const userAgent = `Mozilla/5.0 (${osType} ${os.arch()}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;
        passedWindow.webContents.userAgent = userAgent;
    }
    if (mainWindows.length === 1) {
        app.on("second-instance", (_event, commandLine, _workingDirectory, additionalData) => {
            void (async () => {
                // Print out data received from the second instance.
                console.log(additionalData);

                if (!getConfig("multiInstance")) {
                    // Someone tried to run a second instance, we should focus our window.
                    if (passedWindow) {
                        if (passedWindow.isMinimized()) passedWindow.restore();
                        passedWindow.show();
                        passedWindow.focus();
                    }
                    if (commandLine && commandLine.length > 0) {
                        console.log(commandLine);
                        const lastArg = commandLine.pop();
                        if (lastArg?.startsWith("discord://-")) {
                            navigateTo(passedWindow, lastArg.replace("discord://-", ""));
                        }
                    }
                } else {
                    await init();
                }
            })();
        });
    }
    app.on("activate", async () => {
        app.show();
    });
    passedWindow.webContents.on("frame-created", (_, { frame }) => {
        if (!frame) {
            return;
        }
        frame.once("dom-ready", async () => {
            if (
                frame.url.includes("youtube.com/embed/") ||
                (frame.url.includes("discordsays") && frame.url.includes("youtube.com"))
            ) {
                await frame.executeJavaScript(readFileSync(path.join(__dirname, "assets/js/adguard.js"), "utf-8"));
            }
        });
    });
    passedWindow.webContents.setWindowOpenHandler(({ url }) => {
        // Allow about:blank (used by Vencord & Equicord QuickCss popup)
        if (url === "about:blank") return { action: "allow" };
        // Saving ics files on future events
        if (url.startsWith("blob:https://discord.com/")) {
            return {
                action: "allow",
                overrideBrowserWindowOptions: { show: false },
            };
        }
        // Allow Discord stream popout
        if (
            url === "https://discord.com/popout" ||
            url === "https://canary.discord.com/popout" ||
            url === "https://ptb.discord.com/popout"
        )
            return {
                action: "allow",
                overrideBrowserWindowOptions: {
                    alwaysOnTop: getConfig("popoutPiP"),
                },
            };
        const isHttpOrHttps = isHttpUrl(url);
        const routeDecision = isHttpOrHttps
            ? getGopeedRouteDecision(url)
            : { shouldRoute: false, reason: "non-http-url" };
        if (
            isHttpOrHttps &&
            isGopeedEnabled() &&
            routeDecision.shouldRoute
        ) {
            void (async () => {
                try {
                    await queueGopeedDownload(passedWindow, url);
                } catch {
                    openExternalWithReason(url);
                }
            })();
        } else if (isHttpOrHttps && isGopeedEnabled() && !routeDecision.shouldRoute) {
            openExternalWithReason(url);
        } else if (isHttpOrHttps || url.startsWith("mailto:")) {
            openExternalWithReason(url);
        } else if (ignoreProtocolWarning) {
            openExternalWithReason(url);
        } else {
            const options: MessageBoxOptions = {
                type: "question",
                buttons: [getLang("dialog-openUrl-yes"), getLang("dialog-openUrl-no")],
                defaultId: 1,
                title: getLang("dialog-openUrl-title"),
                message: getLang("dialog-openUrl-message").replace("{url}", url),
                detail: getLang("dialog-openUrl-detail"),
                checkboxLabel: getLang("dialog-openUrl-checkbox"),
                checkboxChecked: false,
            };

            void dialog.showMessageBox(passedWindow, options).then(({ response, checkboxChecked }) => {
                console.log(response, checkboxChecked);
                if (checkboxChecked) {
                    if (response === 0) {
                        setConfig("ignoreProtocolWarning", true);
                    } else {
                        setConfig("ignoreProtocolWarning", false);
                    }
                }
                if (response === 0) {
                    openExternalWithReason(url);
                }
            });
        }

        return { action: "deny" };
    });

    passedWindow.webContents.on("will-navigate", (event, url) => {
        if (!isHttpUrl(url)) {
            return;
        }

        if (!isGopeedEnabled()) {
            return;
        }

        const routeDecision = getGopeedRouteDecision(url);
        if (!routeDecision.shouldRoute) {
            return;
        }
        event.preventDefault();
        void (async () => {
            try {
                await queueGopeedDownload(passedWindow, url);
            } catch {
                openExternalWithReason(url);
            }
        })();
    });

    passedWindow.webContents.session.setSpellCheckerLanguages(getConfig("spellcheckLanguage"));
    registerGopeedHandler(passedWindow);

    registerCustomHandler();

    const blockedPatterns = [
        /https:\/\/.*\/api\/v\d+\/science/,
        /https:\/\/sentry\.io\/.*/,
        /https:\/\/.*\.nel\.cloudflare\.com\/.*/,
    ];

    passedWindow.webContents.session.webRequest.onBeforeRequest((details, callback) => {
        if (details.url.includes("ws://127.0.0.1:")) {
            return callback({ cancel: true });
        }

        if (blockedPatterns.some((pattern) => pattern.test(details.url))) {
            return callback({ cancel: true });
        }

        return callback({});
    });

    passedWindow.webContents.session.webRequest.onBeforeSendHeaders((details, callback) => {
        if (details.url.startsWith("https://www.youtube.com/embed/")) {
            details.requestHeaders.Referer = "https://google.com";
        }

        callback({ requestHeaders: details.requestHeaders });
    });

    // fix UMG video playback handled in unified onBeforeSendHeaders above
    if (getConfig("tray") === "dynamic") {
        passedWindow.webContents.on("page-favicon-updated", (_, favicons) => {
            try {
                let favicon = nativeImage.createFromDataURL(favicons[0]);

                switch (process.platform) {
                    case "darwin":
                        favicon = favicon.resize({ height: 22 });
                        break;
                    case "win32":
                        favicon = favicon.resize({ height: 32 });
                        break;
                }

                tray.setImage(favicon);
            } catch {
                return;
            }
        });
    }
    initQuickCss(passedWindow);
    passedWindow.setTouchBar(mainTouchBar);
    app.on("open-url", (_event, url) => {
        navigateTo(passedWindow, url.replace("discord://-", ""));
    });

    passedWindow.webContents.on("page-title-updated", (e, title) => {
        const legcordSuffix = " - Legcord"; /* identify */
        const unreadMessages = getLang("title-unreadMessages");

        // FIXME - This is a bit of a mess. I'm not sure how to clean it up.
        if (process.platform === "win32") {
            if (title.startsWith("•"))
                return passedWindow.setOverlayIcon(
                    nativeImage.createFromPath(path.join(import.meta.dirname, "../", "/assets/badge-11.ico")),
                    unreadMessages,
                );
            if (title.startsWith("(")) {
                const pings = Number.parseInt(/\((\d+)\)/.exec(title)![1]);
                if (pings > 9) {
                    return passedWindow.setOverlayIcon(
                        nativeImage.createFromPath(path.join(import.meta.dirname, "../", "/assets/badge-10.ico")),
                        unreadMessages,
                    );
                } else {
                    return passedWindow.setOverlayIcon(
                        nativeImage.createFromPath(path.join(import.meta.dirname, "../", `/assets/badge-${pings}.ico`)),
                        unreadMessages,
                    );
                }
            }
            passedWindow.setOverlayIcon(null, "");
        }
        if (process.platform === "darwin") {
            if (title.startsWith("•")) return app.dock?.setBadge("•");
            if (title.startsWith("(")) {
                if (getConfig("bounceOnPing")) app.dock?.bounce();
                return app.setBadgeCount(Number.parseInt(/\((\d+)\)/.exec(title)![1]));
            }
            app.setBadgeCount(0);
        }
        if (!title.endsWith(legcordSuffix)) {
            e.preventDefault();
            void passedWindow.webContents.executeJavaScript(
                `document.title = '${title.replace("Discord |", "") + legcordSuffix}'`,
            );
        }
    });
    injectThemesMain(passedWindow);
    passedWindow.on("unresponsive", () => {
        passedWindow.webContents.reload();
    });

    setMenu();
    passedWindow.on("close", (e) => {
        if (mainWindows.length > 1) {
            mainWindows = mainWindows.filter((mainWindow) => mainWindow.id !== passedWindow.id);
            passedWindow.destroy();
        }
        if (getConfig("minimizeToTray") && !forceQuit) {
            e.preventDefault();
            passedWindow.hide();
        } else if (!getConfig("minimizeToTray")) {
            app.quit();
        }
    });
    app.on("before-quit", () => {
        stopRPC();
        const [width, height] = passedWindow.getSize();
        setWindowState({
            width,
            height,
            isMaximized: passedWindow.isMaximized(),
            x: passedWindow.getPosition()[0],
            y: passedWindow.getPosition()[1],
        });
        setForceQuit(true);
    });
    passedWindow.on("focus", () => {
        void passedWindow.webContents.executeJavaScript(`document.body.removeAttribute("unFocused");`);
    });
    passedWindow.on("blur", () => {
        void passedWindow.webContents.executeJavaScript(`document.body.setAttribute("unFocused", "");`);
    });

    passedWindow.on("maximize", () => {
        void passedWindow.webContents.executeJavaScript(`document.body.setAttribute("isMaximized", "");`);
    });
    passedWindow.on("unmaximize", () => {
        void passedWindow.webContents.executeJavaScript(`document.body.removeAttribute("isMaximized");`);
    });
    if (getConfig("inviteWebsocket") && mainWindows.length === 1) {
        startRPC(passedWindow);
    }
    if (firstRun) {
        passedWindow.close();
    }

    registerGlobalKeybinds();
    switch (getConfig("channel")) {
        case "stable":
            void passedWindow.loadURL("https://discord.com/app");
            break;
        case "canary":
            void passedWindow.loadURL("https://canary.discord.com/app");
            break;
        case "ptb":
            void passedWindow.loadURL("https://ptb.discord.com/app");
            break;
        default:
            void passedWindow.loadURL("https://discord.com/app");
            break;
    }

    if (getConfig("skipSplash")) {
        passedWindow.show();
    }
}

export function createWindow() {
    const browserWindowOptions: BrowserWindowConstructorOptions = {
        width: getWindowState("width") ?? 835,
        height: getWindowState("height") ?? 600,
        x: getWindowState("x"),
        y: getWindowState("y"),
        title: "Legcord",
        show: false,
        darkTheme: true,
        icon: getConfig("customIcon") ?? path.join(import.meta.dirname, "../", "/assets/desktop.png"),
        frame: false,
        backgroundColor: "#202225",
        autoHideMenuBar: getConfig("autoHideMenuBar"),
        webPreferences: {
            sandbox: true,
            nodeIntegration: false,
            contextIsolation: true,
            backgroundThrottling: getConfig("sleepInBackground"),
            preload: path.join(import.meta.dirname, "discord/preload.mjs"),
            spellcheck: getConfig("spellcheck"),
        },
    };
    switch (getConfig("windowStyle")) {
        case "default":
            if (os.platform() === "win32") {
                browserWindowOptions.titleBarStyle = "hidden";
                browserWindowOptions.titleBarOverlay = false;
            }
            break;
        case "native":
            browserWindowOptions.frame = true;
            break;
        case "overlay":
            browserWindowOptions.titleBarStyle = "hidden";
            browserWindowOptions.titleBarOverlay = {
                color: getConfig("overlayButtonColor"),
                symbolColor: "#99aab5",
                height: 30,
            };
            browserWindowOptions.trafficLightPosition = {
                x: 10,
                y: 10,
            };
            break;
    }
    switch (getConfig("transparency")) {
        case "universal":
            browserWindowOptions.backgroundColor = "#00000000";
            browserWindowOptions.transparent = true;
            break;
        case "modern":
            if (os.platform() === "win32") {
                browserWindowOptions.backgroundColor = "#00000000";
                browserWindowOptions.transparent = false;
                browserWindowOptions.frame = true;
                browserWindowOptions.backgroundMaterial = "acrylic";
            } else if (os.platform() === "darwin") {
                browserWindowOptions.backgroundColor = "#00000000";
                browserWindowOptions.vibrancy = "fullscreen-ui";
                browserWindowOptions.transparent = true;
            }
            break;
        case "none":
            break;
    }
    const mainWindow = new BrowserWindow(browserWindowOptions);
    mainWindows.push(mainWindow);
    doAfterDefiningTheWindow(mainWindow);
}
