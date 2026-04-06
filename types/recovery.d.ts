declare const MACRO: {
  BUILD_TIME: string;
  FEEDBACK_CHANNEL: string;
  ISSUES_EXPLAINER: string;
  NATIVE_PACKAGE_URL: string | null;
  PACKAGE_URL: string;
  VERSION: string;
  VERSION_CHANGELOG: string | null;
};

// Allow importing .md files as string content (bundler handles this)
declare module '*.md' {
  const content: string;
  export default content;
}

// React namespace (needed for JSX type annotations like React.ReactNode)
declare namespace React {
  type ReactNode = any;
  type ReactElement = any;
  type FC<P = {}> = (props: P) => ReactElement | null;
  type ComponentType<P = {}> = FC<P> | (new (props: P) => any);
  type RefObject<T> = { current: T | null };
  type MutableRefObject<T> = { current: T };
  type Ref<T> = RefObject<T> | ((instance: T | null) => void) | null;
  type Key = string | number;
  type Dispatch<A> = (action: A) => void;
  type SetStateAction<S> = S | ((prevState: S) => S);
  type Context<T> = any;
  type Provider<T> = any;
  type Consumer<T> = any;
  interface CSSProperties { [key: string]: any }
  interface HTMLAttributes<T> { [key: string]: any }
  interface SVGAttributes<T> { [key: string]: any }
  interface DOMAttributes<T> { [key: string]: any }
  interface AriaAttributes { [key: string]: any }
  type PropsWithChildren<P = unknown> = P & { children?: ReactNode };
  type PropsWithRef<P> = P;
  type ElementRef<T> = any;
  type ComponentProps<T> = any;
  type MouseEvent<T = Element> = any;
  type KeyboardEvent<T = Element> = any;
  type ChangeEvent<T = Element> = any;
  type FormEvent<T = Element> = any;
  type FocusEvent<T = Element> = any;
  type SyntheticEvent<T = Element> = any;
  type JSXElementConstructor<P> = (props: P) => ReactElement | null;
}

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
  export function createComputerUseMcpServer(options?: unknown): unknown;
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
  export interface ComputerExecutor {
    [key: string]: unknown;
  }
  export interface DisplayGeometry {
    width: number;
    height: number;
    [key: string]: unknown;
  }
  export interface FrontmostApp {
    name: string;
    [key: string]: unknown;
  }
  export interface InstalledApp {
    name: string;
    [key: string]: unknown;
  }
  export interface ResolvePrepareCaptureResult {
    [key: string]: unknown;
  }
  export interface RunningApp {
    name: string;
    pid?: number;
    [key: string]: unknown;
  }
  export interface ScreenshotResult {
    data: Buffer;
    width: number;
    height: number;
    [key: string]: unknown;
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
  export interface ComputerUseHostAdapter {
    [key: string]: unknown;
  }
  export type Logger = (...args: unknown[]) => void;
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
  export type ClaudeForChromeContext = Record<string, unknown>;
  export type Logger = (...args: unknown[]) => void;
  export type PermissionMode = string;
  export function createClaudeForChromeMcpServer(options?: unknown): unknown;
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

// React compiler runtime (used by React Compiler in decompiled output)
declare module 'react/compiler-runtime' {
  export function c(size: number): any[];
}

// Bun global namespace
declare namespace Bun {
  function file(path: string): any;
  function write(path: string, data: any): Promise<number>;
  function spawn(cmd: string[], options?: any): any;
  function sleep(ms: number): Promise<void>;
  const env: Record<string, string | undefined>;
  const version: string;
}

// highlight.js missing exports
declare module 'highlight.js' {
  const hljs: {
    highlight(code: string, options: { language: string; ignoreIllegals?: boolean }): { value: string };
    highlightAuto(code: string): { value: string; language: string };
    listLanguages(): string[];
    getLanguage(name: string): any;
    registerLanguage(name: string, lang: any): void;
    [key: string]: any;
  };
  export default hljs;
}

// audio-capture-napi extended
declare module 'audio-capture-napi' {
  export function startCapture(options?: any): any;
  export function stopCapture(): void;
  export function getDevices(): any[];
  export function isSupported(): boolean;
  export function getDefaultDevice(): any;
  export const AudioCapture: any;
  export default function(options?: any): any;
}

// @anthropic-ai/mcpb augment for missing export
declare module '@anthropic-ai/mcpb' {
  export interface McpbUserConfigurationOption {
    title: string;
    description: string;
    type?: string;
    default?: unknown;
    required?: boolean;
    [key: string]: unknown;
  }
}
