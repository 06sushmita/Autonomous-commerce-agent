/**
 * Modular MCP Transport Layer
 *
 * Supports:
 *  1. Remote HTTP/SSE MCP endpoints (Swiggy Builders Club / Zepto MCP)
 *  2. Stdio child processes (if configured for local MCP execution)
 *  3. Offline deterministic mock fixtures (for CI and development)
 *  4. Pluggable Transport Factory with zero-code-change switching
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { spawn, ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { McpToolDefinition } from './types.js';

export type McpTransportMode = 'remote_http' | 'stdio' | 'mock';

export interface McpTransportConfig {
  mode?: McpTransportMode;
  endpoint?: string;
  authToken?: string;
  timeoutMs?: number;
  useMockFallback?: boolean;
  // For Stdio transport
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  // For Mock transport
  initialTools?: string[];
}

export interface IMcpTransportAdapter {
  initialize(): Promise<void>;
  callTool<T = unknown>(toolName: string, args: Record<string, unknown>): Promise<T>;
  listTools(): Promise<string[]>;
  listToolDefinitions?(): Promise<McpToolDefinition[]>;
  close(): Promise<void>;
  getTransportType(): McpTransportMode;
  isConnected(): boolean;
}

/**
 * Remote HTTP / SSE MCP Transport using official @modelcontextprotocol/sdk Client
 */
export class RemoteHttpMcpTransport implements IMcpTransportAdapter {
  private client: Client | null = null;
  private mcpTransport: StreamableHTTPClientTransport | null = null;
  private endpoint: string;
  private authToken?: string;
  private timeoutMs: number;
  private connected = false;

  constructor(config: McpTransportConfig) {
    if (!config.endpoint) {
      throw new Error('RemoteHttpMcpTransport requires a valid endpoint URL');
    }
    this.endpoint = config.endpoint;
    this.authToken = config.authToken;
    this.timeoutMs = config.timeoutMs ?? 15000;
  }

  public async initialize(): Promise<void> {
    try {
      const headers: Record<string, string> = {
        'Accept': 'application/json, text/event-stream',
      };
      if (this.authToken) {
        headers['Authorization'] = this.authToken.startsWith('Bearer ')
          ? this.authToken
          : `Bearer ${this.authToken}`;
      }

      this.mcpTransport = new StreamableHTTPClientTransport(new URL(this.endpoint), {
        requestInit: { headers },
      });

      this.client = new Client({
        name: 'AutonomousCommerceAgent',
        version: '1.0.0',
      });

      await this.client.connect(this.mcpTransport);
      this.connected = true;
    } catch (err: any) {
      this.connected = false;
      const msg = String(err?.message || err);
      if (
        msg.includes('401') ||
        msg.includes('invalid_token') ||
        msg.toLowerCase().includes('unauthorized') ||
        msg.toLowerCase().includes('invalid token')
      ) {
        throw new Error(
          `Authentication failed for MCP endpoint at ${this.endpoint}: 401 Unauthorized or expired token. Run "npm run auth:zepto" to authenticate.`
        );
      }
      if (msg.toLowerCase().includes('timeout') || msg.toLowerCase().includes('timed out')) {
        throw new Error(`Connection to MCP endpoint at ${this.endpoint} timed out after ${this.timeoutMs}ms.`);
      }
      throw new Error(`Failed to connect to remote MCP endpoint at ${this.endpoint}: ${msg}`);
    }
  }

  public async callTool<T = unknown>(toolName: string, args: Record<string, unknown>): Promise<T> {
    if (!this.client || !this.connected) {
      try {
        await this.initialize();
      } catch (err: any) {
        throw new Error(`MCP client is not connected to ${this.endpoint}: ${err.message}`);
      }
    }

    try {
      const result = await this.client!.callTool({
        name: toolName,
        arguments: args,
      });
      return result as T;
    } catch (err: any) {
      const msg = String(err?.message || err);
      if (msg.includes('401') || msg.toLowerCase().includes('unauthorized')) {
        this.connected = false;
        throw new Error(
          `MCP tool call "${toolName}" failed due to authorization failure: 401 Unauthorized or expired token.`
        );
      }
      if (msg.toLowerCase().includes('timeout') || msg.toLowerCase().includes('timed out')) {
        throw new Error(`MCP tool call "${toolName}" timed out after ${this.timeoutMs}ms.`);
      }
      throw err;
    }
  }

