/**
 * Local type shim for the host-provided `@opencode/plugin` runtime module.
 *
 * OpenCode V2 injects the real SDK when it loads a plugin, so this package does
 * not need it installed at runtime. This declaration only keeps the repository's
 * root `bunx tsc --noEmit` green, because the plugin package is not installed
 * into `node_modules`. It declares just the slice of the documented V2 API this
 * plugin uses (Plugin.define, the tool transform, namespaces, and tool results).
 *
 * Docs: https://opencode.ai/v2/docs/build/plugins/server
 */

declare module "@opencode/plugin" {
  export namespace Plugin {
    interface ToolResult {
      content?: string;
      output?: unknown;
      metadata?: Record<string, unknown>;
    }

    interface ToolContext {
      readonly signal: AbortSignal;
      progress(update: Record<string, unknown>): Promise<void>;
    }

    interface ToolInfo {
      readonly name: string;
      readonly description: string;
      readonly input: Record<string, unknown>;
      execute(input: unknown, context: ToolContext): Promise<ToolResult>;
      readonly options?: {
        readonly namespace?: string;
        readonly permission?: string;
        readonly codemode?: boolean;
        readonly pinned?: boolean;
      };
    }

    interface ToolEditor {
      namespace(namespace: { name: string; description: string }): void;
      add(tool: ToolInfo): void;
    }

    interface Registration {
      dispose(): Promise<void>;
    }

    interface Context {
      readonly options: Record<string, unknown>;
      readonly tool: {
        transform(callback: (editor: ToolEditor) => void): Promise<Registration>;
      };
    }

    type Cleanup = () => void | Promise<void>;

    interface Definition {
      readonly id: string;
      setup(context: Context): Cleanup | Promise<Cleanup | void> | void;
    }

    function define(definition: Definition): Definition;
  }
}
