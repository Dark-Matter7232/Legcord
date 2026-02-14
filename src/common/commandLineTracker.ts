/**
 * Tracks all Chrome command-line flags and features applied during startup
 * Uses Map and Set for efficient O(1) lookups and automatic deduplication
 */

// Serializable output format
export interface AppliedFlagsOutput {
    switches: Record<string, string | boolean>;
    enableFeatures: string[];
    disableFeatures: string[];
    enableBlinkFeatures: string[];
    disableBlinkFeatures: string[];
}

// Internal storage using Map for O(1) performance
class FlagTracker {
    private switches: Map<string, string | boolean> = new Map();
    private enableFeatures: Set<string> = new Set();
    private disableFeatures: Set<string> = new Set();
    private enableBlinkFeatures: Set<string> = new Set();
    private disableBlinkFeatures: Set<string> = new Set();

    trackSwitch(key: string, value?: string): void {
        this.switches.set(key, value === undefined ? true : value);
    }

    trackEnableFeatures(features: string[]): void {
        features.forEach(f => this.enableFeatures.add(f));
    }

    trackDisableFeatures(features: string[]): void {
        features.forEach(f => this.disableFeatures.add(f));
    }

    trackEnableBlinkFeatures(features: string[]): void {
        features.forEach(f => this.enableBlinkFeatures.add(f));
    }

    trackDisableBlinkFeatures(features: string[]): void {
        features.forEach(f => this.disableBlinkFeatures.add(f));
    }

    /**
     * Get serializable flags (doesn't expose internal mutable structures)
     */
    getFlags(): AppliedFlagsOutput {
        return {
            switches: Object.fromEntries(this.switches),
            enableFeatures: Array.from(this.enableFeatures),
            disableFeatures: Array.from(this.disableFeatures),
            enableBlinkFeatures: Array.from(this.enableBlinkFeatures),
            disableBlinkFeatures: Array.from(this.disableBlinkFeatures),
        };
    }

    /**
     * Dump flags to console with pretty formatting
     */
    dumpFlags(): void {
        const flags = this.getFlags();
        console.log("===========================================\n   APPLIED CHROME COMMAND-LINE FLAGS\n===========================================");
        console.log(JSON.stringify(flags, null, 2));
        console.log("===========================================");
    }

    /**
     * Clear all tracking data to free memory
     */
    clear(): void {
        this.switches.clear();
        this.enableFeatures.clear();
        this.disableFeatures.clear();
        this.enableBlinkFeatures.clear();
        this.disableBlinkFeatures.clear();
    }
}

const tracker = new FlagTracker();

export function trackSwitch(key: string, value?: string): void {
    tracker.trackSwitch(key, value);
}

export function trackEnableFeatures(features: string[]): void {
    tracker.trackEnableFeatures(features);
}

export function trackDisableFeatures(features: string[]): void {
    tracker.trackDisableFeatures(features);
}

export function trackEnableBlinkFeatures(features: string[]): void {
    tracker.trackEnableBlinkFeatures(features);
}

export function trackDisableBlinkFeatures(features: string[]): void {
    tracker.trackDisableBlinkFeatures(features);
}

export function getAppliedFlags(): AppliedFlagsOutput {
    return tracker.getFlags();
}

export function dumpFlags(): void {
    tracker.dumpFlags();
}

export function clearTracking(): void {
    tracker.clear();
}