  public async listTools(): Promise<string[]> {
    if (!this.client || !this.connected) {
      return [];
    }
    const tools = await this.client.listTools();
    return (tools?.tools || []).map((t) => t.name);
  }

  public async listToolDefinitions(): Promise<McpToolDefinition[]> {
    if (!this.client || !this.connected) {
      return [];
    }
    const res = await this.client.listTools();
    return (res?.tools || []).map((t) => ({
      name: t.name,
      description: t.description || '',
      parameters: (t.inputSchema as Record<string, unknown>) || { type: 'object', properties: {} },
    }));
  }

  public async close(): Promise<void> {
    try {
      await this.client?.close();
    } catch {}
    this.connected = false;
    this.client = null;
    this.mcpTransport = null;
  }

  public getTransportType(): McpTransportMode {
    return 'remote_http';
  }

  public isConnected(): boolean {
    return this.connected;
  }
}

/**
 * Local Stdio child process MCP Transport
 * Communicates via JSON-RPC 2.0 messages over stdin/stdout
 */
export class StdioMcpTransport implements IMcpTransportAdapter {
  private process: ChildProcess | null = null;
  private command: string;
  private args: string[];
  private cwd?: string;
  private env?: Record<string, string>;
  private connected = false;
  private nextRequestId = 1;
  private responseEmitter = new EventEmitter();
  private buffer = '';
  private timeoutMs: number;

  constructor(config: McpTransportConfig) {
    if (!config.command) {
      throw new Error('StdioMcpTransport requires a valid command');
    }
    this.command = config.command;
    this.args = config.args ?? [];
    this.cwd = config.cwd;
    this.env = config.env;
    this.timeoutMs = config.timeoutMs ?? 15000;
  }

  public async initialize(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.process = spawn(this.command, this.args, {
          cwd: this.cwd,
          env: { ...process.env, ...this.env },
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        this.process.stdout?.on('data', (chunk: Buffer) => {
          this.handleStdoutData(chunk);
        });

        this.process.stderr?.on('data', (data: Buffer) => {
          // Log stderr for debugging if needed
        });

        this.process.on('error', (err) => {
          this.connected = false;
          reject(new Error(`Stdio MCP process failed: ${err.message}`));
        });

        this.process.on('exit', () => {
          this.connected = false;
        });

        this.connected = true;
        resolve();
      } catch (err) {
        this.connected = false;
        reject(err);
      }
    });
  }

  private handleStdoutData(chunk: Buffer): void {
    this.buffer += chunk.toString('utf-8');
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const msg = JSON.parse(trimmed);
        if (msg.id !== undefined) {
          this.responseEmitter.emit(`response:${msg.id}`, msg);
        }
      } catch {
        // Non-JSON line ignored
      }
    }
  }

  private sendJsonRpc(method: string, params: Record<string, unknown>): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.process || !this.connected) {
        return reject(new Error('Stdio MCP transport is not connected'));
      }

      const id = this.nextRequestId++;
      const req = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';

      const timer = setTimeout(() => {
        this.responseEmitter.removeAllListeners(`response:${id}`);
        reject(new Error(`Stdio MCP request timed out after ${this.timeoutMs}ms for method ${method}`));
      }, this.timeoutMs);

      this.responseEmitter.once(`response:${id}`, (response: any) => {
        clearTimeout(timer);
        if (response.error) {
          reject(new Error(`MCP error ${response.error.code}: ${response.error.message}`));
        } else {
          resolve(response.result);
        }
      });

      this.process.stdin?.write(req);
    });
  }

  public async callTool<T = unknown>(toolName: string, args: Record<string, unknown>): Promise<T> {
    const res = await this.sendJsonRpc('tools/call', { name: toolName, arguments: args });
    return res as T;
  }

  public async listTools(): Promise<string[]> {
    const res = await this.sendJsonRpc('tools/list', {});
    return (res?.tools || []).map((t: any) => t.name);
  }

  public async listToolDefinitions(): Promise<McpToolDefinition[]> {
    const res = await this.sendJsonRpc('tools/list', {});
    return (res?.tools || []).map((t: any) => ({
      name: t.name,
      description: t.description || '',
      parameters: t.inputSchema || { type: 'object', properties: {} },
    }));
  }

  public async close(): Promise<void> {
    this.connected = false;
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
    this.responseEmitter.removeAllListeners();
  }

  public getTransportType(): McpTransportMode {
    return 'stdio';
  }

  public isConnected(): boolean {
    return this.connected;
  }
}

