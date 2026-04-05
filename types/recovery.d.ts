declare const MACRO: {
  BUILD_TIME: string;
  FEEDBACK_CHANNEL: string;
  ISSUES_EXPLAINER: string;
  NATIVE_PACKAGE_URL: string | null;
  PACKAGE_URL: string;
  VERSION: string;
  VERSION_CHANGELOG: string | null;
};

declare module 'bun:bundle' {
  export function feature(name: string): boolean;
}

declare module 'bun:ffi' {
  export type FFIFunction = (...args: unknown[]) => unknown;
  export const FFIType: Record<string, unknown>;
  export function dlopen(
    library: string,
    symbols: Record<string, unknown>,
  ): {
    symbols: Record<string, FFIFunction>;
    close: () => void;
  };
}

// type-fest stubs
declare module 'type-fest' {
  export type Except<T, K extends keyof T> = Pick<T, Exclude<keyof T, K>>;
  export type IsEqual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
}

// @ant/computer-use-mcp stubs
declare module '@ant/computer-use-mcp' {
  export const API_RESIZE_PARAMS: { width: number; height: number };
  export function targetImageSize(width: number, height: number): { width: number; height: number };
  export function buildComputerUseTools(options?: unknown): unknown[];
  export function bindSessionContext(context: ComputerUseSessionContext): unknown;
  export const DEFAULT_GRANT_FLAGS: Record<string, boolean>;

  export interface ComputerUseSessionContext {
    [key: string]: unknown;
  }
  export interface CuCallToolResult {
    [key: string]: unknown;
  }
  export interface CuPermissionRequest {
    toolName: string;
    input: Record<string, unknown>;
    [key: string]: unknown;
  }
  export interface CuPermissionResponse {
    behavior: 'allow' | 'deny';
    [key: string]: unknown;
  }
  export interface ScreenshotDims {
    width: number;
    height: number;
  }
}

declare module '@ant/computer-use-mcp/types' {
  export type CoordinateMode = 'absolute' | 'relative';
  export interface CuSubGates {
    [key: string]: boolean;
  }
  export interface CuPermissionRequest {
    toolName: string;
    input: Record<string, unknown>;
    [key: string]: unknown;
  }
  export interface CuPermissionResponse {
    behavior: 'allow' | 'deny';
    [key: string]: unknown;
  }
  export const DEFAULT_GRANT_FLAGS: Record<string, boolean>;
}

declare module '@ant/computer-use-mcp/sentinelApps' {
  export function getSentinelCategory(appName: string): string | undefined;
}

// @ant/computer-use-input stubs
declare module '@ant/computer-use-input' {
  export interface ComputerUseInput {
    [key: string]: unknown;
  }
  export interface ComputerUseInputAPI {
    key(k: string): Promise<void>;
    keys(ks: string[]): Promise<void>;
    click(x: number, y: number, button?: string): Promise<void>;
    moveMouse(x: number, y: number): Promise<void>;
    drag(fromX: number, fromY: number, toX: number, toY: number): Promise<void>;
    scroll(x: number, y: number, dx: number, dy: number): Promise<void>;
    type(text: string): Promise<void>;
    getFrontmostApp(): Promise<string>;
    [key: string]: unknown;
  }
}

// @ant/computer-use-swift stubs
declare module '@ant/computer-use-swift' {
  export interface ComputerUseAPI {
    screenshot(options?: unknown): Promise<Buffer>;
    [key: string]: unknown;
  }
}

// @ant/claude-for-chrome-mcp stubs
declare module '@ant/claude-for-chrome-mcp' {
  export const BROWSER_TOOLS: string[];
}

// Native module stubs
declare module 'image-processor-napi' {
  export function getNativeModule(): unknown;
  export function processImage(input: Buffer | string, options?: unknown): Promise<Buffer>;
  export default function(input: unknown, options?: unknown): Promise<unknown>;
}

declare module 'audio-capture-napi' {
  export function startCapture(options?: unknown): unknown;
  export function stopCapture(): void;
  export function getDevices(): unknown[];
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
  export function diffChars(oldStr: string, newStr: string): ColorDiffResult[];
  export function diffWords(oldStr: string, newStr: string): ColorDiffResult[];
  export function diffLines(oldStr: string, newStr: string): ColorDiffResult[];
}
