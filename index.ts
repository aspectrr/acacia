import { serve } from "bun";
import { extensionService } from "./db/client";
import type { Extension, ExtensionRoute } from "./db/schema";

interface ProxyConfig {
  targetUrl: string;
  port: number;
  applicationId: string;
}

interface LoadedExtension {
  id: string;
  name: string;
  code: string;
  routes: ExtensionRoute[];
  enabled: boolean;
  compiledHandler?: Function;
}

class ExtensionProxy {
  private targetUrl: string;
  private port: number;
  private applicationId: string;
  private extensionCache: Map<string, LoadedExtension> = new Map();
  private lastCacheUpdate: number = 0;
  private cacheRefreshInterval: number = 30000; // 30 seconds

  constructor(config: ProxyConfig) {
    this.targetUrl = config.targetUrl;
    this.port = config.port;
    this.applicationId = config.applicationId;
  }

  // Load extensions from database
  private async loadExtensions(): Promise<void> {
    try {
      const extensions = await extensionService.getActiveExtensions(this.applicationId);

      // Clear old cache
      this.extensionCache.clear();

      // Load and compile extensions
      for (const extension of extensions) {
        const loadedExtension: LoadedExtension = {
          id: extension.id,
          name: extension.name,
          code: extension.code,
          routes: extension.routes,
          enabled: extension.enabled,
        };

        // Compile the extension function safely
        try {
          loadedExtension.compiledHandler = this.compileExtensionCode(extension.code);
        } catch (error) {
          console.error(`[EXTENSION ERROR] Failed to compile ${extension.name}:`, error);
          continue;
        }

        this.extensionCache.set(extension.id, loadedExtension);
      }

      this.lastCacheUpdate = Date.now();
      console.log(`[EXTENSIONS] Loaded ${this.extensionCache.size} extensions`);
    } catch (error) {
      console.error('[EXTENSIONS] Failed to load extensions:', error);
    }
  }

  // Safely compile extension code
  private compileExtensionCode(code: string): Function {
    // Create a safe context for extension execution
    const safeContext = {
      console: {
        log: (...args: any[]) => console.log('[EXTENSION]', ...args),
        error: (...args: any[]) => console.error('[EXTENSION]', ...args),
      },
      JSON,
      Date,
      Math,
      setTimeout: (fn: Function, delay: number) => setTimeout(fn, Math.min(delay, 5000)), // Max 5s timeout
      fetch: async (url: string, options?: RequestInit) => {
        // Only allow specific domains or relative URLs for safety
        if (url.startsWith('/') || url.startsWith(this.targetUrl)) {
          return fetch(url, options);
        }
        throw new Error('External fetch not allowed in extensions');
      }
    };

    // Wrap the code in an async function
    const wrappedCode = `
      return (async function(request, response) {
        ${code}
      });
    `;

    // Create function with limited context
    const compiledFunction = new Function(
      'console', 'JSON', 'Date', 'Math', 'setTimeout', 'fetch',
      wrappedCode
    )(
      safeContext.console,
      safeContext.JSON,
      safeContext.Date,
      safeContext.Math,
      safeContext.setTimeout,
      safeContext.fetch
    );

    return compiledFunction;
  }

  // Get extensions that match a route with caching
  private async getExtensionsForRoute(method: string, path: string): Promise<LoadedExtension[]> {
    // Refresh cache if needed
    if (Date.now() - this.lastCacheUpdate > this.cacheRefreshInterval) {
      await this.loadExtensions();
    }

    const matchingExtensions: LoadedExtension[] = [];

    for (const extension of this.extensionCache.values()) {
      if (!extension.enabled || !extension.compiledHandler) continue;

      for (const route of extension.routes) {
        if (this.routeMatches(route, method, path)) {
          matchingExtensions.push(extension);
          break; // Extension already added, no need to check other routes
        }
      }
    }

    // Sort by priority
    return matchingExtensions.sort((a, b) => {
      const aPriority = Math.max(...a.routes.map(r => r.priority || 0));
      const bPriority = Math.max(...b.routes.map(r => r.priority || 0));
      return bPriority - aPriority;
    });
  }

  // Check if route matches request
  private routeMatches(route: ExtensionRoute, method: string, path: string): boolean {
    // Check method match
    if (route.method !== '*' && route.method !== method) {
      return false;
    }

    // Check path match based on pattern type
    switch (route.patternType) {
      case 'exact':
        return route.pathPattern === path;

      case 'prefix':
        return path.startsWith(route.pathPattern);

      case 'regex':
        try {
          const regex = new RegExp(route.pathPattern);
          return regex.test(path);
        } catch {
          return false;
        }

      default:
        return false;
    }
  }