/**
 * Deterministic Mock MCP Transport for offline development & CI
 */
export class MockMcpTransport implements IMcpTransportAdapter {
  private handlers = new Map<string, (args: Record<string, unknown>) => Promise<unknown> | unknown>();
  private toolDefinitions = new Map<string, McpToolDefinition>();
  private connected = false;
  private simulatedLatencyMs = 0;
  private errorTriggers = new Map<string, string>();

  constructor(initialHandlers?: Record<string, (args: Record<string, unknown>) => Promise<unknown> | unknown>) {
    if (initialHandlers) {
      for (const [name, fn] of Object.entries(initialHandlers)) {
        this.handlers.set(name, fn);
      }
    }
  }

  public async initialize(): Promise<void> {
    this.connected = true;
  }

  public registerToolHandler(name: string, handler: (args: Record<string, unknown>) => Promise<unknown> | unknown): void {
    this.handlers.set(name, handler);
  }

  public registerToolDefinition(
    def: McpToolDefinition,
    handler?: (args: Record<string, unknown>) => Promise<unknown> | unknown
  ): void {
    this.toolDefinitions.set(def.name, def);
    if (handler) {
      this.handlers.set(def.name, handler);
    }
  }

  public setSimulatedLatency(ms: number): void {
    this.simulatedLatencyMs = ms;
  }

  public simulateError(toolName: string, errorMessage: string): void {
    this.errorTriggers.set(toolName, errorMessage);
  }

  public clearSimulatedError(toolName: string): void {
    this.errorTriggers.delete(toolName);
  }

  public async callTool<T = unknown>(toolName: string, args: Record<string, unknown>): Promise<T> {
    if (!this.connected) {
      throw new Error('Mock MCP transport is not connected');
    }

    if (this.simulatedLatencyMs > 0) {
      await new Promise((r) => setTimeout(r, this.simulatedLatencyMs));
    }

    const err = this.errorTriggers.get(toolName);
    if (err) {
      throw new Error(err);
    }

    const handler = this.handlers.get(toolName);
    if (!handler) {
      throw new Error(`Tool not found in mock MCP registry: ${toolName}`);
    }

    const result = await handler(args);
    return result as T;
  }

  public async listTools(): Promise<string[]> {
    return Array.from(this.handlers.keys());
  }

  public async listToolDefinitions(): Promise<McpToolDefinition[]> {
    const list: McpToolDefinition[] = [];
    for (const name of this.handlers.keys()) {
      if (this.toolDefinitions.has(name)) {
        list.push(this.toolDefinitions.get(name)!);
      } else {
        list.push({
          name,
          description: `Discovered MCP Tool ${name}`,
          parameters: { type: 'object', properties: {} },
        });
      }
    }
    return list;
  }

  public async close(): Promise<void> {
    this.connected = false;
  }

  public getTransportType(): McpTransportMode {
    return 'mock';
  }

  public isConnected(): boolean {
    return this.connected;
  }
}

/**
 * Factory creating the appropriate MCP transport adapter
 */
export class McpTransportFactory {
  public static createTransport(config: McpTransportConfig): IMcpTransportAdapter {
    const forcedMode = (process.env.MCP_TRANSPORT_MODE as McpTransportMode) || config.mode;

    if (forcedMode === 'mock') {
      return new MockMcpTransport();
    }

    if (forcedMode === 'stdio' && config.command) {
      return new StdioMcpTransport(config);
    }

    const isLiveRemote =
      config.endpoint &&
      !config.endpoint.includes('placeholder') &&
      !config.useMockFallback;

    if (isLiveRemote) {
      return new RemoteHttpMcpTransport(config);
    }

    // Default fallback to Mock
    return new MockMcpTransport();
  }
}
