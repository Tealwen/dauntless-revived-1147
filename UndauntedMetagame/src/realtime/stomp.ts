import type { IncomingMessage, Server } from "http";
import type { Duplex } from "stream";
import WebSocket, { RawData, WebSocketServer } from "ws";
import { logger } from "../logger";
import { OnClose, OnConnect, OnSubscribe, OnUnsubscribe, StompPeer } from "./stompbus1147";

// Minimal STOMP-over-WebSocket endpoint for the 1.14.7 client's StompClientMcp (Epic's notification
// service). The client connects to ws://<metagame address>/ with a v12.stomp subprotocol and escalates a
// failed connection to an error after ~20 s, which marks its online services unhealthy. Nothing is pushed
// yet: the endpoint checks the CONNECT token, records subscriptions (stompbus1147.ts) and keeps the
// connection alive.

const PROTOCOLS = ["v12.stomp", "v11.stomp", "v10.stomp"];
const FRAME_LIMIT = 64 * 1024;
const HEARTBEAT_MS = 20_000;
// Abuse limits: sockets per address and in all, and the time a socket has to send CONNECT
const MAX_PER_ADDRESS = 8;
const MAX_TOTAL = 2000;
const CONNECT_DEADLINE_MS = 15_000;
const PerAddress = new Map<string, number>();
let Total = 0;

type Frame = { Command: string; Headers: Record<string, string> };

function ParseFrames(Data: string): Frame[] {
    const Frames: Frame[] = [];
    for (const Raw of Data.split("\0")) {
        const Text = Raw.replace(/^[\r\n]+/, "");
        if (Text.length === 0) continue;
        const End = Text.search(/\r?\n\r?\n/);
        const Head = (End >= 0 ? Text.slice(0, End) : Text).split(/\r?\n/);
        const Headers: Record<string, string> = {};
        for (const Line of Head.slice(1)) {
            const Colon = Line.indexOf(":");
            if (Colon > 0 && !(Line.slice(0, Colon) in Headers)) Headers[Line.slice(0, Colon)] = Line.slice(Colon + 1);
        }
        Frames.push({ Command: Head[0].trim(), Headers });
    }
    return Frames;
}

function Encode(Command: string, Headers: Record<string, string>): string {
    return `${Command}\n${Object.entries(Headers).map(([K, V]) => `${K}:${V}`).join("\n")}\n\n\0`;
}

export function AttachStomp(Http: Server): void {
    const Wss = new WebSocketServer({
        noServer: true,
        maxPayload: FRAME_LIMIT,
        perMessageDeflate: false,
        handleProtocols: (Offered) => PROTOCOLS.find((P) => Offered.has(P)) ?? false,
    });

    Http.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
        const Offered = String(req.headers["sec-websocket-protocol"] ?? "");
        if (!PROTOCOLS.some((P) => Offered.includes(P))) {
            socket.destroy();
            return;
        }
        socket.on("error", () => undefined);
        const Address = req.socket.remoteAddress ?? "?";
        if (Total >= MAX_TOTAL || (PerAddress.get(Address) ?? 0) >= MAX_PER_ADDRESS) {
            logger.warn(`stomp: refused a connection from ${Address} (limit)`);
            socket.destroy();
            return;
        }
        Total++;
        PerAddress.set(Address, (PerAddress.get(Address) ?? 0) + 1);
        let Released = false;
        socket.once("close", () => {
            if (Released) return;
            Released = true;
            Total--;
            const Left = (PerAddress.get(Address) ?? 1) - 1;
            if (Left > 0) PerAddress.set(Address, Left); else PerAddress.delete(Address);
        });
        Wss.handleUpgrade(req, socket, head, (Ws) => OnConnection(Ws));
    });

    logger.info("stomp: notification endpoint on the metagame port (1.14.7 client)");
}

function OnConnection(Ws: WebSocket): void {
    let Session = "";
    const Peer: StompPeer = { Ws, Session: "", Server: false };
    const Beat = setInterval(() => { if (Ws.readyState === WebSocket.OPEN) Ws.send("\n"); }, HEARTBEAT_MS);
    const Deadline = setTimeout(() => { if (!Session) Ws.terminate(); }, CONNECT_DEADLINE_MS);
    Ws.on("error", () => undefined);
    Ws.on("close", () => {
        clearInterval(Beat);
        clearTimeout(Deadline);
        OnClose(Peer);
        if (Session) logger.info(`stomp: ${Session} disconnected`);
    });
    Ws.on("message", (Data: RawData) => {
        try {
            for (const F of ParseFrames(Data.toString())) {
                switch (F.Command) {
                    case "CONNECT":
                    case "STOMP":
                        Session = `session-${Math.random().toString(36).slice(2, 10)}`;
                        Peer.Session = Session;
                        // The passcode is the player's metagame token (stompbus1147.ts; STOMP_AUTH=enforce refuses a bad one)
                        if (!OnConnect(Peer, F.Headers).Ok) {
                            Ws.send(Encode("ERROR", { message: "auth" }));
                            Ws.close();
                            return;
                        }
                        Ws.send(Encode("CONNECTED", { version: "1.2", "heart-beat": `${HEARTBEAT_MS},0`, session: Session, server: "DauntlessRevived" }));
                        logger.info(`stomp: ${Session} connected`);
                        break;
                    case "DISCONNECT":
                        if (F.Headers.receipt) Ws.send(Encode("RECEIPT", { "receipt-id": F.Headers.receipt }));
                        Ws.close();
                        break;
                    case "SUBSCRIBE":
                        OnSubscribe(Peer, F.Headers);
                        if (F.Headers.receipt) Ws.send(Encode("RECEIPT", { "receipt-id": F.Headers.receipt }));
                        break;
                    case "UNSUBSCRIBE":
                        OnUnsubscribe(Peer, F.Headers);
                        if (F.Headers.receipt) Ws.send(Encode("RECEIPT", { "receipt-id": F.Headers.receipt }));
                        break;
                    default:
                        // ACK, SEND: nothing to deliver, acknowledge receipts only
                        if (F.Headers.receipt) Ws.send(Encode("RECEIPT", { "receipt-id": F.Headers.receipt }));
                }
            }
        } catch (error) {
            logger.warn(`stomp: bad frame (${(error as Error).message})`);
        }
    });
}
