declare module 'image-processor-napi' {
  export function getNativeModule(): unknown;
  export function processImage(input: Buffer | string, options?: unknown): Promise<Buffer>;
  export default function(input: unknown, options?: unknown): Promise<unknown>;
}

declare module 'audio-capture-napi' {
  export function startCapture(options?: any): any;
  export function stopCapture(): void;
  export function getDevices(): any[];
  export function isSupported(): boolean;
  export function getDefaultDevice(): any;
  export const AudioCapture: any;
  export default function(options?: any): any;
}

declare module 'url-handler-napi' {
  export function waitForUrlEvent(options?: unknown): Promise<string>;
  export function registerProtocol(protocol: string): void;
}

declare module 'color-diff-napi' {
  export interface ColorDiffResult {
    added: boolean;
    removed: boolean;
    value: string;
  }
  export interface ColorDiff {
    [key: string]: unknown;
  }
  export interface ColorFile {
    content: string;
    path?: string;
    [key: string]: unknown;
  }
  export interface SyntaxTheme {
    [key: string]: string;
  }
  export function getSyntaxTheme(name?: string): SyntaxTheme;
  export function diffChars(oldStr: string, newStr: string): ColorDiffResult[];
  export function diffWords(oldStr: string, newStr: string): ColorDiffResult[];
  export function diffLines(oldStr: string, newStr: string): ColorDiffResult[];
}