  private async runBeforeExtensions(request: Request, route: { method: string; path: string }): Promise<Request> {
    let modifiedRequest = request;

    for (const extension of this.extensions) {
      if (!extension.enabled) continue;

      for (const routeHandler of extension.routes) {
        if (routeHandler.type !== 'before') continue;
        if (routeHandler.method !== route.method && routeHandler.method !== '*') continue;

        const pathMatches = typeof routeHandler.path === 'string'
          ? route.path === routeHandler.path
          : routeHandler.path.test(route.path);

        if (pathMatches) {
          console.log(`[EXTENSION] Running ${extension.name} (before) on ${route.method} ${route.path}`);
          try {
            const result = await routeHandler.handler(modifiedRequest);
            if (result instanceof Request) {
              modifiedRequest = result;
            }
          } catch (error) {
            console.error(`[EXTENSION ERROR] ${extension.name}:`, error);
          }
        }
      }
    }

    return modifiedRequest;
  }

  private async runAfterExtensions(request: Request, response: Response, route: { method: string; path: string }): Promise<Response> {
    let modifiedResponse = response;

    for (const extension of this.extensions) {
      if (!extension.enabled) continue;

      for (const routeHandler of extension.routes) {
        if (routeHandler.type !== 'after') continue;
        if (routeHandler.method !== route.method && routeHandler.method !== '*') continue;

        const pathMatches = typeof routeHandler.path === 'string'
          ? route.path === routeHandler.path
          : routeHandler.path.test(route.path);

        if (pathMatches) {
          console.log(`[EXTENSION] Running ${extension.name} (after) on ${route.method} ${route.path}`);
          try {
            const result = await routeHandler.handler(request, modifiedResponse);
            if (result instanceof Response) {
              modifiedResponse = result;
            }
          } catch (error) {
            console.error(`[EXTENSION ERROR] ${extension.name}:`, error);
          }
        }
      }
    }

    return modifiedResponse;
  }

  private async runReplaceExtensions(request: Request, route: { method: string; path: string }): Promise<Response | null> {
    for (const extension of this.extensions) {
      if (!extension.enabled) continue;

      for (const routeHandler of extension.routes) {
        if (routeHandler.type !== 'replace') continue;
        if (routeHandler.method !== route.method && routeHandler.method !== '*') continue;

        const pathMatches = typeof routeHandler.path === 'string'
          ? route.path === routeHandler.path
          : routeHandler.path.test(route.path);

        if (pathMatches) {
          console.log(`[EXTENSION] Running ${extension.name} (replace) on ${route.method} ${route.path}`);
          try {
            const result = await routeHandler.handler(request);
            if (result instanceof Response) {
              return result;
            }
          } catch (error) {
            console.error(`[EXTENSION ERROR] ${extension.name}:`, error);
          }
        }
      }
    }

    return null;
  }
    const url = new URL(request.url);

    // Build target URL by replacing the host/port but keeping the path and query
    const targetUrl = `${this.targetUrl}${url.pathname}${url.search}`;

    // Clone the request to forward it
    const forwardedRequest = new Request(targetUrl, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      // @ts-ignore - Bun supports duplex
      duplex: request.body ? "half" : undefined,
    });

    try {
      const response = await fetch(forwardedRequest);

      // Clone the response to modify headers if needed
      const clonedResponse = new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });

      // Add CORS headers to allow browser requests
      clonedResponse.headers.set('Access-Control-Allow-Origin', '*');
      clonedResponse.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      clonedResponse.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');

      return clonedResponse;
    } catch (error) {
      console.error('Proxy error:', error);
      return new Response('Proxy Error: Unable to reach target application', {
        status: 502,
        headers: { 'Content-Type': 'text/plain' },
      });
    }
  }

  async handleRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const route = {
      method: request.method,
      path: url.pathname
    };

    console.log(`[PROXY] ${request.method} ${url.pathname}`);

    // Handle preflight CORS requests
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 200,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        },
      });
    }

    // Check if any extension wants to completely replace this route
    const replacementResponse = await this.runExtensions(request, undefined, route, 'replace') as Response;
    if (replacementResponse) {
      return replacementResponse;
    }

    // Otherwise, forward the request with before/after extension processing
    return this.forwardRequest(request, route);
  }

  async start() {
    // Load extensions on startup
    await this.loadExtensions();

    const server = serve({
      port: this.port,
      fetch: (request) => this.handleRequest(request),
    });

    console.log(`🚀 Extension proxy running on http://localhost:${this.port}`);
    console.log(`📡 Forwarding requests to: ${this.targetUrl}`);
    console.log(`📊 Application ID: ${this.applicationId}`);

    return server;
  }
}

// Configuration - can be moved to env vars
const config: ProxyConfig = {
  targetUrl: process.env.TARGET_APP_URL || 'http://localhost:3001',
  port: parseInt(process.env.PROXY_PORT || '3000'),
  applicationId: process.env.APPLICATION_ID || 'default-app',
};

// Start the proxy
const proxy = new ExtensionProxy(config);
proxy.start().catch(console.error);

export { ExtensionProxy };
