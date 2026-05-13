/**
 * v1.5 Thread θ — capture-SDK session-message poller tests.
 *
 * Covers:
 *   - Canonical-string parity with brain + portal (load-bearing — drift
 *     here = silent 401 on every poll).
 *   - End-to-end pollOnce() flow: mocked fetch returns a message, the
 *     onMessage handler is called, then acknowledge is POSTed.
 *   - No-op when webhookSecret is unset (offline dev safety).
 *   - Handler errors don't ack the message (at-least-once delivery).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSessionMessagePoller,
  _internals,
  type SessionInboxMessage,
} from "./session-message-poller.js";

const { canonicalInbox, canonicalAcknowledge } = _internals;

describe("canonical string builders parity with brain + portal", () => {
  it("canonicalInbox encodes session + cursor + limit", () => {
    expect(canonicalInbox("sess-1", null, 50)).toBe(
      "session-messages-inbox|sess-1|first|50"
    );
    expect(
      canonicalInbox("sess-1", "11111111-1111-1111-1111-111111111111", 100)
    ).toBe(
      "session-messages-inbox|sess-1|11111111-1111-1111-1111-111111111111|100"
    );
  });

  it("canonicalAcknowledge encodes session + msg id", () => {
    expect(
      canonicalAcknowledge("sess-1", "22222222-2222-2222-2222-222222222222")
    ).toBe(
      "session-messages-acknowledge|sess-1|22222222-2222-2222-2222-222222222222"
    );
  });
});

describe("createSessionMessagePoller", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  const makeMessage = (
    overrides: Partial<SessionInboxMessage> = {}
  ): SessionInboxMessage => ({
    id: "msg-1",
    from_canonical_handle: "op_kesuraya",
    from_session_id: null,
    to_session_id: "sess-windows",
    kind: "prompt",
    body: "Run tests",
    metadata: {},
    delivered_at: "2026-05-13T12:00:00.000Z",
    acknowledged_at: null,
    created_at: "2026-05-13T12:00:00.000Z",
    ...overrides,
  });

  it("is a no-op when webhookSecret is unset", async () => {
    const onMessage = vi.fn();
    const poller = createSessionMessagePoller({
      sessionId: "sess-windows",
      onMessage,
    });
    const result = await poller.pollOnce();
    expect(result).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(onMessage).not.toHaveBeenCalled();
  });

  it("pollOnce delivers each message to onMessage then acks", async () => {
    const message = makeMessage();
    fetchMock.mockImplementationOnce(async () =>
      new Response(
        JSON.stringify({ messages: [message], next_cursor: null }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );
    fetchMock.mockImplementationOnce(async () =>
      new Response(
        JSON.stringify({
          id: message.id,
          acknowledged_at: "2026-05-13T12:00:01.000Z",
          response_observation_id: "obs-123",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    const onMessage = vi.fn().mockResolvedValue({
      response_observation_id: "obs-123",
    });
    const poller = createSessionMessagePoller({
      sessionId: "sess-windows",
      webhookSecret: "secret",
      brainBaseUrl: "https://brain.test",
      onMessage,
    });

    const delivered = await poller.pollOnce();
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.id).toBe(message.id);
    expect(onMessage).toHaveBeenCalledWith(message);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    // First call: inbox GET
    const [inboxUrl, inboxInit] = fetchMock.mock.calls[0]!;
    expect(String(inboxUrl)).toContain(
      "/api/sessions/sess-windows/inbox"
    );
    expect((inboxInit as RequestInit).method).toBe("GET");
    // Second call: acknowledge POST
    const [ackUrl, ackInit] = fetchMock.mock.calls[1]!;
    expect(String(ackUrl)).toContain(
      "/api/sessions/sess-windows/messages/msg-1/acknowledge"
    );
    expect((ackInit as RequestInit).method).toBe("POST");
    const ackBody = JSON.parse(String((ackInit as RequestInit).body));
    expect(ackBody.response_observation_id).toBe("obs-123");
  });

  it("does NOT ack when the handler throws (at-least-once delivery)", async () => {
    const message = makeMessage({ id: "msg-2" });
    fetchMock.mockImplementationOnce(async () =>
      new Response(
        JSON.stringify({ messages: [message], next_cursor: null }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    const onMessage = vi.fn().mockRejectedValue(new Error("buffer full"));
    const onError = vi.fn();
    const poller = createSessionMessagePoller({
      sessionId: "sess-windows",
      webhookSecret: "secret",
      brainBaseUrl: "https://brain.test",
      onMessage,
      onError,
    });

    await poller.pollOnce();
    expect(onMessage).toHaveBeenCalledTimes(1);
    // Only the inbox call should have hit fetch — no acknowledge.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalled();
  });

  it("returns [] when the inbox endpoint errors", async () => {
    fetchMock.mockImplementationOnce(async () =>
      new Response("oops", { status: 500 })
    );
    const onError = vi.fn();
    const poller = createSessionMessagePoller({
      sessionId: "sess-windows",
      webhookSecret: "secret",
      brainBaseUrl: "https://brain.test",
      onMessage: vi.fn(),
      onError,
    });
    const result = await poller.pollOnce();
    expect(result).toEqual([]);
    expect(onError).toHaveBeenCalled();
  });

  it("delivers all four kinds to the handler", async () => {
    const kinds = [
      "prompt",
      "pilot_prompt",
      "broadcast",
      "context_switch_request",
    ] as const;
    const messages = kinds.map((kind, i) =>
      makeMessage({ id: `msg-${i}`, kind })
    );
    fetchMock.mockImplementationOnce(async () =>
      new Response(
        JSON.stringify({ messages, next_cursor: null }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );
    // Mock subsequent acks
    for (let i = 0; i < kinds.length; i++) {
      fetchMock.mockImplementationOnce(async () =>
        new Response(
          JSON.stringify({
            id: `msg-${i}`,
            acknowledged_at: "2026-05-13T12:00:00.000Z",
            response_observation_id: null,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );
    }

    const onMessage = vi.fn().mockResolvedValue({});
    const poller = createSessionMessagePoller({
      sessionId: "sess-windows",
      webhookSecret: "secret",
      brainBaseUrl: "https://brain.test",
      onMessage,
    });
    await poller.pollOnce();
    expect(onMessage).toHaveBeenCalledTimes(4);
    for (let i = 0; i < kinds.length; i++) {
      expect(onMessage).toHaveBeenNthCalledWith(
        i + 1,
        expect.objectContaining({ kind: kinds[i] })
      );
    }
  });
});
