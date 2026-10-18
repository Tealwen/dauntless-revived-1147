import crypto from "node:crypto";
import type WebSocket from "ws";
import { ValidateMetagameJWTAndGetPayload } from "../controllers/auth";
import { logger } from "../logger";

// The 1.14.7 client's STOMP topics and who listens on them (PORT-1.14.7/13-social.md). Not wired in yet:
// realtime/stomp.ts calls OnConnect / OnSubscribe / OnUnsubscribe / OnClose, and the party or friends
// code may call PublishToPlayer / PublishToParty.
//
// What the client does with a message: UArchonPartyPrimary::HandleStompMessage Player (exe RVA 0x1C6D040)
// and Party (0x1C6CE70) only LOG "MsgId: [..], Body: [..]" under LogParty-style OSS lines; neither parses
// the body. Party state is polled (POST /party, GET /party/invites), friends go through XMPP. So a push
// changes nothing in game today; it is a diagnostic channel (the body shows up in client.log).
//
// Topics (UArchonPartyPrimary::SubscribeToPlayerTopic 0x1C86CA0, SubscribeToPartyTopic 0x1C86660):
//   /topic/dtls/player/<A>/<B>/msg   B = the player's account id (UniqueNetId ToString)
//   /topic/dtls/party/<A>/<B>/msg    B = presumably the party id
// <A> is read from the Mcp subsystem (0xC4A860), not resolved statically; matching uses the last segment.
//
// CONNECT headers (FStompClientMcp, 0xC42DE0 for a player, 0xC42B10 for a dedicated server):
//   login:<account id, or "INVALID" when the Mcp user has none>   passcode:<the user's auth token>
//   login:dedicated-server                                         passcode:<the server's token>

export const STOMP_TOPIC = /^\/topic\/dtls\/(player|party)\/([^/]{1,128})\/([^/]{1,128})\/msg$/;

export type StompPeer = { Ws: WebSocket, Session: string, AccountId?: string, Server: boolean };
type Subscription = { Peer: StompPeer, Id: string, Destination: string, Kind: "player" | "party", Key: string };

const Subscriptions = new Set<Subscription>();
// The client subscribes to one player topic and one party topic
const MAX_SUBSCRIPTIONS = 16;

// STOMP 1.2 header escaping (\\ \n \r \c)
function EscapeHeader(Value: string): string {
    return Value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/:/g, "\\c");
}

function Frame(Command: string, Headers: Record<string, string>, Body = ""): string {
    const Lines = Object.entries(Headers).map(([K, V]) => `${K}:${EscapeHeader(V)}`);

    return `${Command}\n${Lines.join("\n")}\n\n${Body}\0`;
}

// Decides who a CONNECT is. A bad passcode is refused; STOMP_AUTH=log admits it with a
// warning so a client whose Mcp token is not the metagame JWT keeps its connection (an error after ~20 s
// marks its online services unhealthy). The passcode is never logged.
export function OnConnect(Peer: StompPeer, Headers: Record<string, string>): { Ok: boolean, Reason?: string } {
    const Login = (Headers.login ?? "").slice(0, 128);
    const Passcode = Headers.passcode ?? "";
    const Enforce = process.env.STOMP_AUTH !== "log";

    if (Login === "dedicated-server") {
        Peer.Server = true;
        logger.info(`stomp: ${Peer.Session} dedicated server`);
        return { Ok: true };
    }

    let TokenUid: string | undefined;
    let Why = "";

    try {
        const Payload = ValidateMetagameJWTAndGetPayload(Passcode) as { userId?: unknown };
        TokenUid = typeof Payload.userId === "string" ? Payload.userId : undefined;
    } catch (error) {
        Why = Passcode.length === 0 ? "no-passcode" : (error as Error).name === "TokenExpiredError" ? "expired" : "bad-token";
    }

    if (TokenUid !== undefined && Login !== TokenUid) {
        Why = "uid-mismatch";
    }

    if (Why === "" && TokenUid !== undefined) {
        Peer.AccountId = TokenUid;
        logger.info(`stomp: ${Peer.Session} login uid=${TokenUid}`);
        return { Ok: true };
    }

    logger.warn(`stomp: ${Peer.Session} login=${/^[\w:.-]*$/.test(Login) ? Login : "<odd>"} ${Why}${Enforce ? " (refused)" : " (admitted: STOMP_AUTH=log)"}`);
    return Enforce ? { Ok: false, Reason: Why } : { Ok: true };
}

export function OnSubscribe(Peer: StompPeer, Headers: Record<string, string>): void {
    const Destination = Headers.destination ?? "";
    const Id = Headers.id ?? "";
    const Match = STOMP_TOPIC.exec(Destination);

    logger.info(`stomp: ${Peer.Session} subscribe id=${Id.slice(0, 64)} destination=${Match ? Destination : "<other>"}`);

    // Nothing before a successful CONNECT (Session is set by it)
    if (!Match || Id.length === 0 || Id.length > 128 || Peer.Session === "") {
        return;
    }

    const Kind = Match[1] as "player" | "party";

    // A player topic carries that account's events (Slayer Links): only a peer logged in as that account
    // listens on it. A dedicated server (no passcode check) or a peer admitted by STOMP_AUTH=log has no account.
    if (Kind === "player" && (Peer.AccountId === undefined || (Match[3] !== Peer.AccountId && Match[2] !== Peer.AccountId))) {
        logger.warn(`stomp: ${Peer.Session} player topic of another account ignored`);
        return;
    }

    // The same id again replaces the subscription; at most MAX_SUBSCRIPTIONS per socket
    let Held = 0;
    for (const Sub of Subscriptions) {
        if (Sub.Peer !== Peer) continue;
        if (Sub.Id === Id) Subscriptions.delete(Sub); else Held++;
    }
    if (Held >= MAX_SUBSCRIPTIONS) {
        logger.warn(`stomp: ${Peer.Session} too many subscriptions, ignored`);
        return;
    }

    Subscriptions.add({ Peer, Id, Destination, Kind, Key: Match[3] });
}

export function OnUnsubscribe(Peer: StompPeer, Headers: Record<string, string>): void {
    for (const Sub of Subscriptions) {
        if (Sub.Peer === Peer && Sub.Id === Headers.id) Subscriptions.delete(Sub);
    }
}

export function OnClose(Peer: StompPeer): void {
    for (const Sub of Subscriptions) {
        if (Sub.Peer === Peer) Subscriptions.delete(Sub);
    }
}

function Publish(Kind: "player" | "party", Key: string, Body: unknown): number {
    const Text = typeof Body === "string" ? Body : JSON.stringify(Body);
    let Sent = 0;

    for (const Sub of Subscriptions) {
        if (Sub.Kind !== Kind || Sub.Key !== Key || Sub.Peer.Ws.readyState !== 1) continue;

        Sub.Peer.Ws.send(Frame("MESSAGE", {
            destination: Sub.Destination,
            subscription: Sub.Id,
            "message-id": crypto.randomUUID(),
            "content-type": "application/json",
            "content-length": String(Buffer.byteLength(Text, "utf8"))
        }, Text));
        Sent++;
    }

    return Sent;
}

// The client logs these bodies and does nothing else with them (see the top of the file)
export function PublishToPlayer(AccountId: string, Body: unknown): number {
    return Publish("player", AccountId, Body);
}

export function PublishToParty(PartyId: string, Body: unknown): number {
    return Publish("party", PartyId, Body);
}
