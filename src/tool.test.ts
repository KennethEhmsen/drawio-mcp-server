import { jest } from "@jest/globals";
import { build_channel, default_tool, Handler } from "./tool.js";
import { Bus, BusListener, Context, IdGenerator, Logger } from "./types.js";
import {
  CallToolResult,
  ServerNotification,
  ServerRequest,
} from "@modelcontextprotocol/sdk/types.js";
import { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import { create_logger } from "./standard_console_logger.js";

describe("build_channel", () => {
  let mockBus: jest.Mocked<Bus>;
  let mockIdGenerator: { generate: jest.Mock<() => string> };
  let context: Context;
  const mockHandler = jest.fn<Handler>();
  const log = create_logger();

  beforeEach(() => {
    jest.useFakeTimers();

    mockBus = {
      send_to_extension: jest.fn(),
      on_reply_from_extension: jest.fn().mockReturnValue(jest.fn()),
    } as unknown as jest.Mocked<Bus>;

    mockIdGenerator = {
      generate: jest.fn<() => string>().mockReturnValue("123"),
    };

    context = {
      bus: mockBus,
      id_generator: mockIdGenerator,
      log,
    };

    mockHandler.mockReset();
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it("should create a function that sends a message via bus", async () => {
    const eventName = "test-event";
    const toolFn = build_channel(context, eventName, mockHandler);

    const args = { key: "value" };
    const extra = {} as RequestHandlerExtra<ServerRequest, ServerNotification>;

    const promise = toolFn(args, extra);

    expect(mockBus.send_to_extension).toHaveBeenCalledWith({
      __event: eventName,
      __request_id: "123",
      key: "value",
    });
  });

  it("should wait for reply and call handler with response", async () => {
    const eventName = "test-event";
    const toolFn = build_channel(context, eventName, mockHandler);

    const mockResponse: CallToolResult = {
      content: [{ type: "text", text: "response" }],
    };
    mockHandler.mockReturnValue(mockResponse);

    const promise = toolFn(
      {},
      {} as RequestHandlerExtra<ServerRequest, ServerNotification>,
    );

    // Simulate reply callback
    const replyCallback = mockBus.on_reply_from_extension.mock.calls[0][1];
    replyCallback({ data: "test" });

    const result = await promise;

    expect(mockBus.on_reply_from_extension).toHaveBeenCalledWith(
      "test-event.123",
      expect.any(Function),
    );
    expect(mockHandler).toHaveBeenCalledWith({ data: "test" });
    expect(result).toEqual(mockResponse);
  });

  it("should use correct reply channel name format", async () => {
    mockIdGenerator.generate.mockReturnValue("456");
    const eventName = "another-event";
    const toolFn = build_channel(context, eventName, mockHandler);

    toolFn({}, {} as RequestHandlerExtra<ServerRequest, ServerNotification>);

    expect(mockBus.on_reply_from_extension).toHaveBeenCalledWith(
      "another-event.456",
      expect.any(Function),
    );
  });

  it("should timeout and return error if no reply is received", async () => {
    const eventName = "timeout-event";
    const toolFn = build_channel(context, eventName, mockHandler, 100);

    const promise = toolFn(
      {},
      {} as RequestHandlerExtra<ServerRequest, ServerNotification>,
    );

    await jest.advanceTimersByTimeAsync(100);

    const result = await promise;

    expect(result.isError).toBe(true);
    expect(result.content[0]).toEqual({
      type: "text",
      text: expect.stringContaining("timed out"),
    });
  });

  it("should clean up listener after receiving reply", async () => {
    const mockCleanup = jest.fn();
    mockBus.on_reply_from_extension = jest
      .fn()
      .mockReturnValue(mockCleanup) as any;

    const eventName = "cleanup-event";
    const mockResponse: CallToolResult = {
      content: [{ type: "text", text: "response" }],
    };
    mockHandler.mockReturnValue(mockResponse);

    const toolFn = build_channel(context, eventName, mockHandler);
    const promise = toolFn(
      {},
      {} as RequestHandlerExtra<ServerRequest, ServerNotification>,
    );

    const replyCallback = mockBus.on_reply_from_extension.mock.calls[0][1];
    replyCallback({ data: "test" });

    await promise;

    expect(mockCleanup).toHaveBeenCalled();
  });

  it("should not allow args to overwrite internal fields", async () => {
    const eventName = "override-event";
    const toolFn = build_channel(context, eventName, mockHandler);

    const maliciousArgs = {
      __event: "hijacked-event",
      __request_id: "hijacked-id",
      legit: "data",
    };
    toolFn(
      maliciousArgs,
      {} as RequestHandlerExtra<ServerRequest, ServerNotification>,
    );

    expect(mockBus.send_to_extension).toHaveBeenCalledWith({
      __event: eventName,
      __request_id: "123",
      legit: "data",
    });
  });

  it("should return error result if handler throws", async () => {
    const eventName = "handler-error-event";
    mockHandler.mockImplementation(() => {
      throw new Error("handler exploded");
    });

    const toolFn = build_channel(context, eventName, mockHandler);
    const promise = toolFn(
      {},
      {} as RequestHandlerExtra<ServerRequest, ServerNotification>,
    );

    const replyCallback = mockBus.on_reply_from_extension.mock.calls[0][1];
    replyCallback({ data: "test" });

    const result = await promise;

    expect(result.isError).toBe(true);
    expect(result.content[0]).toEqual({
      type: "text",
      text: expect.stringContaining("handler exploded"),
    });
  });

  it("should clean up listener on timeout", async () => {
    const mockCleanup = jest.fn();
    mockBus.on_reply_from_extension = jest
      .fn()
      .mockReturnValue(mockCleanup) as any;

    const eventName = "timeout-cleanup-event";
    const toolFn = build_channel(context, eventName, mockHandler, 100);

    const promise = toolFn(
      {},
      {} as RequestHandlerExtra<ServerRequest, ServerNotification>,
    );

    await jest.advanceTimersByTimeAsync(100);
    await promise;

    expect(mockCleanup).toHaveBeenCalled();
  });
});

describe("default_tool", () => {
  let mockBus: jest.Mocked<Bus>;
  let mockIdGenerator: { generate: jest.Mock<() => string> };
  const log = create_logger();
  let context: Context;

  beforeEach(() => {
    jest.useFakeTimers();

    mockBus = {
      send_to_extension: jest.fn(),
      on_reply_from_extension: jest.fn((_, callback: BusListener<unknown>) => {
        callback({ test: "data" });
        return jest.fn();
      }),
    } as unknown as jest.Mocked<Bus>;

    mockIdGenerator = {
      generate: jest.fn<() => string>().mockReturnValue("789"),
    };

    context = {
      bus: mockBus,
      id_generator: mockIdGenerator,
      log,
    };
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it("should create a tool that returns JSON stringified response", async () => {
    const toolName = "default-tool";
    const tool = default_tool(toolName, context);

    const result = await tool(
      {},
      {} as RequestHandlerExtra<ServerRequest, ServerNotification>,
    );

    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify({ test: "data" }),
        },
      ],
    });
  });

  it("should use the provided tool name in the channel", async () => {
    const toolName = "custom-tool";
    const tool = default_tool(toolName, context);

    await tool(
      {},
      {} as RequestHandlerExtra<ServerRequest, ServerNotification>,
    );

    expect(mockBus.send_to_extension).toHaveBeenCalledWith({
      __event: toolName,
      __request_id: "789",
    });
  });
});
