export {};

declare global {
  interface Window {
    t?: (key: string, ...args: unknown[]) => string;
    compareVersions?: (v1: string, v2: string) => number;
    checkForUpdates?: () => Promise<void>;
    showVersionDisplay?: (version: string) => void;
    show?: (what: string) => string;
  }
}
