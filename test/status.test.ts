// The status rules (src/status.ts): pure functions, so this suite also shows the tier itself works.
import { describe, expect, it } from "vitest";
import { deriveStatus, overdueSince, replyFacts, stateOf, type Observed, type Post } from "../src/status";

const T0 = "2026-11-01T00:00:00.000Z";
const at = (min: number) => new Date(Date.parse(T0) + min * 60_000).toISOString();
const after = { ack_ms: 60 * 60_000, reply_ms: 60 * 60_000 };
const o = (x: Partial<Observed>): Observed => ({
  needs: "none", created_at: T0, delivered_at: null, read_at: null, acked_at: null, replied_at: null, later_post_at: null, ...x,
});

describe("stateOf", () => {
  it("walks waiting, notified, then what needs asked for", () => {
    expect(stateOf(o({}))).toBe("waiting");
    expect(stateOf(o({ delivered_at: at(1) }))).toBe("notified");
    expect(stateOf(o({ read_at: at(2) }))).toBe("received");
    expect(stateOf(o({ needs: "ack", read_at: at(2) }))).toBe("awaiting_ack");
    expect(stateOf(o({ needs: "ack", read_at: at(2), acked_at: at(3) }))).toBe("acknowledged");
    expect(stateOf(o({ needs: "reply", read_at: at(2) }))).toBe("awaiting_reply");
    expect(stateOf(o({ needs: "reply", read_at: at(2), replied_at: at(4) }))).toBe("replied");
  });
  it("an ack does not answer a question, and a later post is not a reply", () => {
    expect(stateOf(o({ needs: "reply", read_at: at(2), acked_at: at(3) }))).toBe("awaiting_reply");
    expect(stateOf(o({ needs: "reply", read_at: at(2), later_post_at: at(5) }))).toBe("awaiting_reply");
  });
});

describe("overdueSince", () => {
  it("runs from the read, or from the send when never read", () => {
    expect(overdueSince(o({ needs: "ack" }), after)).toBe(Date.parse(at(60)));
    expect(overdueSince(o({ needs: "ack", read_at: at(10) }), after)).toBe(Date.parse(at(70)));
  });
  it("is null once answered, for needs none, and for a reply request with a later post", () => {
    expect(overdueSince(o({ needs: "ack", acked_at: at(1) }), after)).toBeNull();
    expect(overdueSince(o({ needs: "none" }), after)).toBeNull();
    expect(overdueSince(o({ needs: "reply", replied_at: at(1) }), after)).toBeNull();
    expect(overdueSince(o({ needs: "reply", later_post_at: at(1) }), after)).toBeNull();
  });
  it("deriveStatus flags overdue exactly at the boundary", () => {
    expect(deriveStatus(o({ needs: "ack" }), after, Date.parse(at(60)) - 1).overdue).toBe(false);
    expect(deriveStatus(o({ needs: "ack" }), after, Date.parse(at(60)))).toMatchObject({ overdue: true, overdue_since: at(60) });
  });
});

describe("replyFacts", () => {
  const m = { id: "msg_q", from_agent: "alice", created_at: at(0), thread_id: "thr_1" };
  const p = (x: Partial<Post>): Post => ({ id: "msg_p", thread_id: "thr_1", from_agent: "bob", to_agents: '["alice"]', created_at: at(5), reply_to: null, ...x });
  it("counts an explicit reply from the recipient to the sender, whenever it was sent", () => {
    expect(replyFacts(m, "bob", [p({ reply_to: "msg_q" })]).reply).toEqual({ id: "msg_p", at: at(5) });
    expect(replyFacts(m, "bob", [p({ reply_to: "msg_q", created_at: at(-1) })]).reply?.id).toBe("msg_p");
  });
  it("ignores posts from others, to others, in other threads, or naming another message", () => {
    for (const x of [{ from_agent: "carol" }, { to_agents: '["carol"]' }, { thread_id: "thr_2" }, { reply_to: "msg_other" }])
      expect(replyFacts(m, "bob", [p({ ...x, reply_to: x.reply_to ?? "msg_q" })]).reply).toBeNull();
    expect(replyFacts(m, "bob", [p({ reply_to: "msg_other" })]).later_post_at).toBeNull();
  });
  it("a later post without reply_to is later_post_at, an earlier one is not", () => {
    expect(replyFacts(m, "bob", [p({})]).later_post_at).toBe(at(5));
    expect(replyFacts(m, "bob", [p({ created_at: at(-1) })]).later_post_at).toBeNull();
  });
});
