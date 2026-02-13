import { Context } from "./types.js";
import {
  CallToolResult,
  ServerNotification,
  ServerRequest,
} from "@modelcontextprotocol/sdk/types.js";
import { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import { strip_internal_fields } from "./events.js";

export type Handler = (reply_payload: any) => CallToolResult;
export type ToolFn<S> = (
  args: S,
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
) => Promise<CallToolResult>;

export const DEFAULT_TIMEOUT_MS = 30_000;

export function build_channel<S>(
  { bus, id_generator, log }: Context,
  event_name: string,
  handler: Handler,
  timeout_ms: number = DEFAULT_TIMEOUT_MS,
) {
  const fn: ToolFn<S> = async (
    _args: S,
    _extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
  ) => {
    const request_id = id_generator.generate();
    const reply_name = `${event_name}.${request_id}`;
    bus.send_to_extension({
      ..._args,
      __event: event_name,
      __request_id: request_id,
    });
    log.debug(`[${event_name}] emitted, waiting for reply @${reply_name}`);

    const p: Promise<CallToolResult> = new Promise((resolve) => {
      log.debug(`[${event_name}] waiting for response @${reply_name}`);

      let cleanup: () => void = () => {};

      const timeoutId = setTimeout(() => {
        cleanup();
        log.debug(`[${event_name}] timed out after ${timeout_ms}ms`);
        resolve({
          isError: true,
          content: [
            {
              type: "text",
              text: `Tool '${event_name}' timed out waiting for response from Draw.io extension. Ensure the extension is connected.`,
            },
          ],
        });
      }, timeout_ms);

      cleanup = bus.on_reply_from_extension(
        reply_name,
        (reply: Record<string, any>) => {
          clearTimeout(timeoutId);
          cleanup();
          log.debug(`[${reply_name}] received response`, reply);
          try {
            const data = strip_internal_fields(reply);
            const response = handler(data);
            resolve(response);
          } catch (err) {
            resolve({
              isError: true,
              content: [
                {
                  type: "text",
                  text: `Tool '${event_name}' handler error: ${err instanceof Error ? err.message : String(err)}`,
                },
              ],
            });
          }
        },
      );
    });

    return p;
  };

  return fn;
}

export function default_tool(name: string, context: Context) {
  const fn = build_channel(context, name, (reply) => {
    const response: CallToolResult = {
      content: [
        {
          type: "text",
          text: JSON.stringify(reply),
        },
      ],
    };
    return response;
  });

  return fn;
}
