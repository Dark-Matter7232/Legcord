/**
 * Tracks all Chrome command-line flags and features applied during startup
 */

interface CommandLineFlags {
    switches: Record<string, string | boolean>;
    enableFeatures: string[];
    disableFeatures: string[];
    enableBlinkFeatures: string[];
    disableBlinkFeatures: string[];
}

let appliedFlags: CommandLineFlags = {
    switches: {},
    enableFeatures: [],
    disableFeatures: [],
    enableBlinkFeatures: [],
    disableBlinkFeatures: [],
};

export function trackSwitch(key: string, value?: string): void {
    appliedFlags.switches[key] = value === undefined ? true : value;
}

export function trackEnableFeatures(features: string[]): void {
    appliedFlags.enableFeatures.push(...features);
}

export function trackDisableFeatures(features: string[]): void {
    appliedFlags.disableFeatures.push(...features);
}

export function trackEnableBlinkFeatures(features: string[]): void {
    appliedFlags.enableBlinkFeatures.push(...features);
}

export function trackDisableBlinkFeatures(features: string[]): void {
    appliedFlags.disableBlinkFeatures.push(...features);
}

export function getAppliedFlags(): CommandLineFlags {
    return appliedFlags;
}

export function dumpFlags(): void {
    console.log("===========================================");
    console.log("   APPLIED CHROME COMMAND-LINE FLAGS");
    console.log("===========================================");
    console.log("\nSwitches:");
    console.log(JSON.stringify(appliedFlags.switches, null, 2));
    console.log("\nEnabled Features:");
    console.log(JSON.stringify([...new Set(appliedFlags.enableFeatures)], null, 2));
    console.log("\nDisabled Features:");
    console.log(JSON.stringify([...new Set(appliedFlags.disableFeatures)], null, 2));
    console.log("\nEnabled Blink Features:");
    console.log(JSON.stringify([...new Set(appliedFlags.enableBlinkFeatures)], null, 2));
    console.log("\nDisabled Blink Features:");
    console.log(JSON.stringify([...new Set(appliedFlags.disableBlinkFeatures)], null, 2));
    console.log("===========================================");
}
