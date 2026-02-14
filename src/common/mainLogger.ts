function formatArg(arg: unknown): string {
    if (arg instanceof Error) {
        return arg.stack ?? arg.message;
    }

    if (typeof arg === "string") {
        return arg;
    }

    try {
        return JSON.stringify(arg);
    } catch {
        return String(arg);
    }
}

function writeLine(stream: NodeJS.WriteStream, message: string, args: unknown[]): void {
    const suffix = args.length > 0 ? ` ${args.map(formatArg).join(" ")}` : "";
    stream.write(`${message}${suffix}\n`);
}

export function logMain(message: string, ...args: unknown[]): void {
    try {
        writeLine(process.stdout, message, args);
    } catch {
        // no-op
    }
    console.log(message, ...args);
}

export function logMainError(message: string, ...args: unknown[]): void {
    try {
        writeLine(process.stderr, message, args);
    } catch {
        // no-op
    }
    console.error(message, ...args);
}
