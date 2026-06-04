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
    reason?: string;
    apps: Array<{
      requestedName: string;
      alreadyGranted?: boolean;
      resolved?: { bundleId: string; displayName: string };
    }>;
    requestedFlags: Record<string, boolean>;
    tccState?: { accessibility: boolean; screenRecording: boolean };
    [key: string]: any;
  }
  export interface CuPermissionResponse {
    behavior?: 'allow' | 'deny';
    granted: Array<{ bundleId: string; displayName: string; grantedAt: number }>;
    denied: Array<{ bundleId: string; reason: 'user_denied' | 'not_installed' }>;
    flags: Record<string, boolean>;
    [key: string]: any;
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
    reason?: string;
    apps: Array<{
      requestedName: string;
      alreadyGranted?: boolean;
      resolved?: { bundleId: string; displayName: string };
    }>;
    requestedFlags: Record<string, boolean>;
    tccState?: { accessibility: boolean; screenRecording: boolean };
    [key: string]: any;
  }
  export interface CuPermissionResponse {
    behavior?: 'allow' | 'deny';
    granted: Array<{ bundleId: string; displayName: string; grantedAt: number }>;
    denied: Array<{ bundleId: string; reason: 'user_denied' | 'not_installed' }>;
    flags: Record<string, boolean>;
    [key: string]: any;
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

declare module '@ant/computer-use-swift' {
  export interface ComputerUseAPI {
    screenshot(options?: unknown): Promise<Buffer>;
    [key: string]: unknown;
  }
}

declare module '@ant/claude-for-chrome-mcp' {
  export const BROWSER_TOOLS: string[];
  export type ClaudeForChromeContext = Record<string, unknown>;
  export type Logger = (...args: unknown[]) => void;
  export type PermissionMode = string;
  export function createClaudeForChromeMcpServer(options?: unknown): unknown;
}
