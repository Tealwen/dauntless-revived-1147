import "./authenv";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { OnClose, OnSubscribe, PublishToPlayer, type StompPeer } from "../src/realtime/stompbus1147";

// realtime/stompbus1147.ts: who may listen on a player topic, and how many subscriptions a socket holds.
function Peer(AccountId?: string, Session = "session-test"): StompPeer & { Sent: string[] } {
    const Sent: string[] = [];
    return { Ws: { readyState: 1, send: (Text: string) => Sent.push(Text) } as any, Session, AccountId, Server: AccountId === undefined, Sent };
}
const Topic = (Account: string) => `/topic/dtls/player/x/${Account}/msg`;

describe("STOMP player topics", () => {
    it("reach the account's own socket only", () => {
        const Own = Peer("acct-1");
        const Server = Peer(undefined);
        OnSubscribe(Own, { id: "1", destination: Topic("acct-1") });
        OnSubscribe(Server, { id: "1", destination: Topic("acct-1") });
        assert.equal(PublishToPlayer("acct-1", { a: 1 }), 1);
        assert.equal(Server.Sent.length, 0);
        OnClose(Own);
        OnClose(Server);
    });

    it("ignore a SUBSCRIBE before CONNECT", () => {
        const Early = Peer("acct-2", "");
        OnSubscribe(Early, { id: "1", destination: Topic("acct-2") });
        assert.equal(PublishToPlayer("acct-2", {}), 0);
    });

    it("replace a repeated id, and stop at 16 subscriptions per socket", () => {
        const P = Peer("acct-3");
        OnSubscribe(P, { id: "same", destination: Topic("acct-3") });
        OnSubscribe(P, { id: "same", destination: Topic("acct-3") });
        assert.equal(PublishToPlayer("acct-3", {}), 1);
        for (let I = 0; I < 40; I++) OnSubscribe(P, { id: `s${I}`, destination: Topic("acct-3") });
        assert.equal(PublishToPlayer("acct-3", {}), 16);
        OnClose(P);
        assert.equal(PublishToPlayer("acct-3", {}), 0);
    });
});
