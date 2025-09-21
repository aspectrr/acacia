export interface TranspileOptions {
  /**
   * Timeout for code execution in milliseconds
   */
  timeout?: number;

  /**
   * Environment variables to make available to the code
   */
  allowedEnvVars?: string[];

  /**
   * Whether to enable strict mode
   */
  strictMode?: boolean;

  /**
   * Additional globals to remove/undefined
   */
  customUnsafeGlobals?: string[];
}

type TranspileResult =
  | {
      success: true;
      transpiledCode: string;
      sourceMap?: string;
      warnings?: string[];
    }
  | {
      success: false;
      error: string;
      details?: string;
    };

interface ExecutionEnvironment {
  console: {
    log: (...args: any[]) => void;
    error: (...args: any[]) => void;
    warn: (...args: any[]) => void;
  };
  env: Record<string, string | undefined>;
  [key: string]: any;
}

export class TranspileManager {
  private static readonly DEFAULT_UNSAFE_GLOBALS = [
    "global",
    "process",
    "require",
    "Buffer",
    "module",
    "exports",
    "__dirname",
    "__filename",
    "eval",
    "Function",
    "setTimeout",
    "setInterval",
    "setImmediate",
    "clearTimeout",
    "clearInterval",
    "clearImmediate",
  ];

  private static readonly DEFAULT_TIMEOUT = 30000; // 30 seconds

  /**
   * Transpiles and sanitizes user code using Bun's build system
   */
  async transpile(
    code: string,
    options: TranspileOptions = {},
  ): Promise<TranspileResult> {
    try {
      // Validate input
      if (!code || typeof code !== "string") {
        return {
          success: false,
          error: "Invalid code input",
        };
      }

      // Pre-process code to wrap it safely
      const wrappedCode = this.wrapUserCode(code, options);

      // Use Bun to transpile the code
      const buildResult = await Bun.build({
        entrypoints: ["<stdin>"],
        target: "bun",
        format: "esm",
        minify: {
          whitespace: false,
          identifiers: false,
          syntax: true,
        },

        sourcemap: "inline",
        plugins: [
          {
            name: "stdin-plugin",
            setup(build) {
              build.onResolve({ filter: /^<stdin>$/ }, () => ({
                path: "<stdin>",
                namespace: "stdin",
              }));

              build.onLoad({ filter: /.*/, namespace: "stdin" }, () => ({
                contents: wrappedCode,
                loader: "ts",
              }));
            },
          },
        ],
      });

      if (!buildResult.success) {
        return {
          success: false,
          error: "Transpilation failed",
          details: buildResult.logs.map((log) => log.message).join("\n"),
        };
      }

      // Get the transpiled output
      const output = buildResult.outputs[0];
      if (!output) {
        return {
          success: false,
          error: "No transpiled output generated",
        };
      }

      const transpiledCode = await output.text();

      // Additional sanitization pass
      const sanitizedCode = this.sanitizeTranspiledCode(
        transpiledCode,
        options,
      );

      return {
        success: true,
        transpiledCode: sanitizedCode,
        warnings: buildResult.logs
          .filter((log) => log.level === "warning")
          .map((log) => log.message),
      };
    } catch (error) {
      return {
        success: false,
        error: `Transpilation error: ${error instanceof Error ? error.message : "Unknown error"}`,
      };
    }
  }

  /**
   * Creates a safe execution environment for transpiled code
   */
  createExecutionEnvironment(
    options: TranspileOptions = {},
  ): ExecutionEnvironment {
    // Create controlled environment variables access
    const allowedEnv: Record<string, string | undefined> = {};
    if (options.allowedEnvVars) {
      for (const envVar of options.allowedEnvVars) {
        allowedEnv[envVar] = process.env[envVar];
      }
    }

    return {
      console: {
        log: (...args: any[]) => console.log("[USER-CODE]", ...args),
        error: (...args: any[]) => console.error("[USER-CODE-ERROR]", ...args),
        warn: (...args: any[]) => console.warn("[USER-CODE-WARN]", ...args),
      },
      env: allowedEnv,
      // Add other safe utilities here as needed
      JSON: JSON,
      Date: Date,
      Math: Math,
      Object: {
        ...Object,
        // Override dangerous Object methods
        defineProperty: undefined,
        defineProperties: undefined,
        setPrototypeOf: undefined,
        __defineGetter__: undefined,
        __defineSetter__: undefined,
      },
      Array: Array,
      String: String,
      Number: Number,
      Boolean: Boolean,
      RegExp: RegExp,
      Map: Map,
      Set: Set,
      WeakMap: WeakMap,
      WeakSet: WeakSet,
      Promise: Promise,
    };
  }

  /**
   * Executes transpiled code in a controlled environment
   */
  async executeTranspiledCode(
    transpiledCode: string,
    context: Record<string, any> = {},
    options: TranspileOptions = {},
  ): Promise<any> {
    const timeout = options.timeout || TranspileManager.DEFAULT_TIMEOUT;

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new Error(`Code execution timeout after ${timeout}ms`));
      }, timeout);

      try {
        // Create execution environment
        const environment = this.createExecutionEnvironment(options);

        // Merge with provided context
        const fullContext = {
          ...environment,
          ...context,
        };

        // Create a function that executes the code with the controlled context
        const wrappedFunction = new Function(
          ...Object.keys(fullContext),
          `
          "use strict";
          ${transpiledCode}
          `,
        );

        const result = wrappedFunction.call(
          null,
          ...Object.values(fullContext),
        );

        clearTimeout(timeoutId);
        resolve(result);
      } catch (error) {
        clearTimeout(timeoutId);
        reject(error);
      }
    });
  }

  /**
   * Wraps user code with safety measures and proper export handling
   */
  private wrapUserCode(code: string, options: TranspileOptions): string {
    const unsafeGlobals = [
      ...TranspileManager.DEFAULT_UNSAFE_GLOBALS,
      ...(options.customUnsafeGlobals || []),
    ];

    // Create undefined assignments for unsafe globals
    const globalUndefinitions = unsafeGlobals
      .map((global) => `const ${global} = undefined;`)
      .join("\n");

    // Protect against prototype pollution
    const prototypePollutionProtection = `
      // Prevent prototype pollution
      Object.freeze(Object.prototype);
      Object.freeze(Array.prototype);
      Object.freeze(Function.prototype);
      Object.freeze(String.prototype);
      Object.freeze(Number.prototype);
      Object.freeze(Boolean.prototype);
      Object.freeze(Date.prototype);
      Object.freeze(RegExp.prototype);
    `;

    return `
      ${options.strictMode !== false ? '"use strict";' : ""}

      ${globalUndefinitions}

      ${prototypePollutionProtection}

      // User code starts here
      ${code}

      // Ensure we have a default export if none was provided
      if (typeof handler === 'undefined' && typeof exports === 'undefined') {
        throw new Error('No handler function or exports found. Please define a handler function or use exports.');
      }
    `;
  }

  /**
   * Additional sanitization of the transpiled code
   */
  private sanitizeTranspiledCode(
    code: string,
    options: TranspileOptions,
  ): string {
    // Remove any potential eval-like constructs that might have slipped through
    const dangerousPatterns = [
      /new\s+Function\s*\(/gi,
      /eval\s*\(/gi,
      /setTimeout\s*\(/gi,
      /setInterval\s*\(/gi,
      /setImmediate\s*\(/gi,
    ];

    let sanitized = code;

    for (const pattern of dangerousPatterns) {
      if (pattern.test(sanitized)) {
        console.warn(
          `[TranspileManager] Detected potentially dangerous pattern: ${pattern}`,
        );
        // Replace with safe alternatives or throw error
        sanitized = sanitized.replace(pattern, "undefined(");
      }
    }

    return sanitized;
  }

  /**
   * Validates that code doesn't contain obvious security issues
   */
  validateCodeSecurity(code: string): { isValid: boolean; issues: string[] } {
    const issues: string[] = [];

    // Check for obvious dangerous patterns
    const dangerousPatterns = [
      { pattern: /require\s*\(/gi, message: "Use of require() detected" },
      {
        pattern:
          /import\s+.*\s+from\s+['"](fs|child_process|os|net|http|https)['"]/gi,
        message: "Import of dangerous Node.js module detected",
      },
      { pattern: /process\./gi, message: "Access to process object detected" },
      { pattern: /__proto__/gi, message: "Prototype manipulation detected" },
      {
        pattern: /constructor\.constructor/gi,
        message: "Constructor manipulation detected",
      },
      {
        pattern: /Function\s*\(/gi,
        message: "Dynamic function construction detected",
      },
      { pattern: /eval\s*\(/gi, message: "Use of eval() detected" },
    ];

    for (const { pattern, message } of dangerousPatterns) {
      if (pattern.test(code)) {
        issues.push(message);
      }
    }

    return {
      isValid: issues.length === 0,
      issues,
    };
  }

  /**
   * Creates a new instance of the transpile manager
   */
  static create(): TranspileManager {
    return new TranspileManager();
  }
}

// Export a default instance for convenience
export const transpileManager = TranspileManager.create();
